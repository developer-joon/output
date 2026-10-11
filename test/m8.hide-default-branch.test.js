/**
 * M8 — Orca "기본 브랜치 숨기기"를 따른다 (2026-09-29).
 * 본 체크아웃(isMainWorktree)은 Orca가 숨기면 슬롯을 받지 않고, 이미 있던 자리는 비운다.
 * 자리가 비면(숨김·반납·복원) 빈 자리를 자동으로 앞으로 당긴다. 상대 순서는 지킨다 (사용자 결정 2026-09-29).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { OrcaCli } from '../src/adapters/orca/orcaCli.js';
import { OrcaAdapter, toChildUnit, toWorkUnit } from '../src/adapters/orca/orcaAdapter.js';
import { orphanedStatus } from '../src/adapters/orca/agentState.js';
import { OrcaSync } from '../src/adapters/orca/orcaSync.js';
import { OrcaSettings } from '../src/adapters/orca/orcaSettings.js';
import { StateStore } from '../src/core/stateStore.js';
import { WorkUnit, ChildUnit } from '../src/core/units.js';
import { Status, isAttention } from '../src/core/types.js';
import { Events } from '../src/core/eventBus.js';

function tmpDb(uiPayload) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-settings-'));
  const file = path.join(dir, 'profile-state.db');
  if (uiPayload !== undefined) {
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE profile_state_documents (
      domain TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL,
      domain_version INTEGER NOT NULL, revision INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, content_hash TEXT NOT NULL)`);
    db.prepare('INSERT INTO profile_state_documents VALUES (?,?,?,?,?,?)')
      .run('ui', typeof uiPayload === 'string' ? uiPayload : JSON.stringify(uiPayload), 1, 1, Date.now(), 'x');
    db.close();
  }
  return file;
}

function fakeCli({ worktrees = [], terminals = [], ps = { worktrees: [] } } = {}) {
  return new OrcaCli({
    runner: async (_bin, argv) => {
      const cmd = argv.slice(0, 2).join(' ');
      if (cmd === 'worktree list') return JSON.stringify({ ok: true, result: { worktrees } });
      if (cmd === 'terminal list') return JSON.stringify({ ok: true, result: { terminals } });
      if (cmd === 'worktree ps') return JSON.stringify({ ok: true, result: ps });
      if (argv[0] === 'status') return JSON.stringify({ ok: true, result: { app: { running: true }, runtime: { state: 'ready', reachable: true, appVersion: 'test' } } });
      return JSON.stringify({ ok: true, result: {} });
    },
  });
}

const wt = (id, extra = {}) => ({ id, displayName: id, workspaceStatus: 'in-progress', sortOrder: 1, isArchived: false, isMainWorktree: false, ...extra });
const term = (handle, worktreeId) => ({ handle, worktreeId, tabId: `tab-${handle}`, leafId: `leaf-${handle}`, connected: true, orphaned: false, title: handle, lastOutputAt: 1 });

describe('M8 / OrcaSettings — Orca 설정 파일 읽기', () => {
  it('H01 hideDefaultBranchWorkspace를 읽는다', () => {
    const s = new OrcaSettings({ dbPath: tmpDb({ hideDefaultBranchWorkspace: true }) });
    assert.deepEqual(s.read(), { hideDefaultBranch: true, repoOrder: null, agentAcks: {}, warningKo: null });
    const off = new OrcaSettings({ dbPath: tmpDb({ hideDefaultBranchWorkspace: false }) });
    assert.equal(off.read().hideDefaultBranch, false);
  });

  it('H02 파일이 없으면 모른다고 하고 경고를 준다', () => {
    const r = new OrcaSettings({ dbPath: tmpDb(undefined) }).read();
    assert.equal(r.hideDefaultBranch, null);
    assert.match(r.warningKo, /설정을 읽지 못했/);
  });

  it('H03 키가 없거나 JSON이 깨져도 모른다고 한다', () => {
    assert.equal(new OrcaSettings({ dbPath: tmpDb({}) }).read().hideDefaultBranch, null);
    const bad = new OrcaSettings({ dbPath: tmpDb('{not json') }).read();
    assert.equal(bad.hideDefaultBranch, null);
    assert.ok(bad.warningKo);
  });

  it('H04 파일을 쓰지 않는다 (읽기 전용)', () => {
    const file = tmpDb({ hideDefaultBranchWorkspace: true });
    const before = fs.statSync(file).mtimeMs;
    new OrcaSettings({ dbPath: file }).read();
    assert.equal(fs.statSync(file).mtimeMs, before);
  });
});

describe('M8 / OrcaAdapter — 본 체크아웃 제외', () => {
  const list = (hide, extra = {}) => new OrcaAdapter({
    cli: fakeCli({ worktrees: [wt('main', { isMainWorktree: true, branch: 'refs/heads/master' }), wt('feat')], terminals: [term('t1', 'main'), term('t2', 'feat')], ...extra }),
    settings: { read: () => ({ hideDefaultBranch: hide, warningKo: hide === null ? '설정을 읽지 못했습니다.' : null }) },
  }).list();

  it('H05 숨김이 켜지면 isMainWorktree는 목록에서 빠지고 hiddenIds로 보고한다', async () => {
    const r = await list(true);
    assert.deepEqual(r.units.map((u) => u.id), ['feat']);
    assert.deepEqual(r.hiddenIds, ['main']);
  });

  it('H05b Orca와 같은 판정: 브랜치 없는 본 체크아웃과 provisioned-root는 숨기지 않는다', async () => {
    // Orca 1.4.215 필터: isMainWorktree && mode !== 'provisioned-root' && branch.trim() !== ''
    const r = await list(true, {
      worktrees: [
        wt('main', { isMainWorktree: true, branch: 'refs/heads/master' }),
        wt('detached', { isMainWorktree: true, branch: '' }),
        wt('vm', { isMainWorktree: true, branch: 'refs/heads/master', ephemeralVmCheckoutMode: 'provisioned-root' }),
        wt('feat', { branch: 'refs/heads/feat' }),
      ],
      terminals: [],
    });
    assert.deepEqual(r.units.map((u) => u.id).sort(), ['detached', 'feat', 'vm']);
    assert.deepEqual(r.hiddenIds, ['main']);
  });

  it('H06 숨김이 꺼지면 그대로 넣는다', async () => {
    const r = await list(false);
    assert.deepEqual(r.units.map((u) => u.id).sort(), ['feat', 'main']);
    assert.deepEqual(r.hiddenIds, []);
  });

  it('H07 설정을 모르면 숨기지 않고 경고를 남긴다', async () => {
    const r = await list(null);
    assert.deepEqual(r.units.map((u) => u.id).sort(), ['feat', 'main']);
    assert.ok(r.notesKo.some((n) => /설정을 읽지 못했/.test(n)));
  });

  it('H08 설정 없이 만든 어댑터는 예전처럼 동작한다', async () => {
    const r = await new OrcaAdapter({ cli: fakeCli({ worktrees: [wt('main', { isMainWorktree: true, branch: 'refs/heads/master' })] }) }).list();
    assert.deepEqual(r.units.map((u) => u.id), ['main']);
    assert.deepEqual(r.hiddenIds, []);
  });
});

describe('M8 / OrcaSync — 숨긴 작업은 자리를 비운다', () => {
  it('H09 hiddenIds에 든 기존 작업은 정책과 무관하게 자리를 반납한다', () => {
    const store = new StateStore();
    store.addUnit(new WorkUnit({ id: 'main', title: 'master', source: 'orca', kind: 'worktree', children: [new ChildUnit({ id: 't', title: 't', status: Status.RUNNING })] }));
    store.addUnit(new WorkUnit({ id: 'feat', title: 'feat', source: 'orca', kind: 'worktree' }));
    assert.equal(store.canRelease('main'), false, '실행 중이라 일반 정책으로는 반납 불가');
    const d = new OrcaSync(store).syncOnce([store.getUnit('feat')], { hiddenIds: ['main'] });
    assert.deepEqual(d.hidden, ['main']);
    assert.equal(store.getUnit('main'), null);
    assert.deepEqual(store.globalSlots.positionOf('feat'), { bank: 0, slot: 0 }, '빈 자리는 자동으로 당겨진다');
    assert.equal(store.globalSlots.isOccupied(1), false);
  });

  it('H10 숨긴 것은 관측 끊김으로 표시하지 않는다', () => {
    const store = new StateStore();
    store.addUnit(new WorkUnit({ id: 'main', title: 'master', source: 'orca', kind: 'worktree' }));
    const d = new OrcaSync(store).syncOnce([], { hiddenIds: ['main'] });
    assert.deepEqual(d.vanished, []);
    assert.deepEqual(d.hidden, ['main']);
  });

  it('H11 없는 id는 무시한다', () => {
    const store = new StateStore();
    const d = new OrcaSync(store).syncOnce([], { hiddenIds: ['ghost'] });
    assert.deepEqual(d.hidden, []);
  });
});

describe('M8 / StateStore.compactSlots — 빈 자리 당기기', () => {
  it('H12 순서를 지키며 빈 자리를 앞으로 당긴다', () => {
    const store = new StateStore();
    store.addUnit(new WorkUnit({ id: 'a', title: 'a', source: 'orca', kind: 'worktree' }), { atGlobalIndex: 5 });
    store.addUnit(new WorkUnit({ id: 'b', title: 'b', source: 'orca', kind: 'worktree' }), { atGlobalIndex: 6 });
    store.addUnit(new WorkUnit({ id: 'c', title: 'c', source: 'orca', kind: 'worktree' }), { atGlobalIndex: 11 });
    const commits = [];
    store.bus.on(Events.COMMITTED, (e) => commits.push(e.reason));
    const moved = store.compactSlots();
    assert.equal(moved, 3);
    assert.deepEqual(store.globalSlots.positionOf('a'), { bank: 0, slot: 0 });
    assert.deepEqual(store.globalSlots.positionOf('b'), { bank: 0, slot: 1 });
    assert.deepEqual(store.globalSlots.positionOf('c'), { bank: 0, slot: 2 });
    assert.equal(store.globalSlots.bankCount, 1);
    assert.deepEqual(commits, ['slots:compacted']);
  });

  it('H13 이미 붙어 있으면 아무것도 바꾸지 않는다', () => {
    const store = new StateStore();
    store.addUnit(new WorkUnit({ id: 'a', title: 'a', source: 'orca', kind: 'worktree' }));
    const commits = [];
    store.bus.on(Events.COMMITTED, (e) => commits.push(e.reason));
    assert.equal(store.compactSlots(), 0);
    assert.deepEqual(commits, []);
  });

  it('H14 상세 자리(child slot)는 건드리지 않는다', () => {
    const store = new StateStore();
    store.addUnit(new WorkUnit({ id: 'a', title: 'a', source: 'orca', kind: 'worktree', children: [new ChildUnit({ id: 'x', title: 'x' }), new ChildUnit({ id: 'y', title: 'y' })] }), { atGlobalIndex: 7 });
    const before = store.detailSlots('a').positionOf('y');
    store.compactSlots();
    assert.deepEqual(store.detailSlots('a').positionOf('y'), before);
  });
});

describe('M8 / 자동 정리 — 자리가 비면 바로 당긴다', () => {
  it('H17 정책 반납(releaseUnit)으로 자리가 비어도 당긴다', () => {
    const store = new StateStore({ now: () => 1_000_000 });
    store.addUnit(new WorkUnit({ id: 'a', title: 'a', source: 'orca', kind: 'worktree', status: Status.DONE_SEEN }));
    store.addUnit(new WorkUnit({ id: 'b', title: 'b', source: 'orca', kind: 'worktree' }));
    store.addUnit(new WorkUnit({ id: 'c', title: 'c', source: 'orca', kind: 'worktree' }));
    assert.equal(store.releaseUnit('a', { now: 1_000_000, graceMs: 0 }), true);
    assert.deepEqual(['b', 'c'].map((id) => store.globalSlots.globalIndexOf(id)), [0, 1]);
  });

  it('H18 저장 파일에 빈칸이 있어도 복원 직후 당겨진다', async () => {
    const { createPersistence } = await import('../src/adapters/persistence/index.js');
    const { writeJsonAtomic } = await import('../src/adapters/persistence/fileStore.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-restore-'));
    const slot = (id, globalIndex) => ({ id, globalIndex, title: id, source: 'orca', kind: 'worktree', pinned: false });
    writeJsonAtomic(path.join(dir, 'state.json'), { version: 1, savedAt: 1, slots: [slot('x', 5), slot('y', 6), slot('z', 12)], acks: [] });
    const store = new StateStore();
    const { adapter } = createPersistence({ store, dir });
    assert.deepEqual(adapter.restore().restored, ['x', 'y', 'z']);
    assert.deepEqual(['x', 'y', 'z'].map((id) => store.globalSlots.globalIndexOf(id)), [0, 1, 2], '순서는 지키고 빈칸만 없앤다');
    assert.equal(store.globalSlots.bankCount, 1);
  });

  it('H16 서비스는 Orca 필터로 숨긴 작업의 자리를 비우고 기록을 남긴다', async () => {
    const { OutputService } = await import('../src/service/outputService.js');
    const { UNCALIBRATED } = await import('../src/device/calibrationLoader.js');
    let hide = true;
    const svc = new OutputService({
      calibration: UNCALIBRATED,
      stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cb-svc-')),
      openRuntimeTransport: async () => { const e = new Error('x'); e.code = 'DEVICE_NOT_FOUND'; throw e; },
      orcaCli: fakeCli({ worktrees: [wt('main', { isMainWorktree: true, branch: 'refs/heads/master' }), wt('feat')], terminals: [term('t2', 'feat')] }),
      orcaSettings: { read: () => ({ hideDefaultBranch: hide, warningKo: null }) },
      persist: false,
      timers: { setInterval: () => ({}), clearInterval: () => {} },
    });
    await svc.start();
    assert.deepEqual(svc.store.allUnits().map((u) => u.id), ['feat'], '본 체크아웃은 자리를 받지 않는다');
    hide = false;
    svc._orcaAt = -Infinity;   // 다음 확인 때가 됐다 (2026-10-11: Orca 레이어가 아니면 6초마다)
    await svc.refreshOrca();
    assert.deepEqual(svc.store.allUnits().map((u) => u.id).sort(), ['feat', 'main'], '필터를 끄면 다시 들어온다');
    hide = true;
    svc._orcaAt = -Infinity;
    await svc.refreshOrca();
    assert.deepEqual(svc.store.allUnits().map((u) => u.id), ['feat']);
    assert.deepEqual(svc.store.globalSlots.positionOf('feat'), { bank: 0, slot: 0 }, '숨긴 뒤 빈 자리는 자동으로 당겨진다');
    assert.ok(svc.logs.some((l) => /기본 브랜치 숨기기.*1개/.test(l.messageKo ?? l)), JSON.stringify(svc.logs.slice(-3)));
    await svc.stop();
  });
});

describe('M8 / IDLE — 에이전트 없는 worktree는 대기', () => {
  it('H19 라벨·조명·화면색: 대기는 회색이고 급함 순서에서 완료·확인함 다음이다', async () => {
    const { StatusLabelKo, statusRank, isAttention, TERMINAL_STATUSES } = await import('../src/core/types.js');
    const { threadStyleFor, ambientStyleFor } = await import('../src/core/lightingPolicy.js');
    const { colorOf, COLOR_HEX } = await import('../src/service/uiModel.js');
    assert.equal(Status.IDLE, 'IDLE');
    assert.equal(StatusLabelKo[Status.IDLE], '대기');
    assert.ok(statusRank(Status.IDLE) > statusRank(Status.DONE_SEEN));
    assert.ok(statusRank(Status.IDLE) < statusRank(Status.EMPTY));
    assert.equal(isAttention(Status.IDLE), false);
    assert.equal(TERMINAL_STATUSES.includes(Status.IDLE), false, '대기는 끝난 것이 아니라 자리를 지킨다');
    assert.deepEqual(threadStyleFor(Status.IDLE), { color: 'dim_white', brightness: 0.18, pattern: 'solid' });
    assert.equal(ambientStyleFor(Status.IDLE).color, 'green', '대기는 언더글로우를 바꾸지 않는다 — 평온(초록) 그대로');
    assert.equal(colorOf(Status.IDLE), COLOR_HEX.dim_white);
  });
});

describe('M8 / orphaned 탭 — 마지막 보고가 done이면 완료, 아니면 STALE', () => {
  const dead = (handle = 'h') => ({ handle, worktreeId: 'w', tabId: 'pty:x', leafId: 'pty:x', connected: true, orphaned: true, title: null, lastOutputAt: null });
  const done = { paneKey: 'old:pane', state: 'done', interrupted: false, stateStartedAt: 5 };
  const working = { paneKey: 'old:pane', state: 'working', interrupted: false, stateStartedAt: 5 };

  it('H20 orphanedStatus: 에이전트가 done이면 완료·미확인, 그 밖은 STALE', () => {
    assert.equal(orphanedStatus(done, null), Status.DONE_UNSEEN);
    assert.equal(orphanedStatus(working, null), Status.STALE);
    assert.equal(orphanedStatus({ ...done, interrupted: true }, null), Status.STALE);
    assert.equal(orphanedStatus(null, { agents: [done, done] }), Status.DONE_UNSEEN, 'paneKey 조인이 끊겨도 묶음의 보고가 전부 done이면 완료');
    assert.equal(orphanedStatus(null, { agents: [done, working] }), Status.STALE);
    assert.equal(orphanedStatus(null, { agents: [] }), Status.STALE);
    assert.equal(orphanedStatus(null, null), Status.STALE);
  });

  it('H21 Orca 재시작 후(탭 orphaned, paneKey 불일치) done 묶음은 완료·미확인이고 개입 대상이 아니다', () => {
    const u = toWorkUnit({ id: 'w', displayName: 'W' }, [dead()], new Map(), { worktreeId: 'w', status: 'active', agents: [done] });
    assert.equal(u.status, Status.DONE_UNSEEN);
    assert.equal(isAttention(u.status), false);
    assert.equal(u.children[0].confidence, 'inferred', '조인이 끊긴 추정이다');
  });

  it('H22 orphaned인데 마지막 보고가 working이면 여전히 STALE', () => {
    const u = toWorkUnit({ id: 'w', displayName: 'W' }, [dead()], new Map(), { worktreeId: 'w', status: 'active', agents: [working] });
    assert.equal(u.status, Status.STALE);
  });

  it('H23 조인된 에이전트가 done인 orphaned 탭도 완료·미확인', () => {
    assert.equal(toChildUnit(dead(), done, null).status, Status.DONE_UNSEEN);
    assert.equal(toChildUnit(dead(), working, null).status, Status.STALE);
    assert.equal(toChildUnit(dead(), null, null).status, Status.STALE, '보고가 없으면 예전처럼 STALE');
  });
});

describe('M8 / Orca 사이드바 순서로 배치', () => {
  it('H24 OrcaSettings는 수동 프로젝트 순서(repoId 목록)를 읽는다', () => {
    const s = new OrcaSettings({ dbPath: tmpDb({ hideDefaultBranchWorkspace: true, projectOrderBy: 'manual', manualRepoOrder: [{ hostId: 'local', repoId: 'r2' }, { hostId: 'local', repoId: 'r1' }] }) });
    assert.deepEqual(s.read().repoOrder, ['r2', 'r1']);
    const auto = new OrcaSettings({ dbPath: tmpDb({ projectOrderBy: 'recent', manualRepoOrder: [{ repoId: 'r2' }] }) });
    assert.equal(auto.read().repoOrder, null, '수동 순서가 아니면 쓰지 않는다');
  });

  const W = (id, repoId, sortOrder, extra = {}) => ({ id, displayName: id, repoId, sortOrder, isArchived: false, isMainWorktree: false, branch: `refs/heads/${id}`, ...extra });
  const ps = (ids) => ({ worktrees: ids.map(([id, status, agents = []]) => ({ worktreeId: id, status, agents })) });

  it('H25 list().order: 프로젝트 수동 순서 → 프로젝트 안 최근 생성순', async () => {
    const adapter = new OrcaAdapter({
      cli: fakeCli({
        worktrees: [W('a-old', 'r1', 1), W('a-new', 'r1', 5), W('b', 'r2', 3), W('c', 'r3', 9)],
        terminals: [term('t1', 'a-old'), term('t2', 'a-new'), term('t3', 'b'), term('t4', 'c')],
      }),
      settings: { read: () => ({ hideDefaultBranch: false, repoOrder: ['r2', 'r1'], warningKo: null }) },
    });
    const r = await adapter.list();
    assert.deepEqual(r.order, ['b', 'a-new', 'a-old', 'c'], '목록에 없는 프로젝트는 뒤로');
  });

  it('H26 에이전트도 터미널도 없고 Orca가 inactive라 한 worktree는 사이드바처럼 뺀다', async () => {
    const adapter = new OrcaAdapter({
      cli: fakeCli({
        worktrees: [W('live', 'r1', 2), W('sleep', 'r1', 1)],
        terminals: [term('t1', 'live')],
        ps: ps([['live', 'active'], ['sleep', 'inactive']]),
      }),
      settings: { read: () => ({ hideDefaultBranch: false, repoOrder: null, warningKo: null }) },
    });
    const r = await adapter.list();
    assert.deepEqual(r.units.map((u) => u.id), ['live']);
    assert.ok(r.hiddenIds.includes('sleep'));
  });

  it('H27 syncOnce(order)는 슬롯을 그 순서로 다시 배치한다', () => {
    const store = new StateStore();
    for (const id of ['x', 'y', 'z']) store.addUnit(new WorkUnit({ id, title: id, source: 'orca', kind: 'worktree' }));
    const sync = new OrcaSync(store);
    const units = ['x', 'y', 'z'].map((id) => store.getUnit(id));
    sync.syncOnce(units, { order: ['z', 'x', 'y'] });
    assert.deepEqual(['z', 'x', 'y'].map((id) => store.globalSlots.globalIndexOf(id)), [0, 1, 2]);
    const commits = [];
    store.bus.on(Events.COMMITTED, (e) => commits.push(e.reason));
    sync.syncOnce(units, { order: ['z', 'x', 'y'] });
    assert.ok(!commits.includes('slots:arranged'), '같은 순서면 다시 커밋하지 않는다');
  });
});

describe('M8 / Orca 색 맞춤 (사용자 결정 2026-09-30)', () => {
  it('H28 섞은 팔레트 (2026-10-01, 움직임 2026-10-10): 진행 중=호박 숨쉬기, 승인=주황 빠른 숨쉬기, 답변=살구 빠른 숨쉬기, 오류=빨강 빠른 깜박임', async () => {
    const { threadStyleFor } = await import('../src/core/lightingPolicy.js');
    const { colorOf, COLOR_HEX } = await import('../src/service/uiModel.js');
    assert.deepEqual(threadStyleFor(Status.RUNNING), { color: 'amber', brightness: 0.96, pattern: 'breathing' });
    assert.equal(threadStyleFor(Status.WAITING_APPROVAL).color, 'orange');
    assert.equal(threadStyleFor(Status.WAITING_APPROVAL).pattern, 'breathing_fast');
    assert.equal(threadStyleFor(Status.WAITING_INPUT).color, 'apricot');
    assert.equal(threadStyleFor(Status.WAITING_INPUT).pattern, 'breathing_fast');
    assert.equal(threadStyleFor(Status.ERROR).pattern, 'blink_fast');
    const colors = [Status.RUNNING, Status.WAITING_APPROVAL, Status.WAITING_INPUT, Status.ERROR, Status.DONE_UNSEEN, Status.DONE_SEEN].map((s) => threadStyleFor(s).color);
    assert.equal(new Set(colors).size, colors.length, '상태마다 색이 다르다');
    assert.ok(COLOR_HEX.apricot, '살구 화면색');
    assert.equal(colorOf(Status.RUNNING), COLOR_HEX.amber);
  });

});

describe('M8 / 언더글로우 = 메뉴바 점 규칙 (사용자 결정 2026-09-30)', () => {
  const out = async (statuses) => {
    const { Output } = await import('../src/output.js');
    const store = new StateStore();
    statuses.forEach((s, i) => store.addUnit(new WorkUnit({ id: `u${i}`, title: `u${i}`, source: 'orca', kind: 'worktree', status: s })));
    const o = new Output({ store, sourceName: 'Orca' });
    o.setActive(true);
    return o.render();
  };

  it('H29 개입이 있으면 진행 중·완료보다 앞선다 — 색은 종류마다: 오류 빨강 깜박임, 승인 주황·답변 살구 빠른 숨쉬기, 상태 모름 보라 (2026-10-10)', async () => {
    const want = { [Status.ERROR]: ['red', 'blink_fast'], [Status.WAITING_APPROVAL]: ['orange', 'breathing_fast'], [Status.WAITING_INPUT]: ['apricot', 'breathing_fast'],
      [Status.STALE]: ['purple', 'breathing_slow'], [Status.DISCONNECTED]: ['purple', 'breathing_slow'] };
    for (const [s, w] of Object.entries(want)) {
      const z = (await out([s, Status.RUNNING, Status.DONE_UNSEEN])).lighting.ambientZone;
      assert.deepEqual([z.color, z.pattern], w, s);
    }
  });

  it('H30 개입이 없고 진행 중이 있으면 호박 회전, 완료·미확인만 있으면 청록, 그 밖엔 초록 느린 숨쉬기 (2026-10-02, 움직임 2026-10-10)', async () => {
    assert.deepEqual((await out([Status.RUNNING, Status.DONE_UNSEEN])).lighting.ambientZone, { color: 'amber', brightness: 1, pattern: 'rotate' });
    assert.equal((await out([Status.DONE_UNSEEN, Status.IDLE])).lighting.ambientZone.color, 'teal');
    assert.deepEqual((await out([Status.IDLE, Status.DONE_SEEN])).lighting.ambientZone, { color: 'green', brightness: 1, pattern: 'breathing_slow' }, '평온은 메뉴바처럼 초록 (2026-10-02), 느린 숨쉬기 (2026-10-10), 밝기 100% (2026-10-11)');
    assert.equal((await out([])).lighting.ambientZone.color, 'green');
  });

  it('H31 보이지 않는 묶음의 진행 중도 센다', async () => {
    const snap = await out([...Array(6).fill(Status.IDLE), Status.RUNNING]);
    assert.equal(snap.lighting.ambientZone.color, 'amber');
  });
});

describe('M8 / 언더글로우 밝기 — 낮에도 보이게 (사용자 요청 2026-09-30)', () => {
  it('H32 개입 1.0 · 진행 중 0.8 · 완료·미확인 0.6', async () => {
    const { ambientStyleFor } = await import('../src/core/lightingPolicy.js');
    assert.equal(ambientStyleFor(Status.WAITING_APPROVAL).brightness, 1.0);
    assert.equal(ambientStyleFor(Status.RUNNING).brightness, 1, '2026-10-11: 모두 100%');
    assert.equal(ambientStyleFor(Status.DONE_UNSEEN).brightness, 1);
  });
});

describe('M8 / Orca에서 지운 세션 — 자리를 비운다 (2026-09-30)', () => {
  it('H33 순서를 준 동기화(Orca가 기준)에서는 목록에서 빠진 작업을 끊김으로 남기지 않고 지운다', () => {
    const store = new StateStore();
    const sync = new OrcaSync(store);
    const mk = (id) => new WorkUnit({ id, title: id, source: 'orca', kind: 'worktree' });
    sync.syncOnce([mk('a'), mk('b'), mk('c')], { order: ['a', 'b', 'c'] });
    const d = sync.syncOnce([store.getUnit('a'), store.getUnit('c')], { order: ['a', 'c'] });
    assert.deepEqual(d.vanished, ['b']);
    assert.equal(store.getUnit('b'), null, '연결 끊김으로 남지 않는다');
    assert.deepEqual(['a', 'c'].map((id) => store.globalSlots.globalIndexOf(id)), [0, 1]);
  });

  it('H34 순서 없이 부르면 예전처럼 끊김으로 자리를 지킨다', () => {
    const store = new StateStore();
    const sync = new OrcaSync(store);
    sync.syncOnce([new WorkUnit({ id: 'x', title: 'x', source: 'orca', kind: 'worktree' })]);
    sync.syncOnce([]);
    assert.equal(store.getUnit('x').status, Status.DISCONNECTED);
  });
});

describe('M8 / orphaned 탭으로 이동 — Orca가 switch로 다시 붙인다 (실측 2026-09-30)', () => {
  const T = (handle, extra = {}) => ({ handle, worktreeId: 'w', tabId: 'tab', leafId: 'leaf', connected: true, orphaned: false, ...extra });
  const resolve = (terminals, handle) => new OrcaAdapter({ cli: fakeCli({ terminals }) }).resolveHandle({ handle, worktreeId: 'w', tabId: 'tab', leafId: 'leaf' });

  it('H35 같은 자리에 살아 있는 탭이 없으면 orphaned 핸들 그대로 이동한다', async () => {
    const r = await resolve([T('h_old', { orphaned: true, tabId: 'pty:x', leafId: 'pty:x' })], 'h_old');
    assert.equal(r.handle, 'h_old');
    assert.equal(r.recovered, false);
  });

  it('H36 살아 있는 새 탭이 같은 자리에 있으면 그쪽을 쓴다 (기존 복구 우선)', async () => {
    const r = await resolve([T('h_old', { orphaned: true }), T('h_new')], 'h_old');
    assert.equal(r.handle, 'h_new');
  });

  it('H37 핸들이 목록에 아예 없으면 실패를 그대로 보고한다', async () => {
    const r = await resolve([], 'h_gone');
    assert.equal(r.handle, null);
  });

  it('H37b 출력 시각·에이전트 표시가 없는 orphaned 탭뿐이어도 그 탭으로 이동한다 — "worktree 자체로 이동" 실패를 내지 않는다 (2026-10-02)', async () => {
    const { Output } = await import('../src/output.js');
    const { resolveFocusTarget } = await import('../src/core/policy.js');
    const unit = new WorkUnit({ id: 'w', title: 'w', source: 'orca', kind: 'worktree',
      children: [new ChildUnit({ id: 'h_orphan', title: 'h_orphan', status: Status.DONE_SEEN, lastActiveAt: 0, primaryAgent: false })] });
    assert.equal(resolveFocusTarget(unit)?.id, 'h_orphan');
    const store = new StateStore();
    store.addUnit(unit);
    const calls = [];
    const o = new Output({ store, focusRouter: { focus: async (t) => { calls.push(t); return { ok: true }; } } });
    await o.pressSlot(1);
    assert.equal(calls[0].childId, 'h_orphan');
  });
});

describe('M8 / 확인한 완료는 끈다 — ACK 또는 Orca에서 열어 봄 (2026-09-30)', () => {
  const PANE = 'tabA:leafA';
  const live = { handle: 'h', worktreeId: 'w', tabId: 'tabA', leafId: 'leafA', connected: true, orphaned: false, title: 't', lastOutputAt: 1, agentIdentity: 'claude' };
  const listWith = (agent, acks = {}) => new OrcaAdapter({
    cli: fakeCli({ worktrees: [W0('w')], terminals: [live], ps: { worktrees: [{ worktreeId: 'w', status: 'active', agents: [{ paneKey: PANE, ...agent }] }] } }),
    settings: { read: () => ({ hideDefaultBranch: false, repoOrder: null, agentAcks: acks, warningKo: null }) },
  }).list();
  function W0(id) { return { id, displayName: id, repoId: 'r', sortOrder: 1, isArchived: false, isMainWorktree: false, branch: 'refs/heads/x' }; }

  it('H38 확인함(DONE_SEEN)은 흐린 초록 — Orca의 초록 점과 같은 뜻, 빈 자리(꺼짐)와 구별 (2026-10-02)', async () => {
    const { threadStyleFor } = await import('../src/core/lightingPolicy.js');
    const { colorOf, COLOR_HEX } = await import('../src/service/uiModel.js');
    assert.deepEqual(threadStyleFor(Status.DONE_SEEN), { color: 'green', brightness: 0.6, pattern: 'solid' });
    assert.notEqual(threadStyleFor(Status.DONE_SEEN).color, threadStyleFor(Status.EMPTY).color);
    assert.equal(colorOf(Status.DONE_SEEN), COLOR_HEX.green);
  });

  it('H38b 안 본 완료(DONE_UNSEEN)는 청록 — 초록(본 완료)·따뜻한 색(진행·개입)과 다르다 (2026-10-02)', async () => {
    const { threadStyleFor, ambientStyleFor } = await import('../src/core/lightingPolicy.js');
    const { colorOf, COLOR_HEX } = await import('../src/service/uiModel.js');
    assert.deepEqual(threadStyleFor(Status.DONE_UNSEEN), { color: 'teal', brightness: 1, pattern: 'breathing_slow' }, '느린 숨쉬기 (2026-10-02, 2026-10-10)');
    assert.equal(colorOf(Status.DONE_UNSEEN), COLOR_HEX.teal);
    assert.equal(ambientStyleFor(Status.DONE_UNSEEN).color, 'teal', '언더글로우도 같은 색');
  });

  it('H39 OrcaSettings는 에이전트별 확인 시각을 읽는다', () => {
    const s = new OrcaSettings({ dbPath: tmpDb({ hideDefaultBranchWorkspace: true, acknowledgedAgentsByPaneKey: { [PANE]: 500 } }) });
    assert.deepEqual(s.read().agentAcks, { [PANE]: 500 });
  });

  it('H40 Orca에서 완료 뒤에 열어 봤으면 확인함, 완료 전 기록이면 미확인', async () => {
    assert.equal((await listWith({ state: 'done', stateStartedAt: 100 }, { [PANE]: 150 })).units[0].children[0].status, Status.DONE_SEEN);
    assert.equal((await listWith({ state: 'done', stateStartedAt: 200 }, { [PANE]: 150 })).units[0].children[0].status, Status.DONE_UNSEEN);
  });

  it('H41 Output ACK 뒤 다음 폴링에서도 확인함을 유지하고, 새 완료가 오면 다시 미확인 + 새 알림', async () => {
    const store = new StateStore();
    const sync = new OrcaSync(store);
    const poll = async (agent) => { const l = await listWith(agent); sync.syncOnce(l.units, { order: l.order }); };
    const t0 = Date.now();
    await poll({ state: 'done', stateStartedAt: t0 - 60_000 });
    const n = store.unacknowledgedNotifications()[0];
    assert.ok(n, '완료 알림');
    store.acknowledgeNotification(n.id);
    await poll({ state: 'done', stateStartedAt: t0 - 60_000 });
    assert.equal(store.getUnit('w').status, Status.DONE_SEEN, 'Orca가 여전히 done이라고 해도 되돌리지 않는다');
    await poll({ state: 'working', stateStartedAt: t0 + 60_000 });
    await poll({ state: 'done', stateStartedAt: t0 + 120_000 });
    assert.equal(store.getUnit('w').status, Status.DONE_UNSEEN, '새 완료는 다시 알린다');
    assert.equal(store.unacknowledgedNotifications().length, 1, 'ACK할 새 알림이 있다');
  });
});

describe('M8 / Orca에서 열어 봄 = ACK (2026-09-30)', () => {
  it('H42 미확인 완료가 확인함으로 바뀌면 그 완료 알림도 확인 처리된다 — ACK 키가 꺼진다', () => {
    const store = new StateStore();
    store.addUnit(new WorkUnit({ id: 'w', title: 'w', source: 'orca', kind: 'worktree', children: [new ChildUnit({ id: 't', title: 't', status: Status.RUNNING })] }));
    store.setChildStatus('w', 't', Status.DONE_UNSEEN);
    assert.equal(store.unacknowledgedNotifications().length, 1);
    store.setChildStatus('w', 't', Status.DONE_SEEN);            // Orca가 '열어 봄'을 알려 옴
    assert.equal(store.unacknowledgedNotifications().length, 0);
  });
});


describe('M8 / 노브 회전 = 세션 이동 (사용자 결정 2026-10-01)', () => {
  const rig = async (n, router) => {
    const { Output } = await import('../src/output.js');
    const store = new StateStore();
    for (let i = 0; i < n; i += 1) store.addUnit(new WorkUnit({ id: `u${i}`, title: `u${i}`, source: 'orca', kind: 'worktree', children: [new ChildUnit({ id: `t${i}`, title: `t${i}`, status: Status.RUNNING, lastActiveAt: 1 })] }));
    const o = new Output({ store, sourceName: 'Orca', focusRouter: router });
    o.setActive(true);
    return o;
  };
  const recorder = () => ({ calls: [], async focus(t) { this.calls.push(t.unitId); return { ok: true }; } });

  it('H43 시계 방향이면 다음 세션으로 이동하고, 묶음을 넘어가고, 끝에서 처음으로 돈다', async () => {
    const r = recorder();
    const o = await rig(12, r);
    for (let i = 0; i < 10; i += 1) { o.dialCW(); await o.dialIdle(); }
    assert.equal(r.calls.at(-1), 'u10', '10칸 돌리면 두 번째 묶음의 첫 세션');
    assert.equal(o.banks.current, 1, '묶음도 따라간다');
    o.dialCW(); await o.dialIdle();
    o.dialCW(); await o.dialIdle();
    assert.equal(r.calls.at(-1), 'u0', '끝에서 처음으로');
    o.dialCCW(); await o.dialIdle();
    assert.equal(r.calls.at(-1), 'u11', '반시계는 거꾸로');
  });

  it('H44 빨리 돌려도 이동 명령이 쌓이지 않고 마지막 세션으로 간다', async () => {
    const calls = [];
    let release;
    const slow = { async focus(t) { calls.push(t.unitId); await new Promise((res) => { release = res; }); return { ok: true }; } };
    const o = await rig(6, slow);
    o.dialCW(); o.dialCW(); o.dialCW(); o.dialCW();
    release(); await new Promise((res) => setImmediate(res)); release?.();
    await o.dialIdle();
    assert.deepEqual(calls, ['u1', 'u4'], '처음 것과 마지막 것만');
  });

  it('H45 세션이 없으면 아무것도 하지 않는다', async () => {
    const r = recorder();
    const o = await rig(0, r);
    assert.equal(o.dialCW(), null);
    await o.dialIdle();
    assert.deepEqual(r.calls, []);
  });
});
