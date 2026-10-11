import path from 'node:path';
import fs from 'node:fs';

import { writeJsonAtomic } from '../adapters/persistence/fileStore.js';
import { readSourcesFile, SOURCE_FILE_VERSION } from './profiles.js';
import { normalizeLayers, validateLayers, resolveLayer, migrateToLayers, layerFromPreset } from '../apps/layers.js';
import { PRESETS, ORCA_PRESET } from '../apps/presets.js';
import { pickKeyColor } from '../apps/keyLed.js';

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * OutputService의 레이어 저장·불러오기·제안·내보내기 (2026-10-10 outputService.js에서 나눔).
 * OutputService.prototype에 붙는다 — this는 서비스다.
 */
export class LayerStoreMethods {
  _profilesFile() {
    return path.join(this.stateDir, 'profiles.json');
  }

  _loadSources() {
    const raw = readJson(this._profilesFile());
    const r = readSourcesFile(raw, this.sources);
    this._sourcesWarnKo = r.warningKo;
    this._sourcesNotesKo = [...r.notesKo];
    if (r.layersRaw) {
      this.layers = normalizeLayers(r.layersRaw, this._sourcesNotesKo);
    } else {
      const controlsRaw = r.controlsByName.get(this.sources[0].name) ?? null;
      this.layers = migrateToLayers({ controlsRaw, appKeysRaw: r.appKeysRaw }, this._sourcesNotesKo);
      if (raw && (controlsRaw || r.appKeysRaw)) this._sourcesNotesKo.push('설정을 레이어로 옮겼습니다 (Orca → Orca 프리셋 레이어, 기본·앱 세트 → 레이어).');
    }
  }

  /** 앞 앱의 보이는 이름을 찾아 둔다 (상태판 레이어 제안용). 실패하면 번들 ID 끝 */
  _lookupFrontName(bundleId) {
    this._frontName = null;
    Promise.resolve(this.appName(bundleId)).then((n) => { if (this._front === bundleId) { this._frontName = n || null; this._changed(); } }).catch(() => {});
  }

  /** 지금 앞 앱에 레이어가 없으면(기본 레이어를 쓰거나 대기) 만들기를 제안한다 (2026-10-10). Orca 앱은 빼고 */
  _suggestLayer() {
    if (!this._front || this.sources[0].bundleIds.includes(this._front)) return null;
    if (this.mode === 'orca' || (this._layer && this._layer.kind !== 'default')) return null;
    return { bundleId: this._front, name: this._frontName || this._front.split('.').pop() };
  }

  /** 이 앱이 연결된 새 레이어 (색 무작위). 이미 있으면 그 레이어 id */
  createLayerForApp(bundleId, name) {
    const layers = this.layersGet();
    const have = layers.find((l) => l.kind === 'user' && l.apps.some((a) => a.bundleId === bundleId));
    if (have) return { ok: true, id: have.id };
    const id = `l-app-${Date.now().toString(36)}`;
    layers.push({ id, kind: 'user', name: name || bundleId, color: pickKeyColor(layers.map((l) => l.color)), preset: null,
      apps: [{ bundleId, name: name || bundleId }], keys: {}, dial: {}, joystick: { directions: 4, axis: 'vertical', short: {}, long: {} } });
    const r = this.layersSave(layers);
    return r.ok ? { ok: true, id } : r;
  }

  /** 레이어 내보내기 (2026-10-10): 백업·다른 Mac으로 옮기기 */
  layersExport() {
    return { kind: 'output-layers', version: SOURCE_FILE_VERSION, exportedAt: new Date(this.now()).toISOString(), layers: this.layersGet() };
  }

  /** 레이어 가져오기: 검사만 하고 저장하지 않는다 — 설정 화면이 '저장 안 한 변경'으로 보여 주고, 저장은 사용자가 */
  layersImport(raw) {
    if (!raw || raw.kind !== 'output-layers' || !Array.isArray(raw.layers)) {
      return { ok: false, errorsKo: ['Output 레이어 내보내기 파일이 아닙니다.'] };
    }
    const notesKo = [];
    const layers = normalizeLayers(raw.layers, notesKo);
    const v = validateLayers(layers);
    return v.ok ? { ok: true, layers, notesKo } : v;
  }

  layersGet() {
    return structuredClone(this.layers);
  }

  /** 레이어 저장 (레이어 스펙 §3). 장치에 쓰지 않는다 */
  layersSave(raw) {
    // 목록이 아니면 거부한다 — normalize가 기본값으로 채워 사용자 레이어를 지워 버리지 않게
    if (!Array.isArray(raw)) return { ok: false, errorsKo: ['레이어 목록이 아니라 저장하지 않았습니다.'] };
    const layers = normalizeLayers(raw);
    const v = validateLayers(layers);
    if (!v.ok) return v;
    try {
      writeJsonAtomic(this._profilesFile(), { version: SOURCE_FILE_VERSION, layers });
    } catch (err) {
      return { ok: false, errorsKo: [`저장하지 못했습니다: ${err.message}`] };
    }
    this.layers = layers;
    this._reevaluateMode();
    this._changed();
    return { ok: true, errorsKo: [] };
  }

  presetsList() {
    return structuredClone([...PRESETS]);
  }

  /** 프리셋 메뉴 '복사해서 새 레이어'. 저장은 레이어 화면에서 한다 */
  presetCopy(presetId) {
    return layerFromPreset(presetId, `l-copy-${this.now()}`);
  }

  /** Orca 앱이 Orca 프리셋 레이어로 가지 않으면 true (레이어 화면 안내용) */
  orcaUnlinked() {
    return ORCA_PRESET.defaultApps.every((a) => resolveLayer(this.layers, a.bundleId)?.mode !== 'orca');
  }
}
