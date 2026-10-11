import { parseKeystroke } from '../service/profiles.js';
import { rectFor, pickDisplay } from './windowLayout.js';
import { actionLabel } from './actionLabel.js';

/**
 * 앱별 키 동작 실행 (스펙 §2). 실행 수단은 전부 주입받는다 — 테스트는 가짜로 돈다.
 * 실제 조작 직후에만, 잠금 중에는 안 하고, 키 입력 동작은 앞 앱을 다시 본다.
 */
const KEY_TYPES = new Set(['shortcut', 'sequence', 'insertText']);
const PASTE = Object.freeze({ key: 'v', modifiers: ['command'] });
const WINDOW_WAIT_MS = 5000;
const WINDOW_POLL_MS = 250;
const MACRO_MIN_GAP_MS = 100;

export class ActionRunner {
  constructor({ exec, frontmost, displays, isLocked = () => false, ownBundleIds = [], orcaBundleIds = [],
    now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {}, windowMs = 1000 }) {
    Object.assign(this, { exec, frontmost, displays, isLocked, now, sleep, log, windowMs });
    this.own = new Set(ownBundleIds);
    this.orca = new Set(orcaBundleIds);
    this._press = new Map();
    this._busy = new Set();
    this._lastDialAt = -Infinity;          // 노브 칸은 80ms에 한 번 (빠른 회전에 쌓이지 않게)
    this._clipLock = Promise.resolve();   // 클립보드는 모든 칸이 같이 쓴다 — 글자 입력은 한 번에 하나
  }

  notePhysical(slotId) { this._press.set(slotId, this.now()); }

  async run(slotId, action, ctx, { manual = false } = {}) {
    const fail = (reasonKo) => ({ ok: false, reasonKo });
    if (manual) {
      // 설정 화면의 '지금 실행해 보기' (2026-10-10): Orca 동작 말고는 모두. 키 입력은 아래 앞 앱 확인(Output 창 제외)을 거친다
      if (!action || action.type === 'builtin') return fail('설정 화면에서는 실행할 수 없는 동작입니다.');
    } else {
      const at = this._press.get(slotId);
      this._press.delete(slotId);
      if (at === undefined || this.now() - at > this.windowMs) return fail('실제 키 조작 없이 온 요청이라 실행하지 않았습니다.');
    }
    if (!action || action.type === 'none') return fail('배정된 동작이 없습니다.');
    if (action.type === 'builtin') return fail('내장 동작은 Output이 실행합니다.');
    if ((slotId === 'dial_cw' || slotId === 'dial_ccw') && KEY_TYPES.has(action.type)) {   // 키 입력만 — 쌓이면 늦게 몰려 들어간다
      if (this.now() - this._lastDialAt < 80) return fail('노브를 너무 빨리 돌려 건너뛰었습니다.');
      this._lastDialAt = this.now();
    }
    if (this.isLocked()) return fail('화면 잠금 상태에서는 실행하지 않습니다.');
    if (this._busy.has(slotId)) return fail('이전 실행이 아직 끝나지 않았습니다.');
    this._busy.add(slotId);              // 첫 await 전에 건다 — 앞 앱 확인 중의 연타도 막는다
    try {
      if (KEY_TYPES.has(action.type) && !(await this._frontOk(ctx))) return fail('앞 앱이 바뀌어 키 입력을 보내지 않았습니다.');
      const r = await this._do(action, ctx);
      this.log(`${actionLabel(action)}: ${r.ok ? '실행' : r.reasonKo}`);
      return r;
    } catch (err) {
      this.log(`${actionLabel(action)}: 실패`);
      return fail(err?.code === 'AUTOMATION' ? '자동화 권한이 없어 실행하지 못했습니다. 시스템 설정 → 개인정보 보호 및 보안 → 자동화에서 Output 아래 System Events를 켜세요.'
        : err?.code === 'ACCESSIBILITY' ? '손쉬운 사용 권한이 없어 실행하지 못했습니다.'
        : err?.code === 'NO_DISPLAY' ? '화면 정보를 읽지 못해 창을 옮기지 못했습니다.' : '실행하지 못했습니다.');
    } finally {
      this._busy.delete(slotId);
    }
  }

  async _frontOk(ctx) {
    let front;
    try { front = await this.frontmost(); } catch { return false; }
    if (this.own.has(front)) return false;
    if (ctx.kind === 'any') return true;   // 시험 실행: Output 창만 아니면 어느 앱이든
    return ctx.kind === 'app' ? front === ctx.bundleId : !this.orca.has(front);
  }

  _rect(position, display) {
    const wa = pickDisplay(this.displays() ?? [], display);
    if (!wa) { const e = new Error('no display'); e.code = 'NO_DISPLAY'; throw e; }
    return rectFor(position, wa);
  }

  /** 글자 입력: 클립보드를 잠시 바꿔 ⌘V. 모든 칸이 하나의 잠금을 거친다 (원래 클립보드를 잃지 않게) */
  _insertText(text) {
    const run = this._clipLock.then(async () => {
      const prev = await this.exec.readClipboard();
      const w = await this.exec.writeClipboard(text);
      if (w?.code) return { ok: false, reasonKo: '클립보드에 쓰지 못해 붙여 넣지 않았습니다.' };
      await this.exec.synth(PASTE);
      await this.sleep(500);
      let restored;
      try { restored = await this.exec.writeClipboard(prev); } catch { restored = { code: 1 }; }
      if (restored?.code) this.log('클립보드를 되돌리지 못했습니다.');
      return { ok: true, reasonKo: '' };
    });
    this._clipLock = run.catch(() => {});
    return run;
  }

  async _do(a, ctx) {
    const ok = { ok: true, reasonKo: '' };
    switch (a.type) {
      case 'shortcut': await this.exec.synth(parseKeystroke(a.keystroke)); return ok;
      case 'sequence':
        for (const [i, s] of a.steps.entries()) {
          // 단계마다 앞 앱을 다시 본다 — 도중에 앱을 바꾸면 남은 키(Enter 등)를 엉뚱한 곳에 보내지 않는다
          if (i > 0 && !(await this._frontOk(ctx))) return { ok: false, reasonKo: `앞 앱이 바뀌어 ${i + 1}단계부터 보내지 않았습니다.` };
          await this.exec.synth(parseKeystroke(s.keystroke));
          // 단계 사이는 최소 100ms — osascript 시절(단계마다 ~0.15초)의 틈에 기대던 매크로가 빠른 키 입력으로 깨지지 않게 (2026-10-09)
          if (i < a.steps.length - 1) await this.sleep(Math.max(s.delayMs, MACRO_MIN_GAP_MS));
          else if (s.delayMs) await this.sleep(s.delayMs);
        }
        return ok;
      case 'insertText': return this._insertText(a.text);
      case 'openApp': return (await this.exec.openApp(a.bundleId))?.code ? { ok: false, reasonKo: '앱을 열지 못했습니다.' } : ok;
      // 화면 캡처 (2026-10-10): 키 입력이 아니라 앞 앱 확인 없이. 결과(실패 이유 포함)를 그대로
      case 'screenshot': return this.exec.screenshot(a);
      case 'openUrl': return (await this.exec.openUrl(a.url))?.code ? { ok: false, reasonKo: '주소를 열지 못했습니다.' } : ok;
      case 'exec': {
        const r = await this.exec.execCommand(a.command);
        if (r.timedOut) return { ok: false, reasonKo: '명령이 30초 안에 끝나지 않아 멈췄습니다.' };
        return r.code === 0 ? ok : { ok: false, reasonKo: `명령이 실패했습니다 (종료 코드 ${r.code}).` };
      }
      case 'moveWindow': {
        // 앞 창이 Output 자신(상태판·설정)이면 옮기지 않는다 (스펙 §2 '우리 창 제외')
        let front = null;
        try { front = await this.frontmost(); } catch { /* 모르면 아래에서 실패 */ }
        if (!front || this.own.has(front)) return { ok: false, reasonKo: '앞 창이 Output 창이라 옮기지 않았습니다.' };
        return this.exec.moveWindow(null, this._rect(a.position, a.display));
      }
      case 'layout': {
        const missed = [];
        for (const it of a.items) {
          await this.exec.openApp(it.bundleId);
          let found = await this.exec.hasWindow(it.bundleId);
          for (let waited = 0; !found && waited < WINDOW_WAIT_MS; waited += WINDOW_POLL_MS) {
            await this.sleep(WINDOW_POLL_MS);
            found = await this.exec.hasWindow(it.bundleId);
          }
          if (!found) { missed.push(it.appName || it.bundleId); continue; }
          const r = await this.exec.moveWindow(it.bundleId, this._rect(it.position, it.display));
          if (!r.ok) missed.push(it.appName || it.bundleId);
        }
        const last = a.items[a.items.length - 1];
        if (last) await this.exec.openApp(last.bundleId);     // 마지막 앱을 앞으로
        return missed.length ? { ok: false, reasonKo: `창을 옮기지 못한 앱: ${missed.join(', ')}` } : ok;
      }
      default: return { ok: false, reasonKo: '모르는 동작입니다.' };
    }
  }
}
