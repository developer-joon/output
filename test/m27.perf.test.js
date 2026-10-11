/**
 * M27 — 성능 (2026-10-11 측정: Orca CLI 3개를 2초마다 = CPU 한 코어의 약 23%).
 * 1 Orca 확인 줄이기 · 2 숨은 창에 그리지 않기(Electron, 스모크). (3 Input 앱 확인은 2026-10-11 통째로 없앰)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OrcaCli } from '../src/adapters/orca/orcaCli.js';
import { OrcaAdapter } from '../src/adapters/orca/orcaAdapter.js';

function cliCounting({ worktrees, ps }) {
  const calls = [];
  const cli = new OrcaCli({ runner: async (bin, argv) => {
    const cmd = argv.slice(0, 2).join(' ');
    calls.push(cmd);
    if (cmd === 'worktree list') return JSON.stringify({ ok: true, result: { worktrees: worktrees() } });
    if (cmd === 'terminal list') return JSON.stringify({ ok: true, result: { terminals: [] } });
    if (cmd === 'worktree ps') return JSON.stringify({ ok: true, result: ps() });
    return JSON.stringify({ ok: true, result: {} });
  } });
  return { cli, calls };
}
const wt = (id) => ({ id, displayName: id, workspaceStatus: 'in-progress', sortOrder: 1 });

describe('M27 / Orca 확인 줄이기', () => {
  it('F01 list({full:false}): 에이전트 상태(worktree ps)만 새로, 작업·터미널 목록은 지난 것 — 처음엔 셋 다', async () => {
    const { cli, calls } = cliCounting({ worktrees: () => [wt('a')], ps: () => ({ worktrees: [{ worktreeId: 'a', agents: [] }] }) });
    const a = new OrcaAdapter({ cli });
    await a.list({ full: false });
    assert.deepEqual(calls.sort(), ['terminal list', 'worktree list', 'worktree ps'], '처음엔 목록이 없어 셋 다');
    calls.length = 0;
    const r = await a.list({ full: false });
    assert.deepEqual(calls, ['worktree ps']);
    assert.equal(r.units.length, 1);
  });
  it('F02 에이전트 상태에 모르는 작업이 보이면 그 자리에서 목록도 다시 읽는다', async () => {
    let ids = ['a'];
    const { cli, calls } = cliCounting({ worktrees: () => ids.map(wt), ps: () => ({ worktrees: ids.map((id) => ({ worktreeId: id, agents: [] })) }) });
    const a = new OrcaAdapter({ cli });
    await a.list();
    ids = ['a', 'b'];
    calls.length = 0;
    const r = await a.list({ full: false });
    assert.ok(calls.includes('worktree list'), '새 작업 b');
    assert.deepEqual(r.units.map((u) => u.id).sort(), ['a', 'b']);
  });
});

async function svc({ front = 'com.google.Chrome', orcaRunning = async () => true } = {}) {
  const { OutputService } = await import('../src/service/outputService.js');
  const { UNCALIBRATED } = await import('../src/device/calibrationLoader.js');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-m27-'));
  const st = { now: 100000 };
  const s = new OutputService({ calibration: UNCALIBRATED, stateDir, orcaEnabled: false, now: () => st.now, orcaRunning,
    openRuntimeTransport: async () => { throw Object.assign(new Error('x'), { code: 'DEVICE_NOT_FOUND' }); }, frontmost: async () => front, ownBundleIds: [] });
  const lists = [];
  s.orca = { adapter: { list: async (o) => { lists.push(o?.full !== false); return { units: [], terminals: [], hiddenIds: [], order: [], notesKo: [] }; },
    health: async () => ({ runtimeReady: true, appVersion: '1.4' }) }, sync: { indexTerminals() {}, syncOnce: () => ({ added: [], vanished: [], hidden: [] }) } };
  s.orcaEnabled = true;
  await s.watcher.tick();
  return { s, st, lists };
}

describe('M27 / Orca 확인 주기', () => {
  it('F03 Orca 레이어도 상태판도 아니면 6초에 한 번, 목록 전체는 10초에 한 번', async () => {
    const { s, st, lists } = await svc();
    for (let i = 0; i < 6; i += 1) { await s._refreshOrca(); st.now += 2000; }   // 12초 동안 2초마다 부름
    assert.equal(lists.length, 2, '6초에 한 번');
    assert.deepEqual(lists, [true, false], '처음은 전체, 6초 뒤는 에이전트 상태만 (전체는 10초마다)');
  });
  it('F04 상태판이 열려 있으면 2초마다, 열리는 순간 바로 한 번', async () => {
    const { s, st, lists } = await svc();
    await s._refreshOrca();
    lists.length = 0;
    st.now += 100;
    s.setUiVisible(true);
    await new Promise((r) => { setTimeout(r, 5); });
    assert.equal(lists.length, 1, '열리는 순간');
    for (let i = 0; i < 3; i += 1) { st.now += 2000; await s._refreshOrca(); }
    assert.equal(lists.length, 4);
  });
  it('F05 Orca 앱이 꺼져 있으면 CLI를 부르지 않는다', async () => {
    const { s, lists } = await svc({ orcaRunning: async () => false });
    await s._refreshOrca();
    assert.equal(lists.length, 0);
    assert.equal(s.health().orca.state, 'unreachable');
  });
});
