import { createRequire } from 'node:module';
import { RpcClient } from './rpcClient.js';
import { VID, PIDS, USAGE_PAGE, USAGE } from './rpcCodec.js';

/** 프레임 사이 최소 간격 (블루투스, 실기 2026-10-05) */
export const FRAME_GAP_MS = 5;
/** 쓰기가 실패한 프레임을 다시 보내기까지 (2026-10-10) */
const RETRY_MS = 20;

/**
 * node-hid 바인딩. 얇게 유지한다.
 * node-hid는 optional dependency이며, 없으면 한국어 안내와 함께 실패한다.
 * npm test는 이 파일을 로드하지 않고도 전부 통과해야 한다.
 */
function loadHid() {
  try {
    const require = createRequire(import.meta.url);
    return require('node-hid');
  } catch (err) {
    const e = new Error(
      'node-hid를 불러오지 못했습니다. 실장치 명령에는 node-hid가 필요합니다.\n'
      + '  설치: npm install node-hid\n'
      + `  원인: ${String(err.message).split('\n')[0]}`,
    );
    e.cause = err;
    e.code = 'HID_MODULE_MISSING';
    throw e;
  }
}

export function listCandidates(HID = loadHid()) {
  return HID.devices().filter(
    (d) => d.vendorId === VID && PIDS.includes(d.productId)
      && d.usagePage === USAGE_PAGE && d.usage === USAGE,
  );
}

/**
 * @param {{exclusive?:boolean, blockedMethods?:string[], HID?:object}} opts
 *   exclusive: 기본 true. 실패하면 조용히 공유로 내려가지 않고 오류를 던진다.
 *   (CODEX_NEXT_TASK 7절 — non-exclusive가 논리 충돌을 해결한다고 가정하지 않는다)
 */
export function openHidTransport({
  exclusive = true, blockedMethods = [], allowedMethods = null, HID = null,
} = {}) {
  const hidModule = HID ?? loadHid();
  const candidates = listCandidates(hidModule);
  if (!candidates.length) {
    const e = new Error(
      'Creator Micro 2의 vendor HID 인터페이스를 찾지 못했습니다.\n'
      + `  기대값: VID 0x${VID.toString(16)}, PID ${PIDS.map((p) => `0x${p.toString(16)}`).join('/')}, `
      + `usagePage 0x${USAGE_PAGE.toString(16)}, usage ${USAGE}\n`
      + '  장치가 연결되어 있는지, 다른 앱이 점유 중인지 확인해 주세요.',
    );
    e.code = 'DEVICE_NOT_FOUND';
    throw e;
  }

  const info = candidates[0];
  let hid;
  try {
    hid = new hidModule.HID(info.path, { nonExclusive: !exclusive });
  } catch (err) {
    if (exclusive) {
      const e = new Error(
        '장치를 단독으로 열지 못했습니다. 다른 프로세스가 점유 중일 수 있습니다.\n'
        + '  브릿지는 다른 앱을 자동으로 종료하지 않습니다.\n'
        + '  해당 앱을 직접 종료하거나, 공유로 열려면 --force-shared 를 사용하세요.\n'
        + `  원인: ${String(err.message).split('\n')[0]}`,
      );
      e.code = 'DEVICE_BUSY';
      e.cause = err;
      throw e;
    }
    throw err;
  }

  // 프레임 사이를 띄운다. 블루투스에서 연달아 13프레임(LED 명령)을 쓰면 장치가 약 10초 응답하지 않는다.
  // 5ms 간격이면 15프레임도 된다 (실기 2026-10-05). 기다릴 필요가 없으면 지금처럼 바로 쓴다
  // 블루투스는 쓰기가 가끔 한 번 실패한다(IOHIDDeviceSetReport general error, 실기 2026-10-09).
  // 그 프레임만 잠깐 뒤 한 번 더 보내고, 또 실패하면 요청을 실패로 끝낸다 (2026-10-10)
  const waiting = [];              // { frame, retried }
  let lastWriteAt = -Infinity;
  let timer = null;
  const writeNow = (frame) => {
    lastWriteAt = performance.now();
    hid.write(Array.from(frame));
  };
  const schedule = (ms) => { timer ??= setTimeout(flush, ms); };
  const flush = () => {
    timer = null;
    const item = waiting.shift();
    try {
      writeNow(item.frame);
    } catch (err) {
      if (!item.retried) {
        waiting.unshift({ frame: item.frame, retried: true });
        schedule(RETRY_MS);
        return;
      }
      waiting.length = 0;
      client.failAll(err);
      return;
    }
    if (waiting.length) schedule(FRAME_GAP_MS);
  };
  const client = new RpcClient({
    sendFrame: (frame) => {
      if (!waiting.length && performance.now() - lastWriteAt >= FRAME_GAP_MS) {
        try {
          writeNow(frame);
          return;
        } catch {
          waiting.push({ frame, retried: true });
          schedule(RETRY_MS);
          return;
        }
      }
      waiting.push({ frame, retried: false });
      schedule(Math.max(0, Math.ceil(lastWriteAt + FRAME_GAP_MS - performance.now())));   // 타이머는 1ms 단위로 내림 — 올려야 5ms 아래로 붙지 않는다
    },
    blockedMethods,
    allowedMethods,
  });

  const errorHandlers = new Set();
  hid.on('data', (raw) => client.handleFrame(raw));
  hid.on('error', (err) => {
    client.failAll(err);
    // 뽑힘·절전 등. 소유자(DeviceGuard)가 끊김으로 보고 다시 잡을 수 있게 알린다.
    for (const h of errorHandlers) {
      try { h(err); } catch { /* 구독자 오류가 transport를 막지 않게 */ }
    }
  });

  return {
    info,
    // 연결 방식: 블루투스(BLE) HID는 interface 번호가 없다(-1, 실기 2026-10-05) (2026-10-10)
    connection: info.interface === -1 ? 'bluetooth' : 'usb',
    exclusive,
    call: (method, params, timeoutMs) => client.call(method, params, timeoutMs),
    canCall: (method) => client.canCall(method),
    onNotification: (h) => client.onNotification(h),
    onForeignResponse: (h) => client.onForeignResponse(h),
    onError(h) {
      errorHandlers.add(h);
      return () => errorHandlers.delete(h);
    },
    close() {
      clearTimeout(timer);
      timer = null;
      waiting.length = 0;
      try { hid.close(); } catch { /* 이미 닫혔을 수 있다 */ }
      client.failAll(new Error('transport closed'));
    },
  };
}
