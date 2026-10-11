/**
 * M14 — 키 LED 설정 (스펙 docs/superpowers/specs/2026-10-04-key-led-design.md).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLed, ledStyle, pressMs } from '../src/apps/keyLed.js';
import { normalizeAction } from '../src/apps/appKeys.js';
import { normalizeLayers } from '../src/apps/layers.js';
import { buildDeviceScene } from '../src/device/deviceScene.js';
import { DeviceDriver } from '../src/device/deviceDriver.js';
import { defaultLayers } from '../src/apps/layers.js';

const sc = (k, led) => ({ type: 'shortcut', label: k, keystroke: k, ...(led ? { led } : {}) });

describe('M14 / LED 값', () => {
  it('K01 normalizeLed: 평소는 늘 있고 빠진 값은 기본, press·hold는 없으면 null', () => {
    assert.deepEqual(normalizeLed({}), {
      normal: { color: 'layer', effect: 'solid', speed: 'normal', brightness: 'mid' }, press: null, hold: null,
    });
    const l = normalizeLed({ normal: { color: '#00ff00', effect: 'breathe' }, press: {}, hold: { brightness: 'low' } });
    assert.deepEqual(l.normal, { color: '#00FF00', effect: 'breathe', speed: 'normal', brightness: 'mid' });
    assert.deepEqual(l.press, { color: '#FFFFFF', brightness: 'high', duration: 'short' });
    assert.deepEqual(l.hold, { color: 'layer', effect: 'solid', speed: 'normal', brightness: 'low' });
    assert.equal(normalizeLed(null), null);
    assert.equal(normalizeLed('x'), null);
  });
  it('K02 이상한 값은 기본으로 (손으로 고친 파일)', () => {
    const l = normalizeLed({ normal: { color: 'pink', effect: 'disco', speed: 3, brightness: 0.9 }, press: { duration: 'forever' } });
    assert.deepEqual(l.normal, { color: 'layer', effect: 'solid', speed: 'normal', brightness: 'mid' });
    assert.equal(l.press.duration, 'short');
  });
  it('K03 ledStyle: 레이어 색·밝기·e·s, 무지개는 e 3', () => {
    assert.deepEqual(ledStyle({ color: 'layer', effect: 'solid', speed: 'normal', brightness: 'mid' }, '#E8762B'),
      { color: '#E8762B', brightness: 0.6, e: 1, s: 0.6 });
    assert.deepEqual(ledStyle({ color: '#112233', effect: 'breathe', speed: 'fast', brightness: 'high' }, '#E8762B'),
      { color: '#112233', brightness: 1, e: 6, s: 0.9 });
    assert.equal(ledStyle({ color: 'layer', effect: 'rainbow', speed: 'slow', brightness: 'low' }, '#000000').e, 3);
    assert.equal(ledStyle({ color: '#FFFFFF', brightness: 'high', duration: 'long' }, '#000000').e, 1, 'press는 고정');
    assert.equal(pressMs({ duration: 'long' }), 600);
    assert.equal(pressMs({ duration: 'short' }), 150);
  });
  it('K04 normalizeAction이 led를 정리해 붙이고, 없으면 붙이지 않는다', () => {
    assert.deepEqual(normalizeAction(sc('cmd+k', { normal: { effect: 'blink' } })).led.normal.effect, 'blink');
    assert.equal('led' in normalizeAction(sc('cmd+k')), false);
  });
  it('K05 레이어: 키 칸의 led는 남고, 노브·조이스틱 칸의 led는 버린다', () => {
    const [, l] = normalizeLayers([{ id: 'l-a', kind: 'user', name: 'A', preset: null, apps: [],
      keys: { key3: sc('cmd+k', { normal: { effect: 'blink' } }) },
      dial: { cw: sc('cmd+]', { normal: { effect: 'blink' } }) },
      joystick: { directions: 4, short: { up: sc('cmd+u', { normal: { effect: 'blink' } }) }, long: {} } }]);
    assert.equal(l.keys.key3.led.normal.effect, 'blink');
    assert.equal('led' in l.dial.cw, false);
    assert.equal('led' in l.joystick.short.up, false);
  });
});

async function svc({ layers, front = 'com.google.Chrome' }) {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { OutputService } = await import('../src/service/outputService.js');
  const { UNCALIBRATED } = await import('../src/device/calibrationLoader.js');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-m14-'));
  fs.writeFileSync(path.join(stateDir, 'profiles.json'), JSON.stringify({ version: 6, layers }));
  const st = { front }; const calls = []; let t = 1_000_000;
  const s = new OutputService({ calibration: UNCALIBRATED, stateDir, now: () => t,
    openRuntimeTransport: async () => { const e = new Error('x'); e.code = 'DEVICE_NOT_FOUND'; throw e; },
    orcaEnabled: false, frontmost: async () => st.front, ownBundleIds: ['dev.output.keypad'],
    displays: () => [{ id: 1, primary: true, workArea: { x: 0, y: 25, width: 1440, height: 875 } }],
    appExec: { synth: async (k) => calls.push(['synth', k]), openApp: async () => ({ code: 0 }), openUrl: async () => ({ code: 0 }),
      execCommand: async () => ({ code: 0 }), readClipboard: async () => '', writeClipboard: async () => ({ code: 0 }), moveWindow: async () => ({ ok: true }), hasWindow: async () => true },
    timers: { setInterval: () => ({}), clearInterval: () => {}, setTimeout: () => ({}), clearTimeout: () => {} } });
  return { s, st, calls, advance: (ms) => { t += ms; } };
}
const chrome = (keys, color = '#E8762B') => ({ id: 'l-chrome', kind: 'user', name: '크롬', color, preset: null,
  apps: [{ bundleId: 'com.google.Chrome', name: 'Google Chrome' }], keys, dial: {}, joystick: { directions: 4, short: {}, long: {} } });

describe('M14 / 평소 LED', () => {
  it('K06 앱 모드: led 있는 키는 그 스타일, led 없는 키는 레이어 색 중 밝기(0.6) 고정, 동작 없는 키는 꺼짐', async () => {
    const { s } = await svc({ layers: [defaultLayers()[0], chrome({
      key3: sc('cmd+k', { normal: { color: '#00FF00', effect: 'breathe', speed: 'fast', brightness: 'high' } }),
      key4: sc('cmd+j'),
    })] });
    await s.watcher.tick();
    assert.deepEqual(s.bridge.appMode.keyLeds, { key3: { color: '#00FF00', brightness: 1, e: 6, s: 0.9 } });
    const scene = buildDeviceScene(s.bridge.render(), {});
    assert.deepEqual(scene.keys.slot3, { color: '#00FF00', brightness: 1, e: 6, s: 0.9 });
    assert.equal(scene.keys.slot4.color, '#E8762B');
    assert.equal(scene.keys.slot4.brightness, 0.6);
    assert.equal(scene.keys.slot5.color, 'off');
  });
  it('K07 LED 색이 레이어 색이면 레이어 색을 따라간다', async () => {
    const { s } = await svc({ layers: [defaultLayers()[0], chrome({ key3: sc('cmd+k', { normal: { color: 'layer' } }) }, '#123456')] });
    await s.watcher.tick();
    assert.equal(s.bridge.appMode.keyLeds.key3.color, '#123456');
    const ls = s.layersGet(); ls.find((l) => l.id === 'l-chrome').color = '#654321';
    assert.equal(s.layersSave(ls).ok, true);
    assert.equal(s.bridge.appMode.keyLeds.key3.color, '#654321');
  });
  it('K08 덧칠(overlay)은 평소 위에 얹는다 (앱 모드 키만)', async () => {
    const { s } = await svc({ layers: [defaultLayers()[0], chrome({ key3: sc('cmd+k') })] });
    await s.watcher.tick();
    const scene = buildDeviceScene(s.bridge.render(), {}, { overlays: { slot3: { color: '#FFFFFF', brightness: 0.6, e: 1, s: 0.6 }, attention: { color: '#FF0000', brightness: 1, e: 1, s: 0.6 } } });
    assert.equal(scene.keys.slot3.color, '#FFFFFF');
    assert.notEqual(scene.keys.attention.color, '#FF0000', '빈 칸(11번)은 덧칠하지 않는다');
  });
  it('K09 드라이버: 스타일의 e·s를 보내고, 없으면 PATTERN_PARAMS', () => {
    const cal = { led: { indexToLogical: { 0: 'slot1', 1: 'slot2' }, payloadParams: { b: 1, e: 1, s: 0.5, sk: 0, sa: 0 }, keyCount: 2, controllableIndices: [0, 1] } };
    const d = new DeviceDriver({ calibration: cal, send: async () => ({ ok: 1 }) });
    const { payload } = d.toPayload({ keys: { slot1: { color: '#FFFFFF', brightness: 0.6, e: 6, s: 0.9 }, slot2: { color: '#FFFFFF', brightness: 0.5, pattern: 'breathing_fast' } } });
    assert.equal(payload[0].e, 6); assert.equal(payload[0].s, 0.9);
    assert.equal(payload[1].e, 6); assert.equal(payload[1].s, 0.9, 'breathing_fast = e6 s0.9');
  });
});
describe('M14 / 눌렀을 때 · 누르고 있을 때', () => {
  const PRESS = { color: '#FFFFFF', brightness: 'high', duration: 'normal' };
  const HOLD = { color: '#0000FF', effect: 'blink', speed: 'fast', brightness: 'high' };
  it('K10 누르면 press 덧칠, 시간이 지나고 누르는 중이면 hold, 떼면 평소', async () => {
    const { s, advance } = await svc({ layers: [defaultLayers()[0], chrome({ key3: sc('cmd+k', { press: PRESS, hold: HOLD }) })] });
    await s.watcher.tick();
    s._onKeyEdge('slot3', true);
    assert.equal(s._ledOverlays().slot3.color, '#FFFFFF');
    advance(301);
    assert.deepEqual(s._ledOverlays().slot3, { color: '#0000FF', brightness: 1, e: 4, s: 0.9 });
    s._onKeyEdge('slot3', false);
    assert.deepEqual(s._ledOverlays(), {});
  });
  it('K11 press만 있으면 시간이 지나면 (누르는 중이어도) 평소로, 떼도 시간 안이면 press 유지', async () => {
    const { s, advance } = await svc({ layers: [defaultLayers()[0], chrome({ key3: sc('cmd+k', { press: PRESS }) })] });
    await s.watcher.tick();
    s._onKeyEdge('slot3', true);
    s._onKeyEdge('slot3', false);
    assert.equal(s._ledOverlays().slot3.color, '#FFFFFF', '짧게 눌러도 번쩍은 끝까지');
    advance(301);
    assert.deepEqual(s._ledOverlays(), {});
    s._onKeyEdge('slot3', true); advance(301);
    assert.deepEqual(s._ledOverlays(), {}, '누르고 있어도 hold가 없으면 평소');
  });
  it('K12 hold만 있으면 누르는 동안 바로 hold', async () => {
    const { s } = await svc({ layers: [defaultLayers()[0], chrome({ key3: sc('cmd+k', { hold: HOLD }) })] });
    await s.watcher.tick();
    s._onKeyEdge('slot3', true);
    assert.equal(s._ledOverlays().slot3.color, '#0000FF');
    s._onKeyEdge('slot3', false);
    assert.deepEqual(s._ledOverlays(), {});
  });
  it('K13 앞 앱이 바뀌면 덧칠을 지운다 (누른 채 바뀌어도, 뗄 때 찌꺼기 없음)', async () => {
    const { s, st } = await svc({ layers: [defaultLayers()[0], chrome({ key3: sc('cmd+k', { hold: HOLD }) })] });
    await s.watcher.tick();
    s._onKeyEdge('slot3', true);
    st.front = 'com.apple.finder'; await s.watcher.tick();
    assert.deepEqual(s._ledOverlays(), {});
    s._onKeyEdge('slot3', false);
    assert.deepEqual(s._ledOverlays(), {});
  });
  it('K14 Orca 모드·11번·led 없는 키·동작 없는 키는 덧칠하지 않는다', async () => {
    const [d, o] = defaultLayers();
    const { s, st } = await svc({ layers: [d, o, chrome({ key3: sc('cmd+k'), key4: sc('cmd+j', { hold: HOLD }) })], front: 'com.stablyai.orca' });
    await s.watcher.tick(); assert.equal(s.mode, 'orca');
    s._onKeyEdge('slot4', true);
    assert.deepEqual(s._ledOverlays(), {}, 'Orca 모드');
    st.front = 'com.google.Chrome'; await s.watcher.tick();
    for (const k of ['attention', 'slot3', 'slot9']) s._onKeyEdge(k, true);
    assert.deepEqual(s._ledOverlays(), {});
  });
  it('K15 입력 해석기: 받아들인 누름·뗌만 가장자리로 알린다 (디바운스·중복·유령 뗌 제외)', async () => {
    const { InputDecoder } = await import('../src/input/inputDecoder.js');
    let t = 0; const edges = [];
    const dec = new InputDecoder({ now: () => t, onKeyEdge: (k, down) => edges.push([k, down]) });
    dec.release('slot1');                    // 유령 뗌
    dec.press('slot1'); dec.press('slot1');  // 중복
    t += 100; dec.release('slot1');
    assert.deepEqual(edges, [['slot1', true], ['slot1', false]]);
  });
  it('K16 장치 알림 → 가장자리 → 덧칠 (서비스 연결)', async () => {
    const { s } = await svc({ layers: [defaultLayers()[0], chrome({ key3: sc('cmd+k', { hold: HOLD }) })] });
    await s.watcher.tick();
    s.decoder.press('slot3');
    assert.equal(s._ledOverlays().slot3.color, '#0000FF');
  });
});

describe('M14 / 최종 리뷰 반영', () => {
  it('F01 종료하면 남은 눌렀을 때 타이머가 다시 칠하지 않는다 (복원 색을 덮지 않게)', async () => {
    const { s } = await svc({ layers: [defaultLayers()[0], chrome({ key3: sc('cmd+k', { press: { color: '#FFFFFF', brightness: 'high', duration: 'long' } }) })] });
    const fired = [];
    s.timers.setTimeout = (fn) => { fired.push(fn); return fired.length; };
    s.timers.clearTimeout = () => {};
    await s.watcher.tick();
    s._onKeyEdge('slot3', true);
    assert.equal(fired.length, 1, '눌렀을 때 타이머를 건다');
    let renders = 0; const orig = s.scheduler.requestRender.bind(s.scheduler);
    s.scheduler.requestRender = () => { renders += 1; return orig(); };
    fired[0](); assert.equal(renders, 1, '살아 있으면 시간이 끝날 때 다시 칠한다');
    await s.stop();
    renders = 0;
    fired[0]();
    assert.equal(renders, 0, '종료 뒤에는 칠하지 않는다');
    assert.deepEqual(s._ledOverlays(), {});
  });
});
