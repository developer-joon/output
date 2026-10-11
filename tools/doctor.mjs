#!/usr/bin/env node
/**
 * Output doctor — 읽기 전용 장치 조사 (M3-3).
 *
 *   node tools/doctor.mjs                 실장치, 읽기 전용
 *   node tools/doctor.mjs --save          결과를 config/capability.json 에 저장
 *   node tools/doctor.mjs --fake          장치 없이 동작 확인
 *   node tools/doctor.mjs --force-shared  단독 열기 실패 시 공유로 열기 (권장하지 않음)
 *   node tools/doctor.mjs --json          리포트 대신 JSON 출력
 *   node tools/doctor.mjs --dump-keymap   모든 레이어의 keymap 원문 출력
 *   node tools/doctor.mjs --files        장치 파일 목록 (fs.list, 읽기 전용)
 *   node tools/doctor.mjs --leds          대화형 LED 확인 (TTY 필요)
 *   node tools/doctor.mjs --leds --force-leds   활성 레이어에 키코드가 없어도 강행
 *   node tools/doctor.mjs --probe-params  thstatus 파라미터 의미 탐색 (TTY 필요)
 *   node tools/doctor.mjs --restore-leds  13개 키를 활성 레이어 색으로 칠함 (대화 불필요)
 *   node tools/doctor.mjs --restore-leds=1A1A4D   색 직접 지정
 *   node tools/doctor.mjs --leds-off      13개 키 소등
 *   node tools/doctor.mjs --input         키/노브/조이스틱 이벤트 관측 (쓰기 없음, TTY 필요)
 *   node tools/doctor.mjs --input --save-records=test/fixtures/input-events-real-3.json   관측 원본 저장 (calibrate 입력)
 *   node tools/doctor.mjs --preview       런타임 scene을 실기에 그려 눈으로 확인
 *   node tools/doctor.mjs --preview=pulse 시나리오 하나만
 *   node tools/doctor.mjs --live         실기 입력 → 상태 → 조명 왕복 (기본 60초)
 *   node tools/doctor.mjs --live=30      초 지정
 *   node tools/doctor.mjs --live --orca  실제 Orca worktree/terminal로 (진짜 터미널 전환)
 *   OUTPUT_HOME=/경로 node tools/doctor.mjs --live --orca   상태 저장 위치 변경 (기본 ~/.output)
 *
 * keymap(플래시)에 쓰지 않는다. fs.write는 transport 단에서 차단한다.
 * --leds 는 LED를 켠다. 이는 장치 출력 제어이므로 명시적으로 요청할 때만 한다.
 * 어떤 종료 경로에서도 전체 소등을 보장한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  findAgentBindings, resolveActive, compareWithContract, buildCapabilityDraft, formatReport,
  scanAllLayers, cellKeycode,
} from './lib/doctorReport.js';
import { runRainbowMap, formatRainbowReport } from './lib/rainbowMap.js';
import { runInputProbe, formatInputReport } from './lib/inputProbe.js';
import { safeWriteJson } from './lib/safeWrite.js';
import { SCENARIOS, formatExpectations } from './lib/previewScenarios.js';
import {
  PrintingFocusRouter, PrintingActionRouter, statusLine, makeDispatcher,
  describeIntent, summarize,
} from './lib/liveSession.js';
import { InputDecoder } from '../src/input/inputDecoder.js';
import { DeviceEventDecoder } from '../src/input/deviceEventDecoder.js';
import { seedWorkUnits } from '../src/adapters/mockOrcaAdapter.js';
import { createOrcaStack } from '../src/adapters/orca/index.js';
import { createPersistence } from '../src/adapters/persistence/index.js';
import { StateStore } from '../src/core/stateStore.js';
import { loadCalibration, capabilitiesFrom } from '../src/device/calibrationLoader.js';
import { DeviceDriver } from '../src/device/deviceDriver.js';
import { RenderScheduler } from '../src/device/renderScheduler.js';
import { Output } from '../src/output.js';
import { agLabel, expectedPositionOf, KEY_COUNT } from './lib/layout.js';
import { isInteractive, createPrompt } from './lib/prompt.mjs';
import { runParamProbe, formatParamReport } from './lib/paramProbe.js';
import { resolveRestoreColor, uniformPayload, offPayload as allOffPayload }
  from './lib/ledRestore.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** doctor가 호출해도 되는 method. 그 밖은 보내지 않는다. */
export const READ_ONLY_METHODS = Object.freeze(['sys.version', 'device.status', 'fs.read']);
export const BLOCKED_METHODS = Object.freeze(['fs.write']);
/** --leds에서만 추가로 허용하는 출력 method. 관측된 것만 쓴다. */
export const LED_METHOD = 'v.oai.thstatus';
/**
 * --files에서만 허용하는 읽기 method. Input 앱이 쓰는 것을 확인했다.
 * 레이어 전환이 keymap 전체 쓰기가 아니라 작은 상태 파일 쓰기라면
 * 그 파일이 여기 보인다. 읽기뿐이므로 장치를 바꾸지 않는다.
 */
export const LIST_METHOD = 'fs.list';
/**
 * Orca 목록을 다시 읽는 주기.
 * `worktree ps`가 약 140ms이고 '나를 기다린다'는 신호는 빠를수록 쓸모 있다.
 */
export const ORCA_REFRESH_MS = 2000;

/** 장치에서 읽기만 해서 관측치를 모은다. */
export async function collectObservations(transport) {
  const safe = async (method, params) => {
    try {
      return { ok: true, value: await transport.call(method, params) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  };

  const version = await safe('sys.version');
  const status = await safe('device.status');
  const keymapRaw = await safe('fs.read', { file: 'keymap.json' });

  let config = null;
  let parseError = null;
  if (keymapRaw.ok && typeof keymapRaw.value?.data === 'string') {
    try {
      config = JSON.parse(keymapRaw.value.data);
    } catch (err) {
      parseError = err.message;
    }
  } else if (keymapRaw.ok) {
    parseError = 'fs.read keymap.json 응답 형식이 예상과 다릅니다.';
  }

  return {
    version: version.ok ? version.value : null,
    versionError: version.ok ? null : version.error,
    status: status.ok ? status.value : null,
    statusError: status.ok ? null : status.error,
    config,
    keymapError: keymapRaw.ok ? parseError : keymapRaw.error,
  };
}

/** 관측치 → 리포트 + capability 초안. 순수. */
export function analyze(obs, {
  info, ownership, observedAt, methodsSeen = ['v.oai.thstatus'], dumpKeymap = false,
}) {
  let active = { profileIndex: 0, layerIndex: 0, profile: null, layer: null };
  let keymap = null;
  let activeError = obs.keymapError;
  if (obs.config) {
    try {
      active = resolveActive(obs.config, obs.status ?? {});
      keymap = active.layer?.layout?.keymap ?? null;
    } catch (err) {
      activeError = err.message;
    }
  }

  // 활성 레이어에 없어도 다른 레이어에 있을 수 있다.
  const allLayers = obs.config ? scanAllLayers(obs.config) : [];
  const bindings = findAgentBindings(keymap);
  const allBindings = allLayers.flatMap((l) => l.bindings);
  // 계약 대조는 '어느 레이어에든 존재하는가' 기준으로 한다.
  const contract = compareWithContract(allBindings);
  const capability = buildCapabilityDraft({
    version: obs.version, status: obs.status, bindings: allBindings, methodsSeen, observedAt,
  });
  capability.activeLayer = {
    profileIndex: active.profileIndex,
    layerIndex: active.layerIndex,
    name: active.layer?.name ?? null,
    agBindings: bindings.length,
  };
  capability.layers = allLayers.map((l) => ({
    profileIndex: l.profileIndex, layerIndex: l.layerIndex, name: l.layerName,
    keyCount: l.rows.reduce((a, b) => a + b, 0), agBindings: l.bindings.length,
  }));
  // 관측된 '키코드가 존재한다'는 사실. 동작 여부(dial.click 등)와는 별개다.
  const encLayer = allLayers.find((l) => l.encoders) ?? null;
  const joyLayer = allLayers.find((l) => l.joystick) ?? null;
  capability.keycodes = {
    encoders: encLayer
      ? encLayer.encoders.map((e) => (Array.isArray(e) ? e : [e]).map(cellKeycode))
      : null,
    joystickType: joyLayer?.joystick?.type ?? null,
  };
  if (!allBindings.length) {
    capability.notes.push('어떤 레이어에서도 KV_OAI_AG 키코드를 찾지 못함');
  }

  const report = formatReport({
    info, version: obs.version, status: obs.status, active, keymap, bindings,
    contract, capability, ownership, allLayers, dumpKeymap,
  });

  const warnings = [obs.versionError, obs.statusError, activeError]
    .filter(Boolean).map((m) => `조회 실패: ${m}`);
  if (obs.config && !allBindings.length) {
    warnings.push('AG 키코드를 어느 레이어에서도 찾지 못했습니다. --dump-keymap 으로 원문을 확인하세요.');
  }

  return { active, keymap, bindings, allLayers, allBindings, contract, capability, report, warnings };
}

/** 이번 실행에서 보낼 수 있는 method. 그 밖은 프레임조차 나가지 않는다. */
export function methodsFor({
  leds = false, probeParams = false, restoreLeds = false, ledsOff = false,
  preview = false, live = false, files = false,
} = {}) {
  const needsLed = leds || probeParams || restoreLeds || ledsOff || preview || live;
  return [
    ...READ_ONLY_METHODS,
    ...(needsLed ? [LED_METHOD] : []),
    ...(files ? [LIST_METHOD] : []),
  ];
}

/**
 * fs.list 응답을 사람이 읽을 수 있게.
 *
 * 실측(2026-09-25): 최상위가 배열이고 각 항목은 `{name, size}`다.
 *   [{"name":"keymap.json","size":3888},{"name":"smart_actions.json","size":1125}]
 *
 * 모양이 다르면 원문을 그대로 보여준다. 읽지 못한 것을 없다고 하지 않는다.
 */
export function formatFileList(result) {
  const files = Array.isArray(result) ? result
    : Array.isArray(result?.files) ? result.files
      : Array.isArray(result?.list) ? result.list : null;
  if (!files) {
    if (!result || typeof result !== 'object') return '  파일 목록을 읽지 못했습니다.';
    return `  예상과 다른 응답입니다. 원문:\n  ${JSON.stringify(result)}`;
  }
  if (!files.length) return '  파일이 없습니다.';
  return files.map((f) => {
    if (typeof f === 'string') return `  · ${f}`;
    if (f && typeof f === 'object' && f.name) {
      return `  · ${f.name}${f.size === undefined ? '' : `  (${f.size} bytes)`}`;
    }
    return `  · ${JSON.stringify(f)}`;
  }).join('\n');
}

async function openTransportFor(args) {
  const allowedMethods = methodsFor(args);
  if (args.fake) {
    const { FakeTransport } = await import('../src/device/transport/fakeTransport.js');
    const fixture = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'test/fixtures/cm2-device.json'), 'utf8'),
    );
    return {
      transport: new FakeTransport({
        info: fixture.info,
        blockedMethods: BLOCKED_METHODS,
        allowedMethods,
        responses: {
          'sys.version': fixture.version,
          'device.status': fixture.status,
          'fs.read': () => ({ data: JSON.stringify(fixture.keymap) }),
          [LED_METHOD]: () => ({ ok: 1 }),
        },
      }),
      ownership: '가짜 장치 — 소유권 검사 없음',
    };
  }

  const { openHidTransport } = await import('../src/device/transport/hidTransport.js');
  try {
    const t = openHidTransport({ exclusive: true, blockedMethods: BLOCKED_METHODS, allowedMethods });
    return { transport: t, ownership: '단독 열기 성공 — 다른 프로세스가 점유하지 않음' };
  } catch (err) {
    if (err.code === 'DEVICE_BUSY' && args.forceShared) {
      const t = openHidTransport({
        exclusive: false, blockedMethods: BLOCKED_METHODS, allowedMethods,
      });
      return { transport: t, ownership: '⚠ 공유 열기 — 다른 앱과 논리 충돌이 있을 수 있습니다' };
    }
    throw err;
  }
}

/**
 * LED 점등 세션. 부작용 함수를 주입받아 테스트 가능하게 한다.
 * 어떤 종료 경로에서도 전체 소등을 보장한다.
 */
export async function runLedSession(transport, {
  ask, print = console.log, sleep = (ms) => new Promise((r) => { setTimeout(r, ms); }),
  settleMs = 500,
} = {}) {
  // 실기 6차: 배열 위치가 곧 키다. 13개를 한 번에 보낸다.
  // 기본색 복구 수단은 아직 없으므로, 끝나면 소등하지 않고 그대로 둔다.
  // 복구는 --restore-leds 가 담당한다.
  const onSignal = () => { process.exit(130); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    return await runRainbowMap({
      paint: (payload) => transport.call(LED_METHOD, payload),
      ask,
      sleep,
      print,
    }, { settleMs });
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

/** 입력 관측 원본을 픽스처 형식으로 저장한다. calibrate.mjs RECORDED_SOURCES 가 읽는 형식과 같다. */
export function saveInputRecords(target, records, { now = () => new Date().toISOString() } = {}) {
  return safeWriteJson(target, {
    _note: `doctor --input 관측 (${now()}). calibrate.mjs RECORDED_SOURCES 에 넣어 쓴다.`,
    records,
  });
}

/**
 * 입력 관측 세션. 장치에 쓰지 않는다 — 알림을 받기만 한다.
 */
export async function runInputSession(transport, { ask, print = console.log } = {}) {
  const buffer = [];
  const off = transport.onNotification((obj) => buffer.push(obj));
  try {
    return await runInputProbe({
      drain: () => buffer.splice(0, buffer.length),
      ask,
      print,
    });
  } finally {
    off();
  }
}

/** 입력 관측 결과를 capability에 합친다. */
export function mergeInputObservations(capability, result) {
  const next = structuredClone(capability);
  next.inputProbe = {
    verdict: result.verdict.verdict,
    identifierField: result.identifier?.field ?? null,
    byStep: Object.fromEntries(Object.entries(result.records).map(
      ([k, v]) => [k, { skipped: v.skipped, eventCount: v.events.length }],
    )),
    agComparison: result.agComparison
      ? { contractHits: result.agComparison.contractHits,
        readingHits: result.agComparison.readingHits,
        rows: result.agComparison.rows }
      : null,
  };
  const notes = [result.verdict.messageKo];
  if (result.agComparison?.conclusionKo) notes.push(result.agComparison.conclusionKo);
  if (result.aborted) notes.push('사용자가 입력 관측을 중단함 — 나머지는 미관측');
  next.notes = [...next.notes, ...notes];
  return next;
}

/** 측정 결과를 capability에 합친다. */
export function mergeLedMapping(capability, result) {
  const next = structuredClone(capability);
  for (let i = 0; i < KEY_COUNT; i += 1) {
    const key = agLabel(i);
    if (!next.keys[key]) continue;
    const m = result.mapping[i] ?? null;
    next.keys[key].led = m ? 'yes' : 'unknown';
    next.keys[key].ledArrayIndex = i;
    next.keys[key].measuredPosition = m;
    next.keys[key].expectedPosition = expectedPositionOf(i);
  }
  next.method = result.aborted ? 'doctor --leds (중단됨)' : 'doctor --leds';
  next.ledAddressing = 'array_position';
  next.positionCheck = {
    checked: result.comparison.checked,
    mismatches: result.comparison.mismatches.map((m) => ({
      ledArrayIndex: m.index, measured: m.measured, expected: m.expected,
    })),
  };
  const notes = [result.comparison.messageKo];
  if (result.comparison.mismatches.length) {
    notes.push('LED 배열 index와 AG 번호가 같다고 가정할 수 없다. calibration에 실측값을 쓴다.');
  }
  if (result.aborted) notes.push('사용자가 측정을 중단함 — 나머지는 미측정');
  next.notes = [...next.notes, ...notes];
  return next;
}

function parseArgs(argv) {
  const has = (f) => argv.includes(f);
  return {
    fake: has('--fake'),
    save: has('--save'),
    json: has('--json'),
    dumpKeymap: has('--dump-keymap'),
    files: has('--files'),
    forceShared: has('--force-shared'),
    leds: has('--leds'),
    forceLeds: has('--force-leds'),
    probeParams: has('--probe-params'),
    restoreLeds: argv.some((a) => a === '--restore-leds' || a.startsWith('--restore-leds=')),
    restoreColor: (argv.find((a) => a.startsWith('--restore-leds=')) ?? '').split('=')[1] ?? null,
    ledsOff: has('--leds-off'),
    input: has('--input'),
    saveRecords: (argv.find((a) => a.startsWith('--save-records=')) ?? '').split('=')[1] || null,
    preview: argv.some((a) => a === '--preview' || a.startsWith('--preview=')),
    previewOnly: (argv.find((a) => a.startsWith('--preview=')) ?? '').split('=')[1] ?? null,
    orca: has('--orca'),
    orcaBin: (argv.find((a) => a.startsWith('--orca-bin=')) ?? '').split('=')[1] || 'orca',
    live: argv.some((a) => a === '--live' || a.startsWith('--live=')),
    liveSeconds: Number((argv.find((a) => a.startsWith('--live=')) ?? '').split('=')[1]) || 60,
  };
}

async function main(argv) {
  const args = parseArgs(argv);
  let handle;
  try {
    handle = await openTransportFor(args);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const { transport, ownership } = handle;
  try {
    const obs = await collectObservations(transport);
    const result = analyze(obs, {
      info: transport.info, ownership, observedAt: new Date().toISOString(),
      dumpKeymap: args.dumpKeymap,
    });

    // 활성 레이어. 색 복구(--restore-leds·--live·--preview 종료)가 쓴다.
    const activeLayer = result.allLayers.find(
      (l) => l.profileIndex === result.active.profileIndex
        && l.layerIndex === result.active.layerIndex,
    );
    /** 레이어 색으로 되돌린다. */
    const restoreLayerColor = async () => {
      const { color } = resolveRestoreColor({ activeLayerColor: activeLayer?.color ?? null });
      if (color === null) return;
      try {
        await transport.call(LED_METHOD, uniformPayload(color));
      } catch { /* 복구 실패가 종료를 막지 않게 한다 */ }
    };
    /** 보정을 읽어 driver를 만든다. 보정이 없으면 알리고 null (exit 12). */
    const openDriver = (whyKo) => {
      const cal = loadCalibration({ root: ROOT });
      if (!cal.calibrated) {
        console.error(`\n${whyKo} — ${cal.sourceKo}`);
        console.error('먼저 실행하세요: node tools/calibrate.mjs --apply');
        process.exitCode = 12;
        return null;
      }
      const caps = capabilitiesFrom(cal.calibration);
      const driver = new DeviceDriver({
        calibration: cal.calibration,
        send: (payload) => transport.call(LED_METHOD, payload),
      });
      driver.capabilities = caps;
      return { cal, caps, driver };
    };

    if (args.json) {
      console.log(JSON.stringify(result.capability, null, 2));
    } else {
      console.log(result.report);
      for (const w of result.warnings) console.error(`⚠ ${w}`);
    }

    if (args.files) {
      console.log('\n장치 파일 목록 (fs.list)');
      try {
        console.log(formatFileList(await transport.call(LIST_METHOD)));
      } catch (err) {
        console.log(`  fs.list를 지원하지 않거나 실패했습니다: ${err.message.split('\n')[0]}`);
      }
      return;
    }

    if (args.ledsOff) {
      await transport.call(LED_METHOD, allOffPayload());
      console.log('\n13개 키를 소등했습니다.');
      console.log('기본색으로 되돌리려면: --restore-leds');
      return;
    }

    if (args.restoreLeds) {
      const { color, sourceKo } = resolveRestoreColor({
        explicit: args.restoreColor, activeLayerColor: activeLayer?.color ?? null,
      });
      if (color === null) {
        console.error(`\n복구할 색을 정하지 못했습니다 — ${sourceKo}`);
        console.error('색을 직접 지정해 주세요: --restore-leds=1A1A4D');
        process.exitCode = 6;
        return;
      }
      await transport.call(LED_METHOD, uniformPayload(color));
      console.log(`\n13개 키를 ${sourceKo}(으)로 칠했습니다.`);
      console.log('주의: 이것은 키별 override입니다. 펌웨어 기본 상태로의 진짜 복구가 아닙니다.');
      console.log('키별 지정을 해제하는 수단은 아직 찾지 못했습니다.');
      return;
    }

    if (args.probeParams) {
      if (!isInteractive()) {
        console.error('\n--probe-params 는 TTY에서만 동작합니다.');
        process.exitCode = 2;
        return;
      }
      console.log('\n── thstatus 파라미터 탐색 ──');
      console.log('알려진 method 하나만 쓰고 파라미터만 바꿔 가며 확인합니다.');
      console.log('키 색이 바뀐 채로 남을 수 있습니다. 복구 방법도 이 과정에서 찾습니다.');
      console.log('레이어를 전환했다가 돌아오면 기본색이 복구될 가능성이 있습니다.\n');

      const prompt = createPrompt({
        onClosed: () => console.log('\n입력이 닫혀 탐색을 중단합니다.'),
      });
      let probe;
      try {
        probe = await runParamProbe({
          send: (payload) => transport.call(LED_METHOD, payload),
          ask: (q) => prompt.ask(q),
          sleep: (ms) => new Promise((r) => { setTimeout(r, ms); }),
          print: console.log,
        });
      } finally {
        prompt.close();
      }
      console.log(formatParamReport(probe));
      result.capability.thstatusProbe = probe.results;
      result.capability.thstatusInterpretation = probe.interpretation;
      result.capability.notes = [...result.capability.notes, ...probe.interpretation.notesKo];
    }

    if (args.live) {
      const opened = openDriver('보정이 없어 live 세션을 열 수 없습니다');
      if (!opened) return;
      const { cal, driver } = opened;

      const store = new StateStore();
      let focusRouter = new PrintingFocusRouter();
      let orca = null;
      let refreshTimer = null;
      let persistence = null;
      let lastPersistWarn = null;
      const flushPersistence = () => {
        if (!persistence) return;
        const r = persistence.adapter.flush();
        persistence.adapter.stop();
        console.log(r.ok ? `  저장: ${persistence.fileStore.path}` : `  ⚠ 저장 실패: ${r.messageKo}`);
        persistence = null;
      };

      if (args.orca) {
        orca = await createOrcaStack({ store, bin: args.orcaBin });
        let health;
        try {
          health = await orca.adapter.health();
        } catch (err) {
          console.error(`\nOrca에 닿지 못했습니다: ${err.message}`);
          console.error('Orca 앱이 실행 중인지 확인하세요 (orca status).');
          process.exitCode = 13;
          return;
        }
        if (!health.runtimeReady) {
          console.error('\nOrca 런타임이 준비되지 않았습니다. `orca open` 후 다시 시도하세요.');
          process.exitCode = 13;
          return;
        }
        // 재시작 후 자리를 되살린다. 상태는 되살리지 않는다 — 전부 UNKNOWN으로 시작한다 (C14).
        // 첫 조회보다 먼저 해야 자리가 지켜진다. 모의 데이터는 저장하지 않으므로 --orca에서만 켠다.
        persistence = createPersistence({ store });
        const restored = persistence.adapter.restore();
        if (restored.warningKo) console.log(`  ⚠ ${restored.warningKo}`);
        if (restored.restored.length) {
          console.log(`  복원: 작업 ${restored.restored.length}개의 자리를 되살렸습니다 (상태는 확인 전)`);
        }
        for (const s of restored.skipped) console.log(`  ⚠ 복원 건너뜀: ${s.reasonKo}`);
        // 더 새로운 버전의 파일이면 덮어쓰지 않는다. 읽기만 거부하고 저장도 끈다.
        if (persistence.fileStore.read().newerVersion) {
          console.log('  ⚠ 이번 실행은 상태를 저장하지 않습니다.');
          persistence = null;
        } else {
          persistence.adapter.start();
        }

        const first = await orca.adapter.list();
        orca.sync.indexTerminals(first.terminals);
        const r = orca.sync.syncOnce(first.units);
        // 목록에 있다는 것 자체가 관측이다. 상태가 안 바뀌었어도 자리를 지킨다.
        persistence?.adapter.noteSeen(first.units.map((u) => u.id));
        // 복원된 것은 '새로 추가'가 아니므로 따로 센다. 0개라고 말하면 틀린 말이 된다.
        console.log(`\nOrca 연결: v${health.appVersion} · worktree ${store.allUnits().length}개`
          + (r.added.length ? ` (새로 ${r.added.length})` : ''));
        for (const n of first.notesKo) console.log(`  · ${n}`);
        focusRouter = orca.focusRouter;
      } else {
        for (const u of seedWorkUnits()) store.addUnit(u);
      }

      const actionRouter = new PrintingActionRouter();
      // --live는 앞 앱 감시가 없어 항상 활성이다 (기본값)
      const bridge = new Output({
        store, focusRouter, actionRouter, sourceName: 'Orca',
      });
      const scheduler = new RenderScheduler({ bridge, device: driver, bus: bridge.bus });

      const pending = [];
      const intents = [];
      const dispatch = makeDispatcher(bridge);
      const decoder = new InputDecoder({
        sectors: cal.calibration.joystick?.sectors ?? null,
        deadzone: cal.calibration.joystick?.deadzone ?? 0.05,
        onIntent: (intent) => {
          intents.push(intent);
          console.log(`  입력: ${describeIntent(intent)}`);
          pending.push(Promise.resolve(dispatch(intent)).then(() => {
            scheduler.requestRender();
            console.log(statusLine(bridge.render()));
          }).catch((e) => console.log(`    ⚠ 처리 실패: ${e.message}`)));
        },
      });
      const eventDecoder = new DeviceEventDecoder({ decoder, calibration: cal.calibration });

      let eventCount = 0;
      const offNotify = transport.onNotification((obj) => {
        eventCount += 1;
        eventDecoder.handle(obj);
      });
      const holdTimer = setInterval(() => decoder.tick(), 100);
      holdTimer.unref?.();

      // Ctrl+C는 finally를 거치지 않는다. 저장을 여기서도 한다.
      const onSignal = () => {
        flushPersistence();
        restoreLayerColor().finally(() => process.exit(130));
      };
      process.once('SIGINT', onSignal);
      process.once('SIGTERM', onSignal);

      console.log('\n── live 세션 ──');
      console.log(`보정: ${cal.sourceKo}`);
      console.log(`${args.liveSeconds}초 동안 실제 입력이 런타임을 움직입니다.`);
      if (args.orca) {
        console.log('⚠ --orca: 슬롯을 누르면 **실제 Orca 터미널이 전환됩니다**.');
        console.log('  읽기와 터미널 전환만 합니다. 입력 전송·생성·삭제는 하지 않습니다.');
      } else {
        console.log('LED 외에는 아무것도 쓰지 않습니다. 앱 전환이나 키 전송도 하지 않습니다.');
      }
      console.log('');
      console.log('  해보실 것:');
      console.log('    · 위 6키를 눌러 보세요 — 그 작업으로 이동 요청이 출력됩니다');
      console.log('    · 조이스틱 좌/우 — 묶음이 바뀌고 LED가 따라옵니다');
      console.log('    · ATTENTION — 개입이 필요한 곳으로 이동합니다');
      console.log('    · MODE/BACK — Global/Detail 전환');
      console.log('    · 노브 회전 — 슬롯 선택 이동');
      console.log('  Ctrl+C로 언제든 중단할 수 있습니다.');
      console.log('');

      scheduler.start();
      await scheduler.idle();
      console.log(statusLine(bridge.render()));

      // Orca 목록은 계속 변한다. 주기적으로 다시 읽되 슬롯은 움직이지 않는다.
      if (args.orca) {
        refreshTimer = setInterval(async () => {
          try {
            const next = await orca.adapter.list();
            orca.sync.indexTerminals(next.terminals);
            const d = orca.sync.syncOnce(next.units);
            persistence?.adapter.noteSeen(next.units.map((u) => u.id));
            const swept = persistence?.adapter.sweep() ?? [];
            if (swept.length) {
              console.log(`  (복원됐지만 관측되지 않은 작업 ${swept.length}개의 자리를 반납했습니다)`);
              scheduler.requestRender();
            }
            const werr = persistence?.adapter.lastWriteError ?? null;
            if (werr && werr !== lastPersistWarn) console.log(`  ⚠ 저장 실패: ${werr}`);
            lastPersistWarn = werr;
            if (d.added.length || d.vanished.length || d.updatedChildren || d.goneChildren) {
              console.log(`  (Orca 갱신: 추가 ${d.added.length} · 사라짐 ${d.vanished.length}`
                + ` · child 변경 ${d.updatedChildren} · child 끊김 ${d.goneChildren})`);
              scheduler.requestRender();
            }
          } catch (err) {
            console.log(`  ⚠ Orca 갱신 실패: ${err.message.split('\n')[0]}`);
          }
        }, ORCA_REFRESH_MS);
        refreshTimer.unref?.();
      }

      try {
        await new Promise((r) => { setTimeout(r, args.liveSeconds * 1000); });
      } finally {
        if (refreshTimer) clearInterval(refreshTimer);
        flushPersistence();
        clearInterval(holdTimer);
        offNotify();
        scheduler.stop();
        await Promise.all(pending);
        await restoreLayerColor();
        process.removeListener('SIGINT', onSignal);
        process.removeListener('SIGTERM', onSignal);
      }

      console.log(summarize({
        events: eventCount,
        intents,
        unknown: eventDecoder.unknown.length,
        focusCalls: focusRouter.calls.length,
        renders: driver.appliedCount,
      }));
      return;
    }

    if (args.preview) {
      const opened = openDriver('보정이 없어 미리보기를 할 수 없습니다');
      if (!opened) return;
      const { cal, caps, driver } = opened;

      const onSignal = () => { restoreLayerColor().finally(() => process.exit(130)); };
      process.once('SIGINT', onSignal);
      process.once('SIGTERM', onSignal);

      const chosen = args.previewOnly
        ? SCENARIOS.filter((sc) => sc.id === args.previewOnly)
        : SCENARIOS;
      if (!chosen.length) {
        console.error(`\n알 수 없는 시나리오: ${args.previewOnly}`);
        console.error(`사용 가능: ${SCENARIOS.map((sc) => sc.id).join(', ')}`);
        process.exitCode = 2;
        return;
      }

      console.log('\n── 실기 미리보기 ──');
      console.log(`보정: ${cal.sourceKo}`);
      console.log(`LED 제어 가능: ${caps.controllableKeys.join(', ')}`);
      console.log('LED만 바꿉니다. keymap과 설정은 건드리지 않습니다.');
      console.log('끝나면 레이어 색으로 되돌립니다. 중간에 멈추려면 Ctrl+C.\n');

      try {
        for (const [i, sc] of chosen.entries()) {
          console.log(`[${i + 1}/${chosen.length}] ${sc.titleKo} — ${sc.seconds}초`);
          for (const line of sc.lookKo) console.log(`  · ${line}`);
          if (sc.statuses) console.log(formatExpectations(sc.statuses));

          const bridge = new Output({ store: sc.build() });
          const scheduler = new RenderScheduler({ bridge, device: driver, bus: bridge.bus });
          scheduler.start();
          await scheduler.idle();
          await new Promise((r) => { setTimeout(r, sc.seconds * 1000); });
          scheduler.stop();
          console.log('');
        }
      } finally {
        await restoreLayerColor();
        process.removeListener('SIGINT', onSignal);
        process.removeListener('SIGTERM', onSignal);
      }
      console.log('미리보기를 마치고 레이어 색으로 되돌렸습니다.');
      console.log('이상한 점이 있으면 알려주세요 — 색·밝기·점멸 주기를 조정합니다.');
      return;
    }

    if (args.input) {
      if (!isInteractive()) {
        console.error('\n--input 은 TTY에서만 동작합니다.');
        process.exitCode = 2;
        return;
      }
      console.log('\n── 입력 이벤트 관측 ──');
      console.log('장치에 아무것도 쓰지 않습니다. 벤더 채널 알림을 받기만 합니다.');
      console.log('안내대로 조작한 뒤 Enter를 눌러 주세요. 수신이 없어도 그대로 기록합니다.');
      console.log('아무 알림도 오지 않는 것 역시 유효한 결과입니다 (미지원이 아니라 미검증).');

      const prompt = createPrompt({
        onClosed: () => console.log('\n입력이 닫혀 관측을 중단합니다.'),
      });
      let probe;
      try {
        probe = await runInputSession(transport, { ask: (q) => prompt.ask(q) });
      } finally {
        prompt.close();
      }
      console.log(formatInputReport(probe));
      if (args.saveRecords) {
        const target = path.resolve(process.cwd(), args.saveRecords);
        const w = saveInputRecords(target, probe.records);
        console.log(w.ok ? `관측 기록 저장: ${target}` : w.messageKo);
        if (!w.ok) process.exitCode = 8;
      }
      result.capability = mergeInputObservations(result.capability, probe);
      if (probe.verdict.verdict === 'no_events') process.exitCode = 7;
    }

    if (args.leds) {
      // 선행 조건: 활성 레이어에 Output 키코드가 있어야 칠할 대상이 있다.
      if (result.bindings.length === 0 && !args.forceLeds) {
        const withBindings = result.allLayers.filter((l) => l.bindings.length > 0);
        console.error('\n활성 레이어에 Output 키코드가 없습니다 — LED 확인을 시작하지 않습니다.');
        console.error(`  활성: 프로필 ${result.active.profileIndex} / 레이어 ${result.active.layerIndex}`
          + ` "${result.active.layer?.name ?? '?'}" (AG/ACT 0개)`);
        if (withBindings.length) {
          console.error('  키코드가 있는 레이어:');
          for (const l of withBindings) {
            console.error(`    프로필 ${l.profileIndex} / 레이어 ${l.layerIndex} "${l.layerName}"`
              + ` — ${l.bindings.length}개`);
          }
          console.error('  장치나 동반 앱에서 그 레이어로 전환한 뒤 다시 실행해 주세요.');
        }
        console.error('  전환 없이 그대로 확인하려면 --force-leds 를 붙이세요.');
        process.exitCode = 5;
        return;
      }
      if (!isInteractive()) {
        console.error('\n--leds 는 TTY에서만 동작합니다.');
        console.error('사람이 보고 있지 않은데 LED를 바꾸는 것은 의미가 없습니다.');
        process.exitCode = 2;
        return;
      }
      console.log('\n── LED 배열 index → 물리 위치 측정 ──');
      console.log('실기 관측상 배열 위치가 곧 키입니다. 13색을 한 번에 칠하고 행별로 읽습니다.');
      console.log('행은 위에서부터 1~4, 열은 왼쪽부터입니다.');
      console.log('  1행은 노브 오른쪽 2개 · 2·3행은 4개 · 4행은 미니 LED 오른쪽 3개\n');

      const prompt = createPrompt({
        onClosed: () => console.log('\n입력이 닫혀 측정을 중단합니다.'),
      });
      let probe;
      try {
        probe = await runLedSession(transport, { ask: (q) => prompt.ask(q) });
      } finally {
        prompt.close();
      }
      console.log(formatRainbowReport(probe));
      console.log('\n색을 되돌리려면: node tools/doctor.mjs --restore-leds');
      result.capability = mergeLedMapping(result.capability, probe);
      if (probe.comparison.mismatches.length) process.exitCode = 4;
    }

    if (args.save) {
      const dir = path.join(ROOT, 'config');
      const out = path.join(dir, 'capability.json');
      const saved = safeWriteJson(out, result.capability, {
        backupDir: path.join(dir, 'backups'),
      });
      if (!saved.ok) {
        console.error(`\n${saved.messageKo}`);
        process.exitCode = 10;
      } else {
        if (saved.backup) console.log(`\n백업: ${path.relative(ROOT, saved.backup)}`);
        console.log(`저장: ${path.relative(ROOT, out)}`);
      }
    }
    process.exitCode = result.warnings.length ? 3 : 0;
  } finally {
    transport.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main(process.argv.slice(2));
}
