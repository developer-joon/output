/**
 * 개선 4 — Electron 계층. Electron 없이 도는 부분만 검사한다.
 *
 * preload는 sandbox라 로컬 모듈을 require할 수 없어 채널 목록을 코드로 공유하지 못한다.
 * 대신 두 파일의 문자열이 어긋나면 여기서 잡는다 — 런타임에서 '허용되지 않은 채널'로 만나기 전에.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { fakeDevicePair } from '../src/device/fakeDevicePair.js';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const literals = (src, re) => new Set([...src.matchAll(re)].map((m) => m[1]));

describe('개선 4 / IPC 채널 드리프트', () => {
  const preload = read('../electron/preload.cjs');
  const main = read('../electron/main.mjs');

  it('I01 preload가 허용한 invoke 채널과 main이 handle한 채널이 같다', () => {
    const invokeBlock = /const INVOKE = new Set\(\[([\s\S]*?)\]\);/.exec(preload)[1];
    const allowed = literals(invokeBlock, /'(cb:[\w:]+)'/g);
    const handled = literals(main, /handle\('(cb:[\w:]+)'/g);
    assert.deepEqual([...allowed].sort(), [...handled].sort());
  });

  it('I03 프리셋·장치 채널이 있고 키맵 직접 편집 채널은 없다 (2026-10-04)', () => {
    const invokeBlock = /const INVOKE = new Set\(\[([\s\S]*?)\]\);/.exec(preload)[1];
    const allowed = literals(invokeBlock, /'(cb:[\w:]+)'/g);
    for (const c of ['cb:presets:list', 'cb:presets:copy', 'cb:layers:orcaUnlinked', 'cb:device:status', 'cb:device:plan', 'cb:device:apply']) {
      assert.ok(allowed.has(c), c);
    }
    // 백업 목록·되돌리기 화면은 없앴다 (2026-10-11 앱 정보 개편). 백업 파일과 쓰기 실패 시 자동 되돌리기는 그대로
    for (const c of ['cb:keymap:load', 'cb:keymap:state', 'cb:keymap:edit', 'cb:keymap:apply', 'cb:keymap:backups', 'cb:keymap:restore']) assert.equal(allowed.has(c), false, c);
  });

  it('I04 설정 맨 아래 메뉴는 \'앱 정보\' — 안내 문구도 같은 이름을 쓴다 (2026-10-11)', () => {
    assert.match(read('../electron/renderer/settings.html'), /data-nav="about"[^>]*>앱 정보</);
    for (const f of ['../electron/renderer/popover.js', '../electron/renderer/settings.html', '../src/service/outputService.js']) {
      assert.equal(read(f).includes('정보 · 진단'), false, f);
    }
  });

  it('I02 preload가 허용한 이벤트와 main이 send하는 이벤트가 같다', () => {
    const eventsBlock = /const EVENTS = new Set\(\[([\s\S]*?)\]\);/.exec(preload)[1];
    const allowed = literals(eventsBlock, /'(cb:[\w:]+)'/g);
    // 화면 표시 창(hud.mjs, 2026-10-10)도 보낸다
    const sent = literals(main + read('../electron/hud.mjs'), /\.send\('(cb:[\w:]+)'/g);
    assert.deepEqual([...allowed].sort(), [...sent].sort());
  });
});

describe('개선 4 / 가짜 장치 한 쌍 (--fake-device)', () => {
  it('F01 런타임은 fs.write가 막혀 있고, 쓰기용으로 쓴 keymap을 런타임이 다시 읽는다', async () => {
    const { runtime, writer } = fakeDevicePair();
    const rt = runtime();
    await assert.rejects(() => rt.call('fs.write', { file: 'keymap.json', data: '{}' }), /금지/);
    const before = (await rt.call('fs.read', { file: 'keymap.json' })).data;
    assert.ok(before.includes('Output'), '설치된 Output 레이어가 들어 있다');
    const w = writer();
    await w.call('fs.write', { file: 'keymap.json', data: '{"changed":1}' });
    assert.equal((await runtime().call('fs.read', { file: 'keymap.json' })).data, '{"changed":1}');
    assert.equal((await rt.call('device.status')).layer_index, 2, 'Output 레이어(1부터 셈)가 활성');
  });
});
