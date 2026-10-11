/**
 * M2 — FakeDevice / DeviceScene / RenderScheduler / InputDecoder / ActionRouter.
 * ACCEPTANCE_CHECKLIST_KO.md C17~C28, C31 중 로컬 검증 가능 항목.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { StateStore } from '../src/core/stateStore.js';
import { WorkUnit, ChildUnit } from '../src/core/units.js';
import { Status, ChildRole, View } from '../src/core/types.js';
import { Output } from '../src/output.js';
import { EventBus, Events } from '../src/core/eventBus.js';
import { seedWorkUnits } from '../src/adapters/mockOrcaAdapter.js';
import { MockFocusRouter } from '../src/core/focusRouter.js';
import { FakeDevice } from '../src/device/fakeDevice.js';
import { RenderScheduler } from '../src/device/renderScheduler.js';
import { buildDeviceScene, LOGICAL_KEYS } from '../src/device/deviceScene.js';
import { InputDecoder } from '../src/input/inputDecoder.js';

function rig({ capabilities = {}, latencyMs = 0, actions = [] } = {}) {
  const bus = new EventBus();
  const store = new StateStore({ bus });
  for (const u of seedWorkUnits()) store.addUnit(u);
  const focusRouter = new MockFocusRouter();
  const bridge = new Output({ store, focusRouter, actions: ['Mission Control', 'Spotlight', '화면 잠금', '알림 센터'] });
  const device = new FakeDevice({ capabilities, latencyMs });
  const scheduler = new RenderScheduler({ bridge, device, bus });
  return { bus, store, bridge, device, scheduler, focusRouter };
}

// ───────────── 13 논리 키
describe('M2 / DeviceScene 13 논리 키 (C22 C23 C24)', () => {
  it('D01(C22) scene이 칸10 + 전역3의 역할을 모두 갖는다 (2026-10-01: 키 7~10도 칸)', () => {
    const { bridge, device } = rig();
    const scene = buildDeviceScene(bridge.render(), device.capabilities);
    assert.deepEqual(Object.keys(scene.keys).sort(), [...LOGICAL_KEYS].sort());
    assert.equal(Object.keys(scene.keys).length, 13);
    for (const k of ['slot1', 'slot6', 'slot7', 'slot10', 'attention', 'ack', 'mode_back']) {
      assert.ok(scene.keys[k], `${k} 누락`);
    }
  });

  it('D01b mini LED는 scene에도 write 경로에도 없다', () => {
    const { bridge, device } = rig();
    const scene = buildDeviceScene(bridge.render(), device.capabilities);
    assert.equal(Object.keys(scene.keys).some((k) => /mini/i.test(k)), false);
    assert.equal(device.miniLedWriter, undefined);
    assert.equal(device.capabilities.miniLeds, false);
  });

  it('D02 하단 3키가 실제 상태를 반영한다', () => {
    const { bridge } = rig();
    bridge.banks.goto(1); bridge.selectedSlot = 3; // data/etl-backfill: 완료 알림 있음
    let scene = buildDeviceScene(bridge.render(), {});
    assert.notEqual(scene.keys.attention.color, 'off', '개입 대기 있음');
    assert.equal(scene.keys.ack.color, 'green', '확인할 완료 알림 있음');
    assert.ok(scene.keys.mode_back.brightness < 0.2, 'Global에서는 낮은 밝기');

    bridge.selectedSlot = 5; // sre/alert-tuning: 알림 없음
    scene = buildDeviceScene(bridge.render(), {});
    assert.equal(scene.keys.ack.color, 'off', '확인할 알림 없으면 ACK 꺼짐');

    bridge.enterDetail('search/index-rebuild');
    scene = buildDeviceScene(bridge.render(), {});
    assert.equal(bridge.view, View.DETAIL);
    assert.ok(scene.keys.mode_back.brightness >= 0.2, 'Detail에서는 돌아갈 수 있음을 표시');
  });

  it('D04(C24) 미검증 기능은 unsupported로 표시하고 추측 송신하지 않는다', async () => {
    const { bridge, device } = rig({ capabilities: { supportsAmbientZone: false } });
    const scene = buildDeviceScene(bridge.render(), device.capabilities);
    assert.equal(scene.ambientZone, null);
    assert.ok(scene.unsupported.includes('ambientZone'));

    const click = await device.dialClick();
    assert.equal(click.ok, false);
    assert.equal(click.unsupported, true);
    assert.match(click.reasonKo, /실기 검증/);

    const r = await bridge.dialPress();
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'dial_press_not_validated');
  });
});

// ───────────── RenderScheduler
describe('M2 / RenderScheduler (C17 C18 C34)', () => {
  it('D05 EventBus COMMITTED를 실제로 구독한다', async () => {
    const { store, scheduler, device } = rig();
    scheduler.start();
    await scheduler.idle();
    const before = device.applied.length;
    store.setChildStatus('api/cache-refactor', 'api/cache-refactor/claude', Status.ERROR);
    await scheduler.idle();
    assert.ok(device.applied.length > before, 'commit이 렌더를 유발해야 한다');
    assert.equal(scheduler.lastAppliedRevision, store.revision);
  });

  it('D06(C17) 장치 출력 지연 중 새 상태가 생기면 마지막 출력이 최신 scene이다', async () => {
    const { store, scheduler, device } = rig({ latencyMs: 5 });
    scheduler.start();
    store.setChildStatus('api/cache-refactor', 'api/cache-refactor/claude', Status.ERROR);
    store.setChildStatus('api/cache-refactor', 'api/cache-refactor/claude', Status.WAITING_INPUT);
    store.setChildStatus('api/cache-refactor', 'api/cache-refactor/claude', Status.RUNNING);
    await scheduler.idle();
    assert.equal(device.lastScene().revision, store.revision);
    assert.equal(scheduler.inSync, true);
    assert.equal(scheduler.lastAppliedRevision, store.revision);
  });

  it('D07(C18) burst는 병합되고 업무 이벤트는 유실되지 않는다', async () => {
    const { store, scheduler, device } = rig({ latencyMs: 2 });
    scheduler.start();
    for (let i = 0; i < 20; i += 1) {
      store.setChildStatus('core/logging-cleanup', 'core/logging-cleanup/codex',
        i % 2 ? Status.RUNNING : Status.WAITING_INPUT);
    }
    await scheduler.idle();
    assert.ok(device.applied.length < 20, '시각 출력은 병합되어야 한다');
    assert.equal(store.revision >= 20, true, '업무 이벤트는 모두 커밋되어야 한다');
    assert.equal(device.lastScene().revision, store.revision, '마지막 출력은 최신');
  });

  it('D08 장치 쓰기는 직렬화된다', async () => {
    const { store, scheduler, device } = rig({ latencyMs: 3 });
    scheduler.start();
    for (let i = 0; i < 6; i += 1) store.setUnitStatus('docs/api-reference', Status.RUNNING);
    await scheduler.idle();
    assert.equal(device.maxConcurrentWrites, 1);
  });

  it('D09(C34) 재연결 시 최신 scene을 다시 적용한다', async () => {
    const { store, scheduler, device, bus } = rig();
    scheduler.start();
    await scheduler.idle();
    device.disconnect();
    store.setChildStatus('qa/e2e-flake', 'qa/e2e-flake/runner', Status.RUNNING);
    await scheduler.idle();
    const appliedWhileDown = device.applied.length;

    device.reconnect();
    bus.emit(Events.DEVICE_CONNECTED, {});
    await scheduler.idle();
    assert.ok(device.applied.length > appliedWhileDown);
    assert.equal(device.lastScene().revision, store.revision);
  });

  it('D10 stop() 이후에는 렌더가 일어나지 않는다', async () => {
    const { store, scheduler, device } = rig();
    scheduler.start();
    await scheduler.idle();
    scheduler.stop();
    const n = device.applied.length;
    store.setUnitStatus('docs/api-reference', Status.ERROR);
    await scheduler.idle();
    assert.equal(device.applied.length, n);
  });
});

// ───────────── InputDecoder
describe('M2 / InputDecoder (C25 C26)', () => {
  const clock = () => { let t = 0; return { now: () => t, advance: (ms) => { t += ms; } }; };

  it('D11(C25) 길게 누르면 hold만 나가고 tap은 나가지 않는다', () => {
    const c = clock();
    const seen = [];
    const d = new InputDecoder({ now: c.now, onIntent: (i) => seen.push(i.type) });
    d.press('slot1');
    c.advance(600);
    d.tick();
    d.release('slot1');
    assert.deepEqual(seen, ['hold']);
  });

  it('D12 짧게 누르면 tap만 나간다', () => {
    const c = clock();
    const seen = [];
    const d = new InputDecoder({ now: c.now, onIntent: (i) => seen.push(i.type) });
    d.press('slot1'); c.advance(50); d.release('slot1');
    assert.deepEqual(seen, ['tap']);
  });

  it('D13 바운스는 무시된다', () => {
    const c = clock();
    const seen = [];
    const d = new InputDecoder({ now: c.now, debounceMs: 20, onIntent: (i) => seen.push(i.type) });
    d.press('ack'); c.advance(5); d.release('ack');
    c.advance(5); d.press('ack'); c.advance(5); d.release('ack');
    assert.equal(seen.length, 1);
    assert.ok(d.droppedBounces > 0);
  });

  it('D14(C26) 누른 상태에서 연결이 끊기면 pressed가 해제되고 유령 입력이 없다', () => {
    const c = clock();
    const seen = [];
    const d = new InputDecoder({ now: c.now, onIntent: (i) => seen.push(i) });
    d.press('slot3');
    assert.deepEqual(d.pressedKeys, ['slot3']);
    const cleared = d.disconnected();
    assert.deepEqual(cleared, ['slot3']);
    assert.deepEqual(d.pressedKeys, []);
    assert.deepEqual(seen, []);
    d.release('slot3');           // 재연결 후 도착한 유령 release
    assert.deepEqual(seen, []);
  });

  it('D15 joystick deadzone과 neutral 복귀', () => {
    const c = clock();
    const seen = [];
    const d = new InputDecoder({ now: c.now, deadzone: 0.35, onIntent: (i) => seen.push(i.direction) });
    assert.equal(d.joystick({ x: 0.1, y: 0.1 }), null);
    d.joystick({ x: 0.9, y: 0 });
    d.joystick({ x: 0.9, y: 0 });      // 유지 중 반복 발화 없음
    d.joystick({ x: 0, y: 0 });        // neutral
    d.joystick({ x: 0.9, y: 0 });
    assert.deepEqual(seen, ['right', 'right']);
  });

  it('D16 다이얼 회전 rate 제한', () => {
    const c = clock();
    const seen = [];
    const d = new InputDecoder({ now: c.now, rotateMinIntervalMs: 15, onIntent: (i) => seen.push(i.direction) });
    d.dial(1); d.dial(1); c.advance(20); d.dial(-1);
    assert.deepEqual(seen, ['cw', 'ccw']);
    assert.equal(d.droppedRotations, 1);
  });
});

// ───────────── ActionRouter / FocusRouter 분리
describe('M2 / ActionRouter와 FocusRouter 분리 (C27 C28 C31)', () => {
  it('D18 SLOT/ATTENTION은 FocusRouter로만 가고 앱 명령을 보내지 않는다', async () => {
    const { bridge, focusRouter } = rig({ actions: ['Mission Control'] });
    await bridge.pressSlot(1);
    await bridge.pressAttention();
    assert.equal(focusRouter.calls.length, 2);
  });

  it('D22(C31) 외부 이벤트의 shell 문자열은 실행되지 않는다', async () => {
    const bus = new EventBus();
    const store = new StateStore({ bus });
    store.addUnit(new WorkUnit({
      id: 'evil',
      children: [new ChildUnit({ id: 'evil/a', title: 'rm -rf / && kubectl delete ns prod', status: Status.WAITING_INPUT })],
    }));
    const focusRouter = new MockFocusRouter();
    const bridge = new Output({ store, focusRouter });
    await bridge.pressSlot(1);
    await bridge.pressAttention();
    // focus 대상은 신뢰된 식별자뿐이고, 명령 문자열은 전달되지 않는다.
    for (const call of focusRouter.calls) {
      assert.deepEqual(Object.keys(call).sort(), ['childId', 'kind', 'reason', 'unitId']);
      assert.equal(/rm -rf|kubectl/.test(JSON.stringify(call)), false);
    }
  });

  it('D23(C28) focus 실패는 그대로 보고되고 다른 대상을 실행하지 않는다', async () => {
    const bus = new EventBus();
    const store = new StateStore({ bus });
    store.addUnit(new WorkUnit({
      id: 'u', children: [new ChildUnit({ id: 'u/gone', status: Status.WAITING_INPUT })],
    }));
    const focusRouter = {
      calls: [],
      async focus(t) {
        this.calls.push(t);
        return { ok: false, reasonKo: '터미널 handle이 만료되었습니다.' };
      },
    };
    const bridge = new Output({ store, focusRouter });
    await bridge.pressSlot(1);
    assert.equal(focusRouter.calls.length, 1, '대체 대상을 다시 시도하지 않는다');
    assert.match(bridge.lastFocusFailure.reasonKo, /만료/);
  });
});

// ───────────── 상주 child 판정 (C07 재확인, device 경로 포함)
describe('M2 / 상주 terminal과 작업 완료 구분 (C07 C08)', () => {
  it('D24 상주 dev server가 켜져 있어도 완료 알림이 슬롯과 ACK 키에 보인다', () => {
    const bus = new EventBus();
    const store = new StateStore({ bus });
    store.addUnit(new WorkUnit({
      id: 'w',
      children: [
        new ChildUnit({ id: 'w/agent', role: ChildRole.AGENT, status: Status.DONE_UNSEEN }),
        new ChildUnit({ id: 'w/dev', role: ChildRole.DEV_SERVER, status: Status.RUNNING }),
      ],
    }));
    const bridge = new Output({ store });
    const snap = bridge.render();
    assert.equal(snap.slots[0].status, Status.DONE_UNSEEN);
    assert.equal(snap.slots[0].labelKo, '완료 · 미확인');
    assert.equal(buildDeviceScene(snap, {}).keys.ack.color, 'green');
  });

  it('D25 필수 작업이 RUNNING이면 완료로 표시하지 않는다', () => {
    const bus = new EventBus();
    const store = new StateStore({ bus });
    store.addUnit(new WorkUnit({
      id: 'w',
      children: [
        new ChildUnit({ id: 'w/test', role: ChildRole.TEST, status: Status.RUNNING }),
        new ChildUnit({ id: 'w/agent', role: ChildRole.AGENT, status: Status.DONE_UNSEEN }),
      ],
    }));
    const bridge = new Output({ store });
    assert.equal(bridge.render().slots[0].status, Status.RUNNING);
  });
});
