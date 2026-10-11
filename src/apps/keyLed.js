/**
 * 키 LED 설정 (스펙 2026-10-04-key-led-design). 값 표와 변환을 한곳에 모은다 — 실기 뒤 숫자만 바꾸면 된다.
 * 장치 근거(실기 2026-10-02): thstatus e 1 고정 · 3 색이 돌아감 · 4 꺼졌다 켜짐 · 6 연해졌다 진해짐, s = 속도.
 */
export const LED_EFFECT_E = Object.freeze({ solid: 1, breathe: 6, blink: 4, rainbow: 3 });
export const LED_SPEED_S = Object.freeze({ slow: 0.3, normal: 0.6, fast: 0.9 });
// 하 30% · 중 60% · 상 100% (2026-10-10 실기 비교로 사용자 결정). LED 설정이 없는 키도 중 밝기
export const LED_BRIGHTNESS = Object.freeze({ low: 0.3, mid: 0.6, high: 1 });
export const PRESS_MS = Object.freeze({ short: 150, normal: 300, long: 600 });

const HEX_RE = /^#[0-9a-f]{6}$/i;
const pick = (v, table, fallback) => (Object.hasOwn(table, v) ? v : fallback);
const color = (v, fallback) => (v === 'layer' ? 'layer' : HEX_RE.test(v ?? '') ? v.toUpperCase() : fallback);

function normalPart(r, d) {
  return {
    color: color(r?.color, d.color),
    effect: pick(r?.effect, LED_EFFECT_E, d.effect),
    speed: pick(r?.speed, LED_SPEED_S, d.speed),
    brightness: pick(r?.brightness, LED_BRIGHTNESS, d.brightness),
  };
}

const NORMAL = { color: 'layer', effect: 'solid', speed: 'normal', brightness: 'mid' };
const HOLD = { color: 'layer', effect: 'solid', speed: 'normal', brightness: 'high' };
const PRESS = { color: '#FFFFFF', brightness: 'high', duration: 'short' };

/** 레이어 언더글로우 (2026-10-10): 키 LED 평소와 같은 칸. 기본은 레이어 색 고정·강 */
export const UNDERGLOW_DEFAULT = Object.freeze({ color: 'layer', effect: 'solid', speed: 'normal', brightness: 'high' });
export function normalizeUnderglow(raw) {
  // 색은 늘 레이어 색 (2026-10-10 사용자 결정: 레이어 색 = 언더글로우 색). 움직임·속도·밝기만 레이어마다
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...normalPart(raw, UNDERGLOW_DEFAULT), color: 'layer' } : null;
}

/** 동작의 led 정리. 객체가 아니면 null(LED 설정 없음) */
/** 키 LED 기본 색 팔레트 (2026-10-09 사용자 요청: 키마다 기본 색은 무작위). 서로 잘 구별되는 진한 색 */
export const KEY_COLOR_PALETTE = Object.freeze([
  '#E8762B', '#5A8CDC', '#1F9E96', '#D6336C', '#8B6BC4', '#3E9B5A', '#D9A21B', '#E0481F', '#2BB3E8', '#C44BD6',
]);

/** 새 키의 기본 색: 레이어에서 아직 안 쓴 색 가운데 무작위, 다 쓰면 팔레트 전체에서 무작위 */
export function pickKeyColor(usedColors = [], rand = Math.random) {
  const used = new Set(usedColors.map((c) => String(c).toUpperCase()));
  const free = KEY_COLOR_PALETTE.filter((c) => !used.has(c));
  const pool = free.length ? free : KEY_COLOR_PALETTE;
  return pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];
}

export function normalizeLed(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const press = raw.press && typeof raw.press === 'object' ? {
    color: color(raw.press.color, PRESS.color),
    brightness: pick(raw.press.brightness, LED_BRIGHTNESS, PRESS.brightness),
    duration: pick(raw.press.duration, PRESS_MS, PRESS.duration),
  } : null;
  return {
    normal: normalPart(raw.normal, NORMAL),
    press,
    hold: raw.hold && typeof raw.hold === 'object' ? normalPart(raw.hold, HOLD) : null,
  };
}

/** LED 설정 한 부분 → 장면 키 스타일. press에는 움직임·속도가 없어 고정 */
export function ledStyle(part, layerColor) {
  return {
    color: part.color === 'layer' ? layerColor : part.color,
    brightness: LED_BRIGHTNESS[part.brightness] ?? LED_BRIGHTNESS.mid,
    e: LED_EFFECT_E[part.effect] ?? LED_EFFECT_E.solid,
    s: LED_SPEED_S[part.speed] ?? LED_SPEED_S.normal,
  };
}

export function pressMs(press) {
  return PRESS_MS[press?.duration] ?? PRESS_MS.short;
}
