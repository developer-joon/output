import { WorkUnit } from '../../core/units.js';
import { Status, Confidence } from '../../core/types.js';
import { Events } from '../../core/eventBus.js';
import { emptyState } from './schema.js';

/**
 * 호스트 영속화 (M5 설계 §9, C14).
 *
 * Core는 이 클래스를 모른다. 이 클래스가 Store를 구독하고, 시작 때 Store에 넣는다.
 *
 * 남기는 것은 사용자의 의도(자리·핀·확인)다. 관측한 사실은 남기지 않는다.
 * 되살린 unit은 전부 UNKNOWN이다. adapter가 조회하기 전까지는 아무것도 모른다고 말한다.
 * "재시작했더니 어제 색이 켜져 있다"는 것이 이 클래스가 막아야 할 단 하나의 사고다.
 */
export const DEFAULT_GRACE_MS = 10 * 60 * 1000;
export const DEFAULT_DEBOUNCE_MS = 1000;
export const MAX_ACKS = 200;

const ackKey = ({ unitId, childId, kind, runId }) => `${unitId}\u0000${childId ?? ''}\u0000${kind}\u0000${runId ?? ''}`;

export class PersistenceAdapter {
  constructor({
    store, fileStore, now = () => Date.now(),
    debounceMs = DEFAULT_DEBOUNCE_MS, graceMs = DEFAULT_GRACE_MS, maxAcks = MAX_ACKS,
    setTimer = (fn, ms) => { const h = setTimeout(fn, ms); h.unref?.(); return h; },
    clearTimer = (h) => clearTimeout(h),
  }) {
    this.store = store;
    this.fileStore = fileStore;
    this.now = now;
    this.debounceMs = debounceMs;
    this.graceMs = graceMs;
    this.maxAcks = maxAcks;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;

    this._timer = null;
    this._unsubscribes = [];
    /** 복원했지만 아직 관측되지 않은 id */
    this.restoredIds = new Set();
    /** 복원한 ACK 키 → 기록. 같은 알림이 다시 생기면 재적용한다 */
    this.pendingAcks = new Map();
    this.lastWriteError = null;
    this.writeCount = 0;
  }

  // ───────────── 스냅샷

  /** 지금 Store에서 저장할 모양을 만든다. 순수. */
  snapshot() {
    const state = emptyState();
    state.savedAt = this.now();
    const slotIds = new Set();
    for (const id of this.store.globalSlots.ids()) {
      const unit = this.store.getUnit(id);
      if (!unit) continue;
      slotIds.add(id);
      state.slots.push({
        id,
        globalIndex: this.store.globalSlots.globalIndexOf(id),
        title: unit.title,
        source: unit.source,
        kind: unit.kind,
        pinned: Boolean(unit.pinned),
      });
    }
    state.acks = this.store.acknowledgedNotifications()
      .filter((n) => slotIds.has(n.unitId))
      .map((n) => ({
        unitId: n.unitId,
        childId: n.childId,
        kind: n.kind,
        runId: n.runId,
        acknowledgedAt: n.acknowledgedAt ?? 0,
      }))
      .sort((a, b) => b.acknowledgedAt - a.acknowledgedAt)
      .slice(0, this.maxAcks);
    return state;
  }

  // ───────────── 구독

  start() {
    if (this._unsubscribes.length) return this;
    const bus = this.store.bus;
    this._unsubscribes.push(bus.on(Events.COMMITTED, () => this._schedule()));
    this._unsubscribes.push(bus.on(Events.UNIT_UPDATED, (unit) => this._onUnitUpdated(unit)));
    this._unsubscribes.push(bus.on(Events.NOTIFICATION_ADDED, (n) => this._onNotification(n)));
    return this;
  }

  stop() {
    for (const off of this._unsubscribes) off();
    this._unsubscribes = [];
    if (this._timer) {
      this.clearTimer(this._timer);
      this._timer = null;
    }
  }

  // ───────────── 저장

  _schedule() {
    if (this._timer) return;                       // 이미 잡혀 있으면 합친다
    this._timer = this.setTimer(() => {
      this._timer = null;
      this._write();
    }, this.debounceMs);
  }

  _write() {
    const r = this.fileStore.write(this.snapshot());
    if (r.ok) {
      this.writeCount += 1;
      this.lastWriteError = null;
    } else {
      // 같은 오류는 같은 문자열로 남긴다. 호출자가 바뀔 때만 출력할 수 있다.
      this.lastWriteError = r.messageKo ?? '알 수 없는 쓰기 오류';
    }
    return r;
  }

  /** 지금 바로 쓴다. 종료 직전에 부른다. */
  flush() {
    if (this._timer) {
      this.clearTimer(this._timer);
      this._timer = null;
    }
    return this._write();
  }

  // ───────────── 복원

  /**
   * 파일을 읽어 Store에 넣는다. **adapter의 첫 조회 전에** 불러야 자리가 지켜진다.
   * @returns {{restored:string[], skipped:{id:string, reasonKo:string}[], warningKo:string|null}}
   */
  restore() {
    const { state, warningKo } = this.fileStore.read();
    if (!state) return { restored: [], skipped: [], warningKo };

    const restored = [];
    const skipped = [];
    const at = this.now();
    const bySlot = [...state.slots].sort((a, b) => a.globalIndex - b.globalIndex);
    for (const s of bySlot) {
      if (this.store.getUnit(s.id)) {
        skipped.push({ id: s.id, reasonKo: `이미 있는 작업입니다: ${s.id}` });
        continue;
      }
      if (this.store.globalSlots.isOccupied(s.globalIndex)) {
        skipped.push({ id: s.id, reasonKo: `자리 ${s.globalIndex}이(가) 이미 찼습니다.` });
        continue;
      }
      // 되살린 것은 아무것도 모르는 상태다. 저장 당시 상태를 쓰지 않는다 — 애초에 저장하지 않았다.
      const unit = new WorkUnit({
        id: s.id,
        title: s.title,
        source: s.source,
        kind: s.kind,
        pinned: s.pinned,
        status: Status.UNKNOWN,
        confidence: Confidence.INFERRED,
        children: [],
        createdAt: at,
        restoredAt: at,
      });
      try {
        this.store.addUnit(unit, { atGlobalIndex: s.globalIndex });
      } catch (err) {
        skipped.push({ id: s.id, reasonKo: `자리 ${s.globalIndex}에 넣지 못했습니다: ${err.message}` });
        continue;
      }
      this.restoredIds.add(s.id);
      restored.push(s.id);
    }

    for (const a of state.acks) this.pendingAcks.set(ackKey(a), a);
    // 옛 파일의 빈칸은 여기서 당긴다. 순서는 저장된 대로다.
    this.store.compactSlots();
    return { restored, skipped, warningKo };
  }

  // ───────────── 복원 후속

  /**
   * 복원된 unit에 실제 관측이 닿았는가.
   * OrcaSync가 "목록에 없다"고 DISCONNECTED로 바꾼 것도 UNIT_UPDATED로 오지만
   * 그것은 관측이 아니라 관측의 부재다. 그걸 관측으로 치면 유예 반납이 영원히 안 일어난다.
   */
  _onUnitUpdated(unit) {
    if (!unit || !this.restoredIds.has(unit.id)) return;
    const own = unit.ownStatus;
    const observed = unit.children.length > 0
      || (own !== null && own !== Status.UNKNOWN && own !== Status.DISCONNECTED);
    if (!observed) return;
    this.store.noteObserved(unit.id, this.now());
    this.restoredIds.delete(unit.id);
  }

  /**
   * adapter 목록에 이 id들이 **있었다.** 상태가 안 바뀌었어도 관측이다.
   * 상태 변화만 관측으로 치면, 복원된 UNKNOWN과 들어온 UNKNOWN이 같을 때
   * 멀쩡히 목록에 있는 작업이 유예 뒤 반납되고 자리가 옮겨진다 (최종 리뷰 C1).
   */
  noteSeen(ids) {
    for (const id of ids) {
      if (!this.restoredIds.has(id)) continue;
      this.store.noteObserved(id, this.now());
      this.restoredIds.delete(id);
    }
  }

  /**
   * 되살린 ACK와 같은 키의 알림이 다시 생기면 확인된 것으로 만든다.
   * runId가 없으면 하지 않는다 — 재시작 중 새 완료가 있었는지 알 수 없고,
   * 한 번 더 누르는 비용이 완료를 숨기는 비용보다 싸다.
   * Store 변경 도중에 다시 Store를 바꾸지 않으려고 마이크로태스크로 미룬다.
   */
  _onNotification(n) {
    if (!n || n.runId === null || n.runId === undefined) return;
    const key = ackKey(n);
    if (!this.pendingAcks.has(key)) return;
    this.pendingAcks.delete(key);
    queueMicrotask(() => {
      const live = this.store.notification(n.id);
      if (!live || live.acknowledged || live.superseded) return;
      this.store.acknowledgeNotification(n.id);
    });
  }

  /**
   * 복원됐는데 유예가 지나도록 관측되지 않은 것을 반납한다.
   * 정책은 Store.canRelease에 있다. 여기서는 후보를 고르고 결과를 모을 뿐이다.
   * @returns {string[]} 반납한 id
   */
  sweep({ now = this.now() } = {}) {
    const released = [];
    for (const id of [...this.restoredIds]) {
      if (this.store.releaseUnit(id, { now, graceMs: this.graceMs })) {
        this.restoredIds.delete(id);
        released.push(id);
      }
    }
    return released;
  }
}
