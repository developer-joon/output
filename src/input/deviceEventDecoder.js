/**
 * 장치 알림 → InputDecoder 호출.
 *
 * 실기 8·9차에서 확인한 프로토콜만 처리한다. 추측하지 않는다.
 *   키   {"m":"v.oai.hid","p":{"k":"AG00","act":1|0}}
 *   회전 {"m":"v.oai.hid","p":{"k":"ENC_CC","act":2}}
 *   클릭 {"m":"v.oai.hid","p":{"k":"ENC_CLK","act":1|0}}
 *   스틱 {"m":"v.oai.rad","p":{"a":0.748,"d":0.564}}
 *
 * 키코드 → 논리 역할 대응은 calibration이 준다. 코드 이름을 해석하지 않는다.
 */
export const HID_EVENT = 'v.oai.hid';
export const RAD_EVENT = 'v.oai.rad';
export const ACT = Object.freeze({ RELEASE: 0, PRESS: 1, ROTATE: 2 });

export class DeviceEventDecoder {
  /**
   * @param {object} opts
   * @param {import('./inputDecoder.js').InputDecoder} opts.decoder
   * @param {object} opts.calibration
   */
  constructor({ decoder, calibration }) {
    this.decoder = decoder;
    this.calibration = calibration;
    this.unknown = [];   // 해석하지 못한 알림. 버리지 않고 모은다.
  }

  /** 'AG00' → 'slot1' */
  logicalOf(keycode) {
    const map = this.calibration?.eventKeyToLogical ?? {};
    if (map[keycode]) return map[keycode];
    const full = /^KV_OAI_/.test(keycode) ? keycode : `KV_OAI_${keycode}`;
    for (const [logical, code] of Object.entries(this.calibration?.logicalToKeycode ?? {})) {
      if (code === full) return logical;
    }
    return null;
  }

  /** @returns {object|null} 만들어진 의도 */
  handle(event) {
    const m = event?.m;
    const p = event?.p ?? {};

    if (m === RAD_EVENT) {
      if (typeof p.a !== 'number' || typeof p.d !== 'number') {
        this.unknown.push(event);
        return null;
      }
      return this.decoder.joystickPolar({ angle: p.a, distance: p.d });
    }

    if (m === HID_EVENT) {
      const logical = this.logicalOf(p.k);
      if (!logical) {
        this.unknown.push(event);
        return null;
      }
      if (p.act === ACT.ROTATE) {
        if (logical === 'dial_cw') return this.decoder.dial(+1);
        if (logical === 'dial_ccw') return this.decoder.dial(-1);
        this.unknown.push(event);
        return null;
      }
      if (p.act === ACT.PRESS) return this.decoder.press(logical);
      if (p.act === ACT.RELEASE) return this.decoder.release(logical);
    }

    this.unknown.push(event);
    return null;
  }

  /** 연결 끊김 전달 */
  disconnected() {
    return this.decoder.disconnected();
  }
}
