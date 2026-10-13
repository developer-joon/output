/**
 * M31 — 기본 레이어 Mac 추천 키 (사용자 2026-10-14: 처음 쓰는 사람이 직접 채우기 어렵다).
 * 새로 설치하면 기본 레이어가 채워져 시작하고, 이미 쓰던 사람은 '추천 키 채우기'로 빈 칸만 채운다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { defaultLayers, normalizeLayers, validateLayers, fillRecommended } from '../src/apps/layers.js';

describe('M31 / 기본 레이어 Mac 추천 키', () => {
  it('K01 새로 설치하면 기본 레이어에 키 1~10·노브가 채워져 있고, 키 11~13·조이스틱은 비어 있다', () => {
    const def = normalizeLayers(undefined)[0];
    assert.equal(def.kind, 'default');
    assert.equal(def.keys.key1.keystroke, 'cmd+c');
    assert.equal(def.keys.key5.keystroke, 'cmd+space');
    assert.equal(def.keys.key9.type, 'screenshot');
    assert.equal(def.keys.key9.save, 'clipboard');
    assert.deepEqual(Object.keys(def.keys).sort(), ['key1', 'key10', 'key2', 'key3', 'key4', 'key5', 'key6', 'key7', 'key8', 'key9']);
    assert.equal(def.dial.cw.keystroke, 'volume_up');
    assert.equal(def.dial.press.keystroke, 'mute');
    assert.deepEqual(def.joystick.short, {});
    assert.ok(def.keys.key1.led, '키마다 고정 색');
    assert.deepEqual(validateLayers(normalizeLayers(undefined)).errorsKo, []);
  });

  it('K02 이미 저장된 기본 레이어는 건드리지 않는다 (빈 기본 레이어도 그대로)', () => {
    const saved = normalizeLayers([{ id: 'default', kind: 'default', keys: {}, dial: {} }]);
    assert.deepEqual(saved[0].keys, {});
    assert.deepEqual(saved[0].dial, {});
  });

  it('K03 추천 키 채우기: 빈 칸만 채우고 정한 칸은 덮어쓰지 않는다, 채운 수를 돌려준다', () => {
    const layer = normalizeLayers([{ id: 'default', kind: 'default', keys: { key1: { type: 'shortcut', label: '내 키', keystroke: 'cmd+k' } }, dial: {} }])[0];
    const n = fillRecommended(layer);
    assert.equal(n, 12);   // 키 10개 + 노브 3칸 − 이미 정한 키 1
    assert.equal(layer.keys.key1.keystroke, 'cmd+k');
    assert.equal(layer.keys.key2.keystroke, 'cmd+v');
    assert.equal(layer.dial.ccw.keystroke, 'volume_down');
    assert.equal(fillRecommended(layer), 0, '다 차 있으면 0');
  });

  it('K04 채운 동작은 공유되지 않는다 (복사본)', () => {
    const a = defaultLayers()[0];
    a.keys.key1.label = '바뀜';
    assert.notEqual(defaultLayers()[0].keys.key1.label, '바뀜');
  });
});
