/**
 * 물리 배치 공용 헬퍼. HARDWARE_CONTRACT.md에서 유도한다.
 * 계약이 말하는 '기대값'이지 측정된 사실이 아니다.
 */
import { PHYSICAL_ROWS, LOGICAL_TO_AG } from '../../src/core/hardware.js';

/** 실기 16차(2026-09-26): Output 레이어는 13키 전부 KV_OAI_AG. ACT는 LED 채널이 없어 쓰지 않는다. */
// eslint-disable-next-line no-unused-vars
export function familyOf(index) {
  return 'AG';
}

export function agLabel(index) {
  return `AG${String(index).padStart(2, '0')}`;
}

export function keycodeOf(index) {
  return `KV_OAI_${familyOf(index)}${String(index).padStart(2, '0')}`;
}

/** mini LED·노브·조이스틱을 뺀 '키'만 */
const KEY_LOGICALS = Object.freeze(
  PHYSICAL_ROWS.map((row) => row.filter(
    (cell) => cell !== 'dial' && cell !== 'joystick' && cell !== 'mini_led_x3',
  )),
);

export const KEYS_PER_ROW = Object.freeze(KEY_LOGICALS.map((r) => r.length));
export const KEY_COUNT = KEYS_PER_ROW.reduce((a, b) => a + b, 0);

/** 행/열(1-based) → 논리 역할 */
export function logicalAt(row, col) {
  return KEY_LOGICALS[row - 1]?.[col - 1] ?? null;
}

/** @returns {Map<number, {row:number, col:number, logical:string}>} AG 번호 → 기대 위치 */
export function expectedPositions() {
  const out = new Map();
  KEY_LOGICALS.forEach((row, r) => {
    row.forEach((logical, c) => {
      const ag = LOGICAL_TO_AG[logical];
      if (!ag) return;
      out.set(Number(ag.slice(2)), { row: r + 1, col: c + 1, logical });
    });
  });
  return out;
}

export function expectedPositionOf(index) {
  return expectedPositions().get(index) ?? null;
}

export function describePosition(pos) {
  if (!pos) return '(위치 미상)';
  return `${pos.row}행 ${pos.col}열${pos.logical ? ` (${pos.logical})` : ''}`;
}

/** 읽기 순서(왼→오른, 위→아래)로 매긴 일련번호 ↔ 행/열 */
export function readingOrderPositions() {
  const out = [];
  KEYS_PER_ROW.forEach((n, r) => {
    for (let c = 1; c <= n; c += 1) out.push({ row: r + 1, col: c, logical: logicalAt(r + 1, c) });
  });
  return out;
}
