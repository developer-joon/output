/**
 * 창 위치 이름 → 화면 작업 영역(메뉴바·Dock 제외) 기준 좌표 (스펙 §2).
 * 순수 함수. 실제로 옮기는 일은 macos.js가 한다.
 */
export const POSITIONS = Object.freeze([
  'full', 'center', 'left', 'right', 'top', 'bottom',
  'top_left', 'top_right', 'bottom_left', 'bottom_right',
  'left_third', 'center_third', 'right_third', 'left_two_thirds', 'right_two_thirds',
]);

// [x, y, w, h] 작업 영역 비율
const FRACTIONS = Object.freeze({
  full: [0, 0, 1, 1], center: [0.2, 0.2, 0.6, 0.6],
  left: [0, 0, 0.5, 1], right: [0.5, 0, 0.5, 1], top: [0, 0, 1, 0.5], bottom: [0, 0.5, 1, 0.5],
  top_left: [0, 0, 0.5, 0.5], top_right: [0.5, 0, 0.5, 0.5], bottom_left: [0, 0.5, 0.5, 0.5], bottom_right: [0.5, 0.5, 0.5, 0.5],
  left_third: [0, 0, 1 / 3, 1], center_third: [1 / 3, 0, 1 / 3, 1], right_third: [2 / 3, 0, 1 / 3, 1],
  left_two_thirds: [0, 0, 2 / 3, 1], right_two_thirds: [1 / 3, 0, 2 / 3, 1],
});

export function rectFor(position, wa) {
  const [fx, fy, fw, fh] = FRACTIONS[position] ?? FRACTIONS.full;
  const x = wa.x + Math.round(wa.width * fx);
  const y = wa.y + Math.round(wa.height * fy);
  const right = wa.x + Math.round(wa.width * (fx + fw));
  const bottom = wa.y + Math.round(wa.height * (fy + fh));
  return { x, y, width: right - x, height: bottom - y };
}

/** 모니터를 이만큼까지 번호로 고를 수 있다 */
export const MAX_DISPLAYS = 6;

/**
 * 모니터 번호 (2026-10-12): 1 = 주 모니터(메뉴 막대가 있는 화면), 나머지는 시스템이 주는 순서.
 * 화면 캡처(screencapture -D)와 같은 번호라 세 동작(캡처·앞 창 위치·레이아웃)이 같은 모니터를 가리킨다.
 */
export function numberDisplays(displays = []) {
  const primary = displays.find((d) => d.primary) ?? displays[0];
  if (!primary) return [];
  return [primary, ...displays.filter((d) => d !== primary)].map((d, i) => ({ ...d, n: i + 1 }));
}

/** @returns {object|null} 작업 영역. 화면 정보가 없으면 null, 없는 번호는 주 모니터 */
export function pickDisplay(displays, display) {
  const list = numberDisplays(displays);
  if (!list.length) return null;
  const n = display === 'main' ? 1 : display;
  return (list.find((d) => d.n === n) ?? list[0]).workArea;
}
