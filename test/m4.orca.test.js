/**
 * M4 — Orca read/focus 어댑터.
 * 실측 스키마(Orca 1.4.206, 2026-09-21) 기준. 상태를 추측하지 않는다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  OrcaCli, OrcaCliError, isAllowed, READ_COMMANDS, FOCUS_COMMAND, FORBIDDEN_VERBS,
} from '../src/adapters/orca/orcaCli.js';
import {
  OrcaAdapter, toChildUnit, toWorkUnit, terminalStatus, roleOfTerminal,
  WORKSPACE_STATUS_MAP,
} from '../src/adapters/orca/orcaAdapter.js';
import { OrcaFocusRouter } from '../src/adapters/orca/orcaFocusRouter.js';
import { OrcaSync } from '../src/adapters/orca/orcaSync.js';
import { statusOfAgent, confidenceOfAgent, paneKeyToTabLeaf } from '../src/adapters/orca/agentState.js';
import { Status, Confidence, ChildRole, isAttention } from '../src/core/types.js';
import { StateStore } from '../src/core/stateStore.js';
import { WorkUnit } from '../src/core/units.js';
import { Output } from '../src/output.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const REAL = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/orca-real.json'), 'utf8'));
const PS_REAL = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/orca-ps-real.json'), 'utf8'));

/** 실측 응답을 그대로 돌려주는 가짜 CLI */
function fakeCli({
  worktrees = REAL.worktrees, terminals = REAL.terminals, ps = { worktrees: [] }, fail = null,
} = {}) {
  const calls = [];
  const cli = new OrcaCli({
    runner: async (bin, argv) => {
      calls.push(argv);
      if (fail) throw new OrcaCliError(fail);
      const cmd = argv.slice(0, 2).join(' ');
      if (cmd === 'worktree list') return JSON.stringify({ ok: true, result: { worktrees } });
      if (cmd === 'terminal list') return JSON.stringify({ ok: true, result: { terminals } });
      if (cmd === 'worktree ps') {
        if (ps instanceof Error) throw new OrcaCliError(ps.message);
        return JSON.stringify({ ok: true, result: ps });
      }
      if (cmd === 'terminal switch') {
        // 실기와 같게: 목록에 없는 핸들이면 terminal_handle_stale로 거절 (실측 2026-10-04)
        if (!terminals.some((t) => t.handle === argv[3])) return JSON.stringify({ ok: false, error: { code: 'terminal_handle_stale' } });
        return JSON.stringify({ ok: true, result: {} });
      }
      if (argv[0] === 'status') {
        return JSON.stringify({
          ok: true,
          result: { app: { running: true }, runtime: { state: 'ready', reachable: true, appVersion: '1.4.206' } },
        });
      }
      return JSON.stringify({ ok: true, result: {} });
    },
  });
  return { cli, calls };
}

describe('M4 / CLI 안전 경계', () => {
  it('O01 읽기와 focus만 허용한다', () => {
    for (const cmd of Object.values(READ_COMMANDS)) assert.ok(isAllowed(cmd), cmd.join(' '));
    assert.ok(isAllowed(FOCUS_COMMAND));
  });

  it('O02 파괴적 명령은 허용 목록에 없다', () => {
    for (const cmd of [
      ['worktree', 'rm'], ['worktree', 'create'], ['worktree', 'set'],
      ['terminal', 'close'], ['terminal', 'send'], ['terminal', 'create'],
      ['orchestration', 'dispatch'], ['computer', 'click'], ['repo', 'add'],
      ['automations', 'run'], ['account', 'add'],
    ]) {
      assert.equal(isAllowed(cmd), false, cmd.join(' '));
    }
  });

  it('O03 금지 동사는 실행 시도조차 하지 않는다', async () => {
    const { cli, calls } = fakeCli();
    for (const cmd of [['worktree', 'rm'], ['terminal', 'send'], ['computer', 'type-text']]) {
      await assert.rejects(cli.run(cmd), /파괴적일 수 있는/);
    }
    assert.equal(calls.length, 0, '한 건도 실행되면 안 된다');
  });

  it('O04 허용 목록 밖은 거절한다', async () => {
    const { cli } = fakeCli();
    await assert.rejects(cli.run(['skills', 'list']), /허용되지 않은/);
    await assert.rejects(cli.run(['search']), /허용되지 않은/);
  });

  it('O05 금지 동사 목록에 파괴적 동작이 들어 있다', () => {
    for (const v of ['rm', 'close', 'send', 'create', 'delete', 'dispatch', 'click']) {
      assert.ok(FORBIDDEN_VERBS.includes(v), v);
    }
  });

  it('O06 항상 --json을 붙여 호출한다', async () => {
    const { cli, calls } = fakeCli();
    await cli.run(READ_COMMANDS.worktreeList);
    assert.deepEqual(calls[0], ['worktree', 'list', '--json']);
  });

  it('O07 Orca가 거절하면 그대로 실패로 만든다', async () => {
    const cli = new OrcaCli({
      runner: async () => JSON.stringify({ ok: false, error: { code: 'E_NOPE' } }),
    });
    await assert.rejects(cli.run(READ_COMMANDS.status), /거절했습니다/);
  });
});

describe('M4 / 실측 스키마 변환', () => {
  it('O08 terminal 상태는 관측 가능한 것만 쓴다', () => {
    assert.equal(terminalStatus({ orphaned: true, connected: true }), Status.STALE);
    assert.equal(terminalStatus({ orphaned: false, connected: false }), Status.DISCONNECTED);
    // 살아 있다고 해서 무엇을 하는지는 모른다
    assert.equal(terminalStatus({ orphaned: false, connected: true }), Status.UNKNOWN);
  });

  it('O09 출력이 멈췄다고 완료나 답변 필요로 해석하지 않는다', () => {
    const old = { handle: 'h', connected: true, orphaned: false, lastOutputAt: 1 };
    assert.equal(terminalStatus(old), Status.UNKNOWN);
    assert.notEqual(terminalStatus(old), Status.DONE_UNSEEN);
    assert.notEqual(terminalStatus(old), Status.WAITING_INPUT);
  });

  it('O10 agentIdentity가 있으면 agent child로 본다', () => {
    assert.equal(roleOfTerminal({ agentIdentity: 'claude' }), ChildRole.AGENT);
    assert.equal(roleOfTerminal({}), ChildRole.TERMINAL);
    const c = toChildUnit({ handle: 'h', title: 't', agentIdentity: 'claude', connected: true });
    assert.equal(c.primaryAgent, true);
    assert.equal(c.confidence, Confidence.INFERRED, '무엇을 하는지는 모른다');
  });

  it('O11 터미널 내용(preview)을 옮기지 않는다', () => {
    const c = toChildUnit({
      handle: 'h', title: 't', connected: true, preview: '비밀 토큰 abc123',
    });
    assert.equal(JSON.stringify(c).includes('abc123'), false);
    assert.equal('preview' in c, false);
  });

  it('O12 제목이 없으면 handle로 대신한다', () => {
    assert.equal(toChildUnit({ handle: 'term_x', title: null }).title, 'term_x');
  });

  it('O13 상주 여부를 모르므로 완료 판정의 필수 조건에서 뺀다', () => {
    const c = toChildUnit({ handle: 'h', connected: true });
    assert.equal(c.requiredForCompletion, false);
  });

  it('O14 workspaceStatus는 칸반 열이라 상태로 옮기지 않는다 (2026-09-29)', () => {
    // 'in-progress'는 Orca 워크스페이스 보드의 열 이름이다. 모든 worktree가 이 값을 갖는다.
    assert.equal(WORKSPACE_STATUS_MAP['in-progress'], undefined);
    assert.equal(toWorkUnit({ id: 'w', displayName: 'W', workspaceStatus: 'in-progress' }, []).status, Status.UNKNOWN);
    assert.equal(toWorkUnit({ id: 'w', displayName: 'W', workspaceStatus: '처음보는값' }, []).status, Status.UNKNOWN);
  });

  it('O15 isPinned가 슬롯 보호로 이어진다', () => {
    const u = toWorkUnit({ id: 'w', displayName: 'W', isPinned: true, workspaceStatus: 'in-progress' }, []);
    assert.equal(u.pinned, true);
    const store = new StateStore();
    store.addUnit(u);
    assert.equal(store.releaseUnit('w'), false, 'pin된 작업은 자동 해제되지 않는다');
  });
});

describe('M4 / 실측 데이터로 목록 만들기', () => {
  it('O16 worktree와 terminal을 묶어 WorkUnit을 만든다', async () => {
    const { cli } = fakeCli();
    const { units, notesKo } = await new OrcaAdapter({ cli }).list();
    assert.equal(units.length, 1);
    assert.equal(units[0].title, 'output');
    assert.equal(units[0].source, 'orca');
    assert.ok(units[0].children.length >= 1);
    assert.ok(notesKo.some((n) => /미검증\(UNKNOWN\)으로 둡니다/.test(n)));
  });

  it('O17 stale 터미널 수를 보고한다', async () => {
    const { cli } = fakeCli();
    const { notesKo } = await new OrcaAdapter({ cli }).list();
    assert.ok(notesKo.some((n) => /stale 터미널 \d+개/.test(n)));
  });

  it('O18 archived worktree는 기본적으로 뺀다', async () => {
    const archived = [{ ...REAL.worktrees[0], id: 'arch', isArchived: true }];
    const { cli } = fakeCli({ worktrees: [...REAL.worktrees, ...archived] });
    const { units } = await new OrcaAdapter({ cli }).list();
    assert.equal(units.some((u) => u.id === 'arch'), false);
    const { cli: cli2 } = fakeCli({ worktrees: [...REAL.worktrees, ...archived] });
    const all = await new OrcaAdapter({ cli: cli2, includeArchived: true }).list();
    assert.equal(all.units.some((u) => u.id === 'arch'), true);
  });

  it('O19 뜻 모르는 workspaceStatus를 모아 보고한다', async () => {
    const odd = [{ ...REAL.worktrees[0], id: 'x', workspaceStatus: '알수없음' }];
    const { cli } = fakeCli({ worktrees: odd });
    const { notesKo } = await new OrcaAdapter({ cli }).list();
    assert.ok(notesKo.some((n) => /뜻을 모르는 workspaceStatus: 알수없음/.test(n)));
  });

  it('O20 Output에 그대로 넣을 수 있다', async () => {
    const { cli } = fakeCli();
    const { units } = await new OrcaAdapter({ cli }).list();
    const store = new StateStore();
    for (const u of units) store.addUnit(u);
    const snap = new Output({ store }).render();
    assert.equal(snap.slots[0].id, units[0].id);
    // workspaceStatus(칸반 열)는 상태가 아니다. 에이전트 보고가 없으면 모른다고 표시한다 (2026-09-29)
    assert.equal(snap.slots[0].status, Status.UNKNOWN);
    assert.equal(snap.slots[0].labelKo, '상태 모름');
    // 터미널 각각은 무엇을 하는지 모른다 — 모른다고 표시한다
    assert.ok(units[0].children.every((c) => c.status === Status.UNKNOWN));
  });

  it('O20b worktree가 아무 말도 하지 않으면 모른다고 표시한다', async () => {
    const silent = [{ ...REAL.worktrees[0], workspaceStatus: null }];
    const { cli } = fakeCli({ worktrees: silent });
    const { units } = await new OrcaAdapter({ cli }).list();
    const store = new StateStore();
    for (const u of units) store.addUnit(u);
    const snap = new Output({ store }).render();
    assert.equal(snap.slots[0].labelKo, '상태 모름');
  });

  it('O21 health가 런타임 상태를 알려준다', async () => {
    const { cli } = fakeCli();
    const h = await new OrcaAdapter({ cli }).health();
    assert.deepEqual(h, {
      appRunning: true, runtimeReady: true, reachable: true, appVersion: '1.4.206',
    });
  });
});

describe('M4 / stale handle 복구', () => {
  const live = {
    handle: 'term_live', worktreeId: 'w', tabId: 'tab1', leafId: 'leaf1',
    connected: true, orphaned: false, title: 't',
  };

  it('O22 살아 있는 핸들은 그대로 쓴다', async () => {
    const { cli } = fakeCli({ terminals: [live] });
    const r = await new OrcaAdapter({ cli }).resolveHandle({ handle: 'term_live', worktreeId: 'w' });
    assert.equal(r.handle, 'term_live');
    assert.equal(r.recovered, false);
  });

  it('O23 만료된 핸들은 같은 자리를 다시 찾는다', async () => {
    const { cli } = fakeCli({
      terminals: [{ ...live, handle: 'term_new' }, { ...live, handle: 'term_old', orphaned: true }],
    });
    const r = await new OrcaAdapter({ cli }).resolveHandle({
      handle: 'term_old', worktreeId: 'w', leafId: 'leaf1',
    });
    assert.equal(r.handle, 'term_new');
    assert.equal(r.recovered, true);
    assert.match(r.reasonKo, /같은 터미널 자리/);
  });

  it('O24 자리를 못 찾으면 실패로 남긴다 — 엉뚱한 곳으로 가지 않는다', async () => {
    const { cli } = fakeCli({ terminals: [{ ...live, worktreeId: 'other' }] });
    const r = await new OrcaAdapter({ cli }).resolveHandle({
      handle: 'term_gone', worktreeId: 'w', leafId: 'leaf1',
    });
    assert.equal(r.handle, null);
    assert.match(r.reasonKo, /다시 찾지 못했습니다/);
  });
});

describe('M4 / focus', () => {
  const live = {
    handle: 'term_live', worktreeId: 'w', tabId: 'tab1', leafId: 'leaf1',
    connected: true, orphaned: false, title: 't',
  };

  it('O25 터미널로 이동한다', async () => {
    const { cli, calls } = fakeCli({ terminals: [live] });
    const router = new OrcaFocusRouter({ cli });
    const r = await router.focus({ kind: 'child', unitId: 'w', childId: 'term_live' });
    assert.equal(r.ok, true);
    assert.deepEqual(calls[0], ['terminal', 'switch', '--terminal', 'term_live', '--json']);
  });

  it('O26 만료된 핸들을 복구해 이동한다', async () => {
    const { cli, calls } = fakeCli({
      terminals: [{ ...live, handle: 'term_new' }],
    });
    const adapter = new OrcaAdapter({ cli });
    const router = new OrcaFocusRouter({ cli, adapter });
    const r = await router.focus({
      kind: 'child', unitId: 'w', childId: 'term_old', leafId: 'leaf1',
    });
    assert.equal(r.ok, true);
    assert.equal(r.recovered, true);
    assert.equal(router.recoveries, 1);
    assert.ok(calls.some((c) => c[3] === 'term_new'));
  });

  it('O27 복구하지 못하면 다른 대상으로 대신 가지 않는다', async () => {
    const { cli, calls } = fakeCli({ terminals: [{ ...live, worktreeId: 'other' }] });
    const adapter = new OrcaAdapter({ cli });
    const router = new OrcaFocusRouter({ cli, adapter });
    const r = await router.focus({ kind: 'child', unitId: 'w', childId: 'gone', leafId: 'leaf1' });
    assert.equal(r.ok, false);
    const switches = calls.filter((c) => c[0] === 'terminal' && c[1] === 'switch');
    assert.deepEqual(switches.map((c) => c[3]), ['gone'], '원래 핸들로 한 번만 시도하고, 다른 터미널로 가지 않는다');
  });

  it('O29 살아 있는 핸들이면 목록을 읽지 않고 바로 이동한다 — CLI 한 번 (노브 반응, 2026-10-04)', async () => {
    const { cli, calls } = fakeCli({ terminals: [live] });
    const router = new OrcaFocusRouter({ cli, adapter: new OrcaAdapter({ cli }) });
    const r = await router.focus({ kind: 'child', unitId: 'w', childId: 'term_live' });
    assert.equal(r.ok, true);
    assert.deepEqual(calls, [['terminal', 'switch', '--terminal', 'term_live', '--json']]);
  });

  it('O30 이동 명령이 실패하고 목록도 읽지 못하면 실패로 알린다 (Orca가 꺼짐 등)', async () => {
    const { cli } = fakeCli({ fail: 'Orca CLI 실행 실패' });
    const router = new OrcaFocusRouter({ cli, adapter: new OrcaAdapter({ cli }) });
    const r = await router.focus({ kind: 'child', unitId: 'w', childId: 'term_live' });
    assert.equal(r.ok, false);
    assert.match(r.reasonKo, /이동하지 못했습니다/);
  });

  it('O28 worktree 자체 이동은 미지원으로 표시한다', async () => {
    const { cli } = fakeCli();
    const r = await new OrcaFocusRouter({ cli }).focus({ kind: 'worktree_surface', unitId: 'w', childId: null });
    assert.equal(r.ok, false);
    assert.equal(r.unsupported, true);
    assert.match(r.reasonKo, /아직 확인되지 않았습니다/);
  });

  it('O29 이동 실패를 그대로 보고한다', async () => {
    const { cli } = fakeCli({ fail: 'Orca 런타임에 닿지 못했습니다' });
    const r = await new OrcaFocusRouter({ cli }).focus({ kind: 'child', unitId: 'w', childId: 'h' });
    assert.equal(r.ok, false);
    assert.match(r.reasonKo, /이동하지 못했습니다/);
  });

  it('O30 focus는 입력을 보내거나 승인하지 않는다', async () => {
    const { cli, calls } = fakeCli({ terminals: [live] });
    await new OrcaFocusRouter({ cli }).focus({ kind: 'child', unitId: 'w', childId: 'term_live' });
    const flat = JSON.stringify(calls);
    for (const banned of ['send', 'type-text', 'press-key', 'paste-text', 'approve', 'yes']) {
      assert.equal(flat.includes(banned), false, banned);
    }
  });
});

// ───────────── 동기화: 슬롯을 흔들지 않고 목록을 반영
describe('M4 / OrcaSync', () => {
  const wt = (id, status = 'in-progress') => ({
    id, displayName: id, workspaceStatus: status, sortOrder: 1, isArchived: false,
  });
  const term = (handle, worktreeId, extra = {}) => ({
    handle, worktreeId, tabId: `tab-${handle}`, leafId: `leaf-${handle}`,
    connected: true, orphaned: false, title: handle, lastOutputAt: 1, ...extra,
  });

  async function listWith(worktrees, terminals) {
    const { cli } = fakeCli({ worktrees, terminals });
    return new OrcaAdapter({ cli }).list();
  }

  it('O31 새 worktree는 빈 자리에만 들어간다', async () => {
    const store = new StateStore();
    const sync = new OrcaSync(store);
    const a = await listWith([wt('w1')], [term('t1', 'w1')]);
    assert.deepEqual(sync.syncOnce(a.units).added, ['w1']);
    assert.deepEqual(store.globalSlots.positionOf('w1'), { bank: 0, slot: 0 });

    const b = await listWith([wt('w1'), wt('w2')], [term('t1', 'w1')]);
    sync.syncOnce(b.units);
    assert.deepEqual(store.globalSlots.positionOf('w1'), { bank: 0, slot: 0 }, '기존 자리 불변');
    assert.deepEqual(store.globalSlots.positionOf('w2'), { bank: 0, slot: 1 });
  });

  it('O32 목록 순서가 바뀌어도 슬롯은 움직이지 않는다', async () => {
    const store = new StateStore();
    const sync = new OrcaSync(store);
    sync.syncOnce((await listWith([wt('w1'), wt('w2')], [])).units);
    const before = [store.globalSlots.positionOf('w1'), store.globalSlots.positionOf('w2')];

    // 정렬이 뒤집힌 목록을 다시 읽는다
    const flipped = [{ ...wt('w2'), sortOrder: 0 }, { ...wt('w1'), sortOrder: 9 }];
    sync.syncOnce((await listWith(flipped, [])).units);
    assert.deepEqual(
      [store.globalSlots.positionOf('w1'), store.globalSlots.positionOf('w2')], before,
    );
  });

  it('O33 사라진 worktree를 지우지 않고 관측 끊김으로 표시한다', async () => {
    const store = new StateStore();
    const sync = new OrcaSync(store);
    sync.syncOnce((await listWith([wt('w1')], [term('t1', 'w1')])).units);
    const pos = store.globalSlots.positionOf('w1');

    const r = sync.syncOnce((await listWith([], [])).units);
    assert.deepEqual(r.vanished, ['w1']);
    assert.equal(store.getUnit('w1').status, Status.DISCONNECTED);
    assert.deepEqual(store.globalSlots.positionOf('w1'), pos, '자리는 지킨다');
  });

  it('O34 사용자가 닫은 탭(목록에서 빠진 터미널)은 지운다 — 빨강(STALE)으로 남기지 않는다 (2026-10-02)', async () => {
    const store = new StateStore();
    const sync = new OrcaSync(store);
    sync.syncOnce((await listWith([wt('w1')], [term('t1', 'w1'), term('t2', 'w1')])).units);
    assert.equal(store.getUnit('w1').children.length, 2);

    const r = sync.syncOnce((await listWith([wt('w1')], [term('t1', 'w1')])).units);
    assert.equal(r.goneChildren, 1);
    assert.deepEqual(store.getUnit('w1').children.map((c) => c.id), ['t1']);
    assert.equal(isAttention(store.getUnit('w1').status), false, '탭을 닫았다고 개입이 아니다');
    assert.equal(store.detailSlots('w1').globalIndexOf('t2'), -1, '상세 자리도 비운다');
  });

  it('O34b 닫은 탭의 미확인 알림도 사라진다 — ACK 키가 남지 않게', async () => {
    const store = new StateStore();
    const sync = new OrcaSync(store);
    sync.syncOnce((await listWith([wt('w1')], [term('t1', 'w1'), term('t2', 'w1')])).units);
    store.setChildStatus('w1', 't2', Status.DONE_UNSEEN);
    assert.equal(store.unacknowledgedNotifications().length, 1);
    sync.syncOnce((await listWith([wt('w1')], [term('t1', 'w1')])).units);
    assert.equal(store.unacknowledgedNotifications().length, 0);
  });

  it('O35 새 터미널은 detail 자리를 밀지 않고 뒤에 붙는다', async () => {
    const store = new StateStore();
    const sync = new OrcaSync(store);
    sync.syncOnce((await listWith([wt('w1')], [term('t1', 'w1')])).units);
    const first = store.detailSlots('w1').positionOf('t1');

    const r = sync.syncOnce((await listWith([wt('w1')], [term('t1', 'w1'), term('t2', 'w1')])).units);
    assert.equal(r.updatedChildren, 1);
    assert.deepEqual(store.detailSlots('w1').positionOf('t1'), first);
    assert.deepEqual(store.detailSlots('w1').positionOf('t2'), { bank: 0, slot: 1 });
  });

  it('O36 터미널이 stale이 되면 상태만 바뀐다', async () => {
    const store = new StateStore();
    const sync = new OrcaSync(store);
    sync.syncOnce((await listWith([wt('w1')], [term('t1', 'w1')])).units);
    assert.equal(store.getUnit('w1').child('t1').status, Status.UNKNOWN);

    sync.syncOnce((await listWith([wt('w1')], [term('t1', 'w1', { orphaned: true })])).units);
    assert.equal(store.getUnit('w1').child('t1').status, Status.STALE);
  });

  it('O37 다시 읽었다고 상태를 정상으로 가장하지 않는다', async () => {
    const store = new StateStore();
    const sync = new OrcaSync(store);
    sync.syncOnce((await listWith([wt('w1')], [term('t1', 'w1')])).units);
    sync.syncOnce((await listWith([], [])).units);
    assert.equal(store.getUnit('w1').status, Status.DISCONNECTED);
    // 다시 나타나면 끊김이 풀린다. 에이전트 보고가 없으니 '모름'이지 '정상'은 아니다
    sync.syncOnce((await listWith([wt('w1')], [term('t1', 'w1')])).units);
    assert.equal(store.getUnit('w1').status, Status.UNKNOWN);
  });

  it('O38 handle 색인으로 stale 복구 정보를 제공한다', () => {
    const sync = new OrcaSync(new StateStore());
    sync.indexTerminals([term('t1', 'w1')]);
    assert.deepEqual(sync.locate('t1'), { worktreeId: 'w1', tabId: 'tab-t1', leafId: 'leaf-t1' });
    assert.equal(sync.locate('없음'), null);
  });

  it('O39 focus가 색인으로 자리를 찾아 복구한다', async () => {
    const store = new StateStore();
    const sync = new OrcaSync(store);
    sync.indexTerminals([term('t_old', 'w1')]);
    const { cli, calls } = fakeCli({
      terminals: [term('t_new', 'w1', { leafId: 'leaf-t_old' })],
    });
    const router = new OrcaFocusRouter({ cli, adapter: new OrcaAdapter({ cli }), sync });
    const r = await router.focus({ kind: 'child', unitId: 'w1', childId: 't_old' });
    assert.equal(r.ok, true);
    assert.equal(r.recovered, true);
    assert.ok(calls.some((c) => c[3] === 't_new'));
  });

  it('O40 Orca가 아닌 unit은 건드리지 않는다', async () => {
    const store = new StateStore();
    store.addUnit(new (await import('../src/core/units.js')).WorkUnit({
      id: 'mock1', source: 'mock', status: Status.RUNNING,
    }));
    const sync = new OrcaSync(store);
    sync.syncOnce((await listWith([], [])).units);
    assert.equal(store.getUnit('mock1').status, Status.RUNNING, 'mock은 그대로');
  });
});

// ───────────────────────── M4.1 — agent state (worktree ps)

describe('M4.1 / agent state 매핑', () => {
  it('A01 권한 승인 대기(waiting)는 WAITING_APPROVAL이다', () => {
    assert.equal(statusOfAgent({ state: 'waiting' }), Status.WAITING_APPROVAL);
  });

  it('A02 working은 RUNNING이다', () => {
    assert.equal(statusOfAgent({ state: 'working' }), Status.RUNNING);
  });

  it('A03 done은 DONE_UNSEEN이다 — 확인 대상이지 개입 대상이 아니다', () => {
    assert.equal(statusOfAgent({ state: 'done' }), Status.DONE_UNSEEN);
    assert.equal(isAttention(Status.DONE_UNSEEN), false);
  });

  it('A04 blocked은 개입 대상으로 본다 (미관측이라 INFERRED)', () => {
    assert.equal(statusOfAgent({ state: 'blocked' }), Status.WAITING_INPUT);
    assert.equal(isAttention(Status.WAITING_INPUT), true);
    assert.equal(confidenceOfAgent({ state: 'blocked' }), Confidence.INFERRED);
  });

  it('A05 관측한 state는 AUTHORITATIVE다 — 에이전트가 스스로 보고한 사실이다', () => {
    for (const state of ['working', 'waiting', 'done']) {
      assert.equal(confidenceOfAgent({ state }), Confidence.AUTHORITATIVE);
    }
  });

  it('A06 중단된 에이전트를 완료라고 하지 않는다', () => {
    assert.equal(statusOfAgent({ state: 'done', interrupted: true }), Status.INTERRUPTED, '중단됨 (2026-10-09)');
    assert.equal(statusOfAgent({ state: 'working', interrupted: true }), Status.INTERRUPTED);
  });

  it('A07 뜻을 모르는 state는 UNKNOWN이다. 추측하지 않는다', () => {
    assert.equal(statusOfAgent({ state: 'zombie' }), Status.UNKNOWN);
    assert.equal(statusOfAgent({}), Status.UNKNOWN);
  });

  it('A08 paneKey는 tabId:leafId로 나뉜다 — focus 경로의 연결 고리', () => {
    assert.deepEqual(
      paneKeyToTabLeaf('715d2924-2062-4d70-ae60-624f8ea3c466:b02bb84c-3eb7-4fc0-bdde-36dfff73adc1'),
      { tabId: '715d2924-2062-4d70-ae60-624f8ea3c466', leafId: 'b02bb84c-3eb7-4fc0-bdde-36dfff73adc1' },
    );
  });

  it('A09 모양이 다른 paneKey는 null이다', () => {
    assert.equal(paneKeyToTabLeaf('nocolon'), null);
    assert.equal(paneKeyToTabLeaf(''), null);
    assert.equal(paneKeyToTabLeaf(null), null);
  });

  it('A10 실측 ps 응답의 모든 state를 안다', () => {
    const states = new Set(
      PS_REAL.worktrees.flatMap((w) => (w.agents ?? []).map((a) => a.state)),
    );
    assert.ok(states.size > 0);
    for (const s of states) {
      assert.notEqual(statusOfAgent({ state: s }), Status.UNKNOWN, `모르는 state: ${s}`);
    }
  });
});

// ───────────────────────── M4.1 — ps 조인 (agent 상태 → child)

const PERM = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'test/fixtures/orca-ps-permission-real.json'), 'utf8'),
);
const SAMPLE_ID = '4104478c-3942-4d09-aeb6-c05b76bd4cc8::<path>';

/** 승인 프롬프트가 떠 있던 실측 순간을 그대로 재현한 어댑터 */
function permAdapter(overrides = {}) {
  const { cli, calls } = fakeCli({
    worktrees: [{
      id: SAMPLE_ID,
      displayName: 'sample-app',
      workspaceStatus: 'in-progress',
      sortOrder: 1,
    }],
    terminals: PERM.terminals,
    ps: PERM,
    ...overrides,
  });
  return { adapter: new OrcaAdapter({ cli }), calls };
}

describe('M4.1 / ps 조인', () => {
  it('J01 승인 대기 에이전트가 붙은 터미널은 WAITING_APPROVAL이다', async () => {
    const { adapter } = permAdapter();
    const { units } = await adapter.list();
    const child = units[0].children.find(
      (c) => c.id === 'term_3b835c19-904d-4ba5-9b27-b95e7d9e7efe',
    );
    assert.equal(child.status, Status.WAITING_APPROVAL);
    assert.equal(child.role, ChildRole.AGENT);
    assert.equal(child.confidence, Confidence.AUTHORITATIVE);
  });

  it('J02 child id는 계속 handle이다 — stale 복구 경로가 그대로 유효하다', async () => {
    const { adapter } = permAdapter();
    const { units } = await adapter.list();
    for (const c of units[0].children) assert.match(c.id, /^term_/);
  });

  it('J03 에이전트가 없는 터미널은 UNKNOWN으로 남는다', async () => {
    const { adapter } = permAdapter();
    const { units } = await adapter.list();
    const plain = units[0].children.find(
      (c) => c.id === 'term_ecffe082-f3d9-44fd-8c25-fe9a61886fbb',
    );
    assert.equal(plain.status, Status.UNKNOWN);
    assert.equal(plain.role, ChildRole.TERMINAL);
  });

  it('J04 완료 판정의 필수 조건은 에이전트 child뿐이다', async () => {
    const { adapter } = permAdapter();
    const { units } = await adapter.list();
    for (const c of units[0].children) {
      assert.equal(c.requiredForCompletion, c.role === ChildRole.AGENT, c.id);
    }
  });

  it('J05 승인 대기가 하나라도 있으면 묶음 상태는 WAITING_APPROVAL이다', async () => {
    const { adapter } = permAdapter();
    const { units } = await adapter.list();
    assert.equal(units[0].status, Status.WAITING_APPROVAL);
  });

  it('J06 하나가 끝나도 다른 에이전트가 돌고 있으면 완료가 아니다', async () => {
    const twoPanes = {
      worktrees: [{
        worktreeId: SAMPLE_ID,
        agents: [
          { paneKey: 'fa978bdc-589d-4c37-8e4c-df1ae8b414b0:b88fbd3b-b547-48b9-817d-a06c19b0d133', state: 'done' },
          { paneKey: '3c181928-ce60-493f-ab27-0e21f9f5e680:c59e8b12-983b-479f-a82f-c46ea6499e7e', state: 'working' },
        ],
      }],
    };
    const { adapter } = permAdapter({ ps: twoPanes });
    const { units } = await adapter.list();
    const byId = Object.fromEntries(units[0].children.map((c) => [c.id, c.status]));
    assert.equal(byId.term_3b835c19_904d_4ba5_9b27_b95e7d9e7efe ?? byId['term_3b835c19-904d-4ba5-9b27-b95e7d9e7efe'], Status.DONE_UNSEEN);
    assert.equal(byId['term_58642b25-4a0e-4103-91b4-42280faa5cc2'], Status.RUNNING);
    assert.equal(units[0].status, Status.RUNNING);
  });

  it('J07 ps를 읽지 못해도 목록은 만들어진다 — 상태만 모르는 것이다', async () => {
    const { adapter } = permAdapter({ ps: new Error('ps 실패') });
    const { units, notesKo } = await adapter.list();
    assert.equal(units.length, 1);
    for (const c of units[0].children) assert.equal(c.status, Status.UNKNOWN);
    assert.ok(notesKo.some((n) => n.includes('에이전트 상태')));
  });

  it('J08 뜻을 모르는 agent state는 모아 두고 추측하지 않는다', async () => {
    const odd = {
      worktrees: [{
        worktreeId: SAMPLE_ID,
        agents: [{ paneKey: 'fa978bdc-589d-4c37-8e4c-df1ae8b414b0:b88fbd3b-b547-48b9-817d-a06c19b0d133', state: 'zombie' }],
      }],
    };
    const { adapter } = permAdapter({ ps: odd });
    const { units, notesKo } = await adapter.list();
    const child = units[0].children.find((c) => c.id === 'term_3b835c19-904d-4ba5-9b27-b95e7d9e7efe');
    assert.equal(child.status, Status.UNKNOWN);
    assert.ok([...adapter.unknownAgentStates].includes('zombie'));
    assert.ok(notesKo.some((n) => n.includes('zombie')));
  });

  it('J09 ps를 읽었으면 "연결점이 없다"고 말하지 않는다', async () => {
    const { adapter } = permAdapter();
    const { notesKo } = await adapter.list();
    assert.ok(!notesKo.some((n) => n.includes('연결점이 없어')));
  });

  it('J10 ps도 읽기 허용 목록 안에 있다', () => {
    assert.ok(isAllowed(READ_COMMANDS.worktreePs));
  });

  it('J11 list()는 색인에 쓸 터미널 원본을 함께 준다 — 같은 것을 두 번 읽지 않는다', async () => {
    const { adapter, calls } = permAdapter();
    const { terminals } = await adapter.list();
    assert.deepEqual(terminals, PERM.terminals);
    assert.equal(calls.filter((c) => c.slice(0, 2).join(' ') === 'terminal list').length, 1);
  });
});

// ───────────────────────── M4.2 — 연속 승인 (같은 상태로 머무는 새 이벤트)

describe('M4.2 / 연속 승인', () => {
  const PANE = 'tabA:leafA';
  const HANDLE = 'term_A';
  const WT = 'wt1::<path>';

  function stack() {
    const agent = { paneKey: PANE, state: 'working', stateStartedAt: 1000 };
    const { cli } = fakeCli({
      worktrees: [{ id: WT, displayName: 'sample-app', workspaceStatus: 'in-progress', sortOrder: 1 }],
      terminals: [{
        handle: HANDLE, worktreeId: WT, tabId: 'tabA', leafId: 'leafA', title: 'codex',
        connected: true, orphaned: false, lastOutputAt: 1, agentIdentity: 'codex',
      }],
      ps: { worktrees: [{ worktreeId: WT, agents: [agent] }] },
    });
    const adapter = new OrcaAdapter({ cli });
    const store = new StateStore();
    const sync = new OrcaSync(store);
    const tick = async (state, stateStartedAt) => {
      Object.assign(agent, { state, stateStartedAt });
      const { units } = await adapter.list();
      return sync.syncOnce(units);
    };
    return { store, tick };
  }

  it('S01 승인이 연달아 오면 상태 값이 같아도 새 이벤트로 본다', async () => {
    const { tick } = stack();
    await tick('working', 1000);
    const first = await tick('waiting', 2000);
    assert.equal(first.updatedChildren, 1, '첫 승인');
    // 중간 working을 폴링이 놓친 경우 — 값은 그대로 waiting이지만 새 승인이다
    const second = await tick('waiting', 5000);
    assert.equal(second.updatedChildren, 1, '두 번째 승인도 변화로 보여야 한다');
  });

  it('S02 대기 시각은 에이전트가 보고한 상태 진입 시각이다', async () => {
    const { store, tick } = stack();
    await tick('waiting', 2000);
    assert.equal(store.getUnit(WT).child(HANDLE).waitingSince, 2000);
    await tick('waiting', 5000);
    assert.equal(
      store.getUnit(WT).child(HANDLE).waitingSince, 5000,
      '새 승인은 대기 시각이 갱신되어야 개입 순서가 맞는다',
    );
  });

  it('S03 정말 아무것도 안 바뀌면 변화가 아니다', async () => {
    const { tick } = stack();
    await tick('waiting', 2000);
    const again = await tick('waiting', 2000);
    assert.equal(again.updatedChildren, 0);
  });

  it('S04 개입 상태가 아니면 대기 시각을 갖지 않는다', async () => {
    const { store, tick } = stack();
    await tick('waiting', 2000);
    await tick('working', 3000);
    assert.equal(store.getUnit(WT).child(HANDLE).waitingSince, 0);
  });
});

// ───────────────────────── M4.3 — worktree 단위 상태 (ps의 status)

describe('M4.3 / worktree status', () => {
  const WT = 'wt1::<path>';
  const HANDLE = 'term_A';

  function stack(wtStatus, agentState = 'done') {
    const { cli } = fakeCli({
      worktrees: [{ id: WT, displayName: 'sample-app', workspaceStatus: 'in-progress', sortOrder: 1 }],
      terminals: [{
        handle: HANDLE, worktreeId: WT, tabId: 'tabA', leafId: 'leafA', title: 'codex',
        connected: true, orphaned: false, lastOutputAt: 1, agentIdentity: 'codex',
      }],
      ps: {
        worktrees: [{
          worktreeId: WT,
          status: wtStatus,
          agents: [{ paneKey: 'tabA:leafA', state: agentState, stateStartedAt: 5000 }],
        }],
      },
    });
    return new OrcaAdapter({ cli });
  }

  it('W01 거절로 멈춘 묶음은 답변 필요다 — 완료가 아니다', async () => {
    const { units } = await stack('interrupted').list();
    assert.equal(units[0].status, Status.WAITING_INPUT);
  });

  it('W02 거절은 오류가 아니다 — 진짜 실패와 구분한다', async () => {
    const { units } = await stack('interrupted').list();
    assert.notEqual(units[0].status, Status.ERROR);
  });

  it('W03 거절된 묶음은 개입 대기 시각을 갖는다', async () => {
    const { units } = await stack('interrupted').list();
    assert.ok(units[0].ownWaitingSince > 0, '깜빡으로 알리려면 시각이 있어야 한다');
  });

  it('W04 평범한 묶음 상태는 child 판정을 덮지 않는다', async () => {
    const { units } = await stack('working', 'waiting').list();
    assert.equal(units[0].status, Status.WAITING_APPROVAL, 'child의 승인 대기가 살아 있어야 한다');
  });

  it('W05b inactive 묶음은 대기(IDLE)다 — 진행 중도, 개입 대상도 아니다', async () => {
    const { units } = await stack('inactive', 'done').list();
    // 에이전트 child(done)가 있으면 그것이 우선 — 완료·미확인
    assert.equal(units[0].status, Status.DONE_UNSEEN);
    const { cli } = fakeCli({
      worktrees: [{ id: WT, displayName: 'idle', workspaceStatus: 'in-progress', sortOrder: 1 }],
      terminals: [],
      ps: { worktrees: [{ worktreeId: WT, status: 'inactive', agents: [] }] },
    });
    const bareList = await new OrcaAdapter({ cli }).list();
    assert.deepEqual(bareList.units, [], '터미널도 에이전트도 없는 대기 묶음은 사이드바처럼 슬롯을 받지 않는다 (2026-09-30)');
    assert.deepEqual(bareList.hiddenIds, [WT]);
    assert.equal(isAttention(Status.IDLE), false);
    const { cli: cli2 } = fakeCli({
      worktrees: [{ id: WT, displayName: 'idle', workspaceStatus: 'in-progress', sortOrder: 1 }],
      terminals: [{ handle: 'sh', worktreeId: WT, tabId: 't', leafId: 'l', title: 'zsh', connected: true, orphaned: false, lastOutputAt: 1 }],
      ps: { worktrees: [{ worktreeId: WT, status: 'inactive', agents: [] }] },
    });
    const withShell = (await new OrcaAdapter({ cli: cli2 }).list()).units[0];
    assert.equal(withShell.status, Status.IDLE, '셸 탭만 있고 Orca가 inactive라 하면 대기다');
  });

  it('W08 중단(interrupted)이 풀리면 다음 폴링에 답변 필요가 사라진다 — 빨강에 멈추지 않는다', async () => {
    const store = new StateStore();
    const sync = new OrcaSync(store);
    sync.syncOnce((await stack('interrupted').list()).units);
    assert.equal(store.getUnit(WT).status, Status.WAITING_INPUT);
    // 에이전트를 끈 뒤 Orca는 active를 준다 — 묶음 자체의 사실이 없어졌다
    sync.syncOnce((await stack('active').list()).units);
    assert.equal(store.getUnit(WT).ownStatus, null);
    assert.equal(store.getUnit(WT).status, Status.DONE_UNSEEN);
  });

  it('W05 done 묶음은 그대로 완료다', async () => {
    const { units } = await stack('done').list();
    assert.equal(units[0].status, Status.DONE_UNSEEN);
  });

  it('W06 뜻을 모르는 묶음 상태는 모아 두고 추측하지 않는다', async () => {
    const adapter = stack('teleporting');
    const { units, notesKo } = await adapter.list();
    assert.equal(units[0].status, Status.DONE_UNSEEN, 'child가 말한 것을 버리지 않는다');
    assert.ok([...adapter.unknownPsStatuses].includes('teleporting'));
    assert.ok(notesKo.some((n) => n.includes('teleporting')));
  });

  it('W07 ps를 못 읽으면 ps에서 온 상태를 덧붙이지 않는다', async () => {
    const { cli } = fakeCli({
      worktrees: [{ id: WT, displayName: 'sample-app', workspaceStatus: 'in-progress', sortOrder: 1 }],
      terminals: [],
      ps: new Error('실패'),
    });
    const { units } = await new OrcaAdapter({ cli }).list();
    // ps가 없으면 에이전트 사실이 없다. workspaceStatus는 칸반 열이라 상태가 아니므로 '모름'이다 (2026-09-29)
    assert.equal(units[0].status, Status.UNKNOWN);
    assert.equal(units[0].ownWaitingSince, 0);
  });
});

describe('M4.4 / 같은 이름의 worktree', () => {
  it('J12 이름이 겹치면 저장소 이름을 붙여 구분한다 — 안 겹치면 그대로', async () => {
    const { cli } = fakeCli({
      worktrees: [
        { id: 'r1::a', displayName: 'master', workspaceStatus: 'in-progress', sortOrder: 1 },
        { id: 'r2::b', displayName: 'master', workspaceStatus: 'in-progress', sortOrder: 2 },
        { id: 'r3::c', displayName: 'sample-app', workspaceStatus: 'in-progress', sortOrder: 3 },
      ],
      terminals: [],
      ps: { worktrees: [
        { worktreeId: 'r1::a', repo: 'workspace', agents: [] },
        { worktreeId: 'r2::b', repo: 'sample-cron', agents: [] },
        { worktreeId: 'r3::c', repo: 'workspace', agents: [] },
      ] },
    });
    const { units } = await new OrcaAdapter({ cli }).list();
    assert.deepEqual(units.map((u) => u.title), ['workspace · master', 'sample-cron · master', 'sample-app']);
  });
});

describe('M4.4 / 이름 갱신', () => {
  it('J13 이미 슬롯에 있는 작업도 Orca의 새 이름을 따른다 — 자리는 그대로', () => {
    const store = new StateStore();
    const sync = new OrcaSync(store);
    const mk = (title) => new WorkUnit({ id: 'w', title, source: 'orca', status: Status.RUNNING });
    sync.syncOnce([mk('master')]);
    const idx = store.globalSlots.globalIndexOf('w');
    const d = sync.syncOnce([mk('workspace · master')]);
    assert.equal(store.getUnit('w').title, 'workspace · master');
    assert.equal(store.globalSlots.globalIndexOf('w'), idx);
    assert.equal(d.renamed, 1);
  });
});
