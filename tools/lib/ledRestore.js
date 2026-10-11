/**
 * LED 복구.
 *
 * 실기 6차 관측:
 *   - 배열 위치가 키를 정한다 (13개를 한 번에 보내야 한다)
 *   - 빈 배열 []은 아무 효과가 없다 (해제 수단이 아니다)
 *   - 밝기 0은 소등일 뿐 기본색 복구가 아니다
 *
 * 따라서 '기본색으로 되돌리기'는 아직 방법이 없다.
 * 대신 레이어 색을 13개 키에 직접 칠해 눈에 보이는 상태를 되살린다.
 * 이것은 override이지 진짜 복구가 아니며, 그 사실을 숨기지 않는다.
 */
import { KEY_COUNT } from './layout.js';
import { BASE } from './paramProbe.js';

export { KEY_COUNT };

/**
 * 색 값을 정수로 정규화한다.
 * 장치 keymap은 10진수(예: 16711680), 동반 앱 export는 '#F00' 같은 문자열을 준다.
 */
export function parseHexColor(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffff) {
    return value;
  }
  const t = String(value ?? '').trim();
  const six = /^#?([0-9a-f]{6})$/i.exec(t);
  if (six) return parseInt(six[1], 16);
  // '#F00' 축약형도 장치 export에 실제로 나온다
  const three = /^#([0-9a-f]{3})$/i.exec(t);
  if (three) {
    const [r, g, b] = three[1].split('');
    return parseInt(`${r}${r}${g}${g}${b}${b}`, 16);
  }
  const dec = /^\d+$/.test(t) ? Number(t) : NaN;
  if (Number.isInteger(dec) && dec >= 0 && dec <= 0xffffff) return dec;
  return null;
}

/** 16711680 → '#FF0000' */
export function toHexString(color) {
  if (typeof color !== 'number') return String(color);
  return `#${color.toString(16).padStart(6, '0').toUpperCase()}`;
}

/** 13개 키를 같은 색으로 칠하는 payload. */
export function uniformPayload(color) {
  return Array.from({ length: KEY_COUNT }, (_, i) => ({ id: i, c: color, ...BASE }));
}

/** 13개 키를 끄는 payload. */
export function offPayload() {
  return Array.from({ length: KEY_COUNT }, (_, i) => ({
    id: i, c: 0, b: 0, e: 0, s: BASE.s, sk: 0, sa: 0,
  }));
}

/**
 * 복구에 쓸 색을 정한다.
 * 우선순위: 명시값 → 활성 레이어 색 → null(알 수 없음)
 * @returns {{color:number|null, sourceKo:string}}
 */
export function resolveRestoreColor({ explicit = null, activeLayerColor = null } = {}) {
  if (explicit !== null) {
    const c = parseHexColor(explicit);
    if (c === null) return { color: null, sourceKo: `색 형식을 알 수 없습니다: ${explicit}` };
    return { color: c, sourceKo: `지정한 색 ${toHexString(c)}` };
  }
  if (activeLayerColor) {
    const c = parseHexColor(activeLayerColor);
    if (c !== null) return { color: c, sourceKo: `활성 레이어 색 ${toHexString(c)}` };
  }
  return { color: null, sourceKo: '활성 레이어 색을 알 수 없습니다' };
}
