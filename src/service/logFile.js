import fs from 'node:fs';
import path from 'node:path';

/**
 * 기동 로그 한 줄 쓰기 (2026-10-10: launch.log가 끝없이 커졌다). 한도를 넘으면 지금 파일을 <이름>.1로 옮기고
 * 새로 쓴다 — 옛 .1은 버린다. 많아야 두 파일. 실패해도 던지지 않는다 (로그가 앱을 막으면 안 된다).
 */
export function appendLog(file, line, { maxBytes = 1024 * 1024 } = {}) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let size = 0;
    try { size = fs.statSync(file).size; } catch { /* 처음 */ }
    if (size > maxBytes) fs.renameSync(file, `${file}.1`);
    fs.appendFileSync(file, `${line}\n`);
  } catch { /* 무시 */ }
}
