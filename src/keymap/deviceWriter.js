import fs from 'node:fs';
import path from 'node:path';
import { parseKeymap, validateConfig, diffConfigs } from './keymapModel.js';

/**
 * 장치 keymap 쓰기 경로 (M5 설계 §11.5, AGENTS.md 2·3).
 *
 * 런타임 transport는 fs.write가 막혀 있다. 이 클래스만 fs.write가 허용된 **별도** transport를 받는다.
 * 사용자가 "장치에 적용"을 눌렀을 때만 만들어지고 쓴다.
 *
 *   plan(mutator)   장치를 읽어 바꾼 결과와 diff를 만든다. 아무것도 쓰지 않는다 (dry-run)
 *   apply(plan)     다시 읽어 dry-run 이후 바뀌지 않았는지 확인 → 백업 → 검증 → 쓰기 →
 *                   다시 읽어 대조 → 어긋나면 백업으로 한 번 되돌린다
 *
 * 되돌리기도 실패하면 **다시 시도하지 않는다.** 백업 경로를 알려주고 멈춘다.
 * 플래시에 쓰기를 반복하는 것이 가장 나쁜 대응이다.
 */
export const WRITE_METHODS = Object.freeze(['sys.version', 'device.status', 'fs.read', 'fs.write']);
const FILE = 'keymap.json';

const stamp = (d) => d.toISOString().replace(/[:.]/g, '-');
const same = (a, b) => {
  try { return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b)); } catch { return false; }
};

export class DeviceWriter {
  constructor({ transport, backupDir, now = () => new Date(), sleep = (ms) => new Promise((r) => { setTimeout(r, ms); }) }) {
    if (!transport?.canCall?.('fs.write')) {
      throw new Error('이 transport로는 장치에 쓰기를 할 수 없습니다. 쓰기 전용 transport가 필요합니다.');
    }
    this.transport = transport;
    this.backupDir = backupDir;
    this.now = now;
    this.sleep = sleep;
  }

  async _read() {
    const r = await this.transport.call('fs.read', { file: FILE });
    if (typeof r?.data !== 'string') throw new Error('fs.read keymap.json 응답 형식이 예상과 다릅니다.');
    return r.data;
  }

  /**
   * @param {(config:object) => {config:object|null, errorKo:string|null}} mutator
   * @returns {Promise<{beforeText:string, after:object|null, diffLines:string[], errorKo:string|null}>}
   */
  async plan(mutator) {
    let beforeText;
    try {
      beforeText = await this._read();
    } catch (err) {
      return { beforeText: null, after: null, diffLines: [], errorKo: `장치를 읽지 못했습니다: ${err.message}` };
    }
    const { config, errorsKo } = parseKeymap(beforeText);
    if (!config) return { beforeText, after: null, diffLines: [], errorKo: `지금 장치의 keymap을 이해하지 못했습니다: ${errorsKo.join(' ')}` };
    const r = mutator(config);
    if (!r?.config) return { beforeText, after: null, diffLines: [], errorKo: r?.errorKo ?? '바꿀 수 없습니다.' };
    const v = validateConfig(r.config);
    if (v.errorsKo.length) return { beforeText, after: null, diffLines: [], errorKo: `결과가 올바르지 않아 쓰지 않습니다: ${v.errorsKo.join(' ')}` };
    return { beforeText, after: r.config, diffLines: diffConfigs(config, r.config), errorKo: null };
  }

  _backup(text, label) {
    const file = path.join(this.backupDir, `keymap-${stamp(this.now())}${label ? `-${label}` : ''}.json`);
    fs.mkdirSync(this.backupDir, { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
    if (fs.readFileSync(file, 'utf8') !== text) throw new Error('백업 내용이 다릅니다.');
    return file;
  }

  async _writeAndVerify(text) {
    await this.transport.call('fs.write', { file: FILE, data: text });
    await this.sleep(500);
    const back = await this._read();
    return same(back, text);
  }

  /** @returns {Promise<{ok:boolean, stage:string, messageKo:string, backupPath?:string, restored?:boolean}>} */
  async apply(plan, { label = '' } = {}) {
    if (!plan || plan.errorKo || !plan.after) {
      return { ok: false, stage: 'plan', messageKo: plan?.errorKo ?? '적용할 계획이 없습니다.' };
    }
    let current;
    try {
      current = await this._read();
    } catch (err) {
      return { ok: false, stage: 'read', messageKo: `장치를 읽지 못했습니다: ${err.message}` };
    }
    if (!same(current, plan.beforeText)) {
      return { ok: false, stage: 'stale', messageKo: '확인한 뒤에 장치 설정이 바뀌었습니다. 다시 확인하고 적용하세요. 아무것도 쓰지 않았습니다.' };
    }
    let backupPath;
    try {
      backupPath = this._backup(current, label);
    } catch (err) {
      return { ok: false, stage: 'backup', messageKo: `백업을 만들지 못해 쓰지 않았습니다: ${err.message}` };
    }
    const text = JSON.stringify(plan.after);
    try {
      if (await this._writeAndVerify(text)) {
        return { ok: true, stage: 'done', messageKo: '장치에 썼고 다시 읽어 일치를 확인했습니다.', backupPath };
      }
    } catch (err) {
      return {
        ok: false, stage: 'write', backupPath, restored: false,
        messageKo: `쓰기에 실패했습니다: ${err.message}. 장치 상태를 모르면 '장치 복구'에서 백업(${backupPath})을 고르세요.`,
      };
    }
    // 대조 실패 — 한 번만 되돌린다
    let restored = false;
    try {
      restored = await this._writeAndVerify(current);
    } catch { restored = false; }
    return {
      ok: false, stage: 'verify', backupPath, restored,
      messageKo: restored
        ? '쓴 내용이 다시 읽은 내용과 달라 백업으로 되돌렸습니다. 장치는 원래대로입니다.'
        : `쓴 내용이 달랐고 되돌리기도 실패했습니다. 다시 시도하지 마시고, 장치 복구에서 백업 ${backupPath}을(를) 고르세요.`,
    };
  }

  /** 백업 파일로 되돌린다. 되돌리기 직전 상태도 백업한다. */
  async restoreFrom(backupPath) {
    let text;
    try {
      text = fs.readFileSync(backupPath, 'utf8');
    } catch (err) {
      return { ok: false, stage: 'read-backup', messageKo: `백업을 읽지 못했습니다: ${err.message}` };
    }
    const target = parseKeymap(text);
    if (!target.config) return { ok: false, stage: 'plan', messageKo: `백업 파일이 올바르지 않습니다: ${target.errorsKo.join(' ')}` };
    const plan = await this.plan(() => ({ config: target.config, errorKo: null }));
    return this.apply(plan, { label: 'before-restore' });
  }

  listBackups() {
    return listBackups(this.backupDir);
  }
}

/** 백업 폴더의 keymap 백업 경로, 최신 순. 폴더가 없으면 빈 목록. */
export function listBackups(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /^keymap-.*\.json$/.test(f))
    .sort().reverse()
    .map((f) => path.join(dir, f));
}
