import { Status } from '../../core/types.js';

/**
 * Orca 목록 → StateStore 반영.
 *
 * 지켜야 할 것:
 *  - **목록 순서로 슬롯을 움직이지 않는다.** 새 worktree는 빈 자리에만 들어간다 (C02).
 *    자리가 빌 때만 Store가 빈칸을 앞으로 당긴다 (상대 순서 유지).
 *  - **사라진 것을 지우지 않는다.** 목록에서 빠졌다고 끝난 것이 아니다.
 *    관측이 끊긴 것이므로 DISCONNECTED로 표시하고 자리는 지킨다 (C13/C14).
 *  - 터미널 목록에서 빠진 탭은 사용자가 닫은 것이다 → child를 지운다 (2026-10-02, STALE로 남기면 빨강이 된다).
 *    Orca 재시작으로 끊긴 탭은 목록에 orphaned로 남아 있으므로 여기 해당하지 않는다.
 *  - 목록을 다시 읽었다고 해서 상태를 '정상'으로 가장하지 않는다.
 *  - **Orca가 숨긴 것은 사라진 것이 아니다.** 사용자가 필터로 뺀 작업은 관측 끊김이 아니라
 *    자리를 비운다 (hiddenIds). 다시 보이면 빈 자리에 새로 들어온다.
 */
export class OrcaSync {
  constructor(store) {
    this.store = store;
    /** handle → {worktreeId, tabId, leafId} — stale 복구에 쓴다 */
    this.handleIndex = new Map();
  }

  /** 어댑터가 준 원본 terminal 목록으로 복구용 색인을 갱신한다. */
  indexTerminals(terminals = []) {
    for (const t of terminals) {
      if (!t.handle) continue;
      this.handleIndex.set(t.handle, {
        worktreeId: t.worktreeId, tabId: t.tabId, leafId: t.leafId,
      });
    }
    return this.handleIndex;
  }

  _ackedAfter(unitId, childId, doneAt) {
    if (!doneAt) return false;
    return this.store.acknowledgedNotifications()
      .some((n) => n.unitId === unitId && n.childId === childId && (n.acknowledgedAt ?? 0) >= doneAt);
  }

  locate(handle) {
    return this.handleIndex.get(handle) ?? null;
  }

  /**
   * @param {import('../../core/units.js').WorkUnit[]} units 어댑터가 만든 목록
   * @param {{hiddenIds?:string[]}} [opts] Orca 필터가 숨긴 worktree id
   * @returns {{added:string[], updatedChildren:number, vanished:string[], goneChildren:number, renamed:number, hidden:string[]}}
   */
  syncOnce(units, { hiddenIds = [], order = null } = {}) {
    const added = [];
    const vanished = [];
    const hidden = [];
    for (const id of hiddenIds) {
      if (this.store.getUnit(id) && this.store.hideUnit(id)) hidden.push(id);
    }
    let updatedChildren = 0;
    let goneChildren = 0;
    let renamed = 0;

    const incoming = new Map(units.map((u) => [u.id, u]));

    for (const unit of units) {
      const existing = this.store.getUnit(unit.id);
      if (!existing) {
        this.store.addUnit(unit);       // 빈 자리에만 들어간다
        added.push(unit.id);
        continue;
      }
      // 이름은 Orca가 정한다. 자리는 id로 지키므로 이름이 바뀌어도 움직이지 않는다.
      if (unit.title && existing.title !== unit.title) {
        existing.title = unit.title;
        renamed += 1;
      }
      // worktree 자신의 상태가 바뀌었으면 반영한다. 들어온 값이 null이어도 지운다.
      // 안 그러면 끊김(DISCONNECTED)이나 중단(interrupted → 답변 필요)이 풀린 뒤에도 영원히 남는다.
      if (existing.ownStatus !== unit.ownStatus) {
        this.store.setUnitStatus(unit.id, unit.ownStatus ?? null);
      }
      const known = new Set(existing.children.map((c) => c.id));
      for (const child of unit.children) {
        if (!known.has(child.id)) {
          this.store.addChild(unit.id, child);
          updatedChildren += 1;
          continue;
        }
        const cur = existing.child(child.id);
        // Output에서 ACK한 완료를 다음 폴링이 다시 '미확인'으로 덮지 않게 한다.
        // 같은 완료(doneAt이 ACK 이전)면 확인함으로 본다. 새 완료는 doneAt이 더 늦다.
        if (child.status === Status.DONE_UNSEEN && this._ackedAfter(unit.id, child.id, child.doneAt)) {
          child.status = Status.DONE_SEEN;
        }
        // 상태 값이 같아도 새 이벤트일 수 있다. 승인이 연달아 오면
        // waiting → working → waiting이 한 폴링 주기 안에서 끝나 값은 그대로다.
        // 그때 달라지는 것은 개입 진입 시각뿐이므로 그것도 함께 본다.
        if (cur.status !== child.status || cur.waitingSince !== child.waitingSince) {
          this.store.setChildStatus(unit.id, child.id, child.status, {
            waitingSince: child.waitingSince,
          });
          updatedChildren += 1;
        }
      }
      // 목록에서 빠진 터미널(사용자가 닫은 탭)은 지운다
      const incomingChildIds = new Set(unit.children.map((c) => c.id));
      for (const cur of [...existing.children]) {
        if (!incomingChildIds.has(cur.id) && this.store.removeChild(unit.id, cur.id)) goneChildren += 1;
      }
    }

    // 목록에서 사라진 worktree.
    // 소스가 순서를 준다면(Orca 사이드바가 기준, 2026-09-30) 정상 목록에서 빠진 것은 삭제된 것이다 → 자리를 비운다.
    // 순서가 없는 호출은 예전처럼 관측 끊김으로 자리를 지킨다. Orca에 닿지 못하면 이 함수 자체가 불리지 않는다.
    for (const unit of this.store.allUnits()) {
      if (unit.source !== 'orca') continue;
      if (incoming.has(unit.id)) continue;
      if (order) {
        if (this.store.hideUnit(unit.id)) vanished.push(unit.id);
        continue;
      }
      if (unit.ownStatus === Status.DISCONNECTED) continue;
      this.store.setUnitStatus(unit.id, Status.DISCONNECTED);
      vanished.push(unit.id);
    }

    // 소스가 순서를 주면 그 순서로 자리를 맞춘다 (사용자 결정 2026-09-30: Orca 사이드바와 같게)
    const arranged = order ? this.store.arrangeSlots(order) : 0;
    return { added, updatedChildren, vanished, goneChildren, renamed, hidden, arranged };
  }
}
