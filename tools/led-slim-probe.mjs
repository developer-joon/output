/**
 * 블루투스 LED 속도 실험 (2026-10-10, 개선 3번): 기본값을 뺀 짧은 LED 명령을 장치가 받아 주는지 본다.
 * Output을 끄고 실행한다. 3초씩 ① 전체 명령 빨강 → ② 짧은 명령 파랑 → ③ 짧은 명령 끄기(키 1만 초록).
 * ②에서 13키가 파랑, ③에서 키 1만 초록이고 나머지가 꺼지면 짧은 명령을 써도 된다.
 */
import { openHidTransport } from '../src/device/transport/hidTransport.js';

const full = (c) => Array.from({ length: 13 }, (_, id) => ({ id, c, b: 1, e: 1, s: 0.5, sk: 0, sa: 0 }));
const slim = (colorOf) => Array.from({ length: 13 }, (_, id) => (colorOf(id) ? { id, c: colorOf(id), e: 1, s: 0.5 } : { id, c: 0 }));
const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });

const t = openHidTransport({ exclusive: false, allowedMethods: ['v.oai.thstatus'] });
console.log(`연결: ${t.connection}`);
for (const [label, payload] of [
  ['① 전체 명령 — 13키 빨강', full(0xff0000)],
  ['② 짧은 명령 — 13키 파랑', slim(() => 0x0080ff)],
  ['③ 짧은 명령 — 키 1만 초록, 나머지 꺼짐', slim((id) => (id === 0 ? 0x00ff00 : 0))],
]) {
  const bytes = JSON.stringify(payload).length;
  try {
    const r = await t.call('v.oai.thstatus', payload, 3000);
    console.log(`${label}  (${bytes}B) → 응답 ${JSON.stringify(r)}`);
  } catch (err) {
    console.log(`${label}  (${bytes}B) → 실패 ${err.message}`);
  }
  await wait(3000);
}
t.close();
