import { BUILTIN_LABEL } from './appKeys.js';
import { dirsFor } from '../service/controls.js';

/**
 * 프리셋 (스펙 2026-10-04-presets-device-design §2). 소스에 든 고정 키 배치 — 화면에서 고칠 수 없다.
 * 새 프리셋은 소스 변경으로만 추가한다. 키 1~10은 Output 내장(작업 칸)이라 이름만 둔다.
 * 키 11·12·13은 프리셋이 정하지 않는다 — 레이어가 정한다 (2026-10-05, ATTENTION·ACK·받아쓰기 제거). MODE는 노브 누름이다.
 * 프리셋이 정하지 않은 칸은 그 레이어가 직접 정한다 (2026-10-04). 정책: docs/PRESET_POLICY_KO.md
 */
export const builtin = (b) => ({ type: 'builtin', builtin: b, label: BUILTIN_LABEL[b] });
export const sc = (label, keystroke) => ({ type: 'shortcut', label, keystroke });

function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
}

export const ORCA_PRESET = deepFreeze({
  id: 'orca',
  name: 'Orca',
  descriptionKo: 'Orca 에이전트 작업 칸 1~10 · 상태 LED. 노브는 세션·탭 이동과 모드 변경. 키 11·12·13과 조이스틱은 레이어에서 정한다.',
  defaultApps: [{ bundleId: 'com.stablyai.orca', name: 'Orca' }],
  info: {
    createdKo: '2026-10-04',
    basedOnKo: 'Orca 1.4.219 (macOS) 기준. 2026-10-05: 키 11·12·13을 레이어로 넘김 (Orca 1.4.220)',
    behaviorKo: [
      '키 1~10: Orca 작업(worktree) 칸. 색 = 에이전트 상태, 누르면 그 터미널로 이동, 길게 누르면 상세 보기',
      '노브 누름: 모드 변경 — 전체 보기에서 고른 작업의 상세 보기로, 상세 보기에서 다시 누르면 전체 보기로',
      '노브 회전: 전체 보기에서는 다음·이전 세션, 상세 보기에서는 그 작업의 터미널 탭 왼쪽·오른쪽',
    ],
    limitsKo: [
      '조이스틱(방향 수 포함)은 정하지 않습니다 — 레이어에서 정합니다',
      '키 11·12·13은 정하지 않습니다 — 레이어에서 정합니다 (예: 키 13에 단축키 ⌘E = 음성 받아쓰기)',
      '레이어의 단축키는 Orca가 앞에 있을 때만 보냅니다',
      '언더글로우는 이 프리셋을 쓰는 레이어에서만 Orca 상태를 보입니다 — 다른 레이어는 그 레이어 색 (2026-10-10)',
    ],
    // 2026-10-10: 언더글로우 = 작업 전체의 대표 상태. 고칠 수 없다 (프리셋 고정)
    underglowKo: [
      '승인 필요: 주황 빠른 숨쉬기 · 답변 필요: 살구 빠른 숨쉬기',
      '오류: 빨강 빠른 깜박임 (개입과 색이 다릅니다)',
      '진행 중: 호박 회전',
      '완료·미확인: 청록 고정 · 중단됨: 회색 · 상태 모름: 보라 느린 숨쉬기',
      '평온(아무것도 안 할 때): 초록 느린 숨쉬기',
      '여러 작업이면 대표 하나: 개입(오류 > 승인 > 답변) > 진행 중 > 완료·미확인 > 중단됨 > 평온',
      '연결되면 1.5초 회전 인사, 끊겼다 다시 연결되면 빨강 깜박임 1초 먼저 (모든 레이어 공통)',
    ],
  },
  keyLabels: Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => [`key${n}`, `작업 칸 ${n}`])),
  keys: {},   // 2026-10-05: 키 11·12·13은 레이어가 정한다
  dial: { cw: builtin('next_session'), ccw: builtin('prev_session'), press: builtin('toggle_view') },
  joystick: null,   // 조이스틱은 레이어가 정한다 (2026-10-04 사용자 결정)
});

// ───────────── 추천 프리셋 (2026-10-10 사용자 요청). 키 1~8(미디어 1~3)·노브를 정하고, 키 9~13·조이스틱은 레이어가 정한다
// 키마다 고정 색 (2026-10-10 사용자 요청: 같은 레이어 색이라 키를 구분하기 어려웠다). 평소 모습만, 누를 때 효과 없음
const keyLed = (color) => ({ normal: { color, effect: 'solid', speed: 'normal', brightness: 'mid' }, press: null, hold: null });
export const keysOf = (list) => Object.fromEntries(list.map(([label, keystroke, color], i) => [`key${i + 1}`, { ...sc(label, keystroke), led: keyLed(color) }]));
const COMMON_LIMITS = [
  '키 9~13과 조이스틱은 정하지 않습니다 — 레이어에서 정합니다',
  '단축키는 연결된 앱이 앞에 있을 때만 보냅니다',
  '앱에서 단축키를 바꿨다면 그 키는 동작하지 않습니다 (macOS 기본 단축키 기준)',
];

export const CODE_PRESET = deepFreeze({
  id: 'code',
  name: '코드 편집기',
  descriptionKo: 'VS Code · Cursor. 명령 팔레트·파일 열기·터미널·디버그, 노브로 편집기 탭 이동.',
  defaultApps: [{ bundleId: 'com.microsoft.VSCode', name: 'Visual Studio Code' }, { bundleId: 'com.todesktop.230313mzl4w4u92', name: 'Cursor' }],
  info: {
    createdKo: '2026-10-10',
    basedOnKo: 'VS Code 기본 키 바인딩(macOS) — Cursor도 같음',
    behaviorKo: [
      '키 1 명령 팔레트(⌘⇧P) · 키 2 파일 열기(⌘P) · 키 3 터미널 열고 닫기(⌃`) · 키 4 사이드바(⌘B)',
      '키 5 디버그 시작·계속(F5) · 키 6 디버그 중지(⇧F5) · 키 7 정의로 이동(F12) · 키 8 전체에서 찾기(⌘⇧F)',
      '노브 회전: 이전·다음 편집기 탭(⌘⌥← / ⌘⌥→) · 노브 누름: 다음 문제(F8)',
    ],
    limitsKo: [...COMMON_LIMITS, 'AI 채팅은 앱마다 단축키가 달라 넣지 않았습니다 — 레이어의 빈 키에 넣으세요 (예: Cursor ⌘L)'],
  },
  keyLabels: {},
  keys: keysOf([['명령 팔레트', 'cmd+shift+p', '#5A8CDC'], ['파일 열기', 'cmd+p', '#2BB3E8'], ['터미널', 'ctrl+`', '#8B6BC4'], ['사이드바', 'cmd+b', '#1F9E96'],
    ['디버그 시작', 'f5', '#3E9B5A'], ['디버그 중지', 'shift+f5', '#E0481F'], ['정의로 이동', 'f12', '#D9A21B'], ['전체 찾기', 'cmd+shift+f', '#C44BD6']]),
  dial: { cw: sc('다음 탭', 'cmd+alt+right'), ccw: sc('이전 탭', 'cmd+alt+left'), press: sc('다음 문제', 'f8') },
  joystick: null,
});

export const BROWSER_PRESET = deepFreeze({
  id: 'browser',
  name: '브라우저',
  descriptionKo: 'Chrome · Safari · Edge · Brave. 탭 열고 닫기·뒤로·앞으로, 노브로 탭 이동.',
  defaultApps: [{ bundleId: 'com.google.Chrome', name: 'Google Chrome' }, { bundleId: 'com.apple.Safari', name: 'Safari' },
    { bundleId: 'com.microsoft.edgemac', name: 'Microsoft Edge' }, { bundleId: 'com.brave.Browser', name: 'Brave Browser' }],
  info: {
    createdKo: '2026-10-10',
    basedOnKo: 'Chrome · Safari 기본 단축키(macOS) — Edge · Brave는 Chrome과 같음',
    behaviorKo: [
      '키 1 새 탭(⌘T) · 키 2 탭 닫기(⌘W) · 키 3 닫은 탭 다시 열기(⌘⇧T) · 키 4 뒤로(⌘[)',
      '키 5 앞으로(⌘]) · 키 6 새로고침(⌘R) · 키 7 주소창(⌘L) · 키 8 페이지에서 찾기(⌘F)',
      '노브 회전: 다음·이전 탭(⌃⇥ / ⌃⇧⇥) · 노브 누름은 레이어에서 정합니다',
    ],
    limitsKo: [...COMMON_LIMITS, '브라우저 안에서 여는 회의(Google Meet 등)도 이 레이어를 씁니다'],
  },
  keyLabels: {},
  keys: keysOf([['새 탭', 'cmd+t', '#3E9B5A'], ['탭 닫기', 'cmd+w', '#E0481F'], ['닫은 탭 다시', 'cmd+shift+t', '#D9A21B'], ['뒤로', 'cmd+[', '#5A8CDC'],
    ['앞으로', 'cmd+]', '#2BB3E8'], ['새로고침', 'cmd+r', '#1F9E96'], ['주소창', 'cmd+l', '#8B6BC4'], ['페이지 찾기', 'cmd+f', '#C44BD6']]),
  dial: { cw: sc('다음 탭', 'ctrl+tab'), ccw: sc('이전 탭', 'ctrl+shift+tab') },
  joystick: null,
});

export const ZOOM_PRESET = deepFreeze({
  id: 'zoom',
  name: '회의 (Zoom)',
  descriptionKo: 'Zoom 회의: 마이크·카메라·화면 공유·손 들기·참가자·채팅.',
  defaultApps: [{ bundleId: 'us.zoom.xos', name: 'zoom.us' }],
  info: {
    createdKo: '2026-10-10',
    basedOnKo: 'Zoom 기본 단축키(macOS)',
    behaviorKo: [
      '키 1 마이크 켜고 끄기(⌘⇧A) · 키 2 카메라(⌘⇧V) · 키 3 화면 공유 시작·중지(⌘⇧S) · 키 4 손 들기·내리기(⌥Y)',
      '키 5 참가자 창(⌘U) · 키 6 채팅 창(⌘⇧H) · 키 7 발표자·갤러리 보기 전환(⌘⇧W) · 키 8 회의 나가기(⌘W, Zoom이 한 번 묻습니다)',
      '노브는 정하지 않습니다 — 레이어에서 정합니다',
    ],
    limitsKo: [...COMMON_LIMITS,
      '마이크·카메라가 켜졌는지는 LED로 보이지 않습니다 — Output이 Zoom의 상태를 읽을 수 없어 키는 정한 색만 냅니다',
      'Google Meet(브라우저 안)·Teams(단축키가 다름)는 포함하지 않습니다'],
  },
  keyLabels: {},
  keys: keysOf([['마이크', 'cmd+shift+a', '#E8762B'], ['카메라', 'cmd+shift+v', '#2BB3E8'], ['화면 공유', 'cmd+shift+s', '#3E9B5A'], ['손 들기', 'alt+y', '#D9A21B'],
    ['참가자', 'cmd+u', '#5A8CDC'], ['채팅', 'cmd+shift+h', '#8B6BC4'], ['보기 전환', 'cmd+shift+w', '#1F9E96'], ['회의 나가기', 'cmd+w', '#E0481F']]),
  dial: {},
  joystick: null,
});

export const MEDIA_PRESET = deepFreeze({
  id: 'media',
  name: '미디어',
  descriptionKo: '재생·이전·다음 곡, 노브로 볼륨. Mac의 미디어 키와 같아 Music·Spotify·YouTube 어디서나 동작.',
  defaultApps: [],
  info: {
    createdKo: '2026-10-10',
    basedOnKo: 'macOS 미디어 키 (키보드 F7~F12의 재생·볼륨 키와 같은 신호)',
    behaviorKo: [
      '키 1 재생·일시정지 · 키 2 이전 곡 · 키 3 다음 곡',
      '노브 회전: 볼륨 올리기·내리기 · 노브 누름: 음소거',
      '정한 앱이 없습니다 — 기본 레이어(다른 레이어에 연결되지 않은 모든 앱)의 키 배치로 쓰는 것을 권합니다',
    ],
    limitsKo: [
      '키 4~13과 조이스틱은 정하지 않습니다 — 레이어에서 정합니다',
      '미디어 키는 앞 앱과 상관없이 Mac 전체에 갑니다 (지금 재생 중인 앱이 받습니다)',
      '손쉬운 사용 권한이 필요합니다 (다른 단축키와 같음)',
    ],
  },
  keyLabels: {},
  keys: keysOf([['재생·일시정지', 'media_play', '#3E9B5A'], ['이전 곡', 'media_prev', '#5A8CDC'], ['다음 곡', 'media_next', '#2BB3E8']]),
  dial: { cw: sc('볼륨 +', 'volume_up'), ccw: sc('볼륨 −', 'volume_down'), press: sc('음소거', 'mute') },
  joystick: null,
});

export const ITERM_PRESET = deepFreeze({
  id: 'iterm',
  name: 'iTerm',
  descriptionKo: 'iTerm2: 탭·분할창 만들고 옮기기, 화면 지우기·중단, 노브로 탭 이동.',
  defaultApps: [{ bundleId: 'com.googlecode.iterm2', name: 'iTerm' }],
  info: {
    createdKo: '2026-10-10',
    basedOnKo: 'iTerm2 3.7.4 기본 단축키(macOS)',
    behaviorKo: [
      '키 1 새 탭(⌘T) · 키 2 탭 닫기(⌘W) · 키 3 세로 분할(⌘D) · 키 4 가로 분할(⌘⇧D)',
      '키 5 다음 분할창(⌘]) · 키 6 분할창 최대화 켜고 끄기(⌘⇧↩) · 키 7 화면 지우기(⌘K) · 키 8 중단(⌃C)',
      '노브 회전: 이전·다음 탭(⌘⇧[ / ⌘⇧]) · 노브 누름: 찾기(⌘F)',
    ],
    limitsKo: [...COMMON_LIMITS, '레이어의 빈 키 예: 붙여넣기 기록(⌘⇧H), 모든 분할창에 동시 입력(⌘⌥I)', 'Orca 안의 터미널은 Orca 프리셋을 씁니다 — 이 프리셋은 iTerm에만 연결합니다'],
  },
  keyLabels: {},
  keys: keysOf([['새 탭', 'cmd+t', '#3E9B5A'], ['탭 닫기', 'cmd+w', '#E0481F'], ['세로 분할', 'cmd+d', '#5A8CDC'], ['가로 분할', 'cmd+shift+d', '#2BB3E8'],
    ['다음 분할창', 'cmd+]', '#1F9E96'], ['분할창 최대화', 'cmd+shift+enter', '#8B6BC4'], ['화면 지우기', 'cmd+k', '#D9A21B'], ['중단', 'ctrl+c', '#C44BD6']]),
  dial: { cw: sc('다음 탭', 'cmd+shift+]'), ccw: sc('이전 탭', 'cmd+shift+['), press: sc('찾기', 'cmd+f') },
  joystick: null,
});

export const NOTION_PRESET = deepFreeze({
  id: 'notion',
  name: 'Notion',
  descriptionKo: 'Notion: 검색·새 페이지·사이드바·링크·댓글·체크·블록 옮기기, 노브로 뒤로·앞으로.',
  defaultApps: [{ bundleId: 'notion.id', name: 'Notion' }],
  info: {
    createdKo: '2026-10-10',
    basedOnKo: 'Notion 7.37.1 기본 단축키(macOS)',
    behaviorKo: [
      '키 1 검색(⌘P) · 키 2 새 페이지(⌘N) · 키 3 사이드바 열고 닫기(⌘\\) · 키 4 페이지 링크 복사(⌘L)',
      '키 5 댓글(⌘⇧M) · 키 6 할 일 체크 켜고 끄기(⌘↩) · 키 7 블록 위로(⌘⇧↑) · 키 8 블록 아래로(⌘⇧↓)',
      '노브 회전: 뒤로·앞으로(⌘[ / ⌘]) · 노브 누름: Notion AI(⌘J)',
    ],
    limitsKo: [...COMMON_LIMITS, '레이어의 빈 키 예: 제목 1·2·3(⌘⌥1/2/3), 다크 모드(⌘⇧L)'],
  },
  keyLabels: {},
  keys: keysOf([['검색', 'cmd+p', '#5A8CDC'], ['새 페이지', 'cmd+n', '#3E9B5A'], ['사이드바', 'cmd+\\', '#1F9E96'], ['링크 복사', 'cmd+l', '#8B6BC4'],
    ['댓글', 'cmd+shift+m', '#D9A21B'], ['체크', 'cmd+enter', '#2BB3E8'], ['블록 위로', 'cmd+shift+up', '#E8762B'], ['블록 아래로', 'cmd+shift+down', '#C44BD6']]),
  dial: { cw: sc('앞으로', 'cmd+]'), ccw: sc('뒤로', 'cmd+['), press: sc('Notion AI', 'cmd+j') },
  joystick: null,
});

export const PRESETS = Object.freeze([ORCA_PRESET, CODE_PRESET, BROWSER_PRESET, ZOOM_PRESET, MEDIA_PRESET, ITERM_PRESET, NOTION_PRESET]);

export function presetById(id) {
  return PRESETS.find((p) => p.id === id) ?? null;
}

/** 프리셋이 정한 칸 id (키는 이름이 있는 칸). 여기 없는 칸은 레이어가 정한다 */
export function presetLockedSlots(id) {
  const p = presetById(id);
  if (!p) return new Set();
  return new Set([...Object.keys(p.keyLabels ?? {}), ...Object.keys(presetSlots(id))]);
}

/** 프리셋의 실행 칸 (키·노브·조이스틱). Output 내장 키(1~10·12)는 이름만 있어 여기에 없다 */
export function presetSlots(id) {
  const p = presetById(id);
  return p ? flattenSlots(p) : {};
}

/** 레이어·프리셋 자신의 칸을 실행용 칸 id로 펼친다. 조이스틱은 지금 방향 수·축에 맞는 것만 */
export function flattenSlots(layer) {
  const out = { ...(layer.keys ?? {}) };
  if (layer.dial?.cw) out.dial_cw = layer.dial.cw;
  if (layer.dial?.ccw) out.dial_ccw = layer.dial.ccw;
  if (layer.dial?.press) out.dial_press = layer.dial.press;
  if (!layer.joystick) return out;
  for (const d of dirsFor(layer.joystick.directions, layer.joystick.axis)) {
    if (layer.joystick.short[d]) out[`joystick_${d}`] = layer.joystick.short[d];
  }
  return out;
}
