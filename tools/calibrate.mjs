#!/usr/bin/env node
/**
 * Output calibrate — 실측 관측을 런타임이 쓸 매핑으로 확정한다 (M3-7).
 *
 *   node tools/calibrate.mjs                 dry-run (기본)
 *   node tools/calibrate.mjs --apply         config/calibration.json 에 기록
 *   node tools/calibrate.mjs --from=<file>   관측 파일 지정 (여러 번 가능)
 *   node tools/calibrate.mjs --json          초안을 JSON으로 출력
 *
 * **장치에 접속하지 않는다.** 이미 관측된 기록만 읽는다.
 * 쓰는 것은 호스트의 config/calibration.json 하나뿐이며,
 * 기존 파일은 먼저 백업하고 쓴 뒤 다시 읽어 검증한다 (AGENTS.md 3번의 규율).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildCalibration, validateCalibration, formatCalibrationReport, mergeInputRecords,
} from './lib/calibration.js';
import { safeWriteJson } from './lib/safeWrite.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 저장소에 보존된 실기 관측. 출처를 함께 적는다. */
export const RECORDED_SOURCES = Object.freeze([
  { file: 'test/fixtures/input-events-real.json', labelKo: '실기 8차 (2026-09-21) 입력 관측' },
  { file: 'test/fixtures/input-events-real-2.json', labelKo: '실기 9차 (2026-09-21) 입력 관측' },
  { file: 'test/fixtures/input-events-real-3.json', labelKo: '실기 17차 (2026-09-27) 새 Output 레이어(AG06~12) 입력 관측' },
]);
export const RECORDED_LED = Object.freeze({
  file: 'test/fixtures/led-mapping-real-2.json', labelKo: '실기 16차 (2026-09-26) LED 매핑 · 가상 스레드 언더글로우',
});

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(ROOT, file), 'utf8'));
}

/** 관측 파일들을 읽어 calibration 초안을 만든다. */
export function buildFromFiles({ inputFiles = RECORDED_SOURCES, ledFile = RECORDED_LED,
  device = null, now } = {}) {
  const sets = [];
  const sourcesKo = [];
  for (const src of inputFiles) {
    const doc = readJson(src.file);
    sets.push(doc.records ?? doc);
    sourcesKo.push(src.labelKo ?? src.file);
  }
  let ledMapping = null;
  let ledNotLit = [];
  let ledAmbient = null;
  if (ledFile) {
    const led = readJson(ledFile.file);
    ledMapping = led.mapping ?? null;
    ledNotLit = led.notLit ?? [];
    ledAmbient = led.ambient ?? null;
    sourcesKo.push(ledFile.labelKo ?? ledFile.file);
  }
  const inputRecords = mergeInputRecords(...sets);
  for (const r of inputRecords.replacedSteps ?? []) {
    sourcesKo.push(`최신 관측 채택: ${r.stepId} ${r.before} → ${r.after}`);
  }
  return buildCalibration({
    inputRecords,
    ledMapping,
    ledNotLit,
    ledAmbient,
    device,
    sourcesKo,
    ...(now ? { now } : {}),
  });
}

function parseArgs(argv) {
  const from = argv.filter((a) => a.startsWith('--from='))
    .map((a) => ({ file: a.slice('--from='.length), labelKo: null }));
  return {
    apply: argv.includes('--apply'),
    json: argv.includes('--json'),
    inputFiles: from.length ? from : RECORDED_SOURCES,
  };
}

async function main(argv) {
  const args = parseArgs(argv);

  let cal;
  try {
    cal = buildFromFiles({
      inputFiles: args.inputFiles,
      device: { vid: '0x303a', pid: '0x8298', firmware: '0.6.2' },
    });
  } catch (err) {
    console.error(`관측 파일을 읽지 못했습니다: ${err.message}`);
    console.error('doctor --input / --leds 로 먼저 관측하거나 --from= 으로 파일을 지정하세요.');
    process.exit(8);
  }

  const { ok, problems } = validateCalibration(cal);

  // --json 일 때 stdout은 순수 JSON만 담는다. 사람용 안내는 stderr로 보낸다.
  const say = args.json ? (...a) => console.error(...a) : (...a) => console.log(...a);

  if (args.json) {
    console.log(JSON.stringify(cal, null, 2));
  } else {
    console.log(formatCalibrationReport(cal));
  }

  if (!ok) {
    console.error('');
    console.error('검증 실패 — 기록하지 않습니다:');
    for (const p of problems) console.error(`  · ${p}`);
    process.exitCode = 9;
    return;
  }

  if (!args.apply) {
    say('');
    say('DRY RUN — 아무것도 쓰지 않았습니다.');
    say('기록하려면: node tools/calibrate.mjs --apply');
    return;
  }

  const dir = path.join(ROOT, 'config');
  const out = path.join(dir, 'calibration.json');
  const result = safeWriteJson(out, cal, { backupDir: path.join(dir, 'backups') });
  if (!result.ok) {
    console.error('');
    console.error(result.messageKo);
    process.exitCode = 10;
    return;
  }
  if (result.backup) say(`\n백업: ${path.relative(ROOT, result.backup)}`);
  say(`기록: ${path.relative(ROOT, out)} (read-back 검증 통과)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main(process.argv.slice(2));
}
