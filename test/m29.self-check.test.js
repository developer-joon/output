/**
 * M29 — 점검하기 (2026-10-12 사용자 요청: 다른 Mac에서 세션·포커싱은 되는데 키 LED만 안 켜졌다 — 어디가 막혔는지 설정창에서 보기).
 * 권한 · 장치 연결 · 장치 설정 · LED 테스트 · Orca · 지금 레이어 · 환경. 결과 글에는 작업 이름·경로를 넣지 않는다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function svc() {
  const { OutputService } = await import('../src/service/outputService.js');
  const { UNCALIBRATED } = await import('../src/device/calibrationLoader.js');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-m29-'));
  const s = new OutputService({ calibration: UNCALIBRATED, stateDir, orcaEnabled: false, now: () => 1000,
    timers: { setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {} },
    openRuntimeTransport: async () => { throw Object.assign(new Error('x'), { code: 'DEVICE_NOT_FOUND' }); },
    frontmost: async () => 'com.stablyai.orca', ownBundleIds: [] });
  await s.watcher.tick();
  return s;
}
const ENV = { accessibility: true, arch: 'arm64', osKo: 'macOS 26.0', appVersion: '1.0.3', orcaBin: '/opt/homebrew/bin/orca' };
const sleep = async () => {};
const item = (r, id) => r.items.find((i) => i.id === id);

describe('M29 / 점검하기', () => {
  it('C01 장치가 없으면 연결 ✗ + 고치는 법, LED 테스트는 건너뜀', async () => {
    const s = await svc();
    const r = await s.selfCheck(ENV, { sleep });
    assert.equal(item(r, 'device').ok, false);
    assert.ok(item(r, 'device').fixKo);
    assert.equal(item(r, 'led').ok, null);
    assert.deepEqual(r.items.map((i) => i.id), ['permissions', 'device', 'keymap', 'led', 'orca', 'layer', 'env']);
  });

  it('C02 LED 테스트: 키 13개와 언더글로우를 하나씩 켜고(14번) 성공 수를 센다 — 그동안 평소 그리기는 장치에 가지 않는다', async () => {
    const s = await svc();
    const sent = [];
    s.transport = { connection: 'bluetooth', call: async (m, p) => { sent.push(p); return { ok: 1 }; } };
    let during = 0;
    const r = await s.selfCheck(ENV, { sleep: async () => { during += 1; await s.driver.send?.([{ id: 0, c: 1 }]); } });
    const steps = sent.filter((p) => p.length === 14);
    assert.equal(steps.length, 14 + 1, '14단계 + 끝에 모두 끄기');
    for (let k = 0; k < 13; k++) {
      const lit = steps[k].filter((e) => e.c);
      assert.deepEqual(lit.map((e) => e.id), [k], `${k}번째 단계는 키 ${k}만`);
    }
    assert.deepEqual(steps[13].filter((e) => e.c).map((e) => e.id), [13], '마지막은 언더글로우');
    assert.equal(steps[13].find((e) => e.id === 13).sa, 1);
    assert.equal(steps[13].find((e) => e.id === 13).b, 1);
    assert.ok(steps[14].every((e) => !e.c), '끝나면 모두 끔 — 다음 그리기가 원래 상태로 되돌린다');
    assert.equal(item(r, 'led').ok, true);
    assert.match(item(r, 'led').detailKo, /14개 중 14개/);
    assert.ok(during > 0);
  });

  it('C03 LED가 연달아 3번 실패하면 멈추고 오류를 보여 준다 (오래 걸리지 않게)', async () => {
    const s = await svc();
    let calls = 0;
    s.transport = { connection: 'bluetooth', call: async () => { calls += 1; throw new Error('IOHIDDeviceSetReport failed: (0xE00002BC)'); } };
    const r = await s.selfCheck(ENV, { sleep });
    assert.equal(calls, 3);
    const led = item(r, 'led');
    assert.equal(led.ok, false);
    assert.match(led.detailKo, /0xE00002BC/);
    assert.match(led.detailKo, /블루투스/);
  });

  it('C04 Orca: 명령 위치·작업·에이전트 수만 — 결과 글에 작업 이름이 들어가지 않는다', async () => {
    const s = await svc();
    const { WorkUnit } = await import('../src/core/units.js');
    s.store.addUnit(new WorkUnit({ id: 'secret-id', title: '비밀 작업 이름', source: 'orca' }));
    const r = await s.selfCheck(ENV, { sleep });
    const orca = item(r, 'orca');
    assert.match(orca.detailKo, /\/opt\/homebrew\/bin\/orca/);
    assert.match(orca.detailKo, /작업 \d+개/);
    assert.equal(r.text.includes('비밀 작업 이름'), false);
    assert.equal(r.text.includes('secret-id'), false);
  });

  it('C05 결과 글: 항목마다 ✓/✗/– 한 줄, 환경(Mac 종류·macOS·앱 버전) 포함', async () => {
    const s = await svc();
    const r = await s.selfCheck(ENV, { sleep });
    assert.match(r.text, /^Output 점검/m);
    assert.match(r.text, /✗ 장치 연결/);
    assert.match(r.text, /arm64/);
    assert.match(r.text, /macOS 26\.0/);
    assert.match(r.text, /1\.0\.3/);
  });

  it('C06 입력 모니터링이 막혔으면 권한 ✗ + 시스템 설정 열기', async () => {
    const s = await svc();
    s.guard.state = 'denied';
    const r = await s.selfCheck({ ...ENV, accessibility: false }, { sleep });
    const p = item(r, 'permissions');
    assert.equal(p.ok, false);
    assert.match(p.detailKo, /입력 모니터링/);
    assert.match(p.detailKo, /손쉬운 사용/);
    assert.equal(p.action, 'open-input-monitoring');
  });
});
