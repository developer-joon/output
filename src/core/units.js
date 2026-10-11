import {
  Status, Confidence, Impact, ChildRole, defaultRequiredForCompletion,
} from './types.js';
import { aggregateUnitStatus, resolveFocusTarget } from './policy.js';

let seq = 0;

export class ChildUnit {
  constructor({
    id, title, kind, role = ChildRole.TERMINAL, status = Status.RUNNING,
    confidence = Confidence.AUTHORITATIVE, primaryAgent = false, lastActiveAt = 0,
    requiredForCompletion = null, impact = null, runId = null, outcome = null,
    waitingSince = 0, lastSeq = -1, lastHeartbeatAt = 0,
  } = {}) {
    this.id = id ?? `child-${++seq}`;
    this.title = title ?? this.id;
    this.role = role ?? ChildRole.TERMINAL;
    this.kind = kind ?? this.role;
    this.status = status;
    this.confidence = confidence;
    this.primaryAgent = primaryAgent;
    this.lastActiveAt = lastActiveAt;
    this.impact = impact;                    // null이면 부모 영향도를 따른다
    // 상주 표면(dev server/shell/log tail)은 완료 판정의 필수 조건이 아니다.
    this.requiredForCompletion = requiredForCompletion ?? defaultRequiredForCompletion(this.role);
    // 실행 세대. 오래된 run의 이벤트를 걸러내는 데 쓴다.
    this.runId = runId;
    this.outcome = outcome;                  // success | interrupted | failed
    this.waitingSince = waitingSince;
    this.lastSeq = lastSeq;
    this.lastHeartbeatAt = lastHeartbeatAt;
  }
}

export class WorkUnit {
  constructor({
    id, title, source = 'mock', kind = 'worktree',
    status = null, confidence = Confidence.AUTHORITATIVE,
    children = [], createdAt = 0, impact = Impact.NORMAL, pinned = false,
    ownWaitingSince = 0, restoredAt = 0, observedAt = 0,
  } = {}) {
    this.id = id ?? `unit-${++seq}`;
    this.title = title ?? this.id;
    this.source = source;
    this.kind = kind;
    this.confidence = confidence;
    this.children = children.map((c) => (c instanceof ChildUnit ? c : new ChildUnit(c)));
    this.createdAt = createdAt;
    this.impact = impact;
    this.pinned = pinned;
    // worktree 자체의 사실(예: worktree 손상). children이 있어도 버리지 않는다.
    this._ownStatus = status ?? null;
    // parent 자신이 개입 상태가 된 시각. child가 아니라 묶음이 개입을 요구할 때 쓴다.
    this.ownWaitingSince = ownWaitingSince;
    // 영속화에서 되살린 unit. adapter가 한 번이라도 관측하면 observedAt이 찍힌다.
    // 둘 다 0이면 평소처럼 만들어진 unit이다.
    this.restoredAt = restoredAt;
    this.observedAt = observedAt;
  }

  /** parent 자체 사실. children과 별개로 보존된다. */
  get ownStatus() {
    return this._ownStatus;
  }

  set ownStatus(s) {
    this._ownStatus = s;
  }

  /** 대표 상태는 policy.aggregateUnitStatus가 결정한다. */
  get status() {
    return aggregateUnitStatus(this);
  }

  set status(s) {
    this._ownStatus = s;
  }

  child(id) {
    return this.children.find((c) => c.id === id) ?? null;
  }

  resolveFocusTarget() {
    return resolveFocusTarget(this);
  }
}
