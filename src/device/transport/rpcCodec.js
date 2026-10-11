/**
 * Creator Micro 2 vendor HID의 RPC 프레이밍 — 순수 로직.
 *
 * cm2_ag00_setup/common.mjs에서 이식했다 (ADR-002).
 * 장치 없이 단위 테스트할 수 있도록 node-hid 의존을 두지 않는다.
 *
 * 프레임: [reportId][channel][len][payload …]  (64바이트 고정, payload 최대 61)
 */

export const VID = 0x303a;
export const PIDS = Object.freeze([0x8297, 0x8298]);
export const USAGE_PAGE = 0xff00;
export const USAGE = 1;
export const REPORT_ID = 0x06;
export const CH_RPC = 2;
export const CH_DEBUG = 1;
export const CHUNK = 61;
export const REPORT_SIZE = 64;

/**
 * 요청 하나를 64바이트 프레임 배열로 만든다.
 * @returns {Buffer[]}
 */
export function encodeRequest({ method, params = null, id }) {
  const payload = Buffer.from(JSON.stringify({ method, params, id }), 'utf8');
  const frames = [];
  for (let off = 0; off < payload.length; off += CHUNK) {
    const n = Math.min(CHUNK, payload.length - off);
    const report = Buffer.alloc(REPORT_SIZE);
    report[0] = REPORT_ID;
    report[1] = CH_RPC;
    report[2] = n;
    payload.copy(report, 3, off, off + n);
    frames.push(report);
  }
  // 빈 payload는 있을 수 없지만, 방어적으로 최소 한 프레임을 보장한다.
  if (!frames.length) {
    const report = Buffer.alloc(REPORT_SIZE);
    report[0] = REPORT_ID;
    report[1] = CH_RPC;
    frames.push(report);
  }
  return frames;
}

/**
 * 수신 프레임에서 채널과 텍스트를 뽑는다.
 *
 * node-hid는 report ID를 byte 0에 넣어 줄 수도, 빼고 줄 수도 있다.
 * 원본과 같은 순서(offset 1 먼저, 그다음 0)로 시도한다.
 *
 * @returns {{channel:number, text:string}|null}
 */
export function decodeFrame(raw) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  for (const off of [1, 0]) {
    const channel = buf[off];
    const len = buf[off + 1];
    if (channel !== CH_RPC && channel !== CH_DEBUG) continue;
    if (len === undefined || len > CHUNK) continue;
    if (off + 2 + len > buf.length) continue;
    return { channel, text: buf.slice(off + 2, off + 2 + len).toString('utf8') };
  }
  return null;
}

/**
 * 청크로 쪼개져 오는 JSON 스트림을 객체 단위로 복원한다.
 * 중괄호 깊이로 경계를 찾되 문자열 안의 괄호는 세지 않는다.
 */
export class JsonStreamAssembler {
  constructor({ maxBuffer = 16384 } = {}) {
    this.maxBuffer = maxBuffer;
    this._accum = '';
    this.droppedBytes = 0;
  }

  /** @returns {object[]} 이번 입력으로 완성된 객체들 */
  push(text) {
    this._accum += text;
    const out = [];
    let depth = 0;
    let start = -1;
    let inStr = false;
    let esc = false;

    for (let i = 0; i < this._accum.length; i += 1) {
      const c = this._accum[i];
      // 장치는 메시지마다 끝에 \r\n을 붙인다. JSON 안에는 날것의 줄바꿈이 없으므로 여기까지 못 끝낸 조각은 깨진 것이다.
      // 버리고 다음 메시지부터 다시 읽는다 (블루투스 실기 2026-10-05: 잘린 응답 하나에 그 뒤 알림이 모두 삼켜졌다)
      if (c === '\n') {
        if (depth > 0 || inStr) this.droppedBytes += i + 1;
        this._accum = this._accum.slice(i + 1);
        i = -1;
        depth = 0;
        start = -1;
        inStr = false;
        esc = false;
        continue;
      }
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') {
        inStr = true;
      } else if (c === '{') {
        if (depth === 0) start = i;
        depth += 1;
      } else if (c === '}' && depth > 0) {
        depth -= 1;
        if (depth === 0) {
          try {
            out.push(JSON.parse(this._accum.slice(start, i + 1)));
            this._accum = this._accum.slice(i + 1);
            i = -1;
            start = -1;
          } catch {
            // 아직 완성되지 않았거나 깨진 조각. 다음 입력을 기다린다.
          }
        }
      }
    }

    // 경계를 못 찾고 무한히 쌓이면 버린다. 업무 상태가 아니라 전송 버퍼다.
    if (this._accum.length > this.maxBuffer) {
      this.droppedBytes += this._accum.length;
      this._accum = '';
    }
    return out;
  }

  get buffered() {
    return this._accum.length;
  }

  reset() {
    this._accum = '';
  }
}
