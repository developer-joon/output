/**
 * 물리 입력 → 의도 (CODEX_NEXT_TASK_KO.md 5절).
 *
 * M1의 메서드를 직접 부르는 것과 실물 입력이 연결된 것은 다르다.
 * - press/release, debounce, hold
 * - 한 번 길게 눌렀을 때 tap과 hold가 둘 다 실행되지 않게 한다 (C25)
 * - joystick neutral/deadzone, 회전 rate 제한
 * - 연결이 끊기면 눌린 상태를 초기화한다 (C26)
 *
 * 실기 8·9차 관측: 조이스틱은 극좌표 {a: 각도 0~1, d: 거리 0~1}로 온다.
 * 직교좌표 입력도 계속 받되 내부에서 극좌표로 바꾼다.
 *
 * 이 계층은 상태를 바꾸지 않는다. 의도만 만들어 낸다.
 */
export class InputDecoder {
  constructor({
    holdMs = 500, debounceMs = 20, deadzone = 0.35, rotateMinIntervalMs = 15,
    sectors = null, now = () => Date.now(), onIntent = () => {}, onKeyEdge = () => {},
  } = {}) {
    this.holdMs = holdMs;
    this.debounceMs = debounceMs;
    this.deadzone = deadzone;
    this.rotateMinIntervalMs = rotateMinIntervalMs;
    // calibration의 실측 방향 구간. 없으면 직교좌표 판정으로 떨어진다.
    this.sectors = sectors;
    this.now = now;
    this.onIntent = onIntent;
    // 키 누름·뗌 가장자리 (키 LED 반응용, 2026-10-04). 의도 판정과 별개
    this.onKeyEdge = onKeyEdge;

    this._pressed = new Map();     // key -> {at, holdFired}
    this._lastEventAt = new Map(); // key -> ts (debounce)
    this._lastRotateAt = -Infinity;   // 첫 회전은 삼키지 않는다
    this._joystickActive = null;
    this.droppedBounces = 0;
    this.droppedRotations = 0;
    this._holdDirs = new Set();      // 길게 칸이 설정된 조이스틱 방향
    this._joyPending = null;         // {dir, at, fired} — 길게 판정 중인 기울임
  }

  get pressedKeys() {
    return [...this._pressed.keys()];
  }

  _emit(intent) {
    this.onIntent(intent);
    return intent;
  }

  press(key) {
    const t = this.now();
    const last = this._lastEventAt.get(key) ?? -Infinity;
    if (t - last < this.debounceMs) {
      this.droppedBounces += 1;
      return null;
    }
    this._lastEventAt.set(key, t);
    if (this._pressed.has(key)) return null;   // 중복 press 무시
    this._pressed.set(key, { at: t, holdFired: false });
    this.onKeyEdge(key, true);
    return null;   // 의도는 release 또는 hold 시점에 확정된다
  }

  /** hold 판정을 위해 시간 경과를 알린다 (타이머 대신 명시적 tick). */
  tick() {
    const t = this.now();
    const fired = [];
    for (const [key, st] of this._pressed) {
      if (!st.holdFired && t - st.at >= this.holdMs) {
        st.holdFired = true;
        fired.push(this._emit({ type: 'hold', key, at: t }));
      }
    }
    const p = this._joyPending;
    if (p && !p.fired && t - p.at >= this.holdMs) {
      p.fired = true;
      fired.push(this._emit({ type: 'joystick', direction: p.dir, hold: true, at: t }));
    }
    return fired;
  }

  release(key) {
    const t = this.now();
    const st = this._pressed.get(key);
    if (!st) return null;    // 유령 release 무시
    this._pressed.delete(key);
    this._lastEventAt.set(key, t);
    this.onKeyEdge(key, false);
    // hold가 이미 나갔으면 tap을 추가로 내보내지 않는다 (C25).
    if (st.holdFired) return null;
    if (t - st.at >= this.holdMs) {
      return this._emit({ type: 'hold', key, at: t });
    }
    return this._emit({ type: 'tap', key, at: t });
  }

  /** 조이스틱 구간을 바꾼다 (4방향 ↔ 8방향). 진행 중인 방향은 잊는다 */
  setSectors(sectors) {
    this.sectors = sectors;
    this._joystickActive = null;
    this._joyPending = null;
  }

  /** 길게 칸이 설정된 방향 (설정 저장 때마다). 진행 중인 판정은 잊는다 */
  setHoldDirections(dirs) {
    this._holdDirs = new Set(dirs ?? []);
    this._joyPending = null;
    this._joystickActive = null;
  }

  /** 중립 복귀. 길게 판정 중이었고 아직 길게가 안 나갔으면 짧게를 낸다 */
  _joyNeutral() {
    const p = this._joyPending;
    this._joyPending = null;
    this._joystickActive = null;
    if (p && !p.fired) return this._emit({ type: 'joystick', direction: p.dir, hold: false, at: this.now() });
    return null;
  }

  /** 새 방향에 들어감. 길게 칸이 없으면 즉시 짧게, 있으면 판정 시작 (앞 판정은 버린다) */
  _joyEnter(dir, extra = {}) {
    if (this._joystickActive === dir) return null;
    this._joystickActive = dir;
    this._joyPending = null;
    if (this._holdDirs.has(dir)) {
      this._joyPending = { dir, at: this.now(), fired: false };
      return null;
    }
    return this._emit({ type: 'joystick', direction: dir, hold: false, ...extra, at: this.now() });
  }

  /**
   * 실측 구간에서 각도(0~1)에 해당하는 방향을 찾는다.
   * 구간은 원을 한 바퀴 도므로 경계를 넘는 경우를 처리한다.
   */
  _directionFromAngle(angle) {
    if (!this.sectors?.length) return null;
    const a = ((angle % 1) + 1) % 1;
    for (const s of this.sectors) {
      const from = ((s.from % 1) + 1) % 1;
      const to = ((s.to % 1) + 1) % 1;
      // 시작과 끝이 같으면 원 전체 (1방향 조이스틱, 2026-10-03)
      const inside = from === to ? true : from < to ? (a >= from && a < to) : (a >= from || a < to);
      if (inside) return s.direction ?? s.dir;
    }
    return null;
  }

  /**
   * 장치가 보내는 극좌표 그대로 받는다 (v.oai.rad).
   * @param {{angle:number, distance:number}} pos
   */
  joystickPolar({ angle, distance }) {
    if (!(distance >= this.deadzone)) return this._joyNeutral();   // neutral 복귀 (d=0 포함)
    const dir = this._directionFromAngle(angle);
    if (!dir) return null;             // 구간을 모르면 추측하지 않는다
    return this._joyEnter(dir, { angle, distance });
  }

  /** 직교좌표 입력. 내부에서 극좌표로 바꿔 같은 경로를 탄다. */
  joystick({ x, y }) {
    const distance = Math.min(1, Math.hypot(x, y));
    if (!(distance >= this.deadzone)) return this._joyNeutral();
    if (this.sectors?.length) {
      // 장치 각도 규약: right=0, down=0.25, left=0.5, up=0.75
      const angle = ((Math.atan2(-y, x) / (2 * Math.PI)) % 1 + 1) % 1;
      return this.joystickPolar({ angle, distance });
    }
    const dir = Math.abs(x) >= Math.abs(y)
      ? (x > 0 ? 'right' : 'left')
      : (y > 0 ? 'up' : 'down');
    return this._joyEnter(dir);
  }

  /** @param {number} delta +1 CW / -1 CCW */
  dial(delta) {
    const t = this.now();
    if (t - this._lastRotateAt < this.rotateMinIntervalMs) {
      this.droppedRotations += 1;
      return null;
    }
    this._lastRotateAt = t;
    return this._emit({ type: 'dial', direction: delta > 0 ? 'cw' : 'ccw', at: t });
  }

  /** 연결 끊김: 눌린 상태를 모두 해제하고 유령 입력을 만들지 않는다 (C26). */
  disconnected() {
    const cleared = [...this._pressed.keys()];
    this._pressed.clear();
    this._joystickActive = null;
    this._joyPending = null;
    this._lastEventAt.clear();
    this._lastRotateAt = -Infinity;
    return cleared;   // 의도는 하나도 만들지 않는다
  }
}
