/**
 * 자동 업데이트 (2026-10-11 사용자 결정: 알림 후, 사용자가 누르면 업데이트).
 * GitHub Releases(package.json build.publish)에서 새 버전을 뒤에서 받아 둔다. 준비되면 알림 한 번 + 상태판 버튼.
 * 누르면 바꿔 끼우고 다시 시작한다. 앱을 끌 때 몰래 설치하지 않는다.
 * 확인·받기 실패(오프라인 등)는 화면에 띄우지 않고 기록만 한다 — 다음 확인 때 다시 한다.
 */
export const FIRST_CHECK_MS = 10_000;
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

export function createUpdater({ autoUpdater, isPackaged, onChange, notify, log, setTimer = setTimeout, setRepeat = setInterval }) {
  let state = { state: isPackaged ? 'idle' : 'off' };
  const set = (s) => { state = s; onChange?.(state); };
  let notified = null;

  const check = async () => {
    try { await autoUpdater.checkForUpdates(); } catch (err) { log?.(`업데이트 확인 실패: ${err?.message ?? err}`); }
  };

  return {
    get state() { return state; },
    start() {
      if (!isPackaged) return;
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = false;
      autoUpdater.on('update-available', (i) => { if (state.state !== 'ready') set({ state: 'downloading', version: i?.version }); });
      autoUpdater.on('update-downloaded', (i) => {
        set({ state: 'ready', version: i?.version });
        if (notified === i?.version) return;
        notified = i?.version;
        notify?.({ title: 'Output 새 버전', body: `${i?.version} 버전이 준비됐습니다. 상태판에서 '다시 시작해서 업데이트'를 누르세요.` });
      });
      autoUpdater.on('error', (err) => {
        log?.(`업데이트 오류: ${err?.message ?? err}`);
        if (state.state !== 'ready') set({ state: 'idle' });
      });
      setTimer(check, FIRST_CHECK_MS);
      setRepeat(check, CHECK_EVERY_MS);
    },
    /** 준비된 업데이트를 설치하고 다시 시작한다. 준비 전이면 false */
    install() {
      if (state.state !== 'ready') return false;
      autoUpdater.quitAndInstall();
      return true;
    },
  };
}
