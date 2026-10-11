import { ledStyle, pressMs } from '../apps/keyLed.js';
import { actionLabel } from '../apps/actionLabel.js';
import { parseKeystroke } from './profiles.js';

/** 아래 줄 세 키 → 레이어 칸 id (2026-10-05: 셋 다 레이어 칸) */
export const LOGICAL_KEY_SLOT = Object.freeze({ attention: 'key11', ack: 'key12', mode_back: 'key13' });

/**
 * OutputService의 키 누름 처리: LED 덧칠과 누르고 있으면 반복 (2026-10-10 outputService.js에서 나눔).
 * OutputService.prototype에 붙는다 — this는 서비스다.
 */
export class KeyRepeatMethods {
  /** 키 누름·뗌 가장자리 → LED 덧칠 (키 LED 스펙 §4.2). 앱 모드의 동작 있는 키만 */
  _onKeyEdge(logical, down) {
    if (this._stopping) return;
    if (down) this._startRepeat(logical);
    else this._stopRepeat(logical);
    if (!down) {
      const st = this._led.get(logical);
      if (st) { st.down = false; this.scheduler.requestRender(); }
      return;
    }
    const id = this._keyIdOf(logical);
    // 앱 모드의 키, Orca 모드에서는 레이어 칸인 키 11·12·13만 (작업 칸 1~10은 Output이 그린다)
    const led = id && (this.mode === 'app' || (this.mode === 'orca' && LOGICAL_KEY_SLOT[logical])) ? this._slots[id]?.led : null;
    if (!led || (!led.press && !led.hold)) return;
    const color = this._layer?.color ?? '#5A8CDC';
    this._led.set(logical, {
      down: true,
      press: led.press ? ledStyle({ ...led.press, effect: 'solid', speed: 'normal' }, color) : null,
      hold: led.hold ? ledStyle(led.hold, color) : null,
      pressUntil: led.press ? this.now() + pressMs(led.press) : 0,
    });
    this.scheduler.requestRender();
    if (led.press) (this.timers.setTimeout ?? setTimeout)(() => { if (!this._stopping) this.scheduler.requestRender(); }, pressMs(led.press) + 5);
  }

  /** 키 칸 id: slotN → keyN, 아래 줄 세 키 → key11·12·13 */
  _keyIdOf(logical) {
    return LOGICAL_KEY_SLOT[logical] ?? (/^slot(\d+)$/.test(logical) ? `key${logical.slice(4)}` : null);
  }

  /**
   * 누르고 있으면 반복 (스펙 2026-10-09 §4.3): 누르는 순간 실행기로 한 번(안전 규칙 그대로), 성공하면
   * macOS 반복 지연 뒤부터 간격마다 단축키를 직접 보낸다. 앱 모드의 키, Orca 모드에서는 키 11·12·13만.
   */
  _startRepeat(logical) {
    const id = this._keyIdOf(logical);
    if (!id || !(this.mode === 'app' || (this.mode === 'orca' && LOGICAL_KEY_SLOT[logical]))) return;
    const action = this._slots[id];
    if (action?.type !== 'shortcut' || action.repeat === false) return;   // 반복은 기본 켬
    const st = { id, front: this._front, timer: null };
    this._repeats.set(logical, st);
    this._consumed.add(logical);
    const t = { delayMs: 500, intervalMs: 100, ...(this.keyRepeat() ?? {}) };
    const pressAt = this.now();
    const ks = parseKeystroke(action.keystroke);
    const later = (fn, ms) => (this.timers.setTimeout ?? setTimeout)(fn, ms);
    const tick = async () => {
      if (this._repeats.get(logical) !== st) return;
      // 화면 잠금이나 앞 앱 바뀜(같은 레이어 안에서도)이면 멈춘다
      if (this.isLocked() || this._front !== st.front) { this._stopRepeat(logical); return; }
      let via;
      try { via = await this.runner.exec.synth(ks); } catch { this._stopRepeat(logical); return; }
      // 실제로 네이티브로 갔으면 macOS 간격, osascript로 내려갔으면(느림) 최소 150ms — 쌓이지 않게
      if (this._repeats.get(logical) === st) st.timer = later(tick, via === 'native' ? t.intervalMs : Math.max(150, t.intervalMs));
    };
    this.usage?.add(this._layer?.id, id);   // 키별 사용 횟수 (2026-10-10)
    this.runner.notePhysical(id);
    this.runner.run(id, action, { kind: 'app', bundleId: this._front }).then((r) => {
      this.lastEventKo = r.ok ? `${actionLabel(action)} 실행` : `${actionLabel(action)}: ${r.reasonKo}`;
      if (!r.ok) {
        if (this._repeats.get(logical) === st) this._stopRepeat(logical);
        // 아직 누르고 있으면 소비를 풀어, 뗄 때 탭이 평소 길(앞 앱 재확인 포함)로 한 번 들어가게 한다
        // (앞 앱을 막 바꾼 직후 — 감시 주기 전 — 누르면 첫 입력이 앞 앱 확인에 걸린다)
        if (this.decoder.pressedKeys.includes(logical)) this._consumed.delete(logical);
      } else if (this._repeats.get(logical) === st) {
        // 반복 지연은 누른 순간부터 잰다 (첫 입력이 걸린 시간을 뺀다)
        st.timer = later(tick, Math.max(0, t.delayMs - (this.now() - pressAt)));
      }
      this._changed();
    }).catch((err) => {
      this._log(`반복 처리 실패: ${err?.message ?? err}`, 'warn');
      if (this._repeats.get(logical) === st) this._stopRepeat(logical);
    });
  }

  _stopRepeat(logical) {
    const st = this._repeats.get(logical);
    if (!st) return;
    this._repeats.delete(logical);
    if (st.timer) (this.timers.clearTimeout ?? clearTimeout)(st.timer);
  }

  /** Output 자기 창을 눌렀다 — 앞 앱 감시가 무시하는 창이라 따로 알려 받아 반복을 멈춘다 (키가 설정 창에 들어가지 않게) */
  ownWindowFocused() {
    this._stopAllRepeats();
  }

  _stopAllRepeats() {
    for (const k of [...this._repeats.keys()]) this._stopRepeat(k);
  }
}
