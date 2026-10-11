import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { KEY_CODES, MEDIA_KEYS } from './keyCodes.js';
import { keySynth } from './keySynth.js';

/**
 * macOS 연결부. 얇게 유지한다 — 정책은 여기 없다.
 *
 * - 앞 앱: `lsappinfo` (권한 불필요)
 * - 프로세스 감지: `pgrep -x`
 * - 키 합성: 네이티브 모듈(keysynth, CGEvent)이 먼저, 안 되면 `osascript` System Events (둘 다 손쉬운 사용 권한 필요)
 * - 설정 화면: `x-apple.systempreferences:` URL
 * - 앱별 키: `open`(앱·URL), `/bin/zsh -lc`(사용자가 등록한 명령), `pbcopy`/`pbpaste`, System Events 창 위치
 *
 * 명령 인자는 배열로 넘긴다. 셸 문자열을 조립하지 않는다.
 */
const run = (cmd, args, timeout = 3000, { maxBuffer } = {}) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, encoding: 'utf8', ...(maxBuffer ? { maxBuffer } : {}) }, (err, stdout, stderr) => {
    resolve({ code: err ? (err.code ?? 1) : 0, killed: Boolean(err?.killed), stdout: stdout ?? '', stderr: stderr ?? '' });
  });
});

/** 표준 입력으로 글자를 넘기는 실행 (pbcopy). 결과 형식은 run과 같다 */
const runWithInput = (cmd, args, input, timeout = 3000) => new Promise((resolve) => {
  const child = execFile(cmd, args, { timeout, encoding: 'utf8' }, (err, stdout, stderr) => {
    resolve({ code: err ? (err.code ?? 1) : 0, stdout: stdout ?? '', stderr: stderr ?? '' });
  });
  child.stdin.end(input);
});

export const SETTINGS_URLS = Object.freeze({
  inputMonitoring: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
});

export function parseBundleId(text) {
  return /"CFBundleIdentifier"="([^"]+)"/.exec(text ?? '')?.[1] ?? null;
}

export async function frontmostBundleId() {
  const front = await run('lsappinfo', ['front']);
  const asn = front.stdout.trim();
  if (!asn) throw new Error('앞 앱을 찾지 못했습니다.');
  const info = await run('lsappinfo', ['info', '-only', 'bundleid', asn]);
  const id = parseBundleId(info.stdout);
  if (!id) throw new Error('앞 앱의 번들 ID를 읽지 못했습니다.');
  return id;
}

export async function isProcessRunning(name) {
  const r = await run('pgrep', ['-x', name]);
  return r.code === 0;
}

export function keystrokeScript({ key, modifiers = [] }) {
  const using = modifiers.length ? ` using {${modifiers.map((m) => `${m} down`).join(', ')}}` : '';
  if (key.length === 1) {
    return `tell application "System Events" to keystroke "${escapeAppleScript(key)}"${using}`;
  }
  const code = KEY_CODES[key];
  if (code === undefined) throw new Error(`지원하지 않는 키입니다: ${key}`);
  return `tell application "System Events" to key code ${code}${using}`;
}

/** osascript 오류 → 권한 종류. 자동화(-1743, System Events 제어)와 손쉬운 사용은 다른 권한이다 */
export function classifyOsascriptError(stderr) {
  const s = stderr ?? '';
  if (/-1743|Apple 이벤트를 보낼 권한|not authorized to send apple events/i.test(s)) return 'AUTOMATION';
  return /not allowed assistive access|-1719|-25211|not allowed to send keystrokes/i.test(s)
    ? 'ACCESSIBILITY' : 'OTHER';
}

/** 키 하나 입력: 네이티브(즉시)가 먼저, 안 되면 osascript (2026-10-09). 실제로 간 길을 돌려준다 ('native' | 'osascript') */
/** 미디어 키를 JavaScript(JXA)로: NSSystemDefined(14) 이벤트, subtype 8, 누름(0xa)·뗌(0xb) (2026-10-10) */
export function mediaKeyScript(nx) {
  return `ObjC.import('AppKit');
function post(down) {
  const e = $.NSEvent.otherEventWithTypeLocationModifierFlagsTimestampWindowNumberContextSubtypeData1Data2(
    14, $.NSMakePoint(0, 0), down ? 0xa00 : 0xb00, 0, 0, null, 8, (${Number(nx)} << 16) | ((down ? 0xa : 0xb) << 8), -1);
  $.CGEventPost(0, e.CGEvent);
}
post(true); post(false);`;
}

export async function synthKeystroke(ks, { ksynth = keySynth, runner = run } = {}) {
  if (ksynth.keystroke(ks).ok) return 'native';
  const media = Object.hasOwn(MEDIA_KEYS, ks.key);
  const r = await runner('osascript', media ? ['-l', 'JavaScript', '-e', mediaKeyScript(MEDIA_KEYS[ks.key])] : ['-e', keystrokeScript(ks)]);
  if (r.code !== 0) {
    const e = new Error(r.stderr.trim() || '키 입력을 보내지 못했습니다.');
    e.code = classifyOsascriptError(r.stderr);
    throw e;
  }
  return 'osascript';
}

export async function openSettings(which) {
  const url = SETTINGS_URLS[which];
  if (!url) return false;
  const r = await run('open', [url]);
  return r.code === 0;
}

// ───────────── 앱별 키 실행부 (2026-10-03)

export const AUTOMATION_KO = '자동화 권한이 없어 창을 옮기지 못했습니다. 시스템 설정 → 개인정보 보호 및 보안 → 자동화에서 Output 아래 System Events를 켜세요.';

export function escapeAppleScript(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * 화면 캡처 (2026-10-10): 특정 모니터만. screencapture -D n (1 = 주 모니터).
 * 파일 이름은 '스크린샷 날짜 시각 (모니터 n).png'. 둘 다면 파일 한 번 + 클립보드 한 번 찍는다.
 */
export function screenshotArgs({ display, save }, dir, at = new Date()) {
  const n = display === 'main' ? 1 : Number(display);
  const p2 = (v) => String(v).padStart(2, '0');
  const stamp = `${at.getFullYear()}-${p2(at.getMonth() + 1)}-${p2(at.getDate())} ${p2(at.getHours())}.${p2(at.getMinutes())}.${p2(at.getSeconds())}`;
  const file = ['-D', String(n), `${dir}/스크린샷 ${stamp} (${n === 1 ? '주 모니터' : `모니터 ${n}`}).png`];
  const clip = ['-c', '-D', String(n)];
  return save === 'clipboard' ? [clip] : save === 'both' ? [file, clip] : [file];
}

export async function screenshot(a, { runner = run, home = os.homedir(), now = () => new Date() } = {}) {
  let dir = path.join(home, 'Desktop');
  if (a.save !== 'clipboard') {
    // macOS 스크린샷 저장 위치를 따른다 (스크린샷 앱 → 옵션). 없으면 데스크탑
    const r = await runner('defaults', ['read', 'com.apple.screencapture', 'location']);
    const loc = r.code === 0 ? r.stdout.trim() : '';
    if (loc) dir = loc.replace(/^~(?=\/|$)/, home);
  }
  for (const args of screenshotArgs(a, dir, now())) {
    const r = await runner('screencapture', args, 10000);
    if (r.code !== 0) {
      if (/invalid display/i.test(r.stderr)) return { ok: false, reasonKo: `모니터 ${a.display === 'main' ? 1 : a.display}가 연결되어 있지 않습니다.` };
      return { ok: false, reasonKo: '화면을 캡처하지 못했습니다. 시스템 설정 → 개인정보 보호 및 보안 → 화면 및 시스템 오디오 녹음에서 Output을 켜세요.' };
    }
  }
  return { ok: true, reasonKo: '' };
}

export const openAppArgs = (bundleId) => ['-b', bundleId];
export async function openApp(bundleId) { return run('open', openAppArgs(bundleId)); }
export async function openUrl(url) { return run('open', [url]); }
/** 사용자가 설정에 등록한 명령만 부른다. 출력은 버린다 */
export async function execCommand(command, timeoutMs = 30000) {
  const r = await run('/bin/zsh', ['-lc', command], timeoutMs);
  return { code: r.code, timedOut: r.killed };
}
export async function readClipboard() { return (await run('pbpaste', [])).stdout; }
export async function writeClipboard(text) { return runWithInput('pbcopy', [], text); }

export function windowMoveScript(bundleId, { x, y, width, height }) {
  const proc = bundleId
    ? `first application process whose bundle identifier is "${escapeAppleScript(bundleId)}"`
    : 'first application process whose frontmost is true';
  return `tell application "System Events" to tell (${proc})
  set position of window 1 to {${x}, ${y}}
  set size of window 1 to {${width}, ${height}}
end tell`;
}
export async function moveWindow(bundleId, rect) {
  const r = await run('osascript', ['-e', windowMoveScript(bundleId, rect)]);
  if (r.code === 0) return { ok: true, reasonKo: '' };
  const kind = classifyOsascriptError(r.stderr);
  return {
    ok: false,
    reasonKo: kind === 'AUTOMATION' ? AUTOMATION_KO : kind === 'ACCESSIBILITY' ? '손쉬운 사용 권한이 없어 창을 옮기지 못했습니다.' : '창을 찾지 못했습니다.',
  };
}
export async function hasWindow(bundleId) {
  const s = `tell application "System Events" to count windows of (first application process whose bundle identifier is "${escapeAppleScript(bundleId)}")`;
  const r = await run('osascript', ['-e', s]);
  if (r.code !== 0) {
    // 권한 문제는 '창 없음'과 다르다 — 기다려도 소용없으니 바로 알린다
    const kind = classifyOsascriptError(r.stderr);
    if (kind !== 'OTHER') { const e = new Error(r.stderr.trim()); e.code = kind; throw e; }
    return false;
  }
  return Number(r.stdout.trim()) > 0;
}

/** `lsappinfo list` → 일반 앱(Foreground)만 {bundleId, name}, 이름순. 설정 화면의 앱 고르기용 */
export function parseRunningApps(text, excludeBundleIds = []) {
  const out = [];
  const skip = new Set(excludeBundleIds);
  for (const block of String(text ?? '').split(/\n(?=\s*\d+\) ")/)) {
    const name = /^\s*\d+\) "([^"]+)"/.exec(block)?.[1];
    const bundleId = /bundleID="([^"]+)"/.exec(block)?.[1];
    if (!name || !bundleId || skip.has(bundleId) || !/type="Foreground"/.test(block)) continue;
    out.push({ bundleId, name });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function runningApps(excludeBundleIds = []) {
  return parseRunningApps((await run('lsappinfo', ['list'])).stdout, excludeBundleIds);
}

/**
 * 설치된 앱 (2026-10-09): mdfind가 준 .app 경로 + mdls의 번들 ID·표시 이름 → {bundleId, name}, 이름순.
 * 다른 앱 안에 든 도우미 앱(…/X.app/…/Y.app)은 뺀다. mdls는 그 경로들에 대해 한 번에 부른 결과다.
 */
export function parseInstalledApps(paths, mdlsText) {
  const top = (paths ?? []).filter((p) => p.endsWith('.app') && !/\.app\//.test(p));
  const ids = [...String(mdlsText ?? '').matchAll(/kMDItemCFBundleIdentifier\s*=\s*(?:"([^"]*)"|\(null\))/g)].map((m) => m[1] ?? null);
  const names = [...String(mdlsText ?? '').matchAll(/kMDItemDisplayName\s*=\s*(?:"([^"]*)"|\(null\))/g)].map((m) => m[1] ?? null);
  const out = [];
  top.forEach((p, i) => {
    const bundleId = ids[i];
    if (!bundleId || out.some((a) => a.bundleId === bundleId)) return;
    out.push({ bundleId, name: (names[i] || p.split('/').pop()).replace(/\.app$/, '') });
  });
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function installedAppPaths(home = process.env.HOME ?? '') {
  return ['/Applications', '/System/Applications', `${home}/Applications`];
}

/** 설치된 앱 목록. 실패하면 빈 목록 (앱 고르기는 실행 중·최근 목록과 '응용 프로그램에서…'로 계속 된다) */
export async function installedApps(excludeBundleIds = []) {
  const dirs = installedAppPaths().flatMap((d) => ['-onlyin', d]);
  const found = await run('mdfind', [...dirs, "kMDItemContentType == 'com.apple.application-bundle'"], 5000);
  const paths = found.stdout.split('\n').map((x) => x.trim()).filter((p) => p.endsWith('.app') && !/\.app\//.test(p));
  if (!paths.length) return [];
  const meta = await run('mdls', ['-name', 'kMDItemCFBundleIdentifier', '-name', 'kMDItemDisplayName', ...paths], 10000);
  const skip = new Set(excludeBundleIds);
  return parseInstalledApps(paths, meta.stdout).filter((a) => !skip.has(a.bundleId));
}

/**
 * ioreg 출력에서 Creator Micro를 연 프로세스 이름 (2026-10-10). WindowServer와 나(selfPid)는 뺀다.
 * 'Product = Creator Micro' 줄 뒤에 나오는 IOUserClientCreator를 다른 Product 줄이 나올 때까지 모은다.
 */
export function parseDeviceUsers(text, selfPid = process.pid) {
  const out = [];
  let inside = false;
  for (const line of String(text ?? '').split('\n')) {
    const product = /"Product" = "([^"]*)"/.exec(line);
    if (product) inside = /Creator Micro/.test(product[1]);
    const m = inside && /"IOUserClientCreator" = "pid (\d+), ([^"]+)"/.exec(line);
    if (!m || Number(m[1]) === selfPid || m[2] === 'WindowServer' || out.includes(m[2])) continue;
    out.push(m[2]);
  }
  return out;
}

/** ioreg 출력은 1MB를 넘는다(실측 1.1MB) — 기본 한도(1MB)에 잘려 이름을 못 찾았다 (2026-10-10) */
export async function deviceUsers(selfPid = process.pid, runner = run) {
  const r = await runner('ioreg', ['-r', '-c', 'IOHIDDevice', '-l', '-w0'], 5000, { maxBuffer: 32 * 1024 * 1024 });
  return parseDeviceUsers(r.stdout, selfPid);
}

/** .app 경로 → 번들 ID (Spotlight 메타데이터). 못 읽으면 null */
export async function bundleIdOfApp(appPath) {
  const r = await run('mdls', ['-name', 'kMDItemCFBundleIdentifier', '-raw', appPath]);
  const id = r.stdout.trim();
  return r.code === 0 && id && id !== '(null)' ? id : null;
}
