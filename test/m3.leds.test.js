/**
 * M3-5 v3 — doctor --leds (rainbow 매핑).
 *
 * 실기 6차 확정: v.oai.thstatus는 13개 요소 배열을 받고 배열 위치가 곧 키다.
 * 따라서 13색을 한 번에 칠하고 행별로 읽어 매핑을 측정한다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import {
  PALETTE, rainbowPayload, singlePayload, parseColorToken, parseRowAnswer,
  buildMapping, compareMapping, runRainbowMap, formatRainbowReport,
} from '../tools/lib/rainbowMap.js';
import {
  KEYS_PER_ROW, KEY_COUNT, expectedPositionOf, familyOf, agLabel, keycodeOf,
  readingOrderPositions,
} from '../tools/lib/layout.js';
import { methodsFor, runLedSession, mergeLedMapping, LED_METHOD, BLOCKED_METHODS }
  from '../tools/doctor.mjs';
import { FakeTransport } from '../src/device/transport/fakeTransport.js';
import { Obs, AG_KEYS } from '../tools/lib/doctorReport.js';
import {
  EXPERIMENTS, BASE, interpret, runParamProbe, formatParamReport,
} from '../tools/lib/paramProbe.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const noop = () => {};
const nosleep = async () => {};

/** 읽기 순서대로 index가 배치된 장치(= 실기 1행 관측과 일치)의 답변을 만든다 */
function rowAnswersFor(indexToPos) {
  const rows = KEYS_PER_ROW.map(() => []);
  for (const [indexStr, pos] of Object.entries(indexToPos)) {
    rows[pos.row - 1][pos.col - 1] = PALETTE[Number(indexStr)].ko;
  }
  return rows.map((r) => r.join(','));
}

const READING_ORDER = Object.fromEntries(
  readingOrderPositions().map((p, i) => [i, { row: p.row, col: p.col }]),
);

function answererFromRows(rowStrings) {
  let i = 0;
  return async (q) => {
    if (/몇 행 몇 열입니까/.test(q)) return '-';
    if (/행 \d개 키의 색을/.test(q)) return rowStrings[i++] ?? 's';
    return 's';
  };
}

describe('M3 / 팔레트와 payload', () => {
  it('N01 색은 13개이고 전부 다르다', () => {
    assert.equal(PALETTE.length, KEY_COUNT);
    assert.equal(new Set(PALETTE.map((p) => p.hex)).size, 13);
    assert.equal(new Set(PALETTE.map((p) => p.ko)).size, 13);
  });

  it('N02 rainbow payload는 13개 요소다 (배열 위치 = 키)', () => {
    const p = rainbowPayload();
    assert.equal(p.length, 13);
    assert.deepEqual(p.map((x) => x.id), Array.from({ length: 13 }, (_, i) => i));
    assert.equal(new Set(p.map((x) => x.c)).size, 13);
    assert.ok(p.every((x) => x.b === 1 && x.s === 0.5));
  });

  it('N03 단독 점등은 나머지를 끈 13개 배열이다', () => {
    const p = singlePayload(6);
    assert.equal(p.length, 13);
    assert.equal(p[6].b, 1);
    assert.ok(p.filter((_, i) => i !== 6).every((x) => x.b === 0 && x.c === 0));
  });

  it('N04 색 이름을 한국어·영어·별칭으로 받는다', () => {
    assert.deepEqual(parseColorToken('빨강'), { kind: 'color', key: 'RED' });
    assert.deepEqual(parseColorToken('RED'), { kind: 'color', key: 'RED' });
    assert.deepEqual(parseColorToken('마젠타'), { kind: 'color', key: 'MAGENTA' });
    assert.deepEqual(parseColorToken('?'), { kind: 'unknown' });
    assert.deepEqual(parseColorToken('-'), { kind: 'none' });
    assert.equal(parseColorToken('무지개'), null);
  });

  it('N05 행 답은 개수가 맞아야 받는다', () => {
    assert.equal(parseRowAnswer('빨강', 2), null, '2개가 필요한데 1개');
    assert.equal(parseRowAnswer('빨강,초록,파랑', 2), null);
    assert.equal(parseRowAnswer('빨강 초록', 2).length, 2, '공백 구분도 허용');
    assert.deepEqual(parseRowAnswer('q', 2), { abort: true });
    assert.deepEqual(parseRowAnswer('s', 2), { skip: true });
  });
});

describe('M3 / 매핑 구성', () => {
  it('N06 행별 답에서 index → 물리 위치를 만든다', () => {
    const rows = rowAnswersFor(READING_ORDER).map((s, i) => parseRowAnswer(s, KEYS_PER_ROW[i]));
    const b = buildMapping(rows);
    assert.equal(Object.keys(b.mapping).length, 13);
    assert.deepEqual(b.mapping[0], { row: 1, col: 1 });
    assert.deepEqual(b.mapping[1], { row: 1, col: 2 });
    assert.deepEqual(b.mapping[12], { row: 4, col: 3 });
    assert.deepEqual(b.duplicates, []);
    assert.deepEqual(b.unseen, []);
  });

  it('N07 같은 색이 두 곳에 보고되면 확정하지 않는다', () => {
    const rows = [
      parseRowAnswer('빨강,빨강', 2),
      parseRowAnswer('파랑,노랑,자홍,청록', 4),
      parseRowAnswer('흰색,주황,보라,분홍', 4),
      parseRowAnswer('연두,하늘,회색', 3),
    ];
    const b = buildMapping(rows);
    assert.deepEqual(b.duplicates, ['RED']);
    assert.equal(0 in b.mapping, false, '중복 색은 매핑하지 않는다');
    assert.ok(b.unseen.includes(1), '초록은 아무 데도 없었다');
  });

  it('N08 ? 와 - 를 구분해 기록한다', () => {
    const rows = [
      parseRowAnswer('빨강,?', 2),
      parseRowAnswer('파랑,노랑,-,청록', 4),
      null, null,
    ];
    const b = buildMapping(rows);
    assert.deepEqual(b.unknownAt, [{ row: 1, col: 2 }]);
    assert.deepEqual(b.noneAt, [{ row: 2, col: 3 }]);
  });

  it('N09 계약과 대조해 불일치를 짚는다 — 실기 1행 관측 재현', () => {
    // 실기: index0 = 물리 왼쪽 위. 계약은 AG00 = 물리 오른쪽 위(slot2).
    const c = compareMapping({ 0: { row: 1, col: 1 }, 1: { row: 1, col: 2 } });
    assert.equal(c.checked, 2);
    assert.equal(c.mismatches.length, 2);
    assert.match(c.messageKo, /2개 중 2개가 계약의 기대 위치와 다릅니다/);
    assert.deepEqual(expectedPositionOf(0), { row: 1, col: 2, logical: 'slot2' });
  });

  it('N10 계약대로면 일치로 판정한다', () => {
    const mapping = {};
    for (let i = 0; i < 13; i += 1) {
      const e = expectedPositionOf(i);
      mapping[i] = { row: e.row, col: e.col };
    }
    const c = compareMapping(mapping);
    assert.equal(c.mismatches.length, 0);
    assert.match(c.messageKo, /13개 전부 계약의 기대 위치와 일치/);
  });
});

describe('M3 / rainbow 세션', () => {
  it('N11 한 번만 칠하고 행별로 4번 묻는다', async () => {
    const painted = []; const asked = [];
    const r = await runRainbowMap({
      paint: async (p) => painted.push(p),
      ask: async (q) => { asked.push(q); return rowAnswersFor(READING_ORDER)[asked.length - 1]; },
      sleep: nosleep, print: noop,
    });
    assert.equal(painted.length, 1, '칠하기는 한 번');
    assert.equal(painted[0].length, 13);
    assert.equal(asked.length, 4, '질문은 행 수만큼');
    assert.equal(Object.keys(r.mapping).length, 13);
    assert.equal(r.aborted, false);
  });

  it('N12 확정 안 된 index만 단독 점등으로 다시 묻는다', async () => {
    const painted = [];
    let rowIdx = 0;
    const rows = ['빨강,빨강', '파랑,노랑,자홍,청록', '흰색,주황,보라,분홍', '연두,하늘,회색'];
    const r = await runRainbowMap({
      paint: async (p) => painted.push(p),
      ask: async (q) => {
        if (/몇 행 몇 열입니까/.test(q)) return '1,1';
        return rows[rowIdx++];
      },
      sleep: nosleep, print: noop,
    });
    assert.ok(painted.length > 1, '단독 점등이 추가로 나간다');
    assert.ok(r.resolved.length > 0);
    // 단독 점등 payload는 하나만 켜져 있어야 한다
    const solo = painted[1];
    assert.equal(solo.filter((x) => x.b === 1).length, 1);
  });

  it('N13 개수가 안 맞으면 다시 묻는다', async () => {
    let n = 0;
    await runRainbowMap({
      paint: async () => {},
      ask: async (q) => {
        if (/몇 행 몇 열/.test(q)) return '-';
        n += 1;
        if (n === 1) return '빨강';      // 2개가 필요한데 1개
        if (n === 2) return '빨강,초록';
        return 'q';
      },
      sleep: nosleep, print: noop,
    });
    assert.ok(n >= 3, '잘못된 답에는 다시 물어야 한다');
  });

  it('N14 q로 중단하면 나머지는 미측정으로 남는다', async () => {
    const r = await runRainbowMap({
      paint: async () => {},
      ask: async () => 'q',
      sleep: nosleep, print: noop,
    });
    assert.equal(r.aborted, true);
    assert.equal(Object.keys(r.mapping).length, 0);
    assert.match(formatRainbowReport(r), /중단됨/);
  });

  it('N15 건너뛴 행은 매핑하지 않는다', async () => {
    let i = 0;
    const rows = ['s', '파랑,노랑,자홍,청록', 's', 's'];
    const r = await runRainbowMap({
      paint: async () => {},
      ask: async (q) => (/몇 행 몇 열/.test(q) ? '-' : rows[i++]),
      sleep: nosleep, print: noop,
    });
    assert.equal(Object.keys(r.mapping).length, 4, '답한 행만 매핑된다');
    assert.deepEqual(r.mapping[2], { row: 2, col: 1 });
  });
});

describe('M3 / --leds 안전', () => {
  function ledTransport() {
    const calls = [];
    const t = new FakeTransport({
      allowedMethods: methodsFor({ leds: true }),
      blockedMethods: BLOCKED_METHODS,
      responses: { [LED_METHOD]: (p) => { calls.push(p); return { ok: 1 }; } },
    });
    return { t, calls };
  }

  it('N16 --leds 여도 fs.write는 차단된다', async () => {
    const { t } = ledTransport();
    await assert.rejects(t.call('fs.write', { file: 'x', data: '{}' }), /금지/);
    assert.equal(t.sentFrames.length, 0);
  });

  it('N17 LED를 쓰는 모드는 전부 thstatus를 허용한다', () => {
    for (const mode of [{ leds: true }, { probeParams: true }, { restoreLeds: true }, { ledsOff: true }]) {
      assert.ok(methodsFor(mode).includes(LED_METHOD), JSON.stringify(mode));
    }
    assert.equal(methodsFor({}).includes(LED_METHOD), false, '읽기 전용은 차단');
  });

  it('N18 allowlist 밖 method는 세션 중에도 못 나간다', async () => {
    const { t } = ledTransport();
    await assert.rejects(t.call('v.oai.zone', []), /허용되지 않은/);
  });

  it('N19 보내는 배열은 항상 13개이고 id 범위를 벗어나지 않는다', async () => {
    const { t, calls } = ledTransport();
    await runLedSession(t, {
      ask: answererFromRows(rowAnswersFor(READING_ORDER)), print: noop, sleep: nosleep, settleMs: 0,
    });
    assert.ok(calls.length >= 1);
    for (const p of calls) {
      assert.equal(p.length, 13, '배열 위치가 키이므로 항상 13개');
      assert.ok(p.every((x) => x.id >= 0 && x.id <= 12), 'mini LED 범위 밖 접근 없음');
    }
  });

  it('N20 활성 레이어에 키코드가 없으면 시작하지 않는다', () => {
    let failed = false;
    try {
      execFileSync('node', ['tools/doctor.mjs', '--fake', '--leds'],
        { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
      failed = true;
      assert.equal(e.status, 5);
      assert.match(e.stderr, /활성 레이어에 Output 키코드가 없습니다/);
    }
    assert.ok(failed);
  });

  it('N21 TTY가 아니면 거부한다', () => {
    let failed = false;
    try {
      execFileSync('node', ['tools/doctor.mjs', '--fake', '--leds', '--force-leds'],
        { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
      failed = true;
      assert.equal(e.status, 2);
      assert.match(e.stderr, /TTY에서만 동작합니다/);
    }
    assert.ok(failed);
  });
});

describe('M3 / capability 병합', () => {
  const base = {
    version: 1, keys: Object.fromEntries(AG_KEYS.map((k) => [k, { led: Obs.UNKNOWN }])), notes: [],
  };

  it('N22 배열 index와 실측 위치가 기록된다', async () => {
    const r = await runRainbowMap({
      paint: async () => {},
      ask: answererFromRows(rowAnswersFor(READING_ORDER)),
      sleep: nosleep, print: noop,
    });
    const merged = mergeLedMapping(base, r);
    assert.equal(merged.ledAddressing, 'array_position');
    assert.equal(merged.keys.AG00.ledArrayIndex, 0);
    assert.deepEqual(merged.keys.AG00.measuredPosition, { row: 1, col: 1 });
    assert.deepEqual(merged.keys.AG00.expectedPosition, { row: 1, col: 2, logical: 'slot2' });
    assert.equal(base.keys.AG00.led, Obs.UNKNOWN, '원본 불변');
  });

  it('N23 불일치가 있으면 가정 금지 문구를 남긴다', async () => {
    const r = await runRainbowMap({
      paint: async () => {},
      ask: answererFromRows(rowAnswersFor(READING_ORDER)),
      sleep: nosleep, print: noop,
    });
    const merged = mergeLedMapping(base, r);
    assert.ok(merged.positionCheck.mismatches.length >= 2);
    assert.ok(merged.notes.some((n) => /같다고 가정할 수 없다/.test(n)));
  });
});

describe('M3 / 레이아웃 헬퍼', () => {
  it('N24 계열과 키코드', () => {
    assert.equal(familyOf(5), 'AG');
    assert.equal(familyOf(6), 'AG', '실기 16차: Output 레이어는 13키 전부 AG');
    assert.equal(keycodeOf(12), 'KV_OAI_AG12');
    assert.equal(agLabel(3), 'AG03');
  });

  it('N25 행 구성은 실기 매트릭스와 같다', () => {
    assert.deepEqual(KEYS_PER_ROW, [2, 4, 4, 3]);
    assert.equal(KEY_COUNT, 13);
    assert.equal(readingOrderPositions().length, 13);
  });
});

// ───────────── thstatus 파라미터 탐색 (실기 6차)
describe('M3 / thstatus 파라미터 탐색', () => {
  it('P01 실험은 알려진 method 하나만 쓴다', () => {
    assert.equal(EXPERIMENTS.length, 5);
    assert.deepEqual(EXPERIMENTS.map((e) => e.id),
      ['positional_13', 'single_id6', 'sk_sa', 'brightness_zero', 'empty_array']);
  });

  it('P02 positional 실험은 13개 요소를 서로 다른 색으로 보낸다', () => {
    const p = EXPERIMENTS[0].payload;
    assert.equal(p.length, 13);
    assert.equal(new Set(p.map((x) => x.c)).size, 13);
  });

  it('P03 기본 파라미터에서 한 가지씩만 바꾼다', () => {
    assert.equal(EXPERIMENTS[2].payload[0].sk, 6);
    assert.equal(EXPERIMENTS[2].payload[0].sa, 1);
    assert.ok(EXPERIMENTS.every((e) => e.payload.every((x) => x.s === BASE.s)));
  });

  it('P04 실기 6차 답을 넣으면 array_position + off_only로 해석된다', () => {
    const i = interpret({
      positional_13: { choice: 'a' },
      single_id6: { choice: 'd' },
      sk_sa: { choice: 'c' },
      brightness_zero: { choice: 'a' },
      empty_array: { choice: 'c' },
    });
    assert.equal(i.addressing, 'array_position');
    assert.equal(i.clearMethod, 'off_only');
    assert.match(i.notesKo.join(' '), /13개를 한 번에 보내야/);
    assert.match(i.notesKo.join(' '), /기본색 복구가 아니다/);
  });

  it('P05 전부 같은 색이면 broadcast_only로 판정한다', () => {
    const i = interpret({ positional_13: { choice: 'b' }, single_id6: { choice: 'a' } });
    assert.equal(i.addressing, 'broadcast_only');
  });

  it('P06 아무것도 확정되지 않으면 unknown으로 남는다', () => {
    const i = interpret({});
    assert.equal(i.addressing, 'unknown');
    assert.equal(i.clearMethod, 'unknown');
  });

  it('P07 세션이 각 실험을 한 번씩 보내고 묻는다', async () => {
    const sent = [];
    const r = await runParamProbe({
      send: async (p) => sent.push(p), ask: async () => 'b',
      sleep: nosleep, print: noop,
    });
    assert.equal(sent.length, 5);
    assert.equal(Object.keys(r.results).length, 5);
  });

  it('P08 호출이 실패해도 계속하고 사유를 남긴다', async () => {
    const r = await runParamProbe({
      send: async () => { throw new Error('장치 응답 없음'); },
      ask: async () => 'd', sleep: nosleep, print: noop,
    });
    assert.match(r.results.positional_13.sendError, /장치 응답 없음/);
    assert.match(formatParamReport(r), /호출 실패/);
  });
});

// ───────────── 실기 7차: ACT 키는 thstatus로 안 켜진다
describe('M3 / 실기 7차 반영', () => {
  it('N26 행 전체가 안 켜진 경우를 한 글자로 받는다', () => {
    assert.deepEqual(parseRowAnswer('-', 4), Array.from({ length: 4 }, () => ({ kind: 'none' })));
    assert.deepEqual(parseRowAnswer('없음', 3), Array.from({ length: 3 }, () => ({ kind: 'none' })));
    assert.deepEqual(parseRowAnswer('안 켜짐', 2), Array.from({ length: 2 }, () => ({ kind: 'none' })));
  });

  it('N27 앞 6개만 켜지는 장치를 그대로 기록한다', async () => {
    let i = 0;
    const rows = ['빨강,초록', '파랑,노랑,자홍,청록', '-', '-'];
    const r = await runRainbowMap({
      paint: async () => {},
      ask: async (q) => (/몇 행 몇 열/.test(q) ? '-' : rows[i++]),
      sleep: nosleep, print: noop,
    });
    assert.equal(Object.keys(r.mapping).length, 6, 'index 0~5만 확정');
    assert.equal(r.noneAt.length, 7, '나머지 7곳은 변화 없음으로 기록');
    for (const i2 of [6, 7, 8, 9, 10, 11, 12]) {
      assert.equal(i2 in r.mapping, false, `index ${i2}는 확정되지 않아야 한다`);
    }
  });

  it('N28 리포트가 index와 AG 번호를 같다고 단정하지 않는다', async () => {
    let i = 0;
    const rows = ['빨강,초록', '파랑,노랑,자홍,청록', '-', '-'];
    const r = await runRainbowMap({
      paint: async () => {},
      ask: async (q) => (/몇 행 몇 열/.test(q) ? '-' : rows[i++]),
      sleep: nosleep, print: noop,
    });
    const s = formatRainbowReport(r);
    assert.match(s, /계약의 가정일 뿐입니다/);
    assert.match(s, /--input 으로 대조해야 합니다/);
    assert.match(s, /index {2}6 \(AG06\) {2}미확정/);
  });
});
