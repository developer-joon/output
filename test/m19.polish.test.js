/**
 * M19 — 고도화 (2026-10-10 사용자 요청 '전부 진행하자'): 배터리·연결 방식, 다른 앱 경고, 블루투스 재시도,
 * 저장 안 한 변경, 지금 실행해 보기, 레이어 제안, 내보내기·가져오기, 블루투스 LED 줄이기.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildStatusView } from '../src/service/uiModel.js';
import { Output } from '../src/output.js';
import { StateStore } from '../src/core/stateStore.js';
import { openHidTransport } from '../src/device/transport/hidTransport.js';

const snap = () => new Output({ store: new StateStore() }).render();
const health = (device) => ({ device: { state: 'connected', ...device }, orca: { state: 'connected' }, mock: false, permissions: { accessibility: true } });

describe('M19 / 배터리·연결 방식', () => {
  it('P01 장치 칩: 연결 방식과 배터리, 충전 중이면 표시', () => {
    assert.equal(buildStatusView({ snapshot: snap(), health: health({ connection: 'bluetooth', battery: 93, charging: false }) }).health.device.labelKo, '장치 ✓ · 블루투스 93%');
    assert.equal(buildStatusView({ snapshot: snap(), health: health({ connection: 'usb', battery: 80, charging: true }) }).health.device.labelKo, '장치 ✓ · USB 80% 충전 중');
    assert.equal(buildStatusView({ snapshot: snap(), health: health({}) }).health.device.labelKo, '장치 ✓', '모르면 예전 그대로');
  });
  it('P02 배터리 15% 이하이고 충전 중이 아니면 경고, 충전 중이면 경고 없음', () => {
    const low = buildStatusView({ snapshot: snap(), health: health({ connection: 'bluetooth', battery: 12, charging: false }) });
    assert.ok(low.warnings.some((w) => w.code === 'battery-low' && /12%/.test(w.messageKo)));
    const charging = buildStatusView({ snapshot: snap(), health: health({ connection: 'usb', battery: 12, charging: true }) });
    assert.equal(charging.warnings.some((w) => w.code === 'battery-low'), false);
  });
  it('P03 transport가 연결 방식을 알려 준다 (블루투스는 interface -1)', () => {
    const fake = (iface) => ({
      devices: () => [{ vendorId: 0x303a, productId: 0x8298, usagePage: 0xff00, usage: 1, path: 'p', interface: iface }],
      HID: class { constructor() {} on() {} write() {} close() {} },
    });
    assert.equal(openHidTransport({ HID: fake(-1) }).connection, 'bluetooth');
    assert.equal(openHidTransport({ HID: fake(2) }).connection, 'usb');
  });
});

import { RpcClient } from '../src/device/transport/rpcClient.js';
import { REPORT_ID, CH_RPC, REPORT_SIZE } from '../src/device/transport/rpcCodec.js';
import { parseDeviceUsers } from '../src/service/macos.js';

async function svc(opts = {}) {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { OutputService } = await import('../src/service/outputService.js');
  const { UNCALIBRATED } = await import('../src/device/calibrationLoader.js');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-m19-'));
  const st = { now: 1000 };
  const s = new OutputService({ calibration: UNCALIBRATED, stateDir, orcaEnabled: false, now: () => st.now,
    openRuntimeTransport: async () => { const e = new Error('x'); e.code = 'DEVICE_NOT_FOUND'; throw e; },
    frontmost: async () => 'com.stablyai.orca', ownBundleIds: [], ...opts });
  return { s, st };
}

describe('M19 / 다른 앱이 장치를 함께 씀', () => {
  const frameOf = (text) => {
    const b = Buffer.alloc(REPORT_SIZE); const p = Buffer.from(text);
    b[0] = REPORT_ID; b[1] = CH_RPC; b[2] = p.length; p.copy(b, 3); return b;
  };
  it('O01 RpcClient: 내 요청이 아닌 응답을 다른 앱의 것으로 알린다', () => {
    const c = new RpcClient({ sendFrame: () => {} });
    const seen = []; c.onForeignResponse((m) => seen.push(m));
    c.handleFrame(frameOf('{"result":{"ok":1},"id":539,"method":"v.oai.thstatus"}\r\n'));
    assert.deepEqual(seen, ['v.oai.thstatus']);
  });
  it('O02 ioreg 트리에서 Creator Micro를 연 프로세스 이름 (WindowServer·나는 뺀다, 중복 없음, 다른 HID 장치의 사용자는 안 셈)', () => {
    // 실제 모양 (2026-10-10 실측): 장치 노드 아래 IOHIDInterface(Product)와 IOHIDLibUserClient(Creator)가 형제
    const text = [
      '+-o AppleUserUSBHostHIDDevice  <class AppleUserHIDDevice, id 0x1>',
      '  {',
      '    "Product" = "Creator Micro 2"',
      '  }',
      '  +-o IOHIDInterface  <class IOHIDInterface, id 0x2>',
      '  |   {',
      '  |     "Product" = "Creator Micro 2"',
      '  |   }',
      '  +-o IOHIDLibUserClient  <class IOHIDLibUserClient, id 0x3>',
      '      {',
      '        "IOUserClientCreator" = "pid 70557, Output"',
      '      }',
      '  +-o IOHIDLibUserClient  <class IOHIDLibUserClient, id 0x4>',
      '      {',
      '        "IOUserClientCreator" = "pid 66753, ChatGPT"',
      '      }',
      '  +-o IOHIDLibUserClient  <class IOHIDLibUserClient, id 0x5>',
      '      {',
      '        "IOUserClientCreator" = "pid 609, WindowServer"',
      '      }',
      '  +-o IOHIDLibUserClient  <class IOHIDLibUserClient, id 0x6>',
      '        "IOUserClientCreator" = "pid 66753, ChatGPT"',
      '+-o AppleSPUHIDDevice  <class AppleSPUHIDDevice, id 0x9>',
      '  {',
      '    "Product" = "Keyboard"',
      '  }',
      '  +-o IOHIDEventServiceUserClient  <class IOHIDEventServiceUserClient, id 0xa>',
      '        "IOUserClientCreator" = "pid 584, locationd"',
    ].join('\n');
    assert.deepEqual(parseDeviceUsers(text, 70557), ['ChatGPT']);
    assert.deepEqual(parseDeviceUsers(text, 1), ['Output', 'ChatGPT']);
  });
  it('O04 ioreg 출력이 1MB를 넘어도 읽는다 (실측 1.1MB — 기본 한도에 잘려 이름을 못 찾았다)', async () => {
    const { deviceUsers } = await import('../src/service/macos.js');
    let opts = null;
    await deviceUsers(1, async (cmd, args, timeout, o) => { opts = o; return { code: 0, stdout: '', stderr: '' }; });
    assert.ok(opts?.maxBuffer >= 16 * 1024 * 1024);
  });
  it('O03 다른 앱의 응답이 오면 이름을 찾아 상태판에 알린다 (2분에 한 번만 찾음), 5분 조용하면 사라진다', async () => {
    let asked = 0;
    const { s, st } = await svc({ deviceUsers: async () => { asked += 1; return ['ChatGPT']; } });
    await s._onForeign('v.oai.thstatus');
    await s._onForeign('device.status');
    assert.equal(asked, 1);
    const w = s.view().warnings.find((x) => x.code === 'device-shared');
    assert.ok(w); assert.match(w.messageKo, /ChatGPT/);
    st.now += 5 * 60 * 1000 + 1;
    assert.equal(s.view().warnings.some((x) => x.code === 'device-shared'), false);
  });
});

describe('M19 / 블루투스 쓰기 재시도', () => {
  const rig = (failPlan) => {
    const writes = []; let n = 0;
    const HID = {
      devices: () => [{ vendorId: 0x303a, productId: 0x8298, usagePage: 0xff00, usage: 1, path: 'p', interface: -1 }],
      HID: class { constructor() {} on() {} close() {}
        write(f) { n += 1; if (failPlan.includes(n)) throw new Error('IOHIDDeviceSetReport failed: general error'); writes.push(f); } },
    };
    return { t: openHidTransport({ HID }), writes };
  };
  it('R01 프레임 하나가 한 번 실패하면 잠깐 뒤 그 프레임을 다시 보내고 이어 간다 (첫 프레임·중간 프레임 모두)', async () => {
    for (const plan of [[1], [3]]) {
      const { t, writes } = rig(plan);
      const p = t.call('device.status', { pad: 'x'.repeat(200) }, 300).catch((e) => e);
      await new Promise((r) => { setTimeout(r, 200); });
      assert.equal(writes.length, 5, `실패 ${plan}: 다섯 프레임 모두 나간다`);
      const r = await p;
      assert.match(String(r?.message ?? r), /timeout/, '보내기는 됐고 (응답이 없어) 시간 초과로 끝난다 — 쓰기 실패가 아니다');
      t.close();
    }
  });
  it('R02 같은 프레임이 두 번 실패하면 그 요청은 실패로 끝난다', async () => {
    const { t } = rig([2, 3]);
    const r = await t.call('device.status', { pad: 'x'.repeat(200) }, 1000).catch((e) => e);
    assert.match(String(r?.message ?? r), /IOHIDDeviceSetReport/);
    t.close();
  });
});

import { ActionRunner } from '../src/apps/actionRunner.js';

describe('M19 / 지금 실행해 보기', () => {
  const runner = (front) => {
    const calls = [];
    const r = new ActionRunner({ exec: { synth: async (k) => { calls.push(['synth', k.key]); }, openApp: async (b) => { calls.push(['open', b]); return { code: 0 }; } },
      frontmost: async () => front.v, displays: () => [], ownBundleIds: ['dev.output.keypad'], sleep: async () => {} });
    return { r, calls };
  };
  it('T01 설정 화면에서: 앱 열기는 바로, 단축키는 앞 앱이 Output이 아니면 보낸다(어느 앱이든)', async () => {
    const front = { v: 'com.apple.TextEdit' };
    const { r, calls } = runner(front);
    assert.equal((await r.run('-', { type: 'openApp', label: '', bundleId: 'com.apple.Safari' }, { kind: 'any' }, { manual: true })).ok, true);
    assert.equal((await r.run('-', { type: 'shortcut', label: '', keystroke: 'cmd+k' }, { kind: 'any' }, { manual: true })).ok, true);
    assert.deepEqual(calls, [['open', 'com.apple.Safari'], ['synth', 'k']]);
    front.v = 'dev.output.keypad';
    const own = await r.run('-', { type: 'shortcut', label: '', keystroke: 'cmd+k' }, { kind: 'any' }, { manual: true });
    assert.equal(own.ok, false, 'Output 자기 창에는 보내지 않는다');
    assert.equal(calls.length, 2);
  });
  it('T02 서비스: 키 입력·앞 창 위치는 3초 기다린 뒤, 앱 열기는 바로', async () => {
    const waits = [];
    const { s } = await svc({ appExec: { synth: async () => {}, openApp: async () => ({ code: 0 }), openUrl: async () => ({ code: 0 }), execCommand: async () => ({ code: 0 }), readClipboard: async () => '', writeClipboard: async () => ({ code: 0 }), moveWindow: async () => ({ ok: true }), hasWindow: async () => true },
      frontmost: async () => 'com.apple.TextEdit' });
    s.runner.sleep = async (ms) => { waits.push(ms); };
    await s.actionTry({ type: 'shortcut', label: '', keystroke: 'cmd+k' });
    await s.actionTry({ type: 'openApp', label: '', bundleId: 'com.apple.Safari', appName: 'Safari' });
    assert.deepEqual(waits, [3000]);
  });
});

describe('M19 / 레이어 없는 앱에 레이어 제안', () => {
  it('L01 앞 앱이 기본 레이어(또는 대기)면 그 앱 이름으로 제안, Orca·이미 레이어가 있는 앱이면 제안 없음', async () => {
    const { s } = await svc({ frontmost: async () => 'com.google.Chrome', appName: async (b) => (b === 'com.google.Chrome' ? 'Google Chrome' : null) });
    await s.watcher.tick(); await new Promise((r) => { setTimeout(r, 5); });
    assert.deepEqual(s.view().suggestLayer, { bundleId: 'com.google.Chrome', name: 'Google Chrome' });
    const { s: o } = await svc({ frontmost: async () => 'com.stablyai.orca' });
    await o.watcher.tick();
    assert.equal(o.view().suggestLayer, null);
  });
  it('L02 만들기: 그 앱이 연결된 새 레이어(무작위 색), 이미 있으면 그 레이어 — 바로 앱 레이어로 동작', async () => {
    const { s } = await svc({ frontmost: async () => 'com.google.Chrome', appName: async () => 'Google Chrome' });
    await s.watcher.tick();
    const r = s.createLayerForApp('com.google.Chrome', 'Google Chrome');
    assert.equal(r.ok, true);
    const l = s.layersGet().find((x) => x.id === r.id);
    assert.equal(l.name, 'Google Chrome');
    assert.deepEqual(l.apps, [{ bundleId: 'com.google.Chrome', name: 'Google Chrome' }]);
    assert.match(l.color, /^#[0-9A-F]{6}$/);
    assert.equal(s.mode, 'app');
    assert.equal(s.view().suggestLayer, null, '이제 제안하지 않는다');
    assert.equal(s.createLayerForApp('com.google.Chrome', 'Google Chrome').id, r.id, '두 번 만들지 않는다');
  });
});

describe('M19 / 지금 줄의 앱 이름', () => {
  it('L03 레이어에 없는 앱도 실행 중 목록의 이름으로 (번들 ID 끝 대신)', async () => {
    const { s } = await svc({ frontmost: async () => 'notion.id', appName: async () => 'Notion' });
    await s.watcher.tick(); await new Promise((r) => { setTimeout(r, 5); });
    assert.match(s.view().layerLine.nowKo, /Notion/);
  });
});

describe('M19 / 레이어 내보내기·가져오기', () => {
  it('X01 내보내기: 종류·버전·레이어 전부', async () => {
    const { s } = await svc();
    const e = s.layersExport();
    assert.equal(e.kind, 'output-layers');
    assert.equal(e.version, 6);
    assert.deepEqual(e.layers.map((l) => l.id), s.layersGet().map((l) => l.id));
  });
  it('X02 가져오기: 내보낸 파일은 그대로 읽히고(저장은 하지 않는다), 다른 파일·잘못된 값은 거부', async () => {
    const { s } = await svc();
    const e = s.layersExport();
    e.layers.push({ id: 'l-x', kind: 'user', name: 'X', color: '#123456', preset: null, apps: [{ bundleId: 'com.x', name: 'X' }], keys: { key1: { type: 'shortcut', label: '', keystroke: 'cmd+k' } }, dial: {}, joystick: { directions: 4, axis: 'vertical', short: {}, long: {} } });
    const r = s.layersImport(JSON.parse(JSON.stringify(e)));
    assert.equal(r.ok, true);
    assert.ok(r.layers.some((l) => l.id === 'l-x'));
    assert.equal(s.layersGet().some((l) => l.id === 'l-x'), false, '가져오기만으로는 저장하지 않는다');
    assert.equal(s.layersImport({ kind: 'something', layers: [] }).ok, false);
    assert.equal(s.layersImport(null).ok, false);
    const bad = JSON.parse(JSON.stringify(e)); bad.layers.at(-1).keys.key1.keystroke = '???';
    assert.equal(s.layersImport(bad).ok, false);
  });
});

import { DeviceDriver, slimEntry } from '../src/device/deviceDriver.js';
import { readFileSync } from 'node:fs';

describe('M19 / 짧은 LED 명령 (실기 2026-10-10: 기본값을 빼도 같은 색)', () => {
  it('S01 꺼진 칸은 {id,c:0,e:0}(e를 빼면 앞 효과가 남는다, 2026-10-10), 켜진 칸은 {id,c,e,s}, 언더글로우는 sa:1과 (켜졌으면) b를 남긴다', () => {
    assert.deepEqual(slimEntry({ id: 3, c: 0, b: 0, e: 0, s: 0.5, sk: 0, sa: 0 }), { id: 3, c: 0, e: 0 });
    assert.deepEqual(slimEntry({ id: 1, c: 0xff0000, b: 1, e: 6, s: 0.9, sk: 0, sa: 0 }), { id: 1, c: 0xff0000, e: 6, s: 0.9 });
    // 언더글로우는 b가 없으면 켜지지 않는다 (실기 2026-10-10) — 켜진 언더글로우는 b를 남긴다
    assert.deepEqual(slimEntry({ id: 13, c: 0x00ff00, b: 1, e: 1, s: 0.5, sk: 0, sa: 1 }), { id: 13, c: 0x00ff00, b: 1, e: 1, s: 0.5, sa: 1 });
    assert.deepEqual(slimEntry({ id: 13, c: 0, b: 0, e: 0, s: 0.5, sk: 0, sa: 1 }), { id: 13, c: 0, e: 0, sa: 1 });
  });
  it('S02 장치로는 짧은 명령이 나가고, 길이는 줄어든다 (항목 수·순서는 그대로)', async () => {
    const cal = JSON.parse(readFileSync(new URL('../config/calibration.json', import.meta.url), 'utf8'));
    let sent = null;
    const d = new DeviceDriver({ calibration: cal, send: async (p) => { sent = p; } });
    const keys = {}; for (let i = 1; i <= 10; i += 1) keys[`slot${i}`] = { color: 'amber', brightness: 1 };
    await d.applyScene({ keys, ambientZone: { color: 'green', brightness: 0.5 } });
    const full = d.toPayload({ keys, ambientZone: { color: 'green', brightness: 0.5 } }).payload;
    assert.deepEqual(sent, full.map(slimEntry));
    assert.deepEqual(sent.map((e) => e.id), full.map((e) => e.id));
    assert.ok(JSON.stringify(sent).length < JSON.stringify(full).length * 0.7);
  });
});

describe('M19 / 언더글로우 효과 (실기 2026-10-10: b:1이면 e가 먹는다)', () => {
  it('U01 빠른 숨쉬기 언더글로우(개입)는 e:6 s:0.9, 고정은 e:1 — 둘 다 b:1·sa:1', () => {
    const cal = JSON.parse(readFileSync(new URL('../config/calibration.json', import.meta.url), 'utf8'));
    const d = new DeviceDriver({ calibration: cal, send: async () => {} });
    const amb = (z) => d.toPayload({ keys: {}, ambientZone: z }).payload.at(-1);
    assert.deepEqual(slimEntry(amb({ color: 'red', brightness: 1, pattern: 'breathing_fast' })), { id: 13, c: 0xff0000, b: 1, e: 6, s: 0.9, sa: 1 });
    assert.deepEqual(slimEntry(amb({ color: 'red', brightness: 1, pattern: 'solid' })), { id: 13, c: 0xff0000, b: 1, e: 1, s: 0.5, sa: 1 });
  });
});

describe('M19 / 다른 앱 경고 — 헛경고 없음', () => {
  it('O05 남의 응답이 왔어도 지금 장치를 연 다른 앱이 없으면(이미 끝난 개발용 실행 등) 경고하지 않는다', async () => {
    const { s } = await svc({ deviceUsers: async () => [] });
    await s._onForeign('v.oai.thstatus');
    assert.equal(s.view().warnings.some((w) => w.code === 'device-shared'), false);
  });
});
