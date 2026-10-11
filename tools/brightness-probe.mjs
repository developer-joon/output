/**
 * LED 밝기 비교 (2026-10-10): 30% · 70% · 100%를 키에 나란히 띄운다. Output을 끄고 실행한다. 20초 뒤 끈다.
 *   키 1·2·3 = 파랑 30·70·100 · 키 4·5·6 = 주황 · 키 7·8·9 = 초록 · 키 11·12·13 = 하늘(섞인 색)
 *   언더글로우는 끔. 인자로 다른 단계를 줄 수 있다: node tools/brightness-probe.mjs 25 50 100
 */
import { openHidTransport } from '../src/device/transport/hidTransport.js';
import { colorToInt } from '../src/device/deviceDriver.js';

const levels = (process.argv.slice(2).length === 3 ? process.argv.slice(2) : ['30', '70', '100']).map((v) => Number(v) / 100);
const rows = [['#5A8CDC', [0, 1, 2]], ['#E8762B', [3, 4, 5]], ['#3E9B5A', [6, 7, 8]], ['#2BB3E8', [10, 11, 12]]];
const payload = Array.from({ length: 13 }, (_, id) => ({ id, c: 0, e: 0 }));
for (const [color, ids] of rows) ids.forEach((id, i) => { payload[id] = { id, c: colorToInt(color, levels[i]), b: 1, e: 1, s: 0.5 }; });
payload.push({ id: 13, c: 0, e: 0, sa: 1 });

const t = openHidTransport({ exclusive: false, allowedMethods: ['v.oai.thstatus'] });
console.log(`연결: ${t.connection} — 밝기 ${levels.map((l) => `${Math.round(l * 100)}%`).join(' · ')} (왼쪽 → 오른쪽), 20초 동안`);
console.log(JSON.stringify(await t.call('v.oai.thstatus', payload, 3000)));
await new Promise((r) => { setTimeout(r, 20000); });
await t.call('v.oai.thstatus', [...Array.from({ length: 13 }, (_, id) => ({ id, c: 0, e: 0 })), { id: 13, c: 0, e: 0, sa: 1 }], 3000);
console.log('끔');
t.close();
