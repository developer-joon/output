/**
 * 입력·LED 기록 (2026-10-10, 레이어 고르기 조사). Output을 켠 채로 실행한다 — 장치를 함께 열어 지켜보기만 한다.
 * 30초 동안 장치가 보내는 키·노브 신호와, Output이 보낸 LED 명령의 응답(thstatus)을 시각과 함께 적는다.
 */
import { openHidTransport } from '../src/device/transport/hidTransport.js';

const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`;
const ACT = { 0: '뗌', 1: '누름', 2: '돌림' };
const t = openHidTransport({ exclusive: false, allowedMethods: [] });
console.log(`연결: ${t.connection} — 30초 동안 기록합니다. 노브를 0.5초 누르고 → 돌려서 → 눌러 고르세요.`);
t.onNotification((o) => {
  if (o?.m === 'v.oai.hid') console.log(`${at()} 키 ${o.p?.k} ${ACT[o.p?.act] ?? o.p?.act}`);
});
t.onForeignResponse((m) => { if (m) console.log(`${at()} Output 명령 응답: ${m}`); });
await new Promise((r) => { setTimeout(r, 30000); });
t.close();
console.log('끝');
