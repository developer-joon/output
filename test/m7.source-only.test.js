/**
 * M7 — Orca 전용 Output. 스펙: docs/superpowers/specs/2026-09-27-orca-only-design.md
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { StateStore } from '../src/core/stateStore.js';
import { WorkUnit } from '../src/core/units.js';
import { Status, View } from '../src/core/types.js';
import { Output } from '../src/output.js';
import { MockFocusRouter } from '../src/core/focusRouter.js';
import { Events } from '../src/core/eventBus.js';
import { slotsOf } from '../src/apps/layers.js';
import { renderLighting } from '../src/core/lightingPolicy.js';

function coreRig() {
  const store = new StateStore();
  store.addUnit(new WorkUnit({ id: 'u1', title: 'u1', status: Status.WAITING_APPROVAL }));
  store.addUnit(new WorkUnit({ id: 'u2', title: 'u2', status: Status.DONE_UNSEEN }));
  const focusRouter = new MockFocusRouter();
  const bridge = new Output({ store, focusRouter, sourceName: 'Orca' });
  return { store, bridge, focusRouter };
}

describe('M7 / 코어 — 활성/대기', () => {
  it('A01 대기 중에는 모든 입력이 무동작이고 상태가 바뀌지 않는다', async () => {
    const { bridge, focusRouter } = coreRig();
    bridge.dialCW();                                    // 활성일 때 선택 1 (노브는 세션으로 이동한다)
    await bridge.dialIdle();
    focusRouter.calls.length = 0;                       // 활성일 때의 이동은 이 검사의 대상이 아니다
    const events = [];
    bridge.bus.on(Events.ACTIVE_CHANGED, (e) => events.push(e));
    bridge.setActive(false);
    bridge.setActive(false);                            // 같은 값은 이벤트 없음
    assert.deepEqual(events, [{ active: false }]);
    assert.equal(bridge.active, false);
    assert.equal(await bridge.pressSlot(1), null);
    assert.equal(bridge.longPressSlot(1), null);
    assert.equal(await bridge.runBuiltin('attention'), null);
    assert.equal(await bridge.pressAttention(), null);
    assert.equal(bridge.longPressAttention(), null);
    assert.equal(bridge.pressModeBack(), null);
    assert.equal(bridge.longPressModeBack(), null);
    assert.equal(bridge.dialCW(), null);
    assert.equal(bridge.dialCCW(), null);
    assert.equal(await bridge.dialPress({ hardwareValidated: true }), null);
    assert.equal(await bridge.joystickUp(), null);
    assert.equal(await bridge.joystickDown(), null);
    assert.equal(bridge.joystickLeft(), null);
    assert.equal(bridge.joystickRight(), null);
    assert.deepEqual(bridge.pressAck(), []);
    assert.equal(bridge.lastAckResult.ok, false);
    assert.equal(bridge.selectedSlot, 1);
    assert.equal(bridge.view, View.GLOBAL);
    assert.equal(focusRouter.calls.length, 0);
    const snap = bridge.render();
    assert.equal(snap.active, false);
    assert.equal(snap.slots[0].status, Status.WAITING_APPROVAL, '상태판 데이터는 그대로');
    assert.equal(snap.attentionCount, 1);
  });

  it('A03 활성으로 돌아오면 이벤트가 나가고 입력이 다시 된다', async () => {
    const { bridge, focusRouter } = coreRig();
    bridge.setActive(false);
    const events = [];
    bridge.bus.on(Events.ACTIVE_CHANGED, (e) => events.push(e));
    bridge.setActive(true);
    assert.deepEqual(events, [{ active: true }]);
    await bridge.pressSlot(1);
    assert.equal(focusRouter.calls.length, 1);
    assert.equal(bridge.render().active, true);
  });

  it('A09 조명: keysZone도 A키 칸도 없다 (2026-10-01). 소스 이름은 보인다', () => {
    const { bridge } = coreRig();
    const s = bridge.render();
    assert.equal('keysZone' in s.lighting, false);
    assert.equal('actions' in s.lighting, false);
    assert.equal('profile' in s, false);
    assert.equal(s.sourceName, 'Orca');
    bridge.setSourceName('Other');
    assert.equal(bridge.render().sourceName, 'Other');
    assert.deepEqual(Object.keys(renderLighting({ slotStatuses: [Status.RUNNING], ambientSummary: null })).sort(), ['ambientZone', 'threads']);
  });
});

import { buildDeviceScene } from '../src/device/deviceScene.js';
import { DeviceDriver } from '../src/device/deviceDriver.js';
import { RenderScheduler } from '../src/device/renderScheduler.js';
import { FakeDevice } from '../src/device/fakeDevice.js';
import { buildFromFiles } from '../tools/calibrate.mjs';

const M7_CAL = buildFromFiles({ now: () => 'T' });

describe('M7 / 장치 — 대기 씬과 복원 페이로드', () => {
  it('A02 대기 씬은 키·점멸·대체 표현이 없고, 드라이버는 레이어색 13개 + 언더글로우 꺼짐을 보낸다', async () => {
    const { bridge } = coreRig();
    bridge.setActive(false);
    const snap = bridge.render();
    const scene = buildDeviceScene({ ...snap, slots: snap.slots.map((x, i) => (i === 0 ? { ...x, attentionSince: Date.now() - 100 } : x)) },
      { supportsAmbientZone: false }, { ambientPhase: 0.05 });
    assert.equal(scene.inactive, true);
    assert.deepEqual(scene.keys, {});
    assert.equal(scene.notice.active, false);
    assert.equal(scene.ambientFallback, null);

    const sent = [];
    const driver = new DeviceDriver({ calibration: M7_CAL, send: async (p) => { sent.push(p); } });
    driver.restoreColor = 0x1a1a4d;
    const r = await driver.applyScene(scene);
    assert.equal(r.ok, true);
    assert.equal(r.restored, true);
    assert.deepEqual(r.appliedKeys, []);
    const p = sent[0];
    assert.equal(p.length, 14);
    // 장치로는 짧은 명령 (2026-10-10)
    for (let i = 0; i < 13; i += 1) assert.deepEqual(p[i], { id: i, c: 0x1a1a4d, b: 1, e: 1, s: 0.5 });   // 켜진 키도 b (2026-10-12)
    assert.deepEqual(p[13], { id: 13, c: 0, e: 0, sa: 1 });

    driver.restoreColor = null;                          // 레이어 색을 아직 모르면 전부 끔
    await driver.applyScene(scene);
    for (let i = 0; i < 13; i += 1) assert.deepEqual(sent[1][i], { id: i, c: 0, e: 0 });
  });

  it('A03b 활성 전환마다 스케줄러가 다시 그린다 — 대기 씬 뒤 활성 씬', async () => {
    const { bridge } = coreRig();
    const device = new FakeDevice();
    const scheduler = new RenderScheduler({ bridge, device, bus: bridge.bus }).start();
    await scheduler.idle();
    bridge.setActive(false);
    await scheduler.idle();
    assert.equal(device.lastScene().inactive, true);
    bridge.setActive(true);
    await scheduler.idle();
    assert.equal(device.lastScene().inactive, false);
    assert.equal(device.lastScene().keys.slot1.color, 'orange', '승인 대기 상태색으로 복귀');
    scheduler.stop();
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OutputService } from '../src/service/outputService.js';
import { FakeTransport } from '../src/device/transport/fakeTransport.js';
import { RUNTIME_METHODS } from '../src/device/deviceDriver.js';
import { OrcaCli } from '../src/adapters/orca/orcaCli.js';
import { SOURCE } from '../src/adapters/orca/index.js';
import { ForegroundWatcher } from '../src/service/foregroundWatcher.js';
import { readSourcesFile, SOURCE_FILE_VERSION } from '../src/service/profiles.js';
import { CB_LAYER_NAME, parseKeymap } from '../src/keymap/keymapModel.js';

const PS = JSON.parse(fs.readFileSync(new URL('./fixtures/orca-ps-permission-real.json', import.meta.url), 'utf8'));
const WT = '4104478c-3942-4d09-aeb6-c05b76bd4cc8::<path>';
const OUTPUT_KEYMAP = { activeProfileId: 0, profiles: [{ id: 0, layers: [{ name: CB_LAYER_NAME, color: 0x1a1a4d, layout: { keymap: [
  ['KV_OAI_AG00', 'KV_OAI_AG01'], ['KV_OAI_AG02', 'KV_OAI_AG03', 'KV_OAI_AG04', 'KV_OAI_AG05'],
  ['KV_OAI_AG06', 'KV_OAI_AG07', 'KV_OAI_AG08', 'KV_OAI_AG09'], ['KV_OAI_AG10', 'KV_OAI_AG11', 'KV_OAI_AG12'] ], encoders: [['KV_OAI_ENC_CC', 'KV_OAI_ENC_CW', 'KV_OAI_ENC_CLK']] } }] }] };

function svc({ front = 'com.apple.finder', profilesFile = null, keymap = OUTPUT_KEYMAP } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-m7-'));
  if (profilesFile) fs.writeFileSync(path.join(stateDir, 'profiles.json'), JSON.stringify(profilesFile));
  const leds = [];
  const synthed = [];
  let t = 1_000_000;
  const runtime = new FakeTransport({
    allowedMethods: RUNTIME_METHODS, blockedMethods: ['fs.write'],
    responses: {
      'sys.version': { version: '0.6.2' }, 'device.status': { profile_index: 0, layer_index: 1 },
      'fs.read': () => ({ data: JSON.stringify(keymap) }), 'v.oai.thstatus': (p) => { leds.push(p); return { ok: 1 }; },
    },
  });
  const cli = new OrcaCli({ runner: async (bin, argv) => {
    const cmd = argv.slice(0, 2).join(' ');
    if (argv[0] === 'status') return JSON.stringify({ ok: true, result: { app: { running: true }, runtime: { state: 'ready', reachable: true, appVersion: '1.4.210' } } });
    if (cmd === 'worktree list') return JSON.stringify({ ok: true, result: { worktrees: [{ id: WT, displayName: 'sample-app', workspaceStatus: 'in-progress', sortOrder: 1 }] } });
    if (cmd === 'terminal list') return JSON.stringify({ ok: true, result: { terminals: PS.terminals } });
    if (cmd === 'worktree ps') return JSON.stringify({ ok: true, result: PS });
    return JSON.stringify({ ok: true, result: {} });
  } });
  const state = { front };
  const s = new OutputService({
    calibration: M7_CAL, stateDir,
    openRuntimeTransport: async () => runtime,
    frontmost: async () => state.front,
    synth: async (ks) => { synthed.push(ks); }, accessibilityTrusted: () => true,
    orcaCli: cli, ownBundleIds: ['dev.output.app'], orcaSettings: null,
    timers: { setInterval: () => ({}), clearInterval: () => {} }, now: () => t,
  });
  const press = async (k) => {
    runtime.emitNotification({ m: 'v.oai.hid', p: { k, act: 1 } });
    await new Promise((r) => setImmediate(r));
    t += 60;
    runtime.emitNotification({ m: 'v.oai.hid', p: { k, act: 0 } });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await s.scheduler.idle();
  };
  return { s, leds, synthed, press, state, cli };
}

describe('M7 / 서비스 — 소스 감시와 단축키', () => {
  it('A04 감시자: 앞 앱 번들이 바뀔 때만 알리고, 자기 창·실패는 유지한다 (모드는 서비스가 정함, 2026-10-03)', async () => {
    const seen = [];
    const state = { front: 'com.apple.finder', fail: false };
    const w = new ForegroundWatcher({
      frontmost: async () => { if (state.fail) throw new Error('x'); return state.front; },
      ignoreBundleIds: ['dev.output.app'],
      onFront: (b) => seen.push(b),
    });
    await w.tick();                                   // finder (첫 관측)
    state.front = 'com.stablyai.orca'; await w.tick(); await w.tick();
    state.front = 'dev.output.app'; await w.tick();    // 자기 창 → 유지
    state.fail = true; await w.tick(); state.fail = false;
    state.front = 'com.example.other'; await w.tick();
    state.front = 'com.apple.finder'; await w.tick();
    assert.deepEqual(seen, ['com.apple.finder', 'com.stablyai.orca', 'com.example.other', 'com.apple.finder']);
    assert.equal(w.current, 'com.apple.finder');
  });

  it('A05 서비스: 시작 직후 기본 레이어(빈 레이어: 키 꺼짐·언더글로우 레이어 색, 2026-10-11 대기 없음) → Orca 앞이면 활성·상태색·키 7은 단축키 없음 → 다른 앱이면 기본·무동작', async () => {
    const h = svc();
    await h.s.start();
    await h.s.scheduler.idle();
    // 연결 인사(2026-10-10)가 먼저 나간다 — 회전(e:3). 끝난 뒤의 모습을 본다
    assert.ok(h.leds.some((p) => p[0].e === 3), '연결 인사');
    h.s._flash = null; h.s.scheduler.requestRender(); await h.s.scheduler.idle();
    assert.equal(h.s.view().active, false, '첫 관측이 Finder — Orca 모드가 아니다');
    assert.equal(h.s.mode, 'app', '기본 레이어');
    assert.ok(!h.s.view().warnings.some((w) => w.code === 'inactive'), '대기 안내 없음');
    assert.deepEqual(h.leds.at(-1).slice(0, 13).map((e) => e.c), Array(13).fill(0), '빈 기본 레이어 — 키 꺼짐');
    assert.equal(h.leds.at(-1)[13].sa, 1);
    assert.notEqual(h.leds.at(-1)[13].c, 0, '언더글로우는 기본 레이어 색');

    h.state.front = 'com.stablyai.orca';
    await h.s.watcher.tick();
    await h.s.scheduler.idle();
    const v = h.s.view();
    assert.equal(v.active, true);
    assert.ok(!v.warnings.some((w) => w.code === 'inactive'));
    assert.notDeepEqual(h.leds.at(-1).slice(0, 13).map((e) => e.c), Array(13).fill(0), '상태색');
    await h.press('AG06');                              // 키 7 = 칸 7 (2026-10-01, 이전 A1)
    assert.deepEqual(h.synthed, [], '키 7은 단축키를 보내지 않는다');
    await h.press('AG00');                              // SLOT 1 → 이동 (보정: slot1 = AG00, 실측 스왑)
    assert.ok(h.cli.calls.some((c) => c[0] === 'terminal' && c[1] === 'switch'));

    h.state.front = 'com.microsoft.VSCode';
    await h.s.watcher.tick();
    await h.s.scheduler.idle();
    assert.equal(h.s.view().active, false);
    const before = { synth: h.synthed.length, switches: h.cli.calls.filter((c) => c[1] === 'switch').length };
    await h.press('AG06'); await h.press('AG00'); await h.press('AG10');
    assert.equal(h.synthed.length, before.synth, '빈 기본 레이어 — 단축키 없음');
    assert.equal(h.cli.calls.filter((c) => c[1] === 'switch').length, before.switches, '빈 기본 레이어 — 이동 없음');
    assert.deepEqual(h.leds.at(-1).slice(0, 13).map((e) => e.c), Array(13).fill(0), '빈 기본 레이어 — 키 꺼짐');
    // 기본 레이어에서는 Orca 상태가 바뀌어도 키는 Orca 색을 내지 않는다
    await h.s.refreshOrca(); await h.s.scheduler.idle();
    assert.deepEqual(h.leds.at(-1).slice(0, 13).map((e) => e.c), Array(13).fill(0));
    await h.s.stop();

    // 노브 누름이 아직 옛 레이어 전환 키(KI_LS)면 Output 레이어 갱신을 안내한다 (2026-10-03)
    const out = OUTPUT_KEYMAP.profiles[0].layers[0];
    const two = svc({ front: 'com.stablyai.orca', keymap: { ...OUTPUT_KEYMAP, profiles: [{ id: 0, layers: [out, { ...out, name: 'Mine' }] }] } });
    await two.s.start();
    assert.ok(!two.s.view().warnings.some((w) => w.code === 'dial-hint'), 'ENC_CLK면 안내 없음');
    await two.s.stop();
    const oldLs = { ...out, layout: { ...out.layout, encoders: [['KV_OAI_ENC_CC', 'KV_OAI_ENC_CW', 'KI_LS2']] } };
    const three = svc({ front: 'com.stablyai.orca', keymap: { ...OUTPUT_KEYMAP, profiles: [{ id: 0, layers: [oldLs, { ...out, name: 'Mine' }] }] } });
    await three.s.start();
    assert.ok(three.s.view().warnings.some((w) => w.code === 'dial-hint'));
    await three.s.stop();
  });

  it('A06 설정 파일: v1은 Orca만 옮기고 A키는 프리셋과 달라 노트로 남김(2026-10-04), 더 새 버전 거부, 저장은 v6 레이어', async () => {
    assert.equal(SOURCE_FILE_VERSION, 6);
    const v1 = { version: 1, profiles: [
      { name: 'VS Code', bundleIds: ['com.microsoft.VSCode'], actions: [{ labelKo: '팔레트', keystroke: 'cmd+shift+p' }] },
      { name: 'Orca', bundleIds: ['com.stablyai.orca'], actions: [{ labelKo: '목록', keystroke: 'cmd+1' }, { labelKo: 'x', keystroke: null }] },
    ] };
    const r = readSourcesFile(v1, [SOURCE]);
    assert.equal(r.controlsByName.get('Orca')?.joystickHold, undefined, 'A키는 버린다 (조이스틱 길게는 2026-10-12에 없앰)');
    assert.equal(r.controlsByName.has('VS Code'), false);
    const v7 = readSourcesFile({ version: 7, layers: [] }, [SOURCE]);
    assert.equal(v7.layersRaw, null);
    assert.match(v7.warningKo, /새로운 버전/);
    const h = svc({ profilesFile: v1 });
    await h.s.start();
    assert.ok(h.s.logs.some((l) => /Orca 설정만/.test(l.messageKo)));
    assert.ok(h.s.logs.some((l) => /A키 단축키 1개\(목록\)는 옮길 자리가 없어 버렸습니다/.test(l.messageKo)));
    assert.ok(h.s.logs.some((l) => /레이어로 옮겼습니다/.test(l.messageKo)));
    const layers = h.s.layersGet();
    assert.equal(layers.find((l) => l.id === 'l-orca').preset, 'orca');
    assert.equal(JSON.stringify(slotsOf(layers.find((l) => l.id === 'l-orca'))).includes('cmd+1'), false);
    assert.equal(h.s.layersSave(layers).ok, true);
    const saved = JSON.parse(fs.readFileSync(path.join(h.s.stateDir, 'profiles.json'), 'utf8'));
    assert.equal(saved.version, 6);
    assert.equal('sources' in saved, false);
    assert.equal(saved.layers[0].kind, 'default');
    await h.s.stop();
  });

  it('A11 Orca 레이어 단축키는 Orca가 앞일 때만 보낸다 (실행기)', async () => {
    const h = svc({ front: 'com.stablyai.orca' });
    await h.s.start();
    const up = { type: 'shortcut', label: '받아쓰기', keystroke: 'cmd+e' };
    h.s.runner.notePhysical('joystick_up');
    assert.equal((await h.s.runner.run('joystick_up', up, { kind: 'app', bundleId: 'com.stablyai.orca' })).ok, true);
    h.state.front = 'com.microsoft.VSCode';
    h.s.runner.notePhysical('joystick_up');
    const res = await h.s.runner.run('joystick_up', up, { kind: 'app', bundleId: 'com.stablyai.orca' });
    assert.equal(res.ok, false);
    assert.match(res.reasonKo, /앞 앱/);
    assert.equal(h.synthed.length, 1);
    await h.s.stop();
  });
});

import { validateConfig, prepareDevice, macroRefsIn, OUR_LAYERS } from '../src/keymap/keymapModel.js';

const enc = (l) => l.layout.encoders[0].map((e) => (typeof e === 'object' ? e.keycode : e));
function userKeymap(names = ['VS Code']) {
  const layer = (name) => ({
    name, color: 16711680,
    lights: { backlight: { effect: 'solid', brightness: 1, speed: 0.5, magic: 1, color: '#FFFFFF' } },
    layout: {
      keymap: [['KC_F13', 'KC_F14'], ['KC_A', 'KC_B', 'KA_0', 'KC_D'], ['KC_F1', 'KC_F2', 'KC_F3', 'KC_F4'], ['KC_ENT', 'KC_ESC', 'KC_DEL']],
      encoders: [[{ keycode: 'KC_VOLU' }, { keycode: 'KC_VOLD' }, { keycode: 'KC_MUTE' }]],
      joystick: { type: 'RADIAL', sectors: [] },
    },
  });
  return { activeProfileId: 0, profiles: [{ id: 0, layers: names.map(layer) }] };
}

describe('M7 / 키맵 — 장치 준비: Output 레이어 하나, 인코더 누름은 Output 칸 (2026-10-04)', () => {
  it('A07 장치 준비는 Output 하나만 남기고, 인코더 누름은 Output 노브 누름 칸(ENC_CLK)', () => {
    const r = prepareDevice(userKeymap(['VS Code']));
    assert.deepEqual(r.config.profiles[0].layers.map((l) => l.name), [CB_LAYER_NAME]);
    const cb = r.config.profiles[0].layers[0];
    assert.deepEqual(enc(cb), ['KV_OAI_ENC_CC', 'KV_OAI_ENC_CW', 'KV_OAI_ENC_CLK']);
    assert.deepEqual(cb.layout.keymap[2], ['KV_OAI_AG06', 'KV_OAI_AG07', 'KV_OAI_AG08', 'KV_OAI_AG09'].map((c) => (typeof cb.layout.keymap[2][0] === 'object' ? { keycode: c } : c)));
    assert.ok(r.changesKo.some((s) => /노브\(누름 포함\)/.test(s)));
    assert.deepEqual(OUR_LAYERS, [CB_LAYER_NAME]);
  });

  it('A07b Output이 몇 번이든 결과는 Output 하나, 인코더 누름 ENC_CLK', () => {
    const km = userKeymap(['VS Code']);
    km.profiles[0].layers.unshift(prepareDevice(userKeymap(['VS Code'])).config.profiles[0].layers[0]);   // [Output, VS Code]
    const r = prepareDevice(km);
    assert.deepEqual(r.config.profiles[0].layers.map((l) => l.name), [CB_LAYER_NAME]);
    assert.equal(enc(r.config.profiles[0].layers[0])[2], 'KV_OAI_ENC_CLK');
  });

  it('A07c 이미 있는 Output Fallback 레이어는 지운다', () => {
    const r = prepareDevice(userKeymap(['VS Code', 'Output Fallback']));
    assert.deepEqual(r.config.profiles[0].layers.map((l) => l.name), [CB_LAYER_NAME]);
    assert.ok(r.changesKo.includes('삭제: Output Fallback'));
  });

  it('A08 검증: Output 레이어 3행의 매크로 참조는 허용, 3행 밖 매크로는 거부', () => {
    const { config } = prepareDevice(userKeymap(['VS Code']));
    config.profiles[0].layers.push(userKeymap(['VS Code']).profiles[0].layers[0]);   // KA_0 참조를 가진 레이어
    assert.deepEqual([...macroRefsIn(config)], ['KA_0']);
    const ok = JSON.parse(JSON.stringify(config));
    ok.profiles[0].layers[0].layout.keymap[2][0] = 'KA_0';
    assert.deepEqual(validateConfig(ok).errorsKo, []);
    const outside = JSON.parse(JSON.stringify(config));
    outside.profiles[0].layers[0].layout.keymap[0][0] = 'KA_0';
    assert.ok(validateConfig(outside).errorsKo.length > 0, '3행 밖 매크로');
    assert.ok(parseKeymap(JSON.stringify(ok)).config);
  });
});

describe('M7 / 최종 리뷰 반영', () => {
  it('F01 상태판 줄 클릭은 대기 중에도 그 작업으로 이동한다 — 장치 입력이 아니라 앱 자신의 창이다', async () => {
    const h = svc({ front: 'com.microsoft.VSCode' });
    await h.s.start();
    await h.s.scheduler.idle();
    assert.equal(h.s.view().active, false);
    await h.s.focusSlot(1);
    assert.ok(h.cli.calls.some((c) => c[0] === 'terminal' && c[1] === 'switch'), '이동했다');
    assert.equal(h.s.lastEventKo, '슬롯 1로 이동');
    assert.equal(h.s.bridge.selectedSlot, 0);
    await h.s.stop();
  });

});
