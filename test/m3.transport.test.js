/**
 * M3-1 / M3-2 — RPC 프레이밍과 요청/응답 계층. 전부 장치 없이 검증한다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  encodeRequest, decodeFrame, JsonStreamAssembler,
  REPORT_ID, CH_RPC, CH_DEBUG, CHUNK, REPORT_SIZE,
} from '../src/device/transport/rpcCodec.js';
import { RpcClient } from '../src/device/transport/rpcClient.js';
import { FakeTransport } from '../src/device/transport/fakeTransport.js';

const frameOf = (channel, text) => {
  const payload = Buffer.from(text, 'utf8');
  const b = Buffer.alloc(REPORT_SIZE);
  b[0] = REPORT_ID; b[1] = channel; b[2] = payload.length;
  payload.copy(b, 3);
  return b;
};

describe('M3 / rpcCodec 프레이밍', () => {
  it('T01 요청은 64바이트 프레임으로 인코딩된다', () => {
    const frames = encodeRequest({ method: 'sys.version', params: null, id: 7 });
    assert.equal(frames.length, 1);
    assert.equal(frames[0].length, REPORT_SIZE);
    assert.equal(frames[0][0], REPORT_ID);
    assert.equal(frames[0][1], CH_RPC);
    const len = frames[0][2];
    assert.deepEqual(JSON.parse(frames[0].slice(3, 3 + len).toString('utf8')),
      { method: 'sys.version', params: null, id: 7 });
  });

  it('T02 61바이트를 넘으면 여러 프레임으로 청킹된다', () => {
    const big = { method: 'v.oai.thstatus', params: Array.from({ length: 13 }, (_, i) => ({ id: i, c: 0xff0000, b: 1, e: 1, s: 0.5, sk: 0, sa: 0 })), id: 1 };
    const frames = encodeRequest(big);
    assert.ok(frames.length > 1, '여러 프레임이어야 한다');
    let text = '';
    for (const f of frames) {
      assert.equal(f.length, REPORT_SIZE);
      assert.ok(f[2] <= CHUNK);
      text += f.slice(3, 3 + f[2]).toString('utf8');
    }
    assert.deepEqual(JSON.parse(text), big);
  });

  it('T03 report ID가 있든 없든 디코딩된다', () => {
    const withId = frameOf(CH_RPC, '{"a":1}');
    assert.deepEqual(decodeFrame(withId), { channel: CH_RPC, text: '{"a":1}' });

    const payload = Buffer.from('{"a":1}', 'utf8');
    const noId = Buffer.alloc(REPORT_SIZE);
    noId[0] = CH_RPC; noId[1] = payload.length; payload.copy(noId, 2);
    assert.deepEqual(decodeFrame(noId), { channel: CH_RPC, text: '{"a":1}' });
  });

  it('T04 알 수 없는 채널은 null', () => {
    const b = Buffer.alloc(REPORT_SIZE);
    b[0] = REPORT_ID; b[1] = 9; b[2] = 1;
    assert.equal(decodeFrame(b), null);
  });

  it('T05 청크 경계에 걸친 JSON이 재조립된다', () => {
    const a = new JsonStreamAssembler();
    assert.deepEqual(a.push('{"id":1,"result":{"fw"'), []);
    assert.deepEqual(a.push(':"1.2.3"}}'), [{ id: 1, result: { fw: '1.2.3' } }]);
    assert.equal(a.buffered, 0);
  });

  it('T06 문자열 안의 중괄호가 경계를 오인시키지 않는다', () => {
    const a = new JsonStreamAssembler();
    const objs = a.push('{"id":1,"result":"a}b{c","x":"\\"}"}');
    assert.deepEqual(objs, [{ id: 1, result: 'a}b{c', x: '"}' }]);
  });

  it('T07 한 번에 여러 객체가 와도 모두 복원된다', () => {
    const a = new JsonStreamAssembler();
    assert.deepEqual(a.push('{"id":1}{"id":2}{"id":3}').map((o) => o.id), [1, 2, 3]);
  });

  it('T08 경계를 못 찾고 쌓이면 버퍼를 버린다', () => {
    const a = new JsonStreamAssembler({ maxBuffer: 64 });
    a.push('x'.repeat(100));
    assert.equal(a.buffered, 0);
    assert.ok(a.droppedBytes > 0);
    assert.deepEqual(a.push('{"id":1}'), [{ id: 1 }], '버린 뒤에도 계속 동작한다');
  });

  it('T23 잘린 메시지는 줄바꿈에서 버리고 다음 메시지부터 다시 읽는다 (블루투스 실기 2026-10-05: 잘린 오류 응답 뒤 노브 알림이 모두 삼켜졌다)', () => {
    const a = new JsonStreamAssembler();
    const cut = '{"error":{"code":400,"message":"JSON error - InvalidInput"},"';
    const objs = a.push(`${cut}{"error":{"code":400},"id":null}\r\n{"m":"v.oai.hid","p":{"k":"ENC_CW","act":2}}\r\n`);
    assert.deepEqual(objs, [{ m: 'v.oai.hid', p: { k: 'ENC_CW', act: 2 } }]);
    assert.equal(a.buffered, 0);
    assert.ok(a.droppedBytes > 0);
    assert.deepEqual(a.push('{"m":"x"}\r\n'), [{ m: 'x' }]);
    // 문자열 안에서 잘려도 (따옴표 짝이 어긋나도) 줄바꿈에서 회복한다
    assert.deepEqual(a.push('{"result":"abc\r\n{"id":2}\r\n'), [{ id: 2 }]);
  });
});

describe('M3 / RpcClient', () => {
  function client(opts = {}) {
    const sent = [];
    const c = new RpcClient({ sendFrame: (f) => sent.push(f), nextId: () => 42, ...opts });
    return { c, sent };
  }

  it('T09 응답이 오면 resolve된다', async () => {
    const { c } = client();
    const p = c.call('sys.version');
    c.handleFrame(frameOf(CH_RPC, JSON.stringify({ id: 42, result: { fw: '1' } })));
    assert.deepEqual(await p, { fw: '1' });
    assert.equal(c.pendingCount, 0);
  });

  it('T10 error 응답은 reject되고 코드가 보존된다', async () => {
    const { c } = client();
    const p = c.call('nope');
    c.handleFrame(frameOf(CH_RPC, JSON.stringify({ id: 42, error: { code: -32601, message: 'unknown' } })));
    await assert.rejects(p, (e) => e.code === -32601 && /unknown/.test(e.message));
  });

  it('T11 타임아웃되면 pending이 정리된다', async () => {
    let fire = null;
    const { c } = client({
      setTimer: (fn) => { fire = fn; return 1; },
      clearTimer: () => {},
    });
    const p = c.call('sys.version', null, 10);
    assert.equal(c.pendingCount, 1);
    fire();
    await assert.rejects(p, /timeout waiting for sys.version/);
    assert.equal(c.pendingCount, 0);
  });

  // ── M6 실기(2026-09-27): 연결 직후 keymap.json(5KB, 80여 프레임) 읽기와 LED thstatus가 겹치면
  //    장치가 두 응답의 프레임을 섞어 보내 긴 응답 안에 짧은 응답이 끼어든다. 요청은 한 번에 하나만 보낸다.
  it('X01 요청은 직렬화된다 — 앞 요청의 응답이 오기 전에는 다음 요청을 보내지 않는다', async () => {
    let n = 0;
    const { c, sent } = client({ nextId: () => { n += 1; return n; } });
    const p1 = c.call('fs.read', { file: 'keymap.json' });
    const p2 = c.call('v.oai.thstatus', [{ id: 0 }]);
    await new Promise((r) => setImmediate(r));
    const texts = () => sent.map((f) => f.slice(3, 3 + f[2]).toString('utf8')).join('');
    assert.ok(texts().includes('"fs.read"'));
    assert.equal(texts().includes('"v.oai.thstatus"'), false, '두 번째 요청은 아직 보내지 않는다');
    c.handleFrame(frameOf(CH_RPC, JSON.stringify({ id: 1, result: { data: '{}' } })));
    assert.deepEqual(await p1, { data: '{}' });
    await new Promise((r) => setImmediate(r));
    assert.ok(texts().includes('"v.oai.thstatus"'), '첫 응답 뒤에 두 번째를 보낸다');
    c.handleFrame(frameOf(CH_RPC, JSON.stringify({ id: 2, result: { ok: 1 } })));
    assert.deepEqual(await p2, { ok: 1 });
    assert.equal(c.pendingCount, 0);
  });

  it('X02 앞 요청이 실패(타임아웃)해도 다음 요청은 나간다', async () => {
    let n = 0; const timers = [];
    const { c, sent } = client({ nextId: () => { n += 1; return n; }, setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {} });
    const p1 = c.call('sys.version', null, 10);
    const p2 = c.call('device.status');
    await new Promise((r) => setImmediate(r));
    assert.equal(timers.length, 1, '대기 중인 요청은 타이머를 걸지 않는다');
    timers[0]();
    await assert.rejects(p1, /timeout/);
    await new Promise((r) => setImmediate(r));
    const texts = sent.map((f) => f.slice(3, 3 + f[2]).toString('utf8')).join('');
    assert.ok(texts.includes('"device.status"'));
    c.handleFrame(frameOf(CH_RPC, JSON.stringify({ id: 2, result: { layer_index: 3 } })));
    assert.deepEqual(await p2, { layer_index: 3 });
  });

  it('X03 failAll은 대기 중인 요청도 거절하고 다음 요청은 정상 진행된다', async () => {
    let n = 0;
    const { c, sent } = client({ nextId: () => { n += 1; return n; } });
    const p1 = c.call('sys.version');
    const p2 = c.call('device.status');
    c.failAll(new Error('transport closed'));
    await assert.rejects(p1, /transport closed/);
    await assert.rejects(p2, /transport closed/);
    const before = sent.length;
    const p3 = c.call('sys.version');
    assert.ok(sent.length > before, '새 요청은 바로 나간다');
    c.handleFrame(frameOf(CH_RPC, JSON.stringify({ id: n, result: { version: 'x' } })));   // 대기 중이던 요청은 id를 받지 않았다
    assert.deepEqual(await p3, { version: 'x' });
  });

  it('T12 id 없는 객체는 버려지지 않고 notification으로 간다', () => {
    const { c } = client();
    const seen = [];
    c.onNotification((o) => seen.push(o));
    c.handleFrame(frameOf(CH_RPC, JSON.stringify({ ev: 'key', ag: 3, state: 'down' })));
    assert.deepEqual(seen, [{ ev: 'key', ag: 3, state: 'down' }]);
  });

  it('T13 notification 구독자 오류가 전파되지 않는다', () => {
    const { c } = client();
    const seen = [];
    c.onNotification(() => { throw new Error('boom'); });
    c.onNotification((o) => seen.push(o));
    assert.doesNotThrow(() => c.handleFrame(frameOf(CH_RPC, '{"ev":"key"}')));
    assert.equal(seen.length, 1);
  });

  it('T14 debug 채널은 RPC 스트림을 깨지 않는다', async () => {
    const { c } = client();
    const p = c.call('sys.version');
    c.handleFrame(frameOf(CH_DEBUG, 'some debug text {'));
    c.handleFrame(frameOf(CH_RPC, JSON.stringify({ id: 42, result: 'ok' })));
    assert.equal(await p, 'ok');
    assert.deepEqual(c.debugLines, ['some debug text {']);
  });

  it('T15 다른 클라이언트의 응답(모르는 id)은 무시된다', async () => {
    const { c } = client();
    const p = c.call('sys.version');
    c.handleFrame(frameOf(CH_RPC, JSON.stringify({ id: 999, result: 'not mine' })));
    assert.equal(c.pendingCount, 1);
    c.handleFrame(frameOf(CH_RPC, JSON.stringify({ id: 42, result: 'mine' })));
    assert.equal(await p, 'mine');
  });

  it('T16 차단된 method는 프레임조차 나가지 않는다', async () => {
    const { c, sent } = client({ blockedMethods: ['fs.write'] });
    await assert.rejects(c.call('fs.write', {}), /금지/);
    assert.equal(sent.length, 0);
  });

  it('T17 allowlist 밖의 method는 거절된다', async () => {
    const { c, sent } = client({ allowedMethods: ['sys.version'] });
    await assert.rejects(c.call('v.oai.thstatus', []), /허용되지 않은/);
    assert.equal(sent.length, 0);
  });

  it('T18 연결이 끊기면 대기 요청이 모두 실패한다', async () => {
    const { c } = client();
    const p = c.call('sys.version');
    c.failAll(new Error('cable removed'));
    await assert.rejects(p, /cable removed/);
    assert.equal(c.pendingCount, 0);
  });
});

describe('M3 / FakeTransport', () => {
  it('T19 실제 프레이밍을 통과해 응답한다', async () => {
    const t = new FakeTransport({ responses: { 'sys.version': { fw: 'x' } } });
    assert.deepEqual(await t.call('sys.version'), { fw: 'x' });
    assert.ok(t.sentFrames.length >= 1);
    assert.equal(t.sentFrames[0].length, REPORT_SIZE);
  });

  it('T20 긴 응답도 청크로 나뉘어 재조립된다', async () => {
    const big = { data: 'y'.repeat(500) };
    const t = new FakeTransport({ responses: { 'fs.read': big } });
    assert.deepEqual(await t.call('fs.read', { file: 'keymap.json' }), big);
  });

  it('T21 알림을 흘려보낼 수 있다', () => {
    const t = new FakeTransport();
    const seen = [];
    t.onNotification((o) => seen.push(o));
    t.emitNotification({ ev: 'key', ag: 1, state: 'up' });
    assert.deepEqual(seen, [{ ev: 'key', ag: 1, state: 'up' }]);
  });

  it('T22 차단 method는 fake에서도 막힌다', async () => {
    const t = new FakeTransport({ blockedMethods: ['fs.write'] });
    await assert.rejects(t.call('fs.write', {}), /금지/);
    assert.equal(t.sentFrames.length, 0);
  });
});
