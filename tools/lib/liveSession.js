/**
 * --live — 실기 입력 → 상태 → 조명 왕복.
 *
 * 지금까지 출력(LED)만 실기에서 검증됐다. 이 세션은 **입력이 런타임을 움직이는지**를 본다.
 *
 *   장치 알림 → DeviceEventDecoder → InputDecoder → Output
 *   → RenderScheduler → DeviceDriver → 장치 LED
 *
 * 안전: LED 외에는 아무것도 쓰지 않는다.
 * 앱 전환·키 전송은 하지 않는다 — FocusRouter/ActionRouter는 출력만 한다.
 */
import { StatusLabelKo, View } from '../../src/core/types.js';

/** 이동 요청을 화면에 적기만 한다. 실제 앱을 건드리지 않는다. */
export class PrintingFocusRouter {
  constructor({ print = console.log } = {}) {
    this.print = print;
    this.calls = [];
  }

  async focus(target) {
    this.calls.push(target);
    this.print(`    → 이동 요청: ${target.unitId}`
      + `${target.childId ? ` / ${target.childId}` : ''} (${target.reason})`);
    return { ok: true, simulated: true };
  }
}

/** 조이스틱·노브 단축키. 실제 명령을 보내지 않는다. */
export class PrintingActionRouter {
  constructor({ print = console.log } = {}) {
    this.print = print;
    this.calls = [];
  }

  supports() {
    return false;
  }

  async run(request) {
    this.calls.push(request);
    this.print(`    → 동작 '${request.actionId ?? '없음'}' — `
      + '이 세션에서는 앱 명령을 보내지 않습니다.');
    return { ok: false, unsupported: true, reasonKo: 'live 세션은 앱 명령을 보내지 않습니다.' };
  }
}

/** 한 줄짜리 현재 상태 요약 */
export function statusLine(snapshot) {
  const slots = snapshot.slots
    .map((s, i) => `${i + 1}:${s.id ? (StatusLabelKo[s.status] || s.status) : '—'}`)
    .join(' · ');
  return `  [${snapshot.view === View.DETAIL ? 'Detail' : 'Global'} `
    + `묶음 ${snapshot.bank + 1}/${snapshot.bankCount}] ${slots}`;
}

/** 의도 → Output 호출. 앱 서비스와 같은 규칙 — src/input/intentDispatcher.js */
export { makeDispatcher } from '../../src/input/intentDispatcher.js';

export function describeIntent(intent) {
  if (intent.type === 'joystick') return `조이스틱 ${intent.direction}`;
  if (intent.type === 'dial') return `노브 ${intent.direction === 'cw' ? '시계' : '반시계'}`;
  return `${intent.key} ${intent.type === 'hold' ? '길게' : '짧게'}`;
}

/** 세션 통계. 무엇이 실제로 도달했는지 센다. */
export function summarize({ events, intents, unknown, focusCalls, renders }) {
  const byType = {};
  for (const i of intents) byType[i.type] = (byType[i.type] ?? 0) + 1;
  const lines = [];
  lines.push('');
  lines.push('── live 세션 요약 ──');
  lines.push(`  받은 알림 ${events}건 · 해석 못 한 알림 ${unknown}건`);
  lines.push(`  만들어진 의도 ${intents.length}건`
    + (Object.keys(byType).length ? ` (${Object.entries(byType).map(([k, v]) => `${k} ${v}`).join(' · ')})` : ''));
  lines.push(`  이동 요청 ${focusCalls}건 · 장치 렌더 ${renders}회`);
  if (!events) {
    lines.push('  ⚠ 알림이 하나도 오지 않았습니다. 활성 레이어에 Output 키코드가 있는지 확인하세요.');
  } else if (!intents.length) {
    lines.push('  ⚠ 알림은 왔지만 의도로 바뀌지 않았습니다. calibration의 키코드 대응을 확인하세요.');
  }
  return lines.join('\n');
}
