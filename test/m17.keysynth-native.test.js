/**
 * M17 — 네이티브 키 입력 모듈 (2026-10-09). 빌드되지 않은 환경(Xcode 없음)에서는 건너뛴다.
 * 실제 키를 보내는 post()는 잘못된 인자로만 부른다 (테스트 중에 키가 들어가면 안 된다).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

let native = null;
try { native = createRequire(import.meta.url)('keysynth'); } catch { /* 빌드 안 됨 */ }

describe('M17 / 네이티브 모듈', { skip: native ? false : '네이티브 모듈이 빌드되지 않음' }, () => {
  it('N01 함수 다섯을 내보낸다 (postMedia 2026-10-10)', () => {
    for (const f of ['post', 'keyCodeFor', 'repeatTiming', 'trusted', 'postMedia']) assert.equal(typeof native[f], 'function', f);
  });
  // 지금 영문 자판이 US 계열(ABC·US)인지: a가 0번 키. AZERTY·Dvorak 같은 배치에서는 위치를 단정하지 않는다
  const usLike = () => native.keyCodeFor('a')?.keyCode === 0 && native.keyCodeFor('q')?.keyCode === 12;
  it('N02 글자 → 키 코드: 모든 영문 글자를 찾고 범위가 맞다, 없는 글자는 null', () => {
    for (const ch of 'abcdefghijklmnopqrstuvwxyz0123456789') {
      const r = native.keyCodeFor(ch);
      assert.ok(r && r.keyCode >= 0 && r.keyCode <= 127, ch);
    }
    assert.equal(native.keyCodeFor('가'), null);
    assert.equal(native.keyCodeFor(''), null);
    assert.equal(native.keyCodeFor('ab'), null);
  });
  it('N02-US US 계열 자판: c=8, [=33, ?는 Shift', { skip: usLike() ? false : 'US 계열 자판이 아님' }, () => {
    assert.deepEqual(native.keyCodeFor('c'), { keyCode: 8, shift: false });
    assert.deepEqual(native.keyCodeFor('['), { keyCode: 33, shift: false });
    assert.deepEqual(native.keyCodeFor('?'), { keyCode: 44, shift: true });
  });
  it('N05 숫자 키패드보다 본 자판을 먼저 고른다 (US: * = Shift+8, - = 27, . = 47)', { skip: usLike() ? false : 'US 계열 자판이 아님' }, () => {
    assert.deepEqual(native.keyCodeFor('*'), { keyCode: 28, shift: true });
    assert.deepEqual(native.keyCodeFor('-'), { keyCode: 27, shift: false });
    assert.deepEqual(native.keyCodeFor('.'), { keyCode: 47, shift: false });
  });
  it('N03 macOS 키 반복 지연·간격 (밀리초, 양수)', () => {
    const t = native.repeatTiming();
    assert.ok(t.delayMs > 0 && t.delayMs < 5000, String(t.delayMs));
    assert.ok(t.intervalMs > 0 && t.intervalMs < 2000, String(t.intervalMs));
  });
  it('N04 trusted()는 불리언, post()는 잘못된 인자에 false (키를 보내지 않음)', () => {
    assert.equal(typeof native.trusted(), 'boolean');
    assert.equal(native.post(-1, 0, true), false);
    assert.equal(native.post(200, 0, true), false);
    assert.equal(native.post('a', 0, true), false);
    // postMedia도 잘못된 인자에 false (미디어 키를 보내지 않음)
    assert.equal(native.postMedia(-1), false);
    assert.equal(native.postMedia(32), false);
    assert.equal(native.postMedia('x'), false);
  });
});
