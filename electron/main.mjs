/**
 * Output.app — Electron main (M5 설계 §4).
 *
 * 이 파일은 얇다. 하는 일은:
 *   - 서비스(src/service/outputService.js)를 실제 OS·장치·Orca에 연결해 만든다
 *   - 메뉴바 아이콘과 두 창(상태판 팝오버, 설정)을 띄운다
 *   - IPC로 뷰를 밀어주고 명령을 받는다
 * 정책은 여기 없다. src/ 는 Electron을 모른다.
 */
import {
  app, BrowserWindow, Tray, nativeImage, ipcMain, dialog, powerMonitor, systemPreferences, screen, shell, Menu, Notification,
} from 'electron';
import electronUpdater from 'electron-updater';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { OutputService, RUNTIME_METHODS } from '../src/service/outputService.js';
import { fakeDevicePair } from '../src/device/fakeDevicePair.js';
import { keySynth } from '../src/service/keySynth.js';
import { openHidTransport } from '../src/device/transport/hidTransport.js';
import { WRITE_METHODS } from '../src/keymap/deviceWriter.js';
import { loadCalibration } from '../src/device/calibrationLoader.js';
import { defaultDir } from '../src/adapters/persistence/index.js';
import { writeJsonAtomic } from '../src/adapters/persistence/fileStore.js';
import { createHud } from './hud.mjs';
import { appMenuTemplate } from './appMenu.mjs';
import { appendLog } from '../src/service/logFile.js';
import { smoke } from './smoke.mjs';
import { createUpdater } from './updater.mjs';
import {
  frontmostBundleId, isProcessRunning, synthKeystroke, openSettings,
  openApp, openUrl, execCommand, readClipboard, writeClipboard, moveWindow, hasWindow, screenshot,
  runningApps, installedApps, bundleIdOfApp, deviceUsers,
} from '../src/service/macos.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let hudWin = null;   // 노브·조이스틱 화면 표시 (hud.mjs)
const ROOT = path.resolve(HERE, '..');
const STATE_DIR = defaultDir();
/**
 * 기동 추적. 메뉴바 앱은 화면에 아무것도 없으면 어디서 멈췄는지 알 길이 없어 파일에 남긴다.
 * 작업 이름·경로·대화 내용은 쓰지 않는다 (AGENTS.md 12).
 */
function trace(msg) {
  // 1MB를 넘으면 launch.log.1로 옮긴다 (2026-10-10). 실패해도 앱을 막지 않는다
  appendLog(path.join(STATE_DIR, 'launch.log'), `${new Date().toISOString()} ${msg}`);
}
process.on('uncaughtException', (err) => trace(`uncaughtException: ${err?.stack ?? err}`));
process.on('unhandledRejection', (err) => trace(`unhandledRejection: ${err?.stack ?? err}`));
trace(`launch pid=${process.pid} argv=${process.argv.slice(1).join(' ')}`);
const SMOKE = process.argv.includes('--smoke');
const FAKE_DEVICE = process.argv.includes('--fake-device');
// dev.output.keypad: 2026-10-01부터. dev.output.app은 macOS Control Center가 Orca 소속으로 묶어 버려서 바꿨다 (HANDOFF 함정 8)
const APP_BUNDLE_IDS = ['dev.output.keypad', 'dev.output.app', 'com.github.Electron'];
// 다른 Mac에는 셸용 링크(/opt/homebrew/bin/orca)가 없을 수 있다. CLI 본체는 Orca.app 안에 항상 있다.
const ORCA_CANDIDATES = ['/opt/homebrew/bin/orca', '/usr/local/bin/orca', path.join(os.homedir(), '.local/bin/orca'),
  '/Applications/Orca.app/Contents/Resources/bin/orca'];

// 두 개가 같은 장치와 같은 상태 파일을 다투지 않게 한다.
// 두 번째 실행은 아무것도 하지 않고 끝나고, 첫 번째가 상태판을 연다.
const PRIMARY = SMOKE || app.requestSingleInstanceLock();

let service = null;
let tray = null;
let popover = null;
let settings = null;
let locked = false;
let paused = false;
let updater = null;   // 자동 업데이트 (updater.mjs, 2026-10-11)
let pushTimer = null;

// ───────────── 설정 파일 (설치 마법사 진행 여부)

const setupFile = () => path.join(STATE_DIR, 'setup.json');
function readSetup() {
  try { return JSON.parse(fs.readFileSync(setupFile(), 'utf8')); } catch { return { completed: false }; }
}
function writeSetup(v) {
  writeJsonAtomic(setupFile(), v);
}

function findOrca() {
  return ORCA_CANDIDATES.find((p) => fs.existsSync(p)) ?? 'orca';
}

/** 보정은 사용자 폴더 것을 먼저, 없으면 앱에 들어 있는 것 */
function loadCal() {
  const user = loadCalibration({ root: STATE_DIR, file: 'calibration.json' });
  if (user.calibrated) return user;
  return loadCalibration({ root: ROOT });
}

// ───────────── 서비스

function createService() {
  const cal = loadCal();
  const fake = FAKE_DEVICE ? fakeDevicePair() : null;
  const svc = new OutputService({
    calibration: cal.calibration,
    stateDir: STATE_DIR,
    // 공유 모드로 연다. macOS는 루트가 아니면 키보드 계열 HID의 독점(seize)을 privilege violation으로 막는다
    // (실기 2026-09-27: 입력 모니터링 권한이 있어도 exclusive는 항상 실패해 '권한 없음'으로 보였다).
    // HID 소유자 하나(AGENTS.md 4)는 OS 독점이 아니라 DeviceGuard의 양보 규칙과 쓰기 중 런타임 중단으로 지킨다.
    openRuntimeTransport: fake ? async () => fake.runtime() : async () => openHidTransport({
      exclusive: false, blockedMethods: ['fs.write'], allowedMethods: [...RUNTIME_METHODS],
    }),
    openWriteTransport: fake ? async () => fake.writer()
      : async () => openHidTransport({ exclusive: false, allowedMethods: [...WRITE_METHODS] }),
    fakeDevice: Boolean(fake),
    frontmost: frontmostBundleId,
    synth: synthKeystroke,
    // 누르고 있으면 반복: macOS 반복 지연·간격 (2026-10-09). osascript로 내려간 회차는 서비스가 간격을 늘린다
    keyRepeat: () => keySynth.repeatTiming(),
    deviceUsers,
    orcaRunning: () => isProcessRunning('Orca'),   // Orca 앱이 꺼져 있으면 CLI를 부르지 않는다 (2026-10-11 성능)
    appName: async (bundleId) => (await runningApps()).find((a) => a.bundleId === bundleId)?.name ?? null,
    isLocked: () => locked,
    accessibilityTrusted: () => systemPreferences.isTrustedAccessibilityClient(false),
    orcaBin: findOrca(),
    ownBundleIds: APP_BUNDLE_IDS,
    versions: { app: app.getVersion() },
    // 앱별 키 (2026-10-03): 실행부와 창 위치용 화면 목록
    appExec: { synth: synthKeystroke, openApp, openUrl, execCommand, readClipboard, writeClipboard, moveWindow, hasWindow, screenshot },
    displays: () => {
      const primaryId = screen.getPrimaryDisplay().id;
      return screen.getAllDisplays().map((d) => ({ id: d.id, primary: d.id === primaryId, workArea: d.workArea }));
    },
  });
  svc.calibrationSourceKo = cal.sourceKo;
  svc.on('update', schedulePush);
  // 서비스 로그도 launch.log에 (2026-10-10: 실기 조사용. 명령 내용은 원래 로그에 남기지 않는다)
  svc.on('log', (e) => trace(`log ${e.level}: ${e.messageKo}`));
  // 노브·조이스틱 화면 표시 (2026-10-10). 창은 처음 쓸 때 만든다
  svc.on('hud', (h) => { hudWin ??= createHud({ BrowserWindow, screen, here: HERE }); hudWin.show(h); });
  return svc;
}

function currentView() {
  const v = service.view();
  v.paused = paused;
  v.update = updater?.state ?? null;
  return v;
}

/** 뷰를 창에 밀어준다. 초당 수십 번 바뀌어도 5번만 보낸다 */
function schedulePush() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    if (!service) return;
    const v = currentView();
    updateTray(v);
    // 보이는 창에만 보낸다 (2026-10-11 성능) — 숨은 창은 열릴 때 최신 상태를 한 번 받는다 ('show')
    for (const w of [popover, settings]) {
      if (w && !w.isDestroyed() && w.isVisible()) w.webContents.send('cb:view', v);
    }
  }, 200);
}

// ───────────── 메뉴바

/**
 * 메뉴바 아이콘: 앱 아이콘의 두 화살표를 상태색으로 칠한 것 (2026-10-04, 이전에는 동그란 점).
 * nativeImage는 SVG를 읽지 못하고(빈 이미지), 비트맵 직접 생성도 실기에서 보이지 않았다.
 * PNG 파일(1x 18px + @2x 36px)을 읽는 방식이 가장 확실하다. 파일은 tools/make-tray-icons.py로 만든다.
 */
const TRAY_FILES = Object.freeze({ '#9a968d': 'tray-gray', '#c0392b': 'tray-red', '#3e9b5a': 'tray-green', '#d9a21b': 'tray-amber', '#1f9e96': 'tray-teal' });
/** 메뉴바 아이콘 색: 빨강 개입 > 회색 장치 문제 > 호박 진행 중 > 청록 완료·미확인 > 초록 평온 (2026-10-02) */
const TONE_HEX = Object.freeze({ attention: '#c0392b', problem: '#9a968d', running: '#d9a21b', done: '#1f9e96', calm: '#3e9b5a' });
function trayImage(hex) {
  const name = TRAY_FILES[hex] ?? 'tray-gray';
  return nativeImage.createFromPath(path.join(HERE, 'assets', `${name}.png`));
}

function updateTray(v) {
  if (!tray) return;
  const hex = TONE_HEX[v.menu.tone] ?? TONE_HEX.calm;
  tray.setImage(trayImage(paused ? '#9a968d' : hex));
  tray.setTitle(v.menu.count ? ` ${v.menu.count}` : '');
  tray.setToolTip(`Output — ${v.queueLineKo}`);
}

function createPopover() {
  popover = new BrowserWindow({
    width: 400, height: 600, show: false, frame: false, resizable: false, movable: false,
    fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, transparent: false,
    backgroundColor: '#fbfaf6',
    webPreferences: { preload: path.join(HERE, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  popover.loadFile(path.join(HERE, 'renderer', 'popover.html'));
  popover.on('blur', () => {
    trace(`popover blur ${shownAt ? `+${Date.now() - shownAt}ms` : ''}`);
    if (!SMOKE) popover.hide();
  });
  popover.on('closed', () => { popover = null; });
  // 열리면 최신 상태를 바로 보내고 Orca를 2초마다 확인, 닫히면 느리게 (2026-10-11 성능)
  popover.on('show', () => { service?.setUiVisible(true); if (service) popover.webContents.send('cb:view', currentView()); });
  popover.on('hide', () => { service?.setUiVisible(false); });
}

let shownAt = 0;
function togglePopover() {
  try {
    showOrHidePopover();
  } catch (err) {
    trace(`tray click 실패: ${err?.stack ?? err}`);
  }
}

function showOrHidePopover() {
  // 종료 중에는 창이 이미 파괴되어 있다. 살아 있는데 창만 없어졌으면(렌더러 크래시 등) 다시 만든다.
  if (quitting) return;
  if (!popover || popover.isDestroyed()) createPopover();
  trace(`tray click visible=${popover.isVisible()} focused=${popover.isFocused()}`);
  if (popover.isVisible()) { popover.hide(); return; }
  const tb = tray.getBounds();
  const { width } = popover.getBounds();
  const display = screen.getDisplayNearestPoint({ x: tb.x, y: tb.y });
  const x = Math.min(Math.max(Math.round(tb.x + tb.width / 2 - width / 2), display.workArea.x + 8),
    display.workArea.x + display.workArea.width - width - 8);
  popover.setPosition(x, Math.round(tb.y + tb.height + 4));
  // 메뉴바 전용(LSUIElement) 앱은 창을 띄워도 앞으로 오지 않는다. 다른 앱이 앞이면 창이 key가 못 되어
  // 보이지 않거나 바로 blur로 닫힌다 — 설정 창과 같이 앱을 먼저 앞으로 가져온다 (2026-10-02)
  app.focus({ steal: true });
  shownAt = Date.now();
  popover.show();
  popover.focus();
  setTimeout(() => {
    if (!popover || popover.isDestroyed()) return;
    trace(`popover +300ms visible=${popover.isVisible()} focused=${popover.isFocused()} bounds=${JSON.stringify(popover.getBounds())} tray=${JSON.stringify(tb)}`);
  }, 300);
  schedulePush();
}

function openSettingsWindow(tab = 'about') {
  if (settings && !settings.isDestroyed()) {
    settings.webContents.send('cb:tab', tab);
    settings.show();
    settings.focus();
    return;
  }
  // 레이어 화면이 왼쪽 장치 그림 · 오른쪽 키 설정으로 스크롤 없이 들어가는 크기 (2026-10-09 실측: 1200×880). 화면이 작으면 맞춘다
  const wa = screen.getPrimaryDisplay().workAreaSize;
  settings = new BrowserWindow({
    width: Math.min(1200, wa.width - 40), height: Math.min(880, wa.height - 20), minWidth: 900, minHeight: 640, show: !SMOKE, title: 'Output 설정',
    backgroundColor: '#ebe7df',
    webPreferences: { preload: path.join(HERE, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  settings.loadFile(path.join(HERE, 'renderer', 'settings.html'), { query: { tab } });
  settings.on('closed', () => { settings = null; });
  settings.on('show', () => { if (service) settings.webContents.send('cb:view', currentView()); });   // 숨어 있던 동안 못 받은 상태 (2026-10-11)
  // 레이어 설정을 저장하지 않고 닫으려 하면 묻는다 (2026-10-10)
  settings.webContents.on('will-prevent-unload', (event) => {
    if (SMOKE) { event.preventDefault(); return; }   // 사람 없는 점검에서는 묻지 않는다
    const choice = dialog.showMessageBoxSync(settings, {
      type: 'question', buttons: ['저장하지 않고 닫기', '취소'], defaultId: 1, cancelId: 1,
      message: '저장하지 않은 레이어 변경이 있습니다.', detail: '닫으면 바뀐 내용이 사라집니다. 저장하려면 취소하고 저장을 누르세요.',
    });
    if (choice === 0) event.preventDefault();
  });
  settings.webContents.on('render-process-gone', (_e, d) => trace(`settings renderer gone: ${d?.reason}`));
  settings.on('unresponsive', () => trace('settings window unresponsive'));
}

// ───────────── IPC — 채널 목록은 preload와 같아야 한다

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      return { ok: false, errorKo: String(err?.message ?? err) };
    }
  });
}

function registerIpc() {
  handle('cb:view', () => currentView());
  // 설정 메뉴 (2026-10-10): 노브·조이스틱 화면 표시 켜기·끄기
  handle('cb:prefs:get', () => service.prefsGet());
  handle('cb:prefs:set', (p) => service.prefsSet(p));
  handle('cb:usage:get', () => service.usageToday());
  // 상태판에서 레이어 고르기 (2026-10-11): null = 자동(앞 앱 따라)
  handle('cb:layers:pick', (id) => service.pickLayer(typeof id === 'string' ? id : null));
  handle('cb:resize', (height) => {
    // 팝오버를 내용 높이에 맞춘다. 화면보다 크면 화면에 맞추고 안에서 스크롤한다
    if (!popover) return;
    const max = screen.getPrimaryDisplay().workAreaSize.height - 60;
    popover.setContentSize(400, Math.max(200, Math.min(Math.ceil(height), max)));
  });
  handle('cb:focusSlot', (n) => service.focusSlot(Number(n)));
  handle('cb:openPermission', (which) => {
    // 손쉬운 사용: 지금 이 빌드를 목록에 올리도록 macOS에 묻는다(시스템 대화상자). ad-hoc 서명은 빌드마다 바뀌어
    // 예전 빌드의 켜짐 항목이 이 빌드에는 통하지 않는다 (2026-10-02)
    if (which === 'accessibility') systemPreferences.isTrustedAccessibilityClient(true);
    return openSettings(which === 'accessibility' ? 'accessibility' : 'inputMonitoring');
  });
  handle('cb:openSettings', (tab) => { openSettingsWindow(tab); if (popover?.isVisible()) popover.hide(); });
  // 레이어 내보내기·가져오기 (2026-10-10). 가져오기는 검사만 하고 설정 화면이 저장 안 한 변경으로 보여 준다
  handle('cb:layers:export', async () => {
    const r = await dialog.showSaveDialog(settings ?? undefined, {
      title: '레이어 내보내기', defaultPath: path.join(os.homedir(), 'Desktop', `output-layers-${new Date().toISOString().slice(0, 10)}.json`),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(r.filePath, JSON.stringify(service.layersExport(), null, 2));
    return { ok: true, messageKo: `내보냈습니다: ${path.basename(r.filePath)}` };
  });
  handle('cb:layers:import', async () => {
    const r = await dialog.showOpenDialog(settings ?? undefined, { title: '레이어 가져오기', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
    const p = r.canceled ? null : r.filePaths[0];
    if (!p) return { ok: false, canceled: true };
    try { return service.layersImport(JSON.parse(fs.readFileSync(p, 'utf8'))); } catch { return { ok: false, errorsKo: ['파일을 읽지 못했습니다 (JSON이 아닙니다).'] }; }
  });
  // 상태판: 레이어 없는 앱에 레이어 만들기 → 설정에서 그 레이어를 연다 (2026-10-10)
  handle('cb:layers:forApp', (app) => {
    const r = service.createLayerForApp(String(app?.bundleId ?? ''), String(app?.name ?? ''));
    if (r.ok) { openSettingsWindow(`layers:${r.id}`); if (popover?.isVisible()) popover.hide(); }
    return r;
  });
  // 레이어 (2026-10-03, Orca 키·앱별 키 통합)
  handle('cb:layers:get', () => service.layersGet());
  handle('cb:layers:save', (layers) => service.layersSave(layers));
  handle('cb:apps:running', () => runningApps(APP_BUNDLE_IDS));
  handle('cb:apps:installed', () => installedApps(APP_BUNDLE_IDS));   // 앱 고르기의 '설치된 앱' 묶음 (2026-10-09)
  handle('cb:apps:pick', async () => {
    const r = await dialog.showOpenDialog(settings ?? undefined, {
      defaultPath: '/Applications', properties: ['openFile'], filters: [{ name: '앱', extensions: ['app'] }],
    });
    const p = r.canceled ? null : r.filePaths[0];
    if (!p) return null;
    const bundleId = await bundleIdOfApp(p);
    return bundleId ? { bundleId, name: path.basename(p, '.app') } : { ok: false, errorKo: '앱의 번들 ID를 읽지 못했습니다.' };
  });
  handle('cb:action:try', (action) => service.actionTry(action));   // 지금 실행해 보기 (2026-10-10: 모든 동작)
  handle('cb:presets:list', () => service.presetsList());
  handle('cb:presets:copy', (id) => service.presetCopy(String(id ?? '')));
  handle('cb:layers:orcaUnlinked', () => service.orcaUnlinked());
  handle('cb:device:status', () => service.deviceStatus());
  handle('cb:device:plan', () => service.devicePlan());
  handle('cb:device:apply', () => service.deviceApply());
  handle('cb:diagnostics:export', async () => {
    const r = await dialog.showSaveDialog(settings ?? undefined, {
      title: '진단 내보내기', defaultPath: path.join(os.homedir(), 'Desktop', `output-diagnostics-${Date.now()}.json`),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, messageKo: '취소했습니다.' };
    fs.writeFileSync(r.filePath, JSON.stringify(service.diagnostics(), null, 2));
    return { ok: true, messageKo: `저장했습니다: ${path.basename(r.filePath)}` };
  });
  handle('cb:autostart:get', () => ({ openAtLogin: app.getLoginItemSettings().openAtLogin }));
  handle('cb:autostart:set', (on) => {
    // 사용자가 토글할 때만 등록한다. 몰래 등록하지 않는다 (P02)
    app.setLoginItemSettings({ openAtLogin: Boolean(on) });
    return { openAtLogin: app.getLoginItemSettings().openAtLogin };
  });
  handle('cb:setup:get', () => ({
    ...readSetup(),
    stateDir: STATE_DIR,
    calibrationKo: service.calibrationSourceKo,
    calibrated: Boolean(service.calibration.calibrated),
    accessibility: systemPreferences.isTrustedAccessibilityClient(false),
  }));
  handle('cb:setup:complete', () => { writeSetup({ completed: true, at: new Date().toISOString() }); return { ok: true }; });
  handle('cb:pause', async (on) => {
    paused = Boolean(on);
    if (paused) service.suspend(); else await service.resume();
    schedulePush();
    return { paused };
  });
  handle('cb:logs', () => service.logs.slice(-100));
  handle('cb:info', () => ({ versions: service.versions, stateDir: STATE_DIR }));
  // 점검하기 (2026-10-12): 권한·장치·LED 테스트·Orca·레이어·환경. 작업 이름·경로는 넣지 않는다
  handle('cb:check:run', () => service.selfCheck({
    accessibility: service.accessibilityTrusted(), arch: process.arch, osKo: `macOS ${process.getSystemVersion()}`,
    appVersion: app.getVersion(), orcaBin: service.orcaBin,
  }));
  handle('cb:quit', () => { app.quit(); });
  handle('cb:update:install', () => updater?.install() ?? false);
  handle('cb:openStateDir', () => shell.openPath(STATE_DIR));
}

// ───────────── 수명

async function main() {
  trace('main: whenReady 대기');
  await app.whenReady();
  trace('main: ready');
  if (process.platform === 'darwin' && app.dock) app.dock.hide();
  // ⌘Q는 창만 닫고 메뉴바에 남는다 (2026-10-10 사용자 요청). 설정 창은 닫기와 같은 길 — 저장 안 한 변경이면 묻는다
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate({
    onCloseWindows: () => {
      if (settings && !settings.isDestroyed()) settings.close();
      if (popover?.isVisible()) popover.hide();
    },
    onQuit: () => app.quit(),
  })));
  registerIpc();
  service = createService();
  trace('main: service 생성됨');

  tray = new Tray(trayImage('#9a968d'));
  tray.on('click', togglePopover);
  trace(`main: tray 생성됨 bounds=${JSON.stringify(tray.getBounds())}`);
  for (const ms of [3000, 10000]) {
    setTimeout(() => trace(`tray +${ms / 1000}s bounds=${JSON.stringify(tray?.isDestroyed?.() ? null : tray?.getBounds())}`
      + ` device=${service?.guard?.state ?? '?'}${service?.guard?.messageKo ? ` (${service.guard.messageKo})` : ''} layer=${service?.deviceInfo?.layerName ?? '?'}`), ms);
  }
  createPopover();
  trace('main: popover 생성됨');

  powerMonitor.on('suspend', () => service.suspend());
  powerMonitor.on('resume', () => { if (!paused) service.resume(); });
  powerMonitor.on('lock-screen', () => { locked = true; });
  powerMonitor.on('unlock-screen', () => { locked = false; });

  trace('main: service.start 대기');
  await service.start();
  trace('main: service 시작됨');
  schedulePush();

  // 자동 업데이트: 받아 두고 알림 → 상태판 버튼으로 설치 (2026-10-11). 점검(smoke)·개발 실행에서는 끈다
  updater = createUpdater({
    autoUpdater: electronUpdater.autoUpdater, isPackaged: app.isPackaged && !SMOKE,
    onChange: (s) => { trace(`update ${s.state}${s.version ? ` ${s.version}` : ''}`); schedulePush(); },
    notify: ({ title, body }) => {
      if (!Notification.isSupported()) return;
      const n = new Notification({ title, body });
      n.on('click', () => { if (!popover?.isVisible()) togglePopover(); });
      n.show();
    },
    log: trace,
  });
  updater.start();

  const setup = readSetup();
  trace(`main: setup completed=${Boolean(setup.completed)}`);
  if (!setup.completed && !SMOKE) {
    openSettingsWindow('about');
    // 메뉴바 전용(LSUIElement) 앱의 새 창은 앱을 앞으로 가져오지 않는다. 처음 사용자는 창을 봐야 한다.
    app.focus({ steal: true });
    settings?.focus();
    trace(`main: 설정 창 열림 visible=${settings?.isVisible?.()}`);
  }
  if (SMOKE) {
    // 창·서비스는 도중에 바뀌므로 게터로 넘긴다
    await smoke({
      get settings() { return settings; }, get popover() { return popover; }, get tray() { return tray; },
      get service() { return service; }, get hudWin() { return hudWin; },
      currentView, openSettingsWindow, trayImage,
    });
  }
}

let quitting = false;
app.on('before-quit', (e) => {
  if (quitting || !service) return;
  // 서비스 정리가 끝날 때까지 프로세스가 살아 있으므로, 그 사이 다시 실행한 새 인스턴스가 막히지 않게 잠금을 먼저 푼다.
  app.releaseSingleInstanceLock();
  e.preventDefault();
  quitting = true;
  trace('before-quit: service.stop 시작');
  // 정리가 어디서든 막히면 프로세스가 좀비로 남아 재실행이 "먹통"처럼 보인다 (실기 2026-09-27). 3초 뒤엔 무조건 끝낸다.
  const hardExit = setTimeout(() => { trace('종료 3초 초과 — app.exit'); app.exit(0); }, 3000);
  service.stop()
    .catch((err) => trace(`service.stop 실패: ${err?.message ?? err}`))
    .finally(() => {
      // 정리는 끝났다. 두 번째 app.quit()은 macOS에서 진행되지 않는 경우가 있어(실측) 바로 끝낸다.
      trace('service.stop 끝 → app.exit');
      app.exit(0);
    });
  hardExit.unref?.();
});
app.on('will-quit', () => trace('will-quit'));
app.on('quit', (_e, code) => trace(`quit code=${code}`));
app.on('window-all-closed', () => { /* 메뉴바 앱 — 창을 닫아도 계속 돈다 */ });

/**
 * --smoke: 창을 띄우고 렌더러가 뷰를 그렸는지 확인한 뒤 종료한다.
 * 실장치·실 Orca에 붙는다. 장치 쓰기는 하지 않는다.
 */

if (!PRIMARY) {
  trace('second instance — 종료');
  app.exit(0);
} else {
  // 앱을 한 번 더 실행하면(이미 떠 있으면 LaunchServices가 activate를 보낸다) 설정 창을 연다.
  // macOS 26에서 메뉴바 항목이 숨겨져도 들어올 길이 있어야 한다.
  // Output 창(설정·상태판)을 누르면 반복 키를 멈춘다 — 앞 앱 감시는 자기 창을 무시하므로 따로 알린다 (2026-10-09)
  app.on('browser-window-focus', () => { if (!quitting) service?.ownWindowFocused(); });
  app.on('activate', () => {
    if (quitting || !service) return;
    trace('activate → 설정 창');
    openSettingsWindow('about');
    app.focus({ steal: true });
  });
  app.on('second-instance', () => {
    if (quitting) return;
    trace('second-instance → 설정 창');
    openSettingsWindow('about');
  });
  main().catch((err) => {
    trace(`main 실패: ${err?.stack ?? err}`);
    console.error(err);
    app.exit(1);
  });
}
