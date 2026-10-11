/**
 * M9 — 노브·조이스틱 (사용자 결정 2026-10-01). 2026-10-03부터 설정은 레이어(m12)가 맡는다.
 * 여기는 방향 구간과 Orca 내장 동작만 본다. 단축키·실제 조작·노브 빈도 제한은 m11 X·m12 L 테스트.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DIRS4, DIRS8, sectorsFor } from '../src/service/controls.js';
import { InputDecoder } from '../src/input/inputDecoder.js';
import { StateStore } from '../src/core/stateStore.js';
import { WorkUnit, ChildUnit } from '../src/core/units.js';
import { Status } from '../src/core/types.js';
import { Output } from '../src/output.js';

const CAL4 = [
  { direction: 'right', center: 0.0173, from: 0.8821, to: 0.1351 },
  { direction: 'down', center: 0.2529, from: 0.1351, to: 0.366 },
  { direction: 'left', center: 0.4791, from: 0.366, to: 0.613 },
  { direction: 'up', center: 0.7469, from: 0.613, to: 0.8821 },
];

describe('M9 / 8방향 구간', () => {
  it('C04 4방향은 보정 구간 그대로', () => {
    assert.deepEqual(sectorsFor(4, CAL4), CAL4);
  });

  it('C05 8방향은 보정 중심각 사이에 대각선을 넣고 원을 빈틈없이 나눈다', () => {
    const s8 = sectorsFor(8, CAL4);
    assert.equal(s8.length, 8);
    assert.deepEqual(new Set(s8.map((s) => s.direction)), new Set(DIRS8));
    const d = new InputDecoder({ sectors: s8, deadzone: 0.1, onIntent: () => {} });
    const dirAt = (a) => d._directionFromAngle(a);
    assert.equal(dirAt(0.7469), 'up');
    assert.equal(dirAt(0.0173), 'right');
    assert.equal(dirAt((0.7469 + 1.0173) / 2 % 1), 'up_right', 'up과 right 중심의 가운데');
    assert.equal(dirAt((0.2529 + 0.4791) / 2), 'down_left');
    for (let a = 0; a < 1; a += 0.01) assert.ok(dirAt(a), `빈틈 없음 ${a}`);
  });

  it('C06 InputDecoder.setSectors로 실행 중에 바꿀 수 있다', () => {
    const got = [];
    const d = new InputDecoder({ sectors: CAL4, deadzone: 0.1, onIntent: (i) => got.push(i.direction) });
    d.setSectors(sectorsFor(8, CAL4));
    d.joystickPolar({ angle: 0.88, distance: 0.8 });
    assert.equal(got.at(-1), 'up_right');
    assert.deepEqual(DIRS4, ['up', 'right', 'down', 'left']);
  });
});

describe('M9 / Orca 내장 동작 (레이어 2026-10-03)', () => {
  const rig = () => {
    const store = new StateStore();
    for (let i = 0; i < 3; i += 1) store.addUnit(new WorkUnit({ id: `u${i}`, title: `u${i}`, source: 'orca', kind: 'worktree', children: [new ChildUnit({ id: `t${i}`, title: `t${i}`, status: i === 1 ? Status.WAITING_APPROVAL : Status.RUNNING, lastActiveAt: 1 })] }));
    const focus = { calls: [], async focus(t) { this.calls.push(t); return { ok: true }; } };
    const o = new Output({ store, sourceName: 'Orca', focusRouter: focus });
    o.setActive(true);
    return { o, focus };
  };

  it('C07 runBuiltin: ATTENTION은 이동, 다음 세션은 노브 이동, 묶음은 묶음 이동', async () => {
    const { o, focus } = rig();
    await o.runBuiltin('attention');
    assert.match(focus.calls.at(-1).reason, /^attention:/);
    assert.equal(o.runBuiltin('next_session'), 1);
    assert.equal(o.runBuiltin('next_bank'), 0, '묶음이 하나뿐이면 그대로');
    assert.equal(o.runBuiltin('teleport'), null);
  });

  it('C10 대기 중에는 내장 동작도 아무것도 하지 않는다', async () => {
    const { o, focus } = rig();
    o.setActive(false);
    assert.equal(await o.runBuiltin('attention'), null);
    assert.equal(o.runBuiltin('next_session'), null);
    assert.equal(focus.calls.length, 0);
  });
});
