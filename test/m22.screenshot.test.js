/**
 * M22 — 화면 캡처 동작 (2026-10-10 사용자 요청: 모니터가 여럿일 때 특정 모니터만 찍는 키).
 * macOS screencapture -D n (1 = 주 모니터). 저장: macOS 스크린샷 위치(없으면 데스크탑) · 클립보드 · 둘 다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAction, checkAction } from '../src/apps/appKeys.js';
import { autoLabel, actionLabel } from '../src/apps/actionLabel.js';
import { screenshotArgs, screenshot } from '../src/service/macos.js';
import { ActionRunner } from '../src/apps/actionRunner.js';

const AT = new Date(2026, 9, 10, 14, 5, 9);

describe('M22 / 화면 캡처 동작', () => {
  it('C01 저장 형식: 모니터(주·2~4)와 저장 위치(데스크탑·클립보드·둘 다), 모르는 값은 기본(주 모니터·데스크탑)', () => {
    assert.deepEqual(normalizeAction({ type: 'screenshot', label: '', display: 2, save: 'clipboard' }), { type: 'screenshot', label: '', display: 2, save: 'clipboard' });
    assert.deepEqual(normalizeAction({ type: 'screenshot', display: 9, save: 'x' }), { type: 'screenshot', label: '', display: 'main', save: 'desktop' });
    // 세 동작 모두 같은 번호 (2026-10-12): 1 = 주 모니터('main'), 2~6
    assert.equal(normalizeAction({ type: 'screenshot', display: 6 }).display, 6);
    assert.equal(normalizeAction({ type: 'moveWindow', position: 'left', display: 1 }).display, 'main');
    assert.equal(normalizeAction({ type: 'moveWindow', position: 'left', display: 3 }).display, 3);
    assert.equal(normalizeAction({ type: 'layout', items: [{ display: 7 }] }).items[0].display, 'main');
    const errs = [];
    checkAction('key1', normalizeAction({ type: 'screenshot', display: 3, save: 'both' }), 'L', errs);
    assert.deepEqual(errs, [], '이름이 없어도 된다 (자동 이름)');
  });
  it('C02 자동 이름: 캡처 — 주 모니터 / 모니터 2, 클립보드면 (클립보드), 둘 다면 (+ 클립보드)', () => {
    assert.equal(autoLabel({ type: 'screenshot', display: 'main', save: 'desktop' }), '캡처 — 주 모니터');
    assert.equal(autoLabel({ type: 'screenshot', display: 2, save: 'clipboard' }), '캡처 — 모니터 2 (클립보드)');
    assert.equal(autoLabel({ type: 'screenshot', display: 3, save: 'both' }), '캡처 — 모니터 3 (+ 클립보드)');
    assert.equal(actionLabel({ type: 'screenshot', label: '왼쪽 화면', display: 2, save: 'desktop' }), '왼쪽 화면');
  });
  it('C03 screencapture 인자: -D 번호, 파일은 폴더/스크린샷 날짜 시각 (모니터 n).png, 클립보드는 -c', () => {
    assert.deepEqual(screenshotArgs({ display: 'main', save: 'desktop' }, '/d', AT), [['-D', '1', '/d/스크린샷 2026-10-10 14.05.09 (주 모니터).png']]);
    assert.deepEqual(screenshotArgs({ display: 2, save: 'clipboard' }, '/d', AT), [['-c', '-D', '2']]);
    assert.deepEqual(screenshotArgs({ display: 3, save: 'both' }, '/d', AT), [['-D', '3', '/d/스크린샷 2026-10-10 14.05.09 (모니터 3).png'], ['-c', '-D', '3']]);
  });
  it('C04 저장 폴더: macOS 스크린샷 위치(~ 펼침)를 따르고, 없으면 데스크탑. 없는 모니터·권한 실패는 이유를 돌려준다', async () => {
    const calls = [];
    const runner = (loc, cap = { code: 0, stderr: '' }) => async (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'defaults') return loc ? { code: 0, stdout: `${loc}\n`, stderr: '' } : { code: 1, stdout: '', stderr: 'does not exist' };
      return { stdout: '', ...cap };
    };
    assert.deepEqual(await screenshot({ display: 2, save: 'desktop' }, { runner: runner('~/Pictures/Shots'), home: '/Users/u', now: () => AT }), { ok: true, reasonKo: '' });
    assert.equal(calls.at(-1)[1].at(-1), '/Users/u/Pictures/Shots/스크린샷 2026-10-10 14.05.09 (모니터 2).png');
    await screenshot({ display: 'main', save: 'desktop' }, { runner: runner(null), home: '/Users/u', now: () => AT });
    assert.match(calls.at(-1)[1].at(-1), /^\/Users\/u\/Desktop\//);
    const bad = await screenshot({ display: 4, save: 'clipboard' }, { runner: runner(null, { code: 1, stderr: 'screencapture: Invalid display specified' }), home: '/Users/u', now: () => AT });
    assert.deepEqual(bad, { ok: false, reasonKo: '모니터 4가 연결되어 있지 않습니다.' });
    const denied = await screenshot({ display: 2, save: 'clipboard' }, { runner: runner(null, { code: 1, stderr: 'could not create image from display' }), home: '/Users/u', now: () => AT });
    assert.match(denied.reasonKo, /화면 및 시스템 오디오 녹음/);
  });
  it('C05 실행기: 앞 앱 확인 없이(키 입력이 아님) 캡처를 부르고 결과를 그대로', async () => {
    const got = [];
    const r = new ActionRunner({ exec: { screenshot: async (a) => { got.push(a); return { ok: true, reasonKo: '' }; } },
      frontmost: async () => 'com.other', displays: () => [], ownBundleIds: [], sleep: async () => {} });
    r.notePhysical('key1');
    const res = await r.run('key1', { type: 'screenshot', label: '', display: 2, save: 'desktop' }, { kind: 'app', bundleId: 'com.x' });
    assert.equal(res.ok, true);
    assert.deepEqual(got, [{ type: 'screenshot', label: '', display: 2, save: 'desktop' }]);
  });
});
