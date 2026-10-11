import { actionLabel } from '../apps/actionLabel.js';

/**
 * 노브·조이스틱 화면 표시 내용 (2026-10-10 사용자 요청: 밝기 조절 표시처럼).
 * 순수 함수 — 서비스가 장치 입력마다 만들어 'hud' 이벤트로 내고, Electron이 화면에 그린다.
 */
const nameOf = (a) => (a ? actionLabel(a) : null);

/** 조이스틱: 지금 위치(장치 각도 규약 right=0, down=0.25)와 디코더가 쓰는 구간 그대로, 칸마다 짧게·길게 동작 이름 */
export function joystickHud({ angle, distance, dir, sectors, deadzone, holdMs, holdDirs, slots, enteredAt }) {
  return {
    kind: 'joystick',
    angle, distance, dir, deadzone,
    sectors: (sectors ?? []).map((s) => {
      const d = s.direction ?? s.dir;
      return { direction: d, from: s.from, to: s.to, short: nameOf(slots[`joystick_${d}`]), long: nameOf(slots[`joystickHold_${d}`]) };
    }),
    hold: Boolean(dir && holdDirs.includes(dir)),
    enteredAt: dir ? enteredAt : null,
    holdMs,
  };
}

/** 노브: 돌림(cw·ccw)·누름(press)과 그 동작 이름 */
export function dialHud(action, slots) {
  return { kind: 'dial', action, label: nameOf(slots[`dial_${action}`]) ?? '동작 없음' };
}
