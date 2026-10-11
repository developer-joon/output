import { EventBus, Events } from './core/eventBus.js';
import { StateStore } from './core/stateStore.js';
import { BankManager } from './core/bankManager.js';
import { AttentionQueue } from './core/attentionQueue.js';
import { DetailView } from './core/detailView.js';
import { MockFocusRouter } from './core/focusRouter.js';
import { renderLighting } from './core/lightingPolicy.js';
import { Status, StatusLabelKo, View, NotificationKind, isAttention } from './core/types.js';
import { SLOTS_PER_BANK, MINI_LED_PURPOSE } from './core/hardware.js';
import { deepFreeze } from './core/freeze.js';

/**
 * 이 슬롯이 개입 상태로 들어간 시각. 개입이 아니면 0이다.
 *
 * WorkUnit이면 children 중 가장 최근 것을 쓴다 — 승인이 연달아 오면
 * 상태 값은 그대로이고 이 시각만 앞당겨지므로, 새 사건은 여기서만 드러난다.
 */
function attentionSinceOf(entity) {
  if (!entity) return 0;
  if (!isAttention(entity.status)) return 0;
  const children = entity.children ?? null;
  if (!children) return entity.waitingSince ?? 0;
  const fromChildren = children.reduce(
    (max, c) => (isAttention(c.status) ? Math.max(max, c.waitingSince ?? 0) : max),
    0,
  );
  // 묶음 자신이 개입을 요구하는 경우(거절로 멈춤)는 child가 말해주지 않는다.
  return Math.max(fromChildren, entity.ownWaitingSince ?? 0);
}

/**
 * 입력 → 상태 → 뷰모델의 중심.
 * 장치 I/O는 하지 않는다. DeviceScene 변환과 출력은 src/device가 담당한다.
 */
export class Output {
  constructor({
    store, focusRouter = new MockFocusRouter(),
    sourceName = 'Orca',
  } = {}) {
    this.bus = store?.bus ?? new EventBus();
    this.store = store ?? new StateStore({ bus: this.bus });
    this.banks = new BankManager(this.store.globalSlots);
    this.attention = new AttentionQueue(this.store);
    this.sourceName = sourceName;
    this.focusRouter = focusRouter;       // 작업으로 이동만
    /** 앞 앱이 소스일 때만 true. 대기 중에는 입력을 처리하지 않고 장치는 레이어색으로 복원한다 (스펙 §1·§4.2) */
    this.active = true;

    this.view = View.GLOBAL;
    this.detail = null;
    this.selectedSlot = 0;
    this.miniLeds = { purpose: MINI_LED_PURPOSE, layer: 1, touchedByRuntime: false };
    /** 앱 모드 정보 (서비스가 정한다, 2026-10-03). Orca 모드·대기에서는 null */
    this.appMode = null;
    /** Orca 모드에서 레이어 칸인 키 11·12·13의 LED (2026-10-05). 없으면 장면이 Output 내장 모습으로 그린다 (진단 도구·데모) */
    this.layerKeys = null;

    this._lastSnapshot = null;
    this.lastAckResult = null;
  }

  // ───────────── 뷰 구성

  visibleUnits() {
    const out = [];
    for (let s = 0; s < SLOTS_PER_BANK; s += 1) {
      const id = this.store.globalSlots.idAt(this.banks.current, s);
      out.push(id ? this.store.getUnit(id) : null);
    }
    return out;
  }

  visibleEntities() {
    return this.view === View.GLOBAL ? this.visibleUnits() : this.detail.visibleChildren();
  }

  slotStatuses() {
    return this.visibleEntities().map((e) => (e ? e.status : Status.EMPTY));
  }

  /**
   * 화면에 보이지 않는 개입의 수.
   * Global에서는 다른 bank, Detail에서는 다른 worktree의 개입이 여기에 든다.
   */
  _hiddenAttentionCount() {
    const visibleUnitIds = new Set(this.visibleUnits().filter(Boolean).map((u) => u.id));
    const visibleChildIds = this.view === View.DETAIL
      ? new Set(this.detail.visibleChildren().filter(Boolean).map((c) => c.id))
      : null;
    return this.attention.items().filter((item) => {
      if (visibleChildIds) {
        return !(item.unitId === this.detail.unitId && visibleChildIds.has(item.childId));
      }
      return !visibleUnitIds.has(item.unitId);
    }).length;
  }

  /** 이 슬롯에서 ACK 대상이 될 알림 하나. 일괄 확인하지 않는다 (C12). */
  _notificationForSlot(entity) {
    if (!entity) return null;
    const unitId = this.view === View.GLOBAL ? entity.id : this.detail.unitId;
    const candidates = this.store.unacknowledgedNotifications().filter((n) => {
      if (n.unitId !== unitId) return false;
      if (this.view === View.DETAIL) return n.childId === entity.id;
      return true;
    });
    if (!candidates.length) return null;
    // 완료 알림 우선, 그다음 오래된 순.
    candidates.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === NotificationKind.COMPLETION ? -1 : 1;
      return a.createdAt - b.createdAt;
    });
    return candidates[0];
  }

  /** @returns {object} 깊이 동결된 snapshot */
  render() {
    const entities = this.visibleEntities();
    const ambientSummary = this.attention.summaryStatus();
    const lighting = renderLighting({ slotStatuses: this.slotStatuses(), ambientSummary });

    const snapshot = {
      revision: this.store.revision,
      active: this.active,
      appMode: this.appMode,
      layerKeys: this.layerKeys,
      sourceName: this.sourceName,
      view: this.view,
      bank: this.view === View.GLOBAL ? this.banks.current : this.detail.banks.current,
      bankCount: this.view === View.GLOBAL ? this.banks.count : this.detail.banks.count,
      detailUnitId: this.detail?.unitId ?? null,
      selectedSlot: this.selectedSlot,
      slots: entities.map((e, i) => {
        const n = this._notificationForSlot(e);
        const unitId = e ? (this.view === View.GLOBAL ? e.id : this.detail.unitId) : null;
        return {
          slot: i + 1,
          id: e?.id ?? null,
          title: e?.title ?? null,
          status: e ? e.status : Status.EMPTY,
          labelKo: StatusLabelKo[e ? e.status : Status.EMPTY],
          notification: n ? { id: n.id, kind: n.kind, childId: n.childId } : null,
          // 개입 진입 시각. 같은 상태로 머무는 새 이벤트를 알리는 근거다.
          attentionSince: attentionSinceOf(e),
          pendingNotificationCount: e
            ? this.store.unacknowledgedNotifications().filter((x) => x.unitId === unitId
                && (this.view === View.GLOBAL || x.childId === e.id)).length
            : 0,
        };
      }),
      attentionCount: this.attention.items().length,
      ambientSummary,
      // 모든 묶음의 상태별 작업 수. 메뉴바 점처럼 보이는 묶음과 무관한 요약에 쓴다.
      statusCounts: this.store.allUnits().reduce((m, u) => { m[u.status] = (m[u.status] ?? 0) + 1; return m; }, {}),
      // 지금 보이지 않는 곳의 개입 수. underglow가 없는 장치에서 대체 표현의 근거가 된다.
      hiddenAttentionCount: this._hiddenAttentionCount(),
      lighting,
      miniLeds: { ...this.miniLeds },
    };

    this._lastSnapshot = snapshot;
    return deepFreeze(snapshot);
  }

  // ───────────── focus (작업 이동 전용)

  async _focus(target) {
    this.bus.emit(Events.FOCUS_REQUESTED, target);
    const result = await this.focusRouter.focus(target);
    if (result && result.ok === false) {
      this.lastFocusFailure = { target, reasonKo: result.reasonKo ?? '대상으로 이동하지 못했습니다.' };
    } else {
      this.lastFocusFailure = null;
    }
    return result;
  }

  async focusUnit(unit) {
    const child = unit.resolveFocusTarget();
    return this._focus({
      kind: child ? 'child' : 'worktree_surface',
      unitId: unit.id,
      childId: child?.id ?? null,
      reason: child ? `status:${child.status}` : 'surface',
    });
  }

  // ───────────── SLOT 1~10

  /**
   * 상태판(앱 자신의 창)에서 줄을 눌렀다. 장치 입력이 아니므로 활성/대기 게이트를 거치지 않는다 —
   * 다른 앱에서 상태판을 열어 줄을 누르면 그 작업으로 가는 것이 사용자의 기대다 (최종 리뷰 Important 1).
   */
  async focusSlotFromPanel(n) {
    const entity = this.visibleEntities()[n - 1];
    this.selectedSlot = n - 1;
    if (!entity) return null;
    if (this.view === View.GLOBAL) return this.focusUnit(entity);
    return this._focus({ kind: 'child', unitId: this.detail.unitId, childId: entity.id, reason: 'direct' });
  }

  async pressSlot(n) {
    if (!this.active) return null;
    // 화면을 여는 것은 확인(ACK)이 아니다.
    return this.focusSlotFromPanel(n);
  }

  longPressSlot(n) {
    if (!this.active) return null;
    if (this.view !== View.GLOBAL) return false;
    const unit = this.visibleUnits()[n - 1];
    if (!unit) return false;
    return this.enterDetail(unit.id);
  }

  // ───────────── 활성/대기

  /** 앞 앱이 소스인지 서비스가 알려 준다. 바뀔 때만 이벤트 (RenderScheduler가 다시 그린다) */
  setActive(active) {
    const next = Boolean(active);
    if (next === this.active) return false;
    this.active = next;
    this.bus.emit(Events.ACTIVE_CHANGED, { active: next });
    return true;
  }

  /** Orca 모드의 레이어 키 LED 정보. 바뀌면 다시 그린다 */
  setLayerKeys(k) {
    const next = k ?? null;
    if (JSON.stringify(next) === JSON.stringify(this.layerKeys)) return false;
    this.layerKeys = next;
    this.bus.emit(Events.ACTIVE_CHANGED, { active: this.active, layerKeys: next });
    return true;
  }

  /** 앱 모드 정보. 바뀌면 다시 그린다 */
  setAppMode(m) {
    const next = m ?? null;
    if (JSON.stringify(next) === JSON.stringify(this.appMode)) return false;
    this.appMode = next;
    this.bus.emit(Events.ACTIVE_CHANGED, { active: this.active, appMode: next });
    return true;
  }

  /** 앱 모드의 11번: 대기 게이트 없이 기다리는 세션으로 이동만 한다 (AGENTS.md 9) */
  async pressAttentionAnywhere() {
    const item = this.attention.next();
    if (!item) return null;
    return this._focus({
      kind: item.childId ? 'child' : 'unit', unitId: item.unitId, childId: item.childId, reason: `attention:${item.status}`,
    });
  }

  /** 앞에 온 소스 이름. 단축키를 보낼 앱을 정한다 */
  setSourceName(name) {
    this.sourceName = name;
  }

  // ───────────── ATTENTION / ACK / MODE-BACK

  async pressAttention() {
    if (!this.active) return null;
    return this.pressAttentionAnywhere();
  }

  longPressAttention() {
    if (!this.active) return null;
    return { dashboard: 'attention_queue', items: this.attention.items() };
  }

  /**
   * 화면에 표시됐던 알림 하나만 확인한다 (C10 C12).
   * 승인/제출/Enter를 보내지 않는다 (C11).
   * @returns {string[]} 확인 처리된 대상 id (기존 호출부 호환)
   */
  pressAck() {
    if (!this.active) {
      this.lastAckResult = { ok: false, acked: [], reasonKo: '대기 중에는 입력을 처리하지 않습니다.' };
      return [];
    }
    const snap = this._lastSnapshot ?? this.render();
    const shown = snap.slots[this.selectedSlot];
    if (!shown || !shown.notification) {
      this.lastAckResult = { ok: false, acked: [], reasonKo: '이 슬롯에는 확인할 알림이 없습니다.' };
      return [];
    }
    const result = this.store.acknowledgeNotification(shown.notification.id);
    this.lastAckResult = result;
    return result.acked;
  }

  pressModeBack() {
    if (!this.active) return null;
    if (this.view === View.DETAIL) return this.exitDetail();
    const unit = this.visibleUnits()[this.selectedSlot];
    if (!unit) return false;
    return this.enterDetail(unit.id);
  }

  longPressModeBack() {
    if (!this.active) return null;
    return { dashboard: 'output' };
  }

  enterDetail(unitId) {
    const unit = this.store.getUnit(unitId);
    if (!unit) return false;
    this.detail = new DetailView(this.store, unitId);
    this.view = View.DETAIL;
    this.selectedSlot = 0;
    this.bus.emit(Events.VIEW_CHANGED, { view: this.view, unitId });
    return true;
  }

  exitDetail() {
    if (this.view !== View.DETAIL) return false;
    const unitId = this.detail.unitId;
    this.detail = null;
    this.view = View.GLOBAL;
    const pos = this.store.globalSlots.positionOf(unitId);
    if (pos) {
      this.banks.goto(pos.bank);
      this.selectedSlot = pos.slot;
    }
    this.bus.emit(Events.VIEW_CHANGED, { view: this.view, unitId: null });
    return true;
  }

  // ───────────── DIAL

  // 노브 회전 = 다음/이전 세션으로 바로 이동 (사용자 결정 2026-10-01).
  // 키 순서(전체 슬롯 순서)대로 돌고 묶음을 넘어가며 끝에서 처음으로 돈다.
  // 빨리 돌리면 이동 명령을 쌓지 않는다: 진행 중인 이동이 끝나면 마지막 목표로만 간다.
  dialCW() { return this._dialStep(+1); }

  dialCCW() { return this._dialStep(-1); }

  _dialStep(delta) {
    if (!this.active) return null;
    if (this.view === View.DETAIL) return this._detailStep(delta);
    const slots = this.store.globalSlots;
    const order = slots.ids().map((id) => slots.globalIndexOf(id)).sort((a, b) => a - b);
    if (!order.length) return null;
    const cur = this._dialIndex ?? (this.banks.current * SLOTS_PER_BANK + this.selectedSlot);
    let i = order.indexOf(cur);
    if (i < 0) i = delta > 0 ? order.findIndex((g) => g > cur) - 1 : order.findIndex((g) => g >= cur);
    const next = order[((i + delta) % order.length + order.length) % order.length];
    this._dialIndex = next;
    const bank = Math.floor(next / SLOTS_PER_BANK);
    if (bank !== this.banks.current) {
      this.banks.goto(bank);
      this.bus.emit(Events.BANK_CHANGED, { view: this.view, bank });
    }
    this.selectedSlot = next % SLOTS_PER_BANK;
    this._dialTarget = slots.idAt(bank, this.selectedSlot);
    if (!this._dialRun) {
      this._dialRun = (async () => {
        let sent = null;
        while (this._dialTarget && this._dialTarget !== sent) {
          sent = this._dialTarget;
          const unit = this.store.getUnit(sent);
          if (unit) await this.focusUnit(unit);
        }
      })().finally(() => { this._dialRun = null; });
    }
    return next;
  }

  /**
   * 상세 보기의 노브 = 그 작업의 터미널 탭을 차례로 이동 (2026-10-04). 빈 칸은 건너뛰고 끝에서 처음으로 돈다.
   * 빨리 돌리면 전체 보기와 같이 이동 명령을 쌓지 않고 마지막 목표로만 간다.
   */
  _detailStep(delta) {
    const kids = this.detail.visibleChildren();
    const idxs = kids.map((c, i) => (c ? i : -1)).filter((i) => i >= 0);
    if (!idxs.length) return null;
    let i = idxs.indexOf(this.selectedSlot);
    if (i < 0) i = delta > 0 ? -1 : 0;
    const next = idxs[((i + delta) % idxs.length + idxs.length) % idxs.length];
    this.selectedSlot = next;
    const unitId = this.detail.unitId;
    this._detailTarget = kids[next].id;
    if (!this._dialRun) {
      this._dialRun = (async () => {
        let sent = null;
        while (this._detailTarget && this._detailTarget !== sent) {
          sent = this._detailTarget;
          await this._focus({ kind: 'child', unitId, childId: sent, reason: 'dial' });
        }
      })().finally(() => { this._dialRun = null; });
    }
    return next;
  }

  /** 테스트용: 노브로 시작한 이동이 모두 끝날 때까지 기다린다 */
  async dialIdle() {
    while (this._dialRun) await this._dialRun;
  }

  async dialPress({ hardwareValidated = false } = {}) {
    if (!this.active) return null;
    if (!hardwareValidated) return { ok: false, reason: 'dial_press_not_validated' };
    return this.pressSlot(this.selectedSlot + 1);
  }

  // ───────────── 내장 동작 (Orca 레이어 노브·조이스틱, 2026-10-03)

  /** Orca 레이어의 내장 동작. 단축키·앱 실행 등은 서비스의 실행기가 한다 */
  runBuiltin(name) {
    if (!this.active) return null;
    switch (name) {
      case 'attention': return this.pressAttention();
      case 'next_unseen': return this.joystickDown();
      case 'next_session': return this._dialStep(+1);
      case 'prev_session': return this._dialStep(-1);
      case 'next_bank': return this._changeBank(+1);
      case 'prev_bank': return this._changeBank(-1);
      case 'toggle_view': return this.pressModeBack();
      default: return null;
    }
  }

  // ───────────── JOYSTICK

  async joystickUp() {
    if (!this.active) return null;
    return this.pressAttention();
  }

  joystickLeft() {
    if (!this.active) return null;
    return this._changeBank(-1);
  }

  joystickRight() {
    if (!this.active) return null;
    return this._changeBank(+1);
  }

  async joystickDown() {
    if (!this.active) return null;
    const list = this.attention.unseenItems();
    if (!list.length) return null;
    const item = list[0];
    return this._focus({
      kind: item.childId ? 'child' : 'unit',
      unitId: item.unitId,
      childId: item.childId,
      reason: `unseen:${item.status}`,
    });
  }

  _changeBank(delta) {
    const target = this.view === View.GLOBAL ? this.banks : this.detail.banks;
    const before = target.current;
    const bank = delta > 0 ? target.next() : target.prev();
    if (bank !== before) this.bus.emit(Events.BANK_CHANGED, { view: this.view, bank });
    return bank;
  }
}
