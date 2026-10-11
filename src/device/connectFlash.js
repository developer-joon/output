import { LOGICAL_KEYS } from './deviceScene.js';

/**
 * 연결 인사 (2026-10-10 사용자 요청). 연결되면 1.5초 동안 13키·언더글로우 회전,
 * 끊겼다 다시 연결되면 그 앞에 1초 빨강 빠른 깜박임. 끊긴 동안은 장치에 보낼 수 없어 메뉴바·상태판만 알린다.
 * 돌려주는 함수: 시각 → 그때 덮을 { keys, ambientZone } 또는 null(끝남). endsAt = 단계가 끝나는 시각들
 */
const GREET_MS = 1500;
const ALERT_MS = 1000;
const GREET = Object.freeze({ color: 'white', brightness: 0.6, pattern: 'rotate' });
const ALERT = Object.freeze({ color: 'red', brightness: 1, pattern: 'blink_fast' });

const frame = (st) => ({ keys: Object.fromEntries(LOGICAL_KEYS.map((k) => [k, { ...st }])), ambientZone: { ...st } });

export function connectFlash({ reconnect, at }) {
  const phases = reconnect ? [[at + ALERT_MS, ALERT], [at + ALERT_MS + GREET_MS, GREET]] : [[at + GREET_MS, GREET]];
  const f = (now) => {
    const p = phases.find(([until]) => now < until);
    return p ? frame(p[1]) : null;
  };
  f.endsAt = phases.map(([until]) => until);
  return f;
}
