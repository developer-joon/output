/**
 * device/orca.json — 동반 앱에 import할 레이어 파일.
 * 사람이 손으로 쓴 파일이므로 계약·실측과 어긋나지 않는지 기계로 확인한다.
 * 형식은 사용자가 제공한 ChatGPT-layer.json export에서 역산했다 (미검증 가정).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { scanAllLayers, parseAgentKeycode } from '../tools/lib/doctorReport.js';
import { expectedPositions, KEYS_PER_ROW } from '../tools/lib/layout.js';
import { LOGICAL_TO_AG } from '../src/core/hardware.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'device/orca.json'), 'utf8'));
const ref = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'test/fixtures/companion-export-chatgpt-layer.json'), 'utf8'));

const codesOf = (base) => base.map((row) => row.map((c) => c.keycode));

describe('device/orca.json — import용 레이어 파일', () => {
  it('F01 동반 앱 export와 같은 최상위 구조다', () => {
    assert.deepEqual(Object.keys(doc).sort(), Object.keys(ref).sort());
    assert.deepEqual(Object.keys(doc.layer).sort(), Object.keys(ref.layer).sort());
    assert.deepEqual(Object.keys(doc.layer.layout).sort(), Object.keys(ref.layer.layout).sort());
    assert.equal(doc.keyboard, ref.keyboard);
    assert.equal(doc.language, ref.language);
    assert.equal(doc.layer.os, ref.layer.os);
  });

  it('F02 행 구성이 실기 매트릭스와 같다 (2/4/4/3)', () => {
    assert.deepEqual(doc.layer.layout.base.map((r) => r.length), [...KEYS_PER_ROW]);
    assert.deepEqual(doc.layer.layout.base.map((r) => r.length),
      ref.layer.layout.base.map((r) => r.length));
  });

  it('F03 13개 키코드가 모두 유효하고 번호가 0~12로 한 번씩 쓰인다', () => {
    const flat = codesOf(doc.layer.layout.base).flat();
    assert.equal(flat.length, 13);
    const parsed = flat.map(parseAgentKeycode);
    assert.ok(parsed.every(Boolean), '해석 불가한 키코드가 있다');
    assert.deepEqual(parsed.map((p) => p.index).sort((a, b) => a - b),
      Array.from({ length: 13 }, (_, i) => i));
  });

  it('F04 계열이 실측과 같다 — 0~5는 AG, 6~12는 ACT', () => {
    for (const code of codesOf(doc.layer.layout.base).flat()) {
      const { family, index } = parseAgentKeycode(code);
      assert.equal(family, index <= 5 ? 'AG' : 'ACT', code);
    }
  });

  it('F05 실기의 ChatGPT 레이어와 키 배치가 완전히 같다', () => {
    assert.deepEqual(codesOf(doc.layer.layout.base), codesOf(ref.layer.layout.base));
  });

  /**
   * keymap 좌표 → 물리 좌표.
   * 01_inspect.mjs 주석: "The top row is electrically reversed; row 0 col 0 is the top-right key."
   * 나머지 행의 반전 여부는 언급이 없어 그대로라고 가정한다.
   * 이 가정은 doctor --leds 의 위치 측정으로 검증해야 한다 (H02).
   */
  function keymapToPhysical(r, c, rowLength) {
    return { row: r + 1, col: r === 0 ? rowLength - c : c + 1 };
  }

  it('F06 각 키가 계약이 말하는 물리 위치에 놓인다 (상단 행 반전 가정 포함)', () => {
    const expected = expectedPositions();
    doc.layer.layout.base.forEach((row, r) => {
      row.forEach((cell, c) => {
        const { index } = parseAgentKeycode(cell.keycode);
        const exp = expected.get(index);
        assert.deepEqual(keymapToPhysical(r, c, row.length), { row: exp.row, col: exp.col },
          `${cell.keycode} 위치 불일치 (계약상 ${exp.logical})`);
      });
    });
  });

  it('F06b 상단 행 반전은 아직 가정이다 — 반전이 없다면 slot1/slot2가 뒤바뀐다', () => {
    const [first, second] = doc.layer.layout.base[0].map((c) => parseAgentKeycode(c.keycode).index);
    assert.equal(first, 0);
    assert.equal(second, 1);
    // 반전이 사실이 아니라면 AG00이 물리 왼쪽(slot1)이 되어 계약과 어긋난다.
    // doctor --leds 의 위치 측정 전까지 확정하지 않는다.
    assert.equal(expectedPositions().get(0).logical, 'slot2');
    assert.equal(expectedPositions().get(1).logical, 'slot1');
  });

  it('F07 논리 역할이 HARDWARE_CONTRACT와 일치한다', () => {
    const at = (r, c) => parseAgentKeycode(doc.layer.layout.base[r][c].keycode).index;
    const agOf = (logical) => Number(LOGICAL_TO_AG[logical].slice(2));
    assert.equal(at(0, 0), agOf('slot2'), '상단 왼쪽 슬롯은 전기적으로 반전되어 AG00');
    assert.equal(at(0, 1), agOf('slot1'));
    assert.equal(at(1, 0), agOf('slot3'));
    assert.equal(at(2, 0), agOf('slot7'));
    assert.equal(at(3, 0), agOf('attention'));
    assert.equal(at(3, 1), agOf('ack'));
    assert.equal(at(3, 2), agOf('mode_back'));
  });

  it('F08 엔코더와 조이스틱이 Output 설정이다', () => {
    assert.deepEqual(doc.layer.layout.encoders.map((e) => e.map((x) => x.keycode)),
      [['KV_OAI_ENC_CC', 'KV_OAI_ENC_CW', 'KV_OAI_ENC_CLK']]);
    assert.deepEqual(doc.layer.layout.encoders, ref.layer.layout.encoders);
    assert.equal(doc.layer.layout.joystick.type, 'VENDOR');
    assert.deepEqual(doc.layer.layout.joystick.sectors, []);
  });

  it('F09 레이어 색은 상태색과 겹치지 않는 어두운 바탕이다', () => {
    const hex = doc.layer.color;
    assert.match(hex, /^#[0-9A-Fa-f]{6}$/);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    // 상태색(빨강/주황/호박/초록)이 키별로 덮어써야 하므로 바탕이 그 계열이면 안 된다
    assert.ok(b > r && b > g, '바탕은 남색 계열이어야 한다');
    assert.ok((r + g + b) / 3 < 96, '바탕이 밝으면 상태색이 묻힌다');
  });

  it('F10 doctor가 이 파일을 그대로 읽어 13개를 인식한다', () => {
    const [layer] = scanAllLayers({ profiles: [{ id: 'import', layers: [doc.layer] }] });
    assert.equal(layer.bindings.length, 13);
    assert.equal(layer.layerName, 'Orca');
    assert.equal(layer.joystick.type, 'VENDOR');
    assert.equal(layer.encoders.length, 1);
  });

  it('F11 액션 정의는 비어 있다 — 기존 KA_* 설정을 복원하지 않는다', () => {
    assert.deepEqual(doc.actions, []);
    assert.deepEqual(doc.multiactions, []);
    assert.deepEqual(doc.smartActions, []);
    // 이 파일은 기존 Orca 레이어를 대체한다. 원본 백업은 사용자가 앱에서 export해야 한다.
  });
});
