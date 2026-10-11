/**
 * M25 — 개선·기능 묶음 (2026-10-10 사용자 요청).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendLog } from '../src/service/logFile.js';

describe('M25 / 기동 로그 크기 제한', () => {
  it('G01 한도를 넘으면 지금 파일을 .1로 옮기고(옛 .1은 버림) 새로 쓴다 — 최대 두 파일', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-m25-'));
    const f = path.join(dir, 'launch.log');
    for (let i = 0; i < 30; i += 1) appendLog(f, `줄 ${i} ${'x'.repeat(40)}`, { maxBytes: 300 });
    assert.ok(fs.statSync(f).size <= 300 + 80);
    assert.ok(fs.existsSync(`${f}.1`));
    assert.ok(fs.readFileSync(f, 'utf8').includes('줄 29'));
    assert.equal(fs.readdirSync(dir).length, 2);
  });
});

import { buildDeviceScene } from '../src/device/deviceScene.js';
import { DeviceDriver } from '../src/device/deviceDriver.js';
import { inNight } from '../src/service/nightDim.js';

const CAL = JSON.parse(fs.readFileSync(new URL('../config/calibration.json', import.meta.url), 'utf8'));
const sc = (keystroke) => ({ type: 'shortcut', label: '', keystroke });

async function svc({ front = 'com.google.Chrome', prefs } = {}) {
  const { OutputService } = await import('../src/service/outputService.js');
  const { UNCALIBRATED } = await import('../src/device/calibrationLoader.js');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-m25-'));
  if (prefs) fs.writeFileSync(path.join(stateDir, 'prefs.json'), JSON.stringify(prefs));
  fs.writeFileSync(path.join(stateDir, 'profiles.json'), JSON.stringify({ version: 6, layers: [
    { id: 'default', kind: 'default', name: '기본', color: '#5A8CDC', preset: null, apps: [], keys: { key1: sc('cmd+k') }, dial: {}, joystick: {} },
    { id: 'l-c', kind: 'user', name: '크롬', color: '#E8762B', preset: null, apps: [{ bundleId: 'com.google.Chrome', name: 'Chrome' }], keys: { key1: sc('cmd+t') }, dial: {}, joystick: {} },
  ] }));
  const st = { now: 1000, front };
  const timers = [];
  const s = new OutputService({ calibration: UNCALIBRATED, stateDir, orcaEnabled: false, now: () => st.now,
    timers: { setInterval: () => 0, clearInterval: () => {}, setTimeout: (fn, ms) => { timers.push(ms); return 0; }, clearTimeout: () => {} },
    openRuntimeTransport: async () => { throw Object.assign(new Error('x'), { code: 'DEVICE_NOT_FOUND' }); }, frontmost: async () => st.front, ownBundleIds: [] });
  await s.watcher.tick();
  return { s, st, timers };
}

describe('M25 / 레이어 바뀜 깜박임', () => {
  it('G02 앞 앱이 바뀌어 레이어가 바뀌면 0.3초 동안 언더글로우만 새 레이어 색으로 — 키는 그대로', async () => {
    const { s, st, timers } = await svc();
    s._flash = null; timers.length = 0;
    st.front = 'com.apple.TextEdit';
    await s.watcher.tick();
    const f = s._flashNow();
    assert.equal(f.keys, undefined, '키는 덮지 않는다');
    assert.deepEqual(f.ambientZone, { color: '#5A8CDC', brightness: 1, pattern: 'solid' });
    assert.ok(timers.includes(305));
    st.now += 300;
    assert.equal(s._flashNow(), null);
  });
  it('G03 장면: 언더글로우만 덮는 깜박임은 키는 원래대로, 언더글로우만 바꾼다', () => {
    const snap = { revision: 1, active: false, lighting: {}, appMode: { kind: 'app', name: 'A', color: '#E8762B', assigned: ['key1'], keyLeds: {}, underglow: null } };
    const scene = buildDeviceScene(snap, {}, { flash: { ambientZone: { color: 'orange', brightness: 1, pattern: 'blink_fast' } } });
    assert.equal(scene.keys.slot1.color, '#E8762B');
    assert.deepEqual(scene.ambientZone, { color: 'orange', brightness: 1, pattern: 'blink_fast' });
  });
});

describe('M25 / 배터리 경고 (언더글로우)', () => {
  it('G04 15% 이하이고 충전 중이 아니면 배터리 확인 때 1초 주황 빠른 깜박임, 충전 중이면 없음', async () => {
    const { s } = await svc();
    s._flash = null;
    s._setPower({ battery: 12, is_charging: false });
    s._batteryWarn();
    assert.deepEqual(s._flashNow().ambientZone, { color: 'orange', brightness: 1, pattern: 'blink_fast' });
    s._flash = null; s._ambientFlash = null;
    s._setPower({ battery: 12, is_charging: true });
    s._batteryWarn();
    assert.equal(s._flashNow(), null);
  });
});

describe('M25 / 밤 시간 밝기', () => {
  it('G05 시간 구간: 자정을 넘는 구간(22:00~07:00)과 넘지 않는 구간', () => {
    const at = (h, m = 0) => new Date(2026, 9, 10, h, m);
    assert.equal(inNight(at(23), '22:00', '07:00'), true);
    assert.equal(inNight(at(6, 59), '22:00', '07:00'), true);
    assert.equal(inNight(at(7), '22:00', '07:00'), false);
    assert.equal(inNight(at(12), '22:00', '07:00'), false);
    assert.equal(inNight(at(13), '12:00', '14:00'), true);
    assert.equal(inNight(at(14), '12:00', '14:00'), false);
  });
  it('G06 설정(기본 꺼짐, 22:00~07:00) 저장·읽기, 켜져 있고 구간 안이면 드라이버 밝기를 반으로', async () => {
    const { s } = await svc();
    assert.deepEqual(s.prefsGet().night, { enabled: false, from: '22:00', to: '07:00' });
    s.prefsSet({ ...s.prefsGet(), night: { enabled: true, from: '00:00', to: '23:59' } });
    s._applyNight(new Date(2026, 9, 10, 12));
    assert.equal(s.driver.brightnessScale, 0.5);
    s.prefsSet({ ...s.prefsGet(), night: { enabled: false, from: '00:00', to: '23:59' } });
    s._applyNight(new Date(2026, 9, 10, 12));
    assert.equal(s.driver.brightnessScale, 1);
    const { s: s2 } = await svc({ prefs: { night: { enabled: true, from: '9:7', to: 'x' } } });
    assert.deepEqual(s2.prefsGet().night, { enabled: true, from: '22:00', to: '07:00' }, '잘못된 시각은 기본');
  });
  it('G07 드라이버: 밝기 배율을 색에 곱한다 (키·언더글로우)', () => {
    const d = new DeviceDriver({ calibration: CAL, send: async () => {} });
    d.brightnessScale = 0.5;
    const p = d.toPayload({ keys: { slot1: { color: '#FF0000', brightness: 1, pattern: 'solid' } }, ambientZone: { color: '#00FF00', brightness: 1, pattern: 'solid' } }).payload;
    assert.equal(p[0].c, 0x800000);
    assert.equal(p.at(-1).c, 0x008000);
  });
});

import { duplicateLayer, defaultLayers } from '../src/apps/layers.js';
import { shortcutConflicts } from '../src/apps/shortcutConflicts.js';
import { Usage } from '../src/service/usage.js';

describe('M25 / 레이어 복제', () => {
  it('U01 새 id·"이름 복사본"·겹치지 않는 색·앱 없음(앱은 한 레이어에만)·동작은 깊은 복사, 기본 레이어를 복제하면 사용자 레이어', () => {
    const src = { id: 'l-a', kind: 'user', name: '크롬', color: '#E8762B', preset: 'browser', apps: [{ bundleId: 'com.google.Chrome', name: 'Chrome' }],
      keys: { key9: sc('cmd+s') }, dial: {}, joystick: { directions: 4, axis: 'vertical', short: {}, long: {} }, underglow: { color: 'layer', effect: 'breathe', speed: 'slow', brightness: 'mid' } };
    const layers = [...defaultLayers(), src];
    const c = duplicateLayer(src, layers, 'l-b');
    assert.deepEqual([c.id, c.kind, c.name, c.preset, c.apps], ['l-b', 'user', '크롬 복사본', 'browser', []]);
    assert.equal(layers.some((l) => l.color === c.color), false);
    c.keys.key9.keystroke = 'x';
    assert.equal(src.keys.key9.keystroke, 'cmd+s', '원본은 그대로');
    assert.deepEqual(c.underglow, src.underglow);
    assert.equal(duplicateLayer(layers[0], layers, 'l-c').kind, 'user');
  });
});

describe('M25 / 단축키 충돌 경고', () => {
  it('U02 같은 레이어의 다른 칸과 같은 단축키(표기 달라도), macOS 기본 단축키와 겹치면 알려 준다', () => {
    const slots = { key1: sc('cmd+k'), dial_cw: sc('ctrl+tab'), key3: sc('cmd+k') };
    assert.deepEqual(shortcutConflicts('⌘K', 'key3', slots), ['키 1과 같은 단축키입니다.']);
    assert.deepEqual(shortcutConflicts('ctrl+tab', 'key2', slots), ['노브 ↻ 돌림과 같은 단축키입니다.']);
    assert.match(shortcutConflicts('cmd+space', 'key2', slots)[0], /Spotlight/);
    assert.match(shortcutConflicts('cmd+tab', 'key2', slots)[0], /앱 전환/);
    assert.deepEqual(shortcutConflicts('cmd+j', 'key2', slots), []);
    assert.deepEqual(shortcutConflicts('???', 'key2', slots), []);
  });
});

describe('M25 / 키별 사용 횟수', () => {
  it('U03 레이어·칸마다 오늘 누른 횟수, 파일에 남고 다시 읽힌다, 날이 바뀌면 0부터', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-m25u-')), 'usage.json');
    const t = { now: new Date(2026, 9, 10, 9).getTime() };
    const u = new Usage({ file, now: () => t.now, flushMs: 0 });
    u.add('l-a', 'key1'); u.add('l-a', 'key1'); u.add('l-a', 'dial_cw');
    assert.deepEqual(u.today(), { 'l-a': { key1: 2, dial_cw: 1 } });
    u.flush();
    assert.deepEqual(new Usage({ file, now: () => t.now }).today(), { 'l-a': { key1: 2, dial_cw: 1 } });
    t.now = new Date(2026, 9, 11, 9).getTime();
    assert.deepEqual(new Usage({ file, now: () => t.now }).today(), {});
  });
  it('U04 서비스: 레이어 칸을 실행하면 센다', async () => {
    const { s } = await svc();
    s.runner.run = async () => ({ ok: true, reasonKo: '' });
    await s._runSlot('key1', { kind: 'app', bundleId: 'com.google.Chrome' });
    assert.deepEqual(s.usageToday(), { 'l-c': { key1: 1 } });
  });
});
