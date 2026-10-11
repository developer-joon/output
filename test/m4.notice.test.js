/**
 * M4.2 — 새 개입 알림(깜빡).
 *
 * 승인이 연달아 오면 상태 값은 그대로 WAITING_APPROVAL이라 색이 변하지 않는다.
 * "아직 그대로다"와 "새로 생겼다"는 사람에게 다른 사건이므로 짧게 점멸해 알린다.
 * 색은 바꾸지 않는다 — 상태를 잘못 말하지 않기 위해서다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  NOTICE_WINDOW_MS, NOTICE_BLINK_MS, freshNoticeSlots, noticeOverlay,
} from '../src/core/attentionNotice.js';
import { buildDeviceScene } from '../src/device/deviceScene.js';
import { Status } from '../src/core/types.js';
import { StateStore } from '../src/core/stateStore.js';
import { WorkUnit, ChildUnit } from '../src/core/units.js';
import { Output } from '../src/output.js';

const NOW = 1_000_000;

const slot = (status, attentionSince = 0) => ({ status, attentionSince });

describe('M4.2 / 새 개입 알림 — 순수 판정', () => {
  it('N01 방금 들어온 개입은 알림 대상이다', () => {
    const slots = [slot(Status.WAITING_APPROVAL, NOW - 200)];
    assert.deepEqual(freshNoticeSlots({ slots, now: NOW }), [0]);
  });

  it('N02 창이 지나면 알림이 끝난다', () => {
    const slots = [slot(Status.WAITING_APPROVAL, NOW - NOTICE_WINDOW_MS - 1)];
    assert.deepEqual(freshNoticeSlots({ slots, now: NOW }), []);
  });

  it('N03 개입 상태가 아니면 알리지 않는다 — 완료는 깜빡이지 않는다', () => {
    const slots = [
      slot(Status.DONE_UNSEEN, NOW - 100),
      slot(Status.RUNNING, NOW - 100),
      slot(Status.EMPTY, NOW - 100),
    ];
    assert.deepEqual(freshNoticeSlots({ slots, now: NOW }), []);
  });

  it('N04 시각이 없으면 알리지 않는다 — 모르면 조용히 있는다', () => {
    const slots = [slot(Status.WAITING_APPROVAL, 0), slot(Status.ERROR)];
    assert.deepEqual(freshNoticeSlots({ slots, now: NOW }), []);
  });

  it('N05 여러 개가 동시에 새로 들어오면 전부 알린다', () => {
    const slots = [
      slot(Status.WAITING_APPROVAL, NOW - 100),
      slot(Status.RUNNING, NOW - 100),
      slot(Status.ERROR, NOW - 100),
    ];
    assert.deepEqual(freshNoticeSlots({ slots, now: NOW }), [0, 2]);
  });

  it('N06 경과 시간으로 켜짐/꺼짐을 번갈아 한다 — 색은 바꾸지 않는다', () => {
    assert.equal(noticeOverlay(0).off, false);
    assert.equal(noticeOverlay(NOTICE_BLINK_MS).off, true);
    assert.equal(noticeOverlay(NOTICE_BLINK_MS * 2).off, false);
    assert.equal(noticeOverlay(NOTICE_BLINK_MS * 3).off, true);
  });

  it('N06b 창 안에서 최소 네 번은 깜빡인다 — 한 번 꺼지는 것은 깜빡임이 아니다', () => {
    let toggles = 0;
    let prev = noticeOverlay(0).off;
    for (let t = 0; t < NOTICE_WINDOW_MS; t += 10) {
      const cur = noticeOverlay(t).off;
      if (cur !== prev) toggles += 1;
      prev = cur;
    }
    assert.ok(toggles >= 4, `토글 ${toggles}회 — 눈에 띄려면 4회 이상이어야 한다`);
  });

  it('N06c 슬롯마다 자기 시각으로 깜빡인다 — 시계 위상에 끌려가지 않는다', () => {
    // 같은 경과면 같은 결과. 전역 위상 같은 외부 상태에 의존하지 않는다.
    assert.equal(noticeOverlay(75).off, noticeOverlay(75).off);
    assert.notEqual(noticeOverlay(0).off, noticeOverlay(NOTICE_BLINK_MS).off);
  });
});

describe('M4.2 / 새 개입 알림 — scene', () => {
  const snapshotWith = (slots, threads) => ({
    revision: 1,
    view: 'GLOBAL',
    slots,
    attentionCount: 1,
    hiddenAttentionCount: 0,
    lighting: {
      threads,
      ambientZone: { color: 'off', brightness: 0, pattern: 'off' },
    },
    miniLeds: {},
  });

  const caps = { supportsAmbientZone: false };
  const orange = { color: 'orange', brightness: 0.78, pattern: 'breathing' };

  it('N07 새 개입이면 scene이 알림을 켠다', () => {
    const snap = snapshotWith([slot(Status.WAITING_APPROVAL, NOW - 20)], [orange]);
    const scene = buildDeviceScene(snap, caps, { ambientPhase: 0, now: NOW });
    assert.equal(scene.notice.active, true);
    assert.deepEqual(scene.notice.targets, ['slot1']);
  });

  it('N08 꺼짐 위상에서 그 슬롯만 꺼진다', () => {
    const snap = snapshotWith(
      [slot(Status.WAITING_APPROVAL, NOW - NOTICE_BLINK_MS), slot(Status.RUNNING, 0)],
      [orange, { color: 'blue', brightness: 0.3, pattern: 'solid' }],
    );
    const scene = buildDeviceScene(snap, caps, { ambientPhase: 0, now: NOW });
    assert.equal(scene.keys.slot1.brightness, 0);
    assert.equal(scene.keys.slot1.noticePulse, true);
    assert.equal(scene.keys.slot2.color, 'blue', '다른 슬롯은 건드리지 않는다');
  });

  it('N09 켜짐 위상에서는 정책 색 그대로다', () => {
    const snap = snapshotWith([slot(Status.WAITING_APPROVAL, NOW - 20)], [orange]);
    const scene = buildDeviceScene(snap, caps, { ambientPhase: 0, now: NOW });
    assert.equal(scene.keys.slot1.color, 'orange');
    assert.equal(scene.keys.slot1.brightness, 0.78);
  });

  it('N10 창이 지나면 알림이 꺼지고 정책 색으로 돌아온다', () => {
    const snap = snapshotWith(
      [slot(Status.WAITING_APPROVAL, NOW - NOTICE_WINDOW_MS - 1)], [orange],
    );
    const scene = buildDeviceScene(snap, caps, { ambientPhase: 0, now: NOW });
    assert.equal(scene.notice.active, false);
    assert.equal(scene.keys.slot1.brightness, 0.78);
  });

  it('N11 백라이트는 건드리지 않는다 (LIGHTING_POLICY 금지)', () => {
    const snap = snapshotWith([slot(Status.WAITING_APPROVAL, NOW - 100)], [orange]);
    const a = buildDeviceScene(snap, caps, { ambientPhase: 0, now: NOW });
    const b = buildDeviceScene(snap, caps, { ambientPhase: 0, now: NOW + NOTICE_BLINK_MS });
    assert.deepEqual(a.keys.A1, b.keys.A1);
  });
});

describe('M4.2 / 새 개입 알림 — 스냅샷 배선', () => {
  it('N12 render()가 슬롯별 개입 진입 시각을 싣는다', () => {
    const store = new StateStore();
    store.addUnit(new WorkUnit({
      id: 'u1',
      title: 'sample-app',
      source: 'orca',
      status: Status.RUNNING,
      children: [new ChildUnit({ id: 'c1', title: 'codex', status: Status.RUNNING })],
    }));
    store.setChildStatus('u1', 'c1', Status.WAITING_APPROVAL, { waitingSince: 777 });

    const bridge = new Output({ store });
    assert.equal(bridge.render().slots[0].attentionSince, 777);
  });

  it('N13 개입이 아니면 진입 시각은 0이다', () => {
    const store = new StateStore();
    store.addUnit(new WorkUnit({
      id: 'u1',
      title: 'sample-app',
      source: 'orca',
      status: Status.RUNNING,
      children: [new ChildUnit({ id: 'c1', title: 'codex', status: Status.RUNNING })],
    }));
    const bridge = new Output({ store });
    assert.equal(bridge.render().slots[0].attentionSince, 0);
  });
});

describe('M4.2 / 새 개입 알림 — 점멸 시계', () => {
  it('N14 알림 시계는 ambient 시계보다 빠르다', async () => {
    const { NOTICE_TICK_MS } = await import('../src/device/renderScheduler.js');
    const { DEFAULT_PERIOD_MS } = await import('../src/core/ambientFallback.js');
    assert.ok(
      NOTICE_TICK_MS < DEFAULT_PERIOD_MS / 8,
      '알림을 ambient 주기로 그리면 창 안에서 한 번밖에 못 바뀐다',
    );
    assert.ok(NOTICE_TICK_MS <= NOTICE_BLINK_MS, '반주기보다 촘촘히 그려야 깜빡임이 보인다');
  });
});
