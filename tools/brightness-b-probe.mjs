/**
 * 짧은 LED 명령의 b(밝기) 확인 (2026-10-11, 노브로 레이어 고른 뒤 키가 안 바뀐 조사). Output을 끄고 실행한다.
 * ① 키 1~8을 b:0으로 끈다(장치가 b를 기억하는지 보려고) → ② Output이 보낸 것과 같은 짧은 명령(b 없음) Code 색
 * → ③ 같은 색에 b:1을 넣어서 → ④ 끔. 8초씩 — 단계 이름을 먼저 보여 주고 보낸다.
 */
import { openHidTransport } from '../src/device/transport/hidTransport.js';

const CODE = [0x365484, 0x1a6b8b, 0x534076, 0x135f5a, 0x255d36, 0x862b13, 0x826110, 0x762d80];
const rest = (from) => Array.from({ length: 13 - from }, (_, i) => ({ id: from + i, c: 0, e: 0 }));
const amb = { id: 13, c: 0, e: 0, sa: 1 };
const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });
const t = openHidTransport({ exclusive: false, allowedMethods: ['v.oai.thstatus'] });
console.log(`연결: ${t.connection}`);
for (const [label, keys] of [
  ['① 키 1~8 b:0 (빨강이지만 밝기 0)', CODE.map((_, id) => ({ id, c: 0xff0000, b: 0, e: 1, s: 0.6 }))],
  ['② Output과 같은 짧은 명령 — b 없음, Code 색', CODE.map((c, id) => ({ id, c, e: 1, s: 0.6 }))],
  ['③ 같은 색에 b:1', CODE.map((c, id) => ({ id, c, b: 1, e: 1, s: 0.6 }))],
  ['④ 끔', CODE.map((_, id) => ({ id, c: 0, e: 0 }))],
]) {
  console.log(`\n지금: ${label} (8초)`);
  const r = await t.call('v.oai.thstatus', [...keys, ...rest(8), amb], 3000).catch((e) => ({ error: e.message }));
  if (!r?.ok) console.log(`  장치 응답: ${JSON.stringify(r)}`);
  await wait(8000);
}
t.close();
