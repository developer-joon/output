/**
 * M3-9 — calibration을 런타임에 연결.
 * 실기에서 확인된 것만 쓰고, 확인되지 않은 기능은 내보내지 않는다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  loadCalibration, capabilitiesFrom, UNCALIBRATED, DEFAULT_CALIBRATION_PATH,
} from '../src/device/calibrationLoader.js';
import { DeviceDriver, colorToInt, indexOfLogical } from '../src/device/deviceDriver.js';
import { buildDeviceScene, LOGICAL_KEYS } from '../src/device/deviceScene.js';
import { buildFromFiles } from '../tools/calibrate.mjs';
import { Output } from '../src/output.js';
import { StateStore } from '../src/core/stateStore.js';
import { WorkUnit, ChildUnit } from '../src/core/units.js';
import { Status } from '../src/core/types.js';
import { safeWriteJson, describeWriteError } from '../tools/lib/safeWrite.js';

const CAL = buildFromFiles({ now: () => 'T' });

function snapshotWith(statuses) {
  const store = new StateStore();
  statuses.forEach((st, i) => store.addUnit(new WorkUnit({
    id: `u${i}`, title: `u${i}`,
    children: [new ChildUnit({ id: `u${i}/a`, status: st })],
  })));
  return new Output({ store }).render();
}

describe('M3 / calibration 로더', () => {
  it('R30 파일이 없으면 전부 미검증으로 둔다', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-nocal-'));
    const r = loadCalibration({ root: tmp });
    assert.equal(r.calibrated, false);
    assert.equal(r.calibration, UNCALIBRATED);
    assert.match(r.sourceKo, /없음/);
    const caps = capabilitiesFrom(r.calibration);
    assert.deepEqual(caps.controllableKeys, []);
    assert.equal(caps.dialClick, false);
    assert.equal(caps.joystick, false);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('R31 깨진 파일도 죽지 않고 미검증으로 떨어진다', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-badcal-'));
    fs.mkdirSync(path.join(tmp, 'config'));
    fs.writeFileSync(path.join(tmp, DEFAULT_CALIBRATION_PATH), '{not json');
    const r = loadCalibration({ root: tmp });
    assert.equal(r.calibrated, false);
    assert.equal(r.problems.length, 1);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('R32 실측 calibration에서 capability가 나온다', () => {
    const caps = capabilitiesFrom(CAL);
    assert.deepEqual(caps.controllableKeys.sort(), [...LOGICAL_KEYS].sort());
    assert.equal(caps.dialClick, true);
    assert.equal(caps.joystick, true);
    assert.equal(caps.supportsAmbientZone, true);
    assert.equal(caps.miniLeds, false);
  });
});

describe('M3 / DeviceScene이 제어 불가 키를 드러낸다', () => {
  it('R33 13키 전부 제어 가능 — uncontrollable 없음 (실기 16차)', () => {
    const snap = snapshotWith([Status.RUNNING]);
    const scene = buildDeviceScene(snap, capabilitiesFrom(CAL));
    assert.deepEqual(scene.uncontrollableKeys, []);
    assert.equal(scene.unsupported.some((u) => u.startsWith('perKeyColor:')), false);
    // 13키 scene 자체는 그대로 만든다 — 표현 계층과 전달 계층을 섞지 않는다
    assert.equal(Object.keys(scene.keys).length, 13);
  });

  it('R34 언더글로우는 내보낸다', () => {
    const scene = buildDeviceScene(snapshotWith([Status.ERROR]), capabilitiesFrom(CAL));
    assert.ok(scene.ambientZone);
    assert.equal(scene.unsupported.includes('ambientZone'), false);
  });

  it('R35 capability를 주지 않으면 기존 동작을 유지한다', () => {
    const scene = buildDeviceScene(snapshotWith([Status.RUNNING]), {});
    assert.deepEqual(scene.uncontrollableKeys, []);
  });
});

describe('M3 / DeviceDriver', () => {
  function driver() {
    const sent = [];
    return { sent, d: new DeviceDriver({ calibration: CAL, send: async (p) => sent.push(p) }) };
  }

  it('R36 payload는 13개 키 + 언더글로우 1개다', async () => {
    const { d, sent } = driver();
    const scene = buildDeviceScene(snapshotWith([Status.ERROR]), capabilitiesFrom(CAL));
    const r = await d.applyScene(scene);
    assert.equal(r.ok, true);
    assert.equal(sent[0].length, 14);
    assert.deepEqual(sent[0].map((x) => x.id), Array.from({ length: 14 }, (_, i) => i));
  });

  it('R37 13개 index 전부 켜서 보낸다', async () => {
    const { d, sent } = driver();
    const scene = buildDeviceScene(snapshotWith([Status.ERROR]), capabilitiesFrom(CAL));
    await d.applyScene(scene);
    // 켠 값은 전체 항목으로 본다 (장치로는 짧은 명령, 2026-10-10)
    for (let i = 0; i <= 12; i += 1) assert.equal(d.lastPayload[i].b, 1, `index ${i}`);
    assert.equal(sent[0].length, 14);
  });

  it('R38 제어하지 못한 키가 없다 — appliedKeys가 13키 전부', async () => {
    const { d } = driver();
    const scene = buildDeviceScene(snapshotWith([Status.RUNNING]), capabilitiesFrom(CAL));
    const r = await d.applyScene(scene);
    assert.deepEqual(r.appliedKeys.sort(), [...LOGICAL_KEYS].sort());
    assert.deepEqual(r.unsupportedKeys, []);
  });

  it('R39 실측 index → 논리 키 대응을 쓴다 (계약이 아니라)', () => {
    // 계약은 slot1→AG01이지만 실측 LED index 0이 slot1이다
    assert.equal(indexOfLogical(CAL, 'slot1'), 0);
    assert.equal(indexOfLogical(CAL, 'slot2'), 1);
    assert.equal(indexOfLogical(CAL, 'attention'), 10, '16차: ATTENTION도 LED index 10으로 제어된다');
  });

  it('R40 주소 방식이 확정되지 않으면 보내지 않는다', async () => {
    const sent = [];
    const d = new DeviceDriver({ calibration: UNCALIBRATED, send: async (p) => sent.push(p) });
    const r = await d.applyScene(buildDeviceScene(snapshotWith([Status.RUNNING]), {}));
    assert.equal(r.ok, false);
    assert.match(r.reasonKo, /확정되지 않아/);
    assert.equal(sent.length, 0);
  });

  it('R41 쓰기 실패를 한국어로 보고한다', async () => {
    const d = new DeviceDriver({
      calibration: CAL, send: async () => { throw new Error('연결 끊김'); },
    });
    const r = await d.applyScene(buildDeviceScene(snapshotWith([Status.RUNNING]), capabilitiesFrom(CAL)));
    assert.equal(r.ok, false);
    assert.match(r.reasonKo, /장치 쓰기 실패: 연결 끊김/);
  });

  it('R42 상태색이 정수 색으로 변환된다', () => {
    assert.equal(colorToInt('red', 1), 0xff0000);
    assert.equal(colorToInt('green', 1), 0x00ff00);
    assert.equal(colorToInt('off', 1), 0);
    assert.equal(colorToInt('red', 0.5), 0x800000, '밝기가 반영된다');
    assert.equal(colorToInt('알수없는색', 1), 0, '모르는 색은 꺼짐');
  });

  it('R43 상태가 다르면 payload 색도 다르다', async () => {
    const { d, sent } = driver();
    const caps = capabilitiesFrom(CAL);
    await d.applyScene(buildDeviceScene(snapshotWith([Status.ERROR]), caps));
    await d.applyScene(buildDeviceScene(snapshotWith([Status.RUNNING]), caps));
    assert.notEqual(sent[0][0].c, sent[1][0].c);
  });

  it('R44 id가 13키 + 가상 스레드(13) 범위를 넘지 않는다', async () => {
    const { d, sent } = driver();
    await d.applyScene(buildDeviceScene(snapshotWith([Status.RUNNING]), capabilitiesFrom(CAL)));
    assert.ok(sent[0].every((x) => x.id >= 0 && x.id <= 13));
  });
});

describe('M3 / 안전한 파일 쓰기', () => {
  it('R45 권한 오류를 스택 대신 안내로 바꾼다', () => {
    const msg = describeWriteError({ code: 'EACCES' }, '/x/config/calibration.json');
    assert.match(msg, /쓸 권한이 없습니다/);
    assert.match(msg, /sudo chown -R/);
    assert.match(msg, /sudo로 실행할 필요가 없습니다/);
  });

  it('R46 쓰고 나서 다시 읽어 검증한다', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-w-'));
    const target = path.join(tmp, 'config', 'x.json');
    const r = safeWriteJson(target, { a: 1 });
    assert.equal(r.ok, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { a: 1 });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('R47 기존 파일은 백업한 뒤 쓴다', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-w2-'));
    const target = path.join(tmp, 'config', 'x.json');
    const backupDir = path.join(tmp, 'config', 'backups');
    safeWriteJson(target, { a: 1 }, { backupDir });
    const r = safeWriteJson(target, { a: 2 }, { backupDir });
    assert.equal(r.ok, true);
    assert.ok(r.backup);
    assert.deepEqual(JSON.parse(fs.readFileSync(r.backup, 'utf8')), { a: 1 });
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

// ───────────── M6: 가상 스레드 언더글로우 (실기 16차, 2026-09-26)
describe('M6 / 가상 스레드 언더글로우 (실기 16차)', () => {
  const AMBIENT = { method: 'virtual_thread', id: 13, flag: 'sa', brightnessParam: 'b' };
  const withAmbient = (cal) => ({ ...cal, led: { ...cal.led, ambient: AMBIENT } });
  const OFF = { color: 'off', brightness: 0, pattern: 'off' };
  const keysAllOff = Object.fromEntries(LOGICAL_KEYS.map((k) => [k, OFF]));

  it('X01 보정에 ambient가 있으면 capability가 ambient zone 지원으로 바뀐다', () => {
    assert.equal(capabilitiesFrom(withAmbient(CAL)).supportsAmbientZone, true);
    assert.equal(capabilitiesFrom({ ...CAL, led: { ...CAL.led, ambient: null } }).supportsAmbientZone, false);
    assert.equal(capabilitiesFrom(UNCALIBRATED).supportsAmbientZone, false);
    // keys zone은 여전히 수단이 없다
  });

  it('X02 ambientZone 색을 14번째 항목(id 13, sa:1)으로 보내고, 꺼짐이면 c:0 b:0으로 보낸다', () => {
    const d = new DeviceDriver({ calibration: withAmbient(CAL), send: async () => {} });
    const on = d.toPayload({ keys: keysAllOff, ambientZone: { color: 'red', brightness: 0.6, pattern: 'breathing' } });
    assert.equal(on.payload.length, d.keyCount + 1);
    const last = on.payload[on.payload.length - 1];
    assert.equal(last.id, 13);
    assert.equal(last.sa, 1);
    assert.equal(last.sk, 0);
    assert.equal(last.b, 1);
    assert.equal(last.c, colorToInt('red', 0.6));
    assert.equal(on.ambientApplied, true);

    const off = d.toPayload({ keys: keysAllOff, ambientZone: OFF });
    const lastOff = off.payload[off.payload.length - 1];
    assert.deepEqual({ id: lastOff.id, c: lastOff.c, b: lastOff.b, sa: lastOff.sa }, { id: 13, c: 0, b: 0, sa: 1 });
    assert.equal(off.ambientApplied, false);

    const nul = d.toPayload({ keys: keysAllOff, ambientZone: null });
    assert.equal(nul.payload[nul.payload.length - 1].b, 0, 'ambientZone이 null이어도 항목은 보내 이전 색이 남지 않게 한다');
  });

  it('X03 보정에 ambient가 없으면 13개만 보낸다 (옛 보정 파일 호환)', () => {
    const d = new DeviceDriver({ calibration: { ...CAL, led: { ...CAL.led, ambient: null } }, send: async () => {} });
    const r = d.toPayload({ keys: keysAllOff, ambientZone: { color: 'red', brightness: 0.6, pattern: 'breathing' } });
    assert.equal(r.payload.length, 13);
    assert.equal(r.ambientApplied, false);
  });

  it('X04 키 항목은 sa:0 이다 — 언더글로우는 가상 스레드만 움직인다', () => {
    const d = new DeviceDriver({ calibration: withAmbient(CAL), send: async () => {} });
    const r = d.toPayload({ keys: { ...keysAllOff, slot1: { color: 'blue', brightness: 0.3, pattern: 'solid' } },
      ambientZone: { color: 'orange', brightness: 0.5, pattern: 'breathing' } });
    for (const item of r.payload.slice(0, 13)) assert.equal(item.sa, 0, `id ${item.id}`);
  });
});
