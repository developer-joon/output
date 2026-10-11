import { SLOTS_PER_BANK } from './hardware.js';

/**
 * 안정적인 slot 할당기.
 * - 재조회 순서가 바뀌어도 slot을 재정렬하지 않는다 (config: neverReorderOccupiedSlots).
 *   자리가 빌 때만 StateStore.compactSlots()가 상대 순서를 지키며 앞으로 당긴다.
 * - 새 unit은 비어 있는 가장 낮은 index에 들어간다. 기존 slot을 밀지 않는다.
 * - 해제 정책(DONE_UNSEEN/RUNNING/pin 보호)은 StateStore가 판단한다.
 *
 * globalIndex = bankIndex * 10 + slotIndex(0..9)
 */
export class SlotManager {
  constructor({ slotsPerBank = SLOTS_PER_BANK } = {}) {
    this.slotsPerBank = slotsPerBank;
    this._byId = new Map();     // id -> globalIndex
    this._byIndex = new Map();  // globalIndex -> id
  }

  assign(id) {
    if (this._byId.has(id)) return this._byId.get(id);
    let i = 0;
    while (this._byIndex.has(i)) i += 1;
    this._byId.set(id, i);
    this._byIndex.set(i, id);
    return i;
  }

  /**
   * 지정한 자리에 넣는다. 복원 전용 — 저장된 배치를 그대로 되살릴 때만 쓴다.
   * 평소 할당은 assign()이 하고, 자리를 고르는 정책은 거기에만 있다.
   */
  assignAt(id, globalIndex) {
    if (this._byId.has(id)) throw new Error(`already assigned: ${id}`);
    if (this._byIndex.has(globalIndex)) throw new Error(`slot occupied: ${globalIndex}`);
    this._byId.set(id, globalIndex);
    this._byIndex.set(globalIndex, id);
    return globalIndex;
  }

  isOccupied(globalIndex) {
    return this._byIndex.has(globalIndex);
  }

  /**
   * 정책 검사 없이 자리를 비운다.
   * 해제 가능 여부 판단은 StateStore.canRelease가 담당한다 (C13).
   * @returns {boolean} 반납 성공 여부
   */
  forceRelease(id) {
    if (!this._byId.has(id)) return false;
    const i = this._byId.get(id);
    this._byId.delete(id);
    this._byIndex.delete(i);
    return true;
  }

  globalIndexOf(id) {
    return this._byId.has(id) ? this._byId.get(id) : -1;
  }

  /** @returns {{bank:number, slot:number}|null} */
  positionOf(id) {
    const i = this.globalIndexOf(id);
    if (i < 0) return null;
    return { bank: Math.floor(i / this.slotsPerBank), slot: i % this.slotsPerBank };
  }

  idAt(bank, slot) {
    return this._byIndex.get(bank * this.slotsPerBank + slot) ?? null;
  }

  get bankCount() {
    if (this._byIndex.size === 0) return 1;
    const max = Math.max(...this._byIndex.keys());
    return Math.floor(max / this.slotsPerBank) + 1;
  }

  get size() {
    return this._byId.size;
  }

  ids() {
    return [...this._byId.keys()];
  }
}
