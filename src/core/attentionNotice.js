import { isAttention } from './types.js';

/**
 * 새 개입이 생겼다는 것만 알리는 짧은 점멸.
 *
 * 왜 필요한가:
 * 승인이 연달아 오면 상태 값은 계속 WAITING_APPROVAL이다. 색이 변하지 않으니
 * "아직 그대로다"와 "새로 하나 더 생겼다"가 사람 눈에 똑같이 보인다.
 * 이 둘은 다른 사건이므로 구분해 준다.
 *
 * 지키는 것:
 *  - **색은 바꾸지 않는다.** 색은 상태를 말하는 것이고 상태는 안 변했다.
 *    같은 색과 꺼짐을 번갈아 할 뿐이다.
 *  - 짧게 끝난다. 계속 깜빡이면 그게 곧 배경이 되어 아무 말도 하지 않게 된다.
 *  - 개입 상태에만 쓴다. 완료는 확인 대상이지 개입 대상이 아니므로 깜빡이지 않는다.
 *  - 백라이트에는 쓰지 않는다 (LIGHTING_POLICY: profile 색에 fast blink 금지).
 */

/** 새 개입으로 보는 시간. 이 안에서만 깜빡인다. */
export const NOTICE_WINDOW_MS = 1500;

/**
 * 깜빡임 반주기. 창 안에서 다섯 번 깜빡인다.
 *
 * ambient 점멸 시계(1600ms)를 그대로 쓰면 창 안에서 한 번밖에 못 바뀐다 —
 * 그건 깜빡임이 아니라 '한 번 꺼짐'이고, 실기에서 눈에 띄지 않았다 (13차).
 */
export const NOTICE_BLINK_MS = 150;

/**
 * 지금 알릴 슬롯의 인덱스.
 *
 * `attentionSince`는 어댑터가 관측한 개입 진입 시각이다 (우리 시계가 아니다).
 * 0이면 모른다는 뜻이므로 알리지 않는다 — 모르면 조용히 있는다.
 *
 * @param {{slots:{status:string, attentionSince?:number}[], now:number, windowMs?:number}} arg
 * @returns {number[]}
 */
export function freshNoticeSlots({ slots = [], now, windowMs = NOTICE_WINDOW_MS }) {
  const out = [];
  slots.forEach((s, i) => {
    const since = s?.attentionSince ?? 0;
    if (!since) return;
    if (!isAttention(s.status)) return;
    if (now - since >= windowMs) return;
    out.push(i);
  });
  return out;
}

/**
 * 개입이 시작된 뒤 얼마나 지났는지로만 정한다.
 *
 * 전역 위상 시계를 쓰지 않는 이유: 알림이 시작될 때 위상이 어디였느냐에 따라
 * 한 번도 안 깜빡이고 끝날 수 있다. 슬롯마다 자기 시각으로 세면 그런 일이 없고,
 * 서로 다른 때 들어온 개입이 각자의 박자로 깜빡인다.
 *
 * @param {number} elapsedMs 개입 진입 후 경과 시간
 */
export function noticeOverlay(elapsedMs) {
  return { off: Math.floor(elapsedMs / NOTICE_BLINK_MS) % 2 === 1 };
}
