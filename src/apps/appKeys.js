import { parseKeystroke } from '../service/profiles.js';
import { POSITIONS, MAX_DISPLAYS } from './windowLayout.js';
import { normalizeLed } from './keyLed.js';
import { autoLabel } from './actionLabel.js';

/**
 * 칸 동작(action) 정리·검사 (스펙 §1·§5). 칸 배치는 레이어(layers.js)가 정한다 (2026-10-03).
 * 키 11·12·13도 레이어 칸이다 (2026-10-05).
 */
export const ACTION_TYPES = Object.freeze(['none', 'shortcut', 'sequence', 'openApp', 'openUrl', 'insertText', 'exec', 'moveWindow', 'layout', 'screenshot', 'builtin']);
/** Orca 레이어 전용 내장 동작 (레이어 스펙 §1.5). Output이 직접 실행한다 */
export const BUILTIN_NAMES = Object.freeze(['attention', 'next_unseen', 'next_session', 'prev_session', 'next_bank', 'prev_bank', 'toggle_view']);
export const BUILTIN_LABEL = Object.freeze({ attention: 'ATTENTION', next_unseen: '다음 미확인 완료', next_session: '다음 세션', prev_session: '이전 세션', next_bank: '다음 묶음', prev_bank: '이전 묶음', toggle_view: '모드 변경 (전체 ↔ 상세)' });
const BUNDLE_RE = /^[A-Za-z0-9.-]+$/;

const str = (v) => (typeof v === 'string' ? v : '');
/** 모니터 번호 (2026-10-12, 캡처·앞 창 위치·레이아웃 공통): 'main' = 1 = 주 모니터, 2~MAX_DISPLAYS. 나머지는 주 모니터 */
const display = (v) => (Number.isInteger(v) && v >= 2 && v <= MAX_DISPLAYS ? v : 'main');
/** 화면 캡처 (2026-10-10): 저장 위치 */
export const SCREENSHOT_SAVES = Object.freeze(['desktop', 'clipboard', 'both']);

/** 칸 하나 정리. 모르는 type은 null (버림). LED 설정(led)은 있을 때만 붙인다 (2026-10-04) */
export function normalizeAction(a) {
  const base = normalizeActionCore(a);
  if (!base || base.type === 'builtin') return base;
  const led = normalizeLed(a.led);
  return led ? { ...base, led } : base;
}

function normalizeActionCore(a) {
  if (!a || typeof a !== 'object' || !ACTION_TYPES.includes(a.type) || a.type === 'none') return null;
  const base = { type: a.type, label: str(a.label) };
  switch (a.type) {
    // 누르고 있으면 반복은 기본 켬 — 끈 경우만 저장한다 (2026-10-09 사용자 결정)
    case 'shortcut': return { ...base, keystroke: str(a.keystroke).trim(), ...(a.repeat === false ? { repeat: false } : {}) };
    case 'sequence': return { ...base, steps: (Array.isArray(a.steps) ? a.steps : []).map((s) => ({ keystroke: str(s?.keystroke).trim(), delayMs: Number(s?.delayMs) || 0 })) };
    case 'openApp': return { ...base, bundleId: str(a.bundleId), appName: str(a.appName) };
    case 'openUrl': return { ...base, url: str(a.url).trim() };
    case 'insertText': return { ...base, text: str(a.text) };
    case 'exec': return { ...base, command: str(a.command) };
    case 'moveWindow': return { ...base, position: str(a.position), display: display(a.display) };
    case 'screenshot': return { ...base, display: display(a.display), save: SCREENSHOT_SAVES.includes(a.save) ? a.save : 'desktop' };
    case 'layout': return { ...base, items: (Array.isArray(a.items) ? a.items : []).map((i) => ({ bundleId: str(i?.bundleId), appName: str(i?.appName), position: str(i?.position), display: display(i?.display) })) };
    case 'builtin': return BUILTIN_NAMES.includes(a.builtin) ? { type: 'builtin', builtin: a.builtin, label: base.label || BUILTIN_LABEL[a.builtin] } : null;
    default: return null;
  }
}

/** builtin(Orca 동작)은 프리셋 안에만 있으므로 늘 오류다 */
export function checkAction(id, a, where, errorsKo) {
  const at = `${where} ${id}`;
  if (a.type === 'builtin') {
    errorsKo.push(`${at}: Orca 전용 동작은 Orca 프리셋에서만 쓸 수 있습니다. 직접 설정 레이어에는 넣을 수 없습니다.`);
    return;
  }
  if (!a.label && !autoLabel(a)) errorsKo.push(`${at}: 이름이 없습니다.`);   // 단축키·앱 열기·앞 창 위치는 비우면 자동 (2026-10-09)
  const ks = (k, w) => { if (!parseKeystroke(k)) errorsKo.push(`${w}: 단축키 '${k}'을(를) 읽을 수 없습니다.`); };
  const pos = (p, w) => { if (!POSITIONS.includes(p)) errorsKo.push(`${w}: 모르는 위치 '${p}'입니다.`); };
  switch (a.type) {
    case 'shortcut': ks(a.keystroke, at); break;
    case 'sequence':
      if (a.steps.length < 1 || a.steps.length > 20) errorsKo.push(`${at}: 단계는 1~20개여야 합니다.`);
      a.steps.forEach((s, i) => {
        ks(s.keystroke, `${at} ${i + 1}단계`);
        if (s.delayMs < 0 || s.delayMs > 5000) errorsKo.push(`${at} ${i + 1}단계: 지연은 0~5000ms여야 합니다.`);
      });
      break;
    case 'openApp': if (!BUNDLE_RE.test(a.bundleId)) errorsKo.push(`${at}: 앱을 고르세요.`); break;
    case 'openUrl': if (!/^[a-z][a-z0-9+.-]*:/i.test(a.url)) errorsKo.push(`${at}: URL은 https: 같은 형식이어야 합니다.`); break;
    case 'insertText': if (!a.text) errorsKo.push(`${at}: 입력할 글자가 없습니다.`); break;
    case 'exec': if (!a.command.trim()) errorsKo.push(`${at}: 명령이 없습니다.`); break;
    case 'moveWindow': pos(a.position, at); break;
    case 'layout':
      if (a.items.length < 1 || a.items.length > 8) errorsKo.push(`${at}: 레이아웃 항목은 1~8개여야 합니다.`);
      a.items.forEach((it, i) => {
        if (!BUNDLE_RE.test(it.bundleId)) errorsKo.push(`${at} ${i + 1}번째: 앱을 고르세요.`);
        pos(it.position, `${at} ${i + 1}번째`);
      });
      break;
    default: break;
  }
}
