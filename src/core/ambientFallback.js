import { Status, isAttention } from './types.js';
import { AMBIENT_STYLE } from './lightingPolicy.js';

/**
 * underglow 대체 표현 (실기 7차: ambient zone 제어 수단 없음).
 *
 * 숨은 묶음의 개입을 슬롯 LED의 **짧은 점멸**로 알린다.
 *
 * 지켜야 할 것:
 *  - 보이는 칸의 '의미'를 바꾸지 않는다. 점멸은 짧고, 꺼진 위상에서는 원래 색이다.
 *  - 정보를 덮지 않는다. 빈 슬롯이 있으면 그쪽을 먼저 쓴다.
 *  - 이미 보이는 개입에는 점멸하지 않는다. 화면에 있는 것을 또 알릴 이유가 없다.
 *  - 확인 대상(DONE_UNSEEN)만 있을 때는 점멸하지 않는다. 개입이 아니다.
 */

/** 한 주기 중 켜져 있는 구간의 비율. 짧아야 '깜빡임'으로 읽힌다. */
export const DUTY = 0.2;
export const DEFAULT_PERIOD_MS = 1600;

/** 위상(0~1) → 켜짐 여부 */
export function isOnPhase(phase, duty = DUTY) {
  const p = ((phase % 1) + 1) % 1;
  return p < duty;
}

/**
 * @param {object} args
 * @param {string[]} args.slotStatuses 보이는 칸의 상태
 * @param {string|null} args.ambientSummary 전체 요약 상태
 * @param {number} args.hiddenAttentionCount 보이지 않는 개입 수
 * @returns {{active:boolean, targets:number[], style:object|null, reasonKo:string}}
 */
export function planAmbientFallback({
  slotStatuses = [], ambientSummary = null, hiddenAttentionCount = 0,
}) {
  if (!hiddenAttentionCount) {
    return { active: false, targets: [], style: null, reasonKo: '보이지 않는 개입이 없습니다.' };
  }
  if (!ambientSummary || !isAttention(ambientSummary)) {
    return {
      active: false, targets: [], style: null,
      reasonKo: '개입이 아니라 확인 대상뿐이라 점멸하지 않습니다.',
    };
  }

  const style = AMBIENT_STYLE[ambientSummary] ?? null;
  if (!style) {
    return { active: false, targets: [], style: null, reasonKo: '해당 상태의 색이 없습니다.' };
  }

  // 빈 슬롯이 있으면 그쪽만 쓴다 — 아무 정보도 덮지 않는다.
  const empty = slotStatuses
    .map((st, i) => (st === Status.EMPTY ? i : -1))
    .filter((i) => i >= 0);
  if (empty.length) {
    return {
      active: true, targets: empty, style,
      reasonKo: `빈 슬롯 ${empty.length}개로 숨은 개입 ${hiddenAttentionCount}건을 알립니다.`,
    };
  }

  // 빈 슬롯이 없으면 보이는 칸 전체를 짧게 스친다. 위상이 꺼지면 원래 색으로 돌아온다.
  return {
    active: true,
    targets: slotStatuses.map((_, i) => i),
    style,
    reasonKo: `빈 슬롯이 없어 ${slotStatuses.length}키를 짧게 점멸해 숨은 개입 ${hiddenAttentionCount}건을 알립니다.`,
  };
}

/**
 * 실제로 이번 프레임에 덧칠할 슬롯.
 * @returns {{indices:number[], style:object|null, plan:object}}
 */
export function ambientOverlay(args, phase) {
  const plan = planAmbientFallback(args);
  if (!plan.active || !isOnPhase(phase)) {
    return { indices: [], style: null, plan };
  }
  return { indices: plan.targets, style: plan.style, plan };
}
