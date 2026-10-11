/**
 * M24 — ⌘Q는 창만 닫고 메뉴바에 남는다 (2026-10-10 사용자 요청). 진짜 종료는 상태판 '종료' 또는 ⌥⌘Q.
 * Electron 없이 메뉴 틀만 검사한다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appMenuTemplate } from '../electron/appMenu.mjs';

const flat = (items) => items.flatMap((i) => [i, ...(Array.isArray(i.submenu) ? flat(i.submenu) : [])]);

describe('M24 / 앱 메뉴', () => {
  it('Q01 ⌘Q는 창 닫기(메뉴바에 남음), ⌥⌘Q는 종료 — role quit은 없다', () => {
    const calls = [];
    const items = flat(appMenuTemplate({ onCloseWindows: () => calls.push('close'), onQuit: () => calls.push('quit') }));
    const cmdQ = items.find((i) => i.accelerator === 'CmdOrCtrl+Q');
    const optQ = items.find((i) => i.accelerator === 'Alt+CmdOrCtrl+Q');
    cmdQ.click(); optQ.click();
    assert.deepEqual(calls, ['close', 'quit']);
    assert.match(cmdQ.label, /메뉴바/);
    assert.equal(items.some((i) => i.role === 'quit'), false, '기본 종료(⌘Q)를 쓰지 않는다');
  });
  it('Q02 편집(복사·붙여넣기 등)과 창(⌘W) 메뉴는 그대로 둔다 — 설정 화면 입력 칸이 동작하게', () => {
    const roles = flat(appMenuTemplate({ onCloseWindows() {}, onQuit() {} })).map((i) => i.role).filter(Boolean);
    assert.ok(roles.includes('editMenu'));
    assert.ok(roles.includes('windowMenu'));
  });
});
