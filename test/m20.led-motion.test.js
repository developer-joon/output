/**
 * M20 — LED 움직임 (2026-10-10 사용자 요청): 상태별 움직임, 연결 인사·재연결 알림, 레이어 언더글로우.
 * 실기 근거(2026-10-10): 키·언더글로우 모두 e 6 숨쉬기 · 3 회전·색 변화 · 4 꺼졌다 켜짐. 언더글로우는 b:1이 있어야 켜진다.
 * 규칙: 오류와 개입은 색이 구분된다 (개입 = 주황·살구, 오류 = 빨강).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Status } from '../src/core/types.js';
import { THREAD_STYLE, AMBIENT_STYLE, AMBIENT_NORMAL, ambientStyleFor } from '../src/core/lightingPolicy.js';
import { DeviceDriver, PATTERN_PARAMS, slimEntry } from '../src/device/deviceDriver.js';
import { buildDeviceScene, LOGICAL_KEYS } from '../src/device/deviceScene.js';
import { normalizeLayers, defaultLayers } from '../src/apps/layers.js';
import { connectFlash } from '../src/device/connectFlash.js';

const CAL = JSON.parse(readFileSync(new URL('../config/calibration.json', import.meta.url), 'utf8'));
const pat = (st) => [st.color, st.pattern];

describe('M20 / 상태별 움직임', () => {
  it('L01 작업 키: 개입은 그 색 빠른 숨쉬기, 진행 중 보통 숨쉬기, 오류 빨강 빠른 깜박임, 완료·미확인 느린 숨쉬기', () => {
    assert.deepEqual(pat(THREAD_STYLE[Status.WAITING_APPROVAL]), ['orange', 'breathing_fast']);
    assert.deepEqual(pat(THREAD_STYLE[Status.WAITING_INPUT]), ['apricot', 'breathing_fast']);
    assert.deepEqual(pat(THREAD_STYLE[Status.RUNNING]), ['amber', 'breathing']);
    assert.deepEqual(pat(THREAD_STYLE[Status.ERROR]), ['red', 'blink_fast']);
    assert.deepEqual(pat(THREAD_STYLE[Status.DONE_UNSEEN]), ['teal', 'breathing_slow']);
    assert.deepEqual(pat(THREAD_STYLE[Status.DONE_SEEN]), ['green', 'solid'], '아무것도 안 할 때 키는 그대로');
  });
  it('L02 언더글로우: 승인 주황·답변 살구 빠른 숨쉬기, 오류 빨강 빠른 깜박임, 진행 중 호박 회전, 완료·미확인 청록 고정, 평온 초록 느린 숨쉬기', () => {
    assert.deepEqual(pat(AMBIENT_STYLE[Status.WAITING_APPROVAL]), ['orange', 'breathing_fast']);
    assert.deepEqual(pat(AMBIENT_STYLE[Status.WAITING_INPUT]), ['apricot', 'breathing_fast']);
    assert.deepEqual(pat(AMBIENT_STYLE[Status.ERROR]), ['red', 'blink_fast']);
    assert.deepEqual(pat(AMBIENT_STYLE[Status.RUNNING]), ['amber', 'rotate']);
    assert.deepEqual(pat(AMBIENT_STYLE[Status.DONE_UNSEEN]), ['teal', 'solid']);
    assert.deepEqual(pat(AMBIENT_NORMAL), ['green', 'breathing_slow']);
    assert.deepEqual(pat(ambientStyleFor(null)), ['green', 'breathing_slow']);
  });
  it('L03 오류와 개입은 색이 다르다 — 키·언더글로우 모두, 상태 모름도 빨강이 아니다', () => {
    for (const table of [THREAD_STYLE, AMBIENT_STYLE]) {
      const err = table[Status.ERROR].color;
      for (const s of [Status.WAITING_APPROVAL, Status.WAITING_INPUT, Status.UNKNOWN, Status.STALE, Status.DISCONNECTED]) {
        assert.notEqual(table[s].color, err, `${s}`);
      }
    }
  });
  it('L04 움직임 이름 → 장치 e·s (키·언더글로우 같은 표)', () => {
    assert.deepEqual(PATTERN_PARAMS.breathing_fast, { e: 6, s: 0.9 });
    assert.deepEqual(PATTERN_PARAMS.breathing, { e: 6, s: 0.5 });
    assert.deepEqual(PATTERN_PARAMS.breathing_slow, { e: 6, s: 0.25 });
    assert.deepEqual(PATTERN_PARAMS.blink_fast, { e: 4, s: 0.9 });
    assert.deepEqual(PATTERN_PARAMS.rotate, { e: 3, s: 0.5 });
    const d = new DeviceDriver({ calibration: CAL, send: async () => {} });
    const p = d.toPayload({ keys: { slot1: { color: 'red', brightness: 1, pattern: 'blink_fast' } }, ambientZone: { color: 'amber', brightness: 1, pattern: 'rotate' } }).payload;
    assert.deepEqual([p[0].e, p[0].s], [4, 0.9]);
    assert.deepEqual(slimEntry(p.at(-1)), { id: 13, c: 0xffbf00, b: 1, e: 3, s: 0.5, sa: 1 });
    // 언더글로우도 키처럼 e·s를 직접 받는다 (레이어 언더글로우 설정)
    const q = d.toPayload({ keys: {}, ambientZone: { color: '#123456', brightness: 1, e: 4, s: 0.3 } }).payload;
    assert.deepEqual([q.at(-1).e, q.at(-1).s], [4, 0.3]);
  });
});

describe('M20 / 레이어 언더글로우', () => {
  it('L05 저장: 사용자 레이어는 underglow를 읽고(잘못된 값은 기본으로), 색은 늘 레이어 색(2026-10-10 합침), 없으면 null, Orca 프리셋 레이어는 늘 null', () => {
    const base = defaultLayers();
    const raw = structuredClone(base);
    raw[0].underglow = { color: '#123456', effect: 'blink', speed: 'fast', brightness: 'high' };
    raw[1].underglow = { color: '#123456', effect: 'blink', speed: 'fast', brightness: 'high' };   // Orca 프리셋
    raw.push({ id: 'l-x', kind: 'user', name: 'X', color: '#E8762B', preset: null, apps: [], keys: {}, dial: {}, joystick: {}, underglow: { color: 'nope', effect: 'zzz' } });
    const ls = normalizeLayers(raw);
    assert.deepEqual(ls.find((l) => l.id === 'default').underglow, { color: 'layer', effect: 'blink', speed: 'fast', brightness: 'high' });
    assert.equal(ls.find((l) => l.preset === 'orca').underglow, null);
    assert.deepEqual(ls.find((l) => l.id === 'l-x').underglow, { color: 'layer', effect: 'solid', speed: 'normal', brightness: 'high' });
    assert.equal(normalizeLayers(base).find((l) => l.id === 'default').underglow, null);
  });
  it('L06 앱 레이어 장면: 언더글로우는 Orca 상태가 아니라 레이어 설정, 없으면 레이어 색 고정', () => {
    const snap = (underglow) => ({ revision: 1, active: false, lighting: { ambientZone: { color: 'red', brightness: 1, pattern: 'breathing_fast' } },
      appMode: { kind: 'app', name: 'A', color: '#E8762B', assigned: [], keyLeds: {}, underglow } });
    assert.deepEqual(buildDeviceScene(snap(null)).ambientZone, { color: '#E8762B', brightness: 1, e: 1, s: 0.6 });
    assert.deepEqual(buildDeviceScene(snap({ color: '#112233', brightness: 0.25, e: 6, s: 0.3 })).ambientZone, { color: '#112233', brightness: 0.25, e: 6, s: 0.3 });
  });
});

describe('M20 / 연결 인사', () => {
  it('L07 처음 연결: 1.5초 동안 13키·언더글로우 회전, 그 뒤 없음', () => {
    const f = connectFlash({ reconnect: false, at: 1000 });
    const a = f(1000);
    assert.deepEqual(Object.keys(a.keys), [...LOGICAL_KEYS]);
    assert.equal(a.keys.slot1.pattern, 'rotate');
    assert.equal(a.ambientZone.pattern, 'rotate');
    assert.ok(f(2499));
    assert.equal(f(2500), null);
  });
  it('L08 다시 연결: 1초 빨강 빠른 깜박임 → 1.5초 회전', () => {
    const f = connectFlash({ reconnect: true, at: 0 });
    assert.deepEqual([f(0).keys.slot5.color, f(0).keys.slot5.pattern, f(999).ambientZone.pattern], ['red', 'blink_fast', 'blink_fast']);
    assert.equal(f(1000).keys.slot5.pattern, 'rotate');
    assert.equal(f(2500), null);
    assert.deepEqual(connectFlash({ reconnect: true, at: 0 }).endsAt, [1000, 2500]);
  });
  it('L09 장면: 인사 중에는 대기·앱·Orca 어느 장면이든 인사가 덮는다', () => {
    const flash = connectFlash({ reconnect: false, at: 0 })(0);
    const idle = buildDeviceScene({ revision: 1, active: false, lighting: {} }, {}, { flash });
    assert.equal(idle.inactive, false);
    assert.equal(idle.keys.mode_back.pattern, 'rotate');
    assert.equal(idle.ambientZone.pattern, 'rotate');
  });
  it('L10 서비스: 연결되면 인사, 끊겼다 다시 연결되면 깜박임부터 — 단계가 끝날 때 다시 그린다', async () => {
    const { OutputService } = await import('../src/service/outputService.js');
    const { UNCALIBRATED } = await import('../src/device/calibrationLoader.js');
    const st = { now: 0 };
    const timers = [];
    const s = new OutputService({ calibration: UNCALIBRATED, stateDir: mkdtempSync(path.join(os.tmpdir(), 'cb-m20-')), orcaEnabled: false, now: () => st.now,
      timers: { setInterval: () => 0, clearInterval: () => {}, setTimeout: (fn, ms) => { timers.push(ms); return 0; }, clearTimeout: () => {} },
      openRuntimeTransport: async () => { throw Object.assign(new Error('x'), { code: 'DEVICE_NOT_FOUND' }); }, frontmost: async () => null, ownBundleIds: [] });
    s._startConnectFlash();
    assert.equal(s._flashNow().keys.slot1.pattern, 'rotate');
    assert.deepEqual(timers, [1505]);
    st.now = 5000; timers.length = 0;
    s._startConnectFlash();
    assert.equal(s._flashNow().keys.slot1.pattern, 'blink_fast', '두 번째 연결은 다시 연결');
    assert.deepEqual(timers, [1005, 2505]);
  });
});

import { colorToInt } from '../src/device/deviceDriver.js';
import { COLOR_HEX } from '../src/service/uiModel.js';
import { summarizeAmbient } from '../src/core/policy.js';

describe('M20 / 빠짐없이, 엉뚱한 색 없이 (2026-10-10 사용자 요청)', () => {
  it('L11 모든 상태가 키·언더글로우 규칙을 갖는다 — 평온한 상태(대기·본 완료·빈 칸)는 언더글로우 평온, 중단됨은 회색', () => {
    for (const s of Object.values(Status)) {
      assert.ok(THREAD_STYLE[s], `키 ${s}`);
      assert.ok(Object.hasOwn(AMBIENT_STYLE, s), `언더글로우 ${s}`);
    }
    for (const s of [Status.IDLE, Status.DONE_SEEN, Status.EMPTY]) assert.equal(AMBIENT_STYLE[s], AMBIENT_NORMAL, s);
    assert.deepEqual(pat(AMBIENT_STYLE[Status.INTERRUPTED]), ['neutral_gray', 'solid']);
    assert.equal(THREAD_STYLE[Status.INTERRUPTED].color, AMBIENT_STYLE[Status.INTERRUPTED].color, '키와 같은 회색');
  });
  it('L12 쓰는 색은 모두 장치 색(꺼짐 아님)과 상태판 색이 있다', () => {
    const styles = [...Object.values(THREAD_STYLE), ...Object.values(AMBIENT_STYLE), connectFlash({ reconnect: true, at: 0 })(0).ambientZone, connectFlash({ reconnect: false, at: 0 })(0).ambientZone];
    for (const st of styles) {
      if (st.color === 'off') continue;
      assert.notEqual(colorToInt(st.color, 1), 0, `장치 색 ${st.color}`);
    }
    for (const st of Object.values(THREAD_STYLE)) if (st.color !== 'off') assert.ok(COLOR_HEX[st.color], `상태판 색 ${st.color}`);
  });
  it('L13 언더글로우 대표: 개입 > 진행 중 > 완료·미확인 > 중단됨 > 평온', () => {
    assert.equal(summarizeAmbient([], { hasRunning: true, hasInterrupted: true }), Status.RUNNING);
    assert.equal(summarizeAmbient([], { hasUnseenDone: true, hasInterrupted: true }), Status.DONE_UNSEEN);
    assert.equal(summarizeAmbient([], { hasInterrupted: true }), Status.INTERRUPTED);
    assert.equal(summarizeAmbient([], {}), null);
  });
});

import { ORCA_PRESET } from '../src/apps/presets.js';

describe('M20 / 프리셋 설명', () => {
  it('L14 Orca 프리셋 설명에 언더글로우 규칙이 상태마다 있고, 옛 설명(어느 레이어에서나 같음)은 없다', () => {
    const ug = ORCA_PRESET.info.underglowKo;
    assert.ok(Array.isArray(ug));
    for (const word of ['승인', '답변', '오류', '진행 중', '완료', '중단됨', '평온', '연결']) assert.ok(ug.some((t) => t.includes(word)), word);
    assert.equal(ORCA_PRESET.info.limitsKo.some((t) => /어느 레이어에서나 같/.test(t)), false);
  });
});

describe('M20 / 인사 뒤 꺼진 칸 (실기 2026-10-10: 인사 뒤 안 쓰는 키가 계속 색을 돌렸다)', () => {
  it('L15 꺼진 칸·꺼진 언더글로우도 e:0을 보낸다 — 빼면 장치가 앞의 효과(회전 e:3)를 계속 쓴다', () => {
    assert.deepEqual(slimEntry({ id: 3, c: 0, b: 0, e: 0, s: 0.5, sk: 0, sa: 0 }), { id: 3, c: 0, e: 0 });
    assert.deepEqual(slimEntry({ id: 13, c: 0, b: 0, e: 0, s: 0.5, sk: 0, sa: 1 }), { id: 13, c: 0, e: 0, sa: 1 });
    // 인사(회전) 다음 장면: 꺼진 키는 모두 e:0
    const sent = [];
    const d = new DeviceDriver({ calibration: CAL, send: async (p) => { sent.push(p); } });
    return (async () => {
      await d.applyScene({ ...connectFlash({ reconnect: false, at: 0 })(0), revision: 1 });
      await d.applyScene({ revision: 2, keys: { slot1: { color: 'amber', brightness: 1, pattern: 'solid' } }, ambientZone: null });
      assert.ok(sent[0].every((e) => e.e === 3), '인사는 회전');
      for (const e of sent[1].slice(1)) assert.equal(e.e, 0, `id ${e.id}`);
    })();
  });
});

import { pickKeyColor as pickC, KEY_COLOR_PALETTE as PAL } from '../src/apps/keyLed.js';

describe('M20 / 레이어 색 = 언더글로우 색 (2026-10-10)', () => {
  it('L16 앱 레이어의 언더글로우는 레이어 색을 쓴다 — 예전에 따로 저장한 색은 버리고 움직임·밝기·속도만 남긴다', async () => {
    const { OutputService } = await import('../src/service/outputService.js');
    const { UNCALIBRATED } = await import('../src/device/calibrationLoader.js');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cb-m20b-'));
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path.join(dir, 'profiles.json'), JSON.stringify({ version: 6, layers: [{ id: 'default', kind: 'default', name: '기본', color: '#5A8CDC', preset: null, apps: [], keys: { key1: { type: 'shortcut', label: '', keystroke: 'cmd+k' } }, dial: {},
      joystick: {}, underglow: { color: '#FF0000', effect: 'breathe', speed: 'slow', brightness: 'low' } }] }));
    const s = new OutputService({ calibration: UNCALIBRATED, stateDir: dir, orcaEnabled: false,
      openRuntimeTransport: async () => { throw Object.assign(new Error('x'), { code: 'DEVICE_NOT_FOUND' }); }, frontmost: async () => 'com.apple.TextEdit', ownBundleIds: [] });
    await s.watcher.tick();
    const z = buildDeviceScene(s.bridge.render()).ambientZone;
    assert.deepEqual([z.color, z.e, z.s, z.brightness], ['#5A8CDC', 6, 0.3, 0.3]);
  });
  it('L17 새 레이어 색은 다른 레이어와 겹치지 않게 팔레트에서 고른다', () => {
    const used = PAL.slice(0, 4);
    for (let i = 0; i < 20; i += 1) assert.equal(used.includes(pickC(used)), false);
  });
});

describe('M20 / Orca 밝기 기존의 3배 (2026-10-11 사용자 요청: 너무 어둡지만 전부 100%는 아니다)', () => {
  it('L18 작업 칸 키는 기존의 3배(최대 100%), 언더글로우는 3배가 모두 100%를 넘어 100%', () => {
    const want = { RUNNING: 0.96, WAITING_INPUT: 1, WAITING_APPROVAL: 1, DONE_UNSEEN: 1, DONE_SEEN: 0.6, ERROR: 1, STALE: 0.9, UNKNOWN: 0.9, DISCONNECTED: 0.9, IDLE: 0.18, INTERRUPTED: 0.45, EMPTY: 0 };
    for (const [k, v] of Object.entries(want)) assert.equal(THREAD_STYLE[Status[k]].brightness, v, `키 ${k}`);
    for (const [s, st] of Object.entries(AMBIENT_STYLE)) assert.equal(st.brightness, 1, `언더글로우 ${s}`);
    assert.equal(AMBIENT_NORMAL.brightness, 1);
  });
});
