/**
 * M3-3 — 읽기 전용 doctor. 장치 없이 검증한다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import os from 'node:os';

import { collectObservations, analyze, READ_ONLY_METHODS, BLOCKED_METHODS, saveInputRecords } from '../tools/doctor.mjs';
import { Obs, findAgentBindings, resolveActive, compareWithContract, scanAllLayers } from '../tools/lib/doctorReport.js';
import { FakeTransport } from '../src/device/transport/fakeTransport.js';
import { LOGICAL_TO_AG } from '../src/core/hardware.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/cm2-device.json'), 'utf8'));

function transport(overrides = {}) {
  return new FakeTransport({
    info: fixture.info,
    blockedMethods: BLOCKED_METHODS,
    responses: {
      'sys.version': fixture.version,
      'device.status': fixture.status,
      'fs.read': () => ({ data: JSON.stringify(fixture.keymap) }),
      ...overrides,
    },
  });
}

const run = (obs, t) => analyze(obs, {
  info: t.info, ownership: '테스트', observedAt: '2026-09-20T00:00:00.000Z',
});

describe('M3 / doctor 읽기 전용', () => {
  it('T30 읽기 전용 method만 호출한다', async () => {
    const t = transport();
    await collectObservations(t);
    assert.deepEqual([...new Set(t.calledMethods)].sort(), [...READ_ONLY_METHODS].sort());
    for (const m of t.calledMethods) {
      assert.equal(BLOCKED_METHODS.includes(m), false);
    }
  });

  it('T31 fs.write는 transport에서 차단된다', async () => {
    const t = transport();
    await assert.rejects(t.call('fs.write', { file: 'keymap.json', data: '{}' }), /금지/);
    assert.equal(t.sentFrames.length, 0, '프레임이 나가지 않아야 한다');
  });

  it('T32 실측 keymap에서 13개 키코드를 찾는다 (AG 6 + ACT 7)', async () => {
    const t = transport();
    const r = run(await collectObservations(t), t);
    assert.equal(r.active.layer.name, 'Orca', '활성 레이어는 Orca');
    assert.equal(r.bindings.length, 0, '활성 레이어에는 Output 키코드가 없다');
    assert.equal(r.allBindings.length, 13, 'ChatGPT 레이어에 13개');
    assert.equal(r.allBindings.filter((b) => b.family === 'AG').length, 6);
    assert.equal(r.allBindings.filter((b) => b.family === 'ACT').length, 7);
  });

  it('T33 계약과 keymap을 대조하되 계약을 바꾸지 않는다', async () => {
    const t = transport();
    const r = run(await collectObservations(t), t);
    const keyRows = r.contract.filter((c) => c.expectedInKeymap);
    assert.equal(keyRows.length, 13);
    assert.ok(keyRows.every((c) => c.present), '번호 기준으로는 13개 모두 존재');
    // 번호는 계약과 같지만 6번 이후는 접두사가 ACT다
    assert.equal(r.contract.find((c) => c.logical === 'slot1').code, 'KV_OAI_AG01');
    assert.equal(r.contract.find((c) => c.logical === 'slot7').code, 'KV_OAI_ACT06');
    assert.equal(r.contract.find((c) => c.logical === 'slot7').familyDiffers, true);
    assert.equal(r.contract.find((c) => c.logical === 'mode_back').code, 'KV_OAI_ACT12');
    // 노브/조이스틱은 keymap 키가 아니므로 '없음'이 결함이 아니다
    assert.ok(r.contract.filter((c) => !c.expectedInKeymap).length >= 6);
    // 계약 상수는 그대로다
    assert.equal(LOGICAL_TO_AG.slot1, 'AG01');
    assert.equal(LOGICAL_TO_AG.slot2, 'AG00');
  });

  it('T34 capability 초안은 LED/입력을 전부 unknown으로 둔다', async () => {
    const t = transport();
    const { capability } = run(await collectObservations(t), t);
    for (const [ag, v] of Object.entries(capability.keys)) {
      assert.equal(v.led, Obs.UNKNOWN, `${ag} led`);
      assert.equal(v.press, Obs.UNKNOWN, `${ag} press`);
      assert.equal(v.release, Obs.UNKNOWN, `${ag} release`);
      assert.equal(v.boundInKeymap, true);
    }
    assert.equal(capability.keys.AG00.family, 'AG');
    assert.equal(capability.keys.AG06.family, 'ACT');
    assert.equal(capability.keys.AG06.keycode, 'KV_OAI_ACT06');
    assert.equal(capability.dial.click, Obs.UNKNOWN);
    assert.equal(capability.joystick.up, Obs.UNKNOWN);
  });

  it('T35 zone 제어 method가 없으면 not_found로 기록한다', async () => {
    const t = transport();
    const { capability } = run(await collectObservations(t), t);
    assert.equal(capability.zones.keysZone, Obs.NOT_FOUND);
    assert.equal(capability.zones.ambientZone, Obs.NOT_FOUND);
    assert.ok(capability.notes.some((n) => /zone/.test(n)));
  });

  it('T36 mini LED는 조사하지 않는다', async () => {
    const t = transport();
    const { capability, report } = run(await collectObservations(t), t);
    assert.equal(capability.miniLeds, Obs.NEVER_PROBED);
    assert.match(report, /mini LED — 조사하지 않습니다/);
    assert.equal(/mini/i.test(JSON.stringify(capability.keys)), false);
  });

  it('T37 조회 실패를 정상으로 가장하지 않는다', async () => {
    const t = transport({ 'device.status': () => ({ __error: { code: 1, message: 'busy' } }) });
    const obs = await collectObservations(t);
    const r = run(obs, t);
    assert.equal(obs.status, null);
    assert.match(obs.statusError, /busy/);
    assert.ok(r.warnings.some((w) => /busy/.test(w)));
    assert.match(r.report, /\(응답 없음\)/);
  });

  it('T38 keymap이 깨져도 죽지 않고 경고로 남는다', async () => {
    const t = transport({ 'fs.read': () => ({ data: '{not json' }) });
    const obs = await collectObservations(t);
    const r = run(obs, t);
    assert.equal(r.bindings.length, 0);
    assert.ok(r.warnings.length > 0);
    assert.match(r.report, /활성 레이어의 AG 바인딩: 0개/);
  });

  it('T39 활성 레이어를 ChatGPT로 바꾸면 13개가 활성 레이어에서 잡힌다', async () => {
    const t = transport();
    const obs = await collectObservations(t);
    obs.status = { profile_index: 0, layer_index: 2 };   // 1-based → ChatGPT
    const r = run(obs, t);
    assert.equal(r.active.layer.name, 'ChatGPT');
    assert.equal(r.bindings.length, 13);
  });

  it('T40 리포트가 확인하지 않은 것을 확인했다고 쓰지 않는다', async () => {
    const t = transport();
    const { report } = run(await collectObservations(t), t);
    assert.match(report, /이 실행은 장치에 아무것도 쓰지 않습니다/);
    assert.match(report, /이번 실행으로 확인되지 않은 항목/);
    assert.match(report, /실물 확인이 필요합니다/);
    assert.equal(/LED 정상|모두 정상|검증 완료/.test(report), false);
  });
});

describe('M3 / doctor 순수 함수', () => {
  it('T41 findAgentBindings는 AG 코드만 뽑는다', () => {
    const out = findAgentBindings([['KC_A', 'KV_OAI_AG07'], ['KV_OAI_AG99', 'KV_OAI_AGxx']]);
    assert.deepEqual(out.map((b) => b.ag), ['AG07', 'AG99']);
  });

  it('T42 resolveActive는 device.status의 layer_index를 1-based로 본다', () => {
    const cfg = { profiles: [{ layers: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] }] };
    assert.equal(resolveActive(cfg, { layer_index: 3 }).layer.name, 'c');
    assert.equal(resolveActive(cfg, { layer_index: 99 }).layer.name, 'a', '범위 밖이면 0번');
    assert.equal(resolveActive(cfg, {}).layer.name, 'a');
  });

  it('T43 profiles가 없으면 한국어로 실패한다', () => {
    assert.throws(() => resolveActive({}, {}), /profiles/);
  });

  it('T44 compareWithContract는 13개 키와 6개 비키 항목을 구분한다', () => {
    const c = compareWithContract([{ ag: 'AG01' }]);
    assert.equal(c.find((x) => x.logical === 'slot1').present, true);
    assert.equal(c.find((x) => x.logical === 'slot2').present, false);
    assert.equal(c.find((x) => x.logical === 'dial_cw').expectedInKeymap, false);
  });
});

describe('M3 / doctor CLI', () => {
  it('T45 --fake 로 장치 없이 실행된다', () => {
    const out = execFileSync('node', ['tools/doctor.mjs', '--fake'], { cwd: ROOT, encoding: 'utf8' });
    assert.match(out, /프로필 0 \/ 레이어 1 "ChatGPT"\s+키 13개 · AG 13개/);
    assert.match(out, /장치에 아무것도 쓰지 않습니다/);
  });

  it('T46 --json 은 capability 초안을 출력한다', () => {
    const out = execFileSync('node', ['tools/doctor.mjs', '--fake', '--json'], { cwd: ROOT, encoding: 'utf8' });
    const cap = JSON.parse(out);
    assert.equal(cap.version, 1);
    assert.equal(cap.miniLeds, 'never_probed');
    assert.equal(Object.keys(cap.keys).length, 13);
  });

  it('T47 --input 은 TTY가 아니면 거부한다', () => {
    let failed = false;
    try {
      execFileSync('node', ['tools/doctor.mjs', '--fake', '--input'], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
      failed = true;
      assert.equal(e.status, 2);
      assert.match(e.stderr, /TTY에서만 동작합니다/);
    }
    assert.ok(failed, '--input 은 TTY 없이는 종료해야 한다');
  });
});

// ───────────── 실기 1차 관측(2026-09-20)에서 드러난 경로
describe('M3 / 전체 레이어 스캔 (실기에서 발견)', () => {
  const noAg = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/cm2-no-ag.json'), 'utf8'));

  function noAgTransport() {
    return new FakeTransport({
      info: noAg.info,
      blockedMethods: BLOCKED_METHODS,
      responses: {
        'sys.version': noAg.version,
        'device.status': noAg.status,
        'fs.read': () => ({ data: JSON.stringify(noAg.keymap) }),
      },
    });
  }

  it('T48 활성 레이어에 없어도 다른 레이어를 스캔한다 (실기에서 발견된 결함)', async () => {
    const t = transport();
    const r = run(await collectObservations(t), t);
    assert.equal(r.allLayers.length, 2);
    assert.equal(r.allLayers[0].bindings.length, 0, 'Orca 레이어');
    assert.equal(r.allLayers[1].bindings.length, 13, 'ChatGPT 레이어');
    assert.match(r.report, /전체 프로필·레이어 스캔/);
  });

  it('T49 어느 레이어에도 AG가 없으면 단정하지 않고 원인 후보를 제시한다', async () => {
    const t = noAgTransport();
    const obs = await collectObservations(t);
    const r = run(obs, t);
    assert.equal(r.allBindings.length, 0);
    assert.equal(r.active.layer.name, 'Orca');
    assert.match(r.report, /어떤 레이어에서도 KV_OAI_AG 키코드를 찾지 못했습니다/);
    assert.match(r.report, /확인 전까지 단정하지 않습니다/);
    assert.match(r.report, /--dump-keymap/);
    assert.ok(r.warnings.some((w) => /AG 키코드를 어느 레이어에서도/.test(w)));
  });

  it('T50 AG가 없으면 활성 레이어에 든 키코드를 대신 보여준다', async () => {
    const t = noAgTransport();
    const r = run(await collectObservations(t), t);
    assert.match(r.report, /대신 들어 있는 키코드: KC_\w+×\d+/);
  });

  it('T51 capability에 레이어별 요약과 사유가 남는다', async () => {
    const t = noAgTransport();
    const { capability } = run(await collectObservations(t), t);
    assert.equal(capability.activeLayer.name, 'Orca');
    assert.equal(capability.activeLayer.agBindings, 0);
    assert.deepEqual(capability.layers.map((l) => l.name), ['Orca', 'Media']);
    assert.ok(capability.notes.some((n) => /찾지 못함/.test(n)));
    for (const v of Object.values(capability.keys)) {
      assert.equal(v.boundInKeymap, false);
      assert.equal(v.led, Obs.UNKNOWN, 'AG가 없어도 LED는 no가 아니라 unknown');
    }
  });

  it('T52 --dump-keymap 은 모든 레이어의 원문을 낸다', () => {
    const out = execFileSync('node', ['tools/doctor.mjs', '--fake', '--dump-keymap'],
      { cwd: ROOT, encoding: 'utf8' });
    assert.match(out, /── keymap 원문 ──/);
    assert.match(out, /레이어 0 "Orca"/);
    assert.match(out, /row 0: KC_NONE \| KC_NONE/);
    assert.match(out, /row 2: KV_OAI_ACT06 \| KV_OAI_ACT07/);
  });
});

// ───────────── 실기 2차 관측(2026-09-20): 키코드 계열이 둘
describe('M3 / 키코드 계열 AG·ACT (실기에서 발견)', () => {
  it('T53 AG와 ACT를 모두 인식하고 번호로 정규화한다', () => {
    const b = findAgentBindings([['KV_OAI_AG00'], ['KV_OAI_ACT12'], ['KV_OAI_XX01', 'KC_A']]);
    assert.deepEqual(b.map((x) => [x.family, x.index, x.ag]),
      [['AG', 0, 'AG00'], ['ACT', 12, 'AG12']]);
  });

  it('T54 계약 번호는 맞고 접두사만 다른 것을 구분해 보고한다', async () => {
    const t = transport();
    const { report, contract } = run(await collectObservations(t), t);
    const a1 = contract.find((c) => c.logical === 'slot7');
    assert.equal(a1.present, true);
    assert.equal(a1.familyDiffers, true);
    assert.match(report, /번호 일치 · 키코드는 KV_OAI_ACT06/);
    assert.match(report, /키코드 계열이 둘로 나뉩니다/);
    assert.match(report, /계약 문서를 고치지 않습니다/);
  });

  it('T55 옛 레이어: 칸 1~6은 AG, 나머지 7개는 ACT로 갈린다', async () => {
    const t = transport();
    const { contract } = run(await collectObservations(t), t);
    const ag = contract.filter((c) => c.family === 'AG').map((c) => c.logical);
    const act = contract.filter((c) => c.family === 'ACT').map((c) => c.logical);
    assert.deepEqual(ag, ['slot1', 'slot2', 'slot3', 'slot4', 'slot5', 'slot6']);
    assert.deepEqual(act, ['slot7', 'slot8', 'slot9', 'slot10', 'attention', 'ack', 'mode_back']);
  });

  it('T56 HARDWARE_CONTRACT의 논리 매핑 상수는 변경되지 않았다', () => {
    assert.equal(LOGICAL_TO_AG.slot1, 'AG01');
    assert.equal(LOGICAL_TO_AG.slot2, 'AG00');
    assert.equal(LOGICAL_TO_AG.slot7, 'AG06');
    assert.equal(LOGICAL_TO_AG.mode_back, 'AG12');
  });
});

// ───────────── 동반 앱 export 형식 (사용자 제공, 2026-09-20)
describe('M3 / 동반 앱 layer export', () => {
  const exp = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'test/fixtures/companion-export-chatgpt-layer.json'), 'utf8'));
  // export는 단일 레이어라 profiles 구조로 감싼다
  const asConfig = { profiles: [{ id: 'exported', layers: [exp.layer] }] };

  it('T57 export의 base/{keycode} 형식도 파싱된다', () => {
    const layers = scanAllLayers(asConfig);
    assert.equal(layers.length, 1);
    assert.equal(layers[0].bindings.length, 13);
    assert.equal(layers[0].bindings.filter((b) => b.family === 'AG').length, 6);
    assert.equal(layers[0].bindings.filter((b) => b.family === 'ACT').length, 7);
  });

  it('T58 엔코더 키코드가 읽힌다 — 노브 클릭 키코드가 실재한다', () => {
    const [layer] = scanAllLayers(asConfig);
    const codes = layer.encoders.flat().map((x) => (typeof x === 'object' ? x.keycode : x));
    assert.deepEqual(codes, ['KV_OAI_ENC_CC', 'KV_OAI_ENC_CW', 'KV_OAI_ENC_CLK']);
    // 계약은 노브를 AG13/AG14로 '권장'했으나 실제로는 ENC 계열이다
    assert.equal(codes.some((c) => /^KV_OAI_AG1[34]$/.test(c)), false);
  });

  it('T59 조이스틱은 VENDOR 모드이고 방향별 키코드가 없다', () => {
    const [layer] = scanAllLayers(asConfig);
    assert.equal(layer.joystick.type, 'VENDOR');
    assert.deepEqual(layer.joystick.sectors, []);
  });

  it('T60 노브 클릭 키코드 존재가 동작 확인으로 승격되지 않는다', async () => {
    const t = transport();
    const { capability } = run(await collectObservations(t), t);
    // 장치 응답에 encoders가 없으면 null, 있어도 dial.click은 여전히 unknown이어야 한다
    assert.equal(capability.dial.click, Obs.UNKNOWN);
    assert.equal(capability.joystick.up, Obs.UNKNOWN);
  });

  it('T61 장치 응답에 encoders가 없으면 미확인으로 보고한다', async () => {
    const t = transport();
    const { report } = run(await collectObservations(t), t);
    assert.match(report, /노브 \/ 조이스틱 설정/);
    assert.match(report, /encoders \/ joystick 필드가 없습니다|엔코더 0:/);
  });
});

// ───────────────────────── M5 조사 — 장치 파일 목록 (읽기 전용)

describe('doctor --files (fs.list)', () => {
  it('F01 --files일 때만 fs.list를 허용한다', async () => {
    const { methodsFor, LIST_METHOD } = await import('../tools/doctor.mjs');
    assert.ok(methodsFor({ files: true }).includes(LIST_METHOD));
    assert.equal(methodsFor({}).includes(LIST_METHOD), false, '기본은 차단');
  });

  it('F02 fs.list도 쓰기가 아니다 — 차단 목록에 없다', async () => {
    const { BLOCKED_METHODS, LIST_METHOD } = await import('../tools/doctor.mjs');
    assert.equal(BLOCKED_METHODS.includes(LIST_METHOD), false);
    assert.ok(BLOCKED_METHODS.includes('fs.write'), 'fs.write는 여전히 차단');
  });

  it('F03 파일 목록을 사람이 읽을 수 있게 보여준다', async () => {
    const { formatFileList } = await import('../tools/doctor.mjs');
    const out = formatFileList({ files: ['keymap.json', 'state.bin'] });
    assert.match(out, /keymap\.json/);
    assert.match(out, /state\.bin/);
  });

  it('F03b 실측 응답은 배열이고 이름·크기를 가진다', async () => {
    const { formatFileList } = await import('../tools/doctor.mjs');
    // 2026-09-25 실기 관측
    const out = formatFileList([
      { name: 'keymap.json', size: 3888 },
      { name: 'smart_actions.json', size: 1125 },
    ]);
    assert.match(out, /keymap\.json/);
    assert.match(out, /smart_actions\.json/);
    assert.match(out, /3888|3\.8|3,888/, '크기도 보여준다');
    assert.doesNotMatch(out, /예상과 다른/);
  });

  it('F04 응답 모양이 달라도 죽지 않는다 — 원문을 보여준다', async () => {
    const { formatFileList } = await import('../tools/doctor.mjs');
    assert.match(formatFileList(null), /읽지 못했습니다|없습니다/);
    assert.match(formatFileList({ weird: 1 }), /weird/);
  });
});

// ───────────── M6: 입력 관측 원본을 픽스처로 저장 (실기 17차 준비)
describe('M6 / doctor --input 관측 저장', () => {
  it('X01 saveInputRecords 는 calibrate가 읽는 픽스처 형식({_note, records})으로 쓴다', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-rec-'));
    const target = path.join(tmp, 'nested', 'records.json');
    const records = {
      'key-3-1': { skipped: false, events: [{ m: 'v.oai.hid', p: { k: 'AG06', act: 1 } }, { m: 'v.oai.hid', p: { k: 'AG06', act: 0 } }] },
      'joy-up': { skipped: true, events: [] },
    };
    const r = saveInputRecords(target, records, { now: () => '2026-09-26T00:00:00.000Z' });
    assert.equal(r.ok, true, r.messageKo);
    const saved = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.match(saved._note, /doctor --input 관측 \(2026-09-26T00:00:00.000Z\)/);
    assert.deepEqual(saved.records, records);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
