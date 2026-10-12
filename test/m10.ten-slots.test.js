/**
 * M10 — 칸 10개 (스펙 docs/superpowers/specs/2026-10-01-ten-slots-design.md).
 * J: 조이스틱 유지해야 입력 (길게는 2026-10-12에 없앰) · R: A키 제거 · T: 칸 10개
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { InputDecoder } from '../src/input/inputDecoder.js';
import { makeDispatcher } from '../src/input/intentDispatcher.js';
import { StateStore } from '../src/core/stateStore.js';
import { Output } from '../src/output.js';
import { readSourcesFile, SOURCE_FILE_VERSION } from '../src/service/profiles.js';
import { SLOTS_PER_BANK, PHYSICAL_ROWS, LOGICAL_TO_AG } from '../src/core/hardware.js';
import { LOGICAL_KEYS, buildDeviceScene } from '../src/device/deviceScene.js';
import { loadCalibration, capabilitiesFrom } from '../src/device/calibrationLoader.js';
import { WorkUnit, ChildUnit } from '../src/core/units.js';
import { Status } from '../src/core/types.js';
import { slotsOf } from '../src/apps/layers.js';

const CAL4 = [
  { direction: 'right', center: 0.0173, from: 0.8821, to: 0.1351 },
  { direction: 'down', center: 0.2529, from: 0.1351, to: 0.366 },
  { direction: 'left', center: 0.4791, from: 0.366, to: 0.613 },
  { direction: 'up', center: 0.7469, from: 0.613, to: 0.8821 },
];
const DOWN = { angle: 0.25, distance: 1 };
const LEFT = { angle: 0.48, distance: 1 };
const NEUTRAL = { angle: 0, distance: 0 };

function decoder() {
  let t = 0;
  const out = [];
  const d = new InputDecoder({ sectors: CAL4, deadzone: 0.05, now: () => t, onIntent: (i) => out.push(i) });
  return { d, out, at: (ms) => { t = ms; } };
}

describe('M10 / 조이스틱 유지해야 입력 (길게는 2026-10-12에 없앰)', () => {
  it('J01 유지 시간이 0(기본)이면 기울이는 순간 나간다 (지연 없음)', () => {
    const { d, out } = decoder();
    d.joystickPolar(DOWN);
    assert.deepEqual(out.map((i) => i.direction), ['down']);
    assert.equal('hold' in out[0], false, '길게 구분이 없다');
  });

  it('J02 유지 시간 전에 놓으면 아무것도 나가지 않는다', () => {
    const { d, out, at } = decoder();
    d.setJoystickDwell(300);
    at(0); d.joystickPolar(DOWN);
    assert.equal(out.length, 0, '들어갈 때는 아무것도 내지 않는다');
    at(200); d.tick();
    at(250); d.joystickPolar(NEUTRAL);
    at(600); d.tick();
    assert.equal(out.length, 0);
  });

  it('J03 유지 시간이 지나면 tick에서 하나, 더 머물거나 놓아도 더 나가지 않는다', () => {
    const { d, out, at } = decoder();
    d.setJoystickDwell(300);
    at(0); d.joystickPolar(DOWN);
    at(300); d.tick();
    at(900); d.tick();
    at(950); d.joystickPolar(NEUTRAL);
    assert.deepEqual(out.map((i) => i.direction), ['down']);
  });

  it('J04 유지 시간 전에 다른 방향으로 넘어가면 앞 방향은 버리고 새 방향으로 다시 잰다', () => {
    const { d, out, at } = decoder();
    d.setJoystickDwell(300);
    at(0); d.joystickPolar(DOWN);
    at(200); d.joystickPolar(LEFT);
    at(400); d.tick();
    assert.equal(out.length, 0, 'left는 200부터 재서 아직 아니다');
    at(500); d.tick();
    assert.deepEqual(out.map((i) => i.direction), ['left']);
  });

  it('J05 같은 방향 안에서 흔들려도(거리·각도 변화) 다시 재지 않는다', () => {
    const { d, out, at } = decoder();
    d.setJoystickDwell(300);
    at(0); d.joystickPolar(DOWN);
    at(200); d.joystickPolar({ angle: 0.27, distance: 0.8 });
    at(300); d.tick();
    assert.deepEqual(out.map((i) => i.direction), ['down']);
  });

  it('J06 재는 중 연결이 끊기면 나가지 않는다', () => {
    const { d, out, at } = decoder();
    d.setJoystickDwell(300);
    at(0); d.joystickPolar(DOWN);
    d.disconnected();
    at(600); d.tick();
    assert.equal(out.length, 0);
  });

  it('J07 유지 시간을 바꾸면 재던 것은 잊고, 모르는 값은 0(바로)', () => {
    const { d, out, at } = decoder();
    d.setJoystickDwell(300);
    at(0); d.joystickPolar(DOWN);
    d.setJoystickDwell(500);
    at(600); d.tick();
    assert.equal(out.length, 0);
    d.setJoystickDwell(-1);
    assert.equal(d.joystickDwellMs, 0);
  });
});

describe('M10 / 조이스틱 유지해야 입력 설정', () => {
  it('J12 설정(prefs.json)의 유지 시간을 디코더에 넣고, 다시 켜도 남는다. 고를 수 있는 값만', async () => {
    const { OutputService } = await import('../src/service/outputService.js');
    const { UNCALIBRATED } = await import('../src/device/calibrationLoader.js');
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-dwell-'));
    const mk = () => new OutputService({
      calibration: { ...UNCALIBRATED, joystick: { sectors: CAL4, deadzone: 0.05 } }, stateDir,
      openRuntimeTransport: async () => { const e = new Error('x'); e.code = 'DEVICE_NOT_FOUND'; throw e; },
      orcaEnabled: false, timers: { setInterval: () => ({}), clearInterval: () => {} },
      frontmost: async () => 'com.stablyai.orca',
    });
    const s = mk();
    assert.equal(s.prefsGet().joystickDwellMs, 0);
    assert.equal(s.decoder.joystickDwellMs, 0);
    assert.equal(s.prefsSet({ ...s.prefsGet(), joystickDwellMs: 300 }).ok, true);
    assert.equal(s.decoder.joystickDwellMs, 300);
    assert.equal(mk().decoder.joystickDwellMs, 300, '다시 켜도');
    s.prefsSet({ ...s.prefsGet(), joystickDwellMs: 1234 });
    assert.equal(s.decoder.joystickDwellMs, 0, '고를 수 없는 값은 바로');
  });

  it('J13 저장된 레이어의 조이스틱 길게 동작은 지우고 한 줄 남긴다 (옮기지 않는다)', async () => {
    const { normalizeLayers } = await import('../src/apps/layers.js');
    const notes = [];
    const ls = normalizeLayers([{ id: 'default', kind: 'default', joystick: { short: {}, long: { down: { type: 'shortcut', label: '새 탭', keystroke: 'cmd+t' } } } }], notes);
    assert.equal('long' in ls[0].joystick, false);
    assert.equal(Object.keys(ls[0].joystick.short).length, 0);
    assert.ok(notes.some((n) => /길게 동작 1개를 지웠습니다/.test(n)));
  });
});

const ORCA = [{ name: 'Orca', bundleIds: ['com.stablyai.orca'] }];
const v2 = (actions, controls) => ({ version: 2, sources: [{ name: 'Orca', actions, ...(controls ? { controls } : {}) }] });

describe('M10 / A키 제거와 옮기기', () => {
  it('R01 v2의 A키는 옮길 자리가 없어 버리고 한 줄 남긴다 (예전엔 조이스틱 아래 길게로 옮겼다 — 길게는 없앰)', () => {
    const r = readSourcesFile(v2([null, { labelKo: '새 탭', keystroke: 'cmd+shift+t' }, null, { labelKo: 'log', keystroke: 'cmd+l' }]), ORCA);
    assert.equal(r.controlsByName.get('Orca')?.joystickHold, undefined);
    assert.ok(r.notesKo.some((n) => /2개/.test(n) && /새 탭/.test(n) && /log/.test(n)));
  });

  it('R03 이미 저장된 아래 길게는 덮지 않는다', () => {
    const r = readSourcesFile(v2([null, { labelKo: '새 탭', keystroke: 'cmd+alt+t' }, null, null],
      { joystickHold: { down: { builtin: 'attention' } } }), ORCA);
    assert.deepEqual(r.controlsByName.get('Orca').joystickHold.down, { builtin: 'attention' });
  });

  it('R04 v3는 그대로 읽고, 더 새로운 버전은 읽지 않는다', () => {
    const c = { joystickDirections: 8 };
    assert.deepEqual(readSourcesFile({ version: 3, sources: [{ name: 'Orca', controls: c }] }, ORCA).controlsByName.get('Orca'), c);
    const r = readSourcesFile({ version: SOURCE_FILE_VERSION + 1, sources: [] }, ORCA);
    assert.equal(r.controlsByName.size, 0);
    assert.ok(r.warningKo);
  });

  it('R05 저장 파일은 v6 레이어이고 actions 칸이 없다 · 버린 A키는 다시 켜도 없다', async () => {
    const { OutputService } = await import('../src/service/outputService.js');
    const { UNCALIBRATED } = await import('../src/device/calibrationLoader.js');
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-mig-'));
    fs.writeFileSync(path.join(stateDir, 'profiles.json'), JSON.stringify(v2([null, { labelKo: '새 에이전트 탭', keystroke: 'cmd+alt+t' }, null, null])));
    const mk = () => new OutputService({
      calibration: UNCALIBRATED, stateDir,
      openRuntimeTransport: async () => { const e = new Error('x'); e.code = 'DEVICE_NOT_FOUND'; throw e; },
      orcaEnabled: false, timers: { setInterval: () => ({}), clearInterval: () => {} },
    });
    const a = mk();
    assert.equal(a.layersSave(a.layersGet()).ok, true);
    const saved = JSON.parse(fs.readFileSync(path.join(stateDir, 'profiles.json'), 'utf8'));
    assert.equal(saved.version, 6);
    assert.equal(JSON.stringify(saved).includes('"actions"'), false);
    assert.equal(mk().layersGet().find((l) => l.id === 'l-orca').preset, 'orca');
    assert.equal(JSON.stringify(slotsOf(mk().layersGet().find((l) => l.id === 'l-orca'))).includes('cmd+alt+t'), false);
  });

  it('R06 렌더 스냅샷과 조명에 A키가 없다', () => {
    const snap = new Output({ store: new StateStore() }).render();
    assert.equal('actions' in snap, false);
    assert.equal('actions' in snap.lighting, false);
  });
});

const ROOT = path.resolve(import.meta.dirname, '..');
const unit = (id, status = Status.RUNNING) => new WorkUnit({
  id, title: id, source: 'orca', kind: 'worktree',
  children: [new ChildUnit({ id: `${id}:t`, title: 't', status, requiredForCompletion: true })],
});
const filled = (n) => {
  const store = new StateStore();
  for (let i = 1; i <= n; i += 1) store.addUnit(unit(`w${i}`));
  return store;
};

describe('M10 / 칸 10개', () => {
  it('T01 한 묶음은 10칸이고 2행은 slot7~10(AG06~09)이다', () => {
    assert.equal(SLOTS_PER_BANK, 10);
    assert.deepEqual(PHYSICAL_ROWS[2], ['slot7', 'slot8', 'slot9', 'slot10']);
    assert.deepEqual(['slot7', 'slot8', 'slot9', 'slot10'].map((k) => LOGICAL_TO_AG[k]), ['AG06', 'AG07', 'AG08', 'AG09']);
    assert.equal(LOGICAL_KEYS.includes('A1'), false);
  });

  it('T02 작업 10개는 묶음 하나, 11번째는 다음 묶음 첫 칸', () => {
    const store = filled(11);
    assert.deepEqual(store.globalSlots.positionOf('w10'), { bank: 0, slot: 9 });
    assert.deepEqual(store.globalSlots.positionOf('w11'), { bank: 1, slot: 0 });
    const out = new Output({ store });
    assert.equal(out.render().slots.length, 10);
    assert.equal(out.render().bankCount, 2);
  });

  it('T03 키 7~10 짧게 = 그 작업으로 이동, 길게 = 상세 보기', async () => {
    const targets = [];
    const out = new Output({ store: filled(10), focusRouter: { focus: async (t) => { targets.push(t); return { ok: true }; } } });
    const dispatch = makeDispatcher(out);
    await dispatch({ type: 'tap', key: 'slot10' });
    assert.equal(targets[0].unitId, 'w10');
    await dispatch({ type: 'hold', key: 'slot7' });
    assert.equal(out.detail.unitId, 'w7');
  });

  it('T04 키 7~10 LED는 상태색이다', () => {
    const store = filled(8);
    store.setChildStatus('w8', 'w8:t', Status.WAITING_APPROVAL);
    const scene = buildDeviceScene(new Output({ store }).render());
    assert.equal(scene.keys.slot8.color, 'orange');
    assert.equal(scene.keys.slot7.color, 'amber');
    assert.equal(scene.keys.slot9.color, 'off');
  });

  it('T05 옛 이름(A1~A4) 보정 파일도 slot7~10으로 읽는다', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-cal-'));
    const cal = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/calibration.json'), 'utf8'));
    const back = { slot7: 'A1', slot8: 'A2', slot9: 'A3', slot10: 'A4' };
    const old = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [back[k] ?? k, back[v] ?? v]));
    cal.logicalToKeycode = old(cal.logicalToKeycode);
    cal.eventKeyToLogical = old(cal.eventKeyToLogical);
    cal.led.indexToLogical = old(cal.led.indexToLogical);
    fs.writeFileSync(path.join(dir, 'calibration.json'), JSON.stringify(cal));
    const { calibration } = loadCalibration({ root: dir, file: 'calibration.json' });
    assert.equal(calibration.eventKeyToLogical.AG06, 'slot7');
    assert.equal(calibration.led.indexToLogical['9'], 'slot10');
    assert.equal(calibration.logicalToKeycode.slot8, 'KV_OAI_AG07');
    assert.ok(capabilitiesFrom(calibration).controllableKeys.includes('slot10'));
  });

  it('T06 상세 화면은 child 10개까지 한 묶음, 노브는 10칸을 돈다', () => {
    const store = new StateStore();
    store.addUnit(new WorkUnit({ id: 'w', title: 'w', source: 'orca', kind: 'worktree',
      children: Array.from({ length: 11 }, (_, i) => new ChildUnit({ id: `c${i + 1}`, title: `c${i + 1}`, status: Status.RUNNING })) }));
    const out = new Output({ store });
    out.enterDetail('w');
    assert.equal(out.render().slots[9].id, 'c10');
    assert.equal(out.render().bankCount, 2);
    out.selectedSlot = 9;
    out.dialCW();
    assert.equal(out.selectedSlot, 0);
  });
});

describe('M10 / 장치 숨쉬기 (실기 2026-10-02: e=6 연해졌다 진해짐, s=속도)', () => {
  it('B01 숨쉬기 스타일은 장치 효과 e:6으로(breathing_fast s:0.9), 고정은 e:1로 나간다 — 앱이 밝기를 반복해 보내지 않는다', async () => {
    const { DeviceDriver } = await import('../src/device/deviceDriver.js');
    const cal = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/calibration.json'), 'utf8'));
    const d = new DeviceDriver({ calibration: cal, send: async () => {} });
    const { payload } = d.toPayload({ keys: {
      slot1: { color: 'orange', brightness: 0.78, pattern: 'breathing_fast' },
      slot2: { color: 'amber', brightness: 0.32, pattern: 'solid' },
    } });
    assert.equal(payload[0].e, 6);
    assert.equal(payload[0].s, 0.9);
    assert.equal(payload[1].e, 1, '고정은 그대로');
    assert.equal(payload[1].s, cal.led.payloadParams.s);
  });

  it('B02 승인 필요·답변 필요는 빠르게, 진행 중은 보통, 안 본 완료는 느리게 숨쉬고, 본 완료는 고정이다 (2026-10-10)', async () => {
    const { threadStyleFor } = await import('../src/core/lightingPolicy.js');
    for (const st of [Status.WAITING_APPROVAL, Status.WAITING_INPUT]) assert.equal(threadStyleFor(st).pattern, 'breathing_fast', st);
    assert.equal(threadStyleFor(Status.RUNNING).pattern, 'breathing');
    assert.equal(threadStyleFor(Status.DONE_UNSEEN).pattern, 'breathing_slow');
    assert.equal(threadStyleFor(Status.DONE_SEEN).pattern, 'solid');
  });
});
