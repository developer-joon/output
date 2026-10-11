import { encodeRequest, decodeFrame, JsonStreamAssembler, CH_RPC, CH_DEBUG } from './rpcCodec.js';

/**
 * 프레임 송수신 위의 요청/응답 계층.
 *
 * 원본(common.mjs)과 달라진 점:
 * - id 없는 수신 객체를 버리지 않고 notification 핸들러로 보낸다.
 *   (doctor --input이 키 이벤트를 관측하려면 필요하다)
 * - method allowlist/blocklist를 걸 수 있다. doctor는 fs.write를 차단한다.
 * - 타이머를 주입할 수 있어 장치 없이 타임아웃을 테스트할 수 있다.
 */
export class RpcClient {
  constructor({
    sendFrame,
    blockedMethods = [],
    allowedMethods = null,
    defaultTimeoutMs = 5000,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (h) => clearTimeout(h),
    nextId = () => Math.floor(Math.random() * 999),
  }) {
    this.sendFrame = sendFrame;
    this.blockedMethods = new Set(blockedMethods);
    this.allowedMethods = allowedMethods ? new Set(allowedMethods) : null;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.nextId = nextId;

    this._pending = new Map();
    // 요청은 한 번에 하나만 보낸다 (실기 2026-09-27: 긴 응답과 짧은 응답의 프레임이 섞여 keymap 읽기가 깨졌다)
    this._busy = false;
    this._queue = [];
    this._assembler = new JsonStreamAssembler();
    this._notificationHandlers = new Set();
    this._foreignHandlers = new Set();
    this.debugLines = [];
    this.calledMethods = [];
  }

  /** 같은 장치를 함께 연 다른 앱의 요청에 대한 응답. method 이름을 넘긴다 (2026-10-10, 상태판 경고용) */
  onForeignResponse(handler) {
    this._foreignHandlers.add(handler);
    return () => this._foreignHandlers.delete(handler);
  }

  onNotification(handler) {
    this._notificationHandlers.add(handler);
    return () => this._notificationHandlers.delete(handler);
  }

  get pendingCount() {
    return this._pending.size;
  }

  /** 수신 원시 프레임 하나를 처리한다. */
  handleFrame(raw) {
    const frame = decodeFrame(raw);
    if (!frame) return;
    if (frame.channel === CH_DEBUG) {
      this.debugLines.push(frame.text);
      return;
    }
    if (frame.channel !== CH_RPC) return;

    for (const obj of this._assembler.push(frame.text)) {
      if (obj?.id === undefined) {
        // 응답이 아닌 알림. 원문 그대로 넘긴다.
        for (const h of [...this._notificationHandlers]) {
          try { h(obj); } catch { /* 구독자 오류를 전파하지 않는다 */ }
        }
        continue;
      }
      const waiter = this._pending.get(obj.id);
      if (!waiter) {                // 다른 클라이언트의 응답
        for (const h of [...this._foreignHandlers]) {
          try { h(obj.method ?? null); } catch { /* 구독자 오류를 전파하지 않는다 */ }
        }
        continue;
      }
      this._pending.delete(obj.id);
      this.clearTimer(waiter.timer);
      if (obj.error) {
        const err = new Error(obj.error.message || 'RPC error');
        err.code = obj.error.code;
        err.rpc = obj.error;
        waiter.reject(err);
      } else {
        waiter.resolve(obj.result);
      }
    }
  }

  /** 장치 연결이 끊겼을 때 대기 중 요청을 모두 정리한다. */
  failAll(error) {
    for (const [, waiter] of this._pending) {
      this.clearTimer(waiter.timer);
      waiter.reject(error);
    }
    this._pending.clear();
    this._assembler.reset();
    // 대기열도 같은 이유로 실패시킨다. 남겨 두면 다음 연결에서 옛 요청이 나간다.
    this._busy = false;
    const queued = this._queue.splice(0);
    for (const q of queued) q.reject(error);
  }

  /** 이 client로 보낼 수 있는 method인가. 쓰기 경로가 런타임 transport를 잘못 받지 않게 확인한다. */
  canCall(method) {
    if (this.blockedMethods.has(method)) return false;
    return !this.allowedMethods || this.allowedMethods.has(method);
  }

  async call(method, params = null, timeoutMs = this.defaultTimeoutMs) {
    if (this.blockedMethods.has(method)) {
      throw new Error(`이 도구에서는 '${method}' 호출이 금지되어 있습니다.`);
    }
    if (this.allowedMethods && !this.allowedMethods.has(method)) {
      throw new Error(`허용되지 않은 method입니다: '${method}'`);
    }
    this.calledMethods.push(method);
    // 진행 중인 요청이 없으면 바로 보내고, 있으면 그 요청이 끝난(성공·실패 무관) 뒤에 보낸다.
    // 대기 중에는 타이머를 걸지 않는다 — 타임아웃은 실제로 보낸 시점부터 센다.
    if (!this._busy) return this._start(method, params, timeoutMs);
    return new Promise((resolve, reject) => {
      this._queue.push({ method, params, timeoutMs, resolve, reject });
    });
  }

  _start(method, params, timeoutMs) {
    this._busy = true;
    let p;
    try {
      p = this._send(method, params, timeoutMs);
    } catch (err) {
      this._busy = false;
      this._drain();
      throw err;
    }
    return p.finally(() => { this._busy = false; this._drain(); });
  }

  _drain() {
    const next = this._queue.shift();
    if (!next) return;
    let p;
    try { p = this._start(next.method, next.params, next.timeoutMs); } catch (err) { next.reject(err); return; }
    p.then(next.resolve, next.reject);
  }

  _send(method, params, timeoutMs) {
    const id = this.nextId();
    const promise = new Promise((resolve, reject) => {
      const timer = this.setTimer(() => {
        this._pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
    });

    try {
      for (const frame of encodeRequest({ method, params, id })) {
        this.sendFrame(frame);
      }
    } catch (err) {
      const waiter = this._pending.get(id);
      if (waiter) {
        this.clearTimer(waiter.timer);
        this._pending.delete(id);
      }
      throw err;
    }
    return promise;
  }
}
