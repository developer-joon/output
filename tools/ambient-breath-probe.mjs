/**
 * 언더글로우 숨쉬기 실험 (2026-10-10): 언더글로우 항목(id 13, sa:1)에 키처럼 e·s를 주면 숨쉬는지 본다.
 * Output을 끄고 실행한다. 5초씩: 1차에서 b가 없으면 언더글로우가 켜지지 않아 b:1을 넣어 다시 본다.
 */
import { openHidTransport } from '../src/device/transport/hidTransport.js';

const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });
const keysOff = Array.from({ length: 13 }, (_, id) => ({ id, c: 0 }));
const t = openHidTransport({ exclusive: false, allowedMethods: ['v.oai.thstatus'] });
console.log(`연결: ${t.connection}`);
// `node tools/ambient-breath-probe.mjs 4` — 꺼졌다 켜짐(e:4)만 속도별로 8초씩
const only4 = process.argv[2] === '4';
const STEPS = only4 ? [
  ['e:4 느림 (s:0.2)', { b: 1, e: 4, s: 0.2 }],
  ['e:4 보통 (s:0.5)', { b: 1, e: 4, s: 0.5 }],
  ['e:4 빠름 (s:0.9)', { b: 1, e: 4, s: 0.9 }],
  ['끔', null],
] : null;
for (const [label, amb] of STEPS ?? [
  ['① 예전 전체 형식 빨강 고정 (b:1 e:1 sk:0)', { b: 1, e: 1, s: 0.5, sk: 0 }],
  ['② 짧은 형식 + b:1 빨강 고정', { b: 1, e: 1, s: 0.5 }],
  ['③ b:1 + e:6 s:0.9 (키의 숨쉬기)', { b: 1, e: 6, s: 0.9 }],
  ['④ b:1 + e:3 s:0.5 (숨쉬며 회전·색 변화)', { b: 1, e: 3, s: 0.5 }],
  ['⑤ b:1 + e:4 s:0.5 (꺼졌다 켜짐)', { b: 1, e: 4, s: 0.5 }],
  ['⑥ 끔', null],
]) {
  const payload = [...keysOff, amb ? { id: 13, c: 0xff0000, ...amb, sa: 1 } : { id: 13, c: 0, b: 0, e: 0, s: 0.5, sk: 0, sa: 1 }];
  try {
    const r = await t.call('v.oai.thstatus', payload, 3000);
    console.log(`${label} → 응답 ${JSON.stringify(r)}`);
  } catch (err) {
    console.log(`${label} → 실패 ${err.message}`);
  }
  if (amb) await wait(only4 ? 8000 : 5000);
}
t.close();
