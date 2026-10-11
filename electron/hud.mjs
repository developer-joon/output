import path from 'node:path';

/**
 * 노브·조이스틱 화면 표시 창 (2026-10-10 사용자 요청: 밝기 조절 표시처럼).
 * 틀 없음 · 투명 · 클릭이 통과 · 포커스를 가져가지 않음 — 앞 앱 판단과 키 입력에 끼어들지 않는다.
 * 마우스가 있는 화면의 아래 가운데. 전체 화면 앱 위·모든 데스크탑에서 보인다.
 */
const SIZE = Object.freeze({ joystick: [240, 290], dial: [320, 84], picker: [300, 420] });
const SEND_MS = 33;             // 화면 갱신은 1초에 30번까지 (최신 것만)
// 조이스틱: 새 위치가 2.5초 안 오면 내린다 (2026-10-10: 가운데 신호가 빠져도 오래 남지 않게)
const LINGER = Object.freeze({ dial: 1200, end: 700, joystick: 2500, picker: 6000 });

export function createHud({ BrowserWindow, screen, here }) {
  let win = null;
  let kind = null;
  let hideTimer = null;
  let sendTimer = null;
  let latest = null;

  const ensure = () => {
    if (win && !win.isDestroyed()) return win;
    win = new BrowserWindow({
      width: SIZE.joystick[0], height: SIZE.joystick[1], show: false, frame: false, transparent: true, resizable: false,
      movable: false, focusable: false, skipTaskbar: true, hasShadow: false, alwaysOnTop: true, fullscreenable: false,
      backgroundColor: '#00000000',
      webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, sandbox: true },
    });
    win.setIgnoreMouseEvents(true);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.loadFile(path.join(here, 'renderer', 'hud.html'));
    win.on('closed', () => { win = null; });
    return win;
  };

  const place = (k) => {
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const [w, h] = SIZE[k];
    const wa = d.workArea;
    win.setBounds({ x: Math.round(wa.x + (wa.width - w) / 2), y: Math.round(wa.y + wa.height - h - 72), width: w, height: h });
  };

  const flush = () => {
    sendTimer = null;
    if (latest && win && !win.isDestroyed()) win.webContents.send('cb:hud', latest);
  };

  function show(hud) {
    ensure();
    if (!win.isVisible() || kind !== hud.kind) { kind = hud.kind; place(hud.kind); }
    if (!win.isVisible()) win.showInactive();
    latest = hud;
    sendTimer ??= setTimeout(flush, win.webContents.isLoading() ? 150 : SEND_MS);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      win?.webContents.send('cb:hud', { fade: true });
      hideTimer = setTimeout(() => win?.hide(), 260);
    }, hud.end ? (hud.kind === 'picker' ? 150 : LINGER.end) : (LINGER[hud.kind] ?? LINGER.joystick));
  }

  return { show, close: () => win?.destroy(), window: () => win };
}
