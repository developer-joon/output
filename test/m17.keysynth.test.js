/**
 * M17 — 빠른 키 입력 JS 쪽 (2026-10-09). 네이티브 모듈은 가짜로 바꿔 끼운다 (실제 키를 보내지 않는다).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createKeySynth, MOD_FLAGS } from '../src/service/keySynth.js';
import { synthKeystroke } from '../src/service/macos.js';

function fakeNative({ trusted = true, map = { c: { keyCode: 8, shift: false }, '?': { keyCode: 44, shift: true } }, postOk = true } = {}) {
  const posts = [];
  return {
    posts,
    post: (code, flags, down) => { posts.push([code, flags, down]); return postOk; },
    keyCodeFor: (ch) => map[ch] ?? null,
    repeatTiming: () => ({ delayMs: 375, intervalMs: 83 }),
    trusted: () => trusted,
  };
}

describe('M17 / keySynth', () => {
  it('S01 ⌘C: 보조키 flags, 누름·뗌 두 번', () => {
    const n = fakeNative(); const k = createKeySynth(n);
    assert.equal(k.available, true);
    assert.deepEqual(k.keystroke({ key: 'c', modifiers: ['command'] }), { ok: true });
    assert.deepEqual(n.posts, [[8, MOD_FLAGS.command, true], [8, MOD_FLAGS.command, false]]);
  });
  it('S02 이름 키는 KEY_CODES 표, shift가 필요한 글자는 Shift를 더한다', () => {
    const n = fakeNative(); const k = createKeySynth(n);
    k.keystroke({ key: 'left', modifiers: [] });
    assert.deepEqual(n.posts[0], [123, 0, true]);
    k.keystroke({ key: '?', modifiers: ['command'] });
    assert.deepEqual(n.posts[2], [44, MOD_FLAGS.command | MOD_FLAGS.shift, true]);
  });
  it('S03 모듈 없음·모르는 키·권한 없음·보내기 실패는 이유와 함께 실패', () => {
    assert.deepEqual(createKeySynth(null).keystroke({ key: 'c', modifiers: [] }), { ok: false, reason: 'unavailable' });
    assert.equal(createKeySynth(fakeNative()).keystroke({ key: '가', modifiers: [] }).reason, 'nokey');
    assert.equal(createKeySynth(fakeNative({ trusted: false })).keystroke({ key: 'c', modifiers: [] }).reason, 'untrusted');
    assert.equal(createKeySynth(fakeNative({ postOk: false })).keystroke({ key: 'c', modifiers: [] }).reason, 'post');
    assert.equal(createKeySynth(null).repeatTiming(), null);
  });
  it('S04 synthKeystroke: 네이티브가 되면 osascript를 부르지 않고, 안 되면 osascript로 (권한 오류 분류 그대로)', async () => {
    const runs = [];
    const runner = async (cmd, args) => { runs.push([cmd, args]); return { code: 0, stdout: '', stderr: '' }; };
    await synthKeystroke({ key: 'c', modifiers: ['command'] }, { ksynth: createKeySynth(fakeNative()), runner });
    assert.equal(runs.length, 0);
    await synthKeystroke({ key: 'c', modifiers: ['command'] }, { ksynth: createKeySynth(fakeNative({ trusted: false })), runner });
    assert.equal(runs.length, 1);
    assert.equal(runs[0][0], 'osascript');
    const deny = async () => ({ code: 1, stdout: '', stderr: 'osascript is not allowed assistive access (-1719)' });
    await assert.rejects(() => synthKeystroke({ key: 'c', modifiers: [] }, { ksynth: createKeySynth(null), runner: deny }), (e) => e.code === 'ACCESSIBILITY');
  });
});
