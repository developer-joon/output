/**
 * M5-2 ~ M5-7 — 앱 서비스 계층. Electron 없이 돈다.
 * src/service, src/keymap 은 Electron을 모른다 (설계 §4.2).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildStatusView } from '../src/service/uiModel.js';
import { StateStore } from '../src/core/stateStore.js';
import { WorkUnit, ChildUnit } from '../src/core/units.js';
import { Status } from '../src/core/types.js';
import { Output } from '../src/output.js';

function bridgeWith(units) {
  const store = new StateStore();
  for (const u of units) store.addUnit(u);
  return new Output({ store, sourceName: 'Orca' });
}
const unit = (id, status, children = []) => new WorkUnit({ id, title: id, source: 'orca', status, children });
const HEALTH_OK = {
  device: { state: 'connected' }, orca: { state: 'connected', version: '1.4.210' },
  mock: false, permissions: { accessibility: true },
};

describe('M5-2 / 상태판 뷰모델', () => {
  it('U01 슬롯 10줄을 만든다 — 빈 칸도 줄로', () => {
    const b = bridgeWith([unit('a', Status.RUNNING), unit('b', Status.WAITING_APPROVAL)]);
    const v = buildStatusView({ snapshot: b.render(), health: HEALTH_OK });
    assert.equal(v.rows.length, 10);
    assert.deepEqual(v.rows.map((r) => r.title), ['a', 'b', null, null, null, null, null, null, null, null]);
    assert.equal(v.rows[1].labelKo, '승인 필요');
    assert.equal(v.rows[2].empty, true);
  });

  it('U02 기다리는 것이 있으면 메뉴바 점이 주의 색이고 개수가 보인다', () => {
    const b = bridgeWith([unit('a', Status.RUNNING), unit('b', Status.WAITING_APPROVAL)]);
    const v = buildStatusView({ snapshot: b.render(), health: HEALTH_OK });
    assert.equal(v.menu.tone, 'attention');
    assert.equal(v.menu.count, 1);
    const calm = buildStatusView({ snapshot: bridgeWith([unit('a', Status.DONE_SEEN)]).render(), health: HEALTH_OK });
    assert.equal(calm.menu.tone, 'calm');
    assert.equal(calm.menu.count, 0);
  });

  it('U02b 메뉴바 점 우선순위: 개입(빨강) > 장치 문제(회색) > 진행 중(호박) > 완료·미확인(초록) > 평온(파랑) — 2026-09-30', () => {
    const view = (units, health = HEALTH_OK) => buildStatusView({ snapshot: bridgeWith(units).render(), health }).menu;
    assert.equal(view([unit('a', Status.RUNNING), unit('b', Status.DONE_UNSEEN)]).tone, 'running', '진행 중이 완료보다 먼저');
    assert.equal(view([unit('b', Status.DONE_UNSEEN)]).tone, 'done');
    assert.equal(view([unit('b', Status.DONE_UNSEEN)]).count, 0, '초록에는 개수를 달지 않는다');
    assert.equal(view([unit('a', Status.WAITING_APPROVAL), unit('b', Status.RUNNING)]).tone, 'attention', '개입이 먼저');
    assert.equal(view([unit('b', Status.RUNNING)], { ...HEALTH_OK, device: { state: 'denied' } }).tone, 'problem', '장치 문제가 진행 중보다 먼저');
    assert.equal(view([unit('b', Status.IDLE)]).tone, 'calm');
  });

  it('U02c 진행 중·완료 판정은 보이지 않는 묶음까지 센다', () => {
    const units = Array.from({ length: 6 }, (_, i) => unit(`idle${i}`, Status.IDLE));
    units.push(unit('far', Status.RUNNING));                     // 묶음 2
    const snap = bridgeWith(units).render();
    assert.equal(snap.statusCounts[Status.RUNNING], 1);
    assert.equal(buildStatusView({ snapshot: snap, health: HEALTH_OK }).menu.tone, 'running');
  });

  it('U03 요약 줄은 메뉴바 아이콘 설명에만 쓴다 — 다음 ATTENTION 대상 미리 보기는 없다 (ATTENTION 키 제거 2026-10-05)', () => {
    const b = bridgeWith([unit('a', Status.RUNNING), unit('b', Status.WAITING_INPUT)]);
    const v = buildStatusView({ snapshot: b.render(), health: HEALTH_OK });
    assert.equal(v.queueLineKo, '개입 대기 1 · 미확인 완료 0');
    assert.equal('nextTargetKo' in v, false);
  });

  it('U04 장치가 권한 문제로 안 열리면 원인과 해결을 말한다 — 숨기지 않는다', () => {
    const v = buildStatusView({
      snapshot: bridgeWith([]).render(),
      health: { ...HEALTH_OK, device: { state: 'denied', messageKo: 'privilege violation' } },
    });
    const w = v.warnings.find((x) => x.code === 'device-denied');
    assert.ok(w);
    assert.match(w.messageKo, /입력 모니터링/);
    assert.equal(w.action, 'open-input-monitoring');
    assert.equal(v.health.device.ok, false);
  });

  it('U06 모의 데이터면 모의라고 표시한다 — 실제인 척 하지 않는다', () => {
    const v = buildStatusView({ snapshot: bridgeWith([]).render(), health: { ...HEALTH_OK, mock: true } });
    assert.equal(v.mock, true);
    assert.ok(v.warnings.some((x) => x.code === 'mock'));
  });

  it('U07 손쉬운 사용 권한이 없으면 조이스틱·노브 단축키가 동작하지 않는다고 말한다', () => {
    const v = buildStatusView({
      snapshot: bridgeWith([]).render(),
      health: { ...HEALTH_OK, permissions: { accessibility: false } },
    });
    const w = v.warnings.find((x) => x.code === 'accessibility');
    assert.match(w.messageKo, /조이스틱/);
    assert.match(w.messageKo, /켜져 있는데도/, '켜 둔 것 같은데 계속 뜨는 경우(빌드가 바뀜)의 해결법을 말한다 (2026-10-02)');
    assert.equal(w.action, 'open-accessibility');
  });

  it('U08 복원 직후 확인 전인 슬롯이 있으면 그렇다고 말한다', () => {
    const b = bridgeWith([new WorkUnit({ id: 'r', title: 'r', source: 'orca', status: Status.UNKNOWN, restoredAt: 5 })]);
    const v = buildStatusView({ snapshot: b.render(), health: HEALTH_OK, restoring: true });
    assert.equal(v.restoring, true);
    assert.equal(v.rows[0].labelKo, '상태 모름');
  });

  it('U09 대기 중이면 안내가 있고 활성이면 없다', () => {
    const b = bridgeWith([unit('a', Status.RUNNING)]);
    b.setActive(false);
    const off = buildStatusView({ snapshot: b.render(), health: HEALTH_OK });
    assert.equal(off.active, false);
    assert.ok(off.warnings.some((w) => w.code === 'inactive'));
    b.setActive(true);
    const on = buildStatusView({ snapshot: b.render(), health: HEALTH_OK });
    assert.equal(on.active, true);
    assert.ok(!on.warnings.some((w) => w.code === 'inactive'));
  });

  it('U10 줄마다 에이전트 이름을 보여준다 — 무엇이 기다리는지', () => {
    const b = bridgeWith([unit('a', Status.WAITING_APPROVAL, [
      new ChildUnit({ id: 't', title: 'codex 터미널', status: Status.WAITING_APPROVAL }),
    ])]);
    const v = buildStatusView({ snapshot: b.render(), health: HEALTH_OK, unitDetails: { a: { agentKo: 'codex' } } });
    assert.equal(v.rows[0].agentKo, 'codex');
  });
});

// ───────────────────────── M5-3 DeviceGuard

import { DeviceGuard, classifyOpenError } from '../src/service/deviceGuard.js';

function guardHarness({ openImpl } = {}) {
  const events = [];
  const opened = [];
  const guard = new DeviceGuard({
    open: async () => {
      if (openImpl) return openImpl();
      const t = { closed: false, close() { this.closed = true; }, onError(h) { this._err = h; } };
      opened.push(t);
      return t;
    },
    onConnected: (t) => events.push(['connected', t]),
    onDisconnected: (reason) => events.push(['disconnected', reason]),
  });
  return { guard, events, opened };
}

describe('M5-3 / DeviceGuard', () => {
  it('G01 열리면 connected, 연결을 한 번 알린다', async () => {
    const h = guardHarness();
    await h.guard.tick();
    await h.guard.tick();
    assert.equal(h.guard.state, 'connected');
    assert.equal(h.events.filter((e) => e[0] === 'connected').length, 1);
  });

  it('G04 권한 오류는 denied — busy와 구분한다', () => {
    const e = new Error('장치를 단독으로 열지 못했습니다.\n  원인: privilege violation 0xE00002C1');
    e.code = 'DEVICE_BUSY';
    assert.equal(classifyOpenError(e), 'denied');
    const busy = new Error('cannot open device'); busy.code = 'DEVICE_BUSY';
    assert.equal(classifyOpenError(busy), 'busy');
    const nf = new Error('x'); nf.code = 'DEVICE_NOT_FOUND';
    assert.equal(classifyOpenError(nf), 'missing');
    const hm = new Error('x'); hm.code = 'HID_MODULE_MISSING';
    assert.equal(classifyOpenError(hm), 'error');
  });

  it('G05 여는 데 실패해도 죽지 않고 상태와 메시지를 남긴다', async () => {
    const h = guardHarness({ openImpl: () => { const e = new Error('not found'); e.code = 'DEVICE_NOT_FOUND'; throw e; } });
    await h.guard.tick();
    assert.equal(h.guard.state, 'missing');
    assert.ok(h.guard.messageKo);
  });

  it('G06 연결 중 장치 오류가 오면 끊김으로 보고 다음 tick에 다시 연다', async () => {
    const h = guardHarness();
    await h.guard.tick();
    h.opened[0]._err(new Error('device disconnected'));
    assert.equal(h.guard.state, 'missing');
    assert.deepEqual(h.events.at(-1), ['disconnected', 'lost']);
    await h.guard.tick();
    assert.equal(h.guard.state, 'connected');
  });

  it('G07 suspend는 장치를 놓고, resume 뒤 tick에서 다시 잡는다', async () => {
    const h = guardHarness();
    await h.guard.tick();
    h.guard.suspend();
    assert.equal(h.guard.state, 'suspended');
    assert.equal(h.opened[0].closed, true);
    await h.guard.tick();
    assert.equal(h.guard.state, 'suspended', 'suspend 중에는 열지 않는다');
    h.guard.resume();
    await h.guard.tick();
    assert.equal(h.guard.state, 'connected');
  });

  it('G08 동시에 tick이 겹쳐도 두 번 열지 않는다', async () => {
    const h = guardHarness();
    await Promise.all([h.guard.tick(), h.guard.tick(), h.guard.tick()]);
    assert.equal(h.opened.length, 1);
  });
});

import { openHidTransport } from '../src/device/transport/hidTransport.js';

describe('M5-3 / hidTransport 끊김 알림', () => {
  it('G09 장치 오류가 나면 onError 구독자에게 알린다', () => {
    const handlers = {};
    const fakeHid = {
      devices: () => [{ vendorId: 0x303a, productId: 0x8298, usagePage: 0xff00, usage: 1, path: 'p' }],
      HID: class { constructor() {} on(ev, h) { handlers[ev] = h; } write() {} close() {} },
    };
    const t = openHidTransport({ HID: fakeHid });
    let got = null;
    t.onError((e) => { got = e; });
    handlers.error(new Error('unplugged'));
    assert.equal(got?.message, 'unplugged');
  });

  it('G10 여러 프레임 요청은 프레임 사이를 띄워 보낸다 (블루투스: 연달아 13프레임이면 장치가 10초 멈춘다)', async () => {
    const writes = [];
    const fakeHid = {
      devices: () => [{ vendorId: 0x303a, productId: 0x8298, usagePage: 0xff00, usage: 1, path: 'p' }],
      HID: class { constructor() {} on() {} write(f) { writes.push({ at: performance.now(), f }); } close() {} },
    };
    const t = openHidTransport({ HID: fakeHid });
    t.call('device.status', { pad: 'x'.repeat(800) }, 50).catch(() => {});
    assert.equal(writes.length, 1, '첫 프레임은 바로 나간다');
    await new Promise((r) => { setTimeout(r, 300); });
    assert.ok(writes.length >= 13, `프레임 ${writes.length}개`);
    for (let i = 1; i < writes.length; i += 1) {
      assert.ok(writes[i].at - writes[i - 1].at >= 4, `프레임 ${i} 간격 ${(writes[i].at - writes[i - 1].at).toFixed(1)}ms`);
    }
    t.close();
  });
});

// ───────────────────────── M5-4 앱별 프로필

import { parseKeystroke, formatKeystroke } from '../src/service/profiles.js';

describe('M5-4 / 프로필 정의', () => {
  it('F01 단축키 문자열을 읽고 다시 쓴다', () => {
    assert.deepEqual(parseKeystroke('cmd+shift+p'), { key: 'p', modifiers: ['command', 'shift'] });
    assert.deepEqual(parseKeystroke('⌃`'), { key: '`', modifiers: ['control'] });
    assert.deepEqual(parseKeystroke('alt+f12'), { key: 'f12', modifiers: ['option'] });
    assert.equal(parseKeystroke(''), null);
    assert.equal(parseKeystroke('cmd+'), null);
    assert.equal(formatKeystroke({ key: 'p', modifiers: ['command', 'shift'] }), '⌘⇧P');
  });

});

// M5-4 키 합성 라우터(ProfileRouter) 테스트 R01~R09는 2026-10-03 레이어 전환으로 실행기(ActionRunner) 테스트가 대신한다 — m11 X03(실제 조작)·X04(앞 앱)·X05(잠금), m12 L16(노브 빈도)·L17(Orca 앞 앱 재확인)

// ───────────────────────── M5-5/6 키맵 모델

import { isKnownKeycode, isMacroRef, CATALOG } from '../src/keymap/catalog.js';
import {
  parseKeymap, prepareDevice, validateConfig, diffConfigs, CB_LAYER_NAME, ROW_SHAPE,
} from '../src/keymap/keymapModel.js';

/** 실측 모양을 흉내 낸 장치 keymap — 모르는 필드와 매크로를 일부러 넣는다 */
function deviceKeymap() {
  return {
    activeProfileId: 0,
    futureField: { keep: true },
    profiles: [{
      id: 0,
      layers: [
        {
          name: 'VS Code', color: 16711680, unknownLayerField: [1, 2, 3],
          lights: { backlight: { effect: 'solid', brightness: 1, speed: 0.5, magic: 1, color: '#FFFFFF' } },
          layout: {
            keymap: [['KC_F13', 'KC_F14'], ['KC_A', 'KC_B', 'KA_0', 'KC_D'], ['KC_F1', 'KC_F2', 'KC_F3', 'KC_F4'], ['KC_ENT', 'KC_ESC', 'KC_DEL']],
            encoders: [[{ keycode: 'KC_VOLD' }, { keycode: 'KC_VOLU' }, { keycode: 'KC_MUTE' }]],
            joystick: { type: 'RADIAL', sectors: [{ k: 'KI_X', a1: 0.1, a2: 0.3 }] },
          },
        },
      ],
    }],
  };
}

describe('M5-5 / 키코드 카탈로그', () => {
  it('K01 Input이 아는 키코드만 안다', () => {
    assert.equal(CATALOG.kc.length, 184);
    assert.ok(isKnownKeycode('KC_ESC'));
    assert.ok(isKnownKeycode('KV_OAI_AG00'));
    assert.ok(isKnownKeycode('KI_LS1'));
    assert.equal(isKnownKeycode('KC_NOT_A_KEY'), false);
    assert.ok(isKnownKeycode('KV_OAI_AG06'), 'AG06~12는 펌웨어 0.6.2에 있다 (실기 16차)');
    assert.ok(isKnownKeycode('KV_OAI_AG12'));
    assert.equal(isKnownKeycode('KV_OAI_AG13'), false, 'AG13은 가상 스레드 id로만 쓰고 키맵에는 넣지 않는다');
  });

  it('K02 매크로 참조는 패턴으로 알아본다', () => {
    assert.ok(isMacroRef('KA_0'));
    assert.ok(isMacroRef('KM_12'));
    assert.ok(isMacroRef('SA_3'));
    assert.equal(isMacroRef('KC_A'), false);
  });
});

describe('M5-5 / 키맵 모델', () => {
  it('K03 읽는다', () => {
    const { config, errorsKo } = parseKeymap(JSON.stringify(deviceKeymap()));
    assert.deepEqual(errorsKo, []);
    assert.deepEqual(config.profiles[0].layers.map((l) => l.name), ['VS Code']);
  });

  it('K04 장치 준비: Output 레이어 하나만 남긴다 — 다른 레이어는 지우고 모르는 최상위 필드는 보존 (2026-10-04)', () => {
    const { config, changesKo } = prepareDevice(deviceKeymap());
    assert.deepEqual(config.profiles[0].layers.map((l) => l.name), [CB_LAYER_NAME]);
    assert.deepEqual(config.futureField, { keep: true }, '모르는 최상위 필드 보존');
    assert.ok(changesKo.some((c) => /삭제: VS Code/.test(c)));
  });

  it('K05 Output 레이어는 13키 전부 벤더 코드다', () => {
    const { config } = prepareDevice(deviceKeymap());
    const cb = config.profiles[0].layers[0];
    assert.deepEqual(cb.layout.keymap.map((r) => r.length), ROW_SHAPE);
    const flat = cb.layout.keymap.flat();
    assert.deepEqual(flat.slice(0, 6), ['KV_OAI_AG00', 'KV_OAI_AG01', 'KV_OAI_AG02', 'KV_OAI_AG03', 'KV_OAI_AG04', 'KV_OAI_AG05']);
    assert.deepEqual(flat.slice(6), ['KV_OAI_AG06', 'KV_OAI_AG07', 'KV_OAI_AG08', 'KV_OAI_AG09', 'KV_OAI_AG10', 'KV_OAI_AG11', 'KV_OAI_AG12']);
    assert.equal(cb.layout.joystick.type, 'VENDOR');
  });

  it('K07 모르는 형식은 지어내지 않고 기존 레이어에서 복사한다 — 색 타입·인코더 모양·조명', () => {
    const { config } = prepareDevice(deviceKeymap());
    const cb = config.profiles[0].layers[0];
    assert.equal(typeof cb.color, 'number', '기존 레이어가 숫자 색이면 숫자로');
    assert.equal(typeof cb.layout.encoders[0][0], 'object', '인코더 원소 모양도 따라간다');
    assert.deepEqual(cb.lights, deviceKeymap().profiles[0].layers[0].lights);
  });

  it('K08 두 번 해도 Output 하나다', () => {
    const once = prepareDevice(deviceKeymap()).config;
    assert.deepEqual(prepareDevice(once).config.profiles[0].layers.map((l) => l.name), [CB_LAYER_NAME]);
  });

  it('K12 검증 — 행 모양이 틀리면 거부, 모르는 코드가 사용자 레이어에 있는 건 허용(보존)', () => {
    const km = deviceKeymap();
    km.profiles[0].layers[0].layout.keymap[2].push('KC_X');
    assert.ok(validateConfig(km).errorsKo.some((m) => /행/.test(m)));
    const km2 = deviceKeymap();
    km2.profiles[0].layers[0].layout.keymap[0][0] = 'KC_FUTURE_CODE';
    assert.deepEqual(validateConfig(km2).errorsKo, []);
  });

  it('K13 diff는 사람이 읽을 줄로 나온다', () => {
    const a = deviceKeymap();
    const b = JSON.parse(JSON.stringify(a));
    b.profiles[0].layers[0].layout.keymap[1][0] = 'KC_Z';
    const lines = diffConfigs(a, b);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /VS Code/);
    assert.match(lines[0], /KC_A → KC_Z/);
  });
});

// ───────────────────────── M5-5 deviceWriter (가짜 장치만)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FakeTransport } from '../src/device/transport/fakeTransport.js';
import { DeviceWriter, WRITE_METHODS } from '../src/keymap/deviceWriter.js';

function fakeDevice({ corruptWrite = false, failWrite = false, restoreFails = false } = {}) {
  const dev = { text: JSON.stringify(deviceKeymap()), writes: [] };
  const transport = new FakeTransport({
    allowedMethods: WRITE_METHODS,
    responses: {
      'fs.read': () => ({ data: dev.text }),
      'fs.write': (p) => {
        dev.writes.push(p.data);
        if (failWrite) return { __error: { code: -1, message: 'flash busy' } };
        const isRestore = dev.writes.length > 1;
        if (isRestore && restoreFails) return { __error: { code: -1, message: 'still busy' } };
        dev.text = corruptWrite && !isRestore ? p.data.slice(0, -5) : p.data;
        return { ok: 1 };
      },
    },
  });
  return { dev, transport };
}
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cb-writer-'));
const installMut = (c) => prepareDevice(c);

describe('M5-5 / deviceWriter', () => {
  it('W01 dry-run은 아무것도 쓰지 않고 diff만 보여준다', async () => {
    const { dev, transport } = fakeDevice();
    const w = new DeviceWriter({ transport, backupDir: tmpDir(), sleep: async () => {} });
    const plan = await w.plan(installMut);
    assert.equal(plan.errorKo, null);
    assert.ok(plan.diffLines.some((l) => l.includes(CB_LAYER_NAME)));
    assert.equal(dev.writes.length, 0);
  });

  it('W02 적용: 백업 → 쓰기 → 다시 읽어 일치', async () => {
    const dir = tmpDir();
    const { dev, transport } = fakeDevice();
    const w = new DeviceWriter({ transport, backupDir: dir, sleep: async () => {} });
    const plan = await w.plan(installMut);
    const r = await w.apply(plan);
    assert.equal(r.ok, true, r.messageKo);
    assert.equal(dev.writes.length, 1);
    assert.ok(fs.existsSync(r.backupPath));
    assert.equal(fs.readFileSync(r.backupPath, 'utf8'), JSON.stringify(deviceKeymap()), '백업은 원문 그대로');
    assert.deepEqual(JSON.parse(dev.text).futureField, { keep: true }, '모르는 필드가 장치에 남는다');
  });

  it('W03 다시 읽은 내용이 다르면 백업으로 되돌리고 실패를 알린다', async () => {
    const { dev, transport } = fakeDevice({ corruptWrite: true });
    const w = new DeviceWriter({ transport, backupDir: tmpDir(), sleep: async () => {} });
    const r = await w.apply(await w.plan(installMut));
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'verify');
    assert.equal(r.restored, true);
    assert.equal(dev.text, JSON.stringify(deviceKeymap()), '원래대로 돌아왔다');
  });

  it('W04 되돌리기도 실패하면 백업 경로를 알려준다 — 반복하지 않는다', async () => {
    const { dev, transport } = fakeDevice({ corruptWrite: true, restoreFails: true });
    const w = new DeviceWriter({ transport, backupDir: tmpDir(), sleep: async () => {} });
    const r = await w.apply(await w.plan(installMut));
    assert.equal(r.ok, false);
    assert.equal(r.restored, false);
    assert.match(r.messageKo, /백업/);
    assert.ok(r.messageKo.includes(r.backupPath));
    assert.equal(dev.writes.length, 2, '쓰기 1 + 되돌리기 1. 루프를 돌지 않는다');
  });

  it('W05 dry-run 뒤에 장치가 바뀌었으면 쓰지 않는다 — 남의 변경을 덮지 않게', async () => {
    const { dev, transport } = fakeDevice();
    const w = new DeviceWriter({ transport, backupDir: tmpDir(), sleep: async () => {} });
    const plan = await w.plan(installMut);
    dev.text = JSON.stringify({ ...deviceKeymap(), activeProfileId: 0, changedElsewhere: 1 });
    const r = await w.apply(plan);
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'stale');
    assert.equal(dev.writes.length, 0);
  });

  it('W06 검증에 실패하는 결과는 쓰지 않는다', async () => {
    const { dev, transport } = fakeDevice();
    const w = new DeviceWriter({ transport, backupDir: tmpDir(), sleep: async () => {} });
    const plan = await w.plan((c) => {
      const n = JSON.parse(JSON.stringify(c));
      n.profiles[0].layers[0].layout.keymap.pop();
      return { config: n, errorKo: null };
    });
    assert.ok(plan.errorKo);
    const r = await w.apply(plan);
    assert.equal(r.ok, false);
    assert.equal(dev.writes.length, 0);
  });

  it('W07 백업을 만들지 못하면 쓰지 않는다', async () => {
    const { dev, transport } = fakeDevice();
    const dir = tmpDir();
    fs.chmodSync(dir, 0o500);
    try {
      const w = new DeviceWriter({ transport, backupDir: path.join(dir, 'sub'), sleep: async () => {} });
      const r = await w.apply(await w.plan(installMut));
      assert.equal(r.ok, false);
      assert.equal(r.stage, 'backup');
      assert.equal(dev.writes.length, 0);
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  });

  it('W08 쓰기 자체가 실패하면 장치는 안 바뀐 것으로 보고 백업을 안내한다', async () => {
    const { transport } = fakeDevice({ failWrite: true });
    const w = new DeviceWriter({ transport, backupDir: tmpDir(), sleep: async () => {} });
    const r = await w.apply(await w.plan(installMut));
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'write');
  });

  it('W09 백업에서 복원한다 — 복원 전에도 지금 상태를 백업한다', async () => {
    const dir = tmpDir();
    const { dev, transport } = fakeDevice();
    const w = new DeviceWriter({ transport, backupDir: dir, sleep: async () => {} });
    const first = await w.apply(await w.plan(installMut));
    assert.equal(first.ok, true);
    const r = await w.restoreFrom(first.backupPath);
    assert.equal(r.ok, true, r.messageKo);
    assert.equal(dev.text, JSON.stringify(deviceKeymap()));
    assert.equal(w.listBackups().length, 2, '복원 직전 상태도 백업됐다');
  });

  it('W10 런타임 transport(fs.write 차단)로는 쓸 수 없다', async () => {
    const t = new FakeTransport({ blockedMethods: ['fs.write'], responses: { 'fs.read': { data: '{}' } } });
    assert.throws(() => new DeviceWriter({ transport: t, backupDir: tmpDir() }), /쓰기/);
  });
});

// ───────────────────────── M5-7 진단 내보내기

import { buildDiagnostics } from '../src/service/diagnostics.js';

describe('M5-7 / 진단 내보내기 — 민감정보 없음', () => {
  it('D01 prompt·메시지·도구 입력·경로·홈 디렉터리를 담지 않는다', () => {
    const b = bridgeWith([new WorkUnit({ id: 'wt::/Users/someone/secret/repo', title: 'repo', source: 'orca', status: Status.RUNNING })]);
    const d = buildDiagnostics({
      snapshot: b.render(),
      health: HEALTH_OK,
      versions: { app: '0.2.0', firmware: '0.6.2', orca: '1.4.210' },
      logs: [
        { at: 1, messageKo: '갱신 실패: /Users/someone/secret/repo 에서 오류' },
        { at: 2, messageKo: 'prompt: 비밀 계획을 알려줘' },
      ],
      home: '/Users/someone',
    });
    const s = JSON.stringify(d);
    assert.equal(s.includes('/Users/someone'), false, '홈 경로 없음');
    assert.equal(s.includes('secret'), false, '경로 조각 없음');
    assert.equal(s.includes('비밀 계획'), false, 'prompt 내용 없음');
    assert.ok(d.slots.length === 10);
    assert.equal(d.versions.firmware, '0.6.2');
  });

  it('D02 작업 이름 대신 슬롯 번호와 상태만 남긴다', () => {
    const b = bridgeWith([unit('customer-acme-migration', Status.WAITING_APPROVAL)]);
    const d = buildDiagnostics({ snapshot: b.render(), health: HEALTH_OK, versions: {}, logs: [], home: '/Users/x' });
    assert.equal(JSON.stringify(d).includes('acme'), false);
    assert.equal(d.slots[0].status, Status.WAITING_APPROVAL);
  });
});

// ───────────────────────── M5-4 macOS 연결부 (명령 실행 없이)

import { parseBundleId, keystrokeScript, classifyOsascriptError, SETTINGS_URLS } from '../src/service/macos.js';

describe('M5-4 / macOS 연결부', () => {
  it('M01 lsappinfo 출력에서 번들 ID를 읽는다', () => {
    assert.equal(parseBundleId('"CFBundleIdentifier"="com.microsoft.VSCode"\n'), 'com.microsoft.VSCode');
    assert.equal(parseBundleId(''), null);
  });

  it('M02 글자 키는 keystroke, 이름 키는 key code로 만든다', () => {
    assert.equal(
      keystrokeScript({ key: 'p', modifiers: ['command', 'shift'] }),
      'tell application "System Events" to keystroke "p" using {command down, shift down}',
    );
    assert.equal(keystrokeScript({ key: 'f12', modifiers: ['option'] }), 'tell application "System Events" to key code 111 using {option down}');
    assert.equal(keystrokeScript({ key: 'up', modifiers: [] }), 'tell application "System Events" to key code 126');
  });

  it('M03 따옴표·역슬래시는 이스케이프한다 — 스크립트를 깨뜨리지 않게', () => {
    assert.equal(keystrokeScript({ key: '"', modifiers: [] }), 'tell application "System Events" to keystroke "\\""');
    assert.equal(keystrokeScript({ key: '\\', modifiers: ['command'] }), 'tell application "System Events" to keystroke "\\\\" using {command down}');
  });

  it('M04 모르는 키는 만들지 않는다', () => {
    assert.throws(() => keystrokeScript({ key: 'f24', modifiers: [] }), /지원하지 않는 키/);
  });

  it('M05 권한 오류를 알아본다', () => {
    assert.equal(classifyOsascriptError('execution error: System Events got an error: osascript is not allowed assistive access. (-1719)'), 'ACCESSIBILITY');
    assert.equal(classifyOsascriptError('some other failure'), 'OTHER');
  });

  it('M06 권한 설정 화면 주소가 있다', () => {
    assert.match(SETTINGS_URLS.inputMonitoring, /Privacy_ListenEvent/);
    assert.match(SETTINGS_URLS.accessibility, /Privacy_Accessibility/);
  });
});

// ───────────────────────── M5-2 서비스 통합 (가짜 장치·가짜 Orca)

import { OutputService, RUNTIME_METHODS } from '../src/service/outputService.js';
import { buildFromFiles } from '../tools/calibrate.mjs';
import { OrcaCli } from '../src/adapters/orca/orcaCli.js';
import { CB_LAYER_NAME as CBN } from '../src/keymap/keymapModel.js';

const SVC_CAL = buildFromFiles({ now: () => 'T' });
const PERM = JSON.parse(fs.readFileSync(new URL('./fixtures/orca-ps-permission-real.json', import.meta.url), 'utf8'));
const SAMPLE = '4104478c-3942-4d09-aeb6-c05b76bd4cc8::<path>';

function runtimeKeymap() {
  return {
    activeProfileId: 0,
    profiles: [{ id: 0, layers: [{ name: CBN, color: 0x1a1a4d, layout: { keymap: [
      ['KV_OAI_AG00', 'KV_OAI_AG01'], ['KV_OAI_AG02', 'KV_OAI_AG03', 'KV_OAI_AG04', 'KV_OAI_AG05'],
      ['KV_OAI_AG06', 'KV_OAI_AG07', 'KV_OAI_AG08', 'KV_OAI_AG09'], ['KV_OAI_AG10', 'KV_OAI_AG11', 'KV_OAI_AG12'],
    ] } }] }],
  };
}

/** 옛 Output/Output 레이어 (아래 7키가 ACT). 갱신 경고 테스트용 */
function legacyActKeymap() {
  const km = runtimeKeymap();
  km.profiles[0].layers[0].layout.keymap[2] = ['KV_OAI_ACT06', 'KV_OAI_ACT07', 'KV_OAI_ACT08', 'KV_OAI_ACT09'];
  km.profiles[0].layers[0].layout.keymap[3] = ['KV_OAI_ACT10', 'KV_OAI_ACT11', 'KV_OAI_ACT12'];
  return km;
}

function svcHarness({ openFails = null, front = 'com.stablyai.orca', orcaDown = false, withWriter = false, keymap = runtimeKeymap() } = {}) {
  const leds = [];
  const synthed = [];
  const orcaCalls = [];
  const dev = { text: JSON.stringify(keymap), writes: [] };
  let t = 1_000_000;
  const runtime = new FakeTransport({
    allowedMethods: RUNTIME_METHODS, blockedMethods: ['fs.write'],
    responses: {
      'sys.version': { version: '0.6.2' },
      'device.status': { profile_index: 0, layer_index: 1 },
      'fs.read': () => ({ data: dev.text }),
      'v.oai.thstatus': (p) => { leds.push(p); return { ok: 1 }; },
    },
  });
  const cli = new OrcaCli({
    runner: async (bin, argv) => {
      orcaCalls.push(argv.slice(0, 2).join(' '));
      if (orcaDown) throw new Error('orca: connect ECONNREFUSED');
      const cmd = argv.slice(0, 2).join(' ');
      if (argv[0] === 'status') return JSON.stringify({ ok: true, result: { app: { running: true }, runtime: { state: 'ready', reachable: true, appVersion: '1.4.210' } } });
      if (cmd === 'worktree list') return JSON.stringify({ ok: true, result: { worktrees: [{ id: SAMPLE, displayName: 'sample-app', workspaceStatus: 'in-progress', sortOrder: 1 }] } });
      if (cmd === 'terminal list') return JSON.stringify({ ok: true, result: { terminals: PERM.terminals } });
      if (cmd === 'worktree ps') return JSON.stringify({ ok: true, result: PERM });
      return JSON.stringify({ ok: true, result: {} });
    },
  });
  const svc = new OutputService({
    calibration: SVC_CAL,
    stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cb-svc-')),
    openRuntimeTransport: async () => { if (openFails) throw openFails; return runtime; },
    openWriteTransport: withWriter ? async () => new FakeTransport({
      allowedMethods: WRITE_METHODS,
      responses: { 'fs.read': () => ({ data: dev.text }), 'fs.write': (p) => { dev.writes.push(p.data); dev.text = p.data; return { ok: 1 }; } },
    }) : null,
    frontmost: async () => front,
    synth: async (ks) => { synthed.push(ks); },
    accessibilityTrusted: () => true,
    orcaCli: cli, orcaSettings: null,
    timers: { setInterval: () => ({}), clearInterval: () => {} },
    now: () => t,
  });
  const press = async (k) => {
    runtime.emitNotification({ m: 'v.oai.hid', p: { k, act: 1 } });
    await new Promise((r) => setImmediate(r));
    t += 60;
    runtime.emitNotification({ m: 'v.oai.hid', p: { k, act: 0 } });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await svc.scheduler.idle();
  };
  return { svc, runtime, leds, synthed, orcaCalls, dev, press, advance: (ms) => { t += ms; } };
}

describe('M5-2 / 서비스 통합', () => {
  it('S01 시작하면 장치를 잡고 Orca 상태로 LED를 칠한다', async () => {
    const h = svcHarness();
    await h.svc.start();
    await h.svc.scheduler.idle();
    const v = h.svc.view();
    assert.equal(v.health.device.state, 'connected');
    assert.equal(v.health.orca.state, 'connected');
    assert.equal(v.rows[0].title, 'sample-app');
    assert.equal(v.rows[0].labelKo, '승인 필요');
    assert.ok(h.leds.length > 0, 'LED를 보냈다');
    await h.svc.stop();
  });

  it('S02 슬롯 키를 누르면 그 터미널로 이동한다 (terminal switch)', async () => {
    const h = svcHarness();
    await h.svc.start();
    await h.press('AG00');
    assert.ok(h.orcaCalls.includes('terminal switch'), h.orcaCalls.join(','));
    await h.svc.stop();
  });

  it('S03 키 7~10은 키 입력을 만들지 않는다 — 작업 칸이다 (2026-10-01, A1~A4 없음)', async () => {
    const h = svcHarness();
    await h.svc.start();
    for (const ag of ['AG06', 'AG07', 'AG08', 'AG09']) await h.press(ag);
    assert.equal(h.synthed.length, 0);
    await h.svc.stop();
  });

  /** 장치 연결 직후의 비동기 keymap 읽기(_onConnected)가 끝나길 기다린다 */
  async function settle(h) {
    for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r));
    await h.svc.scheduler.idle();
  }

  it('X01 활성 레이어에 옛 ACT 코드가 있으면 갱신 경고를 띄운다', async () => {
    const h = svcHarness({ keymap: legacyActKeymap() });
    await h.svc.start();
    await settle(h);   // _onConnected 가 keymap을 읽어 deviceInfo를 채울 때까지
    const w = h.svc.view().warnings.find((x) => x.code === 'layer-upgrade');
    assert.ok(w, '갱신 경고가 있어야 한다');
    assert.equal(w.action, 'open-device');
    assert.match(w.messageKo, /장치 준비/);
    assert.equal(h.svc.deviceInfo.layerNeedsUpgrade, true);
    await h.svc.stop();
  });

  it('X02 활성 레이어가 AG06~12면 갱신 경고가 없다', async () => {
    const h = svcHarness();   // 기본 runtimeKeymap = AG06~12
    await h.svc.start();
    await settle(h);
    assert.equal(h.svc.view().warnings.some((x) => x.code === 'layer-upgrade'), false);
    assert.equal(h.svc.deviceInfo.layerNeedsUpgrade, false);
    await h.svc.stop();
  });

  /** Input의 ChatGPT 프리셋: 위 6키 AG00~05, 아래 7키 ACT06~12, 이름은 우리 레이어가 아니다 */
  function chatgptPresetKeymap() {
    const km = legacyActKeymap();
    km.profiles[0].layers[0].name = 'ChatGPT';
    return km;
  }

  it('X03 onConnected가 던져도 가드는 연결 상태와 transport를 유지한다 — "열지 못함"으로 굳지 않는다', async () => {
    const g = new DeviceGuard({
      open: async () => ({ close() {} }),
        onConnected: async () => { throw new Error('listener boom'); },
    });
    await g.tick();
    assert.equal(g.state, 'connected');
    assert.ok(g.transport, 'transport를 놓지 않는다');
  });

  it('X04 우리 레이어가 아닌 ChatGPT 프리셋(ACT)이면 장치 준비(Output 하나로)를 안내한다 — 2026-10-04', async () => {
    const h = svcHarness({ keymap: chatgptPresetKeymap() });
    await h.svc.start();
    const w = h.svc.view().warnings.find((x) => x.code === 'layer-upgrade' || x.code === 'layer');
    assert.ok(w, '레이어 경고가 있어야 한다');
    assert.doesNotMatch(w.messageKo, /설치\/갱신/);
    assert.match(w.messageKo, /ChatGPT/);
    assert.match(w.messageKo, /장치 준비/);
    assert.equal(w.action, 'open-device');
    await h.svc.stop();
  });

  it('X05 종료 복원은 언더글로우(14번째 항목)도 끈다 — 항목을 빼면 이전 색이 남는다', async () => {
    const h = svcHarness();
    await h.svc.start();
    await h.svc.stop();
    const last = h.leds.at(-1);
    assert.equal(last.length, 14);
    assert.deepEqual({ id: last[13].id, c: last[13].c, b: last[13].b, sa: last[13].sa }, { id: 13, c: 0, b: 0, sa: 1 });
    assert.ok(last.slice(0, 13).every((k) => k.c === 0x1a1a4d && k.sa === 0));
  });

  it('S04 키 11·12·13은 레이어 칸 — 기본 Orca 레이어에선 비어 있어 키 입력을 만들지 않는다 (2026-10-05)', async () => {
    const h = svcHarness();
    await h.svc.start();
    await h.press('AG10');
    await h.press('AG11');
    await h.press('AG12');
    assert.equal(h.synthed.length, 0);
    await h.svc.stop();
  });

  it('S04b 키 눌림은 조이스틱 단축키 자격을 주지 않는다 — 다른 경로의 실행 요청이 새지 않게', async () => {
    const h = svcHarness();
    await h.svc.start();
    await h.press('AG10');                        // ATTENTION 물리 눌림
    await h.press('AG00');                         // 슬롯 물리 눌림
    // 물리 조이스틱 없이 온 실행 요청 (UI·자동화 등). Orca 레이어 기본 위 = ⌘E
    const r = await h.svc.runner.run('joystick_up', { type: 'shortcut', label: '받아쓰기', keystroke: 'cmd+e' }, { kind: 'app', bundleId: 'com.stablyai.orca' });
    assert.equal(r.ok, false);
    assert.equal(h.synthed.length, 0);
    await h.svc.stop();
  });

  it('S05 상태판에서 슬롯을 눌러도 키 입력은 만들지 않는다 — 이동만', async () => {
    const h = svcHarness();
    await h.svc.start();
    await h.svc.focusSlot(1);
    assert.equal(h.synthed.length, 0);
    assert.ok(h.orcaCalls.includes('terminal switch'));
    await h.svc.stop();
  });

  it('S07 권한이 없어 장치를 못 열어도 Orca는 계속 보이고 해결 절차를 말한다', async () => {
    const e = new Error('단독으로 열지 못했습니다. 원인: privilege violation 0xE00002C1'); e.code = 'DEVICE_BUSY';
    const h = svcHarness({ openFails: e });
    await h.svc.start();
    const v = h.svc.view();
    assert.equal(v.health.device.state, 'denied');
    assert.equal(v.health.orca.state, 'connected');
    assert.equal(v.rows[0].title, 'sample-app');
    assert.ok(v.warnings.some((w) => w.action === 'open-input-monitoring'));
    await h.svc.stop();
  });

  it('S08 Orca가 없어도 죽지 않는다 — 빈 슬롯과 경고, 모의 데이터를 넣지 않는다', async () => {
    const h = svcHarness({ orcaDown: true });
    await h.svc.start();
    const v = h.svc.view();
    assert.equal(v.health.orca.state, 'unreachable');
    assert.ok(v.rows.every((r) => r.empty));
    assert.ok(v.warnings.some((w) => w.code === 'orca-unreachable'));
    await h.svc.stop();
  });

  it('S09 런타임 transport로는 키맵을 쓸 수 없다 — 쓰기 경로가 없으면 거절', async () => {
    const h = svcHarness();
    await h.svc.start();
    assert.equal((await h.svc.devicePlan()).ok, true);
    const r = await h.svc.deviceApply();
    assert.equal(r.ok, false);
    assert.equal(h.dev.writes.length, 0);
    await h.svc.stop();
  });

  it('S10 쓰기 경로로 적용하고, 끝나면 런타임 연결을 다시 잡는다', async () => {
    const h = svcHarness({ withWriter: true, keymap: legacyActKeymap() });   // 옛 ACT 배치 → 갱신할 것이 있다
    await h.svc.start();
    const e = await h.svc.devicePlan();
    assert.equal(e.ok, true);
    assert.ok(e.diffLines.length > 0);
    const r = await h.svc.deviceApply();
    assert.equal(r.ok, true, r.messageKo);
    assert.equal(h.dev.writes.length, 1);
    assert.equal(h.svc.guard.state, 'connected', '런타임을 다시 잡았다');
    assert.equal((await h.svc.keymapBackups()).length, 1);
    await h.svc.stop();
  });

  it('S12 레이어 저장은 검증하고 파일에 남긴다', async () => {
    const h = svcHarness();
    await h.svc.start();
    const layers = h.svc.layersGet();
    layers[0].joystick.short.up = { type: 'shortcut', label: '워크트리', keystroke: 'cmd+shift+o' };
    assert.equal(h.svc.layersSave(layers).ok, true);
    assert.ok(fs.existsSync(path.join(h.svc.stateDir, 'profiles.json')));
    layers[0].joystick.short.up = { type: 'shortcut', label: '워크트리', keystroke: 'cmd+???+' };
    assert.equal(h.svc.layersSave(layers).ok, false);
    await h.svc.stop();
  });

  it('S13 진단 내보내기에 작업 이름이 없다', async () => {
    const h = svcHarness();
    await h.svc.start();
    const d = JSON.stringify(h.svc.diagnostics());
    assert.equal(d.includes('sample-app'), false);
    await h.svc.stop();
  });

  it('S15 보정이 없어도 뜨고, 보정이 필요하다고 말한다', async () => {
    const { UNCALIBRATED } = await import('../src/device/calibrationLoader.js');
    const svc = new OutputService({
      calibration: UNCALIBRATED,
      stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cb-svc-')),
      openRuntimeTransport: async () => { const e = new Error('x'); e.code = 'DEVICE_NOT_FOUND'; throw e; },
      orcaEnabled: false,
      timers: { setInterval: () => ({}), clearInterval: () => {} },
    });
    await svc.start();
    assert.ok(svc.view().warnings.some((w) => w.code === 'calibration'));
    await svc.stop();
  });

  it('S14 종료하면 LED를 레이어 기본색으로 되돌린다', async () => {
    const h = svcHarness();
    await h.svc.start();
    await h.svc.stop();
    const last = h.leds.at(-1);
    assert.ok(last.slice(0, 13).every((k) => k.c === 0x1a1a4d));   // 14번째(언더글로우 끄기)는 X05가 본다
  });
});

// ───────────────────────── 최종 리뷰 반영 (Important 1~6)

describe('M5 / 최종 리뷰 반영', () => {
  it('RV1 여는 도중 suspend가 오면 잡지 않고 바로 놓는다, resume 뒤 멈추지 않는다', async () => {
    let releaseOpen;
    const opened = [];
    const g = new DeviceGuard({
      open: () => new Promise((r) => { releaseOpen = () => { const t = { closed: false, close() { this.closed = true; } }; opened.push(t); r(t); }; }),
    });
    const p = g.tick();
    g.suspend();                    // 여는 사이에 절전·쓰기 시작
    releaseOpen();
    await p;
    assert.equal(g.transport, null, '일시정지 중에는 장치를 잡고 있지 않다');
    assert.ok(opened.every((t) => t.closed));
    g.resume();
    g.open = async () => ({ closed: false, close() {} });
    await g.tick();
    assert.equal(g.state, 'connected', 'resume 뒤 다시 잡는다');
  });

  it('RV2 키를 누른 채 연결이 끊겨도 길게 누름이 생기지 않는다', async () => {
    const h = svcHarness();
    await h.svc.start();
    let held = 0;
    h.svc.bridge.longPressAttention = () => { held += 1; };
    h.svc.bridge.longPressModeBack = () => { held += 1; };
    h.runtime.emitNotification({ m: 'v.oai.hid', p: { k: 'AG10', act: 1 } });
    await new Promise((r) => setImmediate(r));
    h.svc.guard.suspend();                 // 일시정지 — 연결이 끊긴다 (Input 양보는 없앴다, 2026-10-11)
    h.advance(900);
    h.svc.decoder.tick();
    await new Promise((r) => setImmediate(r));
    assert.equal(held, 0);
    await h.svc.stop();
  });

  it('RV6 사용자 레이어에 매크로가 있어도 불러오고 되돌릴 수 있다', () => {
    const { config } = prepareDevice(deviceKeymap());
    config.profiles[0].layers.push({ ...deviceKeymap().profiles[0].layers[0] });
    config.profiles[0].layers[1].layout.keymap[1][0] = 'KA_3';
    assert.deepEqual(validateConfig(config).errorsKo, []);
    assert.ok(parseKeymap(JSON.stringify(config)).config);
  });

  it('RV6b Output 레이어는 여전히 엄격하다', () => {
    const { config } = prepareDevice(deviceKeymap());
    config.profiles[0].layers[0].layout.keymap[0][0] = 'KC_NOPE';
    assert.ok(validateConfig(config).errorsKo.length > 0);
  });
});

// ───────────────────────── 이름 · 상태 폴더

import { defaultDir as outputDir } from '../src/adapters/persistence/index.js';

describe('Output / 이름 · 상태 폴더', () => {
  it('B01 레이어 이름은 Output이다', () => {
    assert.equal(CB_LAYER_NAME, 'Output');
  });

  it('B03 상태 폴더: OUTPUT_HOME > ~/.output', () => {
    const saved = process.env.OUTPUT_HOME;
    try {
      delete process.env.OUTPUT_HOME;
      assert.equal(outputDir(), path.join(os.homedir(), '.output'));
      process.env.OUTPUT_HOME = '/tmp/new';
      assert.equal(outputDir(), '/tmp/new');
    } finally {
      if (saved === undefined) delete process.env.OUTPUT_HOME; else process.env.OUTPUT_HOME = saved;
    }
  });
});

// ───────────────────────── 개선 1 — Orca 폴링 겹침 방지

describe('개선 1 / Orca 폴링 겹침', () => {
  it('P01 앞선 refreshOrca가 끝나기 전에 다시 부르면 새 CLI 호출을 만들지 않고 같은 진행을 기다린다', async () => {
    const h = svcHarness();
    await h.svc.start();
    await h.svc.scheduler.idle();

    // 다음 폴링의 CLI 응답을 붙잡아 둔다 — Orca가 느린 상황
    let release;
    const gate = new Promise((r) => { release = r; });
    const inner = h.svc.orca.cli.runner;
    let spawned = 0;
    h.svc.orca.cli.runner = async (bin, argv) => { spawned += 1; await gate; return inner(bin, argv); };

    h.svc._orcaAt = -Infinity; h.svc._orcaFullAt = -Infinity;   // 다음 확인 때가 됐고 목록 전체도 읽을 때 (2026-10-11 주기)
    const p1 = h.svc.refreshOrca();
    const p2 = h.svc.refreshOrca();
    await new Promise((r) => setImmediate(r));
    assert.equal(spawned, 3, '겹친 두 번째 호출은 CLI를 다시 띄우지 않는다 (list·terminal·ps 3개만)');

    release();
    await Promise.all([p1, p2]);
    assert.equal(h.svc.view().health.orca.state, 'connected');
    await h.svc.stop();
  });
});

// ───────────────────────── 개선 3 — 백업 목록 한 벌

import { listBackups } from '../src/keymap/deviceWriter.js';

describe('개선 3 / listBackups', () => {
  it('L01 keymap-*.json만 최신 순으로, 없는 폴더는 빈 목록', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-bk-'));
    for (const f of ['keymap-2026-01-01.json', 'keymap-2026-01-02.json', 'other.json']) fs.writeFileSync(path.join(dir, f), '{}');
    assert.deepEqual(listBackups(dir).map((p) => path.basename(p)), ['keymap-2026-01-02.json', 'keymap-2026-01-01.json']);
    assert.deepEqual(listBackups(path.join(dir, 'none')), []);
  });
});

// ───────────────────────── 개선 5 — 백업 복원은 백업 폴더 안의 파일만

describe('개선 5 / keymapRestore 경로 검증', () => {
  it('V01 백업 폴더 밖의 경로는 장치를 열지도 않고 거절한다', async () => {
    const h = svcHarness({ withWriter: true });
    await h.svc.start();
    const outside = path.join(h.svc.stateDir, 'keymap-evil.json');
    fs.writeFileSync(outside, JSON.stringify(runtimeKeymap()));
    const r = await h.svc.keymapRestore(outside);
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'path');
    assert.equal(h.dev.writes.length, 0, '장치에 아무것도 쓰지 않았다');
    // 폴더 이름만 흉내 낸 경로도 막는다
    const sneaky = path.join(h.svc.stateDir, 'backups', '..', 'keymap-evil.json');
    assert.equal((await h.svc.keymapRestore(sneaky)).stage, 'path');
    await h.svc.stop();
  });
});
