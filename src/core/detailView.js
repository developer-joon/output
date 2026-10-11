import { SLOTS_PER_BANK } from './hardware.js';
import { BankManager } from './bankManager.js';

/**
 * DETAIL VIEW model.
 * 선택된 WorkUnit의 child 1~10이 키 1~10을 차지한다.
 * child가 10개를 넘으면 detail bank가 생긴다.
 */
export class DetailView {
  constructor(store, unitId) {
    this.store = store;
    this.unitId = unitId;
    this.slots = store.detailSlots(unitId);
    // child가 나중에 추가됐어도 stable하게 자리를 갖도록 보정
    for (const c of store.getUnit(unitId).children) this.slots.assign(c.id);
    this.banks = new BankManager(this.slots);
  }

  get unit() {
    return this.store.getUnit(this.unitId);
  }

  /** @returns {(ChildUnit|null)[]} 길이 10 */
  visibleChildren() {
    const unit = this.unit;
    const out = [];
    for (let s = 0; s < SLOTS_PER_BANK; s += 1) {
      const id = this.slots.idAt(this.banks.current, s);
      out.push(id ? unit.child(id) : null);
    }
    return out;
  }
}
