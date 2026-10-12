/**
 * M30 — 작업 목록과 탭·에이전트 보고의 작업 id가 다를 때 (실기 2026-10-12 다른 Mac).
 * `worktree list`의 id와 `terminal list`·`worktree ps`의 worktreeId가 같은 경로인데 달라서
 * 탭도 상태도 붙지 않아 '상태 모름'이 됐다 (작업 9개 중 3개, 셋 다 Orca에서는 완료). 경로로 짝을 맞춘다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OrcaCli } from '../src/adapters/orca/orcaCli.js';
import { OrcaAdapter } from '../src/adapters/orca/orcaAdapter.js';
import { aggregateUnitStatus } from '../src/core/policy.js';
import { Status } from '../src/core/types.js';

const LIST_ID = 'repo-list::/w/discus';
const PS_ID = 'repo-ps::/w/discus';

function cli({ terminals }) {
  const calls = [];
  const c = new OrcaCli({ runner: async (bin, argv) => {
    const cmd = argv.slice(0, 2).join(' ');
    calls.push(cmd);
    if (cmd === 'worktree list') return JSON.stringify({ ok: true, result: { worktrees: [
      { id: LIST_ID, path: '/w/discus', displayName: 'discus', sortOrder: 1 },
      { id: 'ok::/w/fine', path: '/w/fine', displayName: 'fine', sortOrder: 2 },
    ] } });
    if (cmd === 'terminal list') return JSON.stringify({ ok: true, result: { terminals } });
    if (cmd === 'worktree ps') return JSON.stringify({ ok: true, result: { worktrees: [
      { worktreeId: PS_ID, path: '/w/discus', status: 'active', agents: [{ paneKey: 't1:l1', state: 'done', stateStartedAt: 5 }] },
      { worktreeId: 'ok::/w/fine', path: '/w/fine', status: 'active', agents: [{ paneKey: 't2:l2', state: 'done', stateStartedAt: 5 }] },
    ] } });
    return JSON.stringify({ ok: true, result: {} });
  } });
  return { cli: c, calls };
}
const TERMS = [
  { handle: 'h1', worktreeId: PS_ID, tabId: 't1', leafId: 'l1', connected: true, agentIdentity: 'claude' },
  { handle: 'h1s', worktreeId: PS_ID, tabId: 't1s', leafId: 'l1s', connected: true },
  { handle: 'h2', worktreeId: 'ok::/w/fine', tabId: 't2', leafId: 'l2', connected: true, agentIdentity: 'claude' },
];

describe('M30 / 작업 id가 목록과 보고에서 다를 때', () => {
  it('A01 경로가 같으면 같은 작업 — 탭과 에이전트 상태가 붙어 완료로 보인다 (상태 모름 아님)', async () => {
    const r = await new OrcaAdapter({ cli: cli({ terminals: TERMS }).cli }).list();
    const u = r.units.find((x) => x.id === LIST_ID);
    assert.equal(u.children.length, 2, '에이전트 탭 + 셸 탭');
    assert.equal(aggregateUnitStatus(u), Status.DONE_UNSEEN);
    assert.equal(aggregateUnitStatus(r.units.find((x) => x.id === 'ok::/w/fine')), Status.DONE_UNSEEN);
  });

  it('A02 상태만 새로 읽을 때(full:false) 다른 id를 새 작업으로 여겨 목록을 매번 다시 읽지 않는다', async () => {
    const { cli: c, calls } = cli({ terminals: TERMS });
    const a = new OrcaAdapter({ cli: c });
    await a.list();
    calls.length = 0;
    await a.list({ full: false });
    assert.deepEqual(calls, ['worktree ps']);
  });

  it('A03 끊긴 탭 다시 찾기도 목록 id로 찾는다', async () => {
    const terms = [{ handle: 'new', worktreeId: PS_ID, tabId: 't1', leafId: 'l1', connected: true }];
    const a = new OrcaAdapter({ cli: cli({ terminals: terms }).cli });
    await a.list();
    const r = await a.resolveHandle({ handle: 'old', worktreeId: LIST_ID, tabId: 't1', leafId: 'l1' });
    assert.equal(r.handle, 'new');
  });
});
