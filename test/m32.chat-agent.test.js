/**
 * M32 — Orca 내장 채팅 에이전트 (실기 2026-10-22).
 * 채팅 세션은 터미널이 없고 `worktree ps`에만 paneKey `structured-agent-session-…`로 나온다.
 * 일이 끝나면 묶음 상태가 inactive가 되어 '쉬는 작업'으로 숨겨졌다 — 완료·미확인을 알려야 할 때 키에서 사라졌다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OrcaCli } from '../src/adapters/orca/orcaCli.js';
import { OrcaAdapter } from '../src/adapters/orca/orcaAdapter.js';
import { OrcaFocusRouter } from '../src/adapters/orca/orcaFocusRouter.js';
import { aggregateUnitStatus } from '../src/core/policy.js';
import { Status } from '../src/core/types.js';

const WT = 'repo::/w/chat';
const PANE = 'structured-agent-session-claude_e228:4f86';

function cli({ status = 'inactive', state = 'done', terminals = [] } = {}) {
  const calls = [];
  const c = new OrcaCli({ runner: async (bin, argv) => {
    const cmd = argv.slice(0, 2).join(' ');
    calls.push(argv.join(' '));
    if (cmd === 'worktree list') return JSON.stringify({ ok: true, result: { worktrees: [
      { id: WT, path: '/w/chat', displayName: 'chat', sortOrder: 1 },
    ] } });
    if (cmd === 'terminal list') return JSON.stringify({ ok: true, result: { terminals } });
    if (cmd === 'worktree ps') return JSON.stringify({ ok: true, result: { worktrees: [
      { worktreeId: WT, path: '/w/chat', status, agents: [{ paneKey: PANE, state, agentType: 'claude', stateStartedAt: 5 }] },
    ] } });
    return JSON.stringify({ ok: true, result: {} });
  } });
  return { cli: c, calls };
}
const acked = (at) => ({ read: () => ({ hideDefaultBranch: false, repoOrder: null, agentAcks: { [PANE]: at }, warningKo: null }) });

describe('M32 / 터미널 없는 Orca 채팅 에이전트', () => {
  it('B01 일이 끝나 inactive여도 숨기지 않고 완료·미확인으로 보인다', async () => {
    const r = await new OrcaAdapter({ cli: cli().cli }).list();
    assert.deepEqual(r.hiddenIds, []);
    const u = r.units.find((x) => x.id === WT);
    assert.ok(u, '작업 칸이 있어야 한다');
    assert.equal(aggregateUnitStatus(u), Status.DONE_UNSEEN);
  });

  it('B02 일하는 중이면 진행 중', async () => {
    const r = await new OrcaAdapter({ cli: cli({ status: 'working', state: 'working' }).cli }).list();
    assert.equal(aggregateUnitStatus(r.units.find((x) => x.id === WT)), Status.RUNNING);
  });

  it('B03 Orca에서 완료 뒤에 열어 봤으면 확인함', async () => {
    const r = await new OrcaAdapter({ cli: cli().cli, settings: acked(9) }).list();
    assert.equal(aggregateUnitStatus(r.units.find((x) => x.id === WT)), Status.DONE_SEEN);
  });

  it('B04 터미널에 붙은 에이전트는 채팅으로 한 번 더 세지 않는다', async () => {
    const terminals = [{ handle: 'h1', worktreeId: WT, tabId: 'structured-agent-session-claude_e228', leafId: '4f86', connected: true }];
    const r = await new OrcaAdapter({ cli: cli({ terminals }).cli }).list();
    assert.equal(r.units.find((x) => x.id === WT).children.length, 1);
  });

  it('B05 채팅 칸을 누르면 작업을 연 뒤 그 채팅을 띄운다 — terminal switch는 부르지 않는다 (2026-10-27)', async () => {
    const { cli: c, calls } = cli();
    const a = new OrcaAdapter({ cli: c });
    const r = await a.list();
    const child = r.units.find((x) => x.id === WT).children[0];
    calls.length = 0;
    const res = await new OrcaFocusRouter({ cli: c, adapter: a }).focus({ kind: 'child', unitId: WT, childId: child.id, reason: 'test' });
    assert.equal(res.ok, true);
    assert.deepEqual(calls, [
      `rpc worktree.activate {"worktree":"id:${WT}","navigation":"host"}`,
      'rpc agentSession.reveal {"sessionId":"claude_e228"}',
    ]);
  });

  it('B06 Orca가 거절하면 엉뚱한 곳으로 가지 않고 이유를 알린다', async () => {
    const c = new OrcaCli({ runner: async () => JSON.stringify({ ok: false, error: { code: 'method_not_found' } }) });
    const res = await new OrcaFocusRouter({ cli: c }).focus({ kind: 'child', unitId: WT, childId: `chat:${PANE}`, reason: 'test' });
    assert.equal(res.ok, false);
    assert.match(res.reasonKo, /채팅/);
  });

  it('B07 허용한 두 요청 말고는 rpc로도 보내지 않는다', async () => {
    const c = new OrcaCli({ runner: async () => '{"ok":true,"result":{}}' });
    await assert.rejects(c.rpc('agentSession.send', { sessionId: 'x' }), /허용되지 않은/);
  });
});
