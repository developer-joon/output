import { normalizeAction, checkAction, BUILTIN_NAMES } from './appKeys.js';
import { parseKeystroke } from '../service/profiles.js';
import { DIRS8 } from '../service/controls.js';
import { normalizeUnderglow, pickKeyColor } from './keyLed.js';
import { ORCA_PRESET, presetById, presetSlots, presetLockedSlots, flattenSlots, builtin, sc, keysOf } from './presets.js';

/**
 * 레이어 (스펙 2026-10-04-presets-device-design §3). 레이어 = 키 배치 + 연결된 앱들.
 * 키 배치는 직접 설정 또는 프리셋 연결(preset). 종류: 기본(지울 수 없음, 연결 안 된 앱) · 사용자 레이어.
 * Orca 모드 = 고른 레이어가 Orca 프리셋을 연결했을 때. 하드웨어 레이어가 아니다.
 */
export const BUILTINS = BUILTIN_NAMES;
const KEY_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map((n) => `key${n}`);   // 11번도 레이어 칸 (2026-10-05)
const ALL_DIRS = ['any', ...DIRS8];
const ID_RE = /^l-[A-Za-z0-9-]+$/;
const BUNDLE_RE = /^[A-Za-z0-9.-]+$/;
const HEX_RE = /^#[0-9a-f]{6}$/i;
const emptyJoystick = () => ({ directions: 4, axis: 'vertical', short: {} });
/** 칸 id → 사람이 읽는 이름 (노브·조이스틱 칸). 상태판 키 그림도 쓴다 */
export const SLOT_NAME_KO = (id) => {
  if (id === 'dial_cw') return '노브 시계 방향';
  if (id === 'dial_ccw') return '노브 반시계 방향';
  if (id === 'dial_press') return '노브 누름';
  const DIR = { any: '모든 방향', up: '위', up_right: '오른쪽 위', right: '오른쪽', down_right: '오른쪽 아래', down: '아래', down_left: '왼쪽 아래', left: '왼쪽', up_left: '왼쪽 위' };
  const m = /^joystick_(.+)$/.exec(id);
  return m ? `조이스틱 ${DIR[m[1]] ?? m[1]}` : id;
};

/** v4 이하의 Orca 조이스틱 기본값 — 옛 설정 옮기기에만 쓴다 (2026-10-04부터 Orca 프리셋은 조이스틱을 정하지 않음) */
const LEGACY_ORCA_JOYSTICK = {
  directions: 4, axis: 'vertical',
  short: { up: sc('받아쓰기', 'cmd+e'), right: sc('히스토리 앞으로', 'cmd+alt+right'), down: builtin('next_unseen'), left: sc('히스토리 뒤로', 'cmd+alt+left') },
};

/** 기본 레이어 Mac 추천 키 (2026-10-14 사용자 요청: 처음 쓰는 사람이 직접 채우기 어렵다). 키 11~13·조이스틱은 비워 둔다 */
function macRecommended() {
  const keys = keysOf([['복사', 'cmd+c', '#5A8CDC'], ['붙여넣기', 'cmd+v', '#2BB3E8'], ['실행 취소', 'cmd+z', '#D9A21B'], ['다시 실행', 'cmd+shift+z', '#E08A1F'],
    ['Spotlight 검색', 'cmd+space', '#8B6BC4'], ['Mission Control', 'ctrl+up', '#1F9E96'], ['창 닫기', 'cmd+w', '#E0481F'], ['새 탭', 'cmd+t', '#3E9B5A'],
    ['화면 캡처', '', '#C46BA8'], ['이모지 · 기호', 'ctrl+cmd+space', '#9AA0A6']]);
  const { keystroke, ...shot } = keys.key9;
  keys.key9 = { ...shot, type: 'screenshot', display: 'main', save: 'clipboard' };
  return { keys, dial: { cw: sc('볼륨 +', 'volume_up'), ccw: sc('볼륨 −', 'volume_down'), press: sc('음소거', 'mute') } };
}

/** 빈 칸만 추천 키로 채운다 (이미 정한 칸은 그대로). 채운 칸 수 */
export function fillRecommended(layer) {
  const rec = macRecommended();
  let n = 0;
  for (const part of ['keys', 'dial']) {
    for (const [id, a] of Object.entries(rec[part])) if (!layer[part][id]) { layer[part][id] = a; n++; }
  }
  return n;
}

export function defaultLayers() {
  return [
    { id: 'default', kind: 'default', name: '기본', color: '#5A8CDC', preset: null, apps: [], ...macRecommended(), joystick: emptyJoystick() },
    { id: 'l-orca', kind: 'user', name: 'Orca', color: '#1F9E96', preset: 'orca',
      apps: ORCA_PRESET.defaultApps.map((a) => ({ ...a })), keys: {}, dial: {}, joystick: emptyJoystick() },
  ];
}

function normalizeMap(raw, ids, { keepLed = false } = {}) {
  const out = {};
  for (const id of ids) {
    const a = normalizeAction(raw?.[id]);
    if (!a) continue;
    // LED·반복은 키 칸에만 (노브·조이스틱에는 LED·누르고 있기가 없다, 키 LED 스펙 §1·반복 스펙 §2)
    if (!keepLed) { const { led, repeat, ...rest } = a; out[id] = rest; } else out[id] = a;
  }
  return out;
}

function normalizeLayer(r, kind, notesKo) {
  const j = r.joystick ?? {};
  // 조이스틱 '길게'는 없앴다 (2026-10-12 사용자 결정: 옮기지 않고 지운다. 대신 설정의 '유지해야 입력')
  const dropped = Object.keys(normalizeMap(j.long, ALL_DIRS));
  if (dropped.length) notesKo.push(`'${r.name || r.id}' 레이어의 조이스틱 길게 동작 ${dropped.length}개를 지웠습니다 (길게 기능 없앰).`);
  let preset = typeof r.preset === 'string' ? r.preset : null;
  if (preset && !presetById(preset)) {
    notesKo.push(`'${r.name || r.id}' 레이어의 프리셋 '${preset}'을(를) 몰라 직접 설정으로 읽었습니다.`);
    preset = null;
  }
  return {
    id: kind === 'default' ? 'default' : r.id,
    kind,
    name: kind === 'default' ? '기본' : (typeof r.name === 'string' ? r.name : ''),
    color: HEX_RE.test(r.color ?? '') ? r.color : (kind === 'default' ? '#5A8CDC' : '#E8762B'),
    preset,
    apps: kind === 'user' ? (Array.isArray(r.apps) ? r.apps : [])
      .filter((a) => a && BUNDLE_RE.test(a.bundleId ?? ''))
      .map((a) => ({ bundleId: a.bundleId, name: typeof a.name === 'string' && a.name ? a.name : a.bundleId })) : [],
    keys: normalizeMap(r.keys, KEY_IDS, { keepLed: true }),
    dial: normalizeMap(r.dial, ['cw', 'ccw', 'press']),
    joystick: {
      directions: [1, 2, 4, 8].includes(j.directions) ? j.directions : 4,
      axis: j.axis === 'horizontal' ? 'horizontal' : 'vertical',
      short: normalizeMap(j.short, ALL_DIRS),
    },
    // 언더글로우 (2026-10-10): Orca 프리셋 레이어는 늘 Orca 상태라 저장하지 않는다. null = 레이어 색 고정
    underglow: preset === 'orca' ? null : normalizeUnderglow(r.underglow),
  };
}

/** v5 Orca 레이어(kind 'orca') → Orca 프리셋 레이어. 프리셋이 비운 칸(노브 누름 등)은 살리고,
 *  프리셋이 정한 칸과 다른 값은 버리고 노트로 남긴다 (스펙 §3.4, 2026-10-04 열린 칸) */
function fromOrcaKind(r, takenBundleIds, notesKo) {
  const old = normalizeLayer({ ...r, preset: null }, 'user', notesKo);
  const mine = flattenSlots(old);
  const preset = presetSlots('orca');
  const locked = presetLockedSlots('orca');
  for (const id of new Set([...Object.keys(mine), ...Object.keys(preset)])) {
    // 옛 Orca 레이어의 키는 늘 고정(작업 칸·ACK·MODE)이라 사용자가 정한 값이 없다 — 비교하지 않는다
    if (!locked.has(id) || /^key\d+$/.test(id)) continue;
    if (JSON.stringify(mine[id] ?? null) !== JSON.stringify(preset[id] ?? null)) {
      notesKo.push(`프리셋과 달라 버린 Orca 설정: ${SLOT_NAME_KO(id)}${mine[id] ? ` (${mine[id].label || mine[id].keystroke || mine[id].type})` : ' (비어 있음)'}`);
    }
  }
  // 열린 칸만 남긴다. builtin(Orca 동작)은 직접 칸에 둘 수 없어 노트로 남긴다
  const keep = (bag, prefix) => Object.fromEntries(Object.entries(bag).filter(([d, a]) => {
    if (locked.has(prefix + d)) return false;
    if (a.type === 'builtin') { notesKo.push(`Orca 동작이라 옮기지 못한 칸: ${SLOT_NAME_KO(prefix + d)} (${a.label || a.builtin})`); return false; }
    return true;
  }));
  const pj = ORCA_PRESET.joystick;
  return {
    ...defaultLayers()[1],
    color: HEX_RE.test(r.color ?? '') ? r.color : '#1F9E96',
    apps: ORCA_PRESET.defaultApps.filter((a) => !takenBundleIds.has(a.bundleId)).map((a) => ({ ...a })),
    dial: keep(old.dial, 'dial_'),
    joystick: { directions: pj?.directions ?? old.joystick.directions, axis: pj?.axis ?? old.joystick.axis, short: keep(old.joystick.short, 'joystick_') },
  };
}

/**
 * 레이어 복제 (2026-10-10 사용자 요청): 새 id · '이름 복사본' · 다른 레이어와 겹치지 않는 색 · 앱은 비움(앱은 한 레이어에만).
 * 키 배치·동작·언더글로우는 깊은 복사. 기본 레이어를 복제하면 사용자 레이어가 된다
 */
export function duplicateLayer(layer, layers, id) {
  const c = structuredClone(layer);
  return { ...c, id, kind: 'user', name: `${layer.name || '이름 없음'} 복사본`, color: pickKeyColor(layers.map((l) => l.color)), apps: [] };
}

export function normalizeLayers(raw, notesKo = []) {
  if (!Array.isArray(raw)) return defaultLayers();
  const list = raw.filter((l) => l && typeof l === 'object');
  const def = list.find((l) => l.kind === 'default' || l.id === 'default');
  const users = list.filter((l) => l.kind === 'user' && ID_RE.test(l.id ?? '')).map((l) => normalizeLayer(l, 'user', notesKo));
  const orcaRaw = list.find((l) => l.kind === 'orca');
  const taken = new Set(users.flatMap((l) => l.apps.map((a) => a.bundleId)));
  const migrated = orcaRaw && !users.some((l) => l.id === 'l-orca') ? [fromOrcaKind(orcaRaw, taken, notesKo)] : [];
  return [normalizeLayer(def ?? defaultLayers()[0], 'default', notesKo), ...migrated, ...users];
}

export { flattenSlots };

/** 프리셋 레이어의 조이스틱: 방향 수·축은 프리셋, 프리셋이 비운 방향 칸은 레이어 것 (2026-10-04) */
export function joystickOf(layer) {
  const p = layer.preset ? presetById(layer.preset).joystick : null;
  if (!p) return layer.joystick;      // 조이스틱을 정하지 않은 프리셋이면 통째로 레이어 것
  return { directions: p.directions, axis: p.axis, short: { ...layer.joystick.short, ...p.short } };
}

/** 실행에 쓰는 칸: 프리셋이 정한 칸은 프리셋 것, 비운 칸은 레이어 것 */
export function slotsOf(layer) {
  if (!layer.preset) return flattenSlots(layer);
  const locked = presetLockedSlots(layer.preset);
  const j = joystickOf(layer);
  const own = flattenSlots({ ...layer, joystick: { ...j, short: layer.joystick.short } });
  const open = Object.fromEntries(Object.entries(own).filter(([id]) => !locked.has(id)));
  return { ...open, ...presetSlots(layer.preset) };
}

export function validateLayers(layers) {
  const errorsKo = [];
  const owner = new Map();
  for (const l of layers) {
    const where = `${l.name || '이름 없는'} 레이어`;
    if (l.kind === 'user' && !l.name.trim()) errorsKo.push('레이어 이름이 없습니다.');
    // builtin(Orca 동작)은 프리셋 안에만 있다. 저장된 칸은 프리셋 연결 여부와 상관없이 모두 검사한다
    for (const [id, a] of Object.entries(flattenSlots(l))) checkAction(id, a, where, errorsKo);
    for (const app of l.apps) {
      if (owner.has(app.bundleId)) errorsKo.push(`${app.name}: '${owner.get(app.bundleId)}'와 '${l.name}' 레이어에 함께 연결돼 있습니다.`);
      else owner.set(app.bundleId, l.name);
    }
  }
  return { ok: errorsKo.length === 0, errorsKo };
}

export function resolveLayer(layers, bundleId) {
  const user = layers.find((l) => l.kind === 'user' && l.apps.some((a) => a.bundleId === bundleId));
  const def = layers.find((l) => l.kind === 'default');
  // 기본 레이어는 동작이 하나도 없어도 늘 쓴다 — '대기'를 없앴다 (2026-10-11 사용자 결정)
  const layer = user ?? def ?? null;
  if (!layer) return null;
  return { layer, mode: layer.preset === 'orca' ? 'orca' : 'app' };
}

/** 프리셋 → 직접 설정 레이어. 일반 동작만 복사하고 builtin·앱은 비운다 (스펙 §2.2) */
export function layerFromPreset(presetId, id) {
  const p = presetById(presetId);
  if (!p) return null;
  const plain = (m) => Object.fromEntries(Object.entries(m).filter(([, a]) => a.type !== 'builtin').map(([k, a]) => [k, structuredClone(a)]));
  return {
    id, kind: 'user', name: `${p.name} 복사본`, color: '#E8762B', preset: null, apps: [], keys: {},
    dial: plain(p.dial),
    joystick: p.joystick ? { directions: p.joystick.directions, axis: p.joystick.axis, short: plain(p.joystick.short) } : emptyJoystick(),
  };
}

/** 예전 controls 칸 → 동작 */
function fromControl(c) {
  if (!c || typeof c !== 'object') return null;
  if (typeof c.builtin === 'string') return BUILTIN_NAMES.includes(c.builtin) ? builtin(c.builtin) : null;
  // 못 읽는 단축키는 버리고, 이름이 없으면 단축키를 이름으로 (옮긴 칸 하나가 저장 전체를 막지 않게)
  if (typeof c.keystroke === 'string' && parseKeystroke(c.keystroke)) return sc(c.labelKo || c.keystroke, c.keystroke);
  return null;
}

/** 앱 세트 slots → 레이어 칸 */
function fromSlots(slots = {}) {
  const keys = {}; const dial = {}; const short = {}; const long = {};
  for (const [id, a] of Object.entries(slots)) {
    let m;
    if ((m = /^joystickHold_(.+)$/.exec(id))) long[m[1]] = a;   // 옛 길게 — normalizeLayer가 지우고 알린다
    else if ((m = /^joystick_(.+)$/.exec(id))) short[m[1]] = a;
    else if ((m = /^dial_(cw|ccw)$/.exec(id))) dial[m[1]] = a;
    else keys[id] = a;
  }
  return { keys, dial, short, long };
}

/** v4 이하(sources[].controls + appKeys) → v5 모양 → v6 레이어 */
export function migrateToLayers({ controlsRaw = null, appKeysRaw = null } = {}, notesKo = []) {
  // 옛 Orca 설정이 있을 때만 옛 조이스틱 기본값을 채운다 (새로 시작하면 조이스틱은 비어 있다)
  const orca = { id: 'orca', kind: 'orca', color: '#1F9E96', dial: structuredClone(ORCA_PRESET.dial),
    joystick: controlsRaw && typeof controlsRaw === 'object' ? structuredClone(LEGACY_ORCA_JOYSTICK) : emptyJoystick() };
  const def = { id: 'default', kind: 'default', keys: {}, dial: {}, joystick: emptyJoystick() };
  if (controlsRaw && typeof controlsRaw === 'object') {
    const pick = (src, fallback) => {
      if (!src) return fallback;
      const out = {};
      for (const d of DIRS8) { const a = fromControl(src[d]); if (a) out[d] = a; }
      return out;
    };
    orca.joystick = {
      directions: controlsRaw.joystickDirections === 8 ? 8 : 4, axis: 'vertical',
      short: pick(controlsRaw.joystick, orca.joystick.short),
      long: pick(controlsRaw.joystickHold, orca.joystick.long),
    };
    if (controlsRaw.dial) {
      // 설정이 없던 쪽만 기본값. '없음'으로 꺼 둔 쪽은 비운다
      const defaults = orca.dial;
      const side = (k) => (controlsRaw.dial[k] === undefined ? defaults[k] : fromControl(controlsRaw.dial[k]));
      orca.dial = {};
      for (const k of ['cw', 'ccw']) { const a = side(k); if (a) orca.dial[k] = a; }
    }
  }
  const layers = [orca, def];
  if (appKeysRaw && typeof appKeysRaw === 'object') {
    const d = fromSlots(appKeysRaw.default?.slots);
    Object.assign(def, { keys: d.keys, dial: d.dial, joystick: { directions: appKeysRaw.default?.joystickDirections === 8 ? 8 : 4, axis: 'vertical', short: d.short, long: d.long } });
    (Array.isArray(appKeysRaw.apps) ? appKeysRaw.apps : []).forEach((a, i) => {
      if (!a?.bundleId) return;
      const s = fromSlots(a.slots);
      layers.push({
        id: `l-${String(a.bundleId).replace(/[^A-Za-z0-9]/g, '').slice(0, 12)}-${i + 1}`, kind: 'user',
        name: a.name || a.bundleId, color: a.color, apps: [{ bundleId: a.bundleId, name: a.name || a.bundleId }],
        keys: s.keys, dial: s.dial, joystick: { directions: a.joystickDirections === 8 ? 8 : 4, axis: 'vertical', short: s.short, long: s.long },
      });
    });
  }
  return normalizeLayers(layers, notesKo);
}
