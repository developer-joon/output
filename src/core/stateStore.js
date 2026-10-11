import { EventBus, Events } from './eventBus.js';
import { SlotManager } from './slotManager.js';
import { WorkUnit, ChildUnit } from './units.js';
import { Status, NotificationKind, isAttention, isTerminal } from './types.js';

let notifSeq = 0;

/**
 * 업무 상태의 유일한 소유자.
 *
 * - 모든 변경은 revision을 올리고 COMMITTED를 한 번 emit한다.
 * - 완료/오류는 notification으로 기록한다. ACK는 이 notification을 대상으로 한다.
 * - 오래된 run / 역순 이벤트는 적용하지 않는다.
 * - 호스트 파일 저장은 하지 않는다. 영속화는 외부 PersistenceAdapter의 몫이다.
 */
export class StateStore {
  constructor({ bus = new EventBus(), now = () => Date.now() } = {}) {
    this.bus = bus;
    this.now = now;
    this.units = new Map();
    this.globalSlots = new SlotManager();
    this._detailSlots = new Map();
    this._notifications = new Map();   // id -> notification
    this.revision = 0;
  }

  // ───────────── commit

  _commit(reason) {
    this.revision += 1;
    this.bus.emit(Events.COMMITTED, { revision: this.revision, reason });
    return this.revision;
  }

  // ───────────── units

  /**
   * @param {object} [opts]
   * @param {number} [opts.atGlobalIndex] 복원 전용. 저장된 자리에 그대로 넣는다.
   */
  addUnit(unitLike, { atGlobalIndex } = {}) {
    const unit = unitLike instanceof WorkUnit ? unitLike : new WorkUnit(unitLike);
    if (this.units.has(unit.id)) throw new Error(`duplicate unit: ${unit.id}`);
    if (atGlobalIndex === undefined) this.globalSlots.assign(unit.id);
    else this.globalSlots.assignAt(unit.id, atGlobalIndex);
    this.units.set(unit.id, unit);
    for (const c of unit.children) {
      this.detailSlots(unit.id).assign(c.id);
      this._ensureNotification(unit, c);
    }
    if (!unit.children.length) this._ensureNotification(unit, null);
    this.bus.emit(Events.UNIT_ADDED, unit);
    this._commit('unit:added');
    return unit;
  }

  /** 영속화에서 되살렸음을 표시한다. 상태는 UNKNOWN 그대로다. */
  markRestored(id, at) {
    const unit = this.units.get(id);
    if (!unit) throw new Error(`unknown unit: ${id}`);
    unit.restoredAt = at;
  }

  /** adapter가 이 unit을 실제로 관측했다. 복원-미관측 반납 규칙이 꺼진다. */
  noteObserved(id, at) {
    const unit = this.units.get(id);
    if (!unit) return;
    unit.observedAt = at;
  }

  getUnit(id) {
    return this.units.get(id) ?? null;
  }

  allUnits() {
    return [...this.units.values()];
  }

  detailSlots(unitId) {
    if (!this._detailSlots.has(unitId)) this._detailSlots.set(unitId, new SlotManager());
    return this._detailSlots.get(unitId);
  }

  addChild(unitId, childLike) {
    const unit = this.units.get(unitId);
    if (!unit) throw new Error(`unknown unit: ${unitId}`);
    const existing = unit.children.find((c) => c.id === childLike.id);
    if (existing) return existing;
    const created = childLike instanceof ChildUnit ? childLike : new ChildUnit(childLike);
    unit.children.push(created);
    this.detailSlots(unitId).assign(created.id);
    this._ensureNotification(unit, created);
    this.bus.emit(Events.UNIT_UPDATED, unit);
    this._commit('child:added');
    return created;
  }

  /**
   * child를 지운다. 소스가 '이제 없다'고 확정한 것(사용자가 닫은 탭)에만 쓴다.
   * 그 child의 알림은 대체(superseded) 처리해 ACK 대상으로 남기지 않고, 상세 자리도 비운다.
   * @returns {boolean} 지웠으면 true
   */
  removeChild(unitId, childId) {
    const unit = this.units.get(unitId);
    const i = unit ? unit.children.findIndex((c) => c.id === childId) : -1;
    if (i < 0) return false;
    unit.children.splice(i, 1);
    this.detailSlots(unitId).forceRelease(childId);
    for (const n of this._notifications.values()) {
      if (n.unitId === unitId && n.childId === childId) n.superseded = true;
    }
    this.bus.emit(Events.UNIT_UPDATED, unit);
    this._commit('child:removed');
    return true;
  }

  setUnitStatus(unitId, status) {
    const unit = this.units.get(unitId);
    if (!unit) throw new Error(`unknown unit: ${unitId}`);
    unit.ownStatus = status;
    this._ensureNotification(unit, null);
    this.bus.emit(Events.UNIT_UPDATED, unit);
    this._commit('unit:status');
  }

  /**
   * @param {object} [opts]
   * @param {number} [opts.waitingSince] adapter가 관측한 개입 상태 진입 시각.
   *   같은 개입 상태에 다시 들어간 경우(예: 승인 연속 요청)는 상태 값만으로는
   *   구분되지 않으므로, 관측한 시각을 그대로 쓴다. 우리 시계보다 정확하다.
   */
  setChildStatus(unitId, childId, status, { waitingSince } = {}) {
    const unit = this.units.get(unitId);
    const child = unit?.child(childId);
    if (!child) throw new Error(`unknown child: ${unitId}/${childId}`);
    this._transition(unit, child, status);
    if (waitingSince !== undefined && isAttention(status)) child.waitingSince = waitingSince;
    this.bus.emit(Events.UNIT_UPDATED, unit);
    this._commit('child:status');
  }

  // ───────────── 외부 adapter 이벤트

  /**
   * adapter가 보낸 child 상태 이벤트를 적용한다.
   * 오래된 run이나 역순 seq는 적용하지 않는다 (C15).
   * @returns {boolean} 적용 여부
   */
  applyChildEvent({ unitId, childId, runId = null, generation = null, seq = null, status,
                    outcome = null, heartbeatAt = null }) {
    const unit = this.units.get(unitId);
    const child = unit?.child(childId);
    if (!child) return false;

    if (runId !== null) {
      if (child.runId === null) {
        child.runId = runId;
        this._generationOf(runId, generation);
        child.lastSeq = -1;
      } else if (child.runId !== runId) {
        // 새 run이면 세대를 교체하고, 옛 run이면 버린다.
        if (!this._isNewerRun(child.runId, runId, generation)) return false;
        child.runId = runId;
        child.lastSeq = -1;
      }
    }
    if (seq !== null) {
      if (seq <= child.lastSeq) return false;   // 중복/역순
      child.lastSeq = seq;
    }
    if (heartbeatAt !== null) child.lastHeartbeatAt = heartbeatAt;
    if (outcome !== null) child.outcome = outcome;

    this._transition(unit, child, status);
    this.bus.emit(Events.UNIT_UPDATED, unit);
    this._commit('child:event');
    return true;
  }

  /**
   * run 세대 비교. adapter가 generation을 주면 그것을 쓰고,
   * 없으면 runId 끝의 정수를 세대로 본다. 둘 다 없으면 최초 관측 순서로 본다.
   * 추측으로 '새 run'이라고 단정하지 않는다.
   */
  _isNewerRun(currentRunId, incomingRunId, incomingGeneration = null) {
    const cur = this._generationOf(currentRunId, null);
    const inc = this._generationOf(incomingRunId, incomingGeneration);
    if (cur !== null && inc !== null) return inc > cur;
    if (!this._runOrder) this._runOrder = new Map();
    if (!this._runOrder.has(currentRunId)) this._runOrder.set(currentRunId, this._runOrder.size);
    if (!this._runOrder.has(incomingRunId)) this._runOrder.set(incomingRunId, this._runOrder.size);
    return this._runOrder.get(incomingRunId) > this._runOrder.get(currentRunId);
  }

  _generationOf(runId, explicit) {
    if (explicit !== null && explicit !== undefined) {
      if (!this._generations) this._generations = new Map();
      this._generations.set(runId, explicit);
      return explicit;
    }
    if (this._generations?.has(runId)) return this._generations.get(runId);
    const m = /(\d+)\s*$/.exec(String(runId));
    return m ? Number(m[1]) : null;
  }

  _transition(unit, child, status) {
    const prev = child.status;
    child.status = status;
    if (isAttention(status) && !isAttention(prev)) child.waitingSince = this.now();
    if (!isAttention(status)) child.waitingSince = 0;
    // 소스가 '사용자가 봤다'고 알려 오면(미확인 → 확인함) 그 완료 알림도 확인한 것이다 (2026-09-30)
    if (prev === Status.DONE_UNSEEN && status === Status.DONE_SEEN) {
      for (const n of this._notifications.values()) {
        if (n.unitId === unit.id && n.childId === child.id && n.kind === NotificationKind.COMPLETION
          && !n.acknowledged && !n.superseded) {
          n.acknowledged = true;
          n.acknowledgedAt = this.now();
        }
      }
    }
    this._ensureNotification(unit, child, prev);
  }

  // ───────────── notifications

  /** 완료/오류 상태에 진입하면 확인 대상 알림을 하나 만든다. */
  _ensureNotification(unit, child, prev = null) {
    const status = child ? child.status : unit.ownStatus;
    const kind = status === Status.DONE_UNSEEN ? NotificationKind.COMPLETION
      : status === Status.ERROR ? NotificationKind.ERROR : null;
    if (!kind) return null;

    const runId = child ? child.runId : null;
    const dup = [...this._notifications.values()].find((n) => n.unitId === unit.id
      && n.childId === (child?.id ?? null) && n.kind === kind && n.runId === runId
      && !n.superseded);
    // 확인한 완료 뒤에 다른 상태를 거쳐 다시 완료되면 새 완료다 — 새 알림을 만든다 (2026-09-30).
    // run id가 없는 소스(Orca)에서도 두 번째 완료를 알리고 ACK할 수 있어야 한다.
    const reentered = dup?.acknowledged && kind === NotificationKind.COMPLETION
      && prev !== null && prev !== Status.DONE_UNSEEN && prev !== Status.DONE_SEEN;
    if (dup && reentered) dup.superseded = true;
    else if (dup) return dup;

    // 같은 대상의 옛 run 알림은 superseded 처리해 중복 알림을 만들지 않는다 (C15).
    for (const n of this._notifications.values()) {
      if (n.unitId === unit.id && n.childId === (child?.id ?? null) && n.runId !== runId) {
        n.superseded = true;
      }
    }

    const notif = {
      id: `n${++notifSeq}`,
      unitId: unit.id,
      childId: child?.id ?? null,
      runId,
      kind,
      outcome: child?.outcome ?? null,
      createdAt: this.now(),
      acknowledged: false,
      superseded: false,
    };
    this._notifications.set(notif.id, notif);
    this.bus.emit(Events.NOTIFICATION_ADDED, notif);
    return notif;
  }

  notification(id) {
    return this._notifications.get(id) ?? null;
  }

  notificationsFor(unitId, childId = null) {
    return [...this._notifications.values()].filter(
      (n) => n.unitId === unitId && n.childId === childId && !n.superseded,
    );
  }

  unacknowledgedNotifications() {
    return [...this._notifications.values()].filter((n) => !n.acknowledged && !n.superseded);
  }

  acknowledgedNotifications() {
    return [...this._notifications.values()].filter((n) => n.acknowledged && !n.superseded);
  }

  /**
   * 화면에 표시됐던 특정 알림 하나만 확인한다 (C10 C12).
   * 승인/제출은 하지 않는다. 오류는 남기고 주의 수준만 낮춘다 (C11).
   * @returns {{ok:boolean, acked:string[], reasonKo:string}}
   */
  acknowledgeNotification(notificationId) {
    const n = this._notifications.get(notificationId);
    if (!n) {
      return { ok: false, acked: [], reasonKo: '확인할 알림이 없습니다.' };
    }
    if (n.superseded) {
      return { ok: false, acked: [], reasonKo: '표시된 알림이 새 실행으로 대체되었습니다. 다시 확인해 주세요.' };
    }
    if (n.acknowledged) {
      return { ok: false, acked: [], reasonKo: '이미 확인한 알림입니다.' };
    }

    n.acknowledged = true;
    n.acknowledgedAt = this.now();
    const acked = [];
    const unit = this.units.get(n.unitId);
    const target = n.childId ? unit?.child(n.childId) : unit;

    // 완료 알림만 표시 상태를 바꾼다. 오류는 사실로 남긴다.
    if (target && n.kind === NotificationKind.COMPLETION && target.status === Status.DONE_UNSEEN) {
      if (n.childId) target.status = Status.DONE_SEEN;
      else target.ownStatus = Status.DONE_SEEN;
      acked.push(n.childId ?? n.unitId);
    } else if (target && n.kind === NotificationKind.ERROR) {
      acked.push(n.childId ?? n.unitId);
    }

    this.bus.emit(Events.ACK, { notificationId, unitId: n.unitId, childId: n.childId, acked });
    this._commit('ack');
    return { ok: true, acked, reasonKo: '' };
  }

  // ───────────── 슬롯 해제

  /**
   * 자동 해제 허용 조건 (CODEX_NEXT_TASK_KO.md 2.4):
   *   종료된 실행 + 필요한 알림 확인 + 비고정 + 유예시간 경과.
   * RUNNING/WAITING/미해결 오류/관측 단절은 해제하지 않는다 (C13).
   * @returns {boolean}
   */
  canRelease(id, { now = this.now(), graceMs = 0 } = {}) {
    const unit = this.units.get(id);
    if (!unit) return false;
    if (unit.pinned) return false;
    if (this.unacknowledgedNotifications().some((n) => n.unitId === id)) return false;
    // 복원됐는데 한 번도 관측되지 않은 것: 자리는 지켰지만 영원히 지킬 수는 없다 (spec §9).
    // 종료된 실행이 아니므로 아래 일반 규칙으로는 절대 반납되지 않는다. 여기서만 허용한다.
    if (unit.restoredAt && !unit.observedAt) {
      const s = unit.status;
      if (s !== Status.UNKNOWN && s !== Status.DISCONNECTED) return false;
      return now - unit.restoredAt >= graceMs;
    }
    const status = unit.status;
    if (!isTerminal(status) && status !== Status.EMPTY) return false;
    if (status === Status.DONE_UNSEEN) return false;
    if (graceMs > 0) {
      const acks = [...this._notifications.values()]
        .filter((n) => n.unitId === id && n.acknowledgedAt);
      const last = acks.length ? Math.max(...acks.map((n) => n.acknowledgedAt)) : unit.createdAt;
      if (now - last < graceMs) return false;
    }
    return true;
  }

  /** 정책을 통과한 경우에만 슬롯을 반납한다. */
  releaseUnit(id, opts = {}) {
    if (!this.canRelease(id, opts)) return false;
    this._dropUnit(id, 'unit:removed');
    return true;
  }

  /**
   * 사용자가 소스 쪽 필터로 숨긴 작업의 자리를 비운다. 반납 정책을 거치지 않는다 —
   * 끝난 것이 아니라 사용자가 보지 않기로 한 것이므로 실행 중이어도 비운다.
   * @returns {boolean} 비웠으면 true
   */
  hideUnit(id) {
    if (!this.units.has(id)) return false;
    this._dropUnit(id, 'unit:hidden');
    return true;
  }

  /** 반납·숨김 공통: 자리와 작업을 지우고 알린 뒤 빈 자리를 당긴다. */
  _dropUnit(id, reason) {
    const unit = this.units.get(id);
    this.globalSlots.forceRelease(id);
    this.units.delete(id);
    this._detailSlots.delete(id);
    this.bus.emit(Events.UNIT_REMOVED, unit);
    this._commit(reason);
    this.compactSlots();
  }

  /**
   * 빈 자리를 앞으로 당긴다. 상대 순서는 지킨다. 상세 자리(child)는 건드리지 않는다.
   * 자리가 빌 때(반납·숨김·복원)마다 자동으로 불린다 (사용자 결정 2026-09-29).
   * 재조회 순서가 바뀌는 것만으로는 움직이지 않는다 (C02) — 자리는 무언가 빠질 때만 당겨진다.
   * @returns {number} 옮긴 작업 수
   */
  compactSlots() {
    const ids = [...this.globalSlots.ids()]
      .sort((a, b) => this.globalSlots.globalIndexOf(a) - this.globalSlots.globalIndexOf(b));
    let moved = 0;
    ids.forEach((id, i) => {
      if (this.globalSlots.globalIndexOf(id) === i) return;
      this.globalSlots.forceRelease(id);
      this.globalSlots.assignAt(id, i);
      moved += 1;
    });
    if (moved) this._commit('slots:compacted');
    return moved;
  }

  /**
   * 주어진 순서로 자리를 다시 배치한다. 목록에 없는 작업은 그 뒤에 기존 순서대로 둔다.
   * @returns {number} 옮긴 작업 수
   */
  arrangeSlots(orderedIds) {
    const known = orderedIds.filter((id) => this.globalSlots.globalIndexOf(id) >= 0);
    const rest = this.globalSlots.ids()
      .filter((id) => !known.includes(id))
      .sort((a, b) => this.globalSlots.globalIndexOf(a) - this.globalSlots.globalIndexOf(b));
    const want = [...known, ...rest];
    if (want.every((id, i) => this.globalSlots.globalIndexOf(id) === i)) return 0;
    for (const id of want) this.globalSlots.forceRelease(id);
    want.forEach((id, i) => { this.globalSlots.assignAt(id, i); });
    this._commit('slots:arranged');
    return want.length;
  }

  /** 하위호환: 기존 removeUnit 호출부는 releaseUnit 정책을 따른다. */
  removeUnit(id, opts = {}) {
    return this.releaseUnit(id, opts);
  }
}
