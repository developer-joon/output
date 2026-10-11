/**
 * Bank 네비게이션. 조이스틱 LEFT/RIGHT 전용.
 * bank 전환은 slot 할당을 건드리지 않는다.
 */
export class BankManager {
  constructor(slotManager) {
    this.slots = slotManager;
    this.current = 0;
  }

  get count() {
    return this.slots.bankCount;
  }

  next() {
    this.current = (this.current + 1) % this.count;
    return this.current;
  }

  prev() {
    this.current = (this.current - 1 + this.count) % this.count;
    return this.current;
  }

  goto(bank) {
    if (bank < 0 || bank >= this.count) return false;
    this.current = bank;
    return true;
  }
}
