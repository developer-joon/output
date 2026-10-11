/**
 * M12 — 레이어 (스펙 docs/superpowers/specs/2026-10-03-layers-design.md).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sectorsFor, dirsFor } from '../src/service/controls.js';
import { InputDecoder } from '../src/input/inputDecoder.js';
import { BUILTINS, defaultLayers, normalizeLayers, validateLayers, resolveLayer, flattenSlots, slotsOf, migrateToLayers } from '../src/apps/layers.js';
import { readSourcesFile, SOURCE_FILE_VERSION } from '../src/service/profiles.js';

const CAL4 = [
  { direction: 'right', center: 0.0173, from: 0.8821, to: 0.1351 },
  { direction: 'down', center: 0.2529, from: 0.1351, to: 0.366 },
  { direction: 'left', center: 0.4791, from: 0.366, to: 0.613 },
  { direction: 'up', center: 0.7469, from: 0.613, to: 0.8821 },
];
const dirAt = (sectors, angle) => {
  const out = [];
  const d = new InputDecoder({ sectors, deadzone: 0.05, onIntent: (i) => out.push(i.direction) });
  d.joystickPolar({ angle, distance: 1 });
  return out[0];
};

describe('M12 / 조이스틱 구간', () => {
  it('L01 방향 이름: 1=any, 2=축, 4, 8', () => {
    assert.deepEqual(dirsFor(1), ['any']);
    assert.deepEqual(dirsFor(2, 'vertical'), ['up', 'down']);
    assert.deepEqual(dirsFor(2, 'horizontal'), ['left', 'right']);
    assert.equal(dirsFor(4).length, 4);
    assert.equal(dirsFor(8).length, 8);
  });
  it('L02 1방향: 어느 각도든 any', () => {
    const s = sectorsFor(1, CAL4);
    for (const a of [0, 0.2, 0.5, 0.75, 0.99]) assert.equal(dirAt(s, a), 'any');
  });
  it('L03 2방향: 세로는 위/아래, 가로는 왼쪽/오른쪽, 대각선은 가까운 쪽', () => {
    const v = sectorsFor(2, CAL4, 'vertical');
    assert.equal(dirAt(v, 0.75), 'up');
    assert.equal(dirAt(v, 0.25), 'down');
    assert.equal(dirAt(v, 0.30), 'down', '오른쪽 아래 대각선 → 아래');
    const h = sectorsFor(2, CAL4, 'horizontal');
    assert.equal(dirAt(h, 0.02), 'right');
    assert.equal(dirAt(h, 0.48), 'left');
    assert.equal(dirAt(h, 0.40), 'left', '왼쪽 아래 대각선 → 왼쪽');
  });
  it('L04 4·8은 예전과 같고, 보정이 없으면 null', () => {
    assert.equal(sectorsFor(4, CAL4), CAL4);
    assert.equal(sectorsFor(8, CAL4).length, 8);
    assert.equal(sectorsFor(2, null), null);
  });
});


const ORCA_IDS = ['com.stablyai.orca'];
const devLayer = (over = {}) => ({ id: 'l-dev', kind: 'user', name: '개발', color: '#E8762B',
  apps: [{ bundleId: 'com.microsoft.VSCode', name: 'VS Code' }, { bundleId: 'com.jetbrains.intellij', name: 'IntelliJ' }],
  keys: { key3: { type: 'shortcut', label: '팔레트', keystroke: 'cmd+shift+p' } },
  dial: {}, joystick: { directions: 2, axis: 'vertical', short: { up: { type: 'shortcut', label: '위', keystroke: 'up' } }, long: {} }, ...over });

describe('M12 / 레이어 모델', () => {
  it('L05 기본 레이어 둘: 기본(빈)·Orca 프리셋 레이어(노브=다음·이전 세션, 조이스틱 비어 있음) — 2026-10-04 프리셋', () => {
    const [d, o] = defaultLayers();
    assert.equal(o.preset, 'orca'); assert.equal(d.kind, 'default');
    assert.deepEqual(slotsOf(o).dial_cw, { type: 'builtin', builtin: 'next_session', label: '다음 세션' });
    assert.equal(slotsOf(o).joystickHold_down, undefined);
    assert.deepEqual(d.keys, {});
    assert.ok(BUILTINS.includes('attention'));
  });
  it('L06 normalize: 기본은 맨 앞, 옛 Orca 레이어(kind orca)는 프리셋 레이어로 옮기며 keys를 버림', () => {
    const ls = normalizeLayers([devLayer(), { id: 'orca', kind: 'orca', keys: { key1: { type: 'shortcut', label: 'x', keystroke: 'a' } } }]);
    assert.deepEqual(ls.map((l) => l.id), ['default', 'l-orca', 'l-dev']);
    assert.deepEqual(ls[1].keys, {});
    assert.deepEqual(normalizeLayers(null).map((l) => l.id), ['default', 'l-orca']);
  });
  it('L07 레이어 고르기: Orca → orca 모드, 연결 앱 → 그 레이어, 한 레이어에 여러 앱, 미연결 → 기본(비어 있어도, 2026-10-11)', () => {
    const ls = normalizeLayers([defaultLayers()[1], devLayer()]);
    assert.equal(resolveLayer(ls, 'com.stablyai.orca').mode, 'orca');
    assert.equal(resolveLayer(ls, 'com.jetbrains.intellij').layer.id, 'l-dev');
    assert.equal(resolveLayer(ls, 'com.microsoft.VSCode').layer.id, 'l-dev');
    assert.equal(resolveLayer(ls, 'com.apple.finder').layer.kind, 'default', '비어 있어도 기본');
    ls[0].keys.key1 = { type: 'openApp', label: 'Slack', bundleId: 'com.tinyspeck.slackmacgap' };
    assert.equal(resolveLayer(ls, 'com.apple.finder').layer.kind, 'default');
  });
  it('L08 validate: 같은 앱이 두 레이어 · builtin은 Orca에서만 · 방향 이름', () => {
    const v = validateLayers(normalizeLayers([
      devLayer(),
      devLayer({ id: 'l-two', name: '둘', apps: [{ bundleId: 'com.microsoft.VSCode', name: 'VS Code' }],
        keys: { key1: { type: 'builtin', builtin: 'attention', label: 'a' } } }),
    ]));
    assert.equal(v.ok, false);
    assert.ok(v.errorsKo.some((e) => /VS Code/.test(e) && /개발/.test(e) && /둘/.test(e)));
    assert.ok(v.errorsKo.some((e) => /Orca 프리셋에서만/.test(e)));
    assert.equal(validateLayers(normalizeLayers([devLayer()])).ok, true);
  });
  it('L09 칸 펼치기: keys·dial·현재 방향의 joystick_/joystickHold_', () => {
    const f = flattenSlots(normalizeLayers([devLayer()])[1]);
    assert.ok(f.key3 && f.joystick_up);
    assert.equal(Object.keys(f).some((k) => k.startsWith('joystick_left')), false);
  });
  it('L10 방향 수를 줄이면 다른 방향 칸은 보관되지만 펼치지 않는다', () => {
    const l = normalizeLayers([devLayer({ joystick: { directions: 8, axis: 'vertical', short: { up_left: { type: 'shortcut', label: 'q', keystroke: 'q' } }, long: {} } })])[1];
    l.joystick.directions = 4;
    assert.ok(l.joystick.short.up_left, '보관');
    assert.equal(flattenSlots(l).joystick_up_left, undefined, '실행 안 됨');
  });
  it('L11 v4 → 레이어 옮기기: Orca 조이스틱·노브(내장·단축키), 기본, 앱 세트 → 사용자 레이어', () => {
    const ls = migrateToLayers({
      controlsRaw: { joystickDirections: 4, joystick: { up: { labelKo: '받아쓰기', keystroke: 'cmd+e' }, down: { builtin: 'next_unseen' } },
        joystickHold: { down: { labelKo: '새 에이전트 탭', keystroke: 'cmd+alt+t' } }, dial: { cw: { builtin: 'next_session' } } },
      appKeysRaw: { default: { slots: { key1: { type: 'openApp', label: 'Slack', bundleId: 'com.tinyspeck.slackmacgap' } } },
        apps: [{ bundleId: 'com.google.Chrome', name: 'Chrome', color: '#E8762B', joystickDirections: 4,
          slots: { key3: { type: 'shortcut', label: '다음 탭', keystroke: 'cmd+shift+]' }, joystickHold_down: { type: 'shortcut', label: 'x', keystroke: 'cmd+x' } } }] },
    });
    const [d, o, c] = ls;
    assert.equal(o.preset, 'orca', '옛 Orca 설정은 Orca 프리셋 레이어로 (2026-10-04)');
    assert.deepEqual(slotsOf(o).joystick_up, { type: 'shortcut', label: '받아쓰기', keystroke: 'cmd+e' });
    assert.equal(slotsOf(o).joystickHold_down.keystroke, 'cmd+alt+t');
    assert.equal(d.keys.key1.bundleId, 'com.tinyspeck.slackmacgap');
    assert.equal(c.kind, 'user'); assert.deepEqual(c.apps, [{ bundleId: 'com.google.Chrome', name: 'Chrome' }]);
    assert.equal(c.keys.key3.keystroke, 'cmd+shift+]');
    assert.equal(c.joystick.long.down.keystroke, 'cmd+x');
    assert.match(c.id, /^l-/);
  });
  it('L12 profiles.json v5: v5는 layersRaw로, 더 새 버전은 거부', () => {
    assert.equal(SOURCE_FILE_VERSION, 6);
    const ORCA = [{ name: 'Orca', bundleIds: ORCA_IDS }];
    assert.equal(readSourcesFile({ version: 5, layers: [devLayer()] }, ORCA).layersRaw.length, 1);
    assert.ok(readSourcesFile({ version: 7 }, ORCA).warningKo);
  });
});

async function layerSvc({ layers, front = 'com.stablyai.orca', profiles = null }) {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { OutputService } = await import('../src/service/outputService.js');
  const { UNCALIBRATED } = await import('../src/device/calibrationLoader.js');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-layer-'));
  fs.writeFileSync(path.join(stateDir, 'profiles.json'), JSON.stringify(profiles ?? { version: 6, layers }));
  const st = { front }; const calls = []; let t = 1_000_000;
  const s = new OutputService({ calibration: { ...UNCALIBRATED, joystick: { sectors: CAL4, deadzone: 0.05 } }, stateDir,
    openRuntimeTransport: async () => { const e = new Error('x'); e.code = 'DEVICE_NOT_FOUND'; throw e; },
    orcaEnabled: false, frontmost: async () => st.front, ownBundleIds: ['dev.output.keypad'], now: () => t,
    displays: () => [{ id: 1, primary: true, workArea: { x: 0, y: 25, width: 1440, height: 875 } }],
    appExec: { synth: async (k) => calls.push(['synth', k]), openApp: async (b) => calls.push(['openApp', b]), openUrl: async () => ({ code: 0 }),
      execCommand: async () => ({ code: 0 }), readClipboard: async () => '', writeClipboard: async () => ({ code: 0 }), moveWindow: async () => ({ ok: true }), hasWindow: async () => true },
    timers: { setInterval: () => ({}), clearInterval: () => {} } });
  return { s, st, calls, advance: (ms) => { t += ms; } };
}

describe('M12 / 서비스', () => {
  it('L13 레이어 저장·다시 읽기(v6), 앱 중복 연결은 거부', async () => {
    const { s } = await layerSvc({ layers: [] });
    assert.equal(s.layersSave([devLayer()]).ok, true);
    assert.equal(s.layersGet().find((l) => l.id === 'l-dev').apps.length, 2);
    assert.equal(s.layersSave([devLayer(), devLayer({ id: 'l-b', name: 'B' })]).ok, false);
  });
  it('L14 한 레이어의 두 앱에서 같은 키가 같은 동작', async () => {
    const { s, st, calls } = await layerSvc({ layers: [devLayer()], front: 'com.microsoft.VSCode' });
    await s.watcher.tick(); await s._onIntent({ type: 'tap', key: 'slot3' });
    st.front = 'com.jetbrains.intellij'; await s.watcher.tick(); await s._onIntent({ type: 'tap', key: 'slot3' });
    assert.equal(calls.filter((c) => c[0] === 'synth').length, 2);
  });
  it('L15 옛 v4 설정을 읽어도 Orca 조이스틱 아래 길게 = ⌘⌥T, 노브 = 다음 세션', async () => {
    const { s, calls } = await layerSvc({ profiles: { version: 4, sources: [{ name: 'Orca', controls: { joystickHold: { down: { labelKo: '새 에이전트 탭', keystroke: 'cmd+alt+t' } } } }], appKeys: null } });
    await s.watcher.tick(); assert.equal(s.mode, 'orca');
    await s._onIntent({ type: 'joystick', direction: 'down', hold: true });
    assert.deepEqual(calls.at(-1), ['synth', { key: 't', modifiers: ['command', 'option'] }]);
    let stepped = 0; s.bridge.runBuiltin = (b) => { if (b === 'next_session') stepped += 1; return null; };
    await s._onIntent({ type: 'dial', direction: 'cw' });
    assert.equal(stepped, 1);
  });
  it('L16 Orca 프리셋 노브: 내장은 빨리 돌려도 매번 · 직접 설정 노브 단축키는 80ms 제한', async () => {
    const { s, advance } = await layerSvc({ layers: defaultLayers() });
    await s.watcher.tick();
    let stepped = 0; s.bridge.runBuiltin = () => { stepped += 1; return null; };
    for (let i = 0; i < 3; i += 1) { await s._onIntent({ type: 'dial', direction: 'cw' }); advance(20); }
    assert.equal(stepped, 3);
    const mine = { id: 'l-o', kind: 'user', name: 'O', preset: null, apps: [{ bundleId: 'com.stablyai.orca', name: 'Orca' }],
      dial: { ccw: { type: 'shortcut', label: '뒤로', keystroke: 'cmd+[' } }, joystick: { directions: 4, short: {}, long: {} } };
    const d = await layerSvc({ layers: [mine] });
    await d.s.watcher.tick();
    for (let i = 0; i < 3; i += 1) { await d.s._onIntent({ type: 'dial', direction: 'ccw' }); d.advance(20); }
    assert.equal(d.calls.filter((c) => c[0] === 'synth').length, 1);
  });
  it('L17 Orca 레이어 단축키도 앞 앱이 Orca가 아니면 안 보낸다 (누름과 실행 사이에 바뀜)', async () => {
    const { s, st, calls } = await layerSvc({ layers: defaultLayers() });
    await s.watcher.tick();
    s.runner.frontmost = async () => 'com.apple.finder';
    await s._onIntent({ type: 'joystick', direction: 'up', hold: false });   // 기본 위 = 받아쓰기 ⌘E
    assert.equal(calls.length, 0);
  });
});

describe('M12 / 최종 리뷰 보완 (2026-10-03)', () => {
  it('L18 레이어 목록이 아닌 값으로 저장하면 거부하고 파일을 건드리지 않는다', async () => {
    const fs = await import('node:fs'); const path = await import('node:path');
    const { s } = await layerSvc({ layers: [devLayer()] });
    const file = path.join(s.stateDir, 'profiles.json');
    const before = fs.readFileSync(file, 'utf8');
    assert.equal(s.layersSave(null).ok, false);
    assert.equal(s.layersSave({ layers: [] }).ok, false);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(s.layersGet().length, 2, '사용자 레이어가 남아 있다');
  });

  it('L19 옛 설정의 노브가 프리셋과 다르면 프리셋으로 바꾸고 노트를 남긴다 (2026-10-04, 끈 노브·다른 내장)', () => {
    const notes = [];
    const [, o] = migrateToLayers({ controlsRaw: { dial: { cw: { builtin: 'none' }, ccw: { builtin: 'none' } } } }, notes);
    assert.equal(o.preset, 'orca');
    assert.ok(notes.some((n) => /노브 시계 방향 \(비어 있음\)/.test(n)), notes.join('|'));
    const notes2 = [];
    migrateToLayers({ controlsRaw: { dial: { cw: { builtin: 'next_bank' } } } }, notes2);
    assert.ok(notes2.some((n) => /노브 시계 방향 \(다음 묶음\)/.test(n)), notes2.join('|'));
    assert.ok(!notes2.some((n) => /반시계/.test(n)), '설정이 없던 쪽은 프리셋과 같다');
  });

  it('L20 옛 단축키에 이름이 없으면 단축키를 이름으로, 못 읽는 단축키는 버린다 — 저장을 막지 않는다', () => {
    const notes = [];
    const ls = migrateToLayers({ controlsRaw: { joystick: { up: { labelKo: '', keystroke: 'cmd+e' }, left: { labelKo: 'x', keystroke: '???' } } } }, notes);
    const o = ls.find((l) => l.id === 'l-orca');
    assert.equal(o.joystick.short.up.label, 'cmd+e', '이름 없는 단축키는 단축키를 이름으로 (조이스틱은 열린 칸이라 옮겨진다)');
    assert.equal(o.joystick.short.left, undefined, '못 읽는 단축키는 버림');
    assert.deepEqual(notes, []);
    assert.equal(validateLayers(ls).ok, true);
  });
});

describe('M12 / 미뤄 둔 문제 (2026-10-03)', () => {
  const runner = async (exec = {}) => {
    const { ActionRunner } = await import('../src/apps/actionRunner.js');
    const calls = []; let t = 1000;
    const r = new ActionRunner({
      exec: { synth: async (k) => calls.push(['synth', k]), openApp: async () => ({ code: 0 }), openUrl: async () => ({ code: 0 }),
        execCommand: async () => ({ code: 0 }), ...exec },
      frontmost: async () => 'com.google.Chrome', displays: () => [], now: () => t,
    });
    return { r, calls, advance: (ms) => { t += ms; } };
  };
  const APP = { kind: 'app', bundleId: 'com.google.Chrome' };

  it('D01 앱·URL 열기가 실패하면 실행으로 보고하지 않는다', async () => {
    const { r } = await runner({ openApp: async () => ({ code: 1 }), openUrl: async () => ({ code: 1 }) });
    r.notePhysical('key1');
    assert.deepEqual(await r.run('key1', { type: 'openApp', label: 'S', bundleId: 'x.y' }, APP), { ok: false, reasonKo: '앱을 열지 못했습니다.' });
    r.notePhysical('key2');
    assert.deepEqual(await r.run('key2', { type: 'openUrl', label: 'U', url: 'https://x' }, APP), { ok: false, reasonKo: '주소를 열지 못했습니다.' });
  });
  it('D02 Orca 내장 동작의 이동 실패가 상태판에 나온다', async () => {
    const { s } = await layerSvc({ layers: defaultLayers() });
    await s.watcher.tick();
    s.bridge.runBuiltin = async () => ({ ok: false, reasonKo: '탭이 닫혔습니다.' });
    await s._onIntent({ type: 'dial', direction: 'cw' });
    assert.equal(s.lastEventKo, '이동 실패: 탭이 닫혔습니다.');
    s.bridge.runBuiltin = async () => { throw new Error('boom'); };
    await s._onIntent({ type: 'dial', direction: 'cw' });
    assert.match(s.lastEventKo, /실행하지 못했습니다/);
  });
  it('D03 앱 모드 11번은 레이어 칸 — 비어 있으면 아무것도 안 함 (ATTENTION 이동 없음, 2026-10-05)', async () => {
    const { s, calls } = await layerSvc({ layers: [devLayer()], front: 'com.microsoft.VSCode' });
    await s.watcher.tick(); assert.equal(s.mode, 'app');
    let attended = 0; s.bridge.pressAttentionAnywhere = async () => { attended += 1; return null; };
    await s._onIntent({ type: 'tap', key: 'attention' });
    assert.equal(attended, 0);
    assert.deepEqual(calls, []);
  });
  it('D04 앱을 막 바꾸고 누르면 감시 주기를 기다리지 않고 새 앱의 레이어로 실행한다', async () => {
    const def = { id: 'default', kind: 'default', keys: { key3: { type: 'shortcut', label: '기본', keystroke: 'cmd+k' } }, dial: {}, joystick: { directions: 4, short: {}, long: {} } };
    const { s, st, calls } = await layerSvc({ layers: [def, devLayer()], front: 'com.apple.finder' });
    await s.watcher.tick(); assert.equal(s.bridge.appMode.kind, 'default');
    st.front = 'com.microsoft.VSCode';             // 감시자 tick 없이 바로 누름
    await s._onIntent({ type: 'tap', key: 'slot3' });
    assert.deepEqual(calls, [['synth', { key: 'p', modifiers: ['command', 'shift'] }]]);
  });
  it('D05 명령이 시간 제한을 넘기면 그 이유로 알린다', async () => {
    const { execCommand } = await import('../src/service/macos.js');
    assert.equal((await execCommand('sleep 5', 100)).timedOut, true);
    const { r } = await runner({ execCommand: async () => ({ code: 1, timedOut: true }) });
    r.notePhysical('key1');
    assert.equal((await r.run('key1', { type: 'exec', label: 'e', command: 'x' }, APP)).reasonKo, '명령이 30초 안에 끝나지 않아 멈췄습니다.');
  });
  it('D06 노브 80ms 제한은 키 입력 동작에만 — 앱 열기·명령은 빨리 돌려도 매번', async () => {
    const opened = [];
    const { r, advance } = await runner({ openApp: async (b) => { opened.push(b); return { code: 0 }; } });
    for (let i = 0; i < 3; i += 1) {
      r.notePhysical('dial_cw');
      assert.equal((await r.run('dial_cw', { type: 'openApp', label: 'S', bundleId: 'x.y' }, APP)).ok, true);
      advance(20);
    }
    assert.equal(opened.length, 3);
  });
});

describe('M12 / 노브 누름 칸 (2026-10-03)', () => {
  const press = { type: 'shortcut', label: '받아쓰기', keystroke: 'cmd+e' };
  it('P01 레이어에 노브 누름(dial.press)이 남고, 실행 칸 dial_press로 펼쳐진다', () => {
    const [, o] = normalizeLayers([devLayer({ dial: { press } })]);
    assert.deepEqual(o.dial.press, press);
    assert.deepEqual(slotsOf(o).dial_press, press);
    assert.equal(slotsOf(defaultLayers()[1]).dial_press.builtin, 'toggle_view', 'Orca 프리셋의 누름 = 모드 변경 (2026-10-04)');
  });
  it('P02 Orca 모드·앱 모드에서 노브 누름 → 그 레이어 칸, 비어 있으면 아무것도 안 한다', async () => {
    // Orca 앱을 직접 설정 레이어에 연결한 경우(앱 모드) — Orca 프리셋의 누름은 비어 있어 아래 empty에서 본다 (2026-10-04)
    const orca = { id: 'l-o', kind: 'user', name: 'O', preset: null, apps: [{ bundleId: 'com.stablyai.orca', name: 'Orca' }], dial: { press }, joystick: { directions: 4, short: {}, long: {} } };
    const dev = devLayer({ dial: { press: { type: 'shortcut', label: '닫기', keystroke: 'cmd+w' } } });
    const { s, st, calls } = await layerSvc({ layers: [orca, dev] });
    await s.watcher.tick(); assert.equal(s.mode, 'app');
    await s._onIntent({ type: 'tap', key: 'dial_click' });
    assert.deepEqual(calls.at(-1), ['synth', { key: 'e', modifiers: ['command'] }]);
    st.front = 'com.microsoft.VSCode'; await s.watcher.tick();
    await s._onIntent({ type: 'tap', key: 'dial_click' });
    assert.deepEqual(calls.at(-1), ['synth', { key: 'w', modifiers: ['command'] }]);
    const empty = await layerSvc({ layers: defaultLayers() });
    await empty.s.watcher.tick(); assert.equal(empty.s.mode, 'orca');
    let pressed = 0; empty.s.bridge.pressSlot = async () => { pressed += 1; };
    await empty.s._onIntent({ type: 'tap', key: 'dial_click' });
    assert.equal(empty.calls.length + pressed, 0, '빈 칸이면 슬롯 이동도 하지 않는다');
  });
  it('P03 노브 누름은 회전 80ms 제한과 상관없다', async () => {
    const { ActionRunner } = await import('../src/apps/actionRunner.js');
    const sent = []; let t = 1000;
    const r = new ActionRunner({ exec: { synth: async (k) => sent.push(k) }, frontmost: async () => 'com.google.Chrome', displays: () => [], now: () => t });
    for (let i = 0; i < 2; i += 1) { r.notePhysical('dial_press'); await r.run('dial_press', press, { kind: 'app', bundleId: 'com.google.Chrome' }); t += 20; }
    assert.equal(sent.length, 2);
  });
});
