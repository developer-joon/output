/**
 * M15 — 상태판 키 그림·탭 (2026-10-05 사용자 요청).
 * 지금 레이어의 키 배치와 지금 LED 색을 장치 모양 4×4로, Orca 레이어는 [세션 | 키] 탭.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildKeyMap, KEY_GRID } from '../src/service/uiModel.js';
import { defaultLayers } from '../src/apps/layers.js';

const ORCA_ID = 'com.stablyai.orca';
const sc = (k, led) => ({ type: 'shortcut', label: k, keystroke: k, ...(led ? { led } : {}) });

async function svc({ layers, front = ORCA_ID }) {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { OutputService } = await import('../src/service/outputService.js');
  const { UNCALIBRATED } = await import('../src/device/calibrationLoader.js');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-m15-'));
  if (layers) fs.writeFileSync(path.join(stateDir, 'profiles.json'), JSON.stringify({ version: 6, layers }));
  const st = { front };
  const s = new OutputService({ calibration: UNCALIBRATED, stateDir,
    openRuntimeTransport: async () => { const e = new Error('x'); e.code = 'DEVICE_NOT_FOUND'; throw e; },
    orcaEnabled: false, frontmost: async () => st.front, ownBundleIds: ['dev.output.keypad'],
    displays: () => [{ id: 1, primary: true, workArea: { x: 0, y: 25, width: 1440, height: 875 } }],
    appExec: { synth: async () => {}, openApp: async () => ({ code: 0 }), openUrl: async () => ({ code: 0 }),
      execCommand: async () => ({ code: 0 }), readClipboard: async () => '', writeClipboard: async () => ({ code: 0 }), moveWindow: async () => ({ ok: true }), hasWindow: async () => true },
    timers: { setInterval: () => ({}), clearInterval: () => {} } });
  return { s, st };
}

const cell = (map, id) => map.cells.find((c) => c.id === id);

describe('M15 / 키 그림 데이터', () => {
  it('V01 격자는 장치 배열 그대로 4×4 (노브·1·2·조이스틱 / 3~6 / 7~10 / 미니 LED·11·12·13)', () => {
    assert.deepEqual(KEY_GRID, [
      ['dial', 'key1', 'key2', 'joystick'],
      ['key3', 'key4', 'key5', 'key6'],
      ['key7', 'key8', 'key9', 'key10'],
      ['miniled', 'key11', 'key12', 'key13'],
    ]);
  });

  it('V02 앱 모드: 배정 키는 동작 이름과 지금 LED 색, 빈 칸은 비어 있음·꺼짐, 노브·조이스틱은 동작 목록', () => {
    const map = buildKeyMap({
      mode: 'app',
      scene: { keys: { slot3: { color: '#E8762B', brightness: 0.25 }, mode_back: { color: '#00FF00', brightness: 1 }, slot4: { color: 'off', brightness: 0 } }, ambientZone: { color: 'red', brightness: 1 } },
      slots: { key3: sc('⌘K'), key13: sc('⌘E'), dial_cw: sc('다음'), dial_press: sc('누름'), joystick_up: sc('위') },
      titles: [],
    });
    assert.equal(map.cells.length, 16);
    assert.deepEqual({ ...cell(map, 'key3'), title: undefined }, { id: 'key3', n: 3, kind: 'key', labelKo: '⌘K', statusKo: null, color: '#e8762b', empty: false, title: undefined });
    assert.equal(cell(map, 'key13').color, '#00ff00');
    assert.equal(cell(map, 'key4').empty, true);
    assert.equal(cell(map, 'key4').color, null, '꺼짐');
    assert.equal(cell(map, 'dial').kind, 'dial');
    assert.match(cell(map, 'dial').title, /노브 시계 방향: 다음/);
    assert.match(cell(map, 'dial').title, /노브 누름: 누름/);
    assert.match(cell(map, 'joystick').title, /조이스틱 위: 위/);
    assert.equal(cell(map, 'miniled').kind, 'miniled');
    assert.equal(map.underglow, '#c0392b', '언더글로우 = 지금 색');
  });

  it('V03 Orca 모드: 키 1~10은 작업 이름과 상태색, 키 11·12·13은 레이어 칸', () => {
    const map = buildKeyMap({
      mode: 'orca',
      scene: { keys: { slot1: { color: 'amber', brightness: 0.5 }, slot2: { color: 'off', brightness: 0 }, attention: { color: '#1F9E96', brightness: 0.25 } }, ambientZone: null },
      slots: { key11: sc('⌘1'), dial_cw: { type: 'builtin', builtin: 'next_session', label: '다음 세션' } },
      titles: ['hydroid', null],
    });
    assert.equal(cell(map, 'key1').labelKo, 'hydroid');
    assert.equal(cell(map, 'key1').color, '#d9a21b', '상태색은 상태판 줄과 같은 색');
    assert.equal(cell(map, 'key2').empty, true);
    assert.equal(cell(map, 'key11').labelKo, '⌘1');
    assert.equal(cell(map, 'key11').color, '#1f9e96');
    assert.equal(cell(map, 'key12').empty, true);
    assert.match(cell(map, 'dial').title, /노브 시계 방향: 다음 세션/);
    assert.equal(map.underglow, null);
  });
});

describe('M15 / 서비스 뷰', () => {
  it('V04 Orca 레이어: 탭이 있고 키 그림도 있다', async () => {
    const { s } = await svc({});
    await s.watcher.tick(); assert.equal(s.mode, 'orca');
    const v = s.view();
    assert.equal(v.tabs, true);
    assert.equal(v.keyMap.cells.length, 16);
    assert.match(cell(v.keyMap, 'dial').title, /다음 세션/, 'Orca 프리셋 노브');
  });

  it('V05 앱 레이어: 탭 없이 키 그림 — 연결 없는 앱도 기본 레이어의 키 그림 (2026-10-11: 대기 없음)', async () => {
    const [d, o] = defaultLayers();
    const chrome = { id: 'l-chrome', kind: 'user', name: '크롬', color: '#E8762B', preset: null,
      apps: [{ bundleId: 'com.google.Chrome', name: 'Google Chrome' }], keys: { key3: sc('cmd+k') }, dial: {}, joystick: { directions: 4, short: {}, long: {} } };
    const { s, st } = await svc({ layers: [d, o, chrome], front: 'com.google.Chrome' });
    await s.watcher.tick(); assert.equal(s.mode, 'app');
    let v = s.view();
    assert.equal(v.tabs, false);
    assert.equal(cell(v.keyMap, 'key3').labelKo, 'cmd+k');
    assert.equal(cell(v.keyMap, 'key3').color, '#e8762b', '레이어 색');
    st.front = 'com.apple.finder'; await s.watcher.tick();
    assert.equal(s.mode, 'app', '기본 레이어가 비어 있어도 기본 레이어');
    v = s.view();
    assert.equal(v.tabs, false);
    assert.ok(v.keyMap, '기본 레이어의 키 그림');
  });
});

describe('M15 / 상태판 키 그림 2 — 설정 화면과 같은 판, 노브·조이스틱 작은 그림, 세션 탭도 키 배열 (2026-10-06)', () => {
  it('V06 노브·조이스틱 그림 데이터: 노브 ↺·누름·↻ 이름, 조이스틱 방향 수·축·방향별 이름(짧게), 레이어 색', () => {
    const map = buildKeyMap({
      mode: 'app', color: '#E8762B', joystick: { directions: 2, axis: 'horizontal' },
      scene: { keys: {} },
      slots: { dial_ccw: sc('뒤로'), dial_press: sc('누름'), joystick_left: sc('왼'), joystickHold_left: sc('왼 길게') },
      titles: [],
    });
    assert.deepEqual(map.dial, { ccw: '뒤로', cw: '', press: '누름' });
    assert.deepEqual(map.joystick, { directions: 2, axis: 'horizontal', labels: { left: '왼' } });
    assert.equal(map.color, '#E8762B');
  });
  it('V07 Orca 작업 칸은 상태 글자(statusKo)도 담는다 — 세션 탭이 쓴다', () => {
    const map = buildKeyMap({
      mode: 'orca', scene: { keys: { slot1: { color: 'amber', brightness: 0.5 } } }, slots: {},
      titles: ['hydroid', null], statuses: ['실행 중', null],
    });
    const k1 = map.cells.find((c) => c.id === 'key1');
    assert.equal(k1.statusKo, '실행 중');
    assert.equal(k1.n, 1);
    assert.equal(map.cells.find((c) => c.id === 'key2').statusKo, null);
  });
});
