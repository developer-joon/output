import path from 'node:path';

import { parseKeymap, prepareDevice, diffConfigs, OUR_LAYERS } from '../keymap/keymapModel.js';
import { DeviceWriter, listBackups } from '../keymap/deviceWriter.js';

/**
 * OutputService의 '장치 준비'(keymap 읽기·쓰기·백업 복원) (2026-10-10 outputService.js에서 나눔).
 * 장치 쓰기는 withWriter만 한다. OutputService.prototype에 붙는다 — this는 서비스다.
 */
export class DeviceSetupMethods {
  /**
   * 쓰기 전용 transport를 잠깐 연다. 런타임 transport를 먼저 놓는다 — HID 소유자는 하나다.
   * 끝나면 런타임을 다시 잡는다.
   */
  async withWriter(fn) {
    if (!this.openWriteTransport) return { ok: false, stage: 'setup', messageKo: '쓰기 경로가 준비되지 않았습니다.' };
    this.guard.suspend();
    await this.guard.settle();          // 진행 중이던 열기가 끝나고 놓일 때까지
    let t = null;
    try {
      t = await this.openWriteTransport();
      const writer = new DeviceWriter({ transport: t, backupDir: path.join(this.stateDir, 'backups') });
      return await fn(writer);
    } catch (err) {
      return { ok: false, stage: 'open', messageKo: `쓰기용으로 장치를 열지 못했습니다: ${err.message}` };
    } finally {
      try { t?.close(); } catch { /* 무시 */ }
      this.guard.resume();
      await this.guard.tick();
      this._changed();
    }
  }

  /** 장치 화면 상태 (프리셋·장치 스펙 §4.1) */
  deviceStatus() {
    const d = this.deviceInfo;
    if (!this.transport) {
      return { connected: false, deviceStateKo: this.guard.messageKo ?? '장치가 연결되어 있지 않습니다.', layerName: null, ready: false, reasonsKo: [] };
    }
    const reasonsKo = [];
    if (!OUR_LAYERS.includes(d.layerName)) reasonsKo.push(`지금 장치 레이어가 '${d.layerName ?? '알 수 없음'}'입니다`);
    if (d.layerNeedsUpgrade) reasonsKo.push('옛 키코드(ACT)가 있습니다');
    if (d.dialHintKo) reasonsKo.push('노브 누름이 하드웨어 레이어 전환 키입니다');
    if (d.otherLayerNames?.length) reasonsKo.push(`다른 레이어 ${d.otherLayerNames.length}개 (${d.otherLayerNames.join(', ')})`);
    return { connected: true, deviceStateKo: null, layerName: d.layerName, ready: reasonsKo.length === 0, reasonsKo };
  }

  /** '장치 준비' 1단계: 장치를 읽어 Output 하나로 만든 결과와 바뀌는 목록. 쓰지 않는다 */
  async devicePlan() {
    if (!this.transport) return { ok: false, errorKo: '장치가 연결되어 있지 않습니다.', diffLines: [], changesKo: [] };
    try {
      const raw = await this.transport.call('fs.read', { file: 'keymap.json' });
      const { config, errorsKo } = parseKeymap(raw?.data ?? '');
      if (!config) return { ok: false, errorKo: `keymap을 이해하지 못했습니다: ${errorsKo.join(' ')}`, diffLines: [], changesKo: [] };
      const r = prepareDevice(config, { profileIndex: this.deviceInfo.profileIndex });
      this.keymapDraft = { base: config, draft: r.config };
      return { ok: true, diffLines: diffConfigs(config, r.config), changesKo: r.changesKo };
    } catch (err) {
      return { ok: false, errorKo: `장치를 읽지 못했습니다: ${err.message}`, diffLines: [], changesKo: [] };
    }
  }

  /** '장치 준비' 2단계: 백업 → 쓰기 → 다시 읽어 대조. devicePlan 뒤에 장치가 바뀌었으면 쓰지 않는다 */
  async deviceApply() {
    if (!this.keymapDraft) return { ok: false, stage: 'plan', messageKo: '먼저 장치 준비 내용을 확인하세요.' };
    const { base, draft } = this.keymapDraft;
    const r = await this.withWriter(async (writer) => {
      const plan = await writer.plan(() => ({ config: draft, errorKo: null }));
      if (plan.errorKo) return { ok: false, stage: 'plan', messageKo: plan.errorKo };
      const fresh = parseKeymap(plan.beforeText).config;
      if (JSON.stringify(fresh) !== JSON.stringify(base)) {
        return { ok: false, stage: 'stale', messageKo: '확인한 뒤에 장치 설정이 바뀌었습니다. 장치 준비를 다시 누르세요. 아무것도 쓰지 않았습니다.' };
      }
      return writer.apply(plan);
    });
    this._log(r.ok ? `장치를 준비했습니다 (백업 ${r.backupPath})` : `장치 준비 실패: ${r.messageKo}`, r.ok ? 'info' : 'warn');
    this.keymapDraft = null;
    return r;
  }

  async keymapBackups() {
    return listBackups(path.join(this.stateDir, 'backups')).map((p) => ({ name: path.basename(p), path: p }));
  }

  async keymapRestore(backupPath) {
    // 렌더러가 준 경로를 그대로 믿지 않는다. 우리 백업 폴더 안의 파일만 장치에 쓴다.
    const dir = path.join(this.stateDir, 'backups');
    const resolved = path.resolve(String(backupPath ?? ''));
    if (path.dirname(resolved) !== dir || !/^keymap-.*\.json$/.test(path.basename(resolved))) {
      return { ok: false, stage: 'path', messageKo: '백업 폴더 안의 keymap 백업 파일만 되돌릴 수 있습니다.' };
    }
    const r = await this.withWriter((writer) => writer.restoreFrom(resolved));
    this._log(r.ok ? `백업으로 되돌렸습니다: ${path.basename(backupPath)}` : `복원 실패: ${r.messageKo}`, r.ok ? 'info' : 'warn');
    this.keymapDraft = null;
    return r;
  }
}
