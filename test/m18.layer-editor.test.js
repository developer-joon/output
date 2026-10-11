/**
 * M18 — 레이어 편집 고도화 (2026-10-09 사용자 요청).
 * 이름 자동(단축키·앱 열기·앞 창 위치), 반복 기본 켬, 앱 목록 묶음, 중단·모름 표시.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { actionLabel, autoLabel } from '../src/apps/actionLabel.js';
import { checkAction } from '../src/apps/appKeys.js';
import { buildKeyMap } from '../src/service/uiModel.js';

describe('M18 / 이름 자동', () => {
  it('A01 이름을 비우면: 단축키는 기호(⌘⇧]), 앱 열기는 앱 이름, 앞 창 위치는 위치 이름', () => {
    assert.equal(autoLabel({ type: 'shortcut', keystroke: 'cmd+shift+]' }), '⌘⇧]');
    assert.equal(autoLabel({ type: 'shortcut', keystroke: 'left' }), '←');
    assert.equal(autoLabel({ type: 'openApp', bundleId: 'com.tinyspeck.slackmacgap', appName: 'Slack' }), 'Slack');
    assert.equal(autoLabel({ type: 'moveWindow', position: 'left' }), '창 왼쪽 절반');
    assert.equal(autoLabel({ type: 'shortcut', keystroke: '???' }), '');
    assert.equal(autoLabel({ type: 'openUrl', url: 'https://x' }), '');
  });
  it('A02 actionLabel: 직접 넣은 이름이 우선, 없으면 자동, 그것도 없으면 동작 종류', () => {
    assert.equal(actionLabel({ type: 'shortcut', label: '탭 닫기', keystroke: 'cmd+w' }), '탭 닫기');
    assert.equal(actionLabel({ type: 'shortcut', label: '', keystroke: 'cmd+w' }), '⌘W');
    assert.equal(actionLabel({ type: 'openUrl', label: '', url: 'https://x' }), 'URL 열기');
  });
  it('A03 검사: 단축키·앱 열기·앞 창 위치는 이름이 없어도 되고, 그 밖의 동작은 이름이 필요하다', () => {
    const errs = [];
    checkAction('key1', { type: 'shortcut', label: '', keystroke: 'cmd+w' }, 'L', errs);
    checkAction('key2', { type: 'openApp', label: '', bundleId: 'com.apple.Safari', appName: 'Safari' }, 'L', errs);
    checkAction('key3', { type: 'moveWindow', label: '', position: 'left', display: 'main' }, 'L', errs);
    assert.deepEqual(errs, []);
    checkAction('key4', { type: 'openUrl', label: '', url: 'https://x' }, 'L', errs);
    assert.equal(errs.length, 1);
    assert.match(errs[0], /이름이 없습니다/);
  });
  it('A04 상태판 키 그림도 자동 이름을 쓴다', () => {
    const map = buildKeyMap({ mode: 'app', scene: { keys: {} }, titles: [],
      slots: { key3: { type: 'shortcut', label: '', keystroke: 'cmd+k' }, dial_cw: { type: 'moveWindow', label: '', position: 'right' } } });
    assert.equal(map.cells.find((c) => c.id === 'key3').labelKo, '⌘K');
    assert.equal(map.dial.cw, '창 오른쪽 절반');
  });
});

import { parseInstalledApps } from '../src/service/macos.js';
import { groupApps } from '../src/apps/appGroups.js';

describe('M18 / 앱 목록', () => {
  it('B01 설치된 앱: mdfind 경로 + mdls 결과 → {bundleId, name}, 앱 안의 도우미 앱·ID 없는 것은 뺀다, 이름순', () => {
    const paths = ['/Applications/Safari.app', '/Applications/Xcode.app/Contents/Applications/Instruments.app', '/System/Applications/Calendar.app', '/Applications/Broken.app'];
    const mdls = [
      'kMDItemCFBundleIdentifier = "com.apple.Safari"', 'kMDItemDisplayName        = "Safari"',
      'kMDItemCFBundleIdentifier = "com.apple.iCal"', 'kMDItemDisplayName        = "캘린더"',
      'kMDItemCFBundleIdentifier = (null)', 'kMDItemDisplayName        = "Broken"',
    ].join('\n');
    assert.deepEqual(parseInstalledApps(paths, mdls), [
      { bundleId: 'com.apple.Safari', name: 'Safari' },
      { bundleId: 'com.apple.iCal', name: '캘린더' },
    ]);
  });
  it('B02 묶음: 최근 연결 → 실행 중 → 설치됨, 앞 묶음에 있으면 뒤에서 빼고, 우리 앱(Output)은 뺀다', () => {
    const layers = [
      { apps: [{ bundleId: 'com.google.Chrome', name: 'Google Chrome' }], keys: { key1: { type: 'openApp', bundleId: 'com.tinyspeck.slackmacgap', appName: 'Slack' }, key2: { type: 'layout', items: [{ bundleId: 'com.apple.Safari', appName: 'Safari' }] } }, dial: {}, joystick: { short: {}, long: {} } },
    ];
    const g = groupApps({
      layers,
      running: [{ bundleId: 'com.google.Chrome', name: 'Google Chrome' }, { bundleId: 'com.apple.finder', name: 'Finder' }],
      installed: [{ bundleId: 'com.apple.finder', name: 'Finder' }, { bundleId: 'com.apple.iCal', name: '캘린더' }, { bundleId: 'dev.output.keypad', name: 'Output' }],
      exclude: ['dev.output.keypad'],
    });
    assert.deepEqual(g.map((x) => [x.labelKo, x.apps.map((a) => a.bundleId)]), [
      ['최근 연결', ['com.google.Chrome', 'com.tinyspeck.slackmacgap', 'com.apple.Safari']],
      ['실행 중', ['com.apple.finder']],
      ['설치된 앱', ['com.apple.iCal']],
    ]);
  });
});

import { Status, StatusLabelKo, isAttention } from '../src/core/types.js';
import { statusOfAgent } from '../src/adapters/orca/agentState.js';
import { aggregateUnitStatus } from '../src/core/policy.js';
import { threadStyleFor, AMBIENT_STYLE } from '../src/core/lightingPolicy.js';

describe('M18 / 중단됨 · 상태 모름', () => {
  it('C01 중단된 에이전트는 "중단됨" — 개입 대상이 아니고 언더글로우를 빨갛게 하지 않는다, LED는 흐린 회색', () => {
    assert.equal(statusOfAgent({ state: 'done', interrupted: true }), Status.INTERRUPTED);
    assert.equal(StatusLabelKo[Status.INTERRUPTED], '중단됨');
    assert.equal(isAttention(Status.INTERRUPTED), false);
    assert.equal(AMBIENT_STYLE[Status.INTERRUPTED].color, 'neutral_gray', '언더글로우도 키와 같은 회색 (2026-10-10)');
    assert.equal(threadStyleFor(Status.INTERRUPTED).color, 'neutral_gray');
  });
  it('C02 작업 대표 상태: 진행 중이 있으면 진행 중, 아니면 미확인 완료 > 중단됨 > 확인한 완료', () => {
    const child = (status) => ({ status, requiredForCompletion: true });
    assert.equal(aggregateUnitStatus({ children: [child(Status.INTERRUPTED), child(Status.DONE_SEEN)] }), Status.INTERRUPTED);
    assert.equal(aggregateUnitStatus({ children: [child(Status.INTERRUPTED), child(Status.RUNNING)] }), Status.RUNNING);
    assert.equal(aggregateUnitStatus({ children: [child(Status.INTERRUPTED), child(Status.DONE_UNSEEN)] }), Status.DONE_UNSEEN);
  });
  it('C03 모름은 "상태 모름"이고, 키 그림 설명에 무엇을 하면 되는지 나온다', () => {
    assert.equal(StatusLabelKo[Status.UNKNOWN], '상태 모름');
    const map = buildKeyMap({ mode: 'orca', scene: { keys: {} }, slots: {}, titles: ['x'], statuses: ['상태 모름'],
      hints: ['Orca가 이 작업의 상태를 아직 알려 주지 않았습니다. 터미널을 열어 확인하세요.'] });
    assert.match(map.cells.find((c) => c.id === 'key1').title, /터미널을 열어 확인/);
  });
});

import { pickKeyColor, KEY_COLOR_PALETTE } from '../src/apps/keyLed.js';

describe('M18 / 키 LED 기본 색은 무작위', () => {
  it('E01 팔레트에서 고르고, 레이어에서 이미 쓰는 색은 피한다 — 다 쓰면 아무거나', () => {
    assert.ok(KEY_COLOR_PALETTE.length >= 8);
    for (const c of KEY_COLOR_PALETTE) assert.match(c, /^#[0-9A-F]{6}$/);
    const used = KEY_COLOR_PALETTE.slice(0, -1);
    assert.equal(pickKeyColor(used, () => 0.99), KEY_COLOR_PALETTE.at(-1), '남은 하나');
    assert.equal(pickKeyColor(used.map((c) => c.toLowerCase()), () => 0), KEY_COLOR_PALETTE.at(-1), '대소문자 무관');
    assert.ok(KEY_COLOR_PALETTE.includes(pickKeyColor(KEY_COLOR_PALETTE, () => 0.5)));
    assert.notEqual(pickKeyColor([], () => 0), pickKeyColor([], () => 0.99), '무작위');
  });
});
