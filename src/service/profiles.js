/**
 * profiles.json — 레이어 (v5·v6). v4 이하는 소스별 노브·조이스틱 설정 + 앱별 키였다.
 * v2까지 있던 A1~A4 단축키는 키 7~10이 칸이 되며 없어졌다. 읽을 때 한 칸을 조이스틱 아래 길게로 옮긴다.
 * 레이어(layersRaw)·앱별 키(appKeysRaw)는 원본만 돌려준다 — 정리는 layers.js가 한다 (순환 import 회피).
 */
export const SOURCE_FILE_VERSION = 6;

const MODS = Object.freeze({
  cmd: 'command', command: 'command', '⌘': 'command',
  shift: 'shift', '⇧': 'shift',
  ctrl: 'control', control: 'control', '⌃': 'control',
  alt: 'option', opt: 'option', option: 'option', '⌥': 'option',
});
const NAMED = new Set([
  'enter', 'return', 'space', 'tab', 'esc', 'escape', 'up', 'down', 'left', 'right',
  'delete', 'backspace', 'home', 'end', 'pageup', 'pagedown',
  ...Array.from({ length: 24 }, (_, i) => `f${i + 1}`),
  // 미디어 키 (2026-10-10)
  'media_play', 'media_prev', 'media_next', 'volume_up', 'volume_down', 'mute',
]);
const MOD_SYMBOL = Object.freeze({ command: '⌘', shift: '⇧', control: '⌃', option: '⌥' });
const KEY_SYMBOL = Object.freeze({ up: '↑', down: '↓', left: '←', right: '→', enter: '↩', return: '↩', space: 'Space', tab: '⇥', esc: 'Esc', escape: 'Esc', delete: '⌫', backspace: '⌫',
  media_play: '⏯', media_prev: '⏮', media_next: '⏭', volume_up: '볼륨 +', volume_down: '볼륨 −', mute: '음소거' });

/** 'cmd+shift+p' · '⌘⇧P' · '⌃`' → {key, modifiers}. 읽을 수 없으면 null. */
export function parseKeystroke(text) {
  if (typeof text !== 'string') return null;
  let rest = text.trim();
  if (!rest) return null;
  const modifiers = [];
  // 기호 접두사 (⌘⇧⌃⌥)
  while (rest.length > 1 && MODS[rest[0]] && ['⌘', '⇧', '⌃', '⌥'].includes(rest[0])) {
    modifiers.push(MODS[rest[0]]);
    rest = rest.slice(1);
  }
  const parts = rest.split('+');
  if (parts.some((p) => p === '') && rest !== '+') return null;
  const keyRaw = parts.pop();
  for (const p of parts) {
    const m = MODS[p.toLowerCase()];
    if (!m) return null;
    if (!modifiers.includes(m)) modifiers.push(m);
  }
  const key = keyRaw.toLowerCase();
  if (key.length === 1 || NAMED.has(key)) return { key, modifiers };
  return null;
}

export function formatKeystroke(ks) {
  if (!ks) return '—';
  const k = KEY_SYMBOL[ks.key] ?? ks.key.toUpperCase();
  return `${ks.modifiers.map((m) => MOD_SYMBOL[m]).join('')}${k}`;
}

/** 옛 A키 칸 하나 → {labelKo, keystroke} 또는 null */
function legacyAction(a) {
  if (!a || typeof a !== 'object') return null;
  const ks = typeof a.keystroke === 'string' ? a.keystroke.trim() : '';
  if (!ks || !parseKeystroke(ks)) return null;
  return { labelKo: typeof a.labelKo === 'string' ? a.labelKo : '', keystroke: ks };
}

/** 옛 A1~A4를 controls 원본에 옮긴다. A2 우선, 없으면 첫 번째 설정 칸. 저장된 아래 길게는 덮지 않는다 */
function migrateActions(actions, controls, notesKo) {
  const list = (Array.isArray(actions) ? actions : []).slice(0, 4).map(legacyAction);
  const pick = list[1] ?? list.find(Boolean) ?? null;
  if (!pick) return controls;
  let out = controls;
  if (controls?.joystickHold?.down === undefined) {
    out = { ...controls, joystickHold: { ...(controls?.joystickHold ?? {}), down: pick } };
    notesKo.push(`A키 단축키 '${pick.labelKo || pick.keystroke}'을(를) 조이스틱 아래 길게로 옮겼습니다 (키 7~10은 칸 7~10).`);
  }
  const dropped = list.filter((a) => a && a !== pick);
  if (dropped.length) {
    notesKo.push(`A키 단축키 ${dropped.length}개(${dropped.map((a) => a.labelKo || a.keystroke).join(', ')})는 옮길 자리가 없어 버렸습니다. 필요하면 Orca 키 탭에서 조이스틱·노브에 다시 넣으세요.`);
  }
  return out;
}

/**
 * profiles.json 전체 → 소스별 controls 원본 (normalize 전).
 * @returns {{controlsByName: Map<string, object>, appKeysRaw: object|null, layersRaw: object[]|null, notesKo: string[], warningKo: string|null}}
 */
export function readSourcesFile(raw, sources) {
  const controlsByName = new Map();
  const notesKo = [];
  if (!raw || typeof raw !== 'object') return { controlsByName, appKeysRaw: null, layersRaw: null, notesKo, warningKo: null };
  const v = Number.isInteger(raw.version) ? raw.version : 1;
  if (v > SOURCE_FILE_VERSION) {
    return { controlsByName, appKeysRaw: null, layersRaw: null, notesKo, warningKo: `profiles.json이 더 새로운 버전(v${v})입니다. 이 버전(v${SOURCE_FILE_VERSION})은 읽지 않고 기본 설정으로 시작합니다.` };
  }
  // v5·v6 (레이어): 원본만 돌려준다 — 정리·옮기기(v5 Orca → 프리셋)는 layers.js
  if (v >= 5) return { controlsByName, appKeysRaw: null, layersRaw: Array.isArray(raw.layers) ? raw.layers : null, notesKo, warningKo: null };
  const known = (name) => sources.some((x) => x.name === name);
  if (v >= 2) {
    for (const s of raw.sources ?? []) {
      if (!known(s?.name)) continue;
      const controls = s.controls ?? {};
      controlsByName.set(s.name, v === 2 ? migrateActions(s.actions, controls, notesKo) : controls);
    }
    return { controlsByName, appKeysRaw: v >= 4 ? raw.appKeys ?? null : null, layersRaw: null, notesKo, warningKo: null };
  }
  for (const p of raw.profiles ?? []) {
    const src = sources.find((x) => (p?.bundleIds ?? []).some((b) => x.bundleIds.includes(b)));
    if (src) controlsByName.set(src.name, migrateActions(p.actions, {}, notesKo));
  }
  return { controlsByName, appKeysRaw: null, layersRaw: null, notesKo, warningKo: '앱별 프로필은 없어졌습니다. Orca 설정만 유지했습니다 (다른 앱은 Input 레이어로).' };
}
