import { isKnownKeycode, isMacroRef } from './catalog.js';

/**
 * 장치 keymap.json 모델 (M5 설계 §5, §10.2).
 *
 * 규칙:
 *  - **불변.** 모든 편집은 새 객체를 돌려준다. 원본은 백업과 diff에 그대로 쓰인다.
 *  - **모르는 필드는 통과.** 최상위·프로필·레이어의 뜻 모르는 필드를 지우지 않는다.
 *  - **형식을 지어내지 않는다.** 색 타입(숫자/문자열), 인코더 원소 모양, 조명, 조이스틱은
 *    기존 레이어에서 복사한다. 장치가 받아들인 적 있는 모양만 쓴다.
 *  - Output 레이어는 잠겨 있다. 벤더 코드가 바뀌면 상태 LED와 이동이 멈춘다.
 */
export const CB_LAYER_NAME = 'Output';
export const OUR_LAYERS = Object.freeze([CB_LAYER_NAME]);
const isCbName = (n) => n === CB_LAYER_NAME;
/** 물리 행별 키 수: 위 2 · 슬롯 4 · 슬롯 4 · ATTENTION/ACK/MODE (HARDWARE_CONTRACT) */
export const ROW_SHAPE = Object.freeze([2, 4, 4, 3]);
/** KI_LS1~6 · KI_LM1~6이 있으므로 프로필당 레이어는 6개로 본다 */
export const MAX_LAYERS = 6;

const CB_KEYMAP = [
  ['KV_OAI_AG00', 'KV_OAI_AG01'],
  ['KV_OAI_AG02', 'KV_OAI_AG03', 'KV_OAI_AG04', 'KV_OAI_AG05'],
  // 아래 7키도 AG — 실기 16차(2026-09-26): AG를 묶어야 thstatus id 6~12로 LED가 켜진다. ACT는 LED 채널이 없다.
  ['KV_OAI_AG06', 'KV_OAI_AG07', 'KV_OAI_AG08', 'KV_OAI_AG09'],
  ['KV_OAI_AG10', 'KV_OAI_AG11', 'KV_OAI_AG12'],
];
// 인코더 첫 칸이 물리 시계 방향이다 — 코드 이름(ENC_CC)과 실제 방향이 반대 (9차 실측, calibration.dial.cw).
/** 인코더: 세 칸 모두 벤더 코드. 누름은 Output 레이어의 노브 누름 칸 (2026-10-03, 이전에는 Input 레이어로 가는 KI_LS) */
const CB_ENCODER = ['KV_OAI_ENC_CC', 'KV_OAI_ENC_CW', 'KV_OAI_ENC_CLK'];
/** 레이어 색 기본값. 레이어가 하나도 없을 때만 쓴다 */
const CB_COLOR_HEX = '#1A1A4D';

const clone = (v) => JSON.parse(JSON.stringify(v));
const codeOf = (cell) => (cell && typeof cell === 'object' ? cell.keycode : cell);
function hexToInt(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
  return m ? parseInt(m[1], 16) : null;
}

/** @returns {{config:object|null, errorsKo:string[]}} */
export function parseKeymap(text) {
  let config;
  try {
    config = JSON.parse(text);
  } catch (err) {
    return { config: null, errorsKo: [`keymap.json이 JSON이 아닙니다: ${err.message}`] };
  }
  const { errorsKo } = validateConfig(config);
  return { config: errorsKo.length ? null : config, errorsKo };
}

/** config 어딘가에 실제로 묶여 있는 매크로 참조. 3행에 배정할 수 있는 것은 이것뿐이다 */
export function macroRefsIn(config) {
  const out = new Set();
  for (const p of config?.profiles ?? []) {
    for (const l of p.layers ?? []) {
      for (const c of (l.layout?.keymap ?? []).flat().map(codeOf)) if (isMacroRef(c)) out.add(c);
      for (const c of (l.layout?.encoders?.[0] ?? []).map(codeOf)) if (isMacroRef(c)) out.add(c);
    }
  }
  return out;
}

/**
 * 구조만 검증한다. 사용자 레이어의 모르는 키코드는 **허용**한다 — 보존 대상이지 오류가 아니다.
 * 우리 레이어는 카탈로그 안의 코드만 가져야 한다.
 */
export function validateConfig(config) {
  const errorsKo = [];
  if (!config || typeof config !== 'object') return { errorsKo: ['keymap이 객체가 아닙니다.'] };
  if (!Array.isArray(config.profiles) || !config.profiles.length) return { errorsKo: ['profiles가 없습니다.'] };
  config.profiles.forEach((p, pi) => {
    if (!Array.isArray(p?.layers) || !p.layers.length) { errorsKo.push(`프로필 ${pi}: 레이어가 없습니다.`); return; }
    if (p.layers.length > MAX_LAYERS) errorsKo.push(`프로필 ${pi}: 레이어가 ${MAX_LAYERS}개를 넘습니다.`);
    const names = new Set();
    p.layers.forEach((l, li) => {
      const at = `프로필 ${pi} 레이어 ${li + 1}${l?.name ? ` '${l.name}'` : ''}`;
      if (typeof l?.name === 'string') {
        if (names.has(l.name)) errorsKo.push(`${at}: 이름이 중복입니다.`);
        names.add(l.name);
      }
      const km = l?.layout?.keymap;
      if (!Array.isArray(km) || km.length !== ROW_SHAPE.length
        || km.some((row, r) => !Array.isArray(row) || row.length !== ROW_SHAPE[r])) {
        errorsKo.push(`${at}: 행 구성이 ${ROW_SHAPE.join('/')}이 아닙니다.`);
        return;
      }
      // 엄격한 검증은 잠긴 Output 레이어만. 3행(키 7~10)은 장치에 이미 있는 매크로 참조를 허용한다 (스펙 §3.1)
      if (isCbName(l.name)) {
        const refs = macroRefsIn(config);
        km.forEach((row, r) => row.map(codeOf).forEach((c) => {
          if (isKnownKeycode(c)) return;
          if (r === 2 && isMacroRef(c) && refs.has(c)) return;
          errorsKo.push(`${at}: 카탈로그에 없는 키코드 ${c}`);
        }));
      }
    });
  });
  return { errorsKo };
}

/** 기존 레이어 중 형식 견본으로 쓸 것: 우리 레이어가 아닌 첫 레이어, 없으면 아무거나 */
function templateLayer(layers) {
  return layers.find((l) => !OUR_LAYERS.includes(l.name)) ?? layers[0] ?? null;
}

function buildLayer(name, keymap, encoderCodes, template) {
  const layer = {};
  const encTemplate = template?.layout?.encoders?.[0]?.[0];
  const encCell = (code) => (encTemplate && typeof encTemplate === 'object' ? { keycode: code } : code);
  const keyTemplate = template?.layout?.keymap?.[0]?.[0];
  const keyCell = (code) => (keyTemplate && typeof keyTemplate === 'object' ? { keycode: code } : code);
  layer.name = name;
  if (template && 'color' in template) {
    layer.color = typeof template.color === 'string' ? CB_COLOR_HEX : hexToInt(CB_COLOR_HEX);
  }
  if (template?.lights) layer.lights = clone(template.lights);
  layer.layout = { keymap: keymap.map((row) => row.map(keyCell)) };
  if (!template || template.layout?.encoders) layer.layout.encoders = [encoderCodes.map(encCell)];
  layer.layout.joystick = { type: 'VENDOR', sectors: [] };
  return layer;
}

/**
 * 장치 준비 (프리셋·장치 스펙 §4.2): 활성 프로필을 Output 레이어 하나로 만든다.
 * 13키 AG · 노브 ENC_CC/ENC_CW/ENC_CLK · 조이스틱 벤더. 다른 레이어는 지운다. 매크로 정의는 건드리지 않는다.
 * @returns {{config:object, errorKo:null, changesKo:string[]}}
 */
export function prepareDevice(config, { profileIndex = null } = {}) {
  const next = clone(config);
  // 장치가 알려 준 프로필(device.status profile_index)이 우선. 없으면 activeProfileId, 그것도 없으면 0번
  const at = Number.isInteger(profileIndex) && next.profiles[profileIndex] ? profileIndex : next.profiles.findIndex((p) => p.id === next.activeProfileId);
  const profile = next.profiles[at >= 0 ? at : 0];
  const old = profile.layers.find((l) => isCbName(l.name)) ?? null;
  // 형식 견본(색 타입·조명·인코더 셀 모양)은 원래 Output 레이어가 있으면 그것 — 다른 레이어의 조명을 가져오지 않게
  const cb = buildLayer(CB_LAYER_NAME, CB_KEYMAP, CB_ENCODER, old ?? templateLayer(profile.layers));
  if (old && 'color' in old && 'color' in cb) cb.color = old.color;
  const removed = profile.layers.filter((l) => !isCbName(l.name)).map((l, i) => l.name ?? `레이어 ${i + 1}`);
  profile.layers = [cb];
  return {
    config: next,
    errorKo: null,
    changesKo: [
      'Output 레이어 하나만 둡니다 — 13키·노브(누름 포함)·조이스틱을 Output이 받는 코드로',
      ...removed.map((n) => `삭제: ${n}`),
    ],
  };
}

/** 지금 레이어가 아닌 레이어 이름. 이름이 없으면 장치의 원래 번호(1부터) */
export function otherLayerNames(layers, current) {
  return layers.flatMap((l, i) => (l === current ? [] : [l.name ?? `레이어 ${i + 1}`]));
}

/** 사람이 읽을 변경 목록 */
export function diffConfigs(a, b) {
  const lines = [];
  const pn = Math.max(a.profiles.length, b.profiles.length);
  for (let pi = 0; pi < pn; pi += 1) {
    const la = a.profiles[pi]?.layers ?? [];
    const lb = b.profiles[pi]?.layers ?? [];
    const byName = (ls) => new Map(ls.map((l, i) => [l.name ?? `#${i}`, l]));
    const ma = byName(la);
    const mb = byName(lb);
    for (const [name] of mb) if (!ma.has(name)) lines.push(`+ 레이어 추가: ${name}`);
    for (const [name] of ma) if (!mb.has(name)) lines.push(`- 레이어 삭제: ${name}`);
    for (const [name, lA] of ma) {
      const lB = mb.get(name);
      if (!lB) continue;
      const ka = lA.layout?.keymap ?? [];
      const kb = lB.layout?.keymap ?? [];
      ka.forEach((row, r) => row.forEach((cell, c) => {
        const x = codeOf(cell);
        const y = codeOf(kb[r]?.[c]);
        if (x !== y) lines.push(`~ ${name} [${r},${c}]: ${x} → ${y}`);
      }));
      const ea = (lA.layout?.encoders?.[0] ?? []).map(codeOf);
      const eb = (lB.layout?.encoders?.[0] ?? []).map(codeOf);
      ea.forEach((x, i) => { if (x !== eb[i]) lines.push(`~ ${name} 인코더 ${i}: ${x} → ${eb[i]}`); });
      if (JSON.stringify(lA.color) !== JSON.stringify(lB.color)) lines.push(`~ ${name} 레이어 색: ${lA.color} → ${lB.color}`);
      if (JSON.stringify(lA.lights) !== JSON.stringify(lB.lights)) lines.push(`~ ${name} 조명 변경`);
      if (JSON.stringify(lA.layout?.joystick) !== JSON.stringify(lB.layout?.joystick)) lines.push(`~ ${name} 조이스틱 설정 변경`);
    }
    const oa = la.map((l) => l.name).join('|');
    const ob = lb.filter((l) => ma.has(l.name)).map((l) => l.name).join('|');
    if (oa !== ob && la.every((l) => mb.has(l.name))) lines.push('~ 레이어 순서 변경');
  }
  return lines;
}
