import nodeFs from 'node:fs';
import path from 'node:path';
import { describeWriteError } from '../../../tools/lib/safeWrite.js';
import { SCHEMA_VERSION, validateState } from './schema.js';

/**
 * state.json 하나를 안전하게 읽고 쓴다.
 *
 * - 없으면 null. 경고 없음 — 처음 켠 것이다.
 * - 깨졌으면 지우지 않고 `.corrupt-<시각>`으로 옮긴다. 왜 깨졌는지 나중에 볼 수 있어야 한다.
 * - 더 새로운 버전이면 읽지도 옮기지도 않는다. 옛 앱이 새 데이터를 망치면 안 된다.
 * - 쓰기는 원자적이다: 같은 디렉터리의 임시 파일에 쓰고 fsync한 뒤 rename으로 바꿔 넣는다.
 *   제자리에서 덮어쓰다 죽으면 잘린 JSON이 남고, 다음 시작에서 배치·핀·확인이 전부 사라진다.
 *   백업은 만들지 않는다 — 이 파일은 관측이 아니라 의도라서 이전 값이 필요한 경우가 없다.
 */
/**
 * JSON을 원자적으로 쓴다: 같은 디렉터리의 임시 파일에 쓰고 fsync한 뒤 rename으로 바꿔 넣는다.
 * 실패하면 임시 파일을 치우고 던진다. 앱의 모든 호스트 JSON 쓰기(state·profiles·setup)가 이 한 벌을 쓴다.
 */
export function writeJsonAtomic(file, value, fs = nodeFs) {
  const tmp = `${file}.tmp-${process.pid}`;
  const text = `${JSON.stringify(value, null, 2)}\n`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, text, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 임시 파일 정리 실패는 무시 */ }
    throw err;
  }
}

export class FileStore {
  constructor({ dir, filename = 'state.json', fs = nodeFs }) {
    if (!dir) throw new Error('FileStore: dir가 필요합니다.');
    this.fs = fs;
    this.dir = dir;
    this.path = path.join(dir, filename);
  }

  /** @returns {{state:object|null, warningKo:string|null, newerVersion:boolean}} */
  read() {
    if (!this.fs.existsSync(this.path)) return { state: null, warningKo: null, newerVersion: false };
    let text;
    try {
      text = this.fs.readFileSync(this.path, 'utf8');
    } catch (err) {
      return { state: null, warningKo: `${this.path}을(를) 읽지 못했습니다: ${err.message}`, newerVersion: false };
    }
    let obj;
    try {
      obj = JSON.parse(text);
    } catch {
      return { state: null, warningKo: this._quarantine('JSON이 아닙니다'), newerVersion: false };
    }
    if (obj && Number.isInteger(obj.version) && obj.version > SCHEMA_VERSION) {
      return {
        state: null,
        newerVersion: true,
        warningKo: `${this.path}은(는) 더 새로운 버전(v${obj.version})의 파일입니다. `
          + `이 버전(v${SCHEMA_VERSION})은 읽지도 덮어쓰지도 않습니다. 앱을 업데이트하세요.`,
      };
    }
    const v = validateState(obj);
    if (!v.ok) return { state: null, warningKo: this._quarantine(v.errorsKo.join(' ')), newerVersion: false };
    return { state: obj, warningKo: null, newerVersion: false };
  }

  /** 손상 파일을 옆으로 옮기고 사람이 읽을 경고를 돌려준다. */
  _quarantine(reasonKo) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const to = `${this.path}.corrupt-${stamp}`;
    try {
      this.fs.renameSync(this.path, to);
      return `저장된 상태가 손상되어 빈 상태로 시작합니다 (${reasonKo}). 원본은 ${to}에 남겼습니다.`;
    } catch (err) {
      return `저장된 상태가 손상되었고(${reasonKo}) 옮기지도 못했습니다: ${err.message}. 빈 상태로 시작합니다.`;
    }
  }

  /** @returns {{ok:boolean, messageKo?:string}} */
  write(state) {
    const v = validateState(state);
    if (!v.ok) return { ok: false, messageKo: `저장할 상태가 올바르지 않습니다: ${v.errorsKo.join(' ')}` };
    const fs = this.fs;
    try {
      writeJsonAtomic(this.path, state, fs);
    } catch (err) {
      return { ok: false, messageKo: describeWriteError(err, this.path) };
    }
    // read-back 대조
    try {
      const back = JSON.parse(fs.readFileSync(this.path, 'utf8'));
      if (JSON.stringify(back) !== JSON.stringify(state)) {
        return { ok: false, messageKo: `${this.path}: read-back 내용이 다릅니다.` };
      }
    } catch (err) {
      return { ok: false, messageKo: `${this.path}: read-back 실패 — ${err.message}` };
    }
    return { ok: true };
  }
}
