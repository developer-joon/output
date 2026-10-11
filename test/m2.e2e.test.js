/**
 * M2 end-to-end — 입력 → 상태 → 조명 → 포커스 전 경로를 FakeDevice로 검증.
 * demo/e2e.js가 쓰는 것과 같은 조립을 사용한다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildDemo } from '../demo/e2e.js';
import { buildFromFiles } from '../tools/calibrate.mjs';
import { UNCALIBRATED } from '../src/device/calibrationLoader.js';

// 테스트는 config/ 의 상태에 좌우되면 안 된다. 보정을 명시적으로 주입한다.
const CALIBRATED = { ...buildFromFiles({ now: () => 'T' }), calibrated: true };
const demoCalibrated = (o = {}) => buildDemo({ calibration: CALIBRATED, ...o });
const demoUncalibrated = (o = {}) => buildDemo({ calibration: UNCALIBRATED, ...o });
import { Status, View } from '../src/core/types.js';
import { Events } from '../src/core/eventBus.js';

describe('M2 / end-to-end 로컬 데모', () => {
  it('E01 물리 입력이 상태·조명·포커스까지 도달한다', async () => {
    const rig = demoCalibrated();
    await rig.scheduler.idle();

    // 1) 시작: Bank 1은 조용하지만 hidden bank에 오류가 있다
    let snap = rig.bridge.render();
    assert.equal(snap.bankCount, 3);
    assert.ok(snap.slots.every((s) => [Status.RUNNING, Status.DONE_SEEN].includes(s.status)));
    assert.equal(snap.lighting.ambientZone.color, 'red');
    assert.equal(rig.device.lastScene().keys.attention.color, 'amber', 'ATTENTION 키는 호박 숨쉬기 — 언더글로우 빨강과 따로 (2026-10-03)');
    assert.equal(rig.device.lastScene().keys.attention.pattern, 'breathing');

    // 2) 조이스틱으로 bank 이동 → 장치에 반영
    await rig.joystick('right');
    snap = rig.bridge.render();
    assert.equal(snap.bank, 1);
    assert.equal(snap.slots[0].id, 'search/index-rebuild');
    assert.equal(rig.device.lastScene().keys.slot1.color, 'red');

    // 3) ATTENTION은 포커스만, 상태 변화 없음
    const revBefore = rig.store.revision;
    await rig.tap('attention');
    assert.equal(rig.focusRouter.calls.length, 1);
    assert.equal(rig.store.revision, revBefore, 'ATTENTION은 업무 상태를 바꾸지 않는다');

    // 4) ATTENTION 반복은 같은 항목에 갇히지 않는다
    await rig.tap('attention');
    assert.notDeepEqual(rig.focusRouter.calls[1], rig.focusRouter.calls[0]);

    // 5) ACK는 표시된 알림 하나만 확인
    rig.bridge.selectedSlot = 3;
    rig.bridge.render();
    await rig.tap('ack');
    assert.equal(rig.bridge.lastAckResult.ok, true);
    assert.deepEqual(rig.bridge.lastAckResult.acked, ['data/etl-backfill/codex']);
    assert.equal(rig.store.getUnit('data/etl-backfill').status, Status.DONE_SEEN);

    // 6) 승인 필요 슬롯에서 ACK는 아무것도 승인하지 않는다
    rig.bridge.selectedSlot = 1;
    rig.bridge.render();
    await rig.tap('ack');
    assert.equal(rig.bridge.lastAckResult.ok, false);
    assert.match(rig.bridge.lastAckResult.reasonKo, /[가-힣]/);
    assert.equal(rig.store.getUnit('billing/invoice-pdf').status, Status.WAITING_APPROVAL);

    // 7) 길게 누름 → Detail, 다시 MODE → Global 복귀 (슬롯 유지)
    const beforeIds = rig.bridge.render().slots.map((s) => s.id);
    await rig.hold('slot1');
    assert.equal(rig.bridge.view, View.DETAIL);
    assert.deepEqual(rig.bridge.render().slots.slice(0, 3).map((s) => s.title),
      ['codex', 'reindex', 'shell']);
    await rig.tap('mode_back');
    assert.equal(rig.bridge.view, View.GLOBAL);
    assert.deepEqual(rig.bridge.render().slots.map((s) => s.id), beforeIds);

    // 8) 장치는 항상 최신 revision을 갖고 있다
    assert.equal(rig.device.lastScene().revision, rig.store.revision);
    assert.equal(rig.scheduler.inSync, true);
  });

  it('E02 숨은 묶음의 개입이 보이는 6키를 바꾸지 않고 underglow만 바꾼다', async () => {
    const rig = demoCalibrated();
    await rig.scheduler.idle();
    const { store } = rig;

    // 전부 조용하게 만든다
    for (const u of store.allUnits()) {
      for (const c of u.children) {
        if (c.status !== Status.RUNNING) {
          store.setChildStatus(u.id, c.id, Status.RUNNING);
        }
      }
    }
    await rig.scheduler.idle();
    const quietSlots = rig.bridge.render().slots.map((s) => `${s.id}:${s.status}`);

    // Bank 3의 작업 하나가 승인 대기로
    store.setChildStatus('perf/loadtest-v3', 'perf/loadtest-v3/runner', Status.WAITING_APPROVAL);
    await rig.scheduler.idle();

    const snap = rig.bridge.render();
    assert.equal(snap.bank, 0, '보고 있는 묶음은 그대로');
    assert.deepEqual(snap.slots.map((s) => `${s.id}:${s.status}`), quietSlots, '보이는 6키 불변');
    // 정책 계층은 여전히 개입을 알린다
    assert.equal(snap.lighting.ambientZone.color, 'orange', 'underglow 정책이 개입(승인 = 주황, 2026-10-10)을 알린다');
    assert.equal(snap.attentionCount, 1);

    // 장치 표현은 실기 capability를 따른다.
    // 실기 16차: 언더글로우는 가상 스레드(id 13 + sa)로 보낼 수 있다.
    const scene = rig.device.lastScene();
    assert.ok(scene.ambientZone, '가상 스레드로 언더글로우를 보낸다 (16차)');
    assert.equal(scene.unsupported.includes('ambientZone'), false);
  });

  it('E02b 보정이 없으면 하드웨어 기능을 전부 미검증으로 둔다', async () => {
    const rig = demoUncalibrated();
    await rig.scheduler.idle();
    const scene = rig.device.lastScene();
    // calibration이 없으면 제어 가능한 키가 하나도 없다 — 추측하지 않는다
    assert.deepEqual(scene.uncontrollableKeys.length, 13);
    assert.ok(scene.unsupported.some((u) => u.startsWith('perKeyColor:')));
  });

  it('E04 재연결 후 최신 상태 전체가 다시 적용된다', async () => {
    const rig = demoCalibrated();
    await rig.scheduler.idle();
    rig.device.disconnect();
    rig.store.setChildStatus('core/logging-cleanup', 'core/logging-cleanup/codex', Status.ERROR);
    await rig.scheduler.idle();
    assert.notEqual(rig.device.lastScene().revision, rig.store.revision);

    rig.device.reconnect();
    rig.bus.emit(Events.DEVICE_CONNECTED, {});
    await rig.scheduler.idle();
    assert.equal(rig.device.lastScene().revision, rig.store.revision);
    assert.equal(rig.scheduler.inSync, true);
  });

  it('E05 데모 전 구간에서 파괴적 명령이나 승인 전송이 없다', async () => {
    const rig = demoCalibrated();
    await rig.scheduler.idle();
    await rig.joystick('right');
    await rig.tap('attention');
    await rig.tap('ack');
    await rig.tap('slot1');
    await rig.hold('slot2');
    await rig.tap('mode_back');
    await rig.joystick('down');
    await rig.joystick('left');

    const payload = JSON.stringify({
      focus: rig.focusRouter.calls,
    });
    for (const banned of ['kubectl', 'helm', 'argo', 'rm -rf', 'apply', 'delete', 'scale',
                          'approve', 'yes', 'Enter', 'submit']) {
      assert.equal(payload.includes(banned), false, `${banned} 가 전송 경로에 있으면 안 된다`);
    }
  });
});
