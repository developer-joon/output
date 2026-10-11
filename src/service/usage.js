import fs from 'node:fs';

import { writeJsonAtomic } from '../adapters/persistence/fileStore.js';

/**
 * 키별 사용 횟수 (2026-10-10 사용자 요청): 레이어·칸마다 오늘 누른 횟수. 날이 바뀌면 0부터.
 * 파일(usage.json)은 잠깐 모았다가 쓴다 — 누를 때마다 쓰지 않는다.
 */
const dayOf = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };

export class Usage {
  constructor({ file, now = Date.now, flushMs = 3000 }) {
    this.file = file; this.now = now; this.flushMs = flushMs; this._timer = null;
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 처음 */ }
    this.counts = raw?.day === dayOf(now()) && raw.counts && typeof raw.counts === 'object' ? raw.counts : {};
    this.day = dayOf(now());
  }

  _roll() {
    const d = dayOf(this.now());
    if (d !== this.day) { this.day = d; this.counts = {}; }
  }

  add(layerId, slotId) {
    if (!layerId || !slotId) return;
    this._roll();
    const l = (this.counts[layerId] ??= {});
    l[slotId] = (l[slotId] ?? 0) + 1;
    if (this.flushMs > 0 && !this._timer) { this._timer = setTimeout(() => this.flush(), this.flushMs); this._timer.unref?.(); }
  }

  today() {
    this._roll();
    return structuredClone(this.counts);
  }

  flush() {
    clearTimeout(this._timer); this._timer = null;
    try { writeJsonAtomic(this.file, { day: this.day, counts: this.counts }); } catch { /* 다음에 */ }
  }
}
