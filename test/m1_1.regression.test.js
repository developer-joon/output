/**
 * M1.1 회귀 테스트 — ACCEPTANCE_CHECKLIST_KO.md C01~C21 중 로컬 검증 가능 항목.
 * 각 테스트는 CODEX_NEXT_TASK_KO.md 2.x 절의 결함을 드러내기 위해 먼저 작성되었다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { StateStore } from '../src/core/stateStore.js';
import { WorkUnit, ChildUnit } from '../src/core/units.js';
import { Status, Impact, ChildRole } from '../src/core/types.js';
import { aggregateUnitStatus, rankAttention, resolveFocusTarget, summarizeAmbient }
  from '../src/core/policy.js';
import { Output } from '../src/output.js';
import { EventBus, Events } from '../src/core/eventBus.js';
import { seedWorkUnits } from '../src/adapters/mockOrcaAdapter.js';
import { MockFocusRouter } from '../src/core/focusRouter.js';
import { } from '../src/core/lightingPolicy.js';

const child = (o) => new ChildUnit(o);

function bridge() {
  const store = new StateStore();
  for (const u of seedWorkUnits()) store.addUnit(u);
  const router = new MockFocusRouter();
  return { store, router, cb: new Output({ store, focusRouter: router }) };
}

// ───────────── 2.1 정책 4분리
describe('M1.1 / 정책 분리 (CODEX_NEXT_TASK 2.1)', () => {
  it('R17 대표상태·개입순서·포커스대상·요약조명이 별도 순수 함수다', () => {
    for (const fn of [aggregateUnitStatus, rankAttention, resolveFocusTarget, summarizeAmbient]) {
      assert.equal(typeof fn, 'function');
    }
  });

  it('R17b 세 정책이 같은 입력에서 서로 다른 답을 낼 수 있다', () => {
    // 상주 shell이 ERROR, 필수 agent가 WAITING_INPUT인 작업
    const u = new WorkUnit({
      id: 'u', children: [
        child({ id: 'agent', role: ChildRole.AGENT, status: Status.WAITING_INPUT, lastActiveAt: 10 }),
        child({ id: 'tail', role: ChildRole.LOG_TAIL, status: Status.ERROR, lastActiveAt: 1 }),
      ],
    });
    // 대표 상태는 가장 급한 사실(ERROR)
    assert.equal(aggregateUnitStatus(u), Status.ERROR);
    // 포커스 대상은 사람이 실제로 조치할 수 있는 곳
    assert.equal(resolveFocusTarget(u).id, 'tail');
  });
});

// ───────────── 2.2 실행 상태 / 상주 child / parent 사실
describe('M1.1 / 대표 상태 (C07 C08 C09)', () => {
  it('R01(C09) parent 자체 오류가 정상 children 때문에 사라지지 않는다', () => {
    const u = new WorkUnit({
      id: 'u', status: Status.ERROR,
      children: [child({ id: 'a', status: Status.RUNNING }), child({ id: 'b', status: Status.DONE_SEEN })],
    });
    assert.equal(u.status, Status.ERROR);
  });

  it('R02(C08) 필수 child가 RUNNING이면 다른 child의 완료로 부모를 완료 처리하지 않는다', () => {
    const u = new WorkUnit({
      id: 'u', children: [
        child({ id: 'build', role: ChildRole.TASK, status: Status.RUNNING }),
        child({ id: 'agent', role: ChildRole.AGENT, status: Status.DONE_UNSEEN }),
      ],
    });
    assert.equal(u.status, Status.RUNNING);
  });

  it('R03(C07) 상주 dev server 때문에 완료가 RUNNING으로 가려지지 않는다', () => {
    const u = new WorkUnit({
      id: 'u', children: [
        child({ id: 'agent', role: ChildRole.AGENT, status: Status.DONE_UNSEEN }),
        child({ id: 'dev', role: ChildRole.DEV_SERVER, status: Status.RUNNING }),
      ],
    });
    assert.equal(u.children.find((c) => c.id === 'dev').requiredForCompletion, false);
    assert.equal(u.status, Status.DONE_UNSEEN);
  });

  it('R18 작업 없음(EMPTY)과 상태 미확인(UNKNOWN)을 구분한다', () => {
    assert.notEqual(Status.UNKNOWN, Status.EMPTY);
    const u = new WorkUnit({ id: 'u' }); // child 없음, 상태 정보 없음
    assert.equal(u.status, Status.UNKNOWN);
  });

  it('R16(C15) 오래된 run의 이벤트가 최신 run을 덮지 않는다', () => {
    const store = new StateStore();
    store.addUnit(new WorkUnit({ id: 'u', children: [child({ id: 'u/a', status: Status.RUNNING })] }));
    store.applyChildEvent({ unitId: 'u', childId: 'u/a', runId: 'run-2', seq: 5, status: Status.RUNNING });
    const before = store.revision;
    // 늦게 도착한 옛 run
    const applied = store.applyChildEvent({ unitId: 'u', childId: 'u/a', runId: 'run-1', seq: 9, status: Status.DONE_UNSEEN });
    assert.equal(applied, false);
    assert.equal(store.getUnit('u').child('u/a').status, Status.RUNNING);
    assert.equal(store.revision, before);
    // 같은 run의 역순 seq도 무시
    assert.equal(store.applyChildEvent({ unitId: 'u', childId: 'u/a', runId: 'run-2', seq: 4, status: Status.ERROR }), false);
    assert.equal(store.getUnit('u').child('u/a').status, Status.RUNNING);
  });
});

// ───────────── 2.1 개입 순서
describe('M1.1 / 개입 순서 (C04 C05 C06)', () => {
  it('R14(C04) 확인한 과거 오류가 새 답변 요청을 영구히 가리지 않는다', () => {
    const store = new StateStore();
    store.addUnit(new WorkUnit({ id: 'old', children: [child({ id: 'old/a', status: Status.ERROR })] }));
    const cb = new Output({ store });
    const n = store.notificationsFor('old', 'old/a')[0];
    assert.ok(n, '오류에 알림이 생성되어야 한다');
    store.acknowledgeNotification(n.id);
    // 오류 사실은 남는다
    assert.equal(store.getUnit('old').child('old/a').status, Status.ERROR);
    // 새 답변 요청 도착
    store.addUnit(new WorkUnit({ id: 'new', children: [child({ id: 'new/a', status: Status.WAITING_INPUT })] }));
    assert.equal(cb.attention.items()[0].childId, 'new/a');
  });

  it('R15(C05) 명시적 영향도가 낮은 중요도 요청보다 우선한다', () => {
    const store = new StateStore();
    store.addUnit(new WorkUnit({ id: 'req', impact: Impact.LOW,
      children: [child({ id: 'req/a', status: Status.WAITING_INPUT })] }));
    store.addUnit(new WorkUnit({ id: 'prod', impact: Impact.CRITICAL,
      children: [child({ id: 'prod/a', status: Status.ERROR })] }));
    const cb = new Output({ store });
    assert.equal(cb.attention.items()[0].unitId, 'prod');
  });

  it('R19(C06) ATTENTION 반복 중 새 긴급 이벤트가 즉시 드러난다', async () => {
    const { cb, store, router } = bridge();
    await cb.pressAttention();
    await cb.pressAttention();
    store.addUnit(new WorkUnit({ id: 'urgent', impact: Impact.CRITICAL,
      children: [child({ id: 'urgent/a', status: Status.ERROR })] }));
    await cb.pressAttention();
    assert.equal(router.last().unitId, 'urgent');
  });
});

// ───────────── 2.3 ACK 대상과 시점
describe('M1.1 / ACK 대상 (C10 C11 C12)', () => {
  it('R07(C12) 부모 ACK이 모든 child 알림을 일괄 확인하지 않는다', () => {
    const store = new StateStore();
    store.addUnit(new WorkUnit({ id: 'u', children: [
      child({ id: 'u/a', status: Status.DONE_UNSEEN }),
      child({ id: 'u/b', status: Status.DONE_UNSEEN }),
    ] }));
    const cb = new Output({ store });
    cb.render();
    const acked = cb.pressAck();
    assert.equal(acked.length, 1, '한 번에 알림 하나만 확인');
    const remaining = store.unacknowledgedNotifications();
    assert.equal(remaining.length, 1);
  });

  it('R08(C10) 표시된 알림 이후 새 run 알림이 와도 표시됐던 것만 처리한다', () => {
    const store = new StateStore();
    store.addUnit(new WorkUnit({ id: 'u', children: [child({ id: 'u/a', status: Status.RUNNING })] }));
    store.applyChildEvent({ unitId: 'u', childId: 'u/a', runId: 'run-1', seq: 1, status: Status.DONE_UNSEEN });
    const cb = new Output({ store });
    const shown = cb.render();
    const shownNotif = shown.slots[0].notification.id;
    // 사용자가 누르기 직전 새 run이 완료 알림을 추가
    store.applyChildEvent({ unitId: 'u', childId: 'u/a', runId: 'run-2', seq: 1, status: Status.RUNNING });
    store.applyChildEvent({ unitId: 'u', childId: 'u/a', runId: 'run-2', seq: 2, status: Status.DONE_UNSEEN });
    cb.pressAck();
    // C10: 표시됐던 알림만 확인하거나, 낡았으면 안전하게 거절한다.
    const shownState = store.notification(shownNotif);
    const refusedSafely = cb.lastAckResult.ok === false && cb.lastAckResult.acked.length === 0;
    assert.ok(shownState.acknowledged || refusedSafely,
      '표시된 알림을 확인하거나 한국어 안내와 함께 거절해야 한다');
    if (refusedSafely) assert.match(cb.lastAckResult.reasonKo, /[가-힣]/);
    // 어느 경우에도 새 run의 알림은 건드리지 않는다.
    const fresh = [...store._notifications.values()].find((n) => n.runId === 'run-2');
    assert.equal(fresh.acknowledged, false, '새 run 알림은 확인되지 않음');
    assert.notEqual(fresh.id, shownNotif);
  });

  it('R09(C11) WAITING_APPROVAL에서 ACK/ATTENTION은 승인 payload를 0회 전송한다', async () => {
    const { cb, router, store } = bridge();
    cb.banks.goto(1); cb.selectedSlot = 1;
    cb.render();
    cb.pressAck();
    await cb.pressAttention();
    assert.equal(store.getUnit('billing/invoice-pdf').status, Status.WAITING_APPROVAL);
    assert.equal(router.calls.filter((c) => c.kind === 'approve' || c.submit).length, 0);
    assert.equal(typeof router.approve, 'undefined', 'FocusRouter에 승인 경로가 없어야 한다');
  });

  it('R20 focus가 자동 ACK이 되지 않는다', async () => {
    const { cb, store } = bridge();
    cb.banks.goto(1); cb.selectedSlot = 3;
    cb.render();
    await cb.pressSlot(4);
    assert.equal(store.getUnit('data/etl-backfill').status, Status.DONE_UNSEEN);
  });
});

// ───────────── 2.4 슬롯 자동 해제
describe('M1.1 / 슬롯 보존 (C13)', () => {
  const cases = [
    ['RUNNING', Status.RUNNING],
    ['WAITING_INPUT', Status.WAITING_INPUT],
    ['WAITING_APPROVAL', Status.WAITING_APPROVAL],
    ['미해결 ERROR', Status.ERROR],
    ['DONE_UNSEEN', Status.DONE_UNSEEN],
    ['DISCONNECTED', Status.DISCONNECTED],
  ];
  for (const [label, status] of cases) {
    it(`R04 ${label} 작업은 자동 해제되지 않는다`, () => {
      const store = new StateStore();
      store.addUnit(new WorkUnit({ id: 'u', status, children: [] }));
      assert.equal(store.releaseUnit('u'), false);
      assert.equal(store.globalSlots.globalIndexOf('u'), 0);
    });
  }

  it('R05 pin된 작업은 종료·확인 후에도 자동 해제되지 않는다', () => {
    const store = new StateStore();
    store.addUnit(new WorkUnit({ id: 'u', status: Status.DONE_SEEN, pinned: true }));
    assert.equal(store.releaseUnit('u'), false);
  });

  it('R06 종료 + 알림 확인 + 비고정이면 해제된다', () => {
    const store = new StateStore();
    store.addUnit(new WorkUnit({ id: 'u', status: Status.DONE_SEEN }));
    assert.equal(store.releaseUnit('u'), true);
  });
});

// ───────────── 2.5 snapshot 불변성
describe('M1.1 / snapshot 불변 (C16)', () => {
  it('R10 반환 viewmodel의 중첩 값을 바꿔도 Store와 다음 snapshot에 영향이 없다', () => {
    const { cb } = bridge();
    const s1 = cb.render();
    assert.throws(() => { s1.slots[0].status = Status.ERROR; }, TypeError);
    assert.throws(() => { s1.lighting.threads[0] = null; }, TypeError);
    assert.throws(() => { s1.slots.push({}); }, TypeError);
    const s2 = cb.render();
    assert.equal(s2.slots[0].status, Status.RUNNING);
    assert.equal(s2.slots.length, 10);
  });

  it('R10b snapshot에 revision이 있고 커밋마다 증가한다', () => {
    const { cb, store } = bridge();
    const r1 = cb.render().revision;
    store.setChildStatus('api/cache-refactor', 'api/cache-refactor/claude', Status.ERROR);
    assert.ok(cb.render().revision > r1);
  });
});

// ───────────── 3. EventBus
describe('M1.1 / EventBus 최소 계약 (C19 C20)', () => {
  it('R11(C20) 구독자 하나가 실패해도 Store와 다른 구독자에 전파되지 않는다', () => {
    const bus = new EventBus();
    const seen = [];
    bus.on(Events.COMMITTED, () => { throw new Error('boom'); });
    bus.on(Events.COMMITTED, (p) => seen.push(p.revision));
    const store = new StateStore({ bus });
    assert.doesNotThrow(() => store.addUnit(new WorkUnit({ id: 'u', status: Status.RUNNING })));
    assert.deepEqual(seen, [store.revision]);
    assert.equal(bus.errors.length, 1);
  });

  it('R12(C19) unsubscribe 후에는 호출되지 않는다', () => {
    const bus = new EventBus();
    let n = 0;
    const off = bus.on(Events.COMMITTED, () => { n += 1; });
    const store = new StateStore({ bus });
    store.addUnit(new WorkUnit({ id: 'a', status: Status.RUNNING }));
    off();
    store.addUnit(new WorkUnit({ id: 'b', status: Status.RUNNING }));
    assert.equal(n, 1);
  });
});

// ───────────── 2.6 설정 오류
