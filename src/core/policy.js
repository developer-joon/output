/**
 * 상태 '사실'과 '정책'의 분리 (CODEX_NEXT_TASK_KO.md 2.1).
 *
 * 네 가지 판단은 서로 다른 질문이므로 각각 순수 함수로 둔다.
 * 하나의 우선순위 배열로 전부 처리하지 않는다.
 *
 *  aggregateUnitStatus : 이 작업의 대표 상태는?
 *  rankAttention       : 다음에 사람이 개입할 대상은?
 *  resolveFocusTarget  : 이 작업을 눌렀을 때 열 곳은?
 *  summarizeAmbient    : 모든 묶음의 요약 조명은?
 */
import {
  Status, statusRank, isAttention, impactRank, Impact,
} from './types.js';

// ───────────────────────── 1. 대표 상태

/**
 * @param {import('./units.js').WorkUnit} unit
 * @returns {string} Status
 */
export function aggregateUnitStatus(unit) {
  const children = unit.children ?? [];
  const own = unit.ownStatus ?? null;

  if (!children.length) return own ?? Status.UNKNOWN;

  // 1) 개입/실패 사실이 하나라도 있으면 그것이 대표 상태다.
  //    parent 자체의 실패도 후보에 포함한다 (C09: children이 있다고 버리지 않는다).
  const facts = children.map((c) => c.status);
  if (own) facts.push(own);
  const intervention = facts.filter(isAttention);
  if (intervention.length) {
    return intervention.reduce((a, b) => (statusRank(b) < statusRank(a) ? b : a));
  }

  // 2) 완료 판정은 '필수' child만으로 한다. 상주 표면은 제외한다 (C07).
  const required = children.filter((c) => c.requiredForCompletion);

  if (required.length) {
    // 필수 작업이 아직 돌고 있으면 부모는 완료가 아니다 (C08).
    if (required.some((c) => c.status === Status.RUNNING)) return Status.RUNNING;
    if (required.some((c) => c.status === Status.UNKNOWN)) return Status.UNKNOWN;
    if (required.some((c) => c.status === Status.DONE_UNSEEN)) return Status.DONE_UNSEEN;
    if (required.some((c) => c.status === Status.INTERRUPTED)) return Status.INTERRUPTED;
    return Status.DONE_SEEN;
  }

  // 3) 상주 표면만 있는 작업. 완료 알림이 있으면 완료, 아니면 돌고 있는 것이다.
  if (children.some((c) => c.status === Status.DONE_UNSEEN)) return Status.DONE_UNSEEN;
  if (children.some((c) => c.status === Status.RUNNING)) return Status.RUNNING;
  if (children.every((c) => c.status === Status.DONE_SEEN)) return Status.DONE_SEEN;
  // child가 아무것도 말해주지 않으면 parent 자신의 사실을 쓴다.
  // C09와 같은 이유다 — 알고 있는 것을 버리지 않는다.
  return own ?? Status.UNKNOWN;
}

// ───────────────────────── 2. 개입 순서

const INTERVENTION_CLASS = Object.freeze({
  [Status.ERROR]: 0,
  [Status.WAITING_APPROVAL]: 1,
  [Status.WAITING_INPUT]: 2,
  [Status.STALE]: 3,
  [Status.DISCONNECTED]: 4,
});

/**
 * 개입 큐 정렬 키. 앞자리부터 비교한다.
 *
 *  0 확인한 알림은 뒤로   — 과거 오류가 새 요청을 영원히 가리지 않게 (C04)
 *  1 운영 영향도          — 긴급 운영 장애 우선 (C05)
 *  2 개입 종류
 *  3 대기 시간 긴 순
 *  4 슬롯 순서            — 동률에서 항상 같은 결과
 *
 * @returns {number[]} 사전식으로 비교 가능한 정렬 키
 */
export function rankAttention(item, now = 0) {
  const waited = item.waitingSince ? Math.max(0, now - item.waitingSince) : 0;
  return [
    item.acknowledged ? 1 : 0,
    impactRank(item.impact ?? Impact.NORMAL),
    INTERVENTION_CLASS[item.status] ?? 9,
    -waited,
    item.slot ?? 0,
  ];
}

export function compareAttention(a, b, now = 0) {
  const ka = rankAttention(a, now);
  const kb = rankAttention(b, now);
  for (let i = 0; i < ka.length; i += 1) {
    if (ka[i] !== kb[i]) return ka[i] - kb[i];
  }
  return 0;
}

// ───────────────────────── 3. 포커스 대상

/**
 * '이 작업에서 지금 내가 봐야 하는 곳으로 데려가라' (ORCA_BEHAVIOR.md).
 * 대표 상태와 다를 수 있다. 사람이 실제로 조치할 수 있는 표면을 고른다.
 * @returns {import('./units.js').ChildUnit|null} null이면 worktree surface
 */
export function resolveFocusTarget(unit) {
  const children = unit.children ?? [];
  const byStatus = [
    Status.ERROR, Status.WAITING_APPROVAL, Status.WAITING_INPUT,
    Status.STALE, Status.DISCONNECTED, Status.DONE_UNSEEN,
  ];
  for (const s of byStatus) {
    const hit = children.filter((c) => c.status === s);
    if (hit.length) return hit.reduce((a, b) => (b.lastActiveAt > a.lastActiveAt ? b : a));
  }
  const active = children.filter((c) => c.lastActiveAt > 0);
  if (active.length) return active.reduce((a, b) => (b.lastActiveAt > a.lastActiveAt ? b : a));
  const primary = children.find((c) => c.primaryAgent);
  if (primary) return primary;
  // 출력 시각도 에이전트 표시도 없는 탭(Orca 재시작 뒤 orphaned)도 이동할 수 있다 (terminal switch가 다시 붙인다).
  // 터미널이 하나라도 있으면 그쪽으로 간다 — worktree 자체 이동은 CLI에 없다 (2026-10-02)
  return children[0] ?? null;
}

// ───────────────────────── 4. 요약 조명

/**
 * 모든 묶음(hidden bank 포함)의 요약 조명 상태.
 * @param {{status:string}[]} attentionItems
 * @param {{hasUnseenDone:boolean}} extra
 * @returns {string|null} Status 또는 null(정상)
 */
export function summarizeAmbient(attentionItems, { hasUnseenDone = false, hasRunning = false, hasInterrupted = false } = {}) {
  if (attentionItems.length) {
    return attentionItems
      .map((i) => i.status)
      .reduce((a, b) => (statusRank(b) < statusRank(a) ? b : a));
  }
  // 메뉴바 점과 같은 순서: 개입 > 진행 중 > 완료·미확인 (사용자 결정 2026-09-30)
  if (hasRunning) return Status.RUNNING;
  if (hasUnseenDone) return Status.DONE_UNSEEN;
  // 중단된 작업만 남으면 회색 (2026-10-10)
  return hasInterrupted ? Status.INTERRUPTED : null;
}
