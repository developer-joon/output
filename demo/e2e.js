/**
 * M2 end-to-end 로컬 데모.
 *
 *   FakeDevice 입력 → InputDecoder → Output → StateStore(commit)
 *   → EventBus COMMITTED → RenderScheduler → DeviceScene → FakeDevice 출력
 *
 * 실제 HID를 열지 않고, keymap/firmware를 쓰지 않으며, 외부 계정에 접속하지 않는다.
 * 실행: npm run demo
 */
import { EventBus, Events } from '../src/core/eventBus.js';
import { StateStore } from '../src/core/stateStore.js';
import { Output } from '../src/output.js';
import { MockFocusRouter } from '../src/core/focusRouter.js';
import { FakeDevice } from '../src/device/fakeDevice.js';
import { RenderScheduler } from '../src/device/renderScheduler.js';
import { InputDecoder } from '../src/input/inputDecoder.js';
import { seedWorkUnits } from '../src/adapters/mockOrcaAdapter.js';
import { loadCalibration, capabilitiesFrom } from '../src/device/calibrationLoader.js';
import { DeviceDriver } from '../src/device/deviceDriver.js';
import { Status, StatusLabelKo } from '../src/core/types.js';

/**
 * @param {object} opts
 * @param {object} [opts.calibration] 주입하면 디스크를 읽지 않는다.
 *   테스트가 config/ 상태에 좌우되지 않게 하기 위한 것이다.
 */
export function buildDemo({ latencyMs = 1, calibration = undefined } = {}) {
  // 실기 보정이 있으면 그 capability로 동작한다. 없으면 전부 미검증 상태로 돈다.
  const cal = calibration !== undefined
    ? { calibration, calibrated: Boolean(calibration?.calibrated), sourceKo: '주입된 보정', problems: [] }
    : loadCalibration();
  const calibratedCaps = capabilitiesFrom(cal.calibration);
  const bus = new EventBus();
  const store = new StateStore({ bus });
  for (const u of seedWorkUnits()) store.addUnit(u);

  const focusRouter = new MockFocusRouter();
  const bridge = new Output({ store, focusRouter, sourceName: 'Orca' });
  const device = new FakeDevice({ latencyMs, capabilities: calibratedCaps });
  // 실장치라면 DeviceDriver가 scene을 thstatus payload로 바꾼다.
  // 여기서는 보내는 대신 payload를 기록만 한다 (장치 접속 없음).
  const driverPayloads = [];
  const driver = cal.calibration
    ? new DeviceDriver({ calibration: cal.calibration, send: async (p) => driverPayloads.push(p) })
    : null;
  const scheduler = new RenderScheduler({ bridge, device, bus }).start();

  // 물리 입력 → 의도 → Output 호출.
  // 데모는 가상 시계를 써서 탭 간격을 사람이 누르는 속도로 만든다
  // (실시간 시계를 쓰면 연속 탭이 디바운스에 걸린다).
  const clock = { t: 0, advance(ms) { this.t += ms; } };
  const pending = [];
  const decoder = new InputDecoder({
    now: () => clock.t,
    onIntent: (intent) => { pending.push(dispatch(intent)); },
  });

  function dispatch(intent) {
    if (intent.type === 'tap') {
      const m = /^slot(10|[1-9])$/.exec(intent.key);
      if (m) return bridge.pressSlot(Number(m[1]));
      if (intent.key === 'attention') return bridge.pressAttention();
      if (intent.key === 'ack') return bridge.pressAck();
      if (intent.key === 'mode_back') return bridge.pressModeBack();
    }
    if (intent.type === 'hold') {
      const m = /^slot(10|[1-9])$/.exec(intent.key);
      if (m) return bridge.longPressSlot(Number(m[1]));
      if (intent.key === 'attention') return bridge.longPressAttention();
      if (intent.key === 'mode_back') return bridge.longPressModeBack();
    }
    if (intent.type === 'joystick') {
      if (intent.direction === 'up') return bridge.joystickUp();
      if (intent.direction === 'down') return bridge.joystickDown();
      if (intent.direction === 'left') return bridge.joystickLeft();
      if (intent.direction === 'right') return bridge.joystickRight();
    }
    if (intent.type === 'dial') {
      return intent.direction === 'cw' ? bridge.dialCW() : bridge.dialCCW();
    }
    return null;
  }

  async function settle() {
    await Promise.all(pending.splice(0));
    scheduler.requestRender();
    await scheduler.idle();
  }

  /** 물리 tap 한 번 (press + release) */
  async function tap(key) {
    clock.advance(200);
    decoder.press(key);
    clock.advance(60);
    decoder.release(key);
    await settle();
  }

  async function hold(key, ms = 600) {
    clock.advance(200);
    decoder.press(key);
    clock.advance(ms);
    decoder.tick();
    decoder.release(key);
    await settle();
  }

  async function joystick(direction) {
    const v = { up: { x: 0, y: 1 }, down: { x: 0, y: -1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } }[direction];
    clock.advance(200);
    decoder.joystick(v);
    decoder.joystick({ x: 0, y: 0 });
    await settle();
  }

  return {
    bus, store, bridge, device, scheduler, decoder, focusRouter,
    clock, tap, hold, joystick, settle,
    calibration: cal, driver, driverPayloads,
  };
}

// ───────────────────────── 콘솔 출력

const pad = (s, n) => String(s ?? '').padEnd(n, ' ');

function renderBoard(rig, title) {
  const s = rig.bridge.render();
  const scene = rig.device.lastScene();
  const lines = [];
  lines.push('');
  lines.push(`━━━ ${title}`);
  lines.push(`뷰 ${s.view} · 묶음 ${s.bank + 1}/${s.bankCount} · 소스 ${s.sourceName} · ${s.active ? '활성' : '대기'}`
    + ` · revision ${s.revision} · 장치적용 ${scene?.revision ?? '-'}`);
  for (const slot of s.slots) {
    const mark = slot.slot - 1 === s.selectedSlot ? '▶' : ' ';
    const notif = slot.notification ? ` [알림 ${slot.pendingNotificationCount}]` : '';
    lines.push(`${mark} SLOT ${slot.slot}  ${pad(slot.title ?? '(빈 슬롯)', 26)}`
      + `${pad(slot.labelKo || '—', 12)}${notif}`);
  }
  lines.push(`  하단 3키  ATTENTION ${scene?.keys.attention.color} · ACK ${scene?.keys.ack.color}`
    + ` · MODE ${scene?.keys.mode_back.color}`);
  lines.push(`  조명      keys ${scene?.keysZone?.color ?? '미지원'}`
    + ` / ambient ${scene?.ambientZone?.color ?? '미지원'}`
    + ` (개입 ${s.attentionCount}건 · 숨은 개입 ${s.hiddenAttentionCount}건)`);
  if (scene?.ambientFallback?.active) {
    lines.push(`  대체 표현  슬롯 점멸 ${scene.ambientFallback.targets.map((i) => i + 1).join(',')}`
      + ` — ${scene.ambientFallback.reasonKo}`);
  }
  return lines.join('\n');
}

async function main() {
  const rig = buildDemo();
  const { bridge, store, device, focusRouter, tap, hold, joystick } = rig;
  await rig.scheduler.idle();

  console.log(`\n보정: ${rig.calibration.sourceKo}`);
  if (rig.calibration.calibrated) {
    const caps = capabilitiesFrom(rig.calibration.calibration);
    console.log(`  LED 제어 가능 키: ${caps.controllableKeys.join(', ') || '없음'}`);
    console.log(`  노브 클릭 ${caps.dialClick ? '지원' : '미검증'}`
      + ` · 조이스틱 ${caps.joystick ? '구간 확정' : '미검증'}`
      + ` · zone ${caps.supportsKeysZone ? '지원' : '없음'}`);
  } else {
    console.log('  보정 파일이 없어 하드웨어 기능을 전부 미검증으로 둡니다.');
    console.log('  만들려면: node tools/calibrate.mjs --apply');
  }

  console.log(renderBoard(rig, '1) 시작: Bank 1은 조용하지만 숨은 묶음에 개입 대상이 있다'));

  await joystick('right');
  console.log(renderBoard(rig, '2) 조이스틱 오른쪽: Bank 2 — 오류/승인/답변/완료가 보인다'));

  await tap('attention');
  console.log(`\n▶ ATTENTION 1회 → 이동 대상: ${JSON.stringify(focusRouter.last())}`);
  await tap('attention');
  console.log(`▶ ATTENTION 2회 → 이동 대상: ${JSON.stringify(focusRouter.last())}`);

  // 완료 알림 확인
  bridge.selectedSlot = 3;               // data/etl-backfill
  bridge.render();
  await tap('ack');
  console.log(`\n▶ ACK → ${JSON.stringify(bridge.lastAckResult)}`);

  bridge.selectedSlot = 1;               // billing/invoice-pdf (승인 필요)
  bridge.render();
  await tap('ack');
  console.log(`▶ 승인 필요 슬롯에서 ACK → ${JSON.stringify(bridge.lastAckResult)}`);
  console.log(`  승인 상태 그대로: ${store.getUnit('billing/invoice-pdf').status}`);

  console.log(renderBoard(rig, '3) ACK 후'));

  await hold('slot1');
  console.log(renderBoard(rig, '4) SLOT 1 길게 누름 → Detail (child terminal/session)'));

  await tap('mode_back');
  console.log(renderBoard(rig, '5) MODE/BACK → Global 복귀, 슬롯 위치 유지'));

  // 보이는 묶음의 오류를 먼저 정리해 underglow가 숨은 묶음만 반영하게 만든다.
  store.setChildStatus('search/index-rebuild', 'search/index-rebuild/reindex', Status.RUNNING);
  store.setChildStatus('search/index-rebuild', 'search/index-rebuild/shell', Status.RUNNING);
  store.setChildStatus('qa/e2e-flake', 'qa/e2e-flake/runner', Status.RUNNING);
  store.setChildStatus('mobile/push-token', 'mobile/push-token/claude', Status.RUNNING);
  store.setChildStatus('billing/invoice-pdf', 'billing/invoice-pdf/codex', Status.RUNNING);
  store.setChildStatus('auth/oidc-migrate', 'auth/oidc-migrate/codex', Status.RUNNING);
  store.setChildStatus('net/cdn-config', 'net/cdn-config/probe', Status.RUNNING);
  store.setChildStatus('perf/loadtest-v3', 'perf/loadtest-v3/runner', Status.RUNNING);
  await rig.scheduler.idle();
  console.log(renderBoard(rig, '6a) 보이는 묶음과 숨은 묶음 모두 조용해진 상태'));

  // 숨은 묶음(Bank 3)에서만 개입 발생
  store.setChildStatus('perf/loadtest-v3', 'perf/loadtest-v3/runner', Status.WAITING_APPROVAL);
  await rig.scheduler.idle();
  console.log(renderBoard(rig, '6b) 숨은 묶음에서 승인 필요 발생 → 보이는 6키는 그대로, underglow만 반응'));

  // 대기 (앞 앱이 Orca가 아님) — 입력은 무시되고 장치는 레이어색으로 복원된다
  console.log('\n▶ 7) 대기 — 앞 앱이 Orca가 아니면 입력은 무시되고 장치는 레이어색으로 복원된다');
  bridge.setActive(false);
  await rig.scheduler.idle();
  console.log(`   슬롯1 탭 → ${JSON.stringify(await bridge.pressSlot(1))} · 장치 씬 inactive=${device.lastScene().inactive}`);
  bridge.setActive(true);
  await rig.scheduler.idle();
  console.log(`   Orca로 복귀 → 장치 씬 inactive=${device.lastScene().inactive}`);

  // 연결 끊김 → 재연결
  device.disconnect();
  store.setChildStatus('qa/e2e-flake', 'qa/e2e-flake/runner', Status.RUNNING);
  await rig.scheduler.idle();
  const staleRev = device.lastScene().revision;
  device.reconnect();
  rig.bus.emit(Events.DEVICE_CONNECTED, {});
  await rig.scheduler.idle();
  console.log(`\n▶ 연결 끊김 중 마지막 출력 revision ${staleRev}`
    + ` → 재연결 후 ${device.lastScene().revision} (store ${store.revision})`);

  console.log(`\n━━━ 요약`);
  console.log(`  장치 쓰기 ${device.applied.length}회 · 병합 ${rig.scheduler.coalescedCount}회`
    + ` · 동시 쓰기 최대 ${device.maxConcurrentWrites}`);
  console.log(`  미확인 알림 ${store.unacknowledgedNotifications().length}건`
    + ` · 개입 대기 ${bridge.attention.items().length}건`);
  console.log(`  상태 문구: ${[...new Set(Object.values(StatusLabelKo))].filter(Boolean).join(' / ')}`);
  console.log(`  mini LED: ${bridge.render().miniLeds.purpose} (runtime 접근 ${bridge.render().miniLeds.touchedByRuntime})`);
  const lastScene = device.lastScene();
  if (lastScene?.uncontrollableKeys?.length) {
    console.log(`  LED 제어 불가 키 ${lastScene.uncontrollableKeys.length}개: `
      + lastScene.uncontrollableKeys.join(', '));
  }
  if (rig.driver) {
    const r = await rig.driver.applyScene(lastScene);
    if (!r.ok) {
      console.log(`  DeviceDriver: ${r.reasonKo}`);
    } else {
      console.log(`  DeviceDriver payload ${rig.driver.lastPayload.length}개 요소`
        + ` · 적용 ${r.appliedKeys.length}키 · 미지원 ${r.unsupportedKeys.length}키`);
    }
  }
  console.log('');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
