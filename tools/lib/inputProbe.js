/**
 * doctor --input — 키/노브/조이스틱 이벤트 관측 (M3-6).
 *
 * 장치에 쓰지 않는다. 벤더 채널로 올라오는 알림을 받기만 한다.
 * 알림 형식을 모르므로 **원문을 그대로 기록**하고, 해석은 추론으로만 표시한다.
 *
 * 이 측정의 목적:
 *   1. 키 press/release 이벤트가 실제로 오는가 (H03)
 *   2. 노브 회전/클릭, 조이스틱 4방향이 오는가
 *   3. **이벤트의 식별자가 LED 배열 index와 같은가** (7차 미해결 질문)
 */
import { KEYS_PER_ROW, logicalAt, expectedPositions } from './layout.js';

/** 관측 순서. 물리 읽기 순서로 13키 → 노브 → 조이스틱. */
export function buildSteps() {
  const steps = [];
  KEYS_PER_ROW.forEach((n, r) => {
    for (let c = 1; c <= n; c += 1) {
      const logical = logicalAt(r + 1, c);
      steps.push({
        id: `key-${r + 1}-${c}`,
        kind: 'key',
        row: r + 1,
        col: c,
        logical,
        labelKo: `${r + 1}행 ${c}열 키 (${logical})`,
        actionKo: '짧게 눌렀다 떼세요',
      });
    }
  });
  steps.push(
    { id: 'dial-cw', kind: 'dial', labelKo: '노브 시계 방향', actionKo: '한 칸 돌리세요' },
    { id: 'dial-ccw', kind: 'dial', labelKo: '노브 반시계 방향', actionKo: '한 칸 돌리세요' },
    { id: 'dial-click', kind: 'dial', labelKo: '노브 누르기', actionKo: '눌러 보세요 (없을 수 있습니다)' },
    { id: 'joy-up', kind: 'joystick', labelKo: '조이스틱 위', actionKo: '위로 끝까지 밀었다 놓으세요' },
    { id: 'joy-down', kind: 'joystick', labelKo: '조이스틱 아래', actionKo: '아래로 끝까지 밀었다 놓으세요' },
    { id: 'joy-left', kind: 'joystick', labelKo: '조이스틱 왼쪽', actionKo: '왼쪽으로 끝까지 밀었다 놓으세요' },
    { id: 'joy-right', kind: 'joystick', labelKo: '조이스틱 오른쪽', actionKo: '오른쪽으로 끝까지 밀었다 놓으세요' },
  );
  return steps;
}

export const INPUT_STEPS = Object.freeze(buildSteps());

/** 객체를 경로→값으로 펼친다. 배열은 인덱스를 경로에 넣는다. */
export function flatten(obj, prefix = '', out = null) {
  // map(flatten) 처럼 index/array가 딸려 들어와도 누산기를 공유하지 않도록 방어한다
  if (typeof prefix !== 'string') prefix = '';
  if (out === null || typeof out !== 'object' || Array.isArray(out)) out = {};
  if (obj === null || typeof obj !== 'object') {
    out[prefix || '.'] = obj;
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    flatten(v, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

/** 서로 다른 '모양'(키 집합)을 센다. */
export function shapesOf(events) {
  const counts = new Map();
  for (const e of events) {
    const shape = Object.keys(flatten(e)).sort().join(',');
    counts.set(shape, (counts.get(shape) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/**
 * 키 단계들에서 '식별자로 쓸 만한 필드'를 추론한다.
 * 조건: 여러 키 단계에 존재하고, 단계마다 값이 다르고, 단계 안에서는 일정할 것.
 *
 * 실기 8차: 식별자가 문자열('AG00')이었다. 숫자만 보던 초기 구현은 이를 놓쳤다.
 * @returns {{field:string, byStep:object, distinct:number}|null}
 */
export function inferIdentifierField(records, steps = INPUT_STEPS) {
  const keySteps = steps.filter((s) => s.kind === 'key');
  const candidates = new Map(); // field → Map(stepId → Set(values))

  for (const step of keySteps) {
    const rec = records[step.id];
    if (!rec || !rec.events?.length) continue;
    for (const ev of rec.events) {
      for (const [path, value] of Object.entries(flatten(ev))) {
        if (typeof value !== 'number' && typeof value !== 'string') continue;
        if (!candidates.has(path)) candidates.set(path, new Map());
        const byStep = candidates.get(path);
        if (!byStep.has(step.id)) byStep.set(step.id, new Set());
        byStep.get(step.id).add(value);
      }
    }
  }

  let best = null;
  for (const [field, byStep] of candidates) {
    // 단계 안에서 값이 하나로 고정되어야 식별자다
    const stable = [...byStep.values()].every((set) => set.size === 1);
    if (!stable) continue;
    const values = [...byStep.values()].map((set) => [...set][0]);
    const distinct = new Set(values).size;
    if (distinct < 2) continue;
    const coverage = byStep.size;
    const score = distinct * 100 + coverage;
    if (!best || score > best.score) {
      best = {
        field,
        distinct,
        coverage,
        score,
        byStep: Object.fromEntries([...byStep].map(([k, set]) => [k, [...set][0]])),
      };
    }
  }
  if (!best) return null;
  return { field: best.field, byStep: best.byStep, distinct: best.distinct, coverage: best.coverage };
}

/**
 * 관측된 식별자를 번호로 바꾼다.
 * 실기 8차: 'AG00' / 'ACT06' 같은 문자열이었다. 숫자면 그대로 쓴다.
 * @returns {number|null}
 */
export function identifierToIndex(value) {
  if (typeof value === 'number') return value;
  const m = /^(?:AG|ACT)(\d{1,2})$/i.exec(String(value ?? '').trim());
  return m ? Number(m[1]) : null;
}

/**
 * 추론한 식별자가 계약의 AG 번호와 같은지 대조한다.
 * 같다면 LED 배열 index와 키 이벤트 번호의 관계도 정리된다.
 */
export function compareWithAgNumbers(identifier, steps = INPUT_STEPS) {
  if (!identifier) return null;
  const expected = expectedPositions();
  const posToAg = new Map();
  for (const [ag, pos] of expected) posToAg.set(`${pos.row}-${pos.col}`, ag);

  const rows = [];
  for (const step of steps.filter((s) => s.kind === 'key')) {
    if (!(step.id in identifier.byStep)) continue;
    const raw = identifier.byStep[step.id];
    const observed = identifierToIndex(raw);
    const contractAg = posToAg.get(`${step.row}-${step.col}`) ?? null;
    // 읽기 순서 일련번호 (LED 배열 index가 이 순서였다)
    const readingIndex = steps.filter((s) => s.kind === 'key').indexOf(step);
    rows.push({
      stepId: step.id,
      row: step.row,
      col: step.col,
      logical: step.logical,
      raw,
      observed,
      contractAg,
      readingIndex,
      matchesContract: observed === contractAg,
      matchesReadingOrder: observed === readingIndex,
    });
  }
  const contractHits = rows.filter((r) => r.matchesContract).length;
  const readingHits = rows.filter((r) => r.matchesReadingOrder).length;
  let conclusionKo = '대조할 데이터가 부족합니다.';
  if (rows.length) {
    if (contractHits === rows.length) {
      conclusionKo = '키 이벤트 번호가 계약의 AG 번호와 전부 일치합니다.';
    } else if (readingHits === rows.length) {
      conclusionKo = '키 이벤트 번호가 물리 읽기 순서와 전부 일치합니다 '
        + '(= LED 배열 index와 같은 체계).';
    } else {
      conclusionKo = `계약 AG와 ${contractHits}/${rows.length} 일치, `
        + `읽기 순서와 ${readingHits}/${rows.length} 일치 — 어느 쪽과도 완전히 맞지 않습니다.`;
    }
  }
  return { rows, contractHits, readingHits, conclusionKo };
}

/**
 * 노브 분석. 실기 8차: 시계 방향을 돌렸는데 'ENC_CC'가 왔다.
 * 이름과 방향이 어긋나 보이지만 단정하지 않는다 — 재확인이 필요하다.
 */
export function analyzeDial(records) {
  const pick = (id) => {
    const evs = records[id]?.events ?? [];
    const codes = [...new Set(evs.map((e) => flatten(e)['p.k']).filter(Boolean))];
    const acts = [...new Set(evs.map((e) => flatten(e)['p.act']).filter((v) => v !== undefined))];
    return { count: evs.length, codes, acts };
  };
  const cw = pick('dial-cw');
  const ccw = pick('dial-ccw');
  const click = pick('dial-click');

  const notesKo = [];
  if (click.count > 0) {
    notesKo.push(`노브 클릭이 실제로 이벤트를 냅니다 (${click.codes.join(',')}). `
      + 'HARDWARE_CONTRACT가 보류했던 항목이 해소되었습니다.');
  } else {
    notesKo.push('노브 클릭 이벤트가 관측되지 않았습니다 — 미검증으로 둡니다.');
  }

  // 코드 이름과 실제 방향의 대응. 양방향이 모두 와야 판정한다.
  let rotationNaming = 'unknown';
  if (cw.count && ccw.count) {
    const cwCode = cw.codes[0];
    const ccwCode = ccw.codes[0];
    if (cwCode === 'ENC_CW' && ccwCode === 'ENC_CC') {
      rotationNaming = 'as_named';
      notesKo.push('회전 코드 이름이 실제 방향과 일치합니다 (시계=ENC_CW).');
    } else if (cwCode === 'ENC_CC' && ccwCode === 'ENC_CW') {
      rotationNaming = 'inverted';
      notesKo.push('⚠ 회전 코드 이름이 실제 방향과 반대입니다: '
        + '시계 방향 → ENC_CC, 반시계 방향 → ENC_CW. '
        + '코드 이름을 믿지 말고 이 실측대로 매핑해야 합니다.');
    } else {
      notesKo.push(`회전 코드가 예상 밖입니다 (시계=${cwCode}, 반시계=${ccwCode}).`);
    }
  } else if (cw.count || ccw.count) {
    notesKo.push('회전이 한쪽만 관측되어 코드 이름과 방향의 대응을 판정할 수 없습니다.');
  }

  if (cw.acts.includes(2) || ccw.acts.includes(2)) {
    notesKo.push('회전은 act=2로 오고 누름/뗌(1/0)과 구분됩니다.');
  }
  return {
    cw, ccw, click, notesKo, rotationNaming,
    needsRecheck: Boolean(cw.count) !== Boolean(ccw.count),
  };
}

/**
 * 조이스틱 분석. 실기 8차: {a: 각도 0~1, d: 거리 0~1} 극좌표로 온다.
 * 방향별 각도 구간을 실측에서 유도한다. 추측하지 않는다.
 */
export function analyzeJoystick(records, { minDistance = 0.05, weakBelow = 0.2 } = {}) {
  const dirs = ['up', 'down', 'left', 'right'];
  const byDir = {};
  const strayKeys = {};
  for (const d of dirs) {
    const all = (records[`joy-${d}`]?.events ?? []).map((e) => flatten(e));
    // 조이스틱을 밀다가 키를 건드리면 키 이벤트가 섞인다. 따로 기록한다.
    const keys = all.filter((f) => typeof f['p.k'] === 'string').map((f) => f['p.k']);
    if (keys.length) strayKeys[d] = [...new Set(keys)];

    const polar = all.filter((f) => typeof f['p.a'] === 'number' && typeof f['p.d'] === 'number');
    const moved = polar.filter((f) => f['p.d'] >= minDistance);
    const angles = moved.map((f) => f['p.a']);
    const maxDistance = polar.length ? Math.max(...polar.map((f) => f['p.d'])) : 0;
    byDir[d] = angles.length
      ? {
        count: angles.length,
        min: Math.min(...angles),
        max: Math.max(...angles),
        mean: angles.reduce((a, b) => a + b, 0) / angles.length,
        maxDistance,
        weak: maxDistance < weakBelow,
      }
      : { count: 0, min: null, max: null, mean: null, maxDistance, weak: false };
  }

  const measured = dirs.filter((d) => byDir[d].count > 0);
  const notesKo = [];
  if (!measured.length) {
    notesKo.push('조이스틱 이벤트를 관측하지 못했습니다.');
    return { byDir, measured, notesKo, strayKeys, sectors: null };
  }
  notesKo.push(`조이스틱은 극좌표 {a:각도 0~1, d:거리 0~1}로 옵니다 `
    + `(거리 ${minDistance} 이상만 방향으로 셉니다).`);

  // 실측 평균을 중심으로 방향 구간을 제안한다.
  const centers = measured
    .map((d) => ({ dir: d, center: byDir[d].mean }))
    .sort((a, b) => a.center - b.center);
  const sectors = centers.map(({ dir, center }, i) => {
    const prev = centers[(i - 1 + centers.length) % centers.length].center;
    const next = centers[(i + 1) % centers.length].center;
    const half = (c, o) => {
      let diff = o - c;
      if (diff > 0.5) diff -= 1;
      if (diff < -0.5) diff += 1;
      return (c + diff / 2 + 1) % 1;
    };
    return { dir, center, from: half(center, prev), to: half(center, next) };
  });
  if (measured.length === 4) {
    notesKo.push('네 방향 모두 측정되어 구간 경계를 유도할 수 있습니다.');
  } else {
    notesKo.push(`${measured.length}/4 방향만 측정되었습니다. 나머지는 미검증입니다.`);
  }
  const weak = measured.filter((d) => byDir[d].weak);
  if (weak.length) {
    notesKo.push(`${weak.join(', ')} 방향은 약하게만(거리 ${weakBelow} 미만) 밀렸습니다. `
      + '각도는 참고값이며 끝까지 밀어 재확인하는 편이 좋습니다.');
  }
  if (Object.keys(strayKeys).length) {
    const list = Object.entries(strayKeys).map(([d, ks]) => `${d}:${ks.join('/')}`).join(' · ');
    notesKo.push(`조이스틱 단계에 키 이벤트가 섞였습니다 (${list}). `
      + '조작 중 키를 건드린 것으로 보이며 방향 분석에서는 제외했습니다.');
  }
  const rest = (records['joy-up']?.events ?? []).concat(records['joy-down']?.events ?? [])
    .map((e) => flatten(e)).filter((f) => f['p.d'] === 0);
  if (rest.length) notesKo.push('중립 복귀는 d=0으로 옵니다.');
  return { byDir, measured, sectors, strayKeys, notesKo };
}

export function verdictOf(records, steps = INPUT_STEPS) {
  const answered = steps.filter((s) => records[s.id] && !records[s.id].skipped);
  const withEvents = answered.filter((s) => records[s.id].events.length > 0);
  if (!answered.length) return { verdict: 'not_run', messageKo: '관측한 단계가 없습니다.' };
  if (!withEvents.length) {
    return {
      verdict: 'no_events',
      messageKo: '어떤 입력에서도 벤더 채널 알림이 오지 않았습니다. '
        + '키 입력이 일반 HID 리포트로만 나가는 것일 수 있습니다. 미검증으로 남깁니다.',
    };
  }
  const byKind = {};
  for (const s of answered) {
    byKind[s.kind] ??= { total: 0, withEvents: 0 };
    byKind[s.kind].total += 1;
    if (records[s.id].events.length) byKind[s.kind].withEvents += 1;
  }
  const parts = Object.entries(byKind)
    .map(([k, v]) => `${k} ${v.withEvents}/${v.total}`);
  return {
    verdict: 'events_observed',
    byKind,
    messageKo: `알림이 관측되었습니다 — ${parts.join(' · ')}`,
  };
}

/**
 * @param {object} io
 * @param {() => object[]} io.drain  버퍼에 쌓인 알림을 꺼내 비운다
 * @param {(q:string)=>Promise<string>} io.ask
 * @param {(l:string)=>void} io.print
 */
export async function runInputProbe(io, { steps = INPUT_STEPS } = {}) {
  const records = {};
  let aborted = false;

  for (const [i, step] of steps.entries()) {
    io.drain();   // 이전 단계의 잔여 이벤트를 버린다
    io.print('');
    io.print(`[${i + 1}/${steps.length}] ${step.labelKo} — ${step.actionKo}`);
    const raw = await io.ask('  했으면 Enter · 건너뛰기 s · 중단 q > ');
    const t = String(raw ?? '').trim().toLowerCase();
    if (t === 'q') { aborted = true; break; }
    const events = io.drain();
    if (t === 's') {
      records[step.id] = { skipped: true, events };
      io.print('  건너뜀');
      continue;
    }
    records[step.id] = { skipped: false, events };
    if (!events.length) {
      io.print('  수신 없음');
    } else {
      io.print(`  수신 ${events.length}건:`);
      for (const ev of events.slice(0, 4)) {
        io.print(`    ${JSON.stringify(ev).slice(0, 160)}`);
      }
      if (events.length > 4) io.print(`    … 외 ${events.length - 4}건`);
    }
  }

  const identifier = inferIdentifierField(records, steps);
  return {
    records,
    aborted,
    identifier,
    agComparison: compareWithAgNumbers(identifier, steps),
    dial: analyzeDial(records),
    joystick: analyzeJoystick(records),
    verdict: verdictOf(records, steps),
  };
}

export function formatInputReport({
  records, aborted, identifier, agComparison, verdict, dial, joystick,
},
  steps = INPUT_STEPS) {
  const L = [];
  L.push('');
  L.push('── 입력 이벤트 관측 결과 ──');
  for (const step of steps) {
    const r = records[step.id];
    const state = !r ? '미실행' : r.skipped ? '건너뜀'
      : r.events.length ? `수신 ${r.events.length}건` : '수신 없음';
    L.push(`  ${step.labelKo.padEnd(24, ' ')} ${state}`);
  }
  if (aborted) L.push('  ⚠ 중단됨 — 나머지는 미관측입니다.');

  const allEvents = Object.values(records).flatMap((r) => r.events ?? []);
  if (allEvents.length) {
    L.push('');
    L.push('  관측된 알림 모양:');
    for (const [shape, n] of shapesOf(allEvents).slice(0, 5)) {
      L.push(`    ${n}건  {${shape}}`);
    }
  }

  L.push('');
  L.push(`  판정: ${verdict.messageKo}`);

  if (identifier) {
    L.push('');
    L.push(`  식별자로 보이는 필드: ${identifier.field}`
      + ` (서로 다른 값 ${identifier.distinct}개 / ${identifier.coverage}개 단계)`);
    L.push('  ※ 추론입니다. 필드 이름의 의미를 장치 문서로 확인한 것이 아닙니다.');
  } else if (allEvents.length) {
    L.push('  키를 구분하는 필드를 찾지 못했습니다.');
  }

  if (dial) {
    L.push('');
    L.push('  노브');
    L.push(`    시계 방향   ${dial.cw.count}건 ${dial.cw.codes.join(',') || '-'}`);
    L.push(`    반시계 방향 ${dial.ccw.count}건 ${dial.ccw.codes.join(',') || '-'}`);
    L.push(`    누르기      ${dial.click.count}건 ${dial.click.codes.join(',') || '-'}`);
    for (const n of dial.notesKo) L.push(`    · ${n}`);
  }

  if (joystick) {
    L.push('');
    L.push('  조이스틱');
    for (const d of ['up', 'down', 'left', 'right']) {
      const v = joystick.byDir[d];
      L.push(`    ${d.padEnd(6, ' ')} ${v.count
        ? `각도 ${v.min.toFixed(3)}~${v.max.toFixed(3)} (평균 ${v.mean.toFixed(3)})`
          + ` · 최대거리 ${v.maxDistance.toFixed(3)}${v.weak ? ' ⚠약함' : ''}`
        : `미관측 (최대거리 ${v.maxDistance.toFixed(3)})`}`);
    }
    for (const n of joystick.notesKo) L.push(`    · ${n}`);
    if (joystick.sectors) {
      L.push('    실측에서 유도한 방향 구간:');
      for (const s2 of joystick.sectors) {
        L.push(`      ${s2.dir.padEnd(6, ' ')} ${s2.from.toFixed(3)} ~ ${s2.to.toFixed(3)}`);
      }
    }
  }

  if (agComparison?.rows.length) {
    L.push('');
    L.push('  물리 위치 ↔ 이벤트 번호 ↔ 계약 AG');
    for (const r of agComparison.rows) {
      L.push(`    ${r.row}행 ${r.col}열 (${String(r.logical).padEnd(10, ' ')})`
        + `  이벤트 ${String(r.raw ?? r.observed).padStart(6)}`
        + `  · 계약 AG ${String(r.contractAg).padStart(2)}`
        + `  · 읽기순서 ${String(r.readingIndex).padStart(2)}`
        + `  ${r.matchesContract ? '계약 일치' : r.matchesReadingOrder ? '읽기순서 일치' : '⚠ 둘 다 불일치'}`);
    }
    L.push('');
    L.push(`  대조 결론: ${agComparison.conclusionKo}`);
  }
  return L.join('\n');
}
