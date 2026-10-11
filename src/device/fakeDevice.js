import { LOGICAL_KEYS } from './deviceScene.js';

/**
 * 테스트/데모용 가짜 장치. 실제 HID를 열지 않는다.
 *
 * 실기에서 미검증인 항목은 기본 false로 둔다 (C24, CODEX_NEXT_TASK 4절).
 * AG00 색 변화만 사용자 장치에서 확인된 사실이므로,
 * 나머지는 calibration 전까지 '지원함'으로 가정하지 않는다.
 */
export const UNVERIFIED_CAPABILITIES = Object.freeze({
  perKeyColor: true,          // fake에서는 켜두되 실기 기본값은 doctor가 정한다
  supportsAmbientZone: true,
  dialClick: false,           // 실기 검증 전까지 미지원
  joystick: true,
  miniLeds: false,            // 영구 미지원. write 경로를 만들지 않는다.
});

export class FakeDevice {
  constructor({ capabilities = {}, latencyMs = 0, clock = null } = {}) {
    this.capabilities = { ...UNVERIFIED_CAPABILITIES, ...capabilities };
    this.latencyMs = latencyMs;
    this.clock = clock;
    this.connected = true;
    /** 적용 완료된 scene 이력 */
    this.applied = [];
    this._inflight = 0;
    this.maxConcurrentWrites = 0;
  }

  async _delay() {
    if (!this.latencyMs) return;
    if (this.clock) return this.clock.wait(this.latencyMs);
    return new Promise((r) => { setTimeout(r, this.latencyMs); });
  }

  /** @returns {{ok:boolean, reasonKo?:string}} */
  async applyScene(scene) {
    if (!this.connected) {
      return { ok: false, reasonKo: '장치가 연결되어 있지 않습니다.' };
    }
    for (const k of Object.keys(scene.keys)) {
      if (!LOGICAL_KEYS.includes(k)) {
        return { ok: false, reasonKo: `알 수 없는 논리 키: ${k}` };
      }
    }
    this._inflight += 1;
    this.maxConcurrentWrites = Math.max(this.maxConcurrentWrites, this._inflight);
    await this._delay();
    this._inflight -= 1;
    if (!this.connected) {
      return { ok: false, reasonKo: '쓰기 도중 연결이 끊겼습니다.' };
    }
    this.applied.push(scene);
    return { ok: true };
  }

  /** 검증 전 기능은 추측해서 보내지 않는다. */
  async dialClick() {
    if (!this.capabilities.dialClick) {
      return { ok: false, unsupported: true, reasonKo: '노브 클릭은 실기 검증 전까지 지원하지 않습니다.' };
    }
    return { ok: true };
  }

  /** mini LED write 경로는 존재하지 않는다. */
  get miniLedWriter() {
    return undefined;
  }

  lastScene() {
    return this.applied[this.applied.length - 1] ?? null;
  }

  disconnect() {
    this.connected = false;
  }

  reconnect() {
    this.connected = true;
  }
}
