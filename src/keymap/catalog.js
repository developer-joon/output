import { createRequire } from 'node:module';

/**
 * 키코드 카탈로그 — Input 앱 번들에서 읽기 전용으로 추출한 목록 (2026-09-25).
 *
 * Output 레이어는 이 목록 안의 값만 가진다 (validateConfig). 사용자 레이어의 모르는 값은 보존한다.
 * 매크로 참조(KA_n 액션, KM_n 멀티액션, SA_n 스마트액션)는 인덱스형이라 패턴으로 알아보고 보존한다.
 */
const require = createRequire(import.meta.url);
const raw = require('./keycodes.json');

export const CATALOG = Object.freeze({
  kc: Object.freeze([...raw.kc]),
  kv: Object.freeze([...raw.kv]),
  ki: Object.freeze([...raw.ki]),
});

const KNOWN = new Set([...CATALOG.kc, ...CATALOG.kv, ...CATALOG.ki]);

export function isKnownKeycode(code) {
  return KNOWN.has(code);
}

export function isMacroRef(code) {
  return typeof code === 'string' && /^(KA|KM|SA)_\d+$/.test(code);
}
