import fs from 'node:fs';
import path from 'node:path';

/**
 * calibration 로더.
 *
 * 파일이 없으면 **전부 미검증**으로 동작한다. 계약 값을 사실처럼 쓰지 않는다.
 * 런타임은 이 파일을 읽기만 한다 (AGENTS.md 2번: runtime fs.write 금지).
 */
export const DEFAULT_CALIBRATION_PATH = 'config/calibration.json';

/** calibration이 없을 때의 상태. 아무것도 확정하지 않는다. */
export const UNCALIBRATED = Object.freeze({
  version: 0,
  calibrated: false,
  logicalToKeycode: {},
  eventKeyToLogical: {},
  dial: { clickSupported: false, codeNamingInverted: false, cw: null, ccw: null, click: null },
  joystick: { sectors: null, deadzone: 0.05 },
  led: {
    addressing: null, keyCount: 13, controllableIndices: [], indexToLogical: {},
    notControllableIndices: [], payloadParams: { b: 1, e: 1, s: 0.5, sk: 0, sa: 0 },
    ambient: null,
  },
  unverified: ['calibration 파일이 없습니다 — 모든 하드웨어 기능이 미검증입니다.'],
});

/** 2026-10-01 이전 보정 파일의 논리 이름. 키 7~10이 칸이 되며 바뀌었다 */
export const LEGACY_LOGICAL = Object.freeze({ A1: 'slot7', A2: 'slot8', A3: 'slot9', A4: 'slot10' });

function renameLegacy(parsed) {
  const r = (o) => (o ? Object.fromEntries(Object.entries(o).map(([k, v]) => [LEGACY_LOGICAL[k] ?? k, LEGACY_LOGICAL[v] ?? v])) : o);
  return {
    ...parsed,
    logicalToKeycode: r(parsed.logicalToKeycode),
    eventKeyToLogical: r(parsed.eventKeyToLogical),
    led: parsed.led ? { ...parsed.led, indexToLogical: r(parsed.led.indexToLogical) } : parsed.led,
  };
}

/**
 * @returns {{calibration:object, calibrated:boolean, sourceKo:string, problems:string[]}}
 */
export function loadCalibration({ root = process.cwd(), file = DEFAULT_CALIBRATION_PATH } = {}) {
  const full = path.resolve(root, file);
  if (!fs.existsSync(full)) {
    return {
      calibration: UNCALIBRATED,
      calibrated: false,
      sourceKo: `${file} 없음 — 미검증 상태로 동작합니다`,
      problems: [],
    };
  }
  try {
    const parsed = renameLegacy(JSON.parse(fs.readFileSync(full, 'utf8')));
    const problems = [];
    if (parsed.led?.addressing !== 'array_position') {
      problems.push('LED 주소 방식이 확정되지 않았습니다.');
    }
    if (!Object.keys(parsed.logicalToKeycode ?? {}).length) {
      problems.push('키코드 대응이 비어 있습니다.');
    }
    return {
      calibration: { ...parsed, calibrated: problems.length === 0 },
      calibrated: problems.length === 0,
      sourceKo: `${file} (${parsed.calibratedAt ?? '시각 미상'})`,
      problems,
    };
  } catch (err) {
    return {
      calibration: UNCALIBRATED,
      calibrated: false,
      sourceKo: `${file} 읽기 실패 — 미검증 상태로 동작합니다`,
      problems: [err.message],
    };
  }
}

/**
 * calibration → DeviceScene이 쓰는 capability.
 * 실기에서 확인되지 않은 것은 false로 둔다.
 */
export function capabilitiesFrom(calibration) {
  const led = calibration?.led ?? {};
  const controllableKeys = Object.entries(led.indexToLogical ?? {})
    .filter(([idx]) => (led.controllableIndices ?? []).includes(Number(idx)))
    .map(([, logical]) => logical);
  return {
    perKeyColor: controllableKeys.length > 0,
    controllableKeys,
    // 언더글로우: 물리 키 없는 가상 스레드 id + sa 플래그 (실기 16차)
    supportsAmbientZone: led.ambient?.method === 'virtual_thread',
    dialClick: Boolean(calibration?.dial?.clickSupported),
    joystick: Boolean(calibration?.joystick?.sectors?.length),
    miniLeds: false,
  };
}
