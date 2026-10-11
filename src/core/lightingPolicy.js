import { Status } from './types.js';

const style = (color, brightness, pattern) => Object.freeze({ color, brightness, pattern });

// LIGHTING_POLICY.md 'Per-key thread LED' (brightness = 명시 범위의 중앙값)
// 밝기는 처음 값(2026-10-01 팔레트)의 3배, 최대 100% (2026-10-11 사용자 요청: 너무 어둡지만 전부 100%는 아니다).
// 언더글로우는 3배가 모두 100%를 넘어 100%
export const THREAD_STYLE = Object.freeze({
  // 섞은 팔레트 (사용자 결정 2026-10-01): 진행 중은 Orca 스피너의 호박,
  // 사람 대기는 Codex Micro처럼 주황·살구 계열 숨쉬기. 흰색은 '생각 중'(구분 근거 확인 후) 몫으로 비워 둔다.
  // 움직임 (2026-10-10 사용자 요청): 개입은 그 색 빠른 숨쉬기, 진행 중은 보통 숨쉬기(회전은 색이 바뀌어 키에서는 쓰지 않음),
  // 오류는 빨강 빠른 깜박임 — 오류와 개입은 색이 구분된다
  [Status.RUNNING]: style('amber', 0.96, 'breathing'),
  [Status.WAITING_INPUT]: style('apricot', 1, 'breathing_fast'),
  [Status.WAITING_APPROVAL]: style('orange', 1, 'breathing_fast'),
  // 안 본 완료: 청록 (2026-10-02). 초록(본 완료)과 따뜻한 색(진행·개입) 어느 쪽과도 다르다.
  [Status.DONE_UNSEEN]: style('teal', 1, 'breathing_slow'),
  // 본 완료: 흐린 초록 (2026-10-02). Orca의 초록 점(done)과 같은 뜻, 꺼짐(빈 자리)과 구별된다.
  [Status.DONE_SEEN]: style('green', 0.6, 'solid'),
  [Status.ERROR]: style('red', 1, 'blink_fast'),
  [Status.STALE]: style('purple', 0.9, 'breathing_slow'),
  [Status.UNKNOWN]: style('purple', 0.9, 'breathing_slow'),
  [Status.DISCONNECTED]: style('purple', 0.9, 'breathing_slow'),
  [Status.IDLE]: style('dim_white', 0.18, 'solid'),
  // 중단됨: 흐린 회색 — 완료(초록)도 개입(빨강·주황)도 아니다 (2026-10-09). 언더글로우 표에는 없다(평온)
  [Status.INTERRUPTED]: style('neutral_gray', 0.45, 'solid'),
  [Status.EMPTY]: style('off', 0, 'off'),
});

// LIGHTING_POLICY.md 'Underglow / ambient zone'
// 메뉴바 점과 같은 규칙 (사용자 결정 2026-09-30): 개입이면 종류와 무관하게 빨강,
// 진행 중이면 호박, 완료·미확인이면 청록, 그 밖엔 초록(2026-10-02). 어떤 개입인지는 키 LED가 말한다.
// 밝기는 낮에도 보이게 올렸다 (사용자 요청 2026-09-30).
// 2026-10-10 사용자 결정: 개입은 키와 같은 색(승인 주황·답변 살구) 빠른 숨쉬기, 오류는 빨강 빠른 깜박임 —
// 오류와 개입은 색이 구분된다. 상태 모름은 키와 같은 보라. 진행 중은 회전, 평온은 느린 숨쉬기
const AMBIENT_UNKNOWN = style('purple', 1, 'breathing_slow');
// 평온: 메뉴바 초록 점과 같게 (2026-10-02, Orca의 초록과 같은 뜻), 느린 숨쉬기 (2026-10-10). 대기 중(Orca가 앞이 아님)에는 장치가 따로 끈다.
export const AMBIENT_NORMAL = style('green', 1, 'breathing_slow');
export const AMBIENT_STYLE = Object.freeze({
  [Status.ERROR]: style('red', 1, 'blink_fast'),
  [Status.WAITING_APPROVAL]: style('orange', 1, 'breathing_fast'),
  [Status.WAITING_INPUT]: style('apricot', 1, 'breathing_fast'),
  [Status.STALE]: AMBIENT_UNKNOWN,
  [Status.UNKNOWN]: AMBIENT_UNKNOWN,
  [Status.DISCONNECTED]: AMBIENT_UNKNOWN,
  [Status.RUNNING]: style('amber', 1, 'rotate'),
  [Status.DONE_UNSEEN]: style('teal', 1, 'solid'),
  // 중단됨: 키와 같은 회색 (2026-10-10 사용자 요청 — 빠짐없이)
  [Status.INTERRUPTED]: style('neutral_gray', 1, 'solid'),
  // 아무것도 안 할 때: 평온
  [Status.IDLE]: AMBIENT_NORMAL,
  [Status.DONE_SEEN]: AMBIENT_NORMAL,
  [Status.EMPTY]: AMBIENT_NORMAL,
});


export function threadStyleFor(status) {
  return THREAD_STYLE[status] ?? THREAD_STYLE[Status.EMPTY];
}

export function ambientStyleFor(summaryStatus) {
  if (!summaryStatus) return AMBIENT_NORMAL;
  return AMBIENT_STYLE[summaryStatus] ?? AMBIENT_NORMAL;
}

/**
 * 한 프레임의 조명 전체를 계산한다.
 * mini LED는 계산 대상에 포함하지 않는다 (hardware layer indicator only).
 */
export function renderLighting({ slotStatuses, ambientSummary }) {
  return {
    threads: slotStatuses.map(threadStyleFor),
    ambientZone: ambientStyleFor(ambientSummary),
  };
}
