/**
 * M3-7 — calibrate + 극좌표 InputDecoder.
 * 실측(7·8·9차)에서 확정된 사실만 반영하는지 검증한다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

import {
  buildCalibration, validateCalibration, mergeInputRecords, fullKeycode,
  formatCalibrationReport, CALIBRATION_VERSION,
} from '../tools/lib/calibration.js';
import { buildFromFiles } from '../tools/calibrate.mjs';
import { InputDecoder } from '../src/input/inputDecoder.js';
import { DeviceEventDecoder, ACT } from '../src/input/deviceEventDecoder.js';
import { LOGICAL_TO_AG } from '../src/core/hardware.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const CAL = buildFromFiles({ now: () => 'T' });

describe('M3 / calibration 구성', () => {
  it('K01 13개 키 + 노브 3종이 실측 키코드로 확정된다', () => {
    for (const l of ['slot1', 'slot2', 'slot3', 'slot4', 'slot5', 'slot6',
      'slot7', 'slot8', 'slot9', 'slot10', 'attention', 'ack', 'mode_back',
      'dial_cw', 'dial_ccw', 'dial_click']) {
      assert.ok(CAL.logicalToKeycode[l], `${l} 미확정`);
    }
  });

  it('K02 계약이 틀린 상단 두 키를 실측대로 교정한다', () => {
    assert.equal(CAL.logicalToKeycode.slot1, 'KV_OAI_AG00');
    assert.equal(CAL.logicalToKeycode.slot2, 'KV_OAI_AG01');
    // 계약 상수는 그대로 둔다
    assert.equal(LOGICAL_TO_AG.slot1, 'AG01');
    assert.equal(LOGICAL_TO_AG.slot2, 'AG00');
    const dev = CAL.contractDeviations.map((d) => d.logical);
    assert.ok(dev.includes('slot1') && dev.includes('slot2'));
  });

  it('K03 노브 코드 이름 반전을 실측대로 기록한다', () => {
    assert.equal(CAL.dial.codeNamingInverted, true);
    assert.equal(CAL.logicalToKeycode.dial_cw, 'KV_OAI_ENC_CC');
    assert.equal(CAL.logicalToKeycode.dial_ccw, 'KV_OAI_ENC_CW');
    assert.ok(CAL.contractDeviations.some((d) => d.logical === 'dial_cw'));
  });

  it('K04 노브 클릭을 지원으로 표시한다 (계약 보류 항목 해소)', () => {
    assert.equal(CAL.dial.clickSupported, true);
    assert.equal(CAL.logicalToKeycode.dial_click, 'KV_OAI_ENC_CLK');
    assert.equal(CAL.unverified.some((u) => /노브 클릭/.test(u)), false);
  });

  it('K05 조이스틱 4방향 구간이 실측에서 유도된다', () => {
    assert.equal(CAL.joystick.sectors.length, 4);
    const byDir = Object.fromEntries(CAL.joystick.sectors.map((s) => [s.direction, s]));
    assert.ok(Math.abs(byDir.right.center - 0.017) < 0.01);
    assert.ok(Math.abs(byDir.down.center - 0.253) < 0.01);
    assert.ok(Math.abs(byDir.left.center - 0.479) < 0.02);
    assert.ok(Math.abs(byDir.up.center - 0.747) < 0.01);
    assert.equal(CAL.joystick.event, 'v.oai.rad');
  });

  it('K06 LED는 13개 index 전부 제어 가능하고 언더글로우 수단을 기록한다 (실기 16차)', () => {
    assert.equal(CAL.led.addressing, 'array_position');
    assert.equal(CAL.led.keyCount, 13);
    assert.deepEqual(CAL.led.controllableIndices, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    assert.deepEqual(CAL.led.notControllableIndices, []);
    assert.equal(CAL.led.indexToLogical['0'], 'slot1');
    assert.equal(CAL.led.indexToLogical['6'], 'slot7');
    assert.equal(CAL.led.indexToLogical['12'], 'mode_back');
    assert.deepEqual(CAL.led.ambient, { method: 'virtual_thread', id: 13, flag: 'sa', brightnessParam: 'b' });
  });

  it('K07 확정하지 못한 것을 unverified로 남기고, 확정된 것은 지운다', () => {
    assert.ok(CAL.unverified.some((u) => /해제해 기본색으로 되돌리는 수단/.test(u)));
    assert.equal(CAL.unverified.some((u) => /LED가 바뀌지 않은 index/.test(u)), false);
    assert.equal(CAL.unverified.some((u) => /언더글로우/.test(u)), false);
  });

  it('K08 여러 실행의 관측을 합쳐 놓친 방향을 채운다', () => {
    const r1 = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/input-events-real.json'), 'utf8')).records;
    const r2 = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/input-events-real-2.json'), 'utf8')).records;
    // 9차 단독으로는 left가 없다
    const only2 = buildCalibration({ inputRecords: r2, now: () => 'T' });
    assert.ok(only2.unverified.some((u) => /left/.test(u)));
    // 합치면 채워진다
    const merged = buildCalibration({ inputRecords: mergeInputRecords(r1, r2), now: () => 'T' });
    assert.equal(merged.joystick.sectors.length, 4);
    assert.equal(merged.unverified.some((u) => /방향 미관측/.test(u)), false);
  });

  it('K09 관측이 없으면 확정하지 않는다', () => {
    const empty = buildCalibration({ inputRecords: {}, now: () => 'T' });
    assert.deepEqual(empty.logicalToKeycode, {});
    assert.ok(empty.unverified.some((u) => /키 이벤트를 관측하지 못해/.test(u)));
    assert.equal(validateCalibration(empty).ok, false);
  });

  it('K10 역방향 대응이 일관된다', () => {
    for (const [code, logical] of Object.entries(CAL.eventKeyToLogical)) {
      assert.equal(CAL.logicalToKeycode[logical], fullKeycode(code));
    }
  });

  it('K11 검증은 중복 배정을 잡는다', () => {
    const bad = structuredClone(CAL);
    bad.logicalToKeycode.slot3 = bad.logicalToKeycode.slot1;
    const v = validateCalibration(bad);
    assert.equal(v.ok, false);
    assert.ok(v.problems.some((p) => /같은 키코드가 둘 이상/.test(p)));
  });

  it('K12 리포트가 계약과 다른 점을 드러낸다', () => {
    const s = formatCalibrationReport(CAL);
    assert.match(s, /계약 권장은 AG01/);
    assert.match(s, /이름이 실제 방향과 반대/);
    assert.match(s, /계약 문서는 고치지 않고/);
  });
});

describe('M3 / calibrate CLI', () => {
  it('K13 기본은 dry-run이고 아무것도 쓰지 않는다', () => {
    const before = fs.existsSync(path.join(ROOT, 'config/calibration.json'));
    const out = execFileSync('node', ['tools/calibrate.mjs'], { cwd: ROOT, encoding: 'utf8' });
    assert.match(out, /DRY RUN — 아무것도 쓰지 않았습니다/);
    assert.match(out, /--apply/);
    assert.equal(fs.existsSync(path.join(ROOT, 'config/calibration.json')), before);
  });

  it('K14 --json 의 stdout은 순수 JSON이다', () => {
    const out = execFileSync('node', ['tools/calibrate.mjs', '--json'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    // 안내문이 섞이면 파싱이 깨진다 — 기계가 읽을 수 있어야 한다
    const cal = JSON.parse(out);
    assert.equal(cal.version, CALIBRATION_VERSION);
    assert.equal(cal.logicalToKeycode.slot1, 'KV_OAI_AG00');
    assert.equal(cal.dial.codeNamingInverted, true);
  });

  it('K15 --apply 는 쓰고 다시 읽어 검증한다', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-cal-'));
    // 실제 저장소를 건드리지 않도록 복사본에서 실행한다
    fs.cpSync(path.join(ROOT, 'tools'), path.join(tmp, 'tools'), { recursive: true });
    fs.cpSync(path.join(ROOT, 'src'), path.join(tmp, 'src'), { recursive: true });
    fs.cpSync(path.join(ROOT, 'test/fixtures'), path.join(tmp, 'test/fixtures'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');

    const out = execFileSync('node', ['tools/calibrate.mjs', '--apply'], { cwd: tmp, encoding: 'utf8' });
    assert.match(out, /read-back 검증 통과/);
    const written = JSON.parse(fs.readFileSync(path.join(tmp, 'config/calibration.json'), 'utf8'));
    assert.equal(written.logicalToKeycode.slot1, 'KV_OAI_AG00');

    // 두 번째 실행은 백업을 남긴다
    const out2 = execFileSync('node', ['tools/calibrate.mjs', '--apply'], { cwd: tmp, encoding: 'utf8' });
    assert.match(out2, /백업: config\/backups\/calibration-/);
    assert.equal(fs.readdirSync(path.join(tmp, 'config/backups')).length, 1);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('K16 장치에 접속하지 않는다', () => {
    const src = fs.readFileSync(path.join(ROOT, 'tools/calibrate.mjs'), 'utf8');
    assert.equal(/hidTransport|openTransport|node-hid/.test(src), false);
  });
});

describe('M3 / InputDecoder 극좌표', () => {
  const clock = () => { let t = 0; return { now: () => (t += 100) }; };

  function decoder(extra = {}) {
    const seen = [];
    const d = new InputDecoder({
      sectors: CAL.joystick.sectors,
      deadzone: CAL.joystick.deadzone,
      now: clock().now,
      onIntent: (i) => seen.push(i),
      ...extra,
    });
    return { d, seen };
  }

  it('K17 실측 각도가 올바른 방향으로 해석된다', () => {
    const { d, seen } = decoder();
    for (const [a, expect] of [[0.748, 'up'], [0.253, 'down'], [0.479, 'left'], [0.017, 'right']]) {
      d.joystickPolar({ angle: a, distance: 0.8 });
      d.joystickPolar({ angle: 0, distance: 0 });   // 중립 복귀
      assert.equal(seen[seen.length - 1].direction, expect, `angle ${a}`);
    }
  });

  it('K18 거리 0(중립)은 방향을 내지 않는다', () => {
    const { d, seen } = decoder();
    assert.equal(d.joystickPolar({ angle: 0.748, distance: 0 }), null);
    assert.equal(seen.length, 0);
  });

  it('K19 deadzone 미만은 무시한다', () => {
    const { d, seen } = decoder();
    d.joystickPolar({ angle: 0.748, distance: 0.04 });
    assert.equal(seen.length, 0);
    d.joystickPolar({ angle: 0.748, distance: 0.06 });
    assert.equal(seen.length, 1);
  });

  it('K20 같은 방향을 유지하면 반복 발화하지 않는다', () => {
    const { d, seen } = decoder();
    d.joystickPolar({ angle: 0.748, distance: 0.5 });
    d.joystickPolar({ angle: 0.749, distance: 0.9 });
    assert.equal(seen.length, 1);
    d.joystickPolar({ angle: 0, distance: 0 });
    d.joystickPolar({ angle: 0.748, distance: 0.9 });
    assert.equal(seen.length, 2);
  });

  it('K21 구간이 원을 넘어가는 right도 양쪽에서 잡힌다', () => {
    const { d, seen } = decoder();
    d.joystickPolar({ angle: 0.99, distance: 0.8 });
    assert.equal(seen[0].direction, 'right');
    d.joystickPolar({ angle: 0, distance: 0 });
    d.joystickPolar({ angle: 0.05, distance: 0.8 });
    assert.equal(seen[1].direction, 'right');
  });

  it('K22 구간을 모르면 방향을 추측하지 않는다', () => {
    const { d, seen } = decoder({ sectors: null });
    assert.equal(d.joystickPolar({ angle: 0.748, distance: 0.9 }), null);
    assert.equal(seen.length, 0);
  });

  it('K23 직교좌표 입력도 실측 구간을 통해 같은 답을 낸다', () => {
    const { d, seen } = decoder();
    d.joystick({ x: 0, y: 1 });
    assert.equal(seen[0].direction, 'up');
    d.joystick({ x: 0, y: 0 });
    d.joystick({ x: -1, y: 0 });
    assert.equal(seen[1].direction, 'left');
  });
});

describe('M3 / DeviceEventDecoder', () => {
  function rig() {
    const seen = [];
    let t = 0;
    const decoder = new InputDecoder({
      sectors: CAL.joystick.sectors, deadzone: CAL.joystick.deadzone,
      now: () => (t += 100), onIntent: (i) => seen.push(i),
    });
    return { seen, dev: new DeviceEventDecoder({ decoder, calibration: CAL }) };
  }

  it('K24 실제 키 이벤트가 논리 역할로 변환된다', () => {
    const { dev, seen } = rig();
    dev.handle({ m: 'v.oai.hid', p: { k: 'AG00', act: ACT.PRESS } });
    dev.handle({ m: 'v.oai.hid', p: { k: 'AG00', act: ACT.RELEASE } });
    assert.deepEqual(seen.map((i) => [i.type, i.key]), [['tap', 'slot1']]);
  });

  it('K25 상단 두 키가 계약이 아니라 실측대로 매핑된다', () => {
    const { dev, seen } = rig();
    for (const k of ['AG00', 'AG01']) {
      dev.handle({ m: 'v.oai.hid', p: { k, act: ACT.PRESS } });
      dev.handle({ m: 'v.oai.hid', p: { k, act: ACT.RELEASE } });
    }
    assert.deepEqual(seen.map((i) => i.key), ['slot1', 'slot2']);
  });

  it('K26 회전 코드 반전이 방향에 반영된다', () => {
    const { dev, seen } = rig();
    dev.handle({ m: 'v.oai.hid', p: { k: 'ENC_CC', act: ACT.ROTATE } });
    dev.handle({ m: 'v.oai.hid', p: { k: 'ENC_CW', act: ACT.ROTATE } });
    assert.deepEqual(seen.map((i) => i.direction), ['cw', 'ccw']);
  });

  it('K27 노브 클릭은 tap으로 나온다', () => {
    const { dev, seen } = rig();
    dev.handle({ m: 'v.oai.hid', p: { k: 'ENC_CLK', act: ACT.PRESS } });
    dev.handle({ m: 'v.oai.hid', p: { k: 'ENC_CLK', act: ACT.RELEASE } });
    assert.deepEqual(seen.map((i) => [i.type, i.key]), [['tap', 'dial_click']]);
  });

  it('K28 조이스틱 극좌표가 그대로 전달된다', () => {
    const { dev, seen } = rig();
    dev.handle({ m: 'v.oai.rad', p: { a: 0.253, d: 0.8 } });
    assert.equal(seen[0].direction, 'down');
    assert.equal(seen[0].distance, 0.8);
  });

  it('K29 해석하지 못한 알림은 버리지 않고 모은다', () => {
    const { dev } = rig();
    dev.handle({ m: 'v.oai.hid', p: { k: 'UNKNOWN99', act: 1 } });
    dev.handle({ m: 'v.oai.other', p: {} });
    dev.handle({ m: 'v.oai.rad', p: {} });
    assert.equal(dev.unknown.length, 3);
  });

  it('K30 길게 누르면 hold만, 짧게 누르면 tap만 나온다 (M2 규칙 유지)', () => {
    let t = 0;
    const seen = [];
    const decoder = new InputDecoder({
      sectors: CAL.joystick.sectors, now: () => t, onIntent: (i) => seen.push(i),
    });
    const dev = new DeviceEventDecoder({ decoder, calibration: CAL });
    t = 1000;
    dev.handle({ m: 'v.oai.hid', p: { k: 'AG10', act: ACT.PRESS } });
    t = 1600;
    decoder.tick();
    dev.handle({ m: 'v.oai.hid', p: { k: 'AG10', act: ACT.RELEASE } });
    assert.deepEqual(seen.map((i) => [i.type, i.key]), [['hold', 'attention']]);
  });

  it('K31 연결이 끊기면 눌린 상태가 해제된다', () => {
    const { dev } = rig();
    dev.handle({ m: 'v.oai.hid', p: { k: 'AG02', act: ACT.PRESS } });
    assert.deepEqual(dev.decoder.pressedKeys, ['slot3']);
    assert.deepEqual(dev.disconnected(), ['slot3']);
    assert.deepEqual(dev.decoder.pressedKeys, []);
  });
});

// ───────────── M6: 17차 관측과 병합 (2026-09-27)
describe('M6 / 17차 관측과 병합', () => {
  it('X01 아래 7키 키코드가 AG06~12로 확정되고 계약 편차에서 빠진다', () => {
    assert.equal(CAL.logicalToKeycode.slot7, 'KV_OAI_AG06');
    assert.equal(CAL.logicalToKeycode.mode_back, 'KV_OAI_AG12');
    assert.equal(CAL.eventKeyToLogical.AG06, 'slot7');
    assert.equal(CAL.eventKeyToLogical.ACT06, undefined, '옛 관측은 최신 관측에 밀려난다');
    const dev = CAL.contractDeviations.map((d) => d.logical);
    for (const l of ['slot7', 'slot8', 'slot9', 'slot10', 'attention', 'ack', 'mode_back']) assert.ok(!dev.includes(l), l);
    assert.ok(dev.includes('slot1') && dev.includes('slot2') && dev.includes('dial_cw'), '기존 편차는 유지');
  });

  it('X02 같은 키의 옛/새 관측이 있으면 키 단계는 최신이 이기고 조이스틱은 이어 붙인다', () => {
    const older = { 'key-3-1': { skipped: false, events: [{ m: 'v.oai.hid', p: { k: 'ACT06', act: 1 } }] },
      'joy-left': { skipped: false, events: [{ m: 'v.oai.rad', p: { a: 0.48, d: 0.9 } }] } };
    const newer = { 'key-3-1': { skipped: false, events: [{ m: 'v.oai.hid', p: { k: 'AG06', act: 1 } }] },
      'joy-left': { skipped: false, events: [{ m: 'v.oai.rad', p: { a: 0.47, d: 0.8 } }] } };
    const m = mergeInputRecords(older, newer);
    assert.deepEqual(m['key-3-1'].events.map((e) => e.p.k), ['AG06']);
    assert.equal(m['joy-left'].events.length, 2);
    assert.deepEqual(m.replacedSteps, [{ stepId: 'key-3-1', before: 'ACT06', after: 'AG06' }]);
    assert.equal(Object.keys(m).includes('replacedSteps'), false, '비열거 — 기존 소비자에게 보이지 않는다');
    const same = mergeInputRecords(newer, newer);
    assert.deepEqual(same.replacedSteps, [], '같은 코드면 교체로 세지 않는다');
  });

  it('X03 최신 관측에 이벤트가 없는 키 단계는 옛 관측을 유지한다', () => {
    const older = { 'key-3-1': { skipped: false, events: [{ m: 'v.oai.hid', p: { k: 'ACT06', act: 1 } }] } };
    const newer = { 'key-3-1': { skipped: true, events: [] } };
    const m = mergeInputRecords(older, newer);
    assert.deepEqual(m['key-3-1'].events.map((e) => e.p.k), ['ACT06']);
    assert.deepEqual(m.replacedSteps, []);
  });
});
