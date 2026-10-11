import { RpcClient } from './rpcClient.js';
import { decodeFrame, REPORT_ID, CH_RPC, CHUNK, REPORT_SIZE } from './rpcCodec.js';

/**
 * 장치 없이 doctor/calibrate를 돌리기 위한 가짜 transport.
 * 실제 프레이밍을 그대로 통과시키므로 codec 경로까지 함께 검증된다.
 */
export class FakeTransport {
  /**
   * @param {{responses?:Record<string,any|Function>, info?:object}} opts
   */
  constructor({ responses = {}, info = null, blockedMethods = [], allowedMethods = null } = {}) {
    this.responses = responses;
    this.info = info ?? {
      product: 'Creator Micro 2 (fake)', vendorId: 0x303a, productId: 0x8297,
    };
    this.sentFrames = [];
    this.closed = false;
    this.exclusive = true;

    this.client = new RpcClient({ sendFrame: (f) => this._onFrame(f), blockedMethods, allowedMethods });
    this._inbound = '';
  }

  get calledMethods() {
    return this.client.calledMethods;
  }

  _onFrame(frame) {
    this.sentFrames.push(Buffer.from(frame));
    const d = decodeFrame(frame);
    if (!d || d.channel !== CH_RPC) return;
    this._inbound += d.text;
    let req;
    try {
      req = JSON.parse(this._inbound);
    } catch {
      return;   // 아직 청크가 남았다
    }
    this._inbound = '';
    queueMicrotask(() => this._respond(req));
  }

  _respond(req) {
    const entry = this.responses[req.method];
    if (entry === undefined) {
      this._emitObject({ id: req.id, error: { code: -32601, message: `unknown method: ${req.method}` } });
      return;
    }
    const value = typeof entry === 'function' ? entry(req.params, req) : entry;
    if (value && value.__error) {
      this._emitObject({ id: req.id, error: value.__error });
      return;
    }
    this._emitObject({ id: req.id, result: value });
  }

  /** 장치가 보내는 것처럼 객체 하나를 프레임으로 쪼개 올려보낸다. */
  _emitObject(obj) {
    const payload = Buffer.from(JSON.stringify(obj), 'utf8');
    for (let off = 0; off < payload.length; off += CHUNK) {
      const n = Math.min(CHUNK, payload.length - off);
      const report = Buffer.alloc(REPORT_SIZE);
      report[0] = REPORT_ID;
      report[1] = CH_RPC;
      report[2] = n;
      payload.copy(report, 3, off, off + n);
      this.client.handleFrame(report);
    }
  }

  /** 테스트에서 키 이벤트 같은 알림을 흉내 낼 때 쓴다. */
  emitNotification(obj) {
    this._emitObject(obj);
  }

  canCall(method) {
    return this.client.canCall(method);
  }

  call(method, params, timeoutMs) {
    if (this.closed) return Promise.reject(new Error('transport closed'));
    return this.client.call(method, params, timeoutMs);
  }

  onNotification(handler) {
    return this.client.onNotification(handler);
  }

  close() {
    this.closed = true;
    this.client.failAll(new Error('transport closed'));
  }
}
