/**
 * 렌더러에 열어 주는 창구. 이 목록 밖의 채널은 부를 수 없다.
 * 렌더러는 장치·파일·셸에 직접 닿지 않는다.
 */
const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = new Set([
  'cb:view', 'cb:resize', 'cb:focusSlot', 'cb:openPermission', 'cb:openSettings',
  'cb:layers:get', 'cb:layers:save', 'cb:apps:running', 'cb:apps:installed', 'cb:apps:pick', 'cb:action:try', 'cb:layers:forApp', 'cb:layers:export', 'cb:layers:import',
  'cb:presets:list', 'cb:presets:copy', 'cb:layers:orcaUnlinked', 'cb:device:status', 'cb:device:plan', 'cb:device:apply', 'cb:keymap:backups', 'cb:keymap:restore',
  'cb:diagnostics:export', 'cb:autostart:get', 'cb:autostart:set', 'cb:prefs:get', 'cb:prefs:set', 'cb:usage:get', 'cb:layers:pick',
  'cb:setup:get', 'cb:setup:complete', 'cb:pause', 'cb:logs', 'cb:info', 'cb:quit', 'cb:openStateDir', 'cb:update:install',
]);
const EVENTS = new Set(['cb:view', 'cb:tab', 'cb:hud']);

contextBridge.exposeInMainWorld('cb', {
  invoke(channel, ...args) {
    if (!INVOKE.has(channel)) return Promise.reject(new Error(`허용되지 않은 채널: ${channel}`));
    return ipcRenderer.invoke(channel, ...args);
  },
  on(channel, fn) {
    if (!EVENTS.has(channel)) throw new Error(`허용되지 않은 이벤트: ${channel}`);
    const h = (_e, payload) => fn(payload);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  },
});
