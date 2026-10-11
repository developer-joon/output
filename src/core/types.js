// WorkUnit/ChildUnit 상태 정의. HARDWARE_CONTRACT.md / UX_FINAL_KO.md 기준.

export const Status = Object.freeze({
  EMPTY: 'EMPTY',                 // 슬롯에 작업이 없음
  UNKNOWN: 'UNKNOWN',             // 작업은 있으나 상태를 확인하지 못함
  IDLE: 'IDLE',                   // 소스가 '살아 있는 에이전트 없음'이라고 말한 작업 (Orca ps inactive)
  RUNNING: 'RUNNING',
  WAITING_INPUT: 'WAITING_INPUT',
  WAITING_APPROVAL: 'WAITING_APPROVAL',
  DONE_UNSEEN: 'DONE_UNSEEN',
  DONE_SEEN: 'DONE_SEEN',
  ERROR: 'ERROR',
  STALE: 'STALE',
  DISCONNECTED: 'DISCONNECTED',
  INTERRUPTED: 'INTERRUPTED',     // 에이전트가 중단됨 (Esc 등). 완료도 개입도 아니다 (2026-10-09)
});

// UX_FINAL_KO.md 한국어 상태 문구.
// LIGHTING_POLICY.md가 STALE/UNKNOWN을 한 묶음으로 규정하므로 라벨을 공유한다. 2026-10-09: '상태 확인 불가' → '상태 모름'(무엇을 할지는 STATUS_HINT_KO)
export const StatusLabelKo = Object.freeze({
  [Status.RUNNING]: '진행 중',
  [Status.WAITING_INPUT]: '답변 필요',
  [Status.WAITING_APPROVAL]: '승인 필요',
  [Status.DONE_UNSEEN]: '완료 · 미확인',
  [Status.DONE_SEEN]: '완료 · 확인함',
  [Status.ERROR]: '오류',
  [Status.STALE]: '상태 모름',
  [Status.UNKNOWN]: '상태 모름',
  [Status.INTERRUPTED]: '중단됨',
  [Status.DISCONNECTED]: '연결 끊김',
  [Status.IDLE]: '대기',
  [Status.EMPTY]: '',
});

/** 상태판에서 마우스를 올렸을 때 무엇을 하면 되는지 (2026-10-09 사용자 요청: '확인 불가'는 그래서 어떻게 하라는지 모르겠다) */
export const STATUS_HINT_KO = Object.freeze({
  [Status.UNKNOWN]: 'Orca가 이 작업의 상태를 아직 알려 주지 않았습니다 (Output 재시작 직후이거나 처음 보는 상태). 터미널을 열어 확인하세요.',
  [Status.STALE]: '탭이 사라져 지금 상태를 알 수 없습니다. 터미널을 열어 확인하세요.',
  [Status.INTERRUPTED]: '에이전트가 중단됐습니다 (Esc 등). 이어서 시킬 일이 있으면 터미널에서 계속하세요.',
});

/**
 * 표시 상태의 기본 급함 순서. '사실'의 순서이며 정책이 아니다.
 * 개입 순서(rankAttention)와 포커스 대상(resolveFocusTarget)은
 * 이 배열을 그대로 쓰지 않고 policy.js에서 각자 판단한다.
 */
export const STATUS_PRIORITY = Object.freeze([
  Status.ERROR,
  Status.WAITING_APPROVAL,
  Status.WAITING_INPUT,
  Status.STALE,
  Status.DISCONNECTED,
  Status.UNKNOWN,
  Status.DONE_UNSEEN,
  Status.RUNNING,
  Status.INTERRUPTED,
  Status.DONE_SEEN,
  Status.IDLE,
  Status.EMPTY,
]);

export function statusRank(status) {
  const i = STATUS_PRIORITY.indexOf(status);
  return i === -1 ? STATUS_PRIORITY.length : i;
}

// 사람이 개입해야 하는 상태 (ATTENTION / underglow 대상).
// DONE_UNSEEN은 개입이 아니라 '확인' 대상이므로 제외한다.
export const ATTENTION_STATUSES = Object.freeze([
  Status.ERROR,
  Status.WAITING_APPROVAL,
  Status.WAITING_INPUT,
  Status.STALE,
  Status.DISCONNECTED,
]);

export function isAttention(status) {
  return ATTENTION_STATUSES.includes(status);
}

/** 실행이 종료된 상태 (슬롯 자동 해제 후보 판정용) */
export const TERMINAL_STATUSES = Object.freeze([Status.DONE_SEEN, Status.DONE_UNSEEN]);

export function isTerminal(status) {
  return TERMINAL_STATUSES.includes(status);
}

// confidence: AGENTS.md 11번
export const Confidence = Object.freeze({
  AUTHORITATIVE: 'authoritative',
  INFERRED: 'inferred',
});

/** 운영 영향도. 개입 순서의 1차 정렬 축 (C05). */
export const Impact = Object.freeze({
  CRITICAL: 'critical',
  HIGH: 'high',
  NORMAL: 'normal',
  LOW: 'low',
});

const IMPACT_ORDER = [Impact.CRITICAL, Impact.HIGH, Impact.NORMAL, Impact.LOW];

export function impactRank(impact) {
  const i = IMPACT_ORDER.indexOf(impact);
  return i === -1 ? IMPACT_ORDER.indexOf(Impact.NORMAL) : i;
}

/** child의 역할. 완료 판정에 필수인지 결정한다 (C07/C08). */
export const ChildRole = Object.freeze({
  AGENT: 'agent',
  TASK: 'task',
  TEST: 'test',
  BUILD: 'build',
  TERMINAL: 'terminal',
  SHELL: 'shell',
  DEV_SERVER: 'dev_server',
  LOG_TAIL: 'log_tail',
  WATCH: 'watch',
});

/** 상주 표면. 계속 살아 있는 것이 정상이므로 완료 판정의 필수 조건이 아니다. */
export const RESIDENT_ROLES = Object.freeze([
  ChildRole.SHELL, ChildRole.DEV_SERVER, ChildRole.LOG_TAIL, ChildRole.WATCH,
]);

export function defaultRequiredForCompletion(role) {
  return !RESIDENT_ROLES.includes(role);
}

export const NotificationKind = Object.freeze({
  COMPLETION: 'completion',
  ERROR: 'error',
});

export const View = Object.freeze({ GLOBAL: 'GLOBAL', DETAIL: 'DETAIL' });
