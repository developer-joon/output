/** macOS 가상 키 코드. 이름 키만. 글자는 지금 자판에서 찾는다 (osascript는 keystroke, 네이티브는 keyCodeFor) */
export const KEY_CODES = Object.freeze({
  enter: 36, return: 36, tab: 48, space: 49, delete: 51, backspace: 51, esc: 53, escape: 53,
  left: 123, right: 124, down: 125, up: 126, home: 115, end: 119, pageup: 116, pagedown: 121,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109,
  f11: 103, f12: 111, f13: 105, f14: 107, f15: 113, f16: 106, f17: 64, f18: 79, f19: 80, f20: 90,
});

/**
 * 미디어 키 (2026-10-10, 미디어 프리셋): 일반 키 코드가 아니라 NX 시스템 키 번호. 키보드의 재생·볼륨 키와 같은 신호다.
 * 보조키 없이 쓴다. 네이티브는 postMedia, 없으면 osascript(JavaScript)로 보낸다.
 */
export const MEDIA_KEYS = Object.freeze({ media_play: 16, media_next: 17, media_prev: 18, volume_up: 0, volume_down: 1, mute: 7 });
