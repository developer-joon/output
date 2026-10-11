/**
 * calibration 빌더 — 실측 관측에서 런타임이 쓸 매핑을 만든다.
 *
 * HARDWARE_CONTRACT.md는 고치지 않는다 (AGENTS.md 1번).
 * 물리 역할은 계약 그대로이고, **키코드/이벤트 대응만** 실측으로 교정한다.
 * 관측하지 않은 것은 확정하지 않고 unverified에 남긴다.
 */
import { LOGICAL_TO_AG } from '../../src/core/hardware.js';
import { logicalAt, KEY_COUNT, readingOrderPositions, agLabel } from './layout.js';
import {
  inferIdentifierField, compareWithAgNumbers, analyzeDial, analyzeJoystick,
} from './inputProbe.js';

export const CALIBRATION_VERSION = 1;

/**
 * 여러 번의 관측을 합친다.
 *  - 키 단계(key-*): 이벤트가 있는 **최신 관측이 이긴다** (같은 키에 옛 ACT / 새 AG가 있을 수 있다. 실기 17차)
 *  - 그 밖(노브·조이스틱): 이어 붙인다 — 한 번의 실행에서 놓친 방향이 다른 실행에 있을 수 있다
 * 바뀐 키 단계는 비열거 속성 replacedSteps 로 알린다 (리포트용).
 */
export function mergeInputRecords(...sets) {
  const out = {};
  const replacedSteps = [];
  const firstKey = (events) => events.find((e) => e?.p?.k != null)?.p?.k ?? null;
  for (const set of sets) {
    for (const [stepId, rec] of Object.entries(set ?? {})) {
      const events = rec.events ?? [];
      if (!out[stepId]) out[stepId] = { skipped: true, events: [] };
      const cur = out[stepId];
      if (stepId.startsWith('key-') && events.length) {
        const before = firstKey(cur.events);
        const after = firstKey(events);
        if (cur.events.length && before !== after) replacedSteps.push({ stepId, before, after });
        cur.events = [...events];
      } else {
        cur.events.push(...events);
      }
      if (!rec.skipped) cur.skipped = false;
    }
  }
  Object.defineProperty(out, 'replacedSteps', { value: replacedSteps, enumerable: false });
  return out;
}

/** 관측된 이벤트 키코드('AG00')를 전체 키코드('KV_OAI_AG00')로 */
export function fullKeycode(short) {
  return /^KV_OAI_/.test(short) ? short : `KV_OAI_${short}`;
}

/**
 * @param {object} input
 * @param {object} input.inputRecords  doctor --input 의 records
 * @param {object} [input.ledMapping]  {index: {row,col}} doctor --leds 결과
 * @param {number[]} [input.ledNotLit] 색이 바뀌지 않은 index
 * @param {object|null} [input.ledAmbient] 언더글로우 제어 수단 (실기 16차: 가상 스레드 id + sa)
 * @param {object} [input.device]
 * @param {string[]} [input.sourcesKo]
 */
export function buildCalibration({
  inputRecords = {}, ledMapping = null, ledNotLit = [], ledAmbient = null, device = null,
  sourcesKo = [], now = () => new Date().toISOString(),
} = {}) {
  const identifier = inferIdentifierField(inputRecords);
  const agComparison = compareWithAgNumbers(identifier);
  const dial = analyzeDial(inputRecords);
  const joystick = analyzeJoystick(inputRecords);

  const unverified = [];
  const contractDeviations = [];

  // ── 키: 물리 위치 → 실측 키코드
  const logicalToKeycode = {};
  const eventKeyToLogical = {};
  if (agComparison?.rows.length) {
    for (const row of agComparison.rows) {
      if (!row.logical || row.raw == null) continue;
      logicalToKeycode[row.logical] = fullKeycode(row.raw);
      eventKeyToLogical[String(row.raw)] = row.logical;
      const contractAg = LOGICAL_TO_AG[row.logical];
      const observedAg = agLabel(row.observed);
      if (contractAg && contractAg !== observedAg) {
        contractDeviations.push({
          logical: row.logical,
          contract: contractAg,
          measured: row.raw,
          reasonKo: `계약은 ${contractAg}로 권장하지만 실측 이벤트는 ${row.raw}입니다.`,
        });
      }
    }
  } else {
    unverified.push('키 이벤트를 관측하지 못해 키코드 대응을 확정하지 못함');
  }

  // ── 노브
  const dialOut = {
    event: 'v.oai.hid', rotateAct: 2, pressAct: 1, releaseAct: 0,
    codeNamingInverted: dial.rotationNaming === 'inverted',
    cw: dial.cw.codes[0] ? fullKeycode(dial.cw.codes[0]) : null,
    ccw: dial.ccw.codes[0] ? fullKeycode(dial.ccw.codes[0]) : null,
    click: dial.click.codes[0] ? fullKeycode(dial.click.codes[0]) : null,
    clickSupported: dial.click.count > 0,
  };
  if (dialOut.cw) logicalToKeycode.dial_cw = dialOut.cw;
  if (dialOut.ccw) logicalToKeycode.dial_ccw = dialOut.ccw;
  if (dialOut.click) logicalToKeycode.dial_click = dialOut.click;
  if (dial.rotationNaming === 'unknown') {
    unverified.push('노브 회전 코드 이름과 실제 방향의 대응 (한쪽만 관측)');
  }
  if (!dialOut.clickSupported) unverified.push('노브 클릭 이벤트');
  if (dialOut.codeNamingInverted) {
    contractDeviations.push({
      logical: 'dial_cw',
      contract: LOGICAL_TO_AG.dial_cw ?? null,
      measured: dialOut.cw,
      reasonKo: '회전 코드 이름이 실제 방향과 반대입니다. 이름을 믿으면 방향이 뒤집힙니다.',
    });
  }

  // ── 조이스틱
  const joystickOut = {
    mode: 'VENDOR',
    event: 'v.oai.rad',
    angleField: 'p.a',
    distanceField: 'p.d',
    deadzone: 0.05,
    neutralDistance: 0,
    sectors: joystick.sectors
      ? joystick.sectors.map((s) => ({
        direction: s.dir,
        center: Number(s.center.toFixed(4)),
        from: Number(s.from.toFixed(4)),
        to: Number(s.to.toFixed(4)),
      }))
      : null,
  };
  const missingDirs = ['up', 'down', 'left', 'right'].filter((d) => !joystick.measured.includes(d));
  if (missingDirs.length) unverified.push(`조이스틱 방향 미관측: ${missingDirs.join(', ')}`);
  const weakDirs = joystick.measured.filter((d) => joystick.byDir[d].weak);
  if (weakDirs.length) unverified.push(`조이스틱 약한 입력만 관측: ${weakDirs.join(', ')}`);

  // ── LED
  const indexToLogical = {};
  const controllable = [];
  if (ledMapping) {
    for (const [idxStr, pos] of Object.entries(ledMapping)) {
      const logical = logicalAt(pos.row, pos.col);
      if (!logical) continue;
      indexToLogical[idxStr] = logical;
      controllable.push(Number(idxStr));
    }
  }
  controllable.sort((a, b) => a - b);
  const ledOut = {
    method: 'v.oai.thstatus',
    addressing: 'array_position',
    keyCount: KEY_COUNT,
    payloadParams: { b: 1, e: 1, s: 0.5, sk: 0, sa: 0 },
    controllableIndices: controllable,
    indexToLogical,
    notControllableIndices: [...ledNotLit].sort((a, b) => a - b),
    clearMethod: null,
    baseColorSource: 'layer.color',
    // 언더글로우: 물리 키 없는 가상 스레드 id + sa 플래그 (실기 16차). 관측이 없으면 null
    ambient: ledAmbient && ledAmbient.method === 'virtual_thread' ? { ...ledAmbient } : null,
  };
  if (!ledMapping) unverified.push('LED 배열 index → 물리 위치 매핑');
  if (ledNotLit.length) {
    unverified.push(`LED가 바뀌지 않은 index ${ledNotLit.join(',')} — `
      + '물리적으로 없는지 다른 수단이 필요한지 미확정');
  }
  if (!ledOut.ambient) unverified.push('언더글로우(ambient zone) 제어 수단');
  unverified.push('키별 지정을 해제해 기본색으로 되돌리는 수단');

  return {
    version: CALIBRATION_VERSION,
    calibratedAt: now(),
    device,
    sourcesKo,
    keyEvent: {
      event: 'v.oai.hid', keyField: 'p.k', actField: 'p.act', press: 1, release: 0,
    },
    logicalToKeycode,
    eventKeyToLogical,
    dial: dialOut,
    joystick: joystickOut,
    led: ledOut,
    contractDeviations,
    unverified,
  };
}

/** 최소 일관성 검사. 통과 못 하면 --apply를 막는다. */
export function validateCalibration(cal) {
  const problems = [];
  if (cal?.version !== CALIBRATION_VERSION) problems.push('version이 올바르지 않습니다.');

  const expectedLogicals = readingOrderPositions().map((p) => p.logical);
  for (const logical of expectedLogicals) {
    if (!cal?.logicalToKeycode?.[logical]) problems.push(`키코드 미확정: ${logical}`);
  }
  const codes = expectedLogicals.map((l) => cal?.logicalToKeycode?.[l]).filter(Boolean);
  if (new Set(codes).size !== codes.length) problems.push('같은 키코드가 둘 이상의 역할에 배정되었습니다.');

  for (const [k, logical] of Object.entries(cal?.eventKeyToLogical ?? {})) {
    const back = cal.logicalToKeycode?.[logical];
    if (back && back !== fullKeycode(k)) {
      problems.push(`역방향 대응이 어긋납니다: ${k} ↔ ${logical}`);
    }
  }
  if (cal?.led?.addressing !== 'array_position') problems.push('LED 주소 방식이 확정되지 않았습니다.');
  if (!Array.isArray(cal?.unverified)) problems.push('unverified 목록이 없습니다.');
  return { ok: problems.length === 0, problems };
}

export function formatCalibrationReport(cal) {
  const L = [];
  L.push('── calibration 초안 ──');
  L.push(`  기준: ${cal.sourcesKo.join(' · ') || '(미기재)'}`);
  L.push('');
  L.push('  논리 역할 → 실측 키코드');
  for (const p of readingOrderPositions()) {
    const code = cal.logicalToKeycode[p.logical] ?? '(미확정)';
    const contract = LOGICAL_TO_AG[p.logical];
    const deviated = cal.contractDeviations.some((d) => d.logical === p.logical);
    L.push(`    ${String(p.logical).padEnd(11, ' ')} ${code.padEnd(16, ' ')}`
      + (deviated ? `⚠ 계약 권장은 ${contract}` : ''));
  }
  for (const k of ['dial_cw', 'dial_ccw', 'dial_click']) {
    if (cal.logicalToKeycode[k]) {
      L.push(`    ${k.padEnd(11, ' ')} ${cal.logicalToKeycode[k]}`);
    }
  }
  L.push('');
  L.push('  노브');
  L.push(`    코드 이름 반전: ${cal.dial.codeNamingInverted ? '예 (실측대로 매핑)' : '아니오'}`);
  L.push(`    클릭 지원: ${cal.dial.clickSupported ? '예' : '미검증'}`);
  L.push('');
  L.push('  조이스틱');
  if (cal.joystick.sectors) {
    for (const s of cal.joystick.sectors) {
      L.push(`    ${s.direction.padEnd(6, ' ')} ${s.from} ~ ${s.to} (중심 ${s.center})`);
    }
  } else {
    L.push('    구간 미확정');
  }
  L.push('');
  L.push('  LED');
  L.push(`    주소 방식: ${cal.led.addressing} (${cal.led.keyCount}개 배열)`);
  L.push(`    제어 확인된 index: ${cal.led.controllableIndices.join(', ') || '없음'}`);
  L.push(`    바뀌지 않은 index: ${cal.led.notControllableIndices.join(', ') || '없음'}`);
  L.push(`    언더글로우: ${cal.led.ambient ? `가상 스레드 id ${cal.led.ambient.id} + ${cal.led.ambient.flag}:1` : '수단 없음'}`);
  if (cal.contractDeviations.length) {
    L.push('');
    L.push('  ⚠ 계약과 다른 점 (계약 문서는 고치지 않고 여기에 기록)');
    for (const d of cal.contractDeviations) L.push(`    ${d.logical}: ${d.reasonKo}`);
  }
  L.push('');
  L.push('  미검증으로 남는 항목');
  for (const u of cal.unverified) L.push(`    · ${u}`);
  return L.join('\n');
}
