/**
 * 최소 이벤트 버스 (CODEX_NEXT_TASK_KO.md 3절).
 *
 * - WorkUnit 상태, attention 목록, 조명 결과를 저장하지 않는다. 전달만 한다.
 * - subscriber 하나가 실패해도 Store와 다른 subscriber에 전파되지 않는다 (C20).
 * - unsubscribe 후에는 호출되지 않는다 (C19).
 *
 * 메시지 브로커나 추가 이벤트 프레임워크를 도입하지 않는다.
 */
export class EventBus {
  constructor({ onError = null } = {}) {
    this._handlers = new Map();
    this._onError = onError;
    /** 격리된 subscriber 오류 기록. 진단용이며 업무 상태가 아니다. */
    this.errors = [];
  }

  /** @returns {() => void} unsubscribe */
  on(type, handler) {
    if (!this._handlers.has(type)) this._handlers.set(type, new Set());
    const set = this._handlers.get(type);
    set.add(handler);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      set.delete(handler);
    };
  }

  emit(type, payload) {
    const hs = this._handlers.get(type);
    if (!hs || hs.size === 0) return;
    for (const h of [...hs]) {
      try {
        h(payload);
      } catch (error) {
        const record = { type, error, at: this.errors.length };
        this.errors.push(record);
        if (this._onError) {
          try { this._onError(record); } catch { /* 진단 경로도 전파하지 않는다 */ }
        }
      }
    }
  }
}

export const Events = Object.freeze({
  /** Store가 하나의 revision을 커밋했다. RenderScheduler의 유일한 입력. */
  COMMITTED: 'store:committed',
  UNIT_ADDED: 'unit:added',
  UNIT_UPDATED: 'unit:updated',
  UNIT_REMOVED: 'unit:removed',
  NOTIFICATION_ADDED: 'notification:added',
  VIEW_CHANGED: 'view:changed',
  BANK_CHANGED: 'bank:changed',
  ACTIVE_CHANGED: 'active:changed',
  FOCUS_REQUESTED: 'focus:requested',
  ACK: 'ack',
  DEVICE_CONNECTED: 'device:connected',
});
