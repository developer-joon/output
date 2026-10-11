import { WorkUnit, ChildUnit } from '../../core/units.js';
import { Status, Confidence, ChildRole, Impact, isAttention } from '../../core/types.js';
import { OrcaCli, READ_COMMANDS } from './orcaCli.js';
import {
  statusOfAgent, confidenceOfAgent, indexAgentsByPaneKey, AGENT_STATE_MAP,
  indexPsWorktrees, psWorktreeWaitingSince, PS_WORKTREE_STATUS_MAP, KNOWN_PS_STATUSES,
  orphanedStatus, isAcked,
} from './agentState.js';

/**
 * Orca worktree/terminal → WorkUnit/ChildUnit.
 *
 * 실측 스키마 기준 (Orca 1.4.206, 2026-09-21):
 *   worktree: id displayName branch isPinned isUnread isArchived sortOrder
 *             lastActivityAt workspaceStatus parentWorktreeId childWorktreeIds
 *   terminal: handle ptyId worktreeId tabId leafId title connected writable
 *             orphaned lastOutputAt preview agentIdentity
 *
 * **상태를 추측하지 않는다.**
 * 관측 가능한 것만 상태로 옮기고 나머지는 UNKNOWN으로 둔다.
 * "출력이 멈췄다"를 완료나 답변 필요로 해석하지 않는다 (CODEX_NEXT_TASK 2.2).
 *
 * `preview`(터미널 내용)는 읽는 즉시 버린다. 저장도 기록도 하지 않는다 (AGENTS.md 12).
 */

/**
 * worktree.workspaceStatus는 Orca 워크스페이스 보드의 **칸반 열**이다 (실측 2026-09-29: 모든
 * worktree가 'in-progress'). 에이전트 활동과 무관하므로 상태로 옮기지 않는다. 비워 둔다.
 */
export const WORKSPACE_STATUS_MAP = Object.freeze({});

/**
 * Orca 사이드바의 "기본 브랜치 숨기기"가 빼는 worktree (Orca 1.4.215 필터 코드 실측, 2026-09-29):
 * 본 체크아웃(isMainWorktree)이면서 provisioned-root VM 체크아웃이 아니고 브랜치 이름이 있는 것.
 * 브랜치가 비어 있으면 Orca는 저장소 쪽 조건을 더 보는데 그 값을 우리는 모르므로 숨기지 않는다.
 * `alwaysShowDefaultBranchWorkspace`는 이 필터와 무관하다 — "슬립 중인 항목 숨기기"에서만
 * 본 체크아웃을 예외로 둘지 정하는 값이고, Output은 슬립 필터를 흉내 내지 않는다.
 */
export function isDefaultBranchWorkspace(w) {
  if (w?.isMainWorktree !== true) return false;
  if (w.ephemeralVmCheckoutMode === 'provisioned-root') return false;
  return typeof w.branch === 'string' && w.branch.trim() !== '';
}

/** terminal.agentIdentity 가 있으면 agent child로 본다. */
export function roleOfTerminal(t) {
  return t.agentIdentity ? ChildRole.AGENT : ChildRole.TERMINAL;
}

/**
 * 관측 가능한 사실만으로 terminal 상태를 정한다.
 * 살아 있는지조차 모르면 UNKNOWN이다. RUNNING이라고 단정하지 않는다.
 */
export function terminalStatus(t) {
  if (t.orphaned) return Status.STALE;
  if (t.connected === false) return Status.DISCONNECTED;
  return Status.UNKNOWN;
}

/**
 * terminal → ChildUnit. preview는 옮기지 않는다.
 *
 * @param {object} t terminal
 * @param {object|null} agent `worktree ps`가 준 같은 pane의 에이전트. 없으면 상태를 모른다.
 * @param {object|null} ps 같은 묶음의 `worktree ps` 레코드. orphaned 탭의 근거로만 쓴다.
 */
export function toChildUnit(t, agent = null, ps = null, acks = {}) {
  // 죽은 터미널은 살아 있는 척하지 않는다. 다만 orphaned는 '끝난 뒤 탭이 사라진 것'일 수 있어
  // 마지막 보고가 done이면 완료·미확인으로, 아니면 STALE로 둔다 (orphanedStatus).
  const dead = terminalStatus(t);
  const alive = dead === Status.UNKNOWN;
  let status = agent && alive ? statusOfAgent(agent)
    : dead === Status.STALE ? orphanedStatus(agent, ps, acks)
      : dead;
  // Orca에서 완료 뒤에 열어 봤으면 확인한 것이다 (acknowledgedAgentsByPaneKey)
  if (status === Status.DONE_UNSEEN && agent && alive && isAcked(agent, acks)) status = Status.DONE_SEEN;
  const child = new ChildUnit({
    id: t.handle,
    title: t.title ?? t.handle,
    role: agent ? ChildRole.AGENT : roleOfTerminal(t),
    status,
    confidence: agent && alive ? confidenceOfAgent(agent) : Confidence.INFERRED,
    primaryAgent: Boolean(agent) || Boolean(t.agentIdentity),
    lastActiveAt: t.lastOutputAt ?? 0,
    // 개입 상태에 '언제 들어갔는지'는 에이전트가 보고한 시각을 쓴다.
    // 승인이 연달아 오면 상태 값은 그대로 waiting이고 이 시각만 바뀐다.
    waitingSince: isAttention(status) ? (agent?.stateStartedAt ?? 0) : 0,
    // 수명을 관측할 수 있는 에이전트만 완료 판정의 필수 조건이 된다.
    // ps가 말해주지 않는 터미널은 상주 여부를 모르므로 뺀다.
    // 필수라고 단정하면 '완료 아님'을 잘못 만들어 낸다.
    requiredForCompletion: Boolean(agent),
  });
  // 완료 시각. Output ACK가 이 완료를 이미 확인했는지 비교하는 근거다.
  child.doneAt = status === Status.DONE_UNSEEN || status === Status.DONE_SEEN
    ? Math.max(agent?.stateStartedAt ?? 0, ...(ps?.agents ?? []).map((a) => a.stateStartedAt ?? 0))
    : 0;
  return child;
}

/**
 * worktree → WorkUnit
 * @param {object|null} ps `worktree ps`가 준 같은 묶음의 레코드
 */
export function toWorkUnit(w, terminals = [], agentsByPane = new Map(), ps = null, acks = {}) {
  // 묶음 자체의 사실이 있으면 그것이 우선한다. 거절로 멈춘 것은 child가 말해주지 않는다.
  const psOwn = ps ? PS_WORKTREE_STATUS_MAP[ps.status] ?? null : null;
  const own = psOwn ?? WORKSPACE_STATUS_MAP[w.workspaceStatus] ?? null;
  return new WorkUnit({
    id: w.id,
    title: w.displayName || w.branch || w.id,
    source: 'orca',
    kind: 'worktree',
    status: terminals.length ? own : (own ?? Status.UNKNOWN),
    confidence: Confidence.INFERRED,
    impact: Impact.NORMAL,
    pinned: Boolean(w.isPinned),
    createdAt: w.sortOrder ?? 0,
    ownWaitingSince: psOwn ? psWorktreeWaitingSince(ps) : 0,
    children: terminals.map((t) => toChildUnit(t, agentsByPane.get(`${t.tabId}:${t.leafId}`) ?? null, ps, acks)),
  });
}

export class OrcaAdapter {
  /**
   * @param {object} [opts]
   * @param {{read:()=>{hideDefaultBranch:boolean|null, warningKo:string|null}}|null} [opts.settings]
   *   Orca 사이드바 필터. 없으면 아무것도 숨기지 않는다.
   */
  constructor({ cli = new OrcaCli(), includeArchived = false, settings = null } = {}) {
    this.cli = cli;
    this.includeArchived = includeArchived;
    this.settings = settings;
    /** 관측했지만 뜻을 모르는 값. 추측 대신 모아 둔다. */
    this.unknownWorkspaceStatuses = new Set();
    this.unknownAgentStates = new Set();
    this.unknownPsStatuses = new Set();
  }

  async health() {
    const r = await this.cli.run(READ_COMMANDS.status);
    return {
      appRunning: Boolean(r?.app?.running),
      runtimeReady: r?.runtime?.state === 'ready',
      reachable: Boolean(r?.runtime?.reachable),
      appVersion: r?.runtime?.appVersion ?? null,
    };
  }

  /**
   * worktree + terminal을 한 번에 읽어 WorkUnit 목록을 만든다.
   * @returns {Promise<{units:WorkUnit[], notesKo:string[], terminals:object[], hiddenIds:string[]}>}
   *   hiddenIds — Orca 필터로 숨긴 worktree. 자리를 갖고 있었다면 동기화가 비운다.
   */
  async list({ full = true } = {}) {
    let psError = null;
    // Orca가 "기본 브랜치 숨기기"를 켰으면 본 체크아웃(isMainWorktree)을 넣지 않는다.
    // 설정을 모르면 숨기지 않는다 — 있는 작업을 잘못 빼는 쪽이 더 나쁘다.
    const filter = this.settings ? this.settings.read() : { hideDefaultBranch: null, repoOrder: null, agentAcks: {}, warningKo: null };
    const hideMain = filter.hideDefaultBranch === true;
    // 성능 (2026-10-11 측정: CLI 하나가 CPU 0.15초): full이 아니면 에이전트 상태(worktree ps)만 새로 읽고
    // 작업·터미널 목록은 지난 것을 쓴다. 처음이거나 모르는 작업이 보이면 목록도 다시 읽는다
    const needLists = full || !this._lists;
    const [wres, tres, psres] = await Promise.all([
      needLists ? this.cli.run(READ_COMMANDS.worktreeList) : this._lists.wres,
      needLists ? this.cli.run(READ_COMMANDS.terminalList) : this._lists.tres,
      // 에이전트 상태를 못 읽어도 목록 자체는 만든다. 모르는 것은 모른다고 두면 된다.
      this.cli.run(READ_COMMANDS.worktreePs).catch((e) => { psError = e; return null; }),
    ]);
    if (needLists) this._lists = { wres, tres };
    else if (psres) {
      const known = new Set((wres?.worktrees ?? []).map((w) => w.id));
      if ([...indexPsWorktrees(psres).keys()].some((id) => !known.has(id))) return this.list({ full: true });
    }
    const agentsByPane = psres ? indexAgentsByPaneKey(psres) : new Map();
    const psByWorktree = psres ? indexPsWorktrees(psres) : new Map();
    for (const w of psByWorktree.values()) {
      if (w.status && !KNOWN_PS_STATUSES.includes(w.status)) this.unknownPsStatuses.add(w.status);
    }
    for (const a of agentsByPane.values()) {
      if (a.state && !(a.state in AGENT_STATE_MAP)) this.unknownAgentStates.add(a.state);
    }
    const hiddenIds = [];
    const worktrees = (wres?.worktrees ?? [])
      .filter((w) => this.includeArchived || !w.isArchived)
      .filter((w) => {
        if (hideMain && isDefaultBranchWorkspace(w)) { hiddenIds.push(w.id); return false; }
        return true;
      });
    const terminals = tres?.terminals ?? [];

    const byWorktree = new Map();
    for (const t of terminals) {
      if (!byWorktree.has(t.worktreeId)) byWorktree.set(t.worktreeId, []);
      byWorktree.get(t.worktreeId).push(t);
    }

    const units = worktrees
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
      .map((w) => {
        if (w.workspaceStatus && !(w.workspaceStatus in WORKSPACE_STATUS_MAP)) {
          this.unknownWorkspaceStatuses.add(w.workspaceStatus);
        }
        const ts = (byWorktree.get(w.id) ?? [])
          .sort((a, b) => (a.lastOutputAt ?? 0) - (b.lastOutputAt ?? 0));
        return toWorkUnit(w, ts, agentsByPane, psByWorktree.get(w.id) ?? null, filter.agentAcks ?? {});
      })
      // 사이드바처럼: 터미널도 에이전트도 없고 Orca가 inactive라 한 것은 슬롯을 주지 않는다
      .filter((u) => {
        if (u.children.length || u.ownStatus !== Status.IDLE) return true;
        hiddenIds.push(u.id);
        return false;
      });

    // 슬롯 순서 = Orca 사이드바: 프로젝트 수동 순서 → 프로젝트 안 최근 생성순(sortOrder 내림차순).
    // 사이드바의 'smart' 등급(탭·창 제목 신호)은 밖에서 재현할 수 없어 쓰지 않는다.
    const byId = new Map(worktrees.map((w) => [w.id, w]));
    const repoRank = (w) => {
      const i = filter.repoOrder?.indexOf(w?.repoId) ?? -1;
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    const order = [...units].sort((a, b) => {
      const wa = byId.get(a.id); const wb = byId.get(b.id);
      return repoRank(wa) - repoRank(wb) || (wb?.sortOrder ?? 0) - (wa?.sortOrder ?? 0);
    }).map((u) => u.id);

    // 이름이 겹치면 저장소 이름을 붙인다. 두 줄이 모두 'master'면 어느 쪽인지 알 수 없다.
    const counts = new Map();
    for (const u of units) counts.set(u.title, (counts.get(u.title) ?? 0) + 1);
    for (const u of units) {
      const repo = psByWorktree.get(u.id)?.repo;
      if (counts.get(u.title) > 1 && repo) u.title = `${repo} · ${u.title}`;
    }

    const notesKo = [];
    if (filter.warningKo) notesKo.push(filter.warningKo);
    if (psError) {
      notesKo.push(
        '에이전트 상태를 읽지 못했습니다 (worktree ps). '
        + '모든 터미널을 미검증(UNKNOWN)으로 둡니다.',
      );
    } else if (agentsByPane.size) {
      notesKo.push(
        `에이전트 ${agentsByPane.size}개의 상태는 Orca가 에이전트 hook으로 직접 받은 보고입니다. `
        + 'working·waiting(승인 대기)·done은 실측으로 확인했고, blocked은 아직 관측하지 못해 추정입니다.',
      );
    }
    const unmatched = terminals.filter((t) => !agentsByPane.has(`${t.tabId}:${t.leafId}`)).length;
    if (unmatched) {
      notesKo.push(
        `에이전트가 붙지 않은 터미널 ${unmatched}개는 orphaned/connected만 관측합니다. `
        + '진행 중·승인 대기·완료는 미검증(UNKNOWN)으로 둡니다.',
      );
    }
    if (this.unknownPsStatuses.size) {
      notesKo.push(`뜻을 모르는 묶음 상태: ${[...this.unknownPsStatuses].join(', ')}`);
    }
    if (this.unknownAgentStates.size) {
      notesKo.push(`뜻을 모르는 agent state: ${[...this.unknownAgentStates].join(', ')}`);
    }
    if (this.unknownWorkspaceStatuses.size) {
      notesKo.push(`뜻을 모르는 workspaceStatus: ${[...this.unknownWorkspaceStatuses].join(', ')}`);
    }
    const orphaned = terminals.filter((t) => t.orphaned).length;
    if (orphaned) notesKo.push(`stale 터미널 ${orphaned}개를 관측했습니다.`);

    // terminals 원본을 함께 돌려준다. 호출자가 stale 복구 색인을 만들려고
    // 같은 목록을 다시 읽을 이유가 없다.
    return { units, notesKo, terminals, hiddenIds, order };
  }

  /** 핸들이 아직 살아 있는지 확인하고, 아니면 같은 자리를 다시 찾는다. */
  async resolveHandle({ handle, worktreeId, tabId, leafId }) {
    const r = await this.cli.run(READ_COMMANDS.terminalList);
    const terminals = r?.terminals ?? [];
    const alive = terminals.find((t) => t.handle === handle && !t.orphaned);
    if (alive) return { handle, recovered: false, reasonKo: '' };

    // stale handle recover: 같은 worktree의 같은 탭/리프를 다시 찾는다.
    const sameLeaf = terminals.find(
      (t) => t.worktreeId === worktreeId && t.leafId && t.leafId === leafId && !t.orphaned,
    );
    if (sameLeaf) {
      return { handle: sameLeaf.handle, recovered: true, reasonKo: '같은 터미널 자리를 다시 찾았습니다.' };
    }
    const sameTab = terminals.find(
      (t) => t.worktreeId === worktreeId && t.tabId && t.tabId === tabId && !t.orphaned,
    );
    if (sameTab) {
      return { handle: sameTab.handle, recovered: true, reasonKo: '같은 탭의 다른 터미널로 대체했습니다.' };
    }
    // orphaned 핸들도 Orca가 switch로 다시 붙인다 (실측 2026-09-30: Orca 재시작 뒤 한 번도 열지 않은 탭).
    // 같은 자리에 살아 있는 탭이 없을 때만 쓴다. 이동만 하므로 엉뚱한 곳에 입력하는 위험은 없다.
    const orphan = terminals.find((t) => t.handle === handle && t.orphaned);
    if (orphan) return { handle, recovered: false, reasonKo: '' };
    return { handle: null, recovered: false, reasonKo: '터미널을 다시 찾지 못했습니다.' };
  }
}
