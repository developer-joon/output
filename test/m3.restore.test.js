/**
 * LED 복구/소등 — 실기 6차 관측(빈 배열 무효, 밝기0은 소등뿐)에 따른 대응.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import {
  parseHexColor, toHexString, uniformPayload, offPayload, resolveRestoreColor, KEY_COUNT,
} from '../tools/lib/ledRestore.js';
import { methodsFor } from '../tools/doctor.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

describe('M3 / LED 복구', () => {
  it('R01 색을 문자열·숫자·축약형 모두 파싱한다', () => {
    assert.equal(parseHexColor('#1A1A4D'), 0x1a1a4d);
    assert.equal(parseHexColor('1a1a4d'), 0x1a1a4d);
    // 장치 keymap은 10진수로 준다 (실기 7차에서 발견된 결함)
    assert.equal(parseHexColor(16711680), 0xff0000);
    assert.equal(parseHexColor(1710669), 0x1a1a4d);
    assert.equal(parseHexColor('16711680'), 0xff0000);
    // 동반 앱 export는 '#F00' 축약형을 쓴다
    assert.equal(parseHexColor('#F00'), 0xff0000);
    assert.equal(parseHexColor('초록'), null);
    assert.equal(parseHexColor(0x1000000), null, '범위 밖');
  });

  it('R01b 색을 사람이 읽을 hex로 표시한다', () => {
    assert.equal(toHexString(16711680), '#FF0000');
    assert.equal(toHexString(1710669), '#1A1A4D');
  });

  it('R02 복구 payload는 13개 요소다 (배열 위치가 키이므로)', () => {
    const p = uniformPayload(0x123456);
    assert.equal(p.length, KEY_COUNT);
    assert.deepEqual(p.map((x) => x.id), Array.from({ length: 13 }, (_, i) => i));
    assert.ok(p.every((x) => x.c === 0x123456 && x.b === 1));
  });

  it('R03 소등 payload도 13개다', () => {
    const p = offPayload();
    assert.equal(p.length, KEY_COUNT);
    assert.ok(p.every((x) => x.b === 0 && x.c === 0));
  });

  it('R04 색 결정 우선순위: 명시값 → 활성 레이어 색', () => {
    assert.equal(resolveRestoreColor({ explicit: '#ABCDEF' }).color, 0xabcdef);
    assert.equal(resolveRestoreColor({ activeLayerColor: '#1A1A4D' }).color, 0x1a1a4d);
    assert.equal(resolveRestoreColor({ explicit: '#ABCDEF', activeLayerColor: '#000000' }).color,
      0xabcdef, '명시값이 우선');
  });

  it('R05 색을 모르면 null을 돌려주고 사유를 남긴다', () => {
    const r = resolveRestoreColor({});
    assert.equal(r.color, null);
    assert.match(r.sourceKo, /알 수 없습니다/);
    const bad = resolveRestoreColor({ explicit: 'nope' });
    assert.equal(bad.color, null);
    assert.match(bad.sourceKo, /형식을 알 수 없습니다/);
  });

  it('R06 복구/소등 모드도 thstatus를 허용한다', () => {
    for (const mode of [{ restoreLeds: true }, { ledsOff: true }]) {
      assert.ok(methodsFor(mode).includes('v.oai.thstatus'), JSON.stringify(mode));
    }
  });

  it('R07 색을 정하지 못하면 아무것도 보내지 않고 안내한다', () => {
    let failed = false;
    try {
      execFileSync('node', ['tools/doctor.mjs', '--fake', '--restore-leds'],
        { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
      failed = true;
      assert.equal(e.status, 6);
      assert.match(e.stderr, /복구할 색을 정하지 못했습니다/);
      assert.match(e.stderr, /--restore-leds=1A1A4D/);
    }
    assert.ok(failed);
  });

  it('R08 복구가 진짜 복구가 아님을 분명히 말한다', () => {
    const out = execFileSync('node', ['tools/doctor.mjs', '--fake', '--restore-leds=1A1A4D'],
      { cwd: ROOT, encoding: 'utf8' });
    assert.match(out, /13개 키를 지정한 색 #1A1A4D\(으\)로 칠했습니다/);
    assert.match(out, /키별 override입니다/);
    assert.match(out, /진짜 복구가 아닙니다/);
  });

  it('R09 소등은 복구 방법을 함께 안내한다', () => {
    const out = execFileSync('node', ['tools/doctor.mjs', '--fake', '--leds-off'],
      { cwd: ROOT, encoding: 'utf8' });
    assert.match(out, /13개 키를 소등했습니다/);
    assert.match(out, /--restore-leds/);
  });
});
