/**
 * M3-11 — underglow 대체 표현 (슬롯 LED 점멸).
 * 실기 7차: ambient zone 제어 수단이 없다. 숨은 개입을 다른 방식으로 알려야 한다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  planAmbientFallback, ambientOverlay, isOnPhase, DUTY, DEFAULT_PERIOD_MS,
} from '../src/core/ambientFallback.js';
import { AmbientPulse } from '../src/device/ambientPulse.js';
import { buildDeviceScene } from '../src/device/deviceScene.js';
import { RenderScheduler } from '../src/device/renderScheduler.js';
import { FakeDevice } from '../src/device/fakeDevice.js';
import { Output } from '../src/output.js';
import { StateStore } from '../src/core/stateStore.js';
import { WorkUnit, ChildUnit } from '../src/core/units.js';
import { Status } from '../src/core/types.js';
import { seedWorkUnits } from '../src/adapters/mockOrcaAdapter.js';
import { capabilitiesFrom } from '../src/device/calibrationLoader.js';
import { buildFromFiles } from '../tools/calibrate.mjs';

// 점멸 대체 표현 테스트: 언더글로우 수단이 없는 보정을 가정한다 (실기 16차 이후 실제 보정은 supportsAmbientZone=true)
const CAPS = { ...capabilitiesFrom(buildFromFiles({ now: () => 'T' })), supportsAmbientZone: false };
const RUN6 = Array(6).fill(Status.RUNNING);

describe('M3 / 점멸 정책', () => {
  it('A01 숨은 개입이 없으면 점멸하지 않는다', () => {
    const p = planAmbientFallback({
      slotStatuses: RUN6, ambientSummary: Status.ERROR, hiddenAttentionCount: 0,
    });
    assert.equal(p.active, false);
    assert.match(p.reasonKo, /보이지 않는 개입이 없습니다/);
  });

  it('A02 확인 대상(DONE_UNSEEN)만 있으면 점멸하지 않는다', () => {
    const p = planAmbientFallback({
      slotStatuses: RUN6, ambientSummary: Status.DONE_UNSEEN, hiddenAttentionCount: 1,
    });
    assert.equal(p.active, false);
    assert.match(p.reasonKo, /개입이 아니라 확인 대상/);
  });

  it('A03 빈 슬롯이 있으면 정보를 덮지 않고 그쪽만 쓴다', () => {
    const p = planAmbientFallback({
      slotStatuses: [Status.RUNNING, Status.EMPTY, Status.ERROR, Status.EMPTY,
        Status.RUNNING, Status.RUNNING],
      ambientSummary: Status.WAITING_INPUT,
      hiddenAttentionCount: 2,
    });
    assert.deepEqual(p.targets, [1, 3]);
    assert.match(p.reasonKo, /빈 슬롯 2개/);
  });

  it('A04 빈 슬롯이 없으면 6키를 짧게 스친다', () => {
    const p = planAmbientFallback({
      slotStatuses: RUN6, ambientSummary: Status.WAITING_APPROVAL, hiddenAttentionCount: 1,
    });
    assert.deepEqual(p.targets, [0, 1, 2, 3, 4, 5]);
    assert.equal(p.style.color, 'orange', '승인 대기 = 주황 (2026-10-10)');
    assert.match(p.reasonKo, /빈 슬롯이 없어/);
  });

  it('A05 대체 점멸은 언더글로우와 같은 색 — 오류 빨강, 승인 주황, 답변 살구, 상태 모름 보라 (2026-10-10)', () => {
    const color = (st) => planAmbientFallback({
      slotStatuses: RUN6, ambientSummary: st, hiddenAttentionCount: 1,
    }).style.color;
    assert.deepEqual([Status.ERROR, Status.WAITING_APPROVAL, Status.WAITING_INPUT, Status.STALE].map(color), ['red', 'orange', 'apricot', 'purple']);
  });

  it('A06 점멸은 짧다 — 주기의 대부분은 원래 색이다', () => {
    assert.ok(DUTY <= 0.25, `듀티 ${DUTY}는 너무 길다`);
    let on = 0;
    for (let i = 0; i < 100; i += 1) if (isOnPhase(i / 100)) on += 1;
    assert.ok(on <= 25, `켜진 구간이 ${on}%로 너무 길다`);
  });

  it('A07 꺼진 위상에서는 덧칠하지 않는다', () => {
    const args = { slotStatuses: RUN6, ambientSummary: Status.ERROR, hiddenAttentionCount: 1 };
    assert.equal(ambientOverlay(args, 0.05).indices.length, 6, '켜진 위상');
    assert.equal(ambientOverlay(args, 0.5).indices.length, 0, '꺼진 위상');
  });
});

describe('M3 / 점멸 시계', () => {
  function fakeTimer() {
    let fn = null;
    return {
      setTimer: (f) => { fn = f; return 1; },
      clearTimer: () => { fn = null; },
      tick: (n = 1) => { for (let i = 0; i < n; i += 1) fn?.(); },
      get running() { return fn !== null; },
    };
  }

  it('A08 위상이 한 바퀴 돌아 제자리로 온다', () => {
    const t = fakeTimer();
    const p = new AmbientPulse({ steps: 8, setTimer: t.setTimer, clearTimer: t.clearTimer });
    p.start();
    t.tick(8);
    assert.ok(Math.abs(p.phase) < 1e-9, `위상 ${p.phase}`);
    assert.equal(p.tickCount, 8);
  });

  it('A09 알릴 것이 없으면 시계를 멈춘다', () => {
    const t = fakeTimer();
    const p = new AmbientPulse({ setTimer: t.setTimer, clearTimer: t.clearTimer });
    assert.equal(p.syncTo(true), true);
    assert.equal(t.running, true);
    assert.equal(p.syncTo(false), false);
    assert.equal(t.running, false, '불필요한 타이머를 돌리지 않는다');
  });

  it('A10 매 tick마다 다시 그리라고 알린다', () => {
    const t = fakeTimer();
    let renders = 0;
    const p = new AmbientPulse({
      setTimer: t.setTimer, clearTimer: t.clearTimer, onTick: () => { renders += 1; },
    });
    p.start();
    t.tick(3);
    assert.equal(renders, 3);
  });

  it('A11 기본 타이머는 프로세스를 붙잡지 않는다', () => {
    const p = new AmbientPulse({ periodMs: 10_000 });
    p.start();
    // unref된 타이머여야 테스트 프로세스가 끝난다
    assert.equal(typeof p._handle?.unref, 'function');
    p.stop();
  });
});

describe('M3 / scene 적용', () => {
  function bridgeWith(units) {
    const store = new StateStore();
    for (const u of units) store.addUnit(u);
    return new Output({ store });
  }

  it('A12 숨은 개입이 있을 때만 점멸 대상이 생긴다', () => {
    const bridge = bridgeWith(seedWorkUnits());
    const snap = bridge.render();
    assert.ok(snap.hiddenAttentionCount > 0, 'Bank 1은 조용하고 숨은 개입이 있다');
    const on = buildDeviceScene(snap, CAPS, { ambientPhase: 0.05 });
    assert.equal(on.ambientFallback.active, true);
    assert.equal(on.ambientFallback.pulsing, true);
  });

  it('A13 꺼진 위상에서는 원래 상태색이 보인다', () => {
    const bridge = bridgeWith(seedWorkUnits());
    const snap = bridge.render();
    const off = buildDeviceScene(snap, CAPS, { ambientPhase: 0.5 });
    const plain = buildDeviceScene(snap, CAPS, { ambientPhase: null });
    assert.deepEqual(off.keys.slot1, plain.keys.slot1);
    assert.equal(off.ambientFallback.pulsing, false);
  });

  it('A14 보이는 개입만 있으면 점멸하지 않는다', () => {
    const store = new StateStore();
    store.addUnit(new WorkUnit({
      id: 'u', children: [new ChildUnit({ id: 'u/a', status: Status.ERROR })],
    }));
    const snap = new Output({ store }).render();
    assert.equal(snap.hiddenAttentionCount, 0, '화면에 보이는 개입이다');
    const scene = buildDeviceScene(snap, CAPS, { ambientPhase: 0.05 });
    assert.equal(scene.ambientFallback.active, false);
  });

  it('A15 점멸된 키는 표시가 남아 구분된다', () => {
    const bridge = bridgeWith(seedWorkUnits());
    const scene = buildDeviceScene(bridge.render(), CAPS, { ambientPhase: 0.05 });
    const pulsed = Object.values(scene.keys).filter((k) => k.ambientPulse);
    assert.ok(pulsed.length > 0);
    assert.ok(pulsed.every((k) => k.color === 'red'), '가장 급한 개입 색');
  });

  it('A16 ambient zone을 지원하는 장치에서는 점멸하지 않는다', () => {
    const bridge = bridgeWith(seedWorkUnits());
    const scene = buildDeviceScene(bridge.render(),
      { ...CAPS, supportsAmbientZone: true }, { ambientPhase: 0.05 });
    assert.equal(scene.ambientFallback, null);
    assert.ok(scene.ambientZone);
  });
});

describe('M3 / 스케줄러 연동', () => {
  it('A17 zone이 없는 장치면 점멸 시계를 스스로 만든다', () => {
    const store = new StateStore();
    for (const u of seedWorkUnits()) store.addUnit(u);
    const bridge = new Output({ store });
    const device = new FakeDevice({ capabilities: CAPS });
    const s = new RenderScheduler({ bridge, device });
    assert.ok(s.ambientPulse, 'zone이 없으면 대체 표현이 필요하다');
    s.stop();
  });

  it('A18 zone이 있는 장치면 만들지 않는다', () => {
    const store = new StateStore();
    store.addUnit(new WorkUnit({ id: 'u', status: Status.RUNNING }));
    const bridge = new Output({ store });
    const device = new FakeDevice({ capabilities: { supportsAmbientZone: true } });
    const s = new RenderScheduler({ bridge, device });
    assert.equal(s.ambientPulse, null);
    s.stop();
  });

  it('A19 tick마다 장치에 다시 그리고 위상이 반영된다', async () => {
    const store = new StateStore();
    for (const u of seedWorkUnits()) store.addUnit(u);
    const bridge = new Output({ store });
    const device = new FakeDevice({ capabilities: CAPS });
    let fire = null;
    const pulse = new AmbientPulse({
      steps: 4,
      setTimer: (fn) => { fire = fn; return 1; },
      clearTimer: () => { fire = null; },
    });
    const s = new RenderScheduler({ bridge, device, ambientPulse: pulse });
    pulse.onTick = () => s.requestRender();
    s.start();
    await s.idle();
    const before = device.applied.length;
    fire();                     // 위상 진행 → 다시 그림
    await s.idle();
    assert.ok(device.applied.length > before);
    s.stop();
    assert.equal(pulse.running, false, 'stop하면 시계도 멈춘다');
  });

  it('A20 알릴 것이 없으면 시계가 돌지 않는다', async () => {
    const store = new StateStore();
    store.addUnit(new WorkUnit({
      id: 'u', children: [new ChildUnit({ id: 'u/a', status: Status.RUNNING })],
    }));
    const bridge = new Output({ store });
    const device = new FakeDevice({ capabilities: CAPS });
    const pulse = new AmbientPulse({ setTimer: () => 1, clearTimer: () => {} });
    const s = new RenderScheduler({ bridge, device, ambientPulse: pulse });
    s.start();
    await s.idle();
    assert.equal(pulse.running, false, '개입이 없으면 깜빡일 이유가 없다');
    s.stop();
  });
});
