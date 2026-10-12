/**
 * M23 — 노브·조이스틱 화면 표시 (2026-10-10 사용자 요청: 밝기 조절 표시처럼, 위치를 정확히 맞추게).
 * 서비스는 'hud' 이벤트만 낸다 (화면 창은 Electron). 설정에서 노브·조이스틱 각각 끄고 켠다 (기본 켬).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { joystickHud, dialHud } from '../src/service/hudModel.js';
import { RAD_EVENT, HID_EVENT, ACT } from '../src/input/deviceEventDecoder.js';

const CAL = JSON.parse(fs.readFileSync(new URL('../config/calibration.json', import.meta.url), 'utf8'));
const SECTORS4 = [
  { direction: 'right', from: 0.875, to: 0.125 }, { direction: 'down', from: 0.125, to: 0.375 },
  { direction: 'left', from: 0.375, to: 0.625 }, { direction: 'up', from: 0.625, to: 0.875 },
];
const sc = (label, keystroke) => ({ type: 'shortcut', label, keystroke });

describe('M23 / 표시 모델', () => {
  it('H01 조이스틱: 지금 위치·구간·들어간 방향과 그 동작 이름, 유지해야 입력 시간과 들어간 시각', () => {
    const slots = { joystick_up: sc('다음 탭', 'cmd+]'), joystick_left: sc('뒤로', 'cmd+[') };
    const hud = joystickHud({ angle: 0.75, distance: 0.8, dir: 'up', sectors: SECTORS4, deadzone: 0.05, dwellMs: 300, slots, enteredAt: 100 });
    assert.equal(hud.kind, 'joystick');
    assert.deepEqual([hud.angle, hud.distance, hud.dir, hud.deadzone], [0.75, 0.8, 'up', 0.05]);
    assert.deepEqual(hud.sectors.map((s) => [s.direction, s.label]), [['right', null], ['down', null], ['left', '뒤로'], ['up', '다음 탭']]);
    assert.deepEqual([hud.enteredAt, hud.dwellMs], [100, 300], '유지해야 입력이면 고리가 찬다');
    const n = joystickHud({ angle: 0, distance: 0, dir: null, sectors: SECTORS4, deadzone: 0.05, slots, enteredAt: null });
    assert.equal(n.dir, null);
    assert.equal(n.dwellMs, 0);
  });
  it('H02 노브: 방향(돌림·누름)과 동작 이름, 동작이 없으면 "동작 없음"', () => {
    const slots = { dial_cw: sc('다음 탭', 'ctrl+tab'), dial_press: { type: 'builtin', builtin: 'toggle_view', label: '모드 변경 (전체 ↔ 상세)' } };
    assert.deepEqual(dialHud('cw', slots), { kind: 'dial', action: 'cw', label: '다음 탭' });
    assert.deepEqual(dialHud('press', slots), { kind: 'dial', action: 'press', label: '모드 변경 (전체 ↔ 상세)' });
    assert.deepEqual(dialHud('ccw', slots), { kind: 'dial', action: 'ccw', label: '동작 없음' });
  });
});

async function svc(prefs) {
  const { OutputService } = await import('../src/service/outputService.js');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-m23-'));
  if (prefs) fs.writeFileSync(path.join(stateDir, 'prefs.json'), JSON.stringify(prefs));
  fs.writeFileSync(path.join(stateDir, 'profiles.json'), JSON.stringify({ version: 6, layers: [
    { id: 'default', kind: 'default', name: '기본', color: '#5A8CDC', preset: null, apps: [], keys: {}, dial: { cw: sc('볼륨', 'volume_up') },
      joystick: { directions: 4, axis: 'vertical', short: { up: sc('위', 'up') } } }] }));
  const st = { now: 1000 };
  const s = new OutputService({ calibration: CAL, stateDir, orcaEnabled: false, now: () => st.now,
    openRuntimeTransport: async () => { throw Object.assign(new Error('x'), { code: 'DEVICE_NOT_FOUND' }); },
    frontmost: async () => 'com.apple.TextEdit', ownBundleIds: [] });
  await s.watcher.tick();
  const huds = []; s.on('hud', (h) => huds.push(h));
  return { s, st, huds, stateDir };
}
const up = CAL.joystick.sectors.find((x) => x.direction === 'up').center;
const dialKey = (logical) => Object.entries(CAL.eventKeyToLogical ?? {}).find(([, l]) => l === logical)?.[0]
  ?? CAL.logicalToKeycode?.[logical];

describe('M23 / 서비스', () => {
  it('H03 조이스틱 기울임마다 hud(위치·방향), 같은 방향이면 들어간 시각은 그대로, 가운데로 오면 end', async () => {
    const { s, st, huds } = await svc();
    s._hudInput({ m: RAD_EVENT, p: { a: up, d: 0.9 } });
    st.now = 1100;
    s._hudInput({ m: RAD_EVENT, p: { a: up, d: 0.7 } });
    s._hudInput({ m: RAD_EVENT, p: { a: 0, d: 0 } });
    assert.deepEqual(huds.map((h) => [h.kind, h.dir, h.enteredAt, h.end ?? false]), [['joystick', 'up', 1000, false], ['joystick', 'up', 1000, false], ['joystick', null, null, true]]);
    assert.equal(huds[0].sectors.find((x) => x.direction === 'up').label, '위');
  });
  it('H04 노브 돌림·누름은 그 동작 이름으로 hud', async () => {
    const { s, huds } = await svc();
    s._hudInput({ m: HID_EVENT, p: { k: dialKey('dial_cw'), act: ACT.ROTATE } });
    assert.deepEqual(huds, [{ kind: 'dial', action: 'cw', label: '볼륨' }]);
  });
  it('H05 설정: 노브·조이스틱 각각 끄면 그 표시를 내지 않는다, prefs.json에 저장되고 다시 읽힌다 (기본 켬)', async () => {
    const { s, huds, stateDir } = await svc();
    assert.deepEqual(s.prefsGet().hud, { knob: true, joystick: true });
    s.prefsSet({ ...s.prefsGet(), hud: { knob: false, joystick: true } });
    s._hudInput({ m: HID_EVENT, p: { k: dialKey('dial_cw'), act: ACT.ROTATE } });
    s._hudInput({ m: RAD_EVENT, p: { a: up, d: 0.9 } });
    assert.deepEqual(huds.map((h) => h.kind), ['joystick']);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stateDir, 'prefs.json'), 'utf8')).hud, { knob: false, joystick: true });
    const { s: s2 } = await svc({ hud: { knob: false, joystick: false } });
    assert.deepEqual(s2.prefsGet().hud, { knob: false, joystick: false });
  });
  it('H06 대기(레이어 없음)면 표시하지 않는다', async () => {
    const { s, huds } = await svc();
    s.mode = 'idle';
    s._hudInput({ m: RAD_EVENT, p: { a: up, d: 0.9 } });
    assert.deepEqual(huds, []);
  });
});
