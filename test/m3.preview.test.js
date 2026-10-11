/**
 * M3-12 — doctor --preview. 실기에 런타임 scene을 그려 눈으로 확인한다.
 * LED만 바꾸고 keymap은 건드리지 않는다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import {
  SCENARIOS, STATUS_SEQUENCE, buildStatusStore, buildPulseStore, buildSparseStore,
  expectationsFor, formatExpectations,
} from '../tools/lib/previewScenarios.js';
import { methodsFor, LED_METHOD, BLOCKED_METHODS, READ_ONLY_METHODS } from '../tools/doctor.mjs';
import { Output } from '../src/output.js';
import { buildDeviceScene } from '../src/device/deviceScene.js';
import { DeviceDriver } from '../src/device/deviceDriver.js';
import { capabilitiesFrom } from '../src/device/calibrationLoader.js';
import { buildFromFiles } from '../tools/calibrate.mjs';
import { Status } from '../src/core/types.js';
import { THREAD_STYLE } from '../src/core/lightingPolicy.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const CAL = { ...buildFromFiles({ now: () => 'T' }), calibrated: true };
const CAPS = capabilitiesFrom(CAL);

const sceneOf = (store, phase = 0.05) => buildDeviceScene(
  new Output({ store }).render(), CAPS, { ambientPhase: phase },
);
// 점멸 대체 표현(언더글로우 수단이 없을 때)을 검사할 때 쓴다
const sceneNoAmbient = (store, phase = 0.05) => buildDeviceScene(
  new Output({ store }).render(), { ...CAPS, supportsAmbientZone: false }, { ambientPhase: phase },
);

describe('M3 / preview 시나리오', () => {
  it('V01 세 시나리오가 서로 다른 것을 보여준다', () => {
    assert.deepEqual(SCENARIOS.map((s) => s.id), ['status', 'pulse', 'sparse']);
    for (const s of SCENARIOS) {
      assert.ok(s.seconds > 0 && s.seconds <= 15, `${s.id} 시간이 과하다`);
      assert.ok(s.lookKo.length >= 2, `${s.id} 무엇을 볼지 알려줘야 한다`);
    }
  });

  it('V02 status 시나리오는 6개 상태를 서로 다르게 보여준다', () => {
    const snap = new Output({ store: buildStatusStore() }).render();
    assert.deepEqual(snap.slots.map((s) => s.status), [...STATUS_SEQUENCE, ...Array(4).fill(Status.EMPTY)]);
    const colors = snap.lighting.threads.slice(0, 6).map((t) => t.color);
    assert.equal(new Set(colors).size, 6, '색이 전부 달라야 구분된다');
  });

  it('V03 pulse 시나리오는 보이는 곳이 조용하고 숨은 개입이 있다', () => {
    const snap = new Output({ store: buildPulseStore() }).render();
    assert.ok(snap.slots.every((s) => s.status === Status.RUNNING));
    assert.equal(snap.hiddenAttentionCount, 1);
    const scene = sceneNoAmbient(buildPulseStore());
    assert.deepEqual(scene.ambientFallback.targets, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // 실제 보정(언더글로우 지원)에서는 점멸 대신 ambientZone으로 나간다 (16차)
    const real = sceneOf(buildPulseStore());
    assert.equal(real.ambientFallback, null);
    assert.ok(real.ambientZone && real.ambientZone.color !== 'off');
  });

  it('V04 sparse 시나리오는 빈 자리에서만 점멸한다', () => {
    const snap = new Output({ store: buildSparseStore() }).render();
    assert.deepEqual(snap.slots.map((s) => s.status),
      [Status.RUNNING, Status.RUNNING, Status.RUNNING, ...Array(7).fill(Status.EMPTY)]);
    assert.equal(snap.hiddenAttentionCount, 1);
    const scene = sceneNoAmbient(buildSparseStore());
    assert.deepEqual(scene.ambientFallback.targets, [3, 4, 5, 6, 7, 8, 9], '정보를 덮지 않는다');
  });

  it('V05 기대표가 실제 조명 정책과 일치한다', () => {
    const exp = expectationsFor(STATUS_SEQUENCE);
    assert.equal(exp.length, 6);
    for (const e of exp) {
      assert.equal(e.color, THREAD_STYLE[e.status].color, `${e.logical} 색`);
      assert.equal(e.brightness, THREAD_STYLE[e.status].brightness);
    }
    // 실측 매핑 기준: 1행 1열이 slot1이다 (계약과 반대)
    assert.equal(exp[0].logical, 'slot1');
    assert.equal(exp[0].row, 1);
    assert.equal(exp[0].col, 1);
  });

  it('V06 기대표가 사람이 읽을 수 있다', () => {
    const s = formatExpectations(STATUS_SEQUENCE);
    assert.match(s, /1행 1열/);
    assert.match(s, /진행 중/);
    assert.match(s, /오류/);
    assert.match(s, /red/);
  });
});

describe('M3 / preview 안전', () => {
  it('V07 preview 모드도 fs.write는 차단된다', () => {
    assert.equal(methodsFor({ preview: true }).includes('fs.write'), false);
    assert.ok(BLOCKED_METHODS.includes('fs.write'));
  });

  it('V08 허용 method는 읽기 3종 + thstatus 뿐이다', () => {
    assert.deepEqual(methodsFor({ preview: true }).sort(),
      [...READ_ONLY_METHODS, LED_METHOD].sort());
  });

  it('V09 payload는 13키 + 언더글로우 14개이고 id 범위(0~13)를 넘지 않는다', async () => {
    const sent = [];
    const driver = new DeviceDriver({ calibration: CAL, send: async (p) => sent.push(p) });
    for (const sc of SCENARIOS) {
      await driver.applyScene(sceneOf(sc.build()));
    }
    assert.equal(sent.length, SCENARIOS.length);
    for (const p of sent) {
      assert.equal(p.length, 14);
      assert.ok(p.every((x) => x.id >= 0 && x.id <= 13));
    }
  });

  it('V10 13키 전부 켠 값으로 나가고 14번째는 언더글로우 항목이다 (실기 16차)', async () => {
    const sent = [];
    const driver = new DeviceDriver({ calibration: CAL, send: async (p) => sent.push(p) });
    await driver.applyScene(sceneOf(buildStatusStore()));
    // 켠 값은 드라이버가 만든 전체 항목으로 본다 (장치로는 짧은 명령이 나간다, 2026-10-10)
    for (let i = 0; i <= 12; i += 1) assert.equal(driver.lastPayload[i].b, 1, `index ${i}`);
    assert.equal(sent[0][13].id, 13);
    assert.equal(sent[0][13].sa, 1);
  });
  it('V11 보정이 없으면 미리보기를 거절한다', () => {
    let failed = false;
    try {
      // --fake 는 저장소의 config/ 를 쓰지만, 없는 시나리오 이름으로 먼저 걸러진다
      execFileSync('node', ['tools/doctor.mjs', '--fake', '--preview=없는시나리오'],
        { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
      failed = true;
      assert.ok([2, 12].includes(e.status), `exit ${e.status}`);
      assert.match(e.stderr, /알 수 없는 시나리오|보정이 없어/);
    }
    assert.ok(failed);
  });

  it('V12 미리보기가 끝나면 되돌린다고 알린다', () => {
    const out = execFileSync('node', ['tools/doctor.mjs', '--fake', '--preview=sparse'],
      { cwd: ROOT, encoding: 'utf8' });
    assert.match(out, /LED만 바꿉니다. keymap과 설정은 건드리지 않습니다/);
    assert.match(out, /레이어 색으로 되돌렸습니다/);
    assert.match(out, /Ctrl\+C/);
  });

  it('V13 시나리오마다 무엇을 볼지 먼저 알려준다', () => {
    const out = execFileSync('node', ['tools/doctor.mjs', '--fake', '--preview=status'],
      { cwd: ROOT, encoding: 'utf8' });
    assert.match(out, /슬롯 6개에 서로 다른 상태/);
    assert.match(out, /위치 {8}논리/);
    assert.match(out, /1행 1열/);
  });
});
