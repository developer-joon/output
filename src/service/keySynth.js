import { createRequire } from 'node:module';
import { KEY_CODES, MEDIA_KEYS } from './keyCodes.js';

/**
 * 빠른 키 입력 (스펙 2026-10-09-key-repeat-native-design §4.1).
 * 네이티브 모듈(keysynth)로 CGEvent를 바로 넣는다. 모듈이 없거나 안 되면 실패를 돌려주고, 부르는 쪽이 osascript로 내려간다.
 */
export const MOD_FLAGS = Object.freeze({ command: 0x100000, shift: 0x20000, option: 0x80000, control: 0x40000 });

export function loadNative() {
  try { return createRequire(import.meta.url)('keysynth'); } catch { return null; }
}

export function createKeySynth(native) {
  return {
    available: Boolean(native),
    keystroke({ key, modifiers = [] }) {
      if (!native) return { ok: false, reason: 'unavailable' };
      // 미디어 키 (2026-10-10): NX 시스템 키. 보조키 없음. 옛 모듈(postMedia 없음)은 osascript로 내려간다
      if (Object.hasOwn(MEDIA_KEYS, key)) {
        if (typeof native.postMedia !== 'function') return { ok: false, reason: 'nokey' };
        if (!native.trusted()) return { ok: false, reason: 'untrusted' };
        return native.postMedia(MEDIA_KEYS[key]) ? { ok: true } : { ok: false, reason: 'post' };
      }
      let flags = 0;
      for (const m of modifiers) flags |= MOD_FLAGS[m] ?? 0;
      let code;
      if (key.length === 1) {
        const r = native.keyCodeFor(key);
        if (!r) return { ok: false, reason: 'nokey' };
        code = r.keyCode;
        if (r.shift) flags |= MOD_FLAGS.shift;
      } else {
        code = KEY_CODES[key];
        if (code === undefined) return { ok: false, reason: 'nokey' };
      }
      // 권한이 없으면 CGEvent는 조용히 버려진다 — osascript로 내려가 권한 오류를 보이게 한다
      if (!native.trusted()) return { ok: false, reason: 'untrusted' };
      if (!native.post(code, flags, true) || !native.post(code, flags, false)) return { ok: false, reason: 'post' };
      return { ok: true };
    },
    repeatTiming: () => (native ? native.repeatTiming() : null),
  };
}

export const keySynth = createKeySynth(loadNative());
