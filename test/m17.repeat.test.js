/**
 * M17 — 누르고 있으면 반복 (2026-10-09). 데이터·설정, 그리고 서비스 반복 엔진.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAction } from '../src/apps/appKeys.js';
import { normalizeLayers } from '../src/apps/layers.js';

describe('M17 / 반복 데이터', () => {
  it('R01 반복은 기본 켬 — 끈 경우(repeat:false)만 저장한다, 단축키만 (2026-10-09 사용자 결정)', () => {
    assert.equal(normalizeAction({ type: 'shortcut', keystroke: 'left', repeat: false }).repeat, false);
    assert.equal('repeat' in normalizeAction({ type: 'shortcut', keystroke: 'left', repeat: true }), false, '켬은 기본이라 저장하지 않는다');
    assert.equal('repeat' in normalizeAction({ type: 'shortcut', keystroke: 'left' }), false);
    assert.equal('repeat' in normalizeAction({ type: 'shortcut', keystroke: 'left', repeat: 'no' }), false);
    assert.equal('repeat' in normalizeAction({ type: 'insertText', text: 'x', repeat: false }), false);
  });
  it('R02 레이어: 키 칸은 repeat를 지키고 노브·조이스틱 칸은 지운다', () => {
    const sc = { type: 'shortcut', label: 'L', keystroke: 'left', repeat: false };
    const l = normalizeLayers([
      { id: 'default', kind: 'default', keys: {}, dial: {}, joystick: { directions: 4, short: {}, long: {} } },
      { id: 'l-x', kind: 'user', name: 'X', color: '#123456', apps: [], keys: { key3: sc }, dial: { cw: sc }, joystick: { directions: 4, short: { up: sc }, long: {} } },
    ], []).find((x) => x.id === 'l-x');
    assert.equal(l.keys.key3.repeat, false);
    assert.equal('repeat' in l.dial.cw, false);
    assert.equal('repeat' in l.joystick.short.up, false);
  });
});

const ORCA_ID = 'com.stablyai.orca';
async function svc({ layers, front = 'com.microsoft.VSCode', locked = () => false, failFirst = false, via = 'native', firstTakes = 0 }) {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { OutputService } = await import('../src/service/outputService.js');
  const { UNCALIBRATED } = await import('../src/device/calibrationLoader.js');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-m17-'));
  fs.writeFileSync(path.join(stateDir, 'profiles.json'), JSON.stringify({ version: 6, layers }));
  const st = { front, now: 1000 }; const calls = []; const timers = [];
  let attempts = 0;
  const s = new OutputService({ calibration: UNCALIBRATED, stateDir,
    openRuntimeTransport: async () => { const e = new Error('x'); e.code = 'DEVICE_NOT_FOUND'; throw e; },
    orcaEnabled: false, frontmost: async () => st.front, ownBundleIds: ['dev.output.keypad'], isLocked: locked,
    now: () => st.now,
    keyRepeat: () => ({ delayMs: 400, intervalMs: 50 }),
    appExec: { synth: async (k) => { attempts += 1; if (failFirst && attempts === 1) throw new Error('x'); if (attempts === 1) st.now += firstTakes; calls.push(k.key); return via; },
      openApp: async () => ({ code: 0 }), openUrl: async () => ({ code: 0 }), execCommand: async () => ({ code: 0 }),
      readClipboard: async () => '', writeClipboard: async () => ({ code: 0 }), moveWindow: async () => ({ ok: true }), hasWindow: async () => true },
    timers: { setInterval: () => ({}), clearInterval: () => {},
      setTimeout: (fn, ms) => { const t = { fn, ms, done: false }; timers.push(t); return t; },
      clearTimeout: (t) => { if (t) t.done = true; } } });
  // 예약된 타이머 중 아직 안 끝난 첫 번째를 실행한다
  const fire = async () => { const t = timers.find((x) => !x.done); assert.ok(t, '예약된 타이머 없음'); t.done = true; await t.fn(); };
  const flush = () => new Promise((r) => { setImmediate(r); });
  return { s, st, calls, timers, fire, flush };
}
const lay = (keys) => [
  { id: 'default', kind: 'default', keys: {}, dial: {}, joystick: { directions: 4, short: {}, long: {} } },
  { id: 'l-code', kind: 'user', name: '코드', color: '#123456', apps: [{ bundleId: 'com.microsoft.VSCode', name: 'VS Code' }], keys, dial: {}, joystick: { directions: 4, short: {}, long: {} } },
];
const left = { type: 'shortcut', label: '←', keystroke: 'left' };   // 반복은 기본 켬 (2026-10-09)

describe('M17 / 누르는 동안 반복', () => {
  it('R03 누르는 순간 한 번, 지연 뒤 간격마다, 떼면 멈추고 뗄 때 tap은 버린다 / 첫 입력 전에 떼면 반복 없음', async () => {
    const { s, st, calls, timers, fire, flush } = await svc({ layers: lay({ key3: left }) });
    await s.watcher.tick(); assert.equal(s.mode, 'app');
    s.decoder.press('slot3'); await flush();
    assert.deepEqual(calls, ['left'], '누르는 순간 한 번');
    assert.equal(timers.at(-1).ms, 400, '반복 지연');
    await fire(); assert.deepEqual(calls, ['left', 'left']);
    assert.equal(timers.at(-1).ms, 50, '반복 간격');
    await fire(); assert.equal(calls.length, 3);
    st.now += 100; s.decoder.release('slot3'); await flush();
    assert.equal(calls.length, 3, '뗄 때 tap으로 한 번 더 들어가지 않는다');
    assert.ok(timers.every((t) => t.done), '타이머가 남지 않는다');
    // 아주 짧은 탭: 누르고 첫 입력이 끝나기 전에 뗌
    st.now += 100; s.decoder.press('slot3'); st.now += 30; s.decoder.release('slot3'); await flush();
    assert.equal(calls.length, 4, '한 번만');
    assert.ok(timers.every((t) => t.done), '반복이 시작되지 않는다');
  });
  it('R04 반복 중 앞 앱이 바뀌면 멈춘다', async () => {
    const { s, st, calls, timers, fire, flush } = await svc({ layers: lay({ key3: left }) });
    await s.watcher.tick();
    s.decoder.press('slot3'); await flush();
    await fire(); assert.equal(calls.length, 2);
    const repeatTimers = [...timers];   // 레이어 바뀜 깜박임(2026-10-10)이 새 타이머를 걸므로 반복 타이머만 본다
    st.front = 'com.apple.finder'; await s.watcher.tick();
    assert.ok(repeatTimers.every((t) => t.done), '레이어가 바뀌면 멈춘다');
  });
  it('R05 반복 중 화면이 잠기면 다음 회차에서 멈춘다, 첫 입력이 실패하면 반복하지 않는다', async () => {
    let locked = false;
    const { s, calls, timers, fire, flush } = await svc({ layers: lay({ key3: left }), locked: () => locked });
    await s.watcher.tick();
    s.decoder.press('slot3'); await flush();
    locked = true;
    await fire();
    assert.equal(calls.length, 1, '잠긴 뒤에는 보내지 않는다');
    assert.ok(timers.every((t) => t.done));
    const b = await svc({ layers: lay({ key3: left }), failFirst: true });
    await b.s.watcher.tick();
    b.s.decoder.press('slot3'); await b.flush();
    assert.equal(b.timers.length, 0, '첫 입력 실패 → 반복 없음');
  });
  it('R06 반복을 끈 키는 지금처럼 뗄 때 한 번, Orca 레이어의 키 1~10은 반복 대상이 아니다', async () => {
    const plain = { type: 'shortcut', label: '←', keystroke: 'left', repeat: false };
    const { s, st, calls, timers, flush } = await svc({ layers: lay({ key3: plain }) });
    await s.watcher.tick();
    s.decoder.press('slot3'); await flush();
    assert.equal(calls.length, 0, '누를 때는 아무것도');
    st.now += 100; s.decoder.release('slot3'); await flush(); await new Promise((r) => { setTimeout(r, 5); });
    assert.deepEqual(calls, ['left']);
    assert.equal(timers.length, 0);
    const o = await svc({ layers: [lay({})[0], { id: 'l-orca', kind: 'user', name: 'Orca', color: '#1F9E96', preset: 'orca', apps: [{ bundleId: ORCA_ID, name: 'Orca' }], keys: { key11: left }, dial: {}, joystick: { directions: 4, short: {}, long: {} } }], front: ORCA_ID });
    await o.s.watcher.tick(); assert.equal(o.s.mode, 'orca');
    o.s.decoder.press('slot1'); await o.flush();
    assert.equal(o.calls.length, 0, '작업 칸은 반복하지 않는다');
    o.s.decoder.press('attention'); await o.flush();
    assert.deepEqual(o.calls, ['left'], 'Orca 레이어의 키 11은 반복');
  });
});

describe('M17 / 최종 리뷰 반영 (2026-10-09)', () => {
  const two = (keys) => [lay({})[0], { ...lay(keys)[1], apps: [{ bundleId: 'com.microsoft.VSCode', name: 'VS Code' }, { bundleId: 'com.apple.TextEdit', name: 'TextEdit' }] }];
  it('F1 반복 중 장치가 끊겨도 다음 정상 탭을 버리지 않는다', async () => {
    const { s, st, calls, flush } = await svc({ layers: lay({ key3: left }) });
    await s.watcher.tick();
    s.decoder.press('slot3'); await flush();
    s._onDisconnected('lost');
    st.now += 100;
    await s._onIntent({ type: 'tap', key: 'slot3' });
    await new Promise((r) => { setTimeout(r, 5); });
    assert.equal(calls.length, 2, '끊긴 뒤의 탭은 실행된다');
  });
  it('F2 앞 앱을 막 바꾼 직후 반복 키를 누르면, 첫 입력이 앞 앱 확인에 걸려도 뗄 때 탭으로 들어간다', async () => {
    const { s, st, calls, timers, flush } = await svc({ layers: two({ key3: left }) });
    await s.watcher.tick();
    st.front = 'com.apple.TextEdit';          // 감시 주기(1초) 전에 누름 — 서비스는 아직 VS Code로 안다
    s.decoder.press('slot3'); await flush(); await new Promise((r) => { setTimeout(r, 5); });
    assert.equal(calls.length, 0, '첫 입력은 앞 앱 확인에 걸린다');
    assert.ok(timers.every((t) => t.done), '반복도 없다');
    st.now += 100; s.decoder.release('slot3'); await flush(); await new Promise((r) => { setTimeout(r, 5); });
    assert.deepEqual(calls, ['left'], '뗄 때 평소처럼 한 번 들어간다');
  });
  it('F3 같은 레이어 안에서 앞 앱이 바뀌어도 반복을 멈춘다', async () => {
    const { s, st, calls, timers, fire, flush } = await svc({ layers: two({ key3: left }) });
    await s.watcher.tick();
    s.decoder.press('slot3'); await flush();
    await fire(); assert.equal(calls.length, 2);
    st.front = 'com.apple.TextEdit'; await s.watcher.tick();
    const t = timers.find((x) => !x.done);
    if (t) { t.done = true; await t.fn(); }
    assert.equal(calls.length, 2, '다른 앱에는 보내지 않는다');
    assert.ok(timers.every((x) => x.done));
  });
  it('F4 매크로 단계 사이는 최소 100ms (osascript가 주던 틈 — 빠른 키 입력으로 사라지지 않게)', async () => {
    const { ActionRunner } = await import('../src/apps/actionRunner.js');
    const sleeps = [];
    const r = new ActionRunner({ exec: { synth: async () => {} }, frontmost: async () => 'com.microsoft.VSCode', displays: () => [],
      now: () => 1000, sleep: async (ms) => { sleeps.push(ms); } });
    r.notePhysical('key4');
    const res = await r.run('key4', { type: 'sequence', label: 's', steps: [{ keystroke: 'cmd+space', delayMs: 0 }, { keystroke: 'a', delayMs: 300 }, { keystroke: 'b', delayMs: 0 }] }, { kind: 'app', bundleId: 'com.microsoft.VSCode' });
    assert.equal(res.ok, true);
    assert.deepEqual(sleeps, [100, 300], '단계 사이만, 마지막 뒤에는 기다리지 않는다');
  });
});

describe('M17 / 미룬 것 마무리 (2026-10-09)', () => {
  it('D01 반복 간격: 실제로 네이티브로 갔으면 macOS 간격, osascript로 내려갔으면 최소 150ms', async () => {
    const a = await svc({ layers: lay({ key3: left }), via: 'native' });
    await a.s.watcher.tick(); a.s.decoder.press('slot3'); await a.flush();
    await a.fire();
    assert.equal(a.timers.at(-1).ms, 50);
    const b = await svc({ layers: lay({ key3: left }), via: 'osascript' });
    await b.s.watcher.tick(); b.s.decoder.press('slot3'); await b.flush();
    await b.fire();
    assert.equal(b.timers.at(-1).ms, 150);
  });
  it('D02 반복 지연은 누른 순간부터 잰다 (첫 입력이 걸린 시간을 뺀다)', async () => {
    const { s, timers, flush } = await svc({ layers: lay({ key3: left }), firstTakes: 120 });
    await s.watcher.tick(); s.decoder.press('slot3'); await flush();
    assert.equal(timers.at(-1).ms, 280);
  });
  it('D03 Output 자기 창을 누르면(앞 앱 감시는 무시하는 창) 반복을 멈춘다', async () => {
    const { s, timers, flush } = await svc({ layers: lay({ key3: left }) });
    await s.watcher.tick(); s.decoder.press('slot3'); await flush();
    assert.ok(timers.some((t) => !t.done));
    s.ownWindowFocused();
    assert.ok(timers.every((t) => t.done));
  });
  it('D04 첫 입력 뒤 처리에서 오류가 나도 처리되지 않은 거부를 남기지 않고 반복을 멈춘다', async () => {
    const { s, timers, flush } = await svc({ layers: lay({ key3: left }) });
    await s.watcher.tick();
    const seen = []; const onRej = (e) => seen.push(e); process.on('unhandledRejection', onRej);
    s._changed = () => { throw new Error('화면 갱신 실패'); };
    s.decoder.press('slot3'); await flush(); await flush();
    process.off('unhandledRejection', onRej);
    assert.deepEqual(seen, []);
    assert.ok(timers.every((t) => t.done), '반복도 멈춘다');
  });
});
