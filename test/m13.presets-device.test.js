/**
 * M13 — 프리셋·장치 화면 (스펙 docs/superpowers/specs/2026-10-04-presets-device-design.md).
 * P: 프리셋 · N: 레이어 모델 · R: 레이어 고르기·서비스 · V: 장치 준비
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ORCA_PRESET, PRESETS, presetById, presetSlots, presetLockedSlots } from '../src/apps/presets.js';
import { defaultLayers, normalizeLayers, slotsOf, joystickOf, validateLayers, resolveLayer, layerFromPreset, migrateToLayers } from '../src/apps/layers.js';
import { readSourcesFile, SOURCE_FILE_VERSION } from '../src/service/profiles.js';
import { prepareDevice, diffConfigs, otherLayerNames } from '../src/keymap/keymapModel.js';

describe('M13 / 프리셋', () => {
  it('P01 Orca 프리셋: 노브 = 다음·이전 세션, 조이스틱은 정하지 않는다 (2026-10-04 사용자 결정 — 레이어가 정함)', () => {
    assert.equal(ORCA_PRESET.dial.cw.builtin, 'next_session');
    assert.equal(ORCA_PRESET.dial.ccw.builtin, 'prev_session');
    assert.equal(ORCA_PRESET.dial.press.builtin, 'toggle_view', '노브 누름 = 모드 변경 (2026-10-04 프리셋 2)');
    assert.equal(ORCA_PRESET.joystick, null);
    assert.equal(ORCA_PRESET.keyLabels.key1, '작업 칸 1');
    assert.deepEqual(Object.keys(ORCA_PRESET.keyLabels), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => `key${n}`), '11·12·13은 레이어가 정한다 (2026-10-05)');
    assert.deepEqual(ORCA_PRESET.defaultApps, [{ bundleId: 'com.stablyai.orca', name: 'Orca' }]);
  });
  it('P02 프리셋은 고칠 수 없다 (깊게 얼림)', () => {
    assert.throws(() => { ORCA_PRESET.dial.cw.builtin = 'x'; });
    assert.throws(() => { PRESETS.push({}); });
    assert.equal(ORCA_PRESET.dial.cw.builtin, 'next_session');
  });
  it('P03 presetById·presetSlots: 모르는 id는 null·빈 칸, 칸 id는 dial_*·joystick*_*', () => {
    assert.equal(presetById('orca'), ORCA_PRESET);
    assert.equal(presetById('nope'), null);
    assert.deepEqual(presetSlots('nope'), {});
    const s = presetSlots('orca');
    assert.deepEqual(Object.keys(s).sort(), ['dial_ccw', 'dial_cw', 'dial_press']);
  });
});

const ORCA_ID = 'com.stablyai.orca';
const user = (over = {}) => ({ id: 'l-dev', kind: 'user', name: '개발', color: '#E8762B', preset: null,
  apps: [{ bundleId: 'com.microsoft.VSCode', name: 'VS Code' }],
  keys: { key3: { type: 'shortcut', label: '팔레트', keystroke: 'cmd+shift+p' } }, dial: {}, joystick: { directions: 4, short: {}, long: {} }, ...over });

describe('M13 / 레이어 모델 v6', () => {
  it('N01 기본 레이어: 기본(지울 수 없음) + Orca 프리셋 레이어(Orca 앱 연결)', () => {
    const [d, o] = defaultLayers();
    assert.equal(d.kind, 'default'); assert.equal(d.preset, null);
    assert.equal(o.kind, 'user'); assert.equal(o.preset, 'orca'); assert.equal(o.id, 'l-orca');
    assert.deepEqual(o.apps, [{ bundleId: ORCA_ID, name: 'Orca' }]);
    assert.deepEqual(normalizeLayers(null), defaultLayers());
  });
  it('N02 배열이면 그대로: Orca 레이어가 없으면 다시 만들지 않는다 (지울 수 있음)', () => {
    const ls = normalizeLayers([user()]);
    assert.deepEqual(ls.map((l) => l.id), ['default', 'l-dev']);
  });
  it('N03 모르는 프리셋 id는 직접 설정으로 읽고 노트를 남긴다', () => {
    const notes = [];
    const [, l] = normalizeLayers([user({ preset: 'zzz' })], notes);
    assert.equal(l.preset, null);
    assert.ok(notes.some((n) => /zzz/.test(n)));
  });
  it('N04 slotsOf·joystickOf: 프리셋 레이어는 프리셋 칸(노브), 조이스틱은 레이어 것, 직접 설정은 자기 칸', () => {
    const [, o] = defaultLayers();
    assert.equal(slotsOf(o).dial_cw.builtin, 'next_session');
    assert.equal(slotsOf(o).joystick_up, undefined, 'Orca 프리셋은 조이스틱을 정하지 않는다');
    assert.equal(joystickOf(o), o.joystick);
    assert.equal(slotsOf(user()).key3.keystroke, 'cmd+shift+p');
  });
  it('N05 프리셋을 연결해도 직접 설정 칸은 보관된다 (실행엔 안 씀) — 직접 설정으로 돌리면 그대로', () => {
    const [, l] = normalizeLayers([user({ preset: 'orca' })]);
    assert.equal(l.keys.key3.keystroke, 'cmd+shift+p');
    assert.equal(slotsOf(l).key3, undefined);
    assert.equal(slotsOf({ ...l, preset: null }).key3.keystroke, 'cmd+shift+p');
  });
  it('N06 v5 Orca 레이어 → Orca 프리셋 레이어 + Orca 앱, 프리셋과 다른 칸은 노트', () => {
    const notes = [];
    const v5orca = { id: 'orca', kind: 'orca', color: '#123456', dial: { cw: { type: 'shortcut', label: '앞', keystroke: 'cmd+]' }, ccw: { type: 'builtin', builtin: 'prev_session' } }, joystick: { directions: 4, short: {}, long: {} } };
    const ls = normalizeLayers([v5orca, { id: 'default', kind: 'default' }], notes);
    const o = ls.find((l) => l.id === 'l-orca');
    assert.equal(o.preset, 'orca'); assert.equal(o.kind, 'user'); assert.equal(o.color, '#123456');
    assert.deepEqual(o.apps, [{ bundleId: ORCA_ID, name: 'Orca' }]);
    assert.deepEqual(o.dial, {});
    assert.ok(notes.some((n) => /노브 시계/.test(n)), notes.join('|'));
    assert.deepEqual(ls.map((l) => l.id), ['default', 'l-orca']);
  });
  it('N07 v5에서 Orca 앱이 이미 다른 레이어에 있으면 옮긴 Orca 레이어에는 넣지 않는다', () => {
    const ls = normalizeLayers([{ id: 'orca', kind: 'orca' }, user({ apps: [{ bundleId: ORCA_ID, name: 'Orca' }] })]);
    assert.deepEqual(ls.find((l) => l.id === 'l-orca').apps, []);
    assert.equal(validateLayers(ls).ok, true);
  });
  it('N08 검증: builtin은 어느 레이어에도 저장 못 함, 앱 중복 연결 거부', () => {
    const bad = normalizeLayers([user({ dial: { cw: { type: 'builtin', builtin: 'next_session', label: '다음 세션' } } })]);
    assert.equal(validateLayers(bad).ok, false);
    const dup = normalizeLayers([user(), user({ id: 'l-b', name: 'B' })]);
    assert.equal(validateLayers(dup).ok, false);
  });
  it('N09 layerFromPreset: 단축키만 복사, builtin·앱은 비움', () => {
    const l = layerFromPreset('orca', 'l-copy-1');
    assert.equal(l.preset, null); assert.equal(l.kind, 'user'); assert.deepEqual(l.apps, []);
    assert.equal(l.name, 'Orca 복사본');
    assert.deepEqual(l.dial, {}, 'Orca 노브는 Orca 동작이라 복사되지 않는다');
    assert.deepEqual(l.joystick, { directions: 4, axis: 'vertical', short: {}, long: {} });
    assert.equal(validateLayers(normalizeLayers([l])).ok, true);
    assert.equal(layerFromPreset('nope', 'l-x'), null);
  });
  it('N10 resolveLayer: Orca 프리셋 레이어의 앱 → orca, 직접 설정 → app, 연결 없음 → 기본(비어 있어도, 2026-10-11)', () => {
    const ls = normalizeLayers([{ id: 'default', kind: 'default' }, defaultLayers()[1], user()]);
    assert.equal(resolveLayer(ls, ORCA_ID).mode, 'orca');
    assert.equal(resolveLayer(ls, 'com.microsoft.VSCode').mode, 'app');
    assert.equal(resolveLayer(ls, 'com.apple.finder').layer.kind, 'default');
    const noOrca = normalizeLayers([user()]);
    assert.notEqual(resolveLayer(noOrca, ORCA_ID).mode, 'orca', 'Orca 레이어가 없으면 Orca가 앞이어도 Orca 모드가 아니다 (기본 레이어로)');
    const iterm = normalizeLayers([{ ...defaultLayers()[1], apps: [{ bundleId: 'com.googlecode.iterm2', name: 'iTerm' }] }]);
    assert.equal(resolveLayer(iterm, 'com.googlecode.iterm2').mode, 'orca', '다른 앱에 Orca 프리셋을 연결해도 된다');
    const defPreset = normalizeLayers([{ id: 'default', kind: 'default', preset: 'orca' }]);
    assert.equal(resolveLayer(defPreset, 'com.apple.finder').mode, 'orca', '기본에도 프리셋을 연결할 수 있다');
  });
  it('N11 v4 옮기기는 v6 모양으로 — 조이스틱은 열린 칸이라 단축키를 살리고, Orca 동작 칸만 노트', () => {
    const notes = [];
    const ls = migrateToLayers({ controlsRaw: { joystickHold: { down: { labelKo: '탭', keystroke: 'cmd+1' } } }, appKeysRaw: null }, notes);
    const o = ls.find((l) => l.id === 'l-orca');
    assert.equal(o.preset, 'orca');
    assert.equal(slotsOf(o).joystickHold_down.keystroke, 'cmd+1');
    assert.ok(notes.some((n) => /옮기지 못한.*조이스틱 아래 \(다음 미확인 완료\)/.test(n)), notes.join('|'));
  });
  it('N12 profiles.json v6: v5·v6은 layersRaw, 더 새 버전은 거부', () => {
    assert.equal(SOURCE_FILE_VERSION, 6);
    assert.ok(readSourcesFile({ version: 5, layers: [] }, []).layersRaw);
    assert.ok(readSourcesFile({ version: 6, layers: [] }, []).layersRaw);
    assert.ok(readSourcesFile({ version: 7, layers: [] }, []).warningKo);
  });
});
async function svc({ layers, front = ORCA_ID }) {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { OutputService } = await import('../src/service/outputService.js');
  const { UNCALIBRATED } = await import('../src/device/calibrationLoader.js');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-m13-'));
  if (layers) fs.writeFileSync(path.join(stateDir, 'profiles.json'), JSON.stringify({ version: 6, layers }));
  const st = { front }; const calls = [];
  const s = new OutputService({ calibration: UNCALIBRATED, stateDir,
    openRuntimeTransport: async () => { const e = new Error('x'); e.code = 'DEVICE_NOT_FOUND'; throw e; },
    orcaEnabled: false, frontmost: async () => st.front, ownBundleIds: ['dev.output.keypad'],
    displays: () => [{ id: 1, primary: true, workArea: { x: 0, y: 25, width: 1440, height: 875 } }],
    appExec: { synth: async (k) => calls.push(['synth', k]), openApp: async () => ({ code: 0 }), openUrl: async () => ({ code: 0 }),
      execCommand: async () => ({ code: 0 }), readClipboard: async () => '', writeClipboard: async () => ({ code: 0 }), moveWindow: async () => ({ ok: true }), hasWindow: async () => true },
    timers: { setInterval: () => ({}), clearInterval: () => {} } });
  return { s, st, calls, stateDir };
}

describe('M13 / 서비스', () => {
  it('R01 새로 시작: Orca가 앞이면 Orca 모드, 조이스틱은 비어 있어 아무것도 보내지 않는다', async () => {
    const { s, calls } = await svc({});
    await s.watcher.tick();
    assert.equal(s.mode, 'orca');
    await s._onIntent({ type: 'joystick', direction: 'up', hold: false });
    assert.deepEqual(calls, []);
  });
  it('R02 v5 파일을 읽으면 Orca 프리셋 레이어로 옮기고 노트, 저장은 v6', async () => {
    const fs = await import('node:fs'); const path = await import('node:path');
    const { s, stateDir } = await svc({});
    fs.writeFileSync(path.join(stateDir, 'profiles.json'), JSON.stringify({ version: 5, layers: [{ id: 'orca', kind: 'orca', dial: {} }] }));
    s._loadSources();
    assert.equal(s.layers.find((l) => l.id === 'l-orca').preset, 'orca');
    assert.ok(s._sourcesNotesKo.some((n) => /프리셋과 달라/.test(n)));
    assert.equal(s.layersSave(s.layersGet()).ok, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, 'profiles.json'), 'utf8')).version, 6);
  });
  it('R03 프리셋이 비운 조이스틱은 레이어 칸이 실행되고, 프리셋이 정한 노브 칸에 남은 직접 칸은 실행되지 않는다', async () => {
    const [d, o] = defaultLayers();
    const { s, calls } = await svc({ layers: [d, { ...o, dial: { cw: { type: 'shortcut', label: 'z', keystroke: 'cmd+z' } }, joystick: { directions: 4, short: { up: { type: 'shortcut', label: 'x', keystroke: 'cmd+x' } }, long: {} } }] });
    await s.watcher.tick();
    await s._onIntent({ type: 'joystick', direction: 'up', hold: false });
    assert.deepEqual(calls.at(-1), ['synth', { key: 'x', modifiers: ['command'] }]);
    let stepped = 0; s.bridge.runBuiltin = (b) => { if (b === 'next_session') stepped += 1; return null; };
    await s._onIntent({ type: 'dial', direction: 'cw' });
    assert.equal(stepped, 1, '노브는 프리셋 칸');
  });
  it('R04 presetsList·presetCopy: 목록은 사본, 복사는 직접 설정 레이어', async () => {
    const { s } = await svc({});
    const list = s.presetsList();
    list[0].name = '바꿈';
    assert.equal(s.presetsList()[0].name, 'Orca');
    const c = s.presetCopy('orca');
    assert.match(c.id, /^l-copy-\d+$/);
    assert.equal(c.preset, null);
    assert.equal(s.presetCopy('nope'), null);
  });
  it('R05 Orca 레이어를 지우면 Orca가 앞이어도 Orca 모드가 아니고, orcaUnlinked가 true', async () => {
    const { s } = await svc({ layers: [defaultLayers()[0]] });
    await s.watcher.tick();
    assert.notEqual(s.mode, 'orca');
    assert.equal(s.bridge.active, false);
    assert.equal(s.orcaUnlinked(), true);
    const ok = await svc({});
    assert.equal(ok.s.orcaUnlinked(), false);
  });
});

const cell = (c) => c;
function km({ layers, active = 0, profiles = 1 }) {
  const layer = (name, enc = ['KV_OAI_ENC_CC', 'KV_OAI_ENC_CW', 'KI_LS2'], color = '#1F9E96') => ({ name, color,
    layout: { keymap: [['KV_OAI_AG00', 'KV_OAI_AG01'], ['KV_OAI_AG02', 'KV_OAI_AG03', 'KV_OAI_AG04', 'KV_OAI_AG05'], ['KA_0', 'KV_OAI_AG07', 'KV_OAI_AG08', 'KV_OAI_AG09'], ['KV_OAI_AG10', 'KV_OAI_AG11', 'KV_OAI_AG12']].map((r) => r.map(cell)),
      encoders: [enc], joystick: { type: 'VENDOR', sectors: [] } } });
  return { activeProfileId: active, profiles: Array.from({ length: profiles }, (_, i) => ({ id: i, layers: layers.map((n) => layer(n)) })) };
}

describe('M13 / 장치 준비', () => {
  it('V01 Output 하나만 남기고 다른 레이어는 지운다, 노브 누름 ENC_CLK', () => {
    const r = prepareDevice(km({ layers: ['Output', 'Output Fallback'] }));
    const ls = r.config.profiles[0].layers;
    assert.deepEqual(ls.map((l) => l.name), ['Output']);
    assert.deepEqual(ls[0].layout.encoders[0], ['KV_OAI_ENC_CC', 'KV_OAI_ENC_CW', 'KV_OAI_ENC_CLK']);
    assert.ok(r.changesKo.some((s) => /삭제: Output Fallback/.test(s)));
  });
  it('V02 키 7~10의 매크로는 AG로 덮는다', () => {
    const r = prepareDevice(km({ layers: ['Output'] }));
    assert.equal(r.config.profiles[0].layers[0].layout.keymap[2][0], 'KV_OAI_AG06');
  });
  it('V03 기존 Output 레이어 색을 유지한다', () => {
    const base = km({ layers: ['Output'] });
    base.profiles[0].layers[0].color = '#ABCDEF';
    assert.equal(prepareDevice(base).config.profiles[0].layers[0].color, '#ABCDEF');
  });
  it('V04 활성 프로필만 바꾼다', () => {
    const base = km({ layers: ['Output', 'Mine'], active: 1, profiles: 2 });
    const r = prepareDevice(base);
    assert.deepEqual(r.config.profiles[0].layers.map((l) => l.name), ['Output', 'Mine']);
    assert.deepEqual(r.config.profiles[1].layers.map((l) => l.name), ['Output']);
  });
  it('V05 이미 준비된 장치는 바뀌는 목록이 비어 있다', () => {
    const once = prepareDevice(km({ layers: ['Output', 'Output Fallback'] })).config;
    assert.deepEqual(diffConfigs(once, prepareDevice(once).config), []);
  });
  it('V06 장치가 없으면 devicePlan은 쓰지 않고 이유를 돌려준다, deviceStatus는 연결 안 됨', async () => {
    const { s } = await svc({});
    const p = await s.devicePlan();
    assert.equal(p.ok, false);
    assert.match(p.errorKo, /연결/);
    assert.equal(s.deviceStatus().connected, false);
    assert.equal((await s.deviceApply()).ok, false);
  });
});
describe('M13 / 장치 준비 뒤 상태 (스크린샷 확인 2026-10-04)', () => {
  it('V07 레이어가 하나뿐이면 장치가 옛 레이어 번호(2)를 알려 줘도 그 레이어로 본다 → 준비됨', async () => {
    const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
    const { OutputService } = await import('../src/service/outputService.js');
    const { UNCALIBRATED } = await import('../src/device/calibrationLoader.js');
    const { fakeDevicePair } = await import('../src/device/fakeDevicePair.js');
    const fake = fakeDevicePair();
    const s = new OutputService({ calibration: UNCALIBRATED, stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cb-v07-')),
      openRuntimeTransport: async () => fake.runtime(), orcaEnabled: false, timers: { setInterval: () => ({}), clearInterval: () => {} } });
    await s.start();
    const st = s.deviceStatus();
    assert.equal(st.connected, true);
    assert.equal(st.layerName, 'Output');
    assert.deepEqual(st.reasonsKo, []);
    assert.equal(st.ready, true);
    await s.stop();
  });
});

describe('M13 / 최종 리뷰 반영 (2026-10-04)', () => {
  it('F01 Orca 레이어를 지우면 Orca 앞에서 기본 레이어 단축키가 나간다', async () => {
    const def = { ...defaultLayers()[0], joystick: { directions: 4, axis: 'vertical', short: { up: { type: 'shortcut', label: 'X', keystroke: 'cmd+x' } }, long: {} } };
    const { s, calls } = await svc({ layers: [def] });
    await s.watcher.tick();
    assert.equal(s.mode, 'app');
    await s._onIntent({ type: 'joystick', direction: 'up', hold: false });
    assert.deepEqual(calls.at(-1), ['synth', { key: 'x', modifiers: ['command'] }]);
  });
  it('F02 장치 준비는 장치가 쓰는 프로필(profile_index)을 바꾼다 — activeProfileId가 null이어도', () => {
    const base = km({ layers: ['Output', 'Mine'], profiles: 2 });
    base.activeProfileId = null;
    base.profiles.forEach((p, i) => { p.id = i === 0 ? 'default' : 'work'; });
    const r = prepareDevice(base, { profileIndex: 1 });
    assert.deepEqual(r.config.profiles[0].layers.map((l) => l.name), ['Output', 'Mine'], '쓰지 않는 프로필은 그대로');
    assert.deepEqual(r.config.profiles[1].layers.map((l) => l.name), ['Output']);
  });
  it('F03 조이스틱 설정만 달라도 바뀌는 목록에 나온다 (다시 쓰기로 고칠 수 있게)', () => {
    const base = prepareDevice(km({ layers: ['Output'] })).config;
    base.profiles[0].layers[0].layout.joystick = { type: 'RADIAL', sectors: [] };
    assert.ok(diffConfigs(base, prepareDevice(base).config).some((l) => /조이스틱/.test(l)));
  });
  it('F04 Output 레이어의 조명은 다른 레이어가 아니라 원래 Output 것을 유지한다', () => {
    const base = km({ layers: ['ChatGPT', 'Output'] });
    base.profiles[0].layers[0].lights = { backlight: { effect: 'solid', color: '#FF0000' } };
    base.profiles[0].layers[1].lights = { backlight: { effect: 'solid', color: '#00FF00' } };
    assert.deepEqual(prepareDevice(base).config.profiles[0].layers[0].lights, { backlight: { effect: 'solid', color: '#00FF00' } });
  });
});

describe('M13 / 미룬 작은 문제 (2026-10-04)', () => {
  it('M01 다른 레이어 이름: 이름이 없으면 장치의 원래 번호로 (지금 레이어를 빼도 번호가 밀리지 않는다)', () => {
    const cur = { name: 'Output' };
    assert.deepEqual(otherLayerNames([cur, {}, { name: 'Mine' }, {}], cur), ['레이어 2', 'Mine', '레이어 4']);
    assert.deepEqual(otherLayerNames([cur], cur), []);
  });
});

describe('M13 / 프리셋이 비운 칸은 레이어가 정한다 (2026-10-04 사용자 결정)', () => {
  const sc = (k) => ({ type: 'shortcut', label: k, keystroke: k });
  const orcaWith = (over) => ({ ...defaultLayers()[1], ...over });
  it('Q01 프리셋이 정한 칸: Orca는 키 1~10, 노브 회전·누름 — 키 11·12·13과 조이스틱 전부는 비어 있다', () => {
    const locked = presetLockedSlots('orca');
    for (const id of ['key1', 'key10', 'dial_cw', 'dial_ccw', 'dial_press']) assert.ok(locked.has(id), id);
    for (const id of ['joystick_up', 'joystick_down', 'joystickHold_down', 'joystickHold_up', 'joystick_up_left', 'key11', 'key12', 'key13']) assert.equal(locked.has(id), false, id);
    assert.deepEqual([...presetLockedSlots('nope')], []);
  });
  it('Q02 실행 칸 = 레이어의 빈 칸 동작 + 프리셋 칸 (프리셋이 이긴다), 조이스틱을 정하지 않은 프리셋이면 방향 수도 레이어 것', () => {
    const l = orcaWith({ dial: { press: sc('cmd+k'), cw: sc('cmd+z') },
      joystick: { directions: 8, axis: 'vertical', short: { up: sc('cmd+x'), up_left: sc('cmd+q') }, long: { up: sc('cmd+u') } } });
    const s = slotsOf(l);
    assert.equal(s.dial_press.builtin, 'toggle_view', '프리셋 칸이 이긴다');
    assert.equal(s.dial_cw.builtin, 'next_session', '프리셋 칸은 그대로');
    assert.equal(s.joystick_up.keystroke, 'cmd+x');
    assert.equal(s.joystickHold_up.keystroke, 'cmd+u');
    assert.equal(s.joystick_up_left.keystroke, 'cmd+q', '레이어가 8방향이면 대각선도');
    assert.equal(joystickOf(l).directions, 8);
  });
  it('Q03 Orca 모드에서 조이스틱 위 길게에 넣은 레이어 동작이 실행된다 (노브 누름은 프리셋의 모드 변경)', async () => {
    const [d, o] = defaultLayers();
    const { s, calls } = await svc({ layers: [d, { ...o, dial: { press: sc('cmd+k') }, joystick: { directions: 4, axis: 'vertical', short: {}, long: { up: sc('cmd+u') } } }] });
    await s.watcher.tick(); assert.equal(s.mode, 'orca');
    let modeBack = 0; s.bridge.pressModeBack = () => { modeBack += 1; return true; };
    await s._onIntent({ type: 'tap', key: 'dial_click' });
    assert.equal(modeBack, 1);
    assert.equal(calls.length, 0, '레이어에 남은 노브 누름 단축키는 실행되지 않는다');
    assert.deepEqual([...s.decoder._holdDirs], ['up'], '길게 판정은 레이어의 길게 칸만');
    await s._onIntent({ type: 'joystick', direction: 'up', hold: true });
    assert.deepEqual(calls.at(-1), ['synth', { key: 'u', modifiers: ['command'] }]);
  });
  it('Q04 프리셋 소개: 만든 날짜·기준 Orca 버전·동작·제약', () => {
    assert.equal(ORCA_PRESET.info.createdKo, '2026-10-04');
    assert.match(ORCA_PRESET.info.basedOnKo, /Orca 1\.4\.219/);
    assert.ok(ORCA_PRESET.info.behaviorKo.length >= 3);
    assert.ok(ORCA_PRESET.info.limitsKo.some((t) => /조이스틱/.test(t) && /레이어/.test(t)));
  });
});

describe('M13 / 옮기기 — 열린 칸은 살린다', () => {
  it('Q05 v5 Orca 레이어의 조이스틱 단축키는 옮기고, 노브 누름(이제 프리셋 칸)과 조이스틱의 Orca 동작은 노트', () => {
    const notes = [];
    const v5 = { id: 'orca', kind: 'orca', dial: { cw: { type: 'builtin', builtin: 'next_session' }, ccw: { type: 'builtin', builtin: 'prev_session' }, press: { type: 'shortcut', label: '받아쓰기', keystroke: 'cmd+e' } },
      joystick: { directions: 4, short: { up: { type: 'shortcut', label: '받아쓰기', keystroke: 'cmd+e' }, down: { type: 'builtin', builtin: 'next_unseen' } }, long: { up: { type: 'shortcut', label: '위', keystroke: 'cmd+u' } } } };
    const o = normalizeLayers([v5], notes).find((l) => l.id === 'l-orca');
    assert.equal(o.dial.press, undefined);
    assert.equal(o.joystick.short.up.keystroke, 'cmd+e');
    assert.equal(o.joystick.short.down, undefined);
    assert.equal(o.joystick.long.up.keystroke, 'cmd+u');
    assert.equal(slotsOf(o).dial_press.builtin, 'toggle_view');
    assert.deepEqual(notes, ['프리셋과 달라 버린 Orca 설정: 노브 누름 (받아쓰기)', 'Orca 동작이라 옮기지 못한 칸: 조이스틱 아래 (다음 미확인 완료)']);
  });
});

describe('M13 / Orca 프리셋 2·3 — 노브 누름 모드 변경, 상세 보기 노브 = 터미널 탭 (2026-10-04), 키 11·12·13은 레이어 (2026-10-05)', () => {
  const sc = (k) => ({ type: 'shortcut', label: k, keystroke: k });
  it('S01 Orca 프리셋: 키 11·12·13을 정하지 않는다 — 레이어가 정한다 (2026-10-05), 노브 누름 = 모드 변경', () => {
    const s = presetSlots('orca');
    for (const id of ['key11', 'key12', 'key13']) {
      assert.equal(s[id], undefined, id);
      assert.equal(ORCA_PRESET.keyLabels[id], undefined, id);
    }
    assert.equal(s.dial_press.builtin, 'toggle_view');
    assert.ok(presetLockedSlots('orca').has('dial_press'));
  });
  it('S02 Orca 모드: 키 11·12·13은 Orca 레이어 칸 — 비어 있으면 아무것도 안 함(ATTENTION·ACK·모드 변경 없음), 길게는 아무것도 안 함, 노브 누름은 모드 변경', async () => {
    const [d, o] = defaultLayers();
    const { s, calls } = await svc({ layers: [d, o] });
    await s.watcher.tick(); assert.equal(s.mode, 'orca');
    const used = [];
    for (const m of ['pressAttention', 'pressAttentionAnywhere', 'pressAck', 'pressModeBack', 'longPressAttention', 'longPressModeBack']) {
      s.bridge[m] = () => { used.push(m); return true; };
    }
    for (const key of ['attention', 'ack', 'mode_back']) await s._onIntent({ type: 'tap', key });
    assert.deepEqual(used, [], '빈 칸은 Output 동작으로 떨어지지 않는다');
    assert.deepEqual(calls, []);
    const { s: s2, calls: calls2 } = await svc({ layers: [d, { ...o, keys: { key11: sc('cmd+1'), key12: sc('cmd+2'), key13: sc('cmd+e') } }] });
    await s2.watcher.tick();
    for (const key of ['attention', 'ack', 'mode_back']) {
      await s2._onIntent({ type: 'tap', key });
      await new Promise((r) => { setTimeout(r, 5); });
    }
    assert.deepEqual(calls2.map((c) => c[1].key), ['1', '2', 'e'], '레이어에 넣은 단축키가 나간다');
    await s2._onIntent({ type: 'hold', key: 'mode_back' });
    assert.equal(calls2.length, 3, '길게는 아무것도 안 함');
    let modeBack = 0; s2.bridge.pressModeBack = () => { modeBack += 1; return true; };
    await s2._onIntent({ type: 'tap', key: 'dial_click' });
    assert.equal(modeBack, 1);
  });
  it('S05 Orca 모드 장면: 키 11·12·13 LED는 레이어 칸을 따른다 (빈 칸 꺼짐, 넣은 칸 레이어 색·키 LED 설정)', async () => {
    const [d, o] = defaultLayers();
    const { s } = await svc({ layers: [d, { ...o, keys: { key11: sc('cmd+1'), key13: { ...sc('cmd+e'), led: { normal: { color: '#00FF00', effect: 'solid', brightness: 'normal' } } } } }] });
    await s.watcher.tick(); assert.equal(s.mode, 'orca');
    const { buildDeviceScene } = await import('../src/device/deviceScene.js');
    const scene = buildDeviceScene(s.bridge.render(), {});
    assert.deepEqual(scene.keys.attention, { color: o.color, brightness: 0.6, pattern: 'solid' }, '키 11 = 레이어 색 (중 밝기 0.6, 2026-10-10)');
    assert.equal(scene.keys.ack.color, 'off', '키 12 빈 칸');
    assert.equal(scene.keys.mode_back.color, '#00FF00', '키 13 = 키 LED 설정');
    assert.ok(scene.keys.slot1, '작업 칸은 그대로 Output이 그린다');
  });
  it('S03 상세 보기에서 노브: 그 작업의 다음/이전 터미널로 이동(빈 칸 건너뜀, 끝에서 처음으로)', async () => {
    const { Output } = await import('../src/output.js');
    const { StateStore } = await import('../src/core/stateStore.js');
    const { WorkUnit, ChildUnit } = await import('../src/core/units.js');
    const { MockFocusRouter } = await import('../src/core/focusRouter.js');
    const store = new StateStore();
    const u = new WorkUnit({ id: 'w1', title: 'w1' });
    for (const id of ['t1', 't2', 't3']) u.addChild?.(new ChildUnit({ id, title: id })) ?? u.children.push(new ChildUnit({ id, title: id }));
    store.addUnit(u);
    const router = new MockFocusRouter();
    const o = new Output({ store, focusRouter: router });
    assert.equal(o.enterDetail('w1'), true);
    o.runBuiltin('next_session'); await o.dialIdle();
    assert.equal(router.last().childId, 't2');
    o.runBuiltin('next_session'); await o.dialIdle();
    o.runBuiltin('next_session'); await o.dialIdle();
    assert.equal(router.last().childId, 't1', '끝에서 처음으로');
    o.runBuiltin('prev_session'); await o.dialIdle();
    assert.equal(router.last().childId, 't3');
    assert.equal(router.last().unitId, 'w1');
    assert.equal(o.runBuiltin('toggle_view'), true, '노브 누름 = 뒤로(전체 보기)');
  });
});

describe('M13 / 상태판 — 지금 레이어·레이어 목록 (2026-10-04 사용자 요청)', () => {
  const chrome = { id: 'l-chrome', kind: 'user', name: '크롬', color: '#E8762B', preset: null,
    apps: [{ bundleId: 'com.google.Chrome', name: 'Google Chrome' }], keys: { key3: { type: 'shortcut', label: 'x', keystroke: 'cmd+x' } }, dial: {}, joystick: { directions: 4, short: {}, long: {} } };
  it('U01 Orca 앞: 지금 = Orca 레이어, 활성 레이어 하나, 모드 Orca', async () => {
    const [d, o] = defaultLayers();
    const { s } = await svc({ layers: [d, o, chrome] });
    await s.watcher.tick();
    const l = s.view().layerLine;
    assert.equal(l.mode, 'orca');
    assert.equal(l.nowKo, 'Orca 레이어 — Orca 앞');
    assert.deepEqual(l.layers.map((x) => [x.name, x.active]), [['기본', false], ['Orca', true], ['크롬', false]]);
    assert.equal(l.layers[1].color, '#1F9E96');
  });
  it('U02 Chrome 앞: 지금 = 크롬 레이어 — Google Chrome 앞 · 연결 없는 앱이면 기본 레이어와 앱 이름 (2026-10-11: 대기 없음)', async () => {
    const [d, o] = defaultLayers();
    const { s, st } = await svc({ layers: [d, o, chrome], front: 'com.google.Chrome' });
    await s.watcher.tick();
    assert.equal(s.view().layerLine.nowKo, '크롬 레이어 — Google Chrome 앞');
    assert.equal(s.view().layerLine.mode, 'app');
    st.front = 'com.apple.finder'; await s.watcher.tick();
    const l = s.view().layerLine;
    assert.equal(l.mode, 'app');
    assert.equal(l.nowKo, '기본 레이어 — finder 앞');
    assert.deepEqual(l.layers.filter((x) => x.active).map((x) => x.id), ['default']);
  });
  it('U03 옛 문구가 없다: "키 세트", "Orca로 가면 켜집니다"', async () => {
    const [d, o] = defaultLayers();
    const { s, st } = await svc({ layers: [d, o, chrome], front: 'com.google.Chrome' });
    await s.watcher.tick();
    assert.doesNotMatch(JSON.stringify(s.view()), /키 세트/);
    st.front = 'com.apple.finder'; await s.watcher.tick();
    assert.doesNotMatch(JSON.stringify(s.view()), /Orca로 가면/);
  });
});
