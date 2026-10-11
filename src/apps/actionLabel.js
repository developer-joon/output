import { parseKeystroke, formatKeystroke } from '../service/profiles.js';

/**
 * 칸 동작의 보이는 이름 (2026-10-09 사용자 요청: 키마다 이름을 매번 넣기 불편).
 * 이름을 비우면 단축키는 기호(⌘⇧]), 앱 열기는 앱 이름, 앞 창 위치는 위치 이름을 쓴다.
 * 순수 모듈 — 설정 화면(렌더러)도 그대로 불러 쓴다.
 */
export const POSITION_LABEL = Object.freeze({
  full: '전체', center: '가운데', left: '왼쪽 절반', right: '오른쪽 절반', top: '위 절반', bottom: '아래 절반',
  top_left: '왼쪽 위', top_right: '오른쪽 위', bottom_left: '왼쪽 아래', bottom_right: '오른쪽 아래',
  left_third: '왼쪽 1/3', center_third: '가운데 1/3', right_third: '오른쪽 1/3', left_two_thirds: '왼쪽 2/3', right_two_thirds: '오른쪽 2/3',
});

const TYPE_LABEL = Object.freeze({
  shortcut: '단축키', sequence: '매크로', openApp: '앱 열기', openUrl: 'URL 열기', insertText: '글자 입력',
  exec: '명령 실행', moveWindow: '앞 창 위치', layout: '레이아웃', screenshot: '화면 캡처',
});

/** 이름을 비웠을 때 쓸 이름. 만들 수 없으면 '' */
export function autoLabel(a) {
  switch (a?.type) {
    case 'shortcut': {
      const ks = parseKeystroke(a.keystroke ?? '');
      return ks ? formatKeystroke(ks) : '';
    }
    case 'openApp': return a.appName || '';
    case 'moveWindow': return POSITION_LABEL[a.position] ? `창 ${POSITION_LABEL[a.position]}` : '';
    case 'screenshot': return `캡처 — ${a.display === 'main' || !a.display ? '주 모니터' : `모니터 ${a.display}`}${a.save === 'clipboard' ? ' (클립보드)' : a.save === 'both' ? ' (+ 클립보드)' : ''}`;
    default: return '';
  }
}

/** 보이는 이름: 직접 넣은 이름 → 자동 이름 → 동작 종류 */
export function actionLabel(a) {
  return a?.label || autoLabel(a) || TYPE_LABEL[a?.type] || a?.type || '';
}
