/**
 * M21 — 추천 프리셋 4종 (2026-10-10 사용자 요청): 코드 편집기 · 브라우저 · 회의(Zoom) · 미디어.
 * 정책(docs/PRESET_POLICY_KO.md): 소스 고정·얼림, 정한 칸 잠금·빈 칸은 레이어, info 필수.
 * 공통: 키 1~8(미디어는 1~3)과 노브를 프리셋이 정하고, 키 9~13·조이스틱은 레이어가 정한다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, presetById, presetLockedSlots } from '../src/apps/presets.js';
import { resolveLayer, slotsOf, normalizeLayers, defaultLayers } from '../src/apps/layers.js';
import { parseKeystroke, formatKeystroke } from '../src/service/profiles.js';
import { MEDIA_KEYS } from '../src/service/keyCodes.js';
import { createKeySynth } from '../src/service/keySynth.js';
import { synthKeystroke } from '../src/service/macos.js';
import { autoLabel } from '../src/apps/actionLabel.js';

const NEW = ['code', 'browser', 'zoom', 'media', 'iterm', 'notion'];   // iTerm·Notion 2026-10-10

describe('M21 / 추천 프리셋', () => {
  it('R01 프리셋 목록: Orca 다음에 코드 편집기·브라우저·회의·미디어, 모두 얼었고 info가 있다', () => {
    assert.deepEqual(PRESETS.map((p) => p.id), ['orca', ...NEW]);
    for (const id of NEW) {
      const p = presetById(id);
      assert.ok(Object.isFrozen(p) && Object.isFrozen(p.keys) && Object.isFrozen(p.info), id);
      assert.ok(p.name && p.descriptionKo, id);
      assert.ok(p.info.createdKo && p.info.basedOnKo && p.info.behaviorKo.length && p.info.limitsKo.length, id);
      assert.equal(p.joystick, null, `${id}: 조이스틱은 레이어`);
    }
  });
  it('R02 정한 칸: 코드·브라우저·회의는 키 1~8, 미디어는 1~3 — 잠기고, 키 9~13은 비어 레이어가 정한다. 단축키는 모두 읽힌다', () => {
    const keysOf = (id) => Object.keys(presetById(id).keys).sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)));
    for (const id of ['code', 'browser', 'zoom', 'iterm', 'notion']) assert.deepEqual(keysOf(id), [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `key${n}`), id);
    assert.deepEqual(keysOf('media'), ['key1', 'key2', 'key3']);
    for (const id of NEW) {
      const p = presetById(id);
      const locked = presetLockedSlots(id);
      for (const k of Object.keys(p.keys)) assert.ok(locked.has(k), `${id} ${k} 잠김`);
      for (const n of [9, 10, 11, 12, 13]) assert.equal(locked.has(`key${n}`), false, `${id} key${n} 열림`);
      for (const a of [...Object.values(p.keys), ...Object.values(p.dial)]) {
        assert.equal(a.type, 'shortcut', `${id} ${a.label}`);
        assert.ok(parseKeystroke(a.keystroke), `${id} ${a.label} '${a.keystroke}'`);
        assert.ok(a.label, `${id} 이름`);
      }
    }
  });
  it('R03 대표 단축키 (macOS 기본값)', () => {
    const ks = (id, slot) => (slot.startsWith('dial_') ? presetById(id).dial[slot.slice(5)] : presetById(id).keys[slot]).keystroke;
    assert.equal(ks('code', 'key1'), 'cmd+shift+p');
    assert.equal(ks('code', 'key3'), 'ctrl+`');
    assert.equal(ks('code', 'dial_cw'), 'cmd+alt+right');
    assert.equal(ks('code', 'dial_press'), 'f8');
    assert.equal(ks('browser', 'key1'), 'cmd+t');
    assert.equal(ks('browser', 'dial_cw'), 'ctrl+tab');
    assert.equal(presetById('browser').dial.press, undefined, '브라우저 노브 누름은 레이어');
    assert.equal(ks('zoom', 'key1'), 'cmd+shift+a');
    assert.equal(ks('zoom', 'key2'), 'cmd+shift+v');
    assert.deepEqual(Object.keys(presetById('zoom').dial), [], '회의는 노브를 정하지 않는다');
    assert.equal(ks('media', 'key1'), 'media_play');
    assert.equal(ks('media', 'dial_cw'), 'volume_up');
    assert.equal(ks('media', 'dial_press'), 'mute');
    assert.equal(ks('iterm', 'key3'), 'cmd+d');
    assert.equal(ks('iterm', 'key6'), 'cmd+shift+enter');
    assert.equal(ks('iterm', 'key8'), 'ctrl+c');
    assert.equal(ks('iterm', 'dial_cw'), 'cmd+shift+]');
    assert.equal(ks('iterm', 'dial_press'), 'cmd+f');
    assert.equal(ks('notion', 'key1'), 'cmd+p');
    assert.equal(ks('notion', 'key3'), 'cmd+\\');
    assert.equal(ks('notion', 'dial_ccw'), 'cmd+[');
    assert.equal(ks('notion', 'dial_press'), 'cmd+j');
  });
  it('R04 앱: 코드 = VS Code·Cursor, 브라우저 = Chrome·Safari·Edge·Brave, 회의 = Zoom, 미디어 = 없음(기본 레이어에 연결 권장)', () => {
    const ids = (id) => presetById(id).defaultApps.map((a) => a.bundleId);
    assert.deepEqual(ids('code'), ['com.microsoft.VSCode', 'com.todesktop.230313mzl4w4u92']);
    assert.deepEqual(ids('browser'), ['com.google.Chrome', 'com.apple.Safari', 'com.microsoft.edgemac', 'com.brave.Browser']);
    assert.deepEqual(ids('zoom'), ['us.zoom.xos']);
    assert.deepEqual(ids('media'), []);
    assert.deepEqual(ids('iterm'), ['com.googlecode.iterm2']);
    assert.deepEqual(ids('notion'), ['notion.id']);
  });
  it('R05 레이어가 프리셋을 쓰면 앱 모드, 프리셋 칸 + 레이어 빈 칸이 합쳐진다 (프리셋 칸은 레이어 값이 덮지 못한다)', () => {
    const layers = normalizeLayers([...defaultLayers(), { id: 'l-c', kind: 'user', name: '코드', color: '#123456', preset: 'code',
      apps: [{ bundleId: 'com.microsoft.VSCode', name: 'VS Code' }],
      keys: { key1: { type: 'shortcut', label: 'x', keystroke: 'cmd+x' }, key9: { type: 'shortcut', label: '저장', keystroke: 'cmd+s' } }, dial: {}, joystick: {} }]);
    const r = resolveLayer(layers, 'com.microsoft.VSCode');
    assert.equal(r.mode, 'app');
    const s = slotsOf(r.layer);
    assert.equal(s.key1.keystroke, 'cmd+shift+p');
    assert.equal(s.key9.keystroke, 'cmd+s');
    assert.equal(s.dial_cw.keystroke, 'cmd+alt+right');
  });
});

describe('M21 / 미디어 키', () => {
  it('R06 이름: media_play·media_prev·media_next·volume_up·volume_down·mute — 읽히고, 기호로 보이고, NX 키 번호가 있다', () => {
    assert.deepEqual(MEDIA_KEYS, { media_play: 16, media_next: 17, media_prev: 18, volume_up: 0, volume_down: 1, mute: 7 });
    for (const k of Object.keys(MEDIA_KEYS)) assert.deepEqual(parseKeystroke(k), { key: k, modifiers: [] }, k);
    assert.equal(formatKeystroke(parseKeystroke('media_play')), '⏯');
    assert.equal(autoLabel({ type: 'shortcut', keystroke: 'volume_up' }), '볼륨 +');
  });
  it('R07 네이티브: 미디어 키는 postMedia(번호)로 보내고 보조키를 쓰지 않는다. postMedia가 없는 옛 모듈·권한 없음은 실패', () => {
    const calls = [];
    const native = { post: () => true, keyCodeFor: () => null, repeatTiming: () => null, trusted: () => true, postMedia: (n) => { calls.push(n); return true; } };
    assert.deepEqual(createKeySynth(native).keystroke({ key: 'volume_up', modifiers: [] }), { ok: true });
    assert.deepEqual(calls, [0]);
    const { postMedia, ...old } = native;
    assert.equal(createKeySynth(old).keystroke({ key: 'mute', modifiers: [] }).reason, 'nokey');
    assert.equal(createKeySynth({ ...native, trusted: () => false }).keystroke({ key: 'mute', modifiers: [] }).reason, 'untrusted');
  });
  it('R08 osascript로 내려가면 JavaScript(JXA)로 그 NX 번호의 시스템 키를 보낸다', async () => {
    const runs = [];
    const runner = async (cmd, args) => { runs.push([cmd, args]); return { code: 0, stdout: '', stderr: '' }; };
    assert.equal(await synthKeystroke({ key: 'media_next', modifiers: [] }, { ksynth: createKeySynth(null), runner }), 'osascript');
    assert.equal(runs[0][0], 'osascript');
    assert.deepEqual(runs[0][1].slice(0, 2), ['-l', 'JavaScript']);
    assert.match(runs[0][1][3], /otherEventWithType/);
    assert.match(runs[0][1][3], /\b17\b/);
  });
});

import { LED_BRIGHTNESS, ledStyle } from '../src/apps/keyLed.js';
import { buildDeviceScene } from '../src/device/deviceScene.js';

describe('M21 / 프리셋 키 색 · 기본 밝기 (2026-10-10)', () => {
  it('R09 추천 프리셋의 키마다 고정 색 — 프리셋 안에서 서로 다르다, 노브는 LED가 없다, Orca는 그대로', () => {
    for (const id of NEW) {
      const p = presetById(id);
      const colors = Object.values(p.keys).map((a) => a.led?.normal?.color);
      for (const c of colors) assert.match(c ?? '', /^#[0-9A-F]{6}$/, `${id} ${c}`);
      assert.equal(new Set(colors).size, colors.length, `${id} 색이 겹치지 않는다`);
      for (const a of Object.values(p.keys)) assert.deepEqual([a.led.normal.effect, a.led.normal.brightness, a.led.press, a.led.hold], ['solid', 'mid', null, null]);
      for (const a of Object.values(p.dial)) assert.equal(a.led, undefined);
    }
    assert.deepEqual(presetById('orca').keys, {});
  });
  it('R10 프리셋 레이어의 키 LED는 그 색으로 나간다 (레이어 칸 합치기에 실려 온다)', () => {
    const layers = normalizeLayers([...defaultLayers(), { id: 'l-z', kind: 'user', name: 'Z', color: '#123456', preset: 'zoom', apps: [{ bundleId: 'us.zoom.xos', name: 'zoom' }], keys: {}, dial: {}, joystick: {} }]);
    const s = slotsOf(resolveLayer(layers, 'us.zoom.xos').layer);
    assert.deepEqual(ledStyle(s.key1.led.normal, '#123456'), { color: presetById('zoom').keys.key1.led.normal.color, brightness: LED_BRIGHTNESS.mid, e: 1, s: 0.6 });
  });
  it('R11 밝기 단계 하 0.3 · 중 0.6 · 상 1.0 (실기 비교 2026-10-10), LED 설정이 없는 키도 레이어 색을 중 밝기로', () => {
    assert.deepEqual(LED_BRIGHTNESS, { low: 0.3, mid: 0.6, high: 1 });
    const scene = buildDeviceScene({ revision: 1, active: false, lighting: {}, appMode: { kind: 'app', name: 'A', color: '#E8762B', assigned: ['key4'], keyLeds: {}, underglow: null } });
    assert.deepEqual([scene.keys.slot4.color, scene.keys.slot4.brightness], ['#E8762B', 0.6]);
    assert.equal(scene.keys.slot5.color, 'off');
  });
});
