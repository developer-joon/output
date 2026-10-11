/**
 * 호스트에 남기는 것의 모양 (M5 설계 §9).
 *
 * 남기는 것: 사용자의 의도 — 슬롯 배치, 핀, 확인 이력 — 와 표시에 필요한 최소 정보.
 * 남기지 않는 것: 관측한 사실 — 상태, 색, 대기 시각, children. 다시 관측하면 된다.
 * prompt/preview/toolInput 같은 내용물은 어떤 경우에도 넣지 않는다 (AGENTS.md 12).
 */
export const SCHEMA_VERSION = 1;

export function emptyState() {
  return { version: SCHEMA_VERSION, savedAt: 0, slots: [], acks: [] };
}

const isStr = (v) => typeof v === 'string' && v.length > 0;
const isInt = (v) => Number.isInteger(v);

/** @returns {{ok:boolean, errorsKo:string[]}} */
export function validateState(obj) {
  const errorsKo = [];
  if (!obj || typeof obj !== 'object') return { ok: false, errorsKo: ['상태가 객체가 아닙니다.'] };
  if (!isInt(obj.version)) errorsKo.push('version이 정수가 아닙니다.');
  if (!isInt(obj.savedAt) || obj.savedAt < 0) errorsKo.push('savedAt이 올바르지 않습니다.');
  if (!Array.isArray(obj.slots)) errorsKo.push('slots가 배열이 아닙니다.');
  if (!Array.isArray(obj.acks)) errorsKo.push('acks가 배열이 아닙니다.');
  if (errorsKo.length) return { ok: false, errorsKo };

  const seenIds = new Set();
  const seenIdx = new Set();
  obj.slots.forEach((s, i) => {
    const at = `slots[${i}]`;
    if (!s || typeof s !== 'object') { errorsKo.push(`${at}: 객체가 아닙니다.`); return; }
    if (!isStr(s.id)) errorsKo.push(`${at}.id가 비어 있습니다.`);
    if (!isInt(s.globalIndex) || s.globalIndex < 0) errorsKo.push(`${at}.globalIndex가 0 이상의 정수가 아닙니다.`);
    if (typeof s.title !== 'string') errorsKo.push(`${at}.title이 문자열이 아닙니다.`);
    if (!isStr(s.source)) errorsKo.push(`${at}.source가 비어 있습니다.`);
    if (!isStr(s.kind)) errorsKo.push(`${at}.kind가 비어 있습니다.`);
    if (typeof s.pinned !== 'boolean') errorsKo.push(`${at}.pinned가 불리언이 아닙니다.`);
    if (seenIds.has(s.id)) errorsKo.push(`${at}.id가 중복입니다: ${s.id}`);
    if (seenIdx.has(s.globalIndex)) errorsKo.push(`${at}.globalIndex가 중복입니다: ${s.globalIndex}`);
    seenIds.add(s.id);
    seenIdx.add(s.globalIndex);
  });
  obj.acks.forEach((a, i) => {
    const at = `acks[${i}]`;
    if (!a || typeof a !== 'object') { errorsKo.push(`${at}: 객체가 아닙니다.`); return; }
    if (!isStr(a.unitId)) errorsKo.push(`${at}.unitId가 비어 있습니다.`);
    if (!(a.childId === null || isStr(a.childId))) errorsKo.push(`${at}.childId가 올바르지 않습니다.`);
    if (!isStr(a.kind)) errorsKo.push(`${at}.kind가 비어 있습니다.`);
    if (!(a.runId === null || isStr(a.runId))) errorsKo.push(`${at}.runId가 올바르지 않습니다.`);
    if (!isInt(a.acknowledgedAt) || a.acknowledgedAt < 0) errorsKo.push(`${at}.acknowledgedAt이 올바르지 않습니다.`);
  });
  return { ok: errorsKo.length === 0, errorsKo };
}
