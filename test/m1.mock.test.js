import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Output } from '../src/output.js';
import { StateStore } from '../src/core/stateStore.js';
import { WorkUnit, ChildUnit } from '../src/core/units.js';
import { Status, View, StatusLabelKo } from '../src/core/types.js';
import { seedWorkUnits } from '../src/adapters/mockOrcaAdapter.js';
import { MockFocusRouter } from '../src/core/focusRouter.js';
import { THREAD_STYLE, AMBIENT_NORMAL } from '../src/core/lightingPolicy.js';
import { LOGICAL_TO_AG, SLOTS_PER_BANK, DIAL_PRESS_AG } from '../src/core/hardware.js';

function build() {
  const store = new StateStore();
  for (const u of seedWorkUnits()) store.addUnit(u);
  const router = new MockFocusRouter();
  return { store, router, cb: new Output({ store, focusRouter: router, profile: 'macOS' }) };
}

const ids = (cb) => cb.render().slots.map((s) => s.id);

// ───────────────────────────── 1. 6 slot + bank
describe('1. 6 slot + bank', () => {
  it('30 WorkUnit -> 3 bank, bank당 10 slot', () => {
    const { cb, store } = build();
    assert.equal(store.allUnits().length, 30);
    assert.equal(cb.banks.count, 3);
    assert.equal(cb.render().slots.length, SLOTS_PER_BANK);
  });

  it('각 bank가 서로 다른 10개 unit을 보여준다', () => {
    const { cb } = build();
    const seen = [];
    for (let b = 0; b < 3; b += 1) {
      cb.banks.goto(b);
      seen.push(...ids(cb));
    }
    assert.equal(seen.length, 30);
    assert.equal(new Set(seen).size, 30);
  });

  it('joystick RIGHT/LEFT가 bank를 순환 이동시킨다', () => {
    const { cb } = build();
    assert.equal(cb.joystickRight(), 1);
    assert.equal(cb.joystickRight(), 2);
    assert.equal(cb.joystickRight(), 0); // wrap
    assert.equal(cb.joystickLeft(), 2);  // wrap back
  });

  it('bank 이동은 slot 할당을 바꾸지 않는다', () => {
    const { cb, store } = build();
    const before = store.globalSlots.positionOf('qa/e2e-flake');
    cb.joystickRight(); cb.joystickRight(); cb.joystickLeft();
    assert.deepEqual(store.globalSlots.positionOf('qa/e2e-flake'), before);
  });

  it('DIAL CW/CCW는 다음·이전 세션으로 이동한다 — 전체 슬롯 순서, 끝에서 돈다 (2026-10-01)', async () => {
    const { cb, store } = build();
    assert.equal(cb.dialCW(), 1);
    assert.equal(cb.dialCCW(), 0);
    const last = Math.max(...store.globalSlots.ids().map((id) => store.globalSlots.globalIndexOf(id)));
    assert.equal(cb.dialCCW(), last, '처음에서 반시계면 마지막 세션');
    await cb.dialIdle();
  });

  it('DIAL press는 hardware 검증 전까지 optional capability', async () => {
    const { cb } = build();
    assert.equal(DIAL_PRESS_AG, null);
    const r = await cb.dialPress();
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'dial_press_not_validated');
  });
});

// ───────────────────────────── 2. stable slot
describe('2. stable slot', () => {
  it('SLOT 1~6 물리 위치와 AG 매핑이 계약과 일치한다', () => {
    assert.equal(LOGICAL_TO_AG.slot1, 'AG01');
    assert.equal(LOGICAL_TO_AG.slot2, 'AG00');
    assert.equal(LOGICAL_TO_AG.attention, 'AG10');
    assert.equal(LOGICAL_TO_AG.ack, 'AG11');
    assert.equal(LOGICAL_TO_AG.mode_back, 'AG12');
  });

  it('새 unit이 기존 occupied slot을 밀지 않는다', () => {
    const { cb, store } = build();
    const before = ids(cb);
    store.addUnit(new WorkUnit({ id: 'new/unit', title: 'new/unit', children: [new ChildUnit({ id: 'new/unit/sh', status: Status.RUNNING })] }));
    assert.deepEqual(ids(cb), before);
    assert.deepEqual(store.globalSlots.positionOf('new/unit'), { bank: 3, slot: 0 });
    assert.equal(cb.banks.count, 4);
  });

  it('반납되면 뒤의 자리가 순서대로 당겨지고, 새 작업은 그 뒤 빈 자리로 간다 (2026-09-29 자동 정리)', () => {
    const { cb, store } = build();
    const before = ids(cb);
    const nextBank = [store.globalSlots.idAt(1, 0)];
    store.setUnitStatus('web/login-a11y', Status.DONE_SEEN);
    store.getUnit('web/login-a11y').children.length = 0;
    assert.equal(store.removeUnit('web/login-a11y'), true);
    store.addUnit(new WorkUnit({ id: 'fresh/task', title: 'fresh/task', status: Status.RUNNING }));
    const after = ids(cb);
    assert.deepEqual([after[0], after[1], after[2]], [before[0], before[1], before[2]], '앞은 그대로');
    assert.deepEqual(after.slice(3, 9), before.slice(4, 10), '뒤는 한 칸씩 앞으로');
    assert.equal(after[9], nextBank[0], '다음 묶음의 첫 작업이 이 묶음 끝으로 올라온다');
    const total = store.globalSlots.size;
    assert.equal(store.globalSlots.globalIndexOf('fresh/task'), total - 1, '새 작업은 맨 뒤 빈 자리');
  });

  it('DONE_UNSEEN unit은 ACK 전에 slot을 반납하지 않는다', () => {
    const { store } = build();
    const pos = store.globalSlots.positionOf('ml/feature-store');
    assert.equal(store.getUnit('ml/feature-store').status, Status.DONE_UNSEEN);
    assert.equal(store.removeUnit('ml/feature-store'), false);
    assert.deepEqual(store.globalSlots.positionOf('ml/feature-store'), pos);
  });

  it('상태가 바뀌어도 slot이 재정렬되지 않는다', () => {
    const { cb, store } = build();
    const before = ids(cb);
    store.setChildStatus('payments/fix-timeout', 'payments/fix-timeout/test', Status.ERROR);
    store.setChildStatus('api/cache-refactor', 'api/cache-refactor/claude', Status.WAITING_INPUT);
    assert.deepEqual(ids(cb), before);
  });
});

// ───────────────────────────── 3. attention queue
describe('3. attention queue', () => {
  it('우선순위 ERROR > APPROVAL > INPUT > STALE/DISCONNECTED 순으로 정렬된다', () => {
    const { cb } = build();
    const order = cb.attention.items().map((i) => i.status);
    assert.deepEqual([...new Set(order)], [
      Status.ERROR, Status.WAITING_APPROVAL, Status.WAITING_INPUT,
      Status.STALE, Status.DISCONNECTED,
    ]);
  });

  it('DONE_UNSEEN은 attention이 아니다', () => {
    const { cb } = build();
    assert.equal(cb.attention.items().some((i) => i.status === Status.DONE_UNSEEN), false);
  });

  it('현재 bank가 아닌 hidden bank 항목도 queue에 포함된다', () => {
    const { cb } = build();
    assert.equal(cb.banks.current, 0);
    const banks = cb.attention.items().map((i) => Math.floor(i.slot / SLOTS_PER_BANK));
    assert.deepEqual([...new Set(banks)].sort(), [1, 2]);
  });

  it('ATTENTION은 focus만 하고 상태를 바꾸지 않는다', async () => {
    const { cb, router, store } = build();
    const snapshot = store.allUnits().map((u) => u.status);
    await cb.pressAttention();
    assert.equal(router.calls.length, 1);
    assert.equal(router.last().reason, `attention:${Status.ERROR}`);
    assert.deepEqual(store.allUnits().map((u) => u.status), snapshot);
  });

  it('ATTENTION 반복 시 queue를 순환한다', async () => {
    const { cb, router } = build();
    const n = cb.attention.items().length;
    for (let i = 0; i < n + 1; i += 1) await cb.pressAttention();
    assert.equal(router.calls.length, n + 1);
    assert.deepEqual(router.calls[n], router.calls[0]); // 한 바퀴 후 처음으로
  });

  it('ATTENTION long press는 queue dashboard를 반환한다', () => {
    const { cb } = build();
    const d = cb.longPressAttention();
    assert.equal(d.dashboard, 'attention_queue');
    assert.equal(d.items.length, cb.attention.items().length);
  });

  it('joystick DOWN은 다음 unseen done/error로 이동한다', async () => {
    const { cb, router } = build();
    await cb.joystickDown();
    assert.match(router.last().reason, /^unseen:(ERROR|DONE_UNSEEN)$/);
  });
});

// ───────────────────────────── 4. ACK
describe('4. ACK', () => {
  it('ACK는 DONE_UNSEEN -> DONE_SEEN 만 수행한다', () => {
    const { cb, store } = build();
    cb.banks.goto(1);
    cb.selectedSlot = 3; // data/etl-backfill
    assert.equal(cb.render().slots[3].id, 'data/etl-backfill');
    assert.equal(store.getUnit('data/etl-backfill').status, Status.DONE_UNSEEN);
    const changed = cb.pressAck();
    assert.deepEqual(changed, ['data/etl-backfill/codex']);
    assert.equal(store.getUnit('data/etl-backfill').status, Status.DONE_SEEN);
  });

  it('ACK 전에는 DONE_UNSEEN이 유지된다', () => {
    const { cb, store } = build();
    cb.banks.goto(2);
    cb.selectedSlot = 0; // perf/loadtest-v3 (DONE_UNSEEN 아님)
    cb.pressAck();
    assert.equal(store.getUnit('ml/feature-store').status, Status.DONE_UNSEEN);
  });

  it('ACK는 WAITING_APPROVAL을 승인하지 않는다', () => {
    const { cb, store } = build();
    cb.banks.goto(1);
    cb.selectedSlot = 1; // billing/invoice-pdf
    const changed = cb.pressAck();
    assert.deepEqual(changed, []);
    assert.equal(store.getUnit('billing/invoice-pdf').status, Status.WAITING_APPROVAL);
  });

  it('ACK는 WAITING_INPUT을 자동 submit하지 않는다', () => {
    const { cb, store } = build();
    cb.banks.goto(1);
    cb.selectedSlot = 2; // mobile/push-token
    assert.deepEqual(cb.pressAck(), []);
    assert.equal(store.getUnit('mobile/push-token').status, Status.WAITING_INPUT);
  });

  it('ACK는 focus를 발생시키지 않는다', () => {
    const { cb, router } = build();
    cb.banks.goto(1);
    cb.selectedSlot = 3;
    cb.pressAck();
    assert.equal(router.calls.length, 0);
  });

  it('ACK 후에는 slot 반납이 허용된다', () => {
    const { cb, store } = build();
    cb.banks.goto(1);
    cb.selectedSlot = 3;
    cb.pressAck();
    assert.equal(store.removeUnit('data/etl-backfill'), true);
  });

  it('Detail에서 ACK는 선택한 child에만 적용된다', () => {
    const { cb, store } = build();
    store.setChildStatus('search/index-rebuild', 'search/index-rebuild/codex', Status.DONE_UNSEEN);
    cb.enterDetail('search/index-rebuild');
    cb.selectedSlot = 0; // codex
    assert.deepEqual(cb.pressAck(), ['search/index-rebuild/codex']);
    assert.equal(store.getUnit('search/index-rebuild').child('search/index-rebuild/reindex').status, Status.ERROR);
  });
});

// ───────────────────────────── 5. Global / Detail
describe('5. Global / Detail', () => {
  it('MODE로 Global -> Detail 전환', () => {
    const { cb } = build();
    assert.equal(cb.view, View.GLOBAL);
    cb.selectedSlot = 0;
    assert.equal(cb.pressModeBack(), true);
    assert.equal(cb.view, View.DETAIL);
    assert.equal(cb.detail.unitId, 'payments/fix-timeout');
  });

  it('Detail의 키 1~10은 선택 worktree의 child다', () => {
    const { cb } = build();
    cb.enterDetail('payments/fix-timeout');
    const slots = cb.render().slots;
    assert.equal(slots.length, 10);
    assert.deepEqual(slots.map((s) => s.title),
      ['codex', 'test', 'shell', 'build', 'lint', 'typecheck', 'watch', 'repl', 'bench', 'logs']);
  });

  it('child가 10개 초과면 detail bank가 생긴다', () => {
    const { cb } = build();
    cb.enterDetail('payments/fix-timeout'); // child 11개
    assert.equal(cb.detail.banks.count, 2);
    cb.joystickRight();
    assert.deepEqual(cb.render().slots.map((s) => s.title),
      ['notes', null, null, null, null, null, null, null, null, null]);
  });

  it('SLOT long press로 Detail 진입', () => {
    const { cb } = build();
    assert.equal(cb.longPressSlot(2), true);
    assert.equal(cb.detail.unitId, 'api/cache-refactor');
  });

  it('MODE/BACK으로 Global 복귀 시 원래 slot 위치가 유지된다', () => {
    const { cb } = build();
    cb.banks.goto(2);
    const before = ids(cb);
    cb.selectedSlot = 3; // qa/e2e-flake
    cb.pressModeBack();  // detail
    cb.pressModeBack();  // back
    assert.equal(cb.view, View.GLOBAL);
    assert.equal(cb.banks.current, 2);
    assert.equal(cb.selectedSlot, 3);
    assert.deepEqual(ids(cb), before);
  });

  it('MODE long press는 Output dashboard', () => {
    const { cb } = build();
    assert.deepEqual(cb.longPressModeBack(), { dashboard: 'output' });
  });

  it('Detail에서도 underglow는 전체 Global attention을 유지한다', () => {
    const { cb } = build();
    const globalAmbient = cb.render().lighting.ambientZone;
    cb.enterDetail('payments/fix-timeout'); // 조용한 worktree
    assert.deepEqual(cb.render().lighting.ambientZone, globalAmbient);
    assert.equal(globalAmbient.color, 'red');
  });
});

// ───────────────────────────── 6. Orca child aggregation
describe('6. Orca child aggregation', () => {
  it('Global SLOT은 terminal이 아니라 worktree/task다', () => {
    const { cb } = build();
    for (const s of cb.render().slots) {
      assert.equal(cb.store.getUnit(s.id).kind, 'worktree');
    }
  });

  it('worktree 상태 = child 중 최우선 상태', () => {
    const { store } = build();
    assert.equal(store.getUnit('search/index-rebuild').status, Status.ERROR);
    assert.equal(store.getUnit('billing/invoice-pdf').status, Status.WAITING_APPROVAL);
    assert.equal(store.getUnit('api/cache-refactor').status, Status.RUNNING);
  });

  it('SLOT press focus는 ERROR child를 최우선 선택한다', async () => {
    const { cb, router } = build();
    cb.banks.goto(1);
    await cb.pressSlot(1); // search/index-rebuild: RUNNING + ERROR + WAITING_INPUT
    assert.equal(router.last().childId, 'search/index-rebuild/reindex');
    assert.equal(router.last().reason, `status:${Status.ERROR}`);
  });

  it('focus 우선순위: APPROVAL > INPUT > STALE > DONE_UNSEEN > last active', () => {
    const mk = (statuses) => new WorkUnit({
      id: 'x', children: statuses.map(([id, status, lastActiveAt = 0]) =>
        new ChildUnit({ id, status, lastActiveAt })),
    });
    assert.equal(mk([['a', Status.RUNNING, 1], ['b', Status.WAITING_APPROVAL], ['c', Status.WAITING_INPUT]])
      .resolveFocusTarget().id, 'b');
    assert.equal(mk([['a', Status.RUNNING, 1], ['b', Status.WAITING_INPUT], ['c', Status.STALE]])
      .resolveFocusTarget().id, 'b');
    assert.equal(mk([['a', Status.RUNNING, 1], ['b', Status.STALE], ['c', Status.DONE_UNSEEN]])
      .resolveFocusTarget().id, 'b');
    assert.equal(mk([['a', Status.RUNNING, 1], ['c', Status.DONE_UNSEEN]])
      .resolveFocusTarget().id, 'c');
    assert.equal(mk([['a', Status.RUNNING, 1], ['b', Status.RUNNING, 9]])
      .resolveFocusTarget().id, 'b');
  });

  it('last active가 없으면 primary agent child로 fallback', () => {
    const { cb, router } = build();
    return cb.pressSlot(4).then(() => { // web/login-a11y
      assert.equal(router.last().childId, 'web/login-a11y/codex');
    });
  });

  it('child가 없으면 worktree surface로 focus', async () => {
    const { cb, store, router } = build();
    store.addUnit(new WorkUnit({ id: 'bare/task', title: 'bare/task', status: Status.RUNNING }));
    cb.banks.goto(3);
    await cb.pressSlot(1);
    assert.equal(router.last().kind, 'worktree_surface');
    assert.equal(router.last().childId, null);
  });

  it('Detail child 수가 바뀌어도 worktree slot 위치는 유지된다', () => {
    const { cb, store } = build();
    const before = store.globalSlots.positionOf('api/cache-refactor');
    store.addChild('api/cache-refactor', { id: 'api/cache-refactor/logs', title: 'logs', status: Status.RUNNING });
    assert.deepEqual(store.globalSlots.positionOf('api/cache-refactor'), before);
    cb.enterDetail('api/cache-refactor');
    assert.deepEqual(cb.render().slots.slice(0, 3).map((s) => s.title), ['claude', 'dev server', 'logs']);
  });
});

// ───────────────────────────── 7. hidden-bank underglow
describe('7. hidden-bank underglow', () => {
  it('현재 bank가 모두 조용해도 hidden bank ERROR면 underglow red', () => {
    const { cb } = build();
    assert.equal(cb.banks.current, 0);
    const shown = cb.render().slots.map((s) => s.status);
    assert.equal(shown.every((s) => s === Status.RUNNING || s === Status.DONE_SEEN), true);
    assert.equal(cb.render().lighting.ambientZone.color, 'red');
  });

  it('숨은 묶음의 WAITING_INPUT도 개입이라 ambient는 살구 빠른 숨쉬기 (2026-09-30 규칙, 색은 2026-10-10: 개입 종류 색)', () => {
    const { cb, store } = build();
    store.setChildStatus('search/index-rebuild', 'search/index-rebuild/reindex', Status.RUNNING);
    store.setChildStatus('qa/e2e-flake', 'qa/e2e-flake/runner', Status.RUNNING);
    store.setChildStatus('billing/invoice-pdf', 'billing/invoice-pdf/codex', Status.RUNNING);
    const amb = cb.render().lighting.ambientZone;
    assert.equal(amb.color, 'apricot');
    assert.equal(amb.pattern, 'breathing_fast');
  });

  it('attention이 DONE_UNSEEN 뿐이면 ambient는 청록 (2026-10-02)', () => {
    const { cb, store } = build();
    for (const u of store.allUnits()) {
      for (const c of u.children) {
        if (c.status !== Status.DONE_UNSEEN) c.status = Status.DONE_SEEN;
      }
    }
    const amb = cb.render().lighting.ambientZone;
    assert.equal(amb.color, 'teal');
    assert.equal(amb.pattern, 'solid', '완료·미확인은 고정 — 진행 중(회전)과 움직임으로 구분 (밝기는 모두 100%, 2026-10-11)');
  });

  it('모두 끝나 확인했으면 ambient off, 진행 중이 있으면 호박 (2026-09-30)', () => {
    const { cb, store } = build();
    for (const u of store.allUnits()) for (const c of u.children) c.status = Status.DONE_SEEN;
    assert.deepEqual(cb.render().lighting.ambientZone, AMBIENT_NORMAL);
    for (const u of store.allUnits()) for (const c of u.children) c.status = Status.RUNNING;
    assert.equal(cb.render().lighting.ambientZone.color, 'amber');
  });

  it('per-key LED는 LIGHTING_POLICY 값과 정확히 일치한다', () => {
    const { cb } = build();
    cb.banks.goto(1);
    const l = cb.render().lighting;
    assert.deepEqual(l.threads[0], THREAD_STYLE[Status.ERROR]);
    assert.deepEqual(l.threads[1], THREAD_STYLE[Status.WAITING_APPROVAL]);
    assert.deepEqual(l.threads[2], THREAD_STYLE[Status.WAITING_INPUT]);
    assert.deepEqual(l.threads[3], THREAD_STYLE[Status.DONE_UNSEEN]);
    assert.deepEqual(l.threads[4], THREAD_STYLE[Status.STALE]);
    assert.deepEqual(l.threads[5], THREAD_STYLE[Status.RUNNING]);
  });

  it('RUNNING은 조용하고 WAITING/ERROR만 주의를 끈다 — 밝기는 모두 100%(2026-10-11), 움직임으로 구분', () => {
    // 2026-10-10: 진행 중은 보통 숨쉬기(움직이되 개입의 빠른 숨쉬기·오류 깜박임보다 조용)
    assert.equal(THREAD_STYLE[Status.RUNNING].pattern, 'breathing');
    assert.notEqual(THREAD_STYLE[Status.WAITING_INPUT].pattern, 'breathing');
  });

  it('빈 slot은 off', () => {
    const { cb, store } = build();
    store.addUnit(new WorkUnit({ id: 'solo', title: 'solo', status: Status.RUNNING }));
    cb.banks.goto(3);
    assert.deepEqual(cb.render().lighting.threads[1], THREAD_STYLE[Status.EMPTY]);
  });

  it('mini LED는 runtime이 건드리지 않는다', () => {
    const { cb } = build();
    const r = cb.render();
    assert.equal(r.miniLeds.purpose, 'hardware_layer_indicator_only');
    assert.equal(r.miniLeds.touchedByRuntime, false);
    assert.equal('miniLeds' in r.lighting, false);
  });
});

// ───────────────────────────── 8. context profile
describe('8. context profile', () => {
  it('한국어 상태 문구가 뷰 모델에 노출된다', () => {
    const { cb } = build();
    cb.banks.goto(1);
    assert.deepEqual(cb.render().slots.map((s) => s.labelKo),
      ['오류', '승인 필요', '답변 필요', '완료 · 미확인', '상태 모름', '진행 중',
        '완료 · 확인함', '완료 · 확인함', '완료 · 확인함', '완료 · 확인함']);
    assert.equal(StatusLabelKo[Status.DISCONNECTED], '연결 끊김');
  });
});
