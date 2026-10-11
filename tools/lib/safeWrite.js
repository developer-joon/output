import fs from 'node:fs';
import path from 'node:path';

/**
 * 호스트 파일 쓰기. 실패를 한국어로 설명한다.
 *
 * sudo로 한 번 실행하면 config/ 가 root 소유가 되어 이후 일반 실행이 막힌다.
 * 이때 Node 스택 트레이스를 던지지 않고 무엇을 해야 하는지 알려준다.
 */
export function describeWriteError(err, target) {
  if (err?.code === 'EACCES' || err?.code === 'EPERM') {
    return [
      `${target} 에 쓸 권한이 없습니다.`,
      '  sudo로 한 번 실행하면 그 디렉터리가 root 소유가 됩니다.',
      `  소유권을 되돌리세요:  sudo chown -R "$(whoami)" ${path.dirname(target)}`,
      '  이 명령은 장치에 접속하지 않으므로 sudo로 실행할 필요가 없습니다.',
    ].join('\n');
  }
  if (err?.code === 'ENOSPC') return `${target}: 디스크 공간이 부족합니다.`;
  return `${target} 쓰기 실패: ${err?.message ?? err}`;
}

/**
 * @returns {{ok:boolean, messageKo?:string}}
 */
export function safeWriteJson(target, value, { backupDir = null } = {}) {
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  } catch (err) {
    return { ok: false, messageKo: describeWriteError(err, target) };
  }

  let backup = null;
  if (fs.existsSync(target) && backupDir) {
    try {
      fs.mkdirSync(backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      backup = path.join(backupDir, `${path.basename(target, '.json')}-${stamp}.json`);
      fs.copyFileSync(target, backup);
      if (!fs.existsSync(backup)) {
        return { ok: false, messageKo: '백업을 만들지 못해 기록을 중단합니다.' };
      }
    } catch (err) {
      return { ok: false, messageKo: describeWriteError(err, backup ?? target) };
    }
  }

  const text = `${JSON.stringify(value, null, 2)}\n`;
  try {
    fs.writeFileSync(target, text, 'utf8');
  } catch (err) {
    return { ok: false, messageKo: describeWriteError(err, target) };
  }

  // read-back 검증
  try {
    const back = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (JSON.stringify(back) !== JSON.stringify(value)) {
      return { ok: false, messageKo: `${target}: read-back 내용이 다릅니다.` };
    }
  } catch (err) {
    return { ok: false, messageKo: `${target}: read-back 실패 — ${err.message}` };
  }
  return { ok: true, backup };
}
