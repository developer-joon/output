/**
 * M3-13 — live 세션. 입력이 런타임을 움직이고 그 결과가 장치로 나가는 왕복.
 * 장치 없이 FakeTransport의 알림으로 전 경로를 검증한다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import {
  PrintingFocusRouter, PrintingActionRouter, statusLine, makeDispatcher,
  describeIntent, summarize,
} from '../tools/lib/liveSession.js';
import { methodsFor, LED_METHOD, BLOCKED_METHODS, READ_ONLY_METHODS } from '../tools/doctor.mjs';
import { InputDecoder } from '../src/input/inputDecoder.js';
import { DeviceEventDecoder, ACT } from '../src/input/deviceEventDecoder.js';
import { Output } from '../src/output.js';
import { StateStore } from '../src/core/stateStore.js';
import { RenderScheduler } from '../src/device/renderScheduler.js';
import { DeviceDriver } from '../src/device/deviceDriver.js';
import { capabilitiesFrom } from '../src/device/calibrationLoader.js';
import { buildFromFiles } from '../tools/calibrate.mjs';
import { seedWorkUnits } from '../src/adapters/mockOrcaAdapter.js';
import { View, Status } from '../src/core/types.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const CAL = { ...buildFromFiles({ now: () => 'T' }), calibrated: true };
const CAPS = capabilitiesFrom(CAL);

/** 실기와 같은 조립. 장치 자리에는 payload를 모으는 driver를 둔다. */
function liveRig() {
  const store = new StateStore();
  for (const u of seedWorkUnits()) store.addUnit(u);
  const printed = [];
  const print = (l) => printed.push(l);
  const focusRouter = new PrintingFocusRouter({ print });
  const actionRouter = new PrintingActionRouter({ print });
  const bridge = new Output({ store, focusRouter, actionRouter });

  const payloads = [];
  const driver = new DeviceDriver({ calibration: CAL, send: async (p) => payloads.push(p) });
  driver.capabilities = CAPS;
  const scheduler = new RenderScheduler({ bridge, device: driver, bus: bridge.bus });

  const intents = [];
  const pending = [];
  const dispatch = makeDispatcher(bridge);
  const decoder = new InputDecoder({
    sectors: CAL.joystick.sectors,
    deadzone: CAL.joystick.deadzone,
    now: (() => { let t = 0; return () => (t += 100); })(),
    onIntent: (i) => {
      intents.push(i);
      pending.push(Promise.resolve(dispatch(i)).then(() => scheduler.requestRender()));
    },
  });
  const eventDecoder = new DeviceEventDecoder({ decoder, calibration: CAL });

  return {
    store, bridge, scheduler, driver, payloads, intents, printed,
    focusRouter, actionRouter, decoder, eventDecoder,
    async feed(...events) {
      for (const e of events) eventDecoder.handle(e);
      await Promise.all(pending.splice(0));
      await scheduler.idle();
    },
  };
}

const key = (k, act) => ({ m: 'v.oai.hid', p: { k, act } });
const tapKey = (k) => [key(k, ACT.PRESS), key(k, ACT.RELEASE)];
const rad = (a, d) => ({ m: 'v.oai.rad', p: { a, d } });

describe('M3 / live 왕복', () => {
  it('L50 키를 누르면 이동 요청이 나가고 장치가 다시 그려진다', async () => {
    const rig = liveRig();
    rig.scheduler.start();
    await rig.scheduler.idle();
    const before = rig.payloads.length;

    await rig.feed(...tapKey('AG00'));
    assert.equal(rig.intents.length, 1);
    assert.equal(rig.intents[0].key, 'slot1', '실측 매핑대로 1행 왼쪽이 slot1');
    assert.equal(rig.focusRouter.calls.length, 1);
    // 다시 그린다 — 모습이 같으면 장치에 보내지는 않는다 (2026-10-11: 같은 명령 건너뛰기). 최신 상태와 맞춰져 있으면 된다
    await rig.scheduler.idle();
    assert.ok(rig.payloads.length >= before);
    assert.equal(rig.scheduler.inSync, true, '장치가 최신 상태');
    rig.scheduler.stop();
  });

  it('L51 조이스틱으로 묶음이 넘어가고 LED가 따라온다', async () => {
    const rig = liveRig();
    rig.scheduler.start();
    await rig.scheduler.idle();
    assert.equal(rig.bridge.render().bank, 0);

    await rig.feed(rad(0.017, 0.8), rad(0, 0));   // right
    assert.equal(rig.bridge.render().bank, 1);
    const last = rig.payloads[rig.payloads.length - 1];
    assert.equal(last.length, 14);   // 13키 + 언더글로우(16차)
    // Bank 2의 첫 슬롯은 ERROR → 빨강 계열이 나가야 한다
    assert.ok((last[0].c >> 16) > 0, '빨강 성분이 있어야 한다');
    rig.scheduler.stop();
  });

  it('L52 ATTENTION이 개입 대상으로 이동시킨다', async () => {
    const rig = liveRig();
    rig.scheduler.start();
    await rig.scheduler.idle();
    await rig.feed(...tapKey('AG10'));
    assert.equal(rig.intents[0].key, 'attention');
    assert.match(rig.focusRouter.calls[0].reason, /^attention:/);
    rig.scheduler.stop();
  });

  it('L53 MODE/BACK이 Global/Detail을 오간다', async () => {
    const rig = liveRig();
    rig.scheduler.start();
    await rig.scheduler.idle();
    await rig.feed(...tapKey('AG12'));
    assert.equal(rig.bridge.view, View.DETAIL);
    await rig.feed(...tapKey('AG12'));
    assert.equal(rig.bridge.view, View.GLOBAL);
    rig.scheduler.stop();
  });

  it('L54 노브 회전이 선택 슬롯을 옮긴다 (코드 반전 반영)', async () => {
    const rig = liveRig();
    rig.scheduler.start();
    await rig.scheduler.idle();
    assert.equal(rig.bridge.selectedSlot, 0);
    await rig.feed(key('ENC_CC', ACT.ROTATE));   // 실제로는 시계 방향
    assert.equal(rig.bridge.selectedSlot, 1);
    await rig.feed(key('ENC_CW', ACT.ROTATE));   // 실제로는 반시계
    assert.equal(rig.bridge.selectedSlot, 0);
    rig.scheduler.stop();
  });

  it('L55 노브 클릭이 선택 슬롯을 연다', async () => {
    const rig = liveRig();
    rig.scheduler.start();
    await rig.scheduler.idle();
    await rig.feed(...tapKey('ENC_CLK'));
    assert.equal(rig.focusRouter.calls.length, 1, '검증된 capability이므로 동작한다');
    rig.scheduler.stop();
  });

  it('L56 ACK는 표시된 알림만 확인하고 이동하지 않는다', async () => {
    const rig = liveRig();
    rig.scheduler.start();
    await rig.scheduler.idle();
    rig.bridge.banks.goto(1);
    rig.bridge.selectedSlot = 3;      // data/etl-backfill
    rig.bridge.render();
    await rig.feed(...tapKey('AG11'));
    assert.equal(rig.bridge.lastAckResult.ok, true);
    assert.equal(rig.store.getUnit('data/etl-backfill').status, Status.DONE_SEEN);
    assert.equal(rig.focusRouter.calls.length, 0, 'ACK는 이동이 아니다');
    rig.scheduler.stop();
  });
});

describe('M3 / live 안전', () => {
  it('L57 앱 전환이나 키 전송을 하지 않는다', async () => {
    const rig = liveRig();
    rig.scheduler.start();
    await rig.scheduler.idle();
    const r = await rig.actionRouter.run({ control: 'joystick_up', actionId: 'Run' });
    assert.equal(r.ok, false);
    assert.match(r.reasonKo, /앱 명령을 보내지 않습니다/);
    rig.scheduler.stop();
  });

  it('L58 이동은 요청을 적을 뿐 실제로 전환하지 않는다', async () => {
    const printed = [];
    const fr = new PrintingFocusRouter({ print: (l) => printed.push(l) });
    const r = await fr.focus({ unitId: 'u', childId: 'u/a', reason: 'attention:ERROR' });
    assert.equal(r.simulated, true);
    assert.match(printed[0], /이동 요청/);
  });

  it('L59 허용 method는 읽기 3종 + thstatus 뿐이다', () => {
    assert.deepEqual(methodsFor({ live: true }).sort(),
      [...READ_ONLY_METHODS, LED_METHOD].sort());
    assert.equal(methodsFor({ live: true }).includes('fs.write'), false);
    assert.ok(BLOCKED_METHODS.includes('fs.write'));
  });

  it('L60 payload는 항상 14개(13키 + 언더글로우), id 0~13', async () => {
    const rig = liveRig();
    rig.scheduler.start();
    await rig.scheduler.idle();
    await rig.feed(...tapKey('AG02'), rad(0.253, 0.8), rad(0, 0));
    assert.ok(rig.payloads.length > 0);
    for (const p of rig.payloads) {
      assert.equal(p.length, 14);
      assert.ok(p.every((x) => x.id >= 0 && x.id <= 13));
    }
    rig.scheduler.stop();
  });

  it('L61 모르는 알림은 버리지 않고 센다', async () => {
    const rig = liveRig();
    await rig.feed({ m: 'v.oai.hid', p: { k: 'NOPE9', act: 1 } }, { m: 'v.oai.zzz' });
    assert.equal(rig.eventDecoder.unknown.length, 2);
    assert.equal(rig.intents.length, 0);
  });
});

describe('M3 / live 보고', () => {
  it('L62 상태 한 줄이 뷰와 묶음을 보여준다', () => {
    const store = new StateStore();
    for (const u of seedWorkUnits()) store.addUnit(u);
    const line = statusLine(new Output({ store }).render());
    assert.match(line, /\[Global 묶음 1\/3\]/);
    assert.match(line, /진행 중/);
  });

  it('L63 의도를 사람 말로 적는다', () => {
    assert.equal(describeIntent({ type: 'tap', key: 'slot1' }), 'slot1 짧게');
    assert.equal(describeIntent({ type: 'hold', key: 'attention' }), 'attention 길게');
    assert.equal(describeIntent({ type: 'joystick', direction: 'up' }), '조이스틱 up');
    assert.equal(describeIntent({ type: 'dial', direction: 'cw' }), '노브 시계');
  });

  it('L64 알림이 없으면 원인 후보를 알려준다', () => {
    const s = summarize({ events: 0, intents: [], unknown: 0, focusCalls: 0, renders: 3 });
    assert.match(s, /알림이 하나도 오지 않았습니다/);
    assert.match(s, /활성 레이어/);
  });

  it('L65 알림은 왔는데 의도가 없으면 그 사실을 짚는다', () => {
    const s = summarize({ events: 10, intents: [], unknown: 10, focusCalls: 0, renders: 1 });
    assert.match(s, /의도로 바뀌지 않았습니다/);
    assert.match(s, /calibration의 키코드 대응/);
  });

  it('L66 정상 세션은 경고 없이 집계만 낸다', () => {
    const s = summarize({
      events: 8, intents: [{ type: 'tap' }, { type: 'joystick' }], unknown: 0,
      focusCalls: 2, renders: 5,
    });
    assert.match(s, /받은 알림 8건/);
    assert.match(s, /tap 1 · joystick 1/);
    assert.equal(/⚠/.test(s), false);
  });
});

describe('M3 / live CLI', () => {
  it('L67 보정이 없으면 열지 않는다', () => {
    // fake 장치는 알림을 내지 않으므로 짧게 돌려 요약만 본다
    const out = execFileSync('node', ['tools/doctor.mjs', '--fake', '--live=1'],
      { cwd: ROOT, encoding: 'utf8' });
    assert.match(out, /live 세션/);
    assert.match(out, /LED 외에는 아무것도 쓰지 않습니다/);
    assert.match(out, /앱 전환이나 키 전송도 하지 않습니다/);
    assert.match(out, /알림이 하나도 오지 않았습니다/);
  });
});
