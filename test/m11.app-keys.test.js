/**
 * M11 — 앱별 키 (스펙 docs/superpowers/specs/2026-10-03-app-keys-design.md).
 * W: 창 위치 · K: 키 세트 · X: 실행기 · M: 모드·장면
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { POSITIONS, rectFor, pickDisplay, numberDisplays } from '../src/apps/windowLayout.js';
import { buildDeviceScene } from '../src/device/deviceScene.js';
import { colorToInt } from '../src/device/deviceDriver.js';
import { buildStatusView } from '../src/service/uiModel.js';
import { WorkUnit, ChildUnit } from '../src/core/units.js';
import { Status } from '../src/core/types.js';
import { StateStore } from '../src/core/stateStore.js';
import { Output } from '../src/output.js';
import { ForegroundWatcher } from '../src/service/foregroundWatcher.js';
import { ActionRunner } from '../src/apps/actionRunner.js';
import { openAppArgs, windowMoveScript, escapeAppleScript, parseRunningApps, classifyOsascriptError } from '../src/service/macos.js';
import { normalizeAction, checkAction } from '../src/apps/appKeys.js';
import { readSourcesFile, SOURCE_FILE_VERSION } from '../src/service/profiles.js';

const WA = { x: 0, y: 25, width: 1440, height: 875 };

describe('M11 / 창 위치', () => {
  it('W01 위치 이름 15개', () => {
    assert.equal(POSITIONS.length, 15);
    assert.ok(POSITIONS.includes('left_two_thirds'));
  });
  it('W02 절반·전체는 작업 영역 기준', () => {
    assert.deepEqual(rectFor('full', WA), WA);
    assert.deepEqual(rectFor('left', WA), { x: 0, y: 25, width: 720, height: 875 });
    assert.deepEqual(rectFor('right', WA), { x: 720, y: 25, width: 720, height: 875 });
    assert.deepEqual(rectFor('bottom', WA), { x: 0, y: 463, width: 1440, height: 437 });
  });
  it('W03 4분할·3분할·2/3', () => {
    assert.deepEqual(rectFor('top_right', WA), { x: 720, y: 25, width: 720, height: 438 });
    assert.deepEqual(rectFor('center_third', WA), { x: 480, y: 25, width: 480, height: 875 });
    assert.deepEqual(rectFor('right_two_thirds', WA), { x: 480, y: 25, width: 960, height: 875 });
  });
  it('W04 center는 60% 가운데, 모르는 이름은 전체', () => {
    assert.deepEqual(rectFor('center', WA), { x: 288, y: 200, width: 864, height: 525 });
    assert.deepEqual(rectFor('nope', WA), WA);
  });
  it('W05 모니터 고르기 (2026-10-12): 1 = 주 모니터, 나머지는 시스템 순서 — 화면 캡처와 같은 번호. 없는 번호는 주 모니터', () => {
    const ds = [{ id: 7, primary: false, label: 'DELL', workArea: { x: 1440, y: 0, width: 1920, height: 1080 } }, { id: 1, primary: true, label: '내장', workArea: WA }];
    assert.deepEqual(pickDisplay(ds, 'main'), WA);
    assert.deepEqual(pickDisplay(ds, 1), WA, '1은 목록 순서가 아니라 주 모니터');
    assert.deepEqual(pickDisplay(ds, 2), ds[0].workArea);
    assert.deepEqual(pickDisplay(ds, 9), WA);
    assert.deepEqual(numberDisplays(ds).map((d) => [d.n, d.label]), [[1, '내장'], [2, 'DELL']]);
    assert.equal(pickDisplay([], 'main'), null, '화면 정보가 없으면 null');
  });
});


const CHROME = { bundleId: 'com.google.Chrome', name: 'Chrome', color: '#E8762B', joystickDirections: 4,
  slots: { key3: { type: 'shortcut', label: '다음 탭', keystroke: 'cmd+shift+]' } } };

describe('M11 / 키 세트', () => {
  it('K03 normalize: 모르는 type은 버린다', () => {
    assert.equal(normalizeAction({ type: 'teleport' }), null);
    assert.equal(normalizeAction(null), null);
  });
  it('K04 checkAction: 이름·단축키·URL·위치·범위', () => {
    const slots = {
      key1: { type: 'insertText', label: '', text: 'x' },   // 단축키·앱 열기·앞 창 위치는 이름이 비어도 된다 (2026-10-09)
      key2: { type: 'openUrl', label: 'u', url: 'example.com' },
      key3: { type: 'moveWindow', label: 'm', position: 'diagonal', display: 'main' },
      key4: { type: 'sequence', label: 's', steps: [{ keystroke: 'cmd+t', delayMs: 9000 }] },
      key5: { type: 'layout', label: 'l', items: [] },
    };
    const errorsKo = [];
    for (const [id, a] of Object.entries(slots)) checkAction(id, normalizeAction(a), 'Chrome', errorsKo);
    for (const re of [/이름/, /URL/, /위치/, /지연/, /항목/]) assert.ok(errorsKo.some((e) => re.test(e)), String(re));
    const ok = [];
    checkAction('key3', normalizeAction(CHROME.slots.key3), 'Chrome', ok);
    assert.deepEqual(ok, []);
  });
  it('K05 profiles.json v4(옛 파일): v3는 appKeys 빈 값, v4는 appKeys 원본을 읽는다 (2026-10-03부터 저장은 v5 레이어)', () => {
    assert.equal(SOURCE_FILE_VERSION, 6);
    const ORCA = [{ name: 'Orca', bundleIds: ['com.stablyai.orca'] }];
    assert.equal(readSourcesFile({ version: 3, sources: [{ name: 'Orca', controls: {} }] }, ORCA).appKeysRaw, null);
    const r = readSourcesFile({ version: 4, sources: [], appKeys: { apps: [CHROME] } }, ORCA);
    assert.equal(r.appKeysRaw.apps[0].bundleId, 'com.google.Chrome');
    assert.ok(readSourcesFile({ version: 7 }, ORCA).warningKo);
  });
  it('K06 서비스: 옛 v4 앱 키는 레이어로 옮겨 읽고, 레이어로 저장·다시 읽기, 잘못된 값은 거부', async () => {
    const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
    const { OutputService } = await import('../src/service/outputService.js');
    const { UNCALIBRATED } = await import('../src/device/calibrationLoader.js');
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-ak-'));
    const mk = () => new OutputService({ calibration: UNCALIBRATED, stateDir,
      openRuntimeTransport: async () => { const e = new Error('x'); e.code = 'DEVICE_NOT_FOUND'; throw e; },
      orcaEnabled: false, timers: { setInterval: () => ({}), clearInterval: () => {} } });
    fs.writeFileSync(path.join(stateDir, 'profiles.json'), JSON.stringify({ version: 4, sources: [], appKeys: { default: { slots: {} }, apps: [CHROME] } }));
    const a = mk();
    const chrome = a.layersGet().find((l) => l.apps.some((x) => x.bundleId === 'com.google.Chrome'));
    assert.equal(chrome.keys.key3.keystroke, 'cmd+shift+]');
    assert.equal(a.layersSave(a.layersGet()).ok, true);
    const chromeOf = (ls) => ls.find((l) => l.apps.some((x) => x.bundleId === 'com.google.Chrome'));
    assert.equal(chromeOf(mk().layersGet()).keys.key3.keystroke, 'cmd+shift+]');
    const bad = a.layersGet(); chromeOf(bad).keys.key3.keystroke = '???';
    assert.equal(a.layersSave(bad).ok, false);
    const saved = JSON.parse(fs.readFileSync(path.join(stateDir, 'profiles.json'), 'utf8'));
    assert.equal(saved.version, 6);
  });
});


describe('M11 / macOS 실행부 (스크립트만, 실제 실행 없음)', () => {
  it('X01 open 인자는 배열이고 번들 ID는 -b로', () => {
    assert.deepEqual(openAppArgs('com.google.Chrome'), ['-b', 'com.google.Chrome']);
  });
  it('X02 창 이동 스크립트: 번들 ID로 프로세스를 찾고 위치·크기를 정한다, 문자열은 이스케이프', () => {
    const s = windowMoveScript('com.google.Chrome', { x: 0, y: 25, width: 720, height: 875 });
    assert.match(s, /bundle identifier is "com\.google\.Chrome"/);
    assert.match(s, /set position of window 1 to \{0, 25\}/);
    assert.match(s, /set size of window 1 to \{720, 875\}/);
    assert.match(windowMoveScript(null, { x: 1, y: 2, width: 3, height: 4 }), /frontmost is true/);
    assert.equal(escapeAppleScript('a"b\\c'), 'a\\"b\\\\c');
  });
});


function runnerRig({ front = 'com.google.Chrome', locked = false, windows = true } = {}) {
  const calls = [];
  let t = 1000;
  const logs = [];
  const st = { front, clip: '원래' };
  const r = new ActionRunner({
    exec: {
      synth: async (ks) => calls.push(['synth', ks]),
      openApp: async (b) => calls.push(['openApp', b]),
      openUrl: async (u) => calls.push(['openUrl', u]),
      execCommand: async (c) => { calls.push(['exec', c]); return { code: 0 }; },
      readClipboard: async () => { await new Promise((res) => setImmediate(res)); return st.clip; },
      writeClipboard: async (s) => { await new Promise((res) => setImmediate(res)); if (st.clipFail) return { code: 1 }; st.clip = s; calls.push(['clip', s]); return { code: 0 }; },
      moveWindow: async (b, rect) => { calls.push(['move', b, rect]); return { ok: true }; },
      hasWindow: async () => { if (windows === 'denied') { const e = new Error('x'); e.code = 'AUTOMATION'; throw e; } return windows; },
    },
    frontmost: async () => st.front,
    displays: () => [{ id: 1, primary: true, workArea: { x: 0, y: 25, width: 1440, height: 875 } }],
    isLocked: () => locked,
    ownBundleIds: ['dev.output.keypad'], orcaBundleIds: ['com.stablyai.orca'],
    now: () => t, sleep: async (ms) => { t += ms; await new Promise((res) => setImmediate(res)); }, log: (m) => logs.push(m),
  });
  return { r, calls, st, logs, advance: (ms) => { t += ms; } };
}
const APP = { kind: 'app', bundleId: 'com.google.Chrome' };

describe('M11 / 실행기', () => {
  it('X03 실제 조작 없이 온 요청은 실행하지 않는다 · 한 번만 쓴다', async () => {
    const { r, calls } = runnerRig();
    const a = { type: 'shortcut', label: '다음 탭', keystroke: 'cmd+shift+]' };
    assert.equal((await r.run('key3', a, APP)).ok, false);
    r.notePhysical('key3');
    assert.equal((await r.run('key3', a, APP)).ok, true);
    assert.equal((await r.run('key3', a, APP)).ok, false, '재사용 안 됨');
    assert.equal(calls.filter((c) => c[0] === 'synth').length, 1);
  });
  it('X04 키 입력 동작은 앞 앱이 세트 앱이 아니면 보내지 않는다 · 기본 세트는 Orca가 앞이면 안 보낸다', async () => {
    const { r, st, calls } = runnerRig();
    const a = { type: 'shortcut', label: 't', keystroke: 'cmd+t' };
    st.front = 'com.googlecode.iterm2';
    r.notePhysical('key1');
    assert.equal((await r.run('key1', a, APP)).ok, false);
    st.front = 'com.stablyai.orca';
    r.notePhysical('key1');
    assert.equal((await r.run('key1', a, { kind: 'default', bundleId: null })).ok, false);
    assert.equal(calls.length, 0);
  });
  it('X05 화면 잠금 중에는 아무것도 하지 않는다', async () => {
    const { r, calls } = runnerRig({ locked: true });
    r.notePhysical('key2');
    assert.equal((await r.run('key2', { type: 'openUrl', label: 'u', url: 'https://x' }, APP)).ok, false);
    assert.equal(calls.length, 0);
  });
  it('X06 sequence는 단계마다 보내고 지연을 지킨다', async () => {
    const { r, calls } = runnerRig();
    r.notePhysical('key4');
    await r.run('key4', { type: 'sequence', label: 's', steps: [{ keystroke: 'cmd+t', delayMs: 100 }, { keystroke: 'cmd+l', delayMs: 0 }] }, APP);
    assert.deepEqual(calls.map((c) => c[1].key), ['t', 'l']);
  });
  it('X07 앱·URL·명령: 앞 앱과 무관, 명령 로그에는 내용이 없다', async () => {
    const { r, calls, st, logs } = runnerRig();
    st.front = 'com.apple.finder';
    for (const [id, a] of [['key5', { type: 'openApp', label: 'Slack', bundleId: 'com.tinyspeck.slackmacgap' }],
      ['key6', { type: 'openUrl', label: '대시보드', url: 'https://grafana' }],
      ['key7', { type: 'exec', label: '빌드', command: 'make secret-target' }]]) {
      r.notePhysical(id); assert.equal((await r.run(id, a, APP)).ok, true, id);
    }
    assert.deepEqual(calls.map((c) => c[0]), ['openApp', 'openUrl', 'exec']);
    assert.ok(logs.every((m) => !m.includes('secret')), '명령 내용을 로그에 남기지 않는다');
    assert.ok(logs.some((m) => /빌드/.test(m)));
  });
  it('X08 글자 입력: 클립보드에 넣고 ⌘V, 0.5초 뒤 되돌린다', async () => {
    const { r, calls, st } = runnerRig();
    r.notePhysical('key8');
    await r.run('key8', { type: 'insertText', label: '인사', text: '안녕하세요' }, APP);
    assert.deepEqual(calls.map((c) => c[0]), ['clip', 'synth', 'clip']);
    assert.deepEqual(calls[1][1], { key: 'v', modifiers: ['command'] });
    assert.equal(st.clip, '원래');
  });
  it('X09 창 위치·레이아웃: 위치를 좌표로, 안 떠 있는 앱은 열고 창을 기다린다', async () => {
    const { r, calls } = runnerRig();
    r.notePhysical('key9');
    await r.run('key9', { type: 'moveWindow', label: 'm', position: 'left', display: 'main' }, APP);
    assert.deepEqual(calls[0], ['move', null, { x: 0, y: 25, width: 720, height: 875 }]);
    r.notePhysical('key10');
    await r.run('key10', { type: 'layout', label: '작업', items: [
      { bundleId: 'com.google.Chrome', appName: 'Chrome', position: 'left', display: 'main' },
      { bundleId: 'com.googlecode.iterm2', appName: 'iTerm', position: 'right', display: 2 },
    ] }, APP);
    assert.deepEqual(calls.slice(1).map((c) => c[0]), ['openApp', 'move', 'openApp', 'move', 'openApp']);
    assert.deepEqual(calls[4][2], { x: 720, y: 25, width: 720, height: 875 }, '없는 화면 2 → main');
  });
  it('X10 layout 창을 못 찾으면 건너뛰고 보고 · 실행 중 같은 칸 연타는 무시', async () => {
    const { r, calls } = runnerRig({ windows: false });
    const lay = { type: 'layout', label: 'l', items: [{ bundleId: 'com.x', appName: 'X', position: 'full', display: 'main' }] };
    r.notePhysical('key12');
    const p1 = r.run('key12', lay, APP);
    r.notePhysical('key12');
    const second = await r.run('key12', lay, APP);
    const first = await p1;
    assert.equal(second.ok, false);
    assert.match(first.reasonKo, /X/);
    assert.equal(calls.filter((c) => c[0] === 'move').length, 0);
  });
  it('X11 manual(설정 화면의 지금 실행해 보기)은 Orca 동작만 막는다 (2026-10-10: 레이아웃만 → 모두)', async () => {
    const { r } = runnerRig();
    assert.equal((await r.run('-', { type: 'layout', label: 'l', items: [{ bundleId: 'com.google.Chrome', appName: 'C', position: 'full', display: 'main' }] }, APP, { manual: true })).ok, true);
    assert.equal((await r.run('-', { type: 'exec', label: 'e', command: 'x' }, APP, { manual: true })).ok, true);
    assert.equal((await r.run('-', { type: 'builtin', builtin: 'next_session', label: 'n' }, APP, { manual: true })).ok, false);
  });
});


async function appSvc({ appKeys, front = 'com.google.Chrome' }) {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { OutputService } = await import('../src/service/outputService.js');
  const { UNCALIBRATED } = await import('../src/device/calibrationLoader.js');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-mode-'));
  fs.writeFileSync(path.join(stateDir, 'profiles.json'), JSON.stringify({ version: 4, sources: [], appKeys }));
  const st = { front };
  const calls = [];
  const s = new OutputService({ calibration: UNCALIBRATED, stateDir,
    openRuntimeTransport: async () => { const e = new Error('x'); e.code = 'DEVICE_NOT_FOUND'; throw e; },
    orcaEnabled: false, frontmost: async () => st.front, ownBundleIds: ['dev.output.keypad'],
    displays: () => [{ id: 1, primary: true, workArea: { x: 0, y: 25, width: 1440, height: 875 } }],
    appExec: { synth: async (k) => calls.push(['synth', k]), openApp: async (b) => calls.push(['openApp', b]), openUrl: async () => {}, execCommand: async () => ({ code: 0 }),
      readClipboard: async () => '', writeClipboard: async () => {}, moveWindow: async () => ({ ok: true }), hasWindow: async () => true },
    timers: { setInterval: () => ({}), clearInterval: () => {} } });
  return { s, st, calls };
}
const AK = { default: { slots: {} }, apps: [CHROME] };

describe('M11 / 모드와 입력', () => {
  it('M01 앞 앱으로 모드: Orca / 앱 레이어 / 기본 레이어 (대기 없음, 2026-10-11)', async () => {
    const { s, st } = await appSvc({ appKeys: AK, front: 'com.stablyai.orca' });
    await s.watcher.tick(); assert.equal(s.mode, 'orca');
    st.front = 'com.google.Chrome'; await s.watcher.tick(); assert.equal(s.mode, 'app');
    assert.equal(s.bridge.appMode.bundleId, 'com.google.Chrome');
    st.front = 'com.apple.finder'; await s.watcher.tick(); assert.equal(s.mode, 'app');
    assert.equal(s.bridge.appMode.kind, 'default', '연결 없는 앱은 기본 레이어');
  });
  it('M02 기본 레이어는 비어 있어도 앱 모드(기본) — 배정이 생겨도 그대로 (2026-10-11: 대기 없음)', async () => {
    const { s, st } = await appSvc({ appKeys: AK, front: 'com.apple.finder' });
    await s.watcher.tick(); assert.equal(s.mode, 'app');
    assert.equal(s.bridge.appMode.kind, 'default');
    const layers = s.layersGet();
    layers.find((l) => l.kind === 'default').keys.key1 = { type: 'openApp', label: 'Slack', bundleId: 'com.tinyspeck.slackmacgap' };
    assert.equal(s.layersSave(layers).ok, true);
    assert.equal(s.mode, 'app');
    assert.equal(s.bridge.appMode.kind, 'default');
  });
  it('M03 우리 창이 앞에 와도 모드를 유지한다', async () => {
    const { s, st } = await appSvc({ appKeys: AK });
    await s.watcher.tick(); assert.equal(s.mode, 'app');
    st.front = 'dev.output.keypad'; await s.watcher.tick(); assert.equal(s.mode, 'app');
  });
  it('M04 앱 모드: 키 3 탭 → 그 칸 단축키, 물리 눌림 기록 포함', async () => {
    const { s, calls } = await appSvc({ appKeys: AK });
    await s.watcher.tick();
    await s._onIntent({ type: 'tap', key: 'slot3' });
    assert.deepEqual(calls, [['synth', { key: ']', modifiers: ['command', 'shift'] }]]);
  });
  it('M05 앱 모드: 키 11은 레이어 칸 — ATTENTION 이동은 없다 (2026-10-05), 대기에서는 아무것도 안 한다', async () => {
    const { s, st, calls } = await appSvc({ appKeys: AK });
    await s.watcher.tick();
    let attended = 0;
    s.bridge.pressAttentionAnywhere = async () => { attended += 1; return null; };
    await s._onIntent({ type: 'tap', key: 'attention' });
    assert.equal(attended, 0);
    st.front = 'com.apple.finder'; await s.watcher.tick();
    await s._onIntent({ type: 'tap', key: 'slot3' });
    await s._onIntent({ type: 'tap', key: 'attention' });
    assert.equal(calls.length, 0);
    assert.equal(attended, 0);
  });
  it('M06 감시자는 번들이 바뀔 때만 알리고 우리 창·실패는 무시', async () => {
    const seen = []; const st = { front: 'a', fail: false };
    const w = new ForegroundWatcher({ frontmost: async () => { if (st.fail) throw new Error('x'); return st.front; }, onFront: (b) => seen.push(b), ignoreBundleIds: ['own'] });
    await w.tick(); await w.tick(); st.front = 'own'; await w.tick(); st.fail = true; await w.tick(); st.fail = false; st.front = 'b'; await w.tick();
    assert.deepEqual(seen, ['a', 'b']);
  });
});


describe('M11 / 장면·상태판', () => {
  const appSnap = (store = new StateStore()) => {
    const o = new Output({ store });
    o.setActive(false);
    o.setAppMode({ kind: 'app', bundleId: 'com.google.Chrome', name: 'Chrome', color: '#E8762B', assigned: ['key3', 'key12'] });
    return o.render();
  };
  it('M07 앱 모드 장면: 배정 칸은 세트 색 중 밝기(0.6, 2026-10-10), 빈 칸 꺼짐, 대기 장면이 아니다', () => {
    const scene = buildDeviceScene(appSnap());
    assert.equal(scene.inactive, false);
    assert.deepEqual(scene.keys.slot3, { color: '#E8762B', brightness: 0.6, pattern: 'solid' });
    assert.deepEqual(scene.keys.ack, { color: '#E8762B', brightness: 0.6, pattern: 'solid' }, '키 12');
    assert.equal(scene.keys.slot1.color, 'off');
    assert.equal(scene.keys.mode_back.color, 'off', '키 13 빈 칸');
  });
  it('M08 앱 모드: 언더글로우는 레이어 색(2026-10-10: Orca 상태는 Orca 레이어에서만), 11번은 레이어 칸이라 비면 꺼짐 (2026-10-05)', () => {
    const store = new StateStore();
    store.addUnit(new WorkUnit({ id: 'w', title: 'w', source: 'orca', kind: 'worktree',
      children: [new ChildUnit({ id: 't', title: 't', status: Status.WAITING_APPROVAL, requiredForCompletion: true })] }));
    const scene = buildDeviceScene(appSnap(store));
    assert.equal(scene.keys.attention.color, 'off');
    assert.equal(scene.ambientZone.color, appSnap(store).appMode.color);
  });
  it('M09 드라이버는 #RRGGBB 색도 밝기를 곱해 보낸다', () => {
    assert.equal(colorToInt('#E8762B', 1), 0xE8762B);
    assert.equal(colorToInt('#FF0000', 0.5), 0x800000);
  });
  it('M10 상태판: 앱 모드면 "Chrome 레이어" 안내, 대기 경고 없음 (2026-10-04 용어)', () => {
    const v = buildStatusView({ snapshot: appSnap(), health: { device: { state: 'connected' }, orca: { state: 'connected' } } });
    assert.equal(v.warnings.some((w) => w.code === 'inactive'), false);
    assert.equal(v.appModeKo, 'Chrome 레이어');
  });
});

describe('M11 / 설정 화면 서비스', () => {
  it('K07 actionTry(지금 실행해 보기)는 동작을 실행하고 결과를 돌려준다, Orca 동작은 거절', async () => {
    const { s, calls } = await appSvc({ appKeys: AK });
    const r = await s.actionTry({ type: 'layout', label: 'l', items: [{ bundleId: 'com.google.Chrome', appName: 'C', position: 'left', display: 'main' }] });
    assert.equal(r.ok, true);
    assert.ok(calls.some((c) => c[0] === 'openApp'));
    assert.equal((await s.actionTry({ type: 'builtin', builtin: 'next_session', label: 'n' })).ok, false);
  });
});

describe('M11 / 실행 중인 앱 목록', () => {
  it('K08 lsappinfo list에서 일반 앱(Foreground)만 이름·번들 ID로, 우리 앱 제외, 이름순', () => {
    const text = [
      ' 1) "loginwindow" ASN:0x0-0x1001: ', '    bundleID="com.apple.loginwindow"', '    pid = 612 type="UIElement" flavor=3',
      ' 2) "Google Chrome" ASN:0x0-0x2: ', '    bundleID="com.google.Chrome"', '    pid = 1 type="Foreground" flavor=3',
      ' 3) "Output" ASN:0x0-0x3: ', '    bundleID="dev.output.keypad"', '    pid = 2 type="Foreground"',
      ' 4) "iTerm2" ASN:0x0-0x4: ', '    bundleID="com.googlecode.iterm2"', '    pid = 3 type="Foreground"',
      ' 5) "nobundle" ASN:0x0-0x5: ', '    bundleID=[ NULL ] ', '    pid = 4 type="Foreground"',
    ].join('\n');
    assert.deepEqual(parseRunningApps(text, ['dev.output.keypad']), [
      { bundleId: 'com.google.Chrome', name: 'Google Chrome' },
      { bundleId: 'com.googlecode.iterm2', name: 'iTerm2' },
    ]);
  });
});

describe('M11 / 최종 리뷰 보완 (2026-10-03)', () => {
  it('X12 sequence도 실행 중 같은 칸 연타는 무시한다 (앞 앱 확인 대기 중에도)', async () => {
    const { r, calls } = runnerRig();
    const seq = { type: 'sequence', label: 's', steps: [{ keystroke: 'cmd+t', delayMs: 0 }, { keystroke: 'cmd+l', delayMs: 0 }] };
    r.notePhysical('key4');
    const p1 = r.run('key4', seq, APP);
    r.notePhysical('key4');
    const second = await r.run('key4', seq, APP);
    await p1;
    assert.equal(second.ok, false);
    assert.deepEqual(calls.map((c) => c[1].key), ['t', 'l']);
  });

  it('X13 서로 다른 칸의 글자 입력이 겹쳐도 원래 클립보드를 되찾는다', async () => {
    const { r, st } = runnerRig();
    r.notePhysical('key1'); r.notePhysical('key2');
    const pA = r.run('key1', { type: 'insertText', label: 'A', text: 'AAA' }, APP);
    for (let i = 0; i < 2; i += 1) await new Promise((res) => setImmediate(res));   // A가 클립보드를 바꾼 뒤 B를 누른다
    const pB = r.run('key2', { type: 'insertText', label: 'B', text: 'BBB' }, APP);
    await Promise.all([pA, pB]);
    assert.equal(st.clip, '원래');
  });

  it('X14 클립보드 쓰기에 실패하면 붙여넣지 않는다', async () => {
    const { r, st, calls } = runnerRig();
    st.clipFail = true;
    r.notePhysical('key8');
    const res = await r.run('key8', { type: 'insertText', label: 't', text: 'x' }, APP);
    assert.equal(res.ok, false);
    assert.equal(calls.some((c) => c[0] === 'synth'), false);
  });

  it('X15 sequence 도중 앞 앱이 바뀌면 남은 단계를 보내지 않는다', async () => {
    const { r, st, calls } = runnerRig();
    r.notePhysical('key4');
    const p = r.run('key4', { type: 'sequence', label: 's', steps: [{ keystroke: 'cmd+t', delayMs: 100 }, { keystroke: 'enter', delayMs: 0 }] }, APP);
    await new Promise((res) => setImmediate(res));
    st.front = 'com.stablyai.orca';
    const res = await p;
    assert.equal(res.ok, false);
    assert.deepEqual(calls.map((c) => c[1].key), ['t']);
  });

  it('X16 앞 창이 Output 창이면 앞 창 위치는 옮기지 않는다', async () => {
    const { r, st, calls } = runnerRig();
    st.front = 'dev.output.keypad';
    r.notePhysical('key9');
    const res = await r.run('key9', { type: 'moveWindow', label: 'm', position: 'left', display: 'main' }, APP);
    assert.equal(res.ok, false);
    assert.equal(calls.length, 0);
  });
});

describe('M11 / 권한 오류를 구분해서 알린다 (2026-10-03 Finder 레이아웃 보고)', () => {
  it('X17 osascript -1743은 자동화 권한, -1719는 손쉬운 사용', () => {
    assert.equal(classifyOsascriptError('execution error: System Events에 Apple 이벤트를 보낼 권한이 없습니다. (-1743)'), 'AUTOMATION');
    assert.equal(classifyOsascriptError('not allowed assistive access. (-1719)'), 'ACCESSIBILITY');
  });

  it('X18 레이아웃: 자동화 권한이 없으면 기다리지 않고 바로 그 이유로 실패한다', async () => {
    const { r, calls } = runnerRig({ windows: 'denied' });
    r.notePhysical('key10');
    const res = await r.run('key10', { type: 'layout', label: 'l', items: [
      { bundleId: 'com.apple.finder', appName: 'Finder', position: 'left', display: 'main' },
      { bundleId: 'com.google.Chrome', appName: 'Chrome', position: 'right', display: 'main' }] }, APP);
    assert.equal(res.ok, false);
    assert.match(res.reasonKo, /자동화/);
    assert.equal(calls.filter((c) => c[0] === 'openApp').length, 1, '첫 앱에서 멈춘다');
  });
});
