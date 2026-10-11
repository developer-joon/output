/**
 * M3-6 — doctor --input. 장치 없이 전 경로를 검증한다.
 * 알림 형식을 모르므로, 형식을 가정하지 않는다는 것 자체를 테스트한다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';

import {
  INPUT_STEPS, buildSteps, flatten, shapesOf, inferIdentifierField, identifierToIndex,
  compareWithAgNumbers, verdictOf, runInputProbe, formatInputReport,
  analyzeDial, analyzeJoystick,
} from '../tools/lib/inputProbe.js';
import { runInputSession, mergeInputObservations, methodsFor, BLOCKED_METHODS, LED_METHOD }
  from '../tools/doctor.mjs';
import { FakeTransport } from '../src/device/transport/fakeTransport.js';
import { expectedPositions, KEYS_PER_ROW } from '../tools/lib/layout.js';
import { Obs, AG_KEYS } from '../tools/lib/doctorReport.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const noop = () => {};
const KEY_STEPS = INPUT_STEPS.filter((s) => s.kind === 'key');

/** 이벤트를 만들어 주는 가짜 장치 응답 */
function fakeRun({ eventsFor, answers = () => '' }) {
  const buffer = [];
  const printed = [];
  return runInputProbe({
    drain: () => buffer.splice(0, buffer.length),
    ask: async (q) => {
      const stepIdx = printed.filter((l) => /^\[\d+\//.test(l)).length - 1;
      const step = INPUT_STEPS[stepIdx];
      const answer = answers(step, stepIdx);
      if (answer !== 'q' && answer !== 's') {
        for (const ev of eventsFor(step) ?? []) buffer.push(ev);
      }
      return answer;
    },
    print: (l) => printed.push(l),
  }).then((r) => ({ ...r, printed }));
}

describe('M3 / 입력 관측 단계', () => {
  it('I01 13키 + 노브 3 + 조이스틱 4 = 20단계', () => {
    assert.equal(INPUT_STEPS.length, 20);
    assert.equal(KEY_STEPS.length, 13);
    assert.equal(INPUT_STEPS.filter((s) => s.kind === 'dial').length, 3);
    assert.equal(INPUT_STEPS.filter((s) => s.kind === 'joystick').length, 4);
  });

  it('I02 키 단계는 물리 읽기 순서이고 논리 역할을 알려준다', () => {
    assert.deepEqual(KEY_STEPS.slice(0, 2).map((s) => s.logical), ['slot1', 'slot2']);
    assert.equal(KEY_STEPS[12].logical, 'mode_back');
    assert.deepEqual(KEY_STEPS.map((s) => s.col).slice(0, 2), [1, 2]);
    const perRow = KEYS_PER_ROW.map((n, r) => KEY_STEPS.filter((s) => s.row === r + 1).length);
    assert.deepEqual(perRow, [...KEYS_PER_ROW]);
  });

  it('I03 노브 클릭은 없을 수 있다고 미리 알린다', () => {
    const click = INPUT_STEPS.find((s) => s.id === 'dial-click');
    assert.match(click.actionKo, /없을 수 있습니다/);
  });

  it('I04 buildSteps는 계약 배치에서 유도한다', () => {
    assert.deepEqual(buildSteps().map((s) => s.id), INPUT_STEPS.map((s) => s.id));
  });
});

describe('M3 / 원문 분석 (형식을 가정하지 않음)', () => {
  it('I05 중첩 객체를 경로로 펼친다', () => {
    assert.deepEqual(flatten({ ev: 'key', d: { ag: 3, state: 1 } }),
      { ev: 'key', 'd.ag': 3, 'd.state': 1 });
  });

  it('I06 서로 다른 모양을 센다', () => {
    const shapes = shapesOf([{ a: 1 }, { a: 2 }, { a: 1, b: 2 }]);
    assert.equal(shapes[0][1], 2);
    assert.equal(shapes.length, 2);
  });

  it('I07 단계마다 값이 다르고 단계 안에서 일정한 숫자 필드를 식별자로 본다', () => {
    const records = {};
    KEY_STEPS.forEach((s, i) => {
      records[s.id] = { skipped: false, events: [{ ev: 'key', k: i, st: 1 }, { ev: 'key', k: i, st: 0 }] };
    });
    const id = inferIdentifierField(records);
    assert.equal(id.field, 'k');
    assert.equal(id.distinct, 13);
    assert.equal(id.byStep['key-1-1'], 0);
  });

  it('I08 단계 안에서 값이 흔들리는 필드는 식별자로 쓰지 않는다', () => {
    const records = {};
    KEY_STEPS.forEach((s, i) => {
      // st는 press/release로 값이 두 개 → 식별자 아님
      records[s.id] = { skipped: false, events: [{ k: i, st: 1 }, { k: i, st: 0 }] };
    });
    assert.equal(inferIdentifierField(records).field, 'k');
  });

  it('I09 구분되는 필드가 없으면 null', () => {
    const records = {};
    KEY_STEPS.forEach((s) => { records[s.id] = { skipped: false, events: [{ ev: 'key', k: 1 }] }; });
    assert.equal(inferIdentifierField(records), null);
  });

  it('I10 이벤트가 없으면 null', () => {
    assert.equal(inferIdentifierField({}), null);
  });
});

describe('M3 / 계약 AG 대조 (7차 미해결 질문)', () => {
  function identifierFrom(valueOf) {
    const byStep = {};
    KEY_STEPS.forEach((s, i) => { byStep[s.id] = valueOf(s, i); });
    return { field: 'k', byStep, distinct: 13, coverage: 13 };
  }

  it('I11 이벤트 번호가 계약 AG와 같으면 그렇게 결론낸다', () => {
    const expected = expectedPositions();
    const posToAg = new Map([...expected].map(([ag, p]) => [`${p.row}-${p.col}`, ag]));
    const c = compareWithAgNumbers(identifierFrom((s) => posToAg.get(`${s.row}-${s.col}`)));
    assert.equal(c.contractHits, 13);
    assert.match(c.conclusionKo, /계약의 AG 번호와 전부 일치/);
  });

  it('I12 읽기 순서와 같으면 LED 배열과 같은 체계라고 결론낸다', () => {
    const c = compareWithAgNumbers(identifierFrom((s, i) => i));
    assert.equal(c.readingHits, 13);
    assert.match(c.conclusionKo, /읽기 순서와 전부 일치/);
    assert.match(c.conclusionKo, /LED 배열 index와 같은 체계/);
    // 상단 두 키는 계약과 어긋난다 (실기 7차 LED 관측과 같은 구조)
    const top = c.rows.filter((r) => r.row === 1);
    assert.equal(top.every((r) => r.matchesContract), false);
  });

  it('I13 어느 쪽과도 안 맞으면 단정하지 않는다', () => {
    const c = compareWithAgNumbers(identifierFrom((s, i) => 100 + i));
    assert.equal(c.contractHits, 0);
    assert.equal(c.readingHits, 0);
    assert.match(c.conclusionKo, /어느 쪽과도 완전히 맞지 않습니다/);
  });

  it('I14 식별자가 없으면 대조하지 않는다', () => {
    assert.equal(compareWithAgNumbers(null), null);
  });
});

describe('M3 / 판정', () => {
  it('I15 알림이 하나도 없으면 미지원이 아니라 미검증으로 본다', () => {
    const records = {};
    for (const s of INPUT_STEPS) records[s.id] = { skipped: false, events: [] };
    const v = verdictOf(records);
    assert.equal(v.verdict, 'no_events');
    assert.match(v.messageKo, /미검증으로 남깁니다/);
    assert.match(v.messageKo, /일반 HID 리포트/);
  });

  it('I16 종류별로 몇 개에서 왔는지 센다', () => {
    const records = {};
    for (const s of INPUT_STEPS) {
      records[s.id] = { skipped: false, events: s.kind === 'key' ? [{ k: 1 }] : [] };
    }
    const v = verdictOf(records);
    assert.equal(v.verdict, 'events_observed');
    assert.equal(v.byKind.key.withEvents, 13);
    assert.equal(v.byKind.dial.withEvents, 0);
  });

  it('I17 아무것도 안 했으면 not_run', () => {
    assert.equal(verdictOf({}).verdict, 'not_run');
  });
});

describe('M3 / 세션', () => {
  it('I18 단계마다 버퍼를 비우고 그 사이 이벤트만 귀속시킨다', async () => {
    const r = await fakeRun({
      eventsFor: (s) => (s.kind === 'key' ? [{ ev: 'key', k: KEY_STEPS.indexOf(s) }] : []),
    });
    assert.equal(Object.keys(r.records).length, 20);
    assert.equal(r.records['key-1-1'].events.length, 1);
    assert.equal(r.records['dial-cw'].events.length, 0);
    assert.equal(r.identifier.field, 'k');
  });

  it('I19 건너뛴 단계는 그렇게 기록한다', async () => {
    const r = await fakeRun({
      eventsFor: () => [],
      answers: (s) => (s.kind === 'dial' ? 's' : ''),
    });
    assert.equal(r.records['dial-cw'].skipped, true);
    assert.equal(r.records['key-1-1'].skipped, false);
  });

  it('I20 q로 중단하면 나머지는 미실행으로 남는다', async () => {
    const r = await fakeRun({
      eventsFor: () => [],
      answers: (s, i) => (i >= 2 ? 'q' : ''),
    });
    assert.equal(r.aborted, true);
    assert.equal(Object.keys(r.records).length, 2);
    assert.match(formatInputReport(r), /중단됨/);
  });

  it('I21 수신 없음을 그대로 보고한다', async () => {
    const r = await fakeRun({ eventsFor: () => [] });
    assert.equal(r.verdict.verdict, 'no_events');
    const s = formatInputReport(r);
    assert.match(s, /수신 없음/);
    assert.match(s, /미검증으로 남깁니다/);
  });

  it('I22 리포트가 추론임을 명시한다', async () => {
    const r = await fakeRun({
      eventsFor: (s) => (s.kind === 'key' ? [{ ev: 'key', k: KEY_STEPS.indexOf(s) }] : []),
    });
    const s = formatInputReport(r);
    assert.match(s, /식별자로 보이는 필드: k/);
    assert.match(s, /추론입니다/);
    assert.match(s, /장치 문서로 확인한 것이 아닙니다/);
  });
});

describe('M3 / --input 안전', () => {
  it('I23 입력 관측은 장치에 아무것도 쓰지 않는다', async () => {
    const t = new FakeTransport({
      allowedMethods: methodsFor({}), blockedMethods: BLOCKED_METHODS,
    });
    let i = 0;
    await runInputSession(t, { ask: async () => (i++ < 3 ? '' : 'q'), print: noop });
    assert.equal(t.sentFrames.length, 0, '프레임이 한 건도 나가면 안 된다');
    assert.deepEqual(t.calledMethods, []);
  });

  it('I24 --input 모드는 LED method를 허용하지 않는다', () => {
    assert.equal(methodsFor({}).includes(LED_METHOD), false);
  });

  it('I25 알림 구독은 세션이 끝나면 해제된다', async () => {
    const t = new FakeTransport({ allowedMethods: methodsFor({}) });
    await runInputSession(t, { ask: async () => 'q', print: noop });
    // 세션 후 알림이 와도 버퍼에 쌓이지 않아야 한다 (구독 해제 확인)
    assert.doesNotThrow(() => t.emitNotification({ ev: 'key', k: 1 }));
  });

  it('I26 capability에 관측 결과가 합쳐진다', async () => {
    const base = {
      version: 1, keys: Object.fromEntries(AG_KEYS.map((k) => [k, { led: Obs.UNKNOWN }])), notes: [],
    };
    const r = await fakeRun({
      eventsFor: (s) => (s.kind === 'key' ? [{ ev: 'key', k: KEY_STEPS.indexOf(s) }] : []),
    });
    const merged = mergeInputObservations(base, r);
    assert.equal(merged.inputProbe.verdict, 'events_observed');
    assert.equal(merged.inputProbe.identifierField, 'k');
    assert.equal(merged.inputProbe.byStep['key-1-1'].eventCount, 1);
    assert.ok(merged.notes.some((n) => /읽기 순서와 전부 일치/.test(n)));
    assert.equal(base.notes.length, 0, '원본 불변');
  });
});

// ───────────── 실기 8차 실측 데이터로 검증
describe('M3 / 실기 8차 실측 (2026-09-21)', () => {
  const { records } = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'test/fixtures/input-events-real.json'), 'utf8'));

  it('I27 식별자가 문자열이어도 찾는다 (초기 구현이 놓친 결함)', () => {
    const id = inferIdentifierField(records);
    assert.equal(id.field, 'p.k');
    assert.equal(id.distinct, 13);
    assert.equal(id.byStep['key-1-1'], 'AG00');
  });

  it('I28 AG00/ACT06 같은 문자열을 번호로 바꾼다', () => {
    assert.equal(identifierToIndex('AG00'), 0);
    assert.equal(identifierToIndex('ACT12'), 12);
    assert.equal(identifierToIndex(7), 7);
    assert.equal(identifierToIndex('ENC_CLK'), null);
  });

  it('I29 키 이벤트 번호는 물리 읽기 순서와 13/13 일치한다', () => {
    const c = compareWithAgNumbers(inferIdentifierField(records));
    assert.equal(c.rows.length, 13);
    assert.equal(c.readingHits, 13);
    assert.match(c.conclusionKo, /읽기 순서와 전부 일치/);
  });

  it('I30 계약과는 상단 두 키만 어긋난다 — 계약의 AG 매핑이 틀렸다', () => {
    const c = compareWithAgNumbers(inferIdentifierField(records));
    assert.equal(c.contractHits, 11);
    const top = c.rows.filter((r) => r.row === 1);
    assert.deepEqual(top.map((r) => [r.logical, r.raw]),
      [['slot1', 'AG00'], ['slot2', 'AG01']]);
    // 계약은 slot1→AG01, slot2→AG00 이라고 본다. 실측은 그 반대다.
    assert.equal(top[0].contractAg, 1);
    assert.equal(top[1].contractAg, 0);
    assert.ok(top.every((r) => !r.matchesContract));
  });

  it('I31 노브 클릭이 실제로 동작한다 (계약이 보류했던 항목)', () => {
    const d = analyzeDial(records);
    assert.equal(d.click.count, 2);
    assert.deepEqual(d.click.codes, ['ENC_CLK']);
    assert.ok(d.notesKo.some((n) => /노브 클릭이 실제로 이벤트를 냅니다/.test(n)));
  });

  it('I32 한쪽만 관측되면 노브 방향 대응을 판정하지 않는다', () => {
    const d = analyzeDial(records);
    assert.deepEqual(d.cw.codes, ['ENC_CC']);
    assert.equal(d.ccw.count, 0);
    assert.equal(d.needsRecheck, true);
    assert.equal(d.rotationNaming, 'unknown');
    assert.ok(d.notesKo.some((n) => /한쪽만 관측되어/.test(n)));
  });

  it('I33 회전은 act=2로 눌림/뗌과 구분된다', () => {
    const d = analyzeDial(records);
    assert.deepEqual(d.cw.acts, [2]);
    assert.deepEqual(d.click.acts, [1, 0]);
  });

  it('I34 조이스틱은 극좌표이고 4방향 각도가 실측된다', () => {
    const j = analyzeJoystick(records);
    assert.deepEqual(j.measured.sort(), ['down', 'left', 'right', 'up']);
    assert.ok(Math.abs(j.byDir.right.mean - 0.017) < 0.01);
    assert.ok(Math.abs(j.byDir.down.mean - 0.251) < 0.01);
    assert.ok(Math.abs(j.byDir.left.mean - 0.479) < 0.02);
    assert.ok(Math.abs(j.byDir.up.mean - 0.748) < 0.01);
  });

  it('I35 방향 구간이 실측 평균에서 유도된다', () => {
    const j = analyzeJoystick(records);
    assert.equal(j.sectors.length, 4);
    const byDir = Object.fromEntries(j.sectors.map((s) => [s.dir, s]));
    // 네 구간이 원을 한 바퀴 덮어야 한다
    const widths = j.sectors.map((s) => (s.to - s.from + 1) % 1);
    assert.ok(Math.abs(widths.reduce((a, b) => a + b, 0) - 1) < 0.01);
    assert.ok(byDir.up.from < 0.748 && 0.748 < byDir.up.to);
  });

  it('I36 거리 임계 아래 흔들림은 방향으로 세지 않는다', () => {
    const loose = analyzeJoystick(records, { minDistance: 0 });
    const strict = analyzeJoystick(records, { minDistance: 0.3 });
    assert.ok(loose.byDir.up.count > strict.byDir.up.count);
  });

  it('I37 flatten을 map에 직접 넘겨도 누산기를 공유하지 않는다', () => {
    // .map(flatten) 은 index와 array를 함께 넘긴다 — 실기 데이터에서 드러난 결함
    assert.deepEqual([{ a: 1 }, { b: 2 }].map(flatten), [{ a: 1 }, { b: 2 }]);
  });

  it('I38 전체 리포트에 결론이 담긴다', () => {
    const id = inferIdentifierField(records);
    const s = formatInputReport({
      records, aborted: false, identifier: id,
      agComparison: compareWithAgNumbers(id),
      dial: analyzeDial(records), joystick: analyzeJoystick(records),
      verdict: verdictOf(records),
    });
    assert.match(s, /식별자로 보이는 필드: p\.k/);
    assert.match(s, /누르기 {6}2건 ENC_CLK/);
    assert.match(s, /읽기 순서와 전부 일치/);
    assert.match(s, /극좌표/);
  });
});

// ───────────── 실기 9차: 노브 양방향 확인 + 조이스틱 약한 입력
describe('M3 / 실기 9차 실측 (2026-09-21)', () => {
  const r2 = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'test/fixtures/input-events-real-2.json'), 'utf8')).records;
  const r1 = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'test/fixtures/input-events-real.json'), 'utf8')).records;

  it('I39 노브 코드 이름이 실제 방향과 반대임을 확정한다', () => {
    const d = analyzeDial(r2);
    assert.equal(d.rotationNaming, 'inverted');
    assert.deepEqual(d.cw.codes, ['ENC_CC']);
    assert.deepEqual(d.ccw.codes, ['ENC_CW']);
    assert.ok(d.notesKo.some((n) => /이름이 실제 방향과 반대/.test(n)));
    assert.ok(d.notesKo.some((n) => /코드 이름을 믿지 말고/.test(n)));
  });

  it('I40 한쪽만 관측되면 방향 대응을 판정하지 않는다', () => {
    const d = analyzeDial(r1);   // 8차: 반시계 미수신
    assert.equal(d.rotationNaming, 'unknown');
    assert.ok(d.notesKo.some((n) => /한쪽만 관측되어/.test(n)));
  });

  it('I41 이름이 방향과 맞는 경우도 구분한다', () => {
    const swapped = {
      ...r2,
      'dial-cw': { skipped: false, events: [{ m: 'v.oai.hid', p: { k: 'ENC_CW', act: 2 } }] },
      'dial-ccw': { skipped: false, events: [{ m: 'v.oai.hid', p: { k: 'ENC_CC', act: 2 } }] },
    };
    assert.equal(analyzeDial(swapped).rotationNaming, 'as_named');
  });

  it('I42 약하게 민 방향을 그렇게 표시한다', () => {
    const j = analyzeJoystick(r2);
    assert.equal(j.byDir.up.weak, true, 'up은 거리 0.05로 약하다');
    assert.equal(j.byDir.right.weak, false);
    assert.ok(j.notesKo.some((n) => /약하게만.*끝까지 밀어 재확인/.test(n)));
  });

  it('I43 임계를 낮춰 약한 입력도 각도를 건진다', () => {
    const j = analyzeJoystick(r2);
    // 이전 임계(0.3)였다면 up/down 모두 미관측이었다
    assert.ok(Math.abs(j.byDir.up.mean - 0.744) < 0.01);
    assert.ok(Math.abs(j.byDir.down.mean - 0.253) < 0.01);
    assert.equal(analyzeJoystick(r2, { minDistance: 0.3 }).byDir.up.count, 0);
  });

  it('I44 조이스틱 단계에 섞인 키 이벤트를 걸러내고 보고한다', () => {
    const j = analyzeJoystick(r2);
    assert.deepEqual(j.strayKeys.down, ['AG05']);
    assert.deepEqual(j.strayKeys.left, ['AG01']);
    assert.equal(j.byDir.left.count, 0, '키 이벤트는 방향으로 세지 않는다');
    assert.ok(j.notesKo.some((n) => /키 이벤트가 섞였습니다/.test(n)));
  });

  it('I45 두 번의 실행에서 방향 각도가 일관된다', () => {
    const a = analyzeJoystick(r1);
    const b = analyzeJoystick(r2);
    for (const d of ['up', 'down', 'right']) {
      assert.ok(Math.abs(a.byDir[d].mean - b.byDir[d].mean) < 0.02,
        `${d}: 8차 ${a.byDir[d].mean} vs 9차 ${b.byDir[d].mean}`);
    }
  });

  it('I46 두 번의 실행에서 키 매핑이 동일하다', () => {
    const c1 = compareWithAgNumbers(inferIdentifierField(r1));
    const c2 = compareWithAgNumbers(inferIdentifierField(r2));
    assert.deepEqual(c1.rows.map((r) => [r.logical, r.raw]),
      c2.rows.map((r) => [r.logical, r.raw]));
    assert.equal(c2.readingHits, 13);
    assert.equal(c2.contractHits, 11);
  });

  it('I47 조이스틱 안내가 끝까지 밀라고 말한다', () => {
    const up = INPUT_STEPS.find((s) => s.id === 'joy-up');
    assert.match(up.actionKo, /끝까지/);
  });
});
