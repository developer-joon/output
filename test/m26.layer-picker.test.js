/**
 * M26 — 노브 길게 눌러 레이어 고르기 (2026-10-10 사용자 요청).
 * 길게(0.5초) → 목록(자동 + 레이어들) 화면 표시 → 노브로 옮기고 → 누르면 고름. 5초 입력이 없거나 다른 키를 누르면 취소.
 * 고른 레이어는 지금 앞 앱이 그대로인 동안만 — 앞 앱이 바뀌거나 '자동'을 고르면 앞 앱 따라.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sc = (keystroke) => ({ type: 'shortcut', label: '', keystroke });

async function svc() {
  const { OutputService } = await import('../src/service/outputService.js');
  const { UNCALIBRATED } = await import('../src/device/calibrationLoader.js');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-m26-'));
  fs.writeFileSync(path.join(stateDir, 'profiles.json'), JSON.stringify({ version: 6, layers: [
    { id: 'default', kind: 'default', name: '기본', color: '#5A8CDC', preset: null, apps: [], keys: { key1: sc('cmd+k') }, dial: { cw: sc('cmd+]') }, joystick: {} },
    { id: 'l-c', kind: 'user', name: '크롬', color: '#E8762B', preset: null, apps: [{ bundleId: 'com.google.Chrome', name: 'Chrome' }], keys: { key1: sc('cmd+t') }, dial: {}, joystick: {} },
    { id: 'l-m', kind: 'user', name: '미디어', color: '#3E9B5A', preset: 'media', apps: [], keys: {}, dial: {}, joystick: {} },
  ] }));
  const st = { now: 1000, front: 'com.google.Chrome' };
  const pending = [];
  const s = new OutputService({ calibration: UNCALIBRATED, stateDir, orcaEnabled: false, now: () => st.now,
    timers: { setInterval: () => 0, clearInterval: () => {}, setTimeout: (fn, ms) => { pending.push({ fn, ms }); return pending.length; }, clearTimeout: () => {} },
    openRuntimeTransport: async () => { throw Object.assign(new Error('x'), { code: 'DEVICE_NOT_FOUND' }); }, frontmost: async () => st.front, ownBundleIds: [] });
  await s.watcher.tick();
  const huds = []; s.on('hud', (h) => huds.push(h));
  const ran = []; s.runner.run = async (id) => { ran.push(id); return { ok: true, reasonKo: '' }; };
  return { s, st, huds, ran, pending };
}
const hold = { type: 'hold', key: 'dial_click' };
const tap = { type: 'tap', key: 'dial_click' };
const cw = { type: 'dial', direction: 'cw' };

describe('M26 / 노브로 레이어 고르기', () => {
  it('K01 노브 길게: 목록(자동 + 레이어들)을 띄우고 지금 레이어에 표시', async () => {
    const { s, huds } = await svc();
    await s._onIntent(hold);
    const h = huds.at(-1);
    assert.equal(h.kind, 'picker');
    assert.deepEqual(h.items.map((i) => i.name), ['자동 (앞 앱 따라)', '기본', '크롬', '미디어']);
    assert.equal(h.items[h.index].name, '크롬');
  });
  it('K02 열려 있는 동안 노브 돌림은 표시만 옮긴다 — 노브 동작은 실행하지 않는다 (끝에서 처음으로)', async () => {
    const { s, huds, ran } = await svc();
    await s._onIntent(hold);
    await s._onIntent(cw);
    assert.equal(huds.at(-1).items[huds.at(-1).index].name, '미디어');
    await s._onIntent(cw);
    assert.equal(huds.at(-1).index, 0, '끝에서 처음(자동)으로');
    assert.deepEqual(ran, []);
  });
  it('K03 누르면 고른 레이어로 — 같은 앞 앱인 동안 유지, 상태판에 (직접 고름)', async () => {
    const { s, ran } = await svc();
    await s._onIntent(hold); await s._onIntent(cw); await s._onIntent(tap);
    assert.equal(s._layer.id, 'l-m');
    assert.match(s.view().layerLine.nowKo, /직접 고름/);
    assert.deepEqual(ran, [], '고르는 누름은 노브 누름 동작이 아니다');
    await s.watcher.tick();
    assert.equal(s._layer.id, 'l-m', '앞 앱이 그대로면 유지');
  });
  it('K04 앞 앱이 바뀌면 다시 앞 앱 따라 (고정 풀림)', async () => {
    const { s, st } = await svc();
    await s._onIntent(hold); await s._onIntent(cw); await s._onIntent(tap);
    st.front = 'com.apple.TextEdit';
    await s.watcher.tick();
    assert.equal(s._layer.id, 'default');
    st.front = 'com.google.Chrome';
    await s.watcher.tick();
    assert.equal(s._layer.id, 'l-c');
  });
  it('K05 "자동"을 고르면 앞 앱 따라', async () => {
    const { s } = await svc();
    await s._onIntent(hold); await s._onIntent(cw); await s._onIntent(tap);
    await s._onIntent(hold); await s._onIntent(cw); await s._onIntent(tap);   // 미디어 → 자동
    assert.equal(s._layer.id, 'l-c');
    assert.doesNotMatch(s.view().layerLine.nowKo, /직접 고름/);
  });
  it('K06 다른 키를 누르면 취소하고 그 키는 평소대로, 5초 입력이 없으면 취소 (표시 닫힘)', async () => {
    const { s, huds, ran, pending } = await svc();
    await s._onIntent(hold);
    await s._onIntent({ type: 'tap', key: 'slot1' });
    assert.equal(s._picker, null);
    assert.deepEqual(ran, ['key1']);
    assert.equal(huds.at(-1).kind, 'picker');
    assert.equal(huds.at(-1).end, true);
    await s._onIntent(hold);
    pending.filter((p) => p.ms === 5000).at(-1).fn();
    assert.equal(s._picker, null);
    assert.equal(s._layer.id, 'l-c');
  });
});

describe('M26 / LED 명령 대기 (실기 2026-10-11: 블루투스에서 응답 하나가 빠지면 다음 LED가 5초 늦었다)', () => {
  it('K07 LED 명령은 1.2초만 기다린다 (다른 명령은 그대로 5초)', async () => {
    const { s } = await svc();
    const calls = [];
    s.transport = { call: async (m, p, ms) => { calls.push([m, ms]); return { ok: 1 }; } };
    await s._send([{ id: 0, c: 0 }]);
    assert.deepEqual(calls, [['v.oai.thstatus', 1200]]);
  });
  it('K08 LED 응답이 없으면 로그에 남긴다 (30초에 한 번까지) — 다음 그리기는 막히지 않는다', async () => {
    const { s, st } = await svc();
    s.transport = { call: async () => { throw new Error('timeout waiting for v.oai.thstatus'); } };
    const logs = []; s.on('log', (e) => logs.push(e.messageKo));
    await s._send([]).catch(() => {});
    await s._send([]).catch(() => {});
    st.now += 31000;
    await s._send([]).catch(() => {});
    assert.equal(logs.filter((m) => /LED 응답이 없어/.test(m)).length, 2);
  });
});

describe('M26 / 상태판에서 레이어 고르기 (2026-10-11)', () => {
  it('K09 pickLayer(id): 노브로 고른 것과 같다 — 같은 앞 앱인 동안 유지, null이면 자동, 모르는 id는 거절', async () => {
    const { s } = await svc();
    assert.deepEqual(s.pickLayer('l-m'), { ok: true });
    assert.equal(s._layer.id, 'l-m');
    assert.match(s.view().layerLine.nowKo, /고름/);
    assert.equal(s.view().layerLine.pinned, true);
    assert.equal(s.pickLayer('nope').ok, false);
    assert.equal(s._layer.id, 'l-m');
    s.pickLayer(null);
    assert.equal(s._layer.id, 'l-c');
    assert.equal(s.view().layerLine.pinned, false);
  });
});

import { DeviceDriver } from '../src/device/deviceDriver.js';

describe('M26 / 같은 LED 명령은 다시 보내지 않는다 (실기 2026-10-11: Orca 모드에서 같은 명령이 2초마다 나가 블루투스가 밀렸다)', () => {
  const CAL = JSON.parse(fs.readFileSync(new URL('../config/calibration.json', import.meta.url), 'utf8'));
  const scene = (color) => ({ revision: 1, keys: { slot1: { color, brightness: 1, pattern: 'solid' } }, ambientZone: null });
  it('K10 직전에 보낸 것과 같으면 건너뛰고, 다르면 보낸다 — 실패했거나 다시 연결되면(invalidate) 같아도 보낸다', async () => {
    let fail = false; const sent = [];
    const d = new DeviceDriver({ calibration: CAL, send: async (p) => { if (fail) throw new Error('timeout'); sent.push(p); } });
    assert.equal((await d.applyScene(scene('red'))).ok, true);
    assert.equal((await d.applyScene(scene('red'))).skipped, true);
    assert.equal(sent.length, 1);
    await d.applyScene(scene('blue'));
    assert.equal(sent.length, 2);
    fail = true;
    assert.equal((await d.applyScene(scene('red'))).ok, false);
    fail = false;
    await d.applyScene(scene('red'));
    assert.equal(sent.length, 3, '실패 뒤에는 같은 것도 다시');
    d.invalidate();
    await d.applyScene(scene('red'));
    assert.equal(sent.length, 4, '다시 연결되면 같은 것도 다시');
  });
});

import { RenderScheduler } from '../src/device/renderScheduler.js';
import { EventBus } from '../src/core/eventBus.js';
import { StateStore } from '../src/core/stateStore.js';
import { Output } from '../src/output.js';
import { MockFocusRouter } from '../src/core/focusRouter.js';

describe('M26 / LED 쓰기 실패 뒤 다시 보내기 (실기 2026-10-11: 노브로 고른 직후 블루투스 쓰기가 실패하면 그대로 남았다)', () => {
  it('K11 실패하면 0.2초 → 0.4초 … (최대 2초) 뒤 다시 그려 보내고, 성공하면 멈춘다', async () => {
    const bus = new EventBus();
    const bridge = new Output({ store: new StateStore({ bus }), focusRouter: new MockFocusRouter(), actions: [] });
    let fails = 2; const sent = []; const timers = [];
    const device = { capabilities: {}, applyScene: async (scene) => { if (fails > 0) { fails -= 1; return { ok: false, retryable: true, reasonKo: 'x' }; } sent.push(scene.revision); return { ok: true }; } };
    const s = new RenderScheduler({ bridge, device, bus, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; } });
    s.start();
    await s.idle();
    assert.deepEqual(timers.map((t) => t.ms), [200]);
    timers.shift().fn(); await s.idle();
    assert.deepEqual(timers.map((t) => t.ms), [400]);
    timers.shift().fn(); await s.idle();
    assert.equal(sent.length, 1);
    assert.equal(s.inSync, true);
    assert.deepEqual(timers, [], '성공하면 더 걸지 않는다');
    s.stop();
  });
});
