/**
 * OutputService의 '노브 길게 눌러 레이어 고르기' (2026-10-10 사용자 요청).
 * 길게 → 목록(자동 + 레이어들) 화면 표시 → 노브로 옮기고 → 누르면 고름. 5초 입력이 없거나 다른 입력이면 취소.
 * 고른 레이어(_pin)는 풀 때까지 고정 (2026-10-11) — '자동'을 고르거나 앱을 다시 시작하면 앞 앱 따라 (_reevaluateMode).
 * OutputService.prototype에 붙는다 — this는 서비스다.
 */
const PICKER_IDLE_MS = 5000;
const AUTO = Object.freeze({ id: null, name: '자동 (앞 앱 따라)', color: null });

export class LayerPickerMethods {
  /** 의도가 고르기에 쓰였으면 true (평소 처리를 건너뛴다) */
  _pickerIntent(intent) {
    if (intent.type === 'hold' && intent.key === 'dial_click') { this._pickerOpen(); return true; }
    const p = this._picker;
    if (!p) return false;
    if (intent.type === 'dial') {
      const n = p.items.length;
      p.index = (p.index + (intent.direction === 'cw' ? 1 : -1) + n) % n;
      this._pickerShow();
      return true;
    }
    if (intent.type === 'tap' && intent.key === 'dial_click') {
      const it = p.items[p.index];
      this._pickerClose();
      this.pickLayer(it.id);
      // 기록 (2026-10-10 실기 조사): 무엇을 골랐고, 1.5초 뒤 장치에 실제로 보낸 키 LED 값
      this._log(`노브로 레이어 고름: ${it.name} → 지금 ${this._layer?.name ?? '없음'} (${this.mode})`);
      (this.timers.setTimeout ?? setTimeout)(() => {
        const p = this.driver.lastPayload;
        this._log(`고른 뒤 LED: ${p ? p.slice(0, 8).map((e) => e.c.toString(16).padStart(6, '0')).join(' ') : '보낸 것 없음'} · 레이어 ${this._layer?.name ?? '없음'} (${this.mode})`);
      }, 1500);
      return true;
    }
    this._pickerClose();   // 다른 입력: 취소하고 그 입력은 평소대로
    return false;
  }

  /**
   * 레이어 고르기 — 노브 목록과 상태판 칩이 함께 쓴다 (2026-10-11). id = null이면 자동(앞 앱 따라).
   * 고른 레이어는 풀 때까지 고정 (2026-10-11)
   */
  pickLayer(id) {
    if (id && !this.layers.some((l) => l.id === id)) return { ok: false, errorKo: '그 레이어를 찾지 못했습니다.' };
    this._pin = id ? { layerId: id } : null;
    this._reevaluateMode();
    this._changed();
    return { ok: true };
  }

  _pickerOpen() {
    const items = [AUTO, ...this.layers.map((l) => ({ id: l.id, name: l.name || '이름 없음', color: l.color }))];
    const cur = this._pin ? this._pin.layerId : null;
    const at = items.findIndex((i) => i.id === (cur ?? this._layer?.id ?? null));
    this._picker = { items, index: Math.max(0, at) };
    this._pickerShow();
  }

  /** 표시를 다시 내고, 입력이 없으면 5초 뒤 취소 */
  _pickerShow() {
    const p = this._picker;
    p.token = (p.token ?? 0) + 1;
    const token = p.token;
    (this.timers.setTimeout ?? setTimeout)(() => { if (this._picker === p && p.token === token) this._pickerClose(); }, PICKER_IDLE_MS);
    this.emit('hud', { kind: 'picker', items: p.items, index: p.index, pinned: Boolean(this._pin) });
  }

  _pickerClose() {
    const p = this._picker;
    if (!p) return;
    this._picker = null;
    this.emit('hud', { kind: 'picker', items: p.items, index: p.index, end: true });
  }
}
