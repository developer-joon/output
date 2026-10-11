import { View } from '../core/types.js';
import { threadStyleFor, AMBIENT_NORMAL } from '../core/lightingPolicy.js';
import { ambientOverlay } from '../core/ambientFallback.js';
import { freshNoticeSlots, noticeOverlay } from '../core/attentionNotice.js';
import { LED_BRIGHTNESS } from '../apps/keyLed.js';

/** 앱 레이어 언더글로우 기본: 레이어 색 고정, 밝기 상 (키 LED 표의 high·normal 속도와 같은 값) */
const LAYER_UNDERGLOW = Object.freeze({ brightness: LED_BRIGHTNESS.high, s: 0.6 });

/**
 * 13개 논리 키의 요구 스타일 (CODEX_NEXT_TASK_KO.md 4절).
 *
 * 10개 작업 칸을 칠하는 것과 제품 전체 조명은 다르다.
 * threads[10]만 만들고 끝내지 않는다.
 *
 * mini LED에는 scene 항목도 write 경로도 만들지 않는다.
 */
export const LOGICAL_KEYS = Object.freeze([
  'slot1', 'slot2', 'slot3', 'slot4', 'slot5', 'slot6', 'slot7', 'slot8', 'slot9', 'slot10',
  'attention', 'ack', 'mode_back',
]);

const style = (color, brightness, pattern) => ({ color, brightness, pattern });
const OFF = Object.freeze(style('off', 0, 'off'));

/** ATTENTION 키: 개입 대기가 있으면 호박 숨쉬기 (사용자 결정 2026-10-03 — 언더글로우 빨강과 따로). 누른다고 승인하지 않는다. */
function attentionKeyStyle(snapshot) {
  if (!snapshot.attentionCount) return OFF;
  return style('amber', 0.55, 'breathing');
}

/** ACK 키: 현재 선택 대상에 확인할 알림이 있을 때만 활성. */
function ackKeyStyle(snapshot) {
  const shown = snapshot.slots[snapshot.selectedSlot];
  if (!shown?.notification) return OFF;
  return shown.notification.kind === 'error'
    ? style('red', 0.35, 'solid')
    : style('green', 0.35, 'solid');
}

/** MODE/BACK: Global/Detail과 되돌아갈 수 있는지. */
function modeKeyStyle(snapshot) {
  return snapshot.view === View.DETAIL
    ? style('white', 0.30, 'solid')
    : style('white', 0.10, 'solid');
}

/** 아래 줄 세 키 → 레이어 칸 id */
const LOGICAL_KEY_SLOT = Object.freeze({ attention: 'key11', ack: 'key12', mode_back: 'key13' });

/** 레이어 칸 키 하나: 배정 칸은 덧칠 → 키 LED 설정 → 레이어 색 '중' 밝기(2026-10-10: 0.6), 빈 칸은 꺼짐 */
function layerKeyStyle(m, id, overlay) {
  if (!m.assigned.includes(id)) return { ...OFF };
  return { ...(overlay ?? m.keyLeds?.[id] ?? style(m.color, LED_BRIGHTNESS.mid, 'solid')) };
}

/** 언더글로우 영역. 장치가 지원하지 않으면 null */
function ambientZoneOf(snapshot, capabilities) {
  return capabilities.supportsAmbientZone === false
    ? null
    : { ...(snapshot.lighting.ambientZone ?? AMBIENT_NORMAL) };
}

/**
 * @param {object} snapshot Output.render() 결과
 * @param {{supportsAmbientZone?:boolean, controllableKeys?:string[]}} capabilities
 *
 * controllableKeys가 주어지면 그 밖의 키는 uncontrollable로 표시한다.
 * 실기에서 ACT 7키는 v.oai.thstatus로 제어되지 않았다 — 조용히 버리지 않고 드러낸다.
 */
export function buildDeviceScene(snapshot, capabilities = {}, opts = {}) {
  const scene = buildSceneCore(snapshot, capabilities, opts);
  // 언더글로우만 덮는 깜박임 (레이어 바뀜·배터리 경고, 2026-10-10). 키는 원래대로
  const f = opts.flash;
  if (f && !f.keys && f.ambientZone && !scene.inactive && capabilities.supportsAmbientZone !== false) scene.ambientZone = { ...f.ambientZone };
  return scene;
}

function buildSceneCore(
  snapshot, capabilities = {}, { ambientPhase = null, now = Date.now(), overlays = {}, flash = null } = {},
) {
  // 연결 인사 (2026-10-10): 잠깐 동안 어느 장면이든 덮는다
  if (flash?.keys) {
    return {
      revision: snapshot.revision, inactive: false, keys: flash.keys,
      ambientZone: capabilities.supportsAmbientZone === false ? null : flash.ambientZone,
      ambientFallback: null, notice: { active: false, targets: [] }, uncontrollableKeys: [], unsupported: [],
    };
  }
  // 앱 모드 (2026-10-03): 배정 칸은 레이어 색, 키별 LED 설정(2026-10-04)·눌렀을 때 덧칠이 그 위에.
  // 언더글로우는 Orca 전역. 키 11도 레이어 칸이다 (2026-10-05)
  if (snapshot.active === false && snapshot.appMode) {
    const m = snapshot.appMode;
    const keys = {};
    for (const k of LOGICAL_KEYS) {
      const id = LOGICAL_KEY_SLOT[k] ?? `key${k.replace('slot', '')}`;
      keys[k] = layerKeyStyle(m, id, overlays[k]);
    }
    return {
      revision: snapshot.revision, inactive: false, keys,
      // 앱 레이어의 언더글로우는 레이어 설정, 없으면 레이어 색 고정 (2026-10-10). Orca 상태는 Orca 레이어에서만
      ambientZone: capabilities.supportsAmbientZone === false ? null
        : { ...(m.underglow ?? { color: m.color, brightness: LAYER_UNDERGLOW.brightness, e: 1, s: LAYER_UNDERGLOW.s }) },
      ambientFallback: null, notice: { active: false, targets: [] }, uncontrollableKeys: [], unsupported: [],
    };
  }
  // 대기(앞 앱이 소스도 아니고 키 세트도 없음): 키·점멸·대체 표현 없이 '복원' 표시만. 드라이버가 레이어색 페이로드로 바꾼다 (스펙 §4.2)
  if (snapshot.active === false) {
    return {
      revision: snapshot.revision, inactive: true, keys: {}, ambientZone: null, ambientFallback: null,
      notice: { active: false, targets: [] }, uncontrollableKeys: [], unsupported: [],
    };
  }
  const keys = {};
  snapshot.lighting.threads.forEach((s, i) => { keys[`slot${i + 1}`] = { ...s }; });

  // ambient zone이 없는 장치에서는 숨은 개입을 슬롯 LED 점멸로 알린다 (실기 7차).
  let ambientFallback = null;
  if (capabilities.supportsAmbientZone === false && ambientPhase !== null) {
    const overlay = ambientOverlay({
      slotStatuses: snapshot.slots.map((x) => x.status),
      ambientSummary: snapshot.lighting.ambientZone?.color === 'off'
        ? null : ambientSummaryOf(snapshot),
      hiddenAttentionCount: snapshot.hiddenAttentionCount ?? 0,
    }, ambientPhase);
    ambientFallback = {
      active: overlay.plan.active,
      pulsing: overlay.indices.length > 0,
      targets: overlay.plan.targets,
      reasonKo: overlay.plan.reasonKo,
    };
    for (const i of overlay.indices) {
      keys[`slot${i + 1}`] = { ...overlay.style, ambientPulse: true };
    }
  }

  // 새로 들어온 개입은 짧게 점멸해 알린다. 색은 그대로 두고 꺼짐만 번갈아 한다.
  // 승인이 연달아 오면 상태 값이 같아 색으로는 구분되지 않기 때문이다 (12차).
  const slots = snapshot.slots ?? [];
  const fresh = freshNoticeSlots({ slots, now });
  const notice = { active: fresh.length > 0, targets: fresh.map((i) => `slot${i + 1}`) };
  for (const i of fresh) {
    // 슬롯마다 자기 진입 시각으로 센다. 전역 위상에 끌려가지 않는다.
    if (!noticeOverlay(now - slots[i].attentionSince).off) continue;
    keys[`slot${i + 1}`] = { ...keys[`slot${i + 1}`], brightness: 0, noticePulse: true };
  }

  if (snapshot.layerKeys) {
    // 앱: 키 11·12·13은 Orca 레이어 칸 (2026-10-05)
    for (const [k, id] of Object.entries(LOGICAL_KEY_SLOT)) keys[k] = layerKeyStyle(snapshot.layerKeys, id, overlays[k]);
  } else {
    // 진단 도구·데모: Output 내장 ATTENTION·ACK·MODE 모습
    keys.attention = { ...attentionKeyStyle(snapshot) };
    keys.ack = { ...ackKeyStyle(snapshot) };
    keys.mode_back = { ...modeKeyStyle(snapshot) };
  }

  const ambientZone = ambientZoneOf(snapshot, capabilities);

  const controllable = Array.isArray(capabilities.controllableKeys)
    ? capabilities.controllableKeys : null;
  const uncontrollableKeys = controllable
    ? LOGICAL_KEYS.filter((k) => !controllable.includes(k))
    : [];

  return {
    revision: snapshot.revision,
    inactive: false,
    keys,
    ambientZone,
    ambientFallback,
    notice,
    // 제어할 수 없는 키를 조용히 버리지 않는다 (실기 7차: ACT 7키 미제어)
    uncontrollableKeys,
    // 미지원 기능은 추측해서 보내지 않고 사유를 남긴다 (C24).
    unsupported: [
      ...(capabilities.supportsAmbientZone === false ? ['ambientZone'] : []),
      ...(uncontrollableKeys.length ? ['perKeyColor:' + uncontrollableKeys.join(',')] : []),
    ],
  };
}

/** 전체 요약 상태. 색이 여러 상태에 같으므로(개입은 모두 빨강) 색에서 되짚지 않는다. */
function ambientSummaryOf(snapshot) {
  return snapshot.ambientSummary ?? null;
}
