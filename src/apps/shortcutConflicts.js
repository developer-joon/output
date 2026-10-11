import { parseKeystroke } from '../service/profiles.js';

/**
 * 단축키 충돌 경고 (2026-10-10 사용자 요청). 막지는 않고 알리기만 한다 — 일부러 겹치게 쓸 수도 있다.
 * 같은 레이어의 다른 칸과 같은 단축키, 또는 macOS가 먼저 가져가는 단축키.
 */
const SYSTEM = Object.freeze({
  'command+space': 'Spotlight', 'control+space': '입력 소스 전환(한/영 등)', 'command+tab': '앱 전환',
  'command+shift+3': '화면 캡처', 'command+shift+4': '화면 캡처', 'command+shift+5': '화면 캡처 도구',
  'control+up': 'Mission Control', 'control+down': '앱 윈도우 보기', 'control+left': '데스크탑 이동', 'control+right': '데스크탑 이동',
  'command+option+esc': '강제 종료', 'command+control+q': '화면 잠금', 'command+option+d': 'Dock 가리기',
});
const MOD_ORDER = ['command', 'control', 'option', 'shift'];
const keyOf = (ks) => [...[...ks.modifiers].sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b)), ks.key === 'escape' ? 'esc' : ks.key].join('+');

const ARROW = { up: '↑', down: '↓', left: '←', right: '→', up_left: '↖', up_right: '↗', down_left: '↙', down_right: '↘', any: '(아무 방향)' };
function slotName(id) {
  let m;
  if ((m = /^key(\d+)$/.exec(id))) return `키 ${m[1]}`;
  if (id === 'dial_cw') return '노브 ↻ 돌림';
  if (id === 'dial_ccw') return '노브 ↺ 돌림';
  if (id === 'dial_press') return '노브 누름';
  if ((m = /^joystickHold_(.+)$/.exec(id))) return `조이스틱 ${ARROW[m[1]] ?? m[1]} 길게`;
  if ((m = /^joystick_(.+)$/.exec(id))) return `조이스틱 ${ARROW[m[1]] ?? m[1]}`;
  return id;
}

/** @returns {string[]} 경고 문장. 읽을 수 없는 단축키면 [] (형식 오류는 따로 알린다) */
export function shortcutConflicts(keystroke, slotId, slots) {
  const ks = parseKeystroke(keystroke ?? '');
  if (!ks) return [];
  const k = keyOf(ks);
  const out = [];
  for (const [id, a] of Object.entries(slots ?? {})) {
    if (id === slotId || a?.type !== 'shortcut') continue;
    const other = parseKeystroke(a.keystroke ?? '');
    if (other && keyOf(other) === k) out.push(`${slotName(id)}과 같은 단축키입니다.`);
  }
  if (SYSTEM[k]) out.push(`macOS의 '${SYSTEM[k]}' 단축키라 앱에 닿지 않을 수 있습니다.`);
  return out;
}
