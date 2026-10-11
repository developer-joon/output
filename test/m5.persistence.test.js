/**
 * M5-1 — 영속화 (C14).
 * Core는 파일을 모른다. 복원된 것은 전부 UNKNOWN으로 시작한다.
 * 옛 상태를 최신 정상으로 가장하지 않는다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SlotManager } from '../src/core/slotManager.js';
import { StateStore } from '../src/core/stateStore.js';
import { WorkUnit, ChildUnit } from '../src/core/units.js';
import { Status, Confidence, NotificationKind } from '../src/core/types.js';
import { SCHEMA_VERSION, emptyState, validateState } from '../src/adapters/persistence/schema.js';
import { FileStore } from '../src/adapters/persistence/fileStore.js';
import { PersistenceAdapter } from '../src/adapters/persistence/persistenceAdapter.js';
import { createPersistence, defaultDir } from '../src/adapters/persistence/index.js';
import { OrcaSync } from '../src/adapters/orca/orcaSync.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cb-persist-'));

describe('M5-1 / 슬롯 자리 지정', () => {
  it('P01 assignAt은 지정한 자리에 넣는다 — 낮은 빈자리를 고르지 않는다', () => {
    const sm = new SlotManager();
    assert.equal(sm.assignAt('b', 2), 2);
    assert.equal(sm.globalIndexOf('b'), 2);
    assert.equal(sm.idAt(0, 2), 'b');
    // 그 뒤 일반 assign은 비어 있는 0으로 간다
    assert.equal(sm.assign('a'), 0);
  });

  it('P02 이미 찬 자리에는 넣지 않는다', () => {
    const sm = new SlotManager();
    sm.assignAt('a', 1);
    assert.throws(() => sm.assignAt('b', 1), /slot occupied: 1/);
  });

  it('P03 같은 id를 두 자리에 두지 않는다', () => {
    const sm = new SlotManager();
    sm.assignAt('a', 1);
    assert.throws(() => sm.assignAt('a', 3), /already assigned: a/);
    assert.equal(sm.globalIndexOf('a'), 1);
  });

  it('P02b isOccupied는 그 자리에 무엇이 있는지만 답한다', () => {
    const sm = new SlotManager();
    sm.assignAt('a', 4);
    assert.equal(sm.isOccupied(4), true);
    assert.equal(sm.isOccupied(3), false);
  });
});

describe('M5-1 / Store 복원 표식', () => {
  const unit = (id) => new WorkUnit({ id, title: id, source: 'orca', status: Status.UNKNOWN });

  it('P04 addUnit은 자리를 지정해 넣을 수 있다', () => {
    const store = new StateStore();
    store.addUnit(unit('u2'), { atGlobalIndex: 2 });
    store.addUnit(unit('u0'));
    assert.equal(store.globalSlots.globalIndexOf('u2'), 2);
    assert.equal(store.globalSlots.globalIndexOf('u0'), 0, '빈 0번으로 간다');
  });

  it('P05 복원 후 관측이 없으면 유예 뒤에 반납할 수 있다', () => {
    const store = new StateStore({ now: () => 1_000 });
    store.addUnit(unit('u'));
    store.markRestored('u', 1_000);
    assert.equal(store.canRelease('u', { now: 1_000, graceMs: 600_000 }), false, '유예 전');
    assert.equal(store.canRelease('u', { now: 601_000, graceMs: 600_000 }), true, '유예 후');
  });

  it('P06 복원 후 한 번이라도 관측되면 그 규칙은 꺼진다', () => {
    const store = new StateStore();
    store.addUnit(unit('u'));
    store.markRestored('u', 1_000);
    store.noteObserved('u', 1_500);
    // 관측된 뒤에는 기존 규칙만 적용 — UNKNOWN은 종료 상태가 아니므로 반납 불가
    assert.equal(store.canRelease('u', { now: 9_000_000, graceMs: 600_000 }), false);
  });

  it('P07 고정된 것은 유예가 지나도 반납하지 않는다', () => {
    const store = new StateStore();
    store.addUnit(new WorkUnit({
      id: 'u', title: 'u', source: 'orca', status: Status.UNKNOWN, pinned: true,
    }));
    store.markRestored('u', 1_000);
    assert.equal(store.canRelease('u', { now: 9_000_000, graceMs: 600_000 }), false);
  });

  it('P08 복원 표식은 DISCONNECTED에도 적용된다 — 조회에서 사라진 것', () => {
    const store = new StateStore();
    store.addUnit(unit('u'));
    store.markRestored('u', 1_000);
    store.setUnitStatus('u', Status.DISCONNECTED);
    assert.equal(store.canRelease('u', { now: 9_000_000, graceMs: 600_000 }), true);
  });

  it('P05c 확인한 알림만 골라 준다 — 대체된 것은 빼고', () => {
    const store = new StateStore();
    store.addUnit(new WorkUnit({
      id: 'u', title: 'u', source: 'mock', status: Status.RUNNING,
      children: [
        new ChildUnit({ id: 'c1', title: 'c', status: Status.DONE_UNSEEN, runId: 'r1' }),
        new ChildUnit({ id: 'c2', title: 'c', status: Status.DONE_UNSEEN, runId: 'r2' }),
      ],
    }));
    const [n1] = store.unacknowledgedNotifications();
    store.acknowledgeNotification(n1.id);
    const acked = store.acknowledgedNotifications();
    assert.equal(acked.length, 1);
    assert.equal(acked[0].id, n1.id);
    assert.equal(store.unacknowledgedNotifications().length, 1);
  });
});

describe('M5-1 / 파일 모양', () => {
  it('P09 유효한 상태를 알아본다', () => {
    const s = emptyState();
    s.slots.push({ id: 'u', globalIndex: 3, title: 'u', source: 'orca', kind: 'worktree', pinned: false });
    s.acks.push({ unitId: 'u', childId: 'c', kind: NotificationKind.COMPLETION, runId: 'r1', acknowledgedAt: 5 });
    assert.deepEqual(validateState(s), { ok: true, errorsKo: [] });
  });

  it('P09b 모양이 틀리면 이유를 한국어로 말한다', () => {
    assert.equal(validateState(null).ok, false);
    assert.equal(validateState({ version: 1 }).ok, false);
    const bad = emptyState();
    bad.slots.push({ id: 'u', globalIndex: -1, title: 'u', source: 'orca', kind: 'worktree', pinned: false });
    const r = validateState(bad);
    assert.equal(r.ok, false);
    assert.ok(r.errorsKo.some((m) => /globalIndex/.test(m)));
  });
});

describe('M5-1 / 파일 읽기·쓰기', () => {
  it('P10 없으면 빈 상태, 경고 없음', () => {
    const fsStore = new FileStore({ dir: tmp() });
    assert.deepEqual(fsStore.read(), { state: null, warningKo: null, newerVersion: false });
  });

  it('P11 쓰고 읽으면 같다', () => {
    const fsStore = new FileStore({ dir: tmp() });
    const s = emptyState();
    s.savedAt = 42;
    s.slots.push({ id: 'u', globalIndex: 0, title: 'u', source: 'orca', kind: 'worktree', pinned: true });
    assert.equal(fsStore.write(s).ok, true);
    assert.deepEqual(fsStore.read().state, s);
  });

  it('P12 깨진 파일은 옮겨 두고 빈 상태로 시작한다 — 지우지 않는다', () => {
    const dir = tmp();
    const fsStore = new FileStore({ dir });
    fs.writeFileSync(fsStore.path, '{ not json', 'utf8');
    const r = fsStore.read();
    assert.equal(r.state, null);
    assert.match(r.warningKo, /읽지 못했습니다|손상/);
    const moved = fs.readdirSync(dir).filter((f) => f.startsWith('state.json.corrupt-'));
    assert.equal(moved.length, 1, '원본을 corrupt 파일로 보존한다');
    assert.equal(fs.existsSync(fsStore.path), false);
  });

  it('P12b 모양이 틀린 JSON도 손상으로 본다', () => {
    const dir = tmp();
    const fsStore = new FileStore({ dir });
    fs.writeFileSync(fsStore.path, JSON.stringify({ version: 1, slots: 'nope' }), 'utf8');
    const r = fsStore.read();
    assert.equal(r.state, null);
    assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('state.json.corrupt-')));
  });

  it('P09c 더 새로운 버전의 파일은 읽지도 옮기지도 않고, 그렇다고 알린다', () => {
    const dir = tmp();
    const fsStore = new FileStore({ dir });
    fs.writeFileSync(fsStore.path, JSON.stringify({ ...emptyState(), version: SCHEMA_VERSION + 1 }), 'utf8');
    const r = fsStore.read();
    assert.equal(r.state, null);
    assert.equal(r.newerVersion, true);
    assert.match(r.warningKo, /새로운 버전/);
    assert.equal(fs.existsSync(fsStore.path), true, '옮기지 않는다');
    assert.equal(fs.readdirSync(dir).length, 1);
  });
});

/** 타이머를 손으로 돌리는 어댑터 */
function harness({ dir = tmp(), now = 1_000_000, store = new StateStore({ now: () => now }) } = {}) {
  const timers = [];
  const fileStore = new FileStore({ dir });
  const adapter = new PersistenceAdapter({
    store, fileStore, now: () => now, debounceMs: 1000,
    setTimer: (fn, ms) => { const h = { fn, ms }; timers.push(h); return h; },
    clearTimer: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
  });
  const fireTimers = () => { const t = timers.splice(0); for (const h of t) h.fn(); };
  return { store, fileStore, adapter, timers, fireTimers, dir };
}

const orcaUnit = (id, extra = {}) => new WorkUnit({
  id, title: `제목 ${id}`, source: 'orca', kind: 'worktree', status: Status.RUNNING, ...extra,
});

describe('M5-1 / 스냅샷', () => {
  it('P13a 슬롯 배치·핀·표시 정보만 담는다. 상태는 담지 않는다', () => {
    const { store, adapter } = harness();
    store.addUnit(orcaUnit('a', { pinned: true }));
    store.addUnit(orcaUnit('b'));
    store.setUnitStatus('b', Status.WAITING_INPUT);
    const s = adapter.snapshot();
    assert.equal(s.version, SCHEMA_VERSION);
    assert.deepEqual(s.slots.map((x) => [x.id, x.globalIndex, x.pinned]), [['a', 0, true], ['b', 1, false]]);
    assert.equal(JSON.stringify(s).includes('WAITING_INPUT'), false, '상태는 저장하지 않는다');
    assert.equal(JSON.stringify(s).includes('RUNNING'), false);
  });

  it('P13b 확인한 알림을 키로 담는다 — id는 재시작 후 바뀌므로 쓰지 않는다', () => {
    const { store, adapter } = harness();
    store.addUnit(new WorkUnit({
      id: 'u', title: 'u', source: 'mock', status: Status.RUNNING,
      children: [new ChildUnit({ id: 'c', title: 'c', status: Status.DONE_UNSEEN, runId: 'run-7' })],
    }));
    const n = store.unacknowledgedNotifications()[0];
    store.acknowledgeNotification(n.id);
    const s = adapter.snapshot();
    assert.equal(s.acks.length, 1);
    assert.deepEqual(
      { ...s.acks[0], acknowledgedAt: undefined },
      { unitId: 'u', childId: 'c', kind: NotificationKind.COMPLETION, runId: 'run-7', acknowledgedAt: undefined },
    );
    assert.equal('id' in s.acks[0], false);
  });

  it('P13c 슬롯에 없는 unit의 ACK는 버린다', () => {
    const { store, adapter } = harness();
    store.addUnit(new WorkUnit({
      id: 'gone', title: 'g', source: 'mock', status: Status.DONE_UNSEEN, children: [],
    }));
    const n = store.unacknowledgedNotifications()[0];
    store.acknowledgeNotification(n.id);
    assert.equal(store.releaseUnit('gone', { now: 9_999_999, graceMs: 0 }), true);
    assert.deepEqual(adapter.snapshot().acks, []);
  });

  it('P13d ACK는 최근 200건까지만', () => {
    const { store, adapter } = harness();
    const children = [];
    for (let i = 0; i < 250; i += 1) {
      children.push(new ChildUnit({ id: `c${i}`, title: 'c', status: Status.DONE_UNSEEN, runId: `r${i}` }));
    }
    store.addUnit(new WorkUnit({ id: 'u', title: 'u', source: 'mock', status: Status.RUNNING, children }));
    for (const n of store.unacknowledgedNotifications()) store.acknowledgeNotification(n.id);
    assert.equal(adapter.snapshot().acks.length, 200);
  });
});

describe('M5-1 / 복원', () => {
  function saved(dir) {
    const a = harness({ dir });
    a.store.addUnit(orcaUnit('a', { pinned: true }));
    a.store.addUnit(orcaUnit('b'));
    a.store.addUnit(orcaUnit('c'));
    a.store.setUnitStatus('b', Status.WAITING_APPROVAL);
    assert.equal(a.store.releaseUnit('b', { now: 9_999_999, graceMs: 0 }), false, 'WAITING은 반납 안 됨');
    // b를 비워 '0, 2'만 남긴 배치를 만든다 (사용자가 나중에 비운 상황)
    a.store.setUnitStatus('b', Status.DONE_SEEN);
    assert.equal(a.store.releaseUnit('b', { now: 9_999_999, graceMs: 0 }), true);
    assert.equal(a.adapter.flush().ok, true);
    return a;
  }

  it('P14 자리를 순서대로 되살린다 — 빈칸은 당겨진다 (2026-09-29 자동 정리)', () => {
    const dir = tmp();
    saved(dir);                        // b를 반납하면 c가 1번으로 당겨진 채 저장된다
    const { store, adapter } = harness({ dir });
    const r = adapter.restore();
    assert.deepEqual(r.restored, ['a', 'c']);
    assert.equal(store.globalSlots.globalIndexOf('a'), 0);
    assert.equal(store.globalSlots.globalIndexOf('c'), 1);
    // 새로 발견된 것은 다음 빈 자리로 간다. 기존 자리를 밀지 않는다.
    store.addUnit(orcaUnit('new'));
    assert.equal(store.globalSlots.globalIndexOf('new'), 2);
  });

  it('P14b 복원된 것은 전부 UNKNOWN·INFERRED·children 없음이다 — 저장 당시 상태와 무관하게', () => {
    const dir = tmp();
    saved(dir);
    const { store, adapter } = harness({ dir });
    adapter.restore();
    for (const id of ['a', 'c']) {
      const u = store.getUnit(id);
      assert.equal(u.status, Status.UNKNOWN, id);
      assert.equal(u.ownStatus, Status.UNKNOWN, id);
      assert.equal(u.confidence, Confidence.INFERRED, id);
      assert.deepEqual(u.children, [], id);
      assert.ok(u.restoredAt > 0, id);
      assert.equal(u.observedAt, 0, id);
    }
  });

  it('P14c 핀과 제목이 남는다', () => {
    const dir = tmp();
    saved(dir);
    const { store, adapter } = harness({ dir });
    adapter.restore();
    assert.equal(store.getUnit('a').pinned, true);
    assert.equal(store.getUnit('c').pinned, false);
    assert.equal(store.getUnit('a').title, '제목 a');
  });

  it('P15 같은 id가 이미 있으면 건너뛰고 경고한다 — 죽지 않는다', () => {
    const dir = tmp();
    saved(dir);
    const { store, adapter } = harness({ dir });
    store.addUnit(orcaUnit('a'));            // 다른 경로로 먼저 들어온 상황
    const r = adapter.restore();
    assert.deepEqual(r.restored, ['c']);
    assert.equal(r.skipped.length, 1);
    assert.equal(r.skipped[0].id, 'a');
    assert.match(r.skipped[0].reasonKo, /이미/);
  });

  it('P15b 자리가 이미 찼으면 그 항목만 건너뛴다', () => {
    const dir = tmp();
    saved(dir);
    const { store, adapter } = harness({ dir });
    store.addUnit(orcaUnit('x'));            // 0번을 먼저 차지
    const r = adapter.restore();
    assert.deepEqual(r.restored, ['c']);
    assert.equal(r.skipped[0].id, 'a');
    assert.match(r.skipped[0].reasonKo, /자리/);
  });

  it('P16 뱅크 범위를 넘는 자리는 되살린 뒤 앞으로 당겨진다', () => {
    const dir = tmp();
    const a = harness({ dir });
    a.store.addUnit(orcaUnit('far'), { atGlobalIndex: 17 });
    assert.equal(a.adapter.flush().ok, true);
    const { store, adapter } = harness({ dir });
    adapter.restore();
    assert.equal(store.globalSlots.globalIndexOf('far'), 0);
    assert.equal(store.globalSlots.bankCount, 1);
  });

  it('P17 파일이 없으면 아무것도 안 하고 경고도 없다', () => {
    const { adapter } = harness();
    assert.deepEqual(adapter.restore(), { restored: [], skipped: [], warningKo: null });
  });

  it('P17b 깨진 파일이면 빈 상태 + 경고', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'state.json'), 'garbage', 'utf8');
    const { adapter } = harness({ dir });
    const r = adapter.restore();
    assert.deepEqual(r.restored, []);
    assert.match(r.warningKo, /손상/);
  });
});

describe('M5-1 / 저장 시점', () => {
  it('P18 커밋이 여러 번 와도 debounce 뒤 한 번만 쓴다', () => {
    const { store, adapter, fileStore, timers, fireTimers } = harness();
    adapter.start();
    store.addUnit(orcaUnit('a'));
    store.addUnit(orcaUnit('b'));
    store.setUnitStatus('a', Status.WAITING_INPUT);
    assert.equal(fs.existsSync(fileStore.path), false, '아직 안 썼다');
    assert.equal(timers.length, 1, '타이머는 하나로 합쳐진다');
    fireTimers();
    assert.equal(adapter.writeCount, 1);
    assert.equal(fileStore.read().state.slots.length, 2);
  });

  it('P18b 변화가 없으면 쓰지 않는다', () => {
    const { adapter, timers } = harness();
    adapter.start();
    assert.equal(timers.length, 0);
  });

  it('P19 flush는 즉시 쓰고 대기 중인 타이머를 지운다', () => {
    const { store, adapter, fileStore, timers } = harness();
    adapter.start();
    store.addUnit(orcaUnit('a'));
    assert.equal(timers.length, 1);
    assert.equal(adapter.flush().ok, true);
    assert.equal(timers.length, 0);
    assert.equal(fileStore.read().state.slots[0].id, 'a');
  });

  it('P20 stop 뒤에는 커밋을 들어도 쓰지 않는다', () => {
    const { store, adapter, timers } = harness();
    adapter.start();
    adapter.stop();
    store.addUnit(orcaUnit('a'));
    assert.equal(timers.length, 0);
  });

  it('P21 복원된 unit이 관측되면 표식이 찍힌다', () => {
    const dir = tmp();
    const a = harness({ dir });
    a.store.addUnit(orcaUnit('a'));
    a.adapter.flush();
    const { store, adapter } = harness({ dir, now: 5_000 });
    adapter.restore();
    adapter.start();
    assert.equal(store.getUnit('a').observedAt, 0);
    store.setUnitStatus('a', Status.RUNNING);       // OrcaSync가 하는 일
    assert.equal(store.getUnit('a').observedAt, 5_000);
    assert.equal(adapter.restoredIds.has('a'), false);
  });

  it('P21b 목록에 없어 DISCONNECTED가 된 것은 관측이 아니다 — 유예 반납이 살아 있어야 한다', () => {
    const dir = tmp();
    const a = harness({ dir });
    a.store.addUnit(orcaUnit('a'));
    a.adapter.flush();
    const { store, adapter } = harness({ dir, now: 5_000 });
    adapter.restore();
    adapter.start();
    store.setUnitStatus('a', Status.DISCONNECTED);   // OrcaSync: 목록에서 사라짐
    assert.equal(store.getUnit('a').observedAt, 0, '관측의 부재를 관측으로 치지 않는다');
    assert.equal(adapter.restoredIds.has('a'), true);
    assert.deepEqual(adapter.sweep({ now: 5_000 + 600_000 }), ['a']);
  });

  it('P22 쓰기에 실패해도 죽지 않고, 같은 오류를 매번 되풀이하지 않는다', () => {
    const dir = tmp();
    const { store, adapter, fireTimers } = harness({ dir });
    adapter.start();
    fs.chmodSync(dir, 0o500);                        // 쓰기 금지
    try {
      store.addUnit(orcaUnit('a'));
      fireTimers();
      assert.ok(adapter.lastWriteError, '오류가 기록된다');
      const first = adapter.lastWriteError;
      store.addUnit(orcaUnit('b'));
      fireTimers();
      assert.equal(adapter.lastWriteError, first, '같은 오류면 문자열이 그대로다 (호출자가 한 번만 출력할 수 있다)');
      assert.equal(adapter.writeCount, 0);
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  });
});

describe('M5-1 / ACK 재적용', () => {
  const doneChild = (runId) => new ChildUnit({ id: 'c', title: 'c', status: Status.DONE_UNSEEN, ...(runId ? { runId } : {}) });

  function savedAck(dir, runId, source = 'mock') {
    const a = harness({ dir });
    a.store.addUnit(new WorkUnit({
      id: 'u', title: 'u', source, status: Status.RUNNING, children: [doneChild(runId)],
    }));
    a.store.acknowledgeNotification(a.store.unacknowledgedNotifications()[0].id);
    a.adapter.flush();
  }

  it('P13 runId가 있는 완료 알림은 다시 생겨도 확인된 상태로 만든다', async () => {
    const dir = tmp();
    savedAck(dir, 'run-7');
    const { store, adapter } = harness({ dir });
    adapter.restore();
    adapter.start();
    // adapter 조회가 같은 run의 완료를 다시 가져온 상황
    store.addChild('u', doneChild('run-7'));
    await new Promise((r) => setImmediate(r));
    assert.equal(store.unacknowledgedNotifications().length, 0, '다시 확인을 요구하지 않는다');
    assert.equal(store.getUnit('u').child('c').status, Status.DONE_SEEN);
  });

  it('P13e runId가 없으면 자동 확인하지 않는다 — 재시작 중 새 완료였는지 알 수 없다', async () => {
    const dir = tmp();
    savedAck(dir, null, 'orca');
    const { store, adapter } = harness({ dir });
    adapter.restore();
    adapter.start();
    store.addChild('u', doneChild(null));
    await new Promise((r) => setImmediate(r));
    assert.equal(store.unacknowledgedNotifications().length, 1, '보수적으로 다시 보여준다');
  });

  it('P13f 다른 run의 완료는 새 알림이다', async () => {
    const dir = tmp();
    savedAck(dir, 'run-7');
    const { store, adapter } = harness({ dir });
    adapter.restore();
    adapter.start();
    store.addChild('u', doneChild('run-8'));
    await new Promise((r) => setImmediate(r));
    assert.equal(store.unacknowledgedNotifications().length, 1);
  });
});

describe('M5-1 / 유예 반납', () => {
  it('P23 복원 후 관측 없이 유예가 지나면 자리를 반납한다', () => {
    const dir = tmp();
    const a = harness({ dir });
    a.store.addUnit(orcaUnit('a'));
    a.store.addUnit(orcaUnit('b'));
    a.adapter.flush();
    const { store, adapter } = harness({ dir, now: 1_000 });
    adapter.restore();
    adapter.start();
    store.setUnitStatus('b', Status.RUNNING);                   // b만 관측됨
    assert.deepEqual(adapter.sweep({ now: 1_000 + 599_999 }), [], '유예 전');
    assert.deepEqual(adapter.sweep({ now: 1_000 + 600_000 }), ['a']);
    assert.equal(store.getUnit('a'), null);
    assert.equal(store.getUnit('b').id, 'b', '관측된 것은 남는다');
    assert.equal(adapter.restoredIds.has('a'), false);
  });

  it('P23b 고정된 것은 유예가 지나도 남는다', () => {
    const dir = tmp();
    const a = harness({ dir });
    a.store.addUnit(orcaUnit('a', { pinned: true }));
    a.adapter.flush();
    const { store, adapter } = harness({ dir, now: 1_000 });
    adapter.restore();
    assert.deepEqual(adapter.sweep({ now: 99_999_999 }), []);
    assert.equal(store.getUnit('a').id, 'a');
  });
});

describe('M5-1 / Core 순수성', () => {
  it('P24 src/core는 파일시스템을 모른다', () => {
    const dir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'core');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      assert.equal(/from\s+['"]node:(fs|path|os)['"]/.test(src), false, `${f}이(가) 파일시스템을 import한다`);
      assert.equal(/from\s+['"](fs|path|os)['"]/.test(src), false, f);
    }
  });
});

describe('M5-1 / 배선', () => {
  it('P25 기본 위치는 홈의 .output, OUTPUT_HOME이 있으면 그것', () => {
    const saved = process.env.OUTPUT_HOME;
    try {
      delete process.env.OUTPUT_HOME;
      assert.equal(defaultDir(), path.join(os.homedir(), '.output'));
      process.env.OUTPUT_HOME = '/tmp/cb-x';
      assert.equal(defaultDir(), '/tmp/cb-x');
    } finally {
      if (saved === undefined) delete process.env.OUTPUT_HOME; else process.env.OUTPUT_HOME = saved;
    }
  });
  it('P25b createPersistence는 한 벌을 묶어 준다', () => {
    const dir = tmp();
    const store = new StateStore();
    const p = createPersistence({ store, dir });
    assert.equal(p.dir, dir);
    assert.equal(p.fileStore.path, path.join(dir, 'state.json'));
    assert.equal(p.adapter.store, store);
  });
});

describe('M5-1 / 최종 리뷰 반영', () => {
  it('R1 목록에 계속 있는 복원 unit은 상태가 안 바뀌어도 관측된 것이다 — 반납하지 않는다', () => {
    const dir = tmp();
    const a = harness({ dir });
    a.store.addUnit(orcaUnit('wA'), { atGlobalIndex: 3 });
    a.adapter.flush();
    const { store, adapter } = harness({ dir, now: 1_000 });
    adapter.restore();
    adapter.start();
    // 목록에는 있지만 상태가 여전히 UNKNOWN (터미널 없음, 뜻 모르는 workspaceStatus)
    adapter.noteSeen(['wA']);
    assert.deepEqual(adapter.sweep({ now: 1_000 + 600_000 }), [], '목록에 있으면 자리를 지킨다');
    assert.equal(store.globalSlots.globalIndexOf('wA'), 0, '복원 시 앞으로 당겨진 자리');
  });

  it('R1b noteSeen은 목록에 없는 복원 unit을 건드리지 않는다', () => {
    const dir = tmp();
    const a = harness({ dir });
    a.store.addUnit(orcaUnit('wA'));
    a.store.addUnit(orcaUnit('wB'));
    a.adapter.flush();
    const { adapter } = harness({ dir, now: 1_000 });
    adapter.restore();
    adapter.noteSeen(['wA']);
    assert.deepEqual(adapter.sweep({ now: 1_000 + 600_000 }), ['wB']);
  });

  it('R2 쓰기는 대상 파일을 제자리에서 덮지 않는다 — 임시 파일에 쓰고 바꿔 넣는다', () => {
    const dir = tmp();
    const writes = [];
    const renames = [];
    const spyFs = {
      ...fs,
      writeFileSync: (p, ...rest) => { writes.push(p); return fs.writeFileSync(p, ...rest); },
      renameSync: (a1, b1) => { renames.push([a1, b1]); return fs.renameSync(a1, b1); },
    };
    const store = new FileStore({ dir, fs: spyFs });
    assert.equal(store.write(emptyState()).ok, true);
    assert.ok(writes.length > 0, '주입한 fs로 쓴다');
    assert.ok(writes.every((p) => p !== store.path), '대상 파일에 직접 쓰지 않는다');
    assert.deepEqual(renames.map((r) => r[1]), [store.path], '마지막에 바꿔 넣는다');
    assert.deepEqual(fs.readdirSync(dir), ['state.json'], '임시 파일이 남지 않는다');
    assert.deepEqual(store.read().state, emptyState());
  });

  it('R3 사라졌다 돌아온 unit은 DISCONNECTED에서 풀린다 — 들어온 상태가 null이어도', () => {
    const store = new StateStore();
    const sync = new OrcaSync(store);
    const mk = (children = []) => new WorkUnit({
      id: 'w', title: 'w', source: 'orca', status: null, children,
    });
    sync.syncOnce([mk()]);
    sync.syncOnce([]);                                    // 목록에서 빠짐
    assert.equal(store.getUnit('w').ownStatus, Status.DISCONNECTED);
    sync.syncOnce([mk([new ChildUnit({ id: 't', title: 't', status: Status.RUNNING })])]);
    assert.notEqual(store.getUnit('w').status, Status.DISCONNECTED, '돌아왔으면 끊김이 아니다');
    assert.equal(store.getUnit('w').status, Status.RUNNING);
  });
});

// ───────────────────────── 개선 3 — 원자적 JSON 쓰기 한 벌

import { writeJsonAtomic } from '../src/adapters/persistence/fileStore.js';

describe('개선 3 / writeJsonAtomic', () => {
  it('A01 임시 파일에 쓰고 바꿔 넣는다 — 끝나면 임시 파일이 남지 않는다', () => {
    const dir = tmp();
    const file = path.join(dir, 'nested', 'x.json');
    writeJsonAtomic(file, { a: 1 });
    assert.equal(fs.readFileSync(file, 'utf8'), '{\n  "a": 1\n}\n');
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['x.json']);
  });

  it('A02 쓰기가 실패하면 던지고 임시 파일을 치운다', () => {
    const dir = tmp();
    const file = path.join(dir, 'y.json');
    const broken = { ...fs, renameSync: () => { throw new Error('boom'); } };
    assert.throws(() => writeJsonAtomic(file, { a: 1 }, broken), /boom/);
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});
