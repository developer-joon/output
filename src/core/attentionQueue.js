import { Status, isAttention } from './types.js';
import { compareAttention, summarizeAmbient } from './policy.js';

/**
 * 전체 bank / 전체 source를 가로지르는 개입 목록.
 * 현재 보고 있는 bank를 참조하지 않는다 (hidden bank 규칙).
 *
 * 탐색은 명시적 cursor 세션으로 한다 (C06):
 * - 이미 방문한 항목은 한 바퀴 동안 다시 주지 않는다.
 * - 새로 생긴 더 급한 항목은 즉시 드러난다.
 * - 큐에서 오류를 지우거나 실패를 성공으로 바꾸지 않는다.
 */
export class AttentionQueue {
  constructor(store) {
    this.store = store;
    this._visited = new Set();   // 이번 탐색 세션에서 이미 안내한 key
    this._topKeyAtStart = null;
  }

  _key(i) {
    return `${i.unitId}::${i.childId ?? ''}`;
  }

  /** 알림 확인 여부는 개입 순서의 1차 축이므로 여기서 합쳐준다. */
  _acknowledged(unitId, childId) {
    const ns = this.store.notificationsFor(unitId, childId);
    return ns.length > 0 && ns.every((n) => n.acknowledged);
  }

  items(now = this.store.now()) {
    const out = [];
    for (const unit of this.store.allUnits()) {
      const slot = this.store.globalSlots.globalIndexOf(unit.id);
      const push = (child) => {
        const status = child ? child.status : unit.ownStatus;
        if (!isAttention(status)) return;
        out.push({
          unitId: unit.id,
          childId: child?.id ?? null,
          status,
          slot,
          impact: child?.impact ?? unit.impact,
          waitingSince: child?.waitingSince ?? 0,
          acknowledged: this._acknowledged(unit.id, child?.id ?? null),
        });
      };
      // parent 자체 사실도 개입 대상이다 (C09).
      if (unit.ownStatus) push(null);
      for (const c of unit.children) push(c);
    }
    out.sort((a, b) => compareAttention(a, b, now));
    return out;
  }

  /** 확인 대상(joystick DOWN: next unseen done/error) */
  unseenItems() {
    return this.store.unacknowledgedNotifications().map((n) => ({
      unitId: n.unitId,
      childId: n.childId,
      status: n.kind === 'error' ? Status.ERROR : Status.DONE_UNSEEN,
      notificationId: n.id,
      slot: this.store.globalSlots.globalIndexOf(n.unitId),
    })).sort((a, b) => (a.status === b.status ? a.slot - b.slot : a.status === Status.ERROR ? -1 : 1));
  }

  top() {
    return this.items()[0] ?? null;
  }

  /**
   * ATTENTION / joystick UP.
   * 아직 안내하지 않은 가장 급한 항목을 준다.
   * 전부 안내했으면 세션을 새로 시작한다.
   */
  next() {
    const list = this.items();
    if (!list.length) {
      this._visited.clear();
      return null;
    }
    // 세션 중 더 급한 신규 항목이 1순위로 올라오면 즉시 안내한다.
    const topKey = this._key(list[0]);
    if (this._topKeyAtStart !== null && topKey !== this._topKeyAtStart
        && !this._visited.has(topKey)) {
      this._visited.add(topKey);
      this._topKeyAtStart = topKey;
      return list[0];
    }

    const fresh = list.find((i) => !this._visited.has(this._key(i)));
    if (fresh) {
      if (this._visited.size === 0) this._topKeyAtStart = topKey;
      this._visited.add(this._key(fresh));
      return fresh;
    }
    this._visited.clear();
    this._topKeyAtStart = topKey;
    this._visited.add(topKey);
    return list[0];
  }

  /**
   * underglow 요약 (모든 묶음).
   * LIGHTING_POLICY.md 기준이므로 '지금 표시되는 상태'를 본다.
   * 알림(notification)은 ACK 대상 지정용이지 조명 근거가 아니다.
   */
  summaryStatus() {
    const hasUnseenDone = this.store.allUnits().some((u) => u.status === Status.DONE_UNSEEN
      || u.children.some((c) => c.status === Status.DONE_UNSEEN));
    const hasRunning = this.store.allUnits().some((u) => u.status === Status.RUNNING);
    const hasInterrupted = this.store.allUnits().some((u) => u.status === Status.INTERRUPTED
      || u.children.some((c) => c.status === Status.INTERRUPTED));
    return summarizeAmbient(this.items(), { hasUnseenDone, hasRunning, hasInterrupted });
  }
}
