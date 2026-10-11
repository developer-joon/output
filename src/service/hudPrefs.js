import path from 'node:path';
import fs from 'node:fs';

import { writeJsonAtomic } from '../adapters/persistence/fileStore.js';
import { joystickHud, dialHud } from './hudModel.js';
import { RAD_EVENT, HID_EVENT, ACT } from '../input/deviceEventDecoder.js';
import { connectFlash } from '../device/connectFlash.js';
import { normalizeNight, inNight } from './nightDim.js';

/** 언더글로우 짧은 알림 (2026-10-10) */
const LAYER_FLASH_MS = 300;
const BATTERY_FLASH_MS = 1000;
const BATTERY_LOW = 15;

/**
 * OutputService의 설정(prefs.json)·노브/조이스틱 화면 표시·연결 인사 (2026-10-10 outputService.js에서 나눔).
 * OutputService.prototype에 붙는다 — this는 서비스다.
 */
export class HudPrefsMethods {
  /** 연결 인사 (2026-10-10): 처음이면 회전, 끊겼다 다시면 빨강 깜박임부터. 단계가 끝날 때마다 다시 그린다 */
  _startConnectFlash() {
    this._flash = connectFlash({ reconnect: this._everConnected, at: this.now() });
    this._everConnected = true;
    const at = this.now();
    for (const end of this._flash.endsAt) (this.timers.setTimeout ?? setTimeout)(() => { if (!this._stopping) this.scheduler.requestRender(); }, end - at + 5);
  }

  /** 지금 덮을 것: 연결 인사(키·언더글로우) → 언더글로우만 짧게(레이어 바뀜·배터리) */
  _flashNow() {
    const f = this._flash?.(this.now()) ?? null;
    if (!f) this._flash = null;
    if (f) return f;
    const a = this._ambientFlash;
    if (a && this.now() < a.until) return { ambientZone: a.zone };
    this._ambientFlash = null;
    return null;
  }

  /** 언더글로우만 잠깐 (키는 그대로). 끝날 때 다시 그린다 */
  _flashAmbient(zone, ms) {
    this._ambientFlash = { zone, until: this.now() + ms };
    (this.timers.setTimeout ?? setTimeout)(() => { if (!this._stopping) this.scheduler.requestRender(); }, ms + 5);
    this.scheduler.requestRender();
  }

  /** 레이어 바뀜 (2026-10-10): 새 레이어 색으로 0.3초 */
  _layerFlash(color) {
    if (color) this._flashAmbient({ color, brightness: 1, pattern: 'solid' }, LAYER_FLASH_MS);
  }

  /** 배터리 경고 (2026-10-10): 15% 이하이고 충전 중이 아니면 1초 주황 빠른 깜박임 (배터리 확인마다 = 1분에 한 번) */
  _batteryWarn() {
    const { battery, charging } = this.power;
    if (Number.isFinite(battery) && battery <= BATTERY_LOW && !charging) this._flashAmbient({ color: 'orange', brightness: 1, pattern: 'blink_fast' }, BATTERY_FLASH_MS);
  }

  /** 밤 시간 밝기 (2026-10-10): 켜져 있고 구간 안이면 반 밝기. 바뀌었을 때만 다시 그린다 */
  _applyNight(date = new Date(this.now())) {
    const n = this._prefs.night;
    const scale = n.enabled && inNight(date, n.from, n.to) ? 0.5 : 1;
    if (this.driver.brightnessScale !== scale) { this.driver.brightnessScale = scale; this.scheduler.requestRender(); }
  }

  _prefsFile() {
    return path.join(this.stateDir, 'prefs.json');
  }

  /** 설정 (기본: 노브·조이스틱 표시 켬). 모르는 값은 기본 */
  _loadPrefs() {
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(this._prefsFile(), 'utf8')); } catch { /* 없으면 기본 */ }
    return { hud: { knob: raw?.hud?.knob !== false, joystick: raw?.hud?.joystick !== false }, night: normalizeNight(raw?.night) };
  }

  prefsGet() {
    return structuredClone(this._prefs);
  }

  prefsSet(raw) {
    this._prefs = { hud: { knob: raw?.hud?.knob !== false, joystick: raw?.hud?.joystick !== false }, night: normalizeNight(raw?.night) };
    try { writeJsonAtomic(this._prefsFile(), this._prefs); } catch (err) { return { ok: false, errorKo: `저장하지 못했습니다: ${err.message}` }; }
    this._applyNight();
    return { ok: true };
  }

  /** 장치 입력 원문 → 화면 표시. 디코더와 같은 구간·데드존으로 방향을 정한다. 대기(레이어 없음)면 내지 않는다 */
  _hudInput(obj) {
    if (this.mode === 'idle' || !obj) return;
    const p = obj.p ?? {};
    if (obj.m === RAD_EVENT && this._prefs.hud.joystick && typeof p.a === 'number' && typeof p.d === 'number') {
      const dz = this.decoder.deadzone;
      const dir = p.d >= dz ? this.decoder._directionFromAngle(p.a) : null;
      if (dir !== this._hudJoy.dir) this._hudJoy = { dir, enteredAt: dir ? this.now() : null };
      const hud = joystickHud({ angle: p.a, distance: p.d, dir, sectors: this.decoder.sectors, deadzone: dz, holdMs: this.decoder.holdMs,
        holdDirs: [...(this.decoder._holdDirs ?? [])], slots: this._slots, enteredAt: this._hudJoy.enteredAt });
      this.emit('hud', p.d < dz ? { ...hud, end: true } : { ...hud, heldMs: dir ? this.now() - this._hudJoy.enteredAt : 0 });
      return;
    }
    // 레이어 고르는 중에는 노브 표시를 내지 않는다 — 고르기 목록이 그 자리에 있다
    if (obj.m === HID_EVENT && this._prefs.hud.knob && !this._picker) {
      const logical = this.eventDecoder.logicalOf(p.k);
      const action = p.act === ACT.ROTATE ? { dial_cw: 'cw', dial_ccw: 'ccw' }[logical]
        : p.act === ACT.PRESS && logical === 'dial_click' ? 'press' : null;
      if (action) this.emit('hud', dialHud(action, this._slots));
    }
  }
}
