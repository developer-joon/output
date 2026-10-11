import { Status, Confidence } from '../../core/types.js';

/**
 * Orca `worktree ps`의 agent 상태 → Output Status.
 *
 * 출처: Orca가 에이전트 hook(`~/.orca/agent-hooks/*.sh`)으로 직접 받은 보고다.
 * 앱 번들의 `[agent-hooks]` 모듈에 열거형이 박혀 있다:
 *
 *     var EDe = ["working","blocked","waiting","done"];
 *
 * 실측(2026-09-23)으로 확인한 것:
 *  - `waiting` — 권한 승인 대기. 같은 순간 worktree `status`가 `permission`이 되고
 *    터미널 제목이 `[ ! ] Action Required`가 된다. 승인 대기지 질문 대기가 아니다.
 *    그래서 WAITING_INPUT이 아니라 WAITING_APPROVAL이다 (AGENTS.md 7).
 *  - `working` — 도구를 돌리는 중.
 *  - `done` — 턴이 끝남.
 *
 * **`done`은 '완료'와 '되묻고 기다림'을 구분하지 못한다.**
 * Claude Code의 Stop hook이 둘을 나누지 않으므로 Orca도 우리도 알 수 없다.
 * 메시지 본문을 읽어 질문인지 판정하는 짓은 하지 않는다. 그건 상태를 지어내는 것이다.
 * 둘 다 '사람이 봐야 한다'는 점은 같으므로 DONE_UNSEEN 하나로 둔다.
 */

export const AGENT_STATE_MAP = Object.freeze({
  working: Status.RUNNING,
  waiting: Status.WAITING_APPROVAL,
  done: Status.DONE_UNSEEN,
  // 아직 실제로 관측하지 못했다. 정황상 decision gate나 멈춘 worker로 보인다.
  // 놓치는 쪽이 과하게 알리는 쪽보다 나쁘므로 개입 대상으로 둔다. 신뢰도는 INFERRED.
  blocked: Status.WAITING_INPUT,
});

/** 실측으로 뜻을 확인한 값. 나머지는 추정이다. */
const OBSERVED = new Set(['working', 'waiting', 'done']);

/**
 * @param {{state?:string, interrupted?:boolean}} agent
 * @returns {string} Status
 */
export function statusOfAgent(agent = {}) {
  // 중단된 에이전트는 완료가 아니다. 그렇다고 '모름'(개입·빨강)도 아니다 — 사용자가 멈춘 것이다 (2026-10-09)
  if (agent.interrupted) return Status.INTERRUPTED;
  return AGENT_STATE_MAP[agent.state] ?? Status.UNKNOWN;
}

/** 관측으로 뜻을 확인한 상태만 authoritative다. */
export function confidenceOfAgent(agent = {}) {
  return OBSERVED.has(agent.state) ? Confidence.AUTHORITATIVE : Confidence.INFERRED;
}

/**
 * orphaned 탭의 상태 (2026-09-29, Orca 재시작 실측).
 *
 * Orca가 재시작되면 살아 있던 탭이 전부 orphaned가 되고 tabId가 `pty:…`로 바뀌어
 * `worktree ps`의 paneKey와 더는 맞지 않는다. 그때 마지막 보고가 **done**이면 끝난 뒤 탭만
 * 사라진 것이라 개입할 게 없다 → DONE_UNSEEN (확인은 여전히 필요하다).
 * working/waiting 중에 끊겼거나 보고가 없으면 무엇이 끊겼는지 모른다 → STALE.
 *
 * @param {object|null} agent paneKey로 조인된 에이전트
 * @param {object|null} ps 같은 묶음의 `worktree ps` 레코드 (조인이 끊겼을 때의 근거)
 */
export function orphanedStatus(agent, ps, acks = {}) {
  const finished = (a) => Boolean(a) && a.state === 'done' && !a.interrupted;
  const agents = agent ? [agent] : (ps?.agents ?? []);
  if (!agents.length || !agents.every(finished)) return Status.STALE;
  return agents.every((a) => isAcked(a, acks)) ? Status.DONE_SEEN : Status.DONE_UNSEEN;
}

/** Orca에서 사용자가 이 에이전트의 마지막 상태 이후에 세션을 열어 봤는가 */
export function isAcked(agent, acks = {}) {
  const at = acks?.[agent?.paneKey];
  return Number.isFinite(at) && Number.isFinite(agent?.stateStartedAt) && at >= agent.stateStartedAt;
}

/**
 * paneKey는 `tabId:leafId`다 (실측 확인).
 * 이 분해가 ps의 agent를 `terminal list`의 handle로 잇는 유일한 연결 고리이고,
 * handle이 있어야 `terminal switch`로 데려갈 수 있다.
 */
export function paneKeyToTabLeaf(paneKey) {
  if (typeof paneKey !== 'string') return null;
  const at = paneKey.indexOf(':');
  if (at <= 0 || at === paneKey.length - 1) return null;
  return { tabId: paneKey.slice(0, at), leafId: paneKey.slice(at + 1) };
}

/**
 * ps 응답 → paneKey별 agent 색인.
 * worktree 단위로 묶지 않는다. 터미널이 이미 worktree를 알고 있으므로
 * paneKey 하나로 바로 잇는 편이 짧고, ps와 `worktree list`의 id 표기 차이도 피한다.
 */
export function indexAgentsByPaneKey(psResult = {}) {
  const index = new Map();
  for (const w of psResult.worktrees ?? []) {
    for (const a of w.agents ?? []) {
      if (a.paneKey) index.set(a.paneKey, a);
    }
  }
  return index;
}

/**
 * `worktree ps`의 묶음 단위 `status`.
 *
 * Orca 앱 번들의 상태 점 컴포넌트에서 확인한 값들 (2026-09-24):
 *
 *     working → 스피너 · monitoring → 노랑 · permission → 질문 아이콘
 *     interrupted → 빨강 · done|active → 초록
 *
 * `interrupted`만 옮긴다. 나머지는 child가 이미 더 정확하게 말하고 있으므로
 * 덮지 않는다 — 같은 사실을 두 곳에서 말하면 어긋날 때 어느 쪽이 맞는지 알 수 없다.
 *
 * ⚠ **`interrupted`는 아직 관측하지 못했다.** 승인 대기 154표본 동안 한 번도
 * 나오지 않았다 (15차). **권한 프롬프트 거절은 이 값을 만들지 않는다** —
 * 거절은 `waiting → working → done`으로 승인과 똑같이 보고된다.
 * 실행 중인 에이전트를 사용자가 중단시키는 경우로 추정하나 확인되지 않았다.
 *
 * 그럼에도 매핑을 두는 이유: 값이 나타난다면 '에이전트가 멈췄고 사람이 다음을
 * 정해야 한다'는 뜻이며, 그것은 오류가 아니라 '답변 필요'다.
 * 사용자가 스스로 막은 것이므로 실패한 것이 없고, 진짜 실패(ERROR, 빨강)와
 * 구분해서 보여야 둘 다 뜻을 유지한다.
 */
export const PS_WORKTREE_STATUS_MAP = Object.freeze({
  interrupted: Status.WAITING_INPUT,
  // 살아 있는 에이전트가 없다고 Orca가 말한 것. 진행 중이 아니고 개입 대상도 아니다 (2026-09-29).
  // 에이전트 child가 있으면 child(done 등)가 우선하고, 셸 탭만 있거나 아무것도 없으면 대기다.
  inactive: Status.IDLE,
});

/** 뜻을 아는 묶음 상태. 이 밖의 값은 모르는 값이다. */
export const KNOWN_PS_STATUSES = Object.freeze([
  'working', 'monitoring', 'permission', 'interrupted', 'done', 'active', 'inactive',
]);

/** ps 응답 → worktreeId별 묶음 레코드. */
export function indexPsWorktrees(psResult = {}) {
  const index = new Map();
  for (const w of psResult.worktrees ?? []) {
    if (w.worktreeId) index.set(w.worktreeId, w);
  }
  return index;
}

/** 거절로 멈춘 시각. 턴이 끝난 시각이므로 에이전트가 보고한 것 중 가장 최근 것을 쓴다. */
export function psWorktreeWaitingSince(w) {
  return (w?.agents ?? []).reduce((max, a) => Math.max(max, a.stateStartedAt ?? 0), 0);
}
