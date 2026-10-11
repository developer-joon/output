/**
 * LED 배열 index → 물리 위치 매핑 측정 (--leds v3).
 *
 * 실기 6차 확정: v.oai.thstatus는 13개 요소 배열을 받고 **배열 위치가 곧 키**다.
 * 따라서 한 키씩 물을 필요가 없다. 13색을 한 번에 칠하고 행별로 색만 읽으면
 * 질문 4번으로 전체 매핑이 나온다.
 *
 * 구분이 어려운 색은 `?`로 답할 수 있고, 그 index만 단독 점등으로 다시 확인한다.
 */
import { KEYS_PER_ROW, KEY_COUNT, expectedPositionOf, describePosition, agLabel } from './layout.js';
import { BASE } from './paramProbe.js';

/** 13개 구분 가능한 색. 순서가 곧 배열 index다. */
export const PALETTE = Object.freeze([
  { key: 'RED', ko: '빨강', hex: 0xff0000, aliases: ['red', '적색'] },
  { key: 'GREEN', ko: '초록', hex: 0x00ff00, aliases: ['green', '녹색'] },
  { key: 'BLUE', ko: '파랑', hex: 0x0000ff, aliases: ['blue', '청색'] },
  { key: 'YELLOW', ko: '노랑', hex: 0xffff00, aliases: ['yellow', '노란'] },
  { key: 'MAGENTA', ko: '자홍', hex: 0xff00ff, aliases: ['magenta', '마젠타'] },
  { key: 'CYAN', ko: '청록', hex: 0x00ffff, aliases: ['cyan', '시안'] },
  { key: 'WHITE', ko: '흰색', hex: 0xffffff, aliases: ['white', '하양', '흰'] },
  { key: 'ORANGE', ko: '주황', hex: 0xff8000, aliases: ['orange'] },
  { key: 'PURPLE', ko: '보라', hex: 0x8000ff, aliases: ['purple', '자주'] },
  { key: 'PINK', ko: '분홍', hex: 0xff80c0, aliases: ['pink', '핑크'] },
  { key: 'LIME', ko: '연두', hex: 0x80ff00, aliases: ['lime'] },
  { key: 'SKY', ko: '하늘', hex: 0x80c0ff, aliases: ['sky', '하늘색'] },
  { key: 'GRAY', ko: '회색', hex: 0x808080, aliases: ['gray', 'grey'] },
]);

/** 13개 키를 서로 다른 색으로. 배열 위치가 곧 키다. */
export function rainbowPayload() {
  return PALETTE.map((p, i) => ({ id: i, c: p.hex, ...BASE }));
}

/** 한 index만 켜고 나머지는 끈다 (모호한 키 재확인용). */
export function singlePayload(index, color = 0xffffff) {
  return PALETTE.map((_, i) => (i === index
    ? { id: i, c: color, ...BASE }
    : { id: i, c: 0, b: 0, e: 0, s: BASE.s, sk: 0, sa: 0 }));
}

const NAME_TO_KEY = (() => {
  const m = new Map();
  for (const p of PALETTE) {
    m.set(p.ko, p.key);
    m.set(p.key.toLowerCase(), p.key);
    for (const a of p.aliases) m.set(a.toLowerCase(), p.key);
  }
  return m;
})();

/** 색 이름 하나를 파싱. '?'와 '없음'은 미상/변화없음. */
export function parseColorToken(token) {
  const t = String(token ?? '').trim().toLowerCase();
  if (t === '') return null;
  if (t === '?' || t === 'x') return { kind: 'unknown' };
  if (t === '-' || t === '없음' || t === 'off' || t === 'n') return { kind: 'none' };
  const key = NAME_TO_KEY.get(t);
  return key ? { kind: 'color', key } : null;
}

/**
 * 한 행의 답을 파싱한다. 쉼표/공백 구분.
 * @returns {Array<{kind:string,key?:string}>|null} 개수가 안 맞으면 null
 */
export function parseRowAnswer(raw, count) {
  const t = String(raw ?? '').trim();
  if (t.toLowerCase() === 'q') return { abort: true };
  if (t.toLowerCase() === 's') return { skip: true };
  // 행 전체가 안 켜진 경우: '-' 하나 또는 '없음' 한 단어로 받는다
  const allNone = ['-', '없음', '전부없음', '안켜짐', '전부안켜짐', 'none', 'off'];
  if (allNone.includes(t.toLowerCase().replace(/\s+/g, ''))) {
    return Array.from({ length: count }, () => ({ kind: 'none' }));
  }
  const tokens = t.split(/[,\s]+/).filter(Boolean);
  if (tokens.length !== count) return null;
  const parsed = tokens.map(parseColorToken);
  if (parsed.some((p) => p === null)) return null;
  return parsed;
}

/**
 * 행별 답 → index별 물리 위치.
 * @param {Array<Array<{kind,key}>|null>} rows 4개 행. null이면 건너뜀.
 * @returns {{mapping:object, duplicates:string[], unseen:number[], unknownAt:object[]}}
 */
export function buildMapping(rows) {
  const mapping = {};        // index → {row, col}
  const seenColor = new Map(); // colorKey → [{row,col}]
  const unknownAt = [];      // 사용자가 ?로 답한 물리 위치
  const noneAt = [];         // 변화 없다고 답한 물리 위치

  rows.forEach((row, r) => {
    if (!row) return;
    row.forEach((cell, c) => {
      const pos = { row: r + 1, col: c + 1 };
      if (cell.kind === 'unknown') { unknownAt.push(pos); return; }
      if (cell.kind === 'none') { noneAt.push(pos); return; }
      if (!seenColor.has(cell.key)) seenColor.set(cell.key, []);
      seenColor.get(cell.key).push(pos);
    });
  });

  const duplicates = [];
  for (const [key, positions] of seenColor) {
    if (positions.length > 1) { duplicates.push(key); continue; }
    const index = PALETTE.findIndex((p) => p.key === key);
    if (index >= 0) [mapping[index]] = positions;
  }

  const answeredRows = rows.filter(Boolean).length;
  const unseen = answeredRows === KEYS_PER_ROW.length
    ? PALETTE.map((_, i) => i).filter((i) => !(i in mapping)
      && !duplicates.includes(PALETTE[i].key))
    : [];

  return { mapping, duplicates, unseen, unknownAt, noneAt };
}

/** 측정된 매핑이 계약의 기대 위치와 맞는지. */
export function compareMapping(mapping) {
  const rows = [];
  for (const [indexStr, measured] of Object.entries(mapping)) {
    const index = Number(indexStr);
    const expected = expectedPositionOf(index);
    rows.push({
      index,
      measured,
      expected,
      matches: Boolean(expected) && expected.row === measured.row && expected.col === measured.col,
    });
  }
  rows.sort((a, b) => a.index - b.index);
  const mismatches = rows.filter((r) => !r.matches);
  return {
    checked: rows.length,
    rows,
    mismatches,
    messageKo: rows.length === 0 ? '측정된 키가 없습니다.'
      : mismatches.length === 0
        ? `${rows.length}개 전부 계약의 기대 위치와 일치합니다.`
        : `${rows.length}개 중 ${mismatches.length}개가 계약의 기대 위치와 다릅니다.`,
  };
}

/**
 * @param {object} io
 * @param {(payload:any)=>Promise<any>} io.paint
 * @param {(q:string)=>Promise<string>} io.ask
 * @param {(ms:number)=>Promise<void>} io.sleep
 * @param {(l:string)=>void} io.print
 */
export async function runRainbowMap(io, { settleMs = 500, resolveAmbiguous = true } = {}) {
  io.print('13개 키를 서로 다른 색으로 칠합니다. 색 이름:');
  io.print(`  ${PALETTE.map((p) => p.ko).join(' · ')}`);
  io.print('구분이 안 되면 ? · 변화가 없으면 - 로 답해 주세요.\n');

  await io.paint(rainbowPayload());
  await io.sleep(settleMs);

  const rows = [];
  let aborted = false;
  for (let r = 0; r < KEYS_PER_ROW.length; r += 1) {
    const count = KEYS_PER_ROW[r];
    let parsed = null;
    while (parsed === null) {
      const raw = await io.ask(
        `  ${r + 1}행 ${count}개 키의 색을 왼쪽부터 알려주세요 (쉼표 구분)\n`
        + `  건너뛰기 s · 중단 q > `,
      );
      parsed = parseRowAnswer(raw, count);
      if (parsed === null) {
        io.print(`  색 이름 ${count}개가 필요합니다. 예: ${PALETTE.slice(0, count).map((p) => p.ko).join(',')}`);
        io.print('  이 행이 전부 안 켜져 있으면 - 한 글자만 입력하세요.');
      }
    }
    if (parsed.abort) { aborted = true; break; }
    rows.push(parsed.skip ? null : parsed);
  }
  while (rows.length < KEYS_PER_ROW.length) rows.push(null);

  const built = buildMapping(rows);

  // 모호하거나 중복된 index만 단독 점등으로 다시 확인한다.
  const ambiguous = [
    ...built.unseen,
    ...built.duplicates.map((k) => PALETTE.findIndex((p) => p.key === k)),
  ].filter((i) => i >= 0 && !(i in built.mapping));

  const resolved = [];
  if (resolveAmbiguous && !aborted && ambiguous.length) {
    io.print(`\n  ${ambiguous.length}개 키가 확정되지 않았습니다. 하나씩 단독 점등합니다.`);
    for (const index of ambiguous) {
      await io.paint(singlePayload(index));
      await io.sleep(settleMs);
      let pos = null;
      while (pos === null) {
        const raw = await io.ask(
          `  배열 ${index}번만 흰색으로 켰습니다. 몇 행 몇 열입니까? `
          + '(예: 2,3 · 안 보이면 - · 중단 q) > ',
        );
        const t = String(raw ?? '').trim().toLowerCase();
        if (t === 'q') { pos = { abort: true }; break; }
        if (t === '-' || t === 'n') { pos = { none: true }; break; }
        const m = /(\d)\s*[,\s]\s*(\d)/.exec(t);
        if (m) {
          const row = Number(m[1]); const col = Number(m[2]);
          if (row >= 1 && row <= KEYS_PER_ROW.length && col >= 1 && col <= KEYS_PER_ROW[row - 1]) {
            pos = { row, col };
          }
        }
        if (pos === null) io.print('  「행,열」 형식으로 답해 주세요.');
      }
      if (pos.abort) { aborted = true; break; }
      if (pos.none) { resolved.push({ index, none: true }); continue; }
      built.mapping[index] = { row: pos.row, col: pos.col };
      resolved.push({ index, ...pos });
    }
  }

  return {
    rows,
    mapping: built.mapping,
    duplicates: built.duplicates,
    unknownAt: built.unknownAt,
    noneAt: built.noneAt,
    resolved,
    aborted,
    comparison: compareMapping(built.mapping),
  };
}

export function formatRainbowReport(result) {
  const { mapping, comparison, aborted, duplicates, unknownAt, noneAt } = result;
  const L = [];
  L.push('');
  L.push('── LED 배열 index → 물리 위치 ──');
  L.push('  괄호 안 AG 번호는 계약의 가정일 뿐입니다.');
  L.push('  LED 배열 index와 키 이벤트의 AG 번호가 같은지는 --input 으로 대조해야 합니다.');
  for (let i = 0; i < KEY_COUNT; i += 1) {
    const m = mapping[i];
    const exp = expectedPositionOf(i);
    if (!m) {
      L.push(`  index ${String(i).padStart(2)} (${agLabel(i)})  미확정`);
      continue;
    }
    const ok = exp && exp.row === m.row && exp.col === m.col;
    L.push(`  index ${String(i).padStart(2)} (${agLabel(i)})  ${m.row}행 ${m.col}열  `
      + (ok ? `일치 (${exp.logical})` : `⚠ 계약 기대값 ${describePosition(exp)}`));
  }
  if (duplicates.length) L.push(`  ⚠ 같은 색이 여러 곳에 보고됨: ${duplicates.join(', ')}`);
  if (unknownAt.length) L.push(`  ? 로 답한 위치: ${unknownAt.map((p) => `${p.row},${p.col}`).join(' ')}`);
  if (noneAt.length) L.push(`  변화 없다고 답한 위치: ${noneAt.map((p) => `${p.row},${p.col}`).join(' ')}`);
  if (aborted) L.push('  ⚠ 중단됨 — 나머지는 미측정입니다.');
  L.push('');
  L.push(`  판정: ${comparison.messageKo}`);
  for (const m of comparison.mismatches) {
    L.push(`    index ${m.index}: 실측 ${m.measured.row},${m.measured.col}`
      + ` ≠ 기대 ${describePosition(m.expected)}`);
  }
  return L.join('\n');
}
