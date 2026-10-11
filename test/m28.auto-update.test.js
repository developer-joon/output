/**
 * M28 — 자동 업데이트 (2026-10-11 사용자 결정: 알림 후, 사용자가 누르면 업데이트).
 * GitHub Releases에서 새 버전을 뒤에서 받아 두고, 준비되면 알림 한 번 + 상태판 버튼. 누르면 바꿔 끼우고 다시 시작한다.
 * Electron 없이 가짜 autoUpdater로 검사한다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createUpdater, CHECK_EVERY_MS, FIRST_CHECK_MS } from '../electron/updater.mjs';

function rig({ packaged = true } = {}) {
  const au = new EventEmitter();
  au.checks = 0; au.installs = 0;
  au.checkForUpdates = async () => { au.checks += 1; };
  au.quitAndInstall = () => { au.installs += 1; };
  const timers = [];
  const changes = [];
  const notes = [];
  const logs = [];
  const u = createUpdater({
    autoUpdater: au, isPackaged: packaged,
    onChange: (s) => changes.push(s), notify: (n) => notes.push(n), log: (m) => logs.push(m),
    setTimer: (fn, ms) => { timers.push({ fn, ms, repeat: false }); return timers.length; },
    setRepeat: (fn, ms) => { timers.push({ fn, ms, repeat: true }); return timers.length; },
  });
  return { au, u, timers, changes, notes, logs };
}

describe('M28 / 자동 업데이트', () => {
  it('U01 받아 두기는 자동, 끌 때 몰래 설치하지 않는다 (누를 때만)', () => {
    const { au, u } = rig();
    u.start();
    assert.equal(au.autoDownload, true);
    assert.equal(au.autoInstallOnAppQuit, false);
  });

  it('U02 시작 뒤 잠깐 있다가 확인, 그 뒤 6시간마다', async () => {
    const { au, u, timers } = rig();
    u.start();
    assert.equal(FIRST_CHECK_MS, 10_000);
    assert.equal(CHECK_EVERY_MS, 6 * 60 * 60 * 1000);
    assert.deepEqual(timers.map((t) => [t.ms, t.repeat]), [[FIRST_CHECK_MS, false], [CHECK_EVERY_MS, true]]);
    await timers[0].fn(); await timers[1].fn();
    assert.equal(au.checks, 2);
  });

  it('U03 개발 실행(패키지 아님)에서는 아무것도 하지 않는다', () => {
    const { au, u, timers } = rig({ packaged: false });
    u.start();
    assert.equal(timers.length, 0);
    assert.equal(au.checks, 0);
    assert.equal(u.state.state, 'off');
  });

  it('U04 다 받으면 준비됨 + 알림 한 번 (같은 버전을 다시 알리지 않는다)', () => {
    const { au, u, changes, notes } = rig();
    u.start();
    au.emit('update-available', { version: '1.0.2' });
    assert.equal(u.state.state, 'downloading');
    au.emit('update-downloaded', { version: '1.0.2' });
    au.emit('update-downloaded', { version: '1.0.2' });
    assert.deepEqual(u.state, { state: 'ready', version: '1.0.2' });
    assert.equal(notes.length, 1);
    assert.match(notes[0].body, /1\.0\.2/);
    assert.ok(changes.length >= 2);
  });

  it('U05 준비되기 전에는 설치하지 않고, 준비되면 누를 때 설치', () => {
    const { au, u } = rig();
    u.start();
    assert.equal(u.install(), false);
    au.emit('update-downloaded', { version: '1.0.2' });
    assert.equal(u.install(), true);
    assert.equal(au.installs, 1);
  });

  it('U06 확인·받기 실패는 화면에 띄우지 않고 기록만, 다음 확인 때 다시 한다', async () => {
    const { au, u, timers, notes, logs } = rig();
    au.checkForUpdates = async () => { throw new Error('offline'); };
    u.start();
    await timers[0].fn();
    au.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'));
    assert.equal(u.state.state, 'idle');
    assert.equal(notes.length, 0);
    assert.ok(logs.some((m) => /offline/.test(m)));
    assert.ok(logs.some((m) => /ERR_INTERNET/.test(m)));
  });

  it('U07 받아 둔 업데이트는 실패 이벤트가 와도 준비됨을 지킨다', () => {
    const { au, u } = rig();
    u.start();
    au.emit('update-downloaded', { version: '1.0.2' });
    au.emit('error', new Error('later check failed'));
    assert.equal(u.state.state, 'ready');
  });
});
