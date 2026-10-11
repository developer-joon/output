/**
 * v.oai.thstatus 파라미터 의미 탐색 (--probe-params).
 *
 * 실기 5차 관측: 한 요소만 보냈는데 13키 전부 같은 색이 되었고,
 * 이후 호출과 빈 배열은 아무 효과가 없었다.
 * 즉 id는 키 주소가 아니고, []는 해제가 아니다.
 *
 * 알려진 method 하나만 쓰고, 파라미터만 바꿔 가며 한 번에 하나씩 묻는다.
 * method 이름을 추측해 던지지 않는다.
 */

/** 03_led_test.mjs가 실제로 쓴 기본값. 이 위에서 한 가지씩만 바꾼다. */
export const BASE = Object.freeze({ b: 1, e: 1, s: 0.5, sk: 0, sa: 0 });

export const COLORS = Object.freeze({
  RED: 0xff0000, GREEN: 0x00ff00, BLUE: 0x0000ff, YELLOW: 0xffff00,
  MAGENTA: 0xff00ff, CYAN: 0x00ffff, WHITE: 0xffffff, ORANGE: 0xff7f00,
  PURPLE: 0x7f00ff, PINK: 0xff7fbf, LIME: 0x7fff00, SKY: 0x7fbfff, GRAY: 0x7f7f7f,
});

/** 13키에 서로 다른 색. 순서가 곧 id 0~12. */
export const RAINBOW = Object.freeze([
  ['RED', COLORS.RED], ['GREEN', COLORS.GREEN], ['BLUE', COLORS.BLUE],
  ['YELLOW', COLORS.YELLOW], ['MAGENTA', COLORS.MAGENTA], ['CYAN', COLORS.CYAN],
  ['WHITE', COLORS.WHITE], ['ORANGE', COLORS.ORANGE], ['PURPLE', COLORS.PURPLE],
  ['PINK', COLORS.PINK], ['LIME', COLORS.LIME], ['SKY', COLORS.SKY], ['GRAY', COLORS.GRAY],
]);

const el = (id, c, extra = {}) => ({ id, c, ...BASE, ...extra });

/**
 * 실험 목록. 각 실험은 호출 1번 + 질문 1개다.
 * payload는 전부 v.oai.thstatus의 인자다.
 */
export const EXPERIMENTS = Object.freeze([
  {
    id: 'positional_13',
    titleKo: '13개 요소를 한 번에 — 배열 위치가 키를 정하는가',
    payload: RAINBOW.map(([, c], i) => el(i, c)),
    lookKo: '13개 키의 색을 보세요. 서로 다릅니까, 전부 같습니까?',
    options: [
      ['a', '키마다 색이 다르다'],
      ['b', '전부 같은 색이다'],
      ['c', '일부만 바뀌었다'],
      ['d', '변화 없음'],
    ],
    followUp: {
      when: 'a',
      askKo: '1행(노브 오른쪽) 두 키의 색을 왼쪽부터 알려주세요. '
        + '예: 빨강,초록 · 모르면 s',
    },
  },
  {
    id: 'single_id6',
    titleKo: '요소 하나 (id=6) — id가 키를 고르는가',
    payload: [el(6, COLORS.MAGENTA)],
    lookKo: '자홍색이 어디에 나타났습니까?',
    options: [
      ['a', '13개 전부 자홍'],
      ['b', '한 키만 자홍'],
      ['c', '일부만 자홍'],
      ['d', '변화 없음'],
    ],
  },
  {
    id: 'sk_sa',
    titleKo: 'sk/sa 변경 — 이 둘이 키 범위를 정하는가',
    payload: [el(0, COLORS.CYAN, { sk: 6, sa: 1 })],
    lookKo: '청록색이 어디에 나타났습니까?',
    options: [
      ['a', '한 키만 청록'],
      ['b', '13개 전부 청록'],
      ['c', '일부만 청록'],
      ['d', '변화 없음'],
    ],
  },
  {
    id: 'brightness_zero',
    titleKo: '밝기 0 — 끄기가 되는가',
    payload: RAINBOW.map((_, i) => el(i, 0, { b: 0, e: 0 })),
    lookKo: '키 LED가 어떻게 되었습니까?',
    options: [
      ['a', '전부 꺼짐'],
      ['b', '전부 레이어 기본색으로 돌아옴'],
      ['c', '변화 없음'],
      ['d', '그 밖'],
    ],
  },
  {
    id: 'empty_array',
    titleKo: '빈 배열 — 지정 해제가 되는가',
    payload: [],
    lookKo: '키 LED가 어떻게 되었습니까?',
    options: [
      ['a', '레이어 기본색으로 돌아옴'],
      ['b', '전부 꺼짐'],
      ['c', '변화 없음'],
      ['d', '그 밖'],
    ],
  },
]);

export function parseChoice(raw, options) {
  const t = String(raw ?? '').trim().toLowerCase();
  if (t === 'q') return { kind: 'abort' };
  if (t === 's') return { kind: 'skip' };
  if (options.some(([key]) => key === t)) return { kind: 'choice', value: t };
  return null;
}

/**
 * 결론 도출. 관측되지 않은 것은 결론내지 않는다.
 * @returns {{addressing:string, clearMethod:string, notesKo:string[]}}
 */
export function interpret(results) {
  const r = (id) => results[id]?.choice ?? null;
  const notesKo = [];
  let addressing = 'unknown';

  if (r('positional_13') === 'a') {
    addressing = 'array_position';
    notesKo.push('배열의 각 요소가 키 하나에 대응한다. 13개를 한 번에 보내야 한다.');
  } else if (r('sk_sa') === 'a') {
    addressing = 'sk_sa_range';
    notesKo.push('sk/sa가 키 범위를 정한다. id는 키 주소가 아니다.');
  } else if (r('single_id6') === 'b') {
    addressing = 'id_index';
    notesKo.push('id가 키를 고른다. 5차 관측과 어긋나므로 재확인이 필요하다.');
  } else if (r('positional_13') === 'b' && r('single_id6') === 'a') {
    addressing = 'broadcast_only';
    notesKo.push('무엇을 보내도 13키가 같은 색이 된다. 키별 제어 수단을 찾지 못했다.');
  }

  let clearMethod = 'unknown';
  if (r('empty_array') === 'a') clearMethod = 'empty_array';
  else if (r('brightness_zero') === 'b') clearMethod = 'brightness_zero';
  else if (r('brightness_zero') === 'a') {
    clearMethod = 'off_only';
    notesKo.push('밝기 0은 소등일 뿐 기본색 복구가 아니다. 복구 수단을 따로 찾아야 한다.');
  }
  if (clearMethod === 'unknown') {
    notesKo.push('키별 지정을 해제해 기본색으로 되돌리는 방법을 찾지 못했다. '
      + '레이어 전환이나 동반 앱으로 복구해야 할 수 있다.');
  }

  return { addressing, clearMethod, notesKo };
}

/**
 * @param {object} io
 * @param {(payload:any)=>Promise<any>} io.send
 * @param {(q:string)=>Promise<string>} io.ask
 * @param {(ms:number)=>Promise<void>} io.sleep
 * @param {(l:string)=>void} io.print
 */
export async function runParamProbe(io, { experiments = EXPERIMENTS, settleMs = 400 } = {}) {
  const results = {};
  let aborted = false;

  for (const exp of experiments) {
    io.print('');
    io.print(`── ${exp.titleKo}`);
    io.print(`   보낸 값: ${JSON.stringify(exp.payload).slice(0, 160)}`);
    let sendError = null;
    try {
      await io.send(exp.payload);
    } catch (err) {
      sendError = err.message;
      io.print(`   ⚠ 호출 실패: ${sendError}`);
    }
    await io.sleep(settleMs);

    const lines = exp.options.map(([k, label]) => `     ${k}) ${label}`).join('\n');
    let choice = null;
    while (choice === null) {
      const raw = await io.ask(`   ${exp.lookKo}\n${lines}\n     s) 건너뜀  q) 중단\n   > `);
      choice = parseChoice(raw, exp.options);
      if (choice === null) io.print('   a~d, s, q 중 하나를 입력해 주세요.');
    }
    if (choice.kind === 'abort') {
      aborted = true;
      break;
    }

    const record = {
      choice: choice.kind === 'choice' ? choice.value : null,
      skipped: choice.kind === 'skip',
      sendError,
    };

    if (exp.followUp && record.choice === exp.followUp.when) {
      const raw = await io.ask(`   ${exp.followUp.askKo}\n   > `);
      const t = String(raw ?? '').trim();
      record.followUp = t.toLowerCase() === 's' ? null : t;
    }
    results[exp.id] = record;
  }

  return { results, aborted, interpretation: interpret(results) };
}

export function formatParamReport({ results, aborted, interpretation }) {
  const L = [];
  L.push('');
  L.push('── thstatus 파라미터 탐색 결과 ──');
  for (const exp of EXPERIMENTS) {
    const r = results[exp.id];
    if (!r) {
      L.push(`  ${exp.id.padEnd(18)} 미실행`);
      continue;
    }
    const label = r.skipped ? '건너뜀'
      : exp.options.find(([k]) => k === r.choice)?.[1] ?? r.choice;
    L.push(`  ${exp.id.padEnd(18)} ${label}`);
    if (r.followUp) L.push(`  ${''.padEnd(18)}   1행 색: ${r.followUp}`);
    if (r.sendError) L.push(`  ${''.padEnd(18)}   호출 실패: ${r.sendError}`);
  }
  if (aborted) L.push('  ⚠ 중단됨 — 나머지 실험은 미실행입니다.');
  L.push('');
  L.push(`  키 주소 방식: ${interpretation.addressing}`);
  L.push(`  해제 방법:    ${interpretation.clearMethod}`);
  for (const n of interpretation.notesKo) L.push(`  · ${n}`);
  return L.join('\n');
}
