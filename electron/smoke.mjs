import fs from 'node:fs';
import path from 'node:path';
import { app, Menu } from 'electron';

/**
 * 스모크 점검 (--smoke, 2026-10-10 main.mjs에서 나눔): 실제 창을 띄워 화면·흔들림·스크롤·⌘Q 등을 재고
 * --shots=<폴더>면 스크린샷을 찍는다. 저장은 하지 않는다. main의 창·서비스는 c(게터)로 받는다 — 도중에 바뀐다.
 */
export async function smoke(c) {
  c.openSettingsWindow('about');
  for (const [name, w] of [['popover', c.popover], ['settings', c.settings]]) {
    w.webContents.on('console-message', (e) => {
      if (e.level === 'error' || e.level === 'warning') console.log(`[${name}] ${e.message}`);
    });
    w.webContents.on('preload-error', (_e, p, err) => console.log(`[${name}] preload 오류: ${err.message}`));
  }
  const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });
  await wait(2500);
  const pop = await c.popover.webContents.executeJavaScript(
    `({ rows: document.querySelectorAll('[data-row]').length, title: document.title, warnings: [...document.querySelectorAll('[data-warning]')].map(e => e.textContent.trim()) })`,
  );
  const set = await c.settings.webContents.executeJavaScript(
    `({ title: document.title, tab: document.querySelector('[data-tab-active]')?.dataset.tabActive ?? null, steps: document.querySelectorAll('[data-step]').length })`,
  );
  // 레이어 탭: Orca 레이어(노브 2 + 조이스틱 4) · 기본 레이어(키 12 + 노브 2 + 조이스틱 4)가 그려졌는가 (M12)
  await c.settings.webContents.executeJavaScript(`document.querySelector('[data-nav="layers"]')?.click()`);
  await wait(900);
  set.layersOrca = await c.settings.webContents.executeJavaScript(`document.querySelectorAll('[data-layer-slot]').length`);
  await c.settings.webContents.executeJavaScript(`[...document.querySelectorAll('.layers button')].find((b) => b.textContent.includes('기본'))?.click()`);
  await wait(500);
  set.layersDefault = await c.settings.webContents.executeJavaScript(`document.querySelectorAll('[data-layer-slot]').length`);
  // 기본 크기에서 키를 고르면 왼쪽·오른쪽이 나란히, 세로 스크롤 없이 보이는지 (2026-10-09)
  await c.settings.webContents.executeJavaScript(`document.querySelector('[data-layer-slot="key1"]')?.click()`);
  await wait(400);
  set.layersFit = await c.settings.webContents.executeJavaScript(`(() => { const m = document.getElementById('main'); const l = document.querySelector('.ly-left')?.getBoundingClientRect(); const r = document.querySelector('.ly-right')?.getBoundingClientRect(); return { window: [innerWidth, innerHeight], sideBySide: Boolean(l && r && r.left > l.right), scroll: m.scrollHeight - m.clientHeight, parts: [...m.querySelectorAll(':scope > * > *, .ly-main > *')].map((e) => (e.className || e.tagName) + ':' + Math.round(e.getBoundingClientRect().height)) }; })()`);
  // 저장 안 한 변경 (2026-10-10): 키를 열기만 하면 아님, 이름을 바꾸면 표시
  set.dirtyAfterView = await c.settings.webContents.executeJavaScript(`Boolean(document.querySelector('[data-ly-save]')?.classList.contains('dirty'))`);
  // 머리 줄 겹침 (2026-10-10): 창이 좁아도 머리 줄 칸들이 서로 겹치지 않고 카드 안에 들어오는지 (Orca 레이어)
  {
    const prev = c.settings.getSize();
    await c.settings.webContents.executeJavaScript(`[...document.querySelectorAll('.ly-list button')].find((b) => b.textContent.includes('Orca'))?.click()`);
    const headFit = {};
    for (const w of [900, 1000, 1200]) {
      c.settings.setSize(w, prev[1]);
      await wait(400);
      headFit[w] = await c.settings.webContents.executeJavaScript(`(() => { const card = document.querySelector('.ly-head3'); const cr = card.getBoundingClientRect(); let overlap = 0; let out = 0; for (const row of card.querySelectorAll('.ly-row')) { const kids = [...row.querySelectorAll(':scope > *, .ly-apps > *, .ly-apps .row-flex > *')].filter((e) => e.getBoundingClientRect().width > 0 && !e.classList.contains('grow')).map((e) => e.getBoundingClientRect()); const top = [...row.children].filter((e) => e.getBoundingClientRect().width > 0).map((e) => e.getBoundingClientRect()); for (let k = 1; k < top.length; k += 1) overlap = Math.max(overlap, Math.round(top[k - 1].right - top[k].left)); out = Math.max(out, ...kids.map((r) => Math.round(r.right - cr.right + 1))); } return { overlap, out: Math.max(0, out), height: Math.round(cr.height), rows: [...card.querySelectorAll('.ly-row')].map((r) => Math.round(r.getBoundingClientRect().height)) }; })()`);
    }
    await c.settings.webContents.executeJavaScript(`[...document.querySelectorAll('.ly-list button')].find((b) => b.textContent.includes('기본'))?.click()`);
    for (const w of [900, 1200]) {
      c.settings.setSize(w, prev[1]);
      await wait(400);
      headFit[`기본 ${w}`] = await c.settings.webContents.executeJavaScript(`(() => { const card = document.querySelector('.ly-head3'); const cr = card.getBoundingClientRect(); let overlap = 0; let out = 0; for (const row of card.querySelectorAll('.ly-row')) { const kids = [...row.querySelectorAll(':scope > *, .ly-apps > *, .ly-apps .row-flex > *')].filter((e) => e.getBoundingClientRect().width > 0 && !e.classList.contains('grow')).map((e) => e.getBoundingClientRect()); const top = [...row.children].filter((e) => e.getBoundingClientRect().width > 0).map((e) => e.getBoundingClientRect()); for (let k = 1; k < top.length; k += 1) overlap = Math.max(overlap, Math.round(top[k - 1].right - top[k].left)); out = Math.max(out, ...kids.map((r) => Math.round(r.right - cr.right + 1))); } return { overlap, out: Math.max(0, out), height: Math.round(cr.height), rows: [...card.querySelectorAll('.ly-row')].map((r) => Math.round(r.getBoundingClientRect().height)) }; })()`);
    }
    c.settings.setSize(prev[0], prev[1]);
    await wait(300);
    set.headFit = headFit;
  }
  // 상태판 레이어 칩 (2026-10-11): 쉬는 레이어를 누르면 그 레이어(직접 고름), '자동' 칩이 생기고 누르면 앞 앱 따라
  {
    const pj = (code) => c.popover.webContents.executeJavaScript(code);
    const before = c.currentView().layerLine;
    await pj(`document.querySelector('.layer-chips .lchip:not(.on):not(.auto)')?.click()`);
    await wait(500);
    const mid = c.currentView().layerLine;
    const autoChip = await pj(`Boolean(document.querySelector('.layer-chips .lchip.auto'))`);
    await pj(`document.querySelector('.layer-chips .lchip.auto')?.click()`);
    await wait(500);
    set.popoverPick = { before: before.layers.find((l) => l.active)?.name ?? null, picked: mid.layers.find((l) => l.active)?.name ?? null, pinned: mid.pinned, autoChip, afterAuto: c.currentView().layerLine.pinned };
  }
  // 상태판 스크롤 (2026-10-10): 창 높이가 내용과 맞아 스크롤이 생기지 않는지. 레이어 제안 칸이 있으면 함께 본다
  set.popoverFit = await c.popover.webContents.executeJavaScript(`(() => { const e = document.scrollingElement; const app = document.getElementById('app'); return { overflow: e.scrollHeight - innerHeight, appOverflow: app ? app.scrollHeight - app.clientHeight : null, suggest: Boolean(document.querySelector('.suggest')), height: innerHeight }; })()`);
  // 제안 칸이 뜬 모습을 흉내 내 같은 측정 (실제 앞 앱과 상관없이)
  c.popover.webContents.send('cb:view', { ...c.currentView(), suggestLayer: { bundleId: 'com.apple.systempreferences', name: '시스템 설정' } });
  await wait(500);
  set.popoverFitSuggest = await c.popover.webContents.executeJavaScript(`(() => { const e = document.scrollingElement; return { overflow: e.scrollHeight - innerHeight, suggest: Boolean(document.querySelector('.suggest')), height: innerHeight, slack: Math.round(parseFloat(getComputedStyle(document.querySelector('.pop footer')).marginTop)) }; })()`);
  c.popover.webContents.send('cb:view', c.currentView());
  await wait(300);
  // 대기 (2026-10-11): 키 그림·세션 목록 없이 안내만
  c.popover.webContents.send('cb:view', { ...c.currentView(), keyMap: null, tabs: false });
  await wait(400);
  set.popoverIdle = await c.popover.webContents.executeJavaScript(`({ rows: document.querySelectorAll('.pop .rows .row').length, board: Boolean(document.querySelector('.pop-board')), overflow: document.scrollingElement.scrollHeight - innerHeight, height: innerHeight })`);
  // 제안 칸이 사라진 뒤 창이 다시 줄어드는지 — 아래 빈 공간(footer 위 자동 여백)이 거의 없어야 한다 (2026-10-11)
  for (let i = 0; i < 3; i += 1) { c.popover.webContents.send('cb:view', c.currentView()); await wait(250); }
  set.popoverAfter = await c.popover.webContents.executeJavaScript(`(() => ({ overflow: document.scrollingElement.scrollHeight - innerHeight, slack: Math.round(parseFloat(getComputedStyle(document.querySelector('.pop footer')).marginTop)), height: innerHeight }))()`);
  // 레이아웃 흔들림 (2026-10-10 사용자 요청): '+ 레이어'·알림·저장 안 한 변경이 생겨도 장치 그림 위치가 그대로인지
  const workTop = () => c.settings.webContents.executeJavaScript(`Math.round(document.querySelector('.ly-work')?.getBoundingClientRect().top ?? -1)`);
  const shift = { before: await workTop() };
  for (let i = 0; i < 4; i += 1) {
    await c.settings.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find((b) => b.textContent === '+ 레이어')?.click()`);
    await wait(250);
  }
  shift.afterAdd4 = await workTop();
  shift.partsAfterAdd = await c.settings.webContents.executeJavaScript(`[...document.querySelectorAll('#main .panel > *, .ly-main > *')].map((e) => (e.className || e.tagName) + ':' + Math.round(e.getBoundingClientRect().height))`);
  shift.partsBefore = set.layersFit?.parts;
  shift.headKids = await c.settings.webContents.executeJavaScript(`[...document.querySelectorAll('.ly-head3 .ly-row > *, .ly-apps > *')].map((e) => (e.className || e.tagName) + ':' + Math.round(e.getBoundingClientRect().width) + 'x' + Math.round(e.getBoundingClientRect().height) + '@' + Math.round(e.getBoundingClientRect().top))`);
  await c.settings.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find((b) => b.textContent === '되돌리기')?.click()`);
  await wait(400);
  shift.afterRevert = await workTop();
  set.layoutShift = shift;
  await c.settings.webContents.executeJavaScript(`document.querySelector('[data-layer-slot="key1"]')?.click()`);
  await wait(300);
  // 자동 이름 (2026-10-10): 이름을 넣지 않은 단축키는 입력 칸 없이 자동 이름 + '이름 바꾸기'
  set.selAfterRevert = await c.settings.webContents.executeJavaScript(`document.querySelector('.ly-list [aria-pressed="true"]')?.textContent ?? null`);
  set.autoName = await c.settings.webContents.executeJavaScript(`document.querySelector('.ly-auto-name')?.textContent ?? null`);
  set.nameInputBeforeRename = await c.settings.webContents.executeJavaScript(`Boolean(document.querySelector('.ly-editor input[aria-label="이름"]'))`);
  await c.settings.webContents.executeJavaScript(`[...document.querySelectorAll('.ly-editor button')].find((b) => b.textContent === '이름 바꾸기')?.click()`);
  await wait(300);
  set.dirtyAfterRenameOpen = await c.settings.webContents.executeJavaScript(`Boolean(document.querySelector('[data-ly-save]')?.classList.contains('dirty'))`);
  await c.settings.webContents.executeJavaScript(`(() => { const i = document.querySelector('.ly-editor input[aria-label="이름"]'); if (i) { i.value += '시험'; i.dispatchEvent(new Event('input', { bubbles: true })); } })()`);
  await wait(200);
  // 이름 칸이 없는 키(사용자 데이터에 따라)여도 변경 표시를 확인한다 — 언더글로우 움직임을 바꿔 본다 (2026-10-10)
  await c.settings.webContents.executeJavaScript(`(() => { const s = document.querySelector('select[aria-label="언더글로우 움직임"]'); if (s) { s.value = s.value === 'blink' ? 'breathe' : 'blink'; s.dispatchEvent(new Event('change')); } })()`);
  await wait(200);
  set.dirtyAfterEdit = await c.settings.webContents.executeJavaScript(`Boolean(document.querySelector('[data-ly-save]')?.classList.contains('dirty'))`);
  // 빈 키에 단축키를 넣으면: 입력 칸 없이 자동 이름, 단축키를 적으면 그 자리에서 기호로 (2026-10-10)
  const jsS = (code) => c.settings.webContents.executeJavaScript(code);
  await jsS(`document.querySelector('[data-layer-slot="key2"]')?.click()`);
  await wait(300);
  await jsS(`(() => { const s = document.querySelector('select[aria-label="동작 종류"]'); s.value = 'shortcut'; s.dispatchEvent(new Event('change')); })()`);
  await wait(300);
  set.autoNameEmpty = { name: await jsS(`document.querySelector('.ly-auto-name')?.textContent ?? null`), input: await jsS(`Boolean(document.querySelector('.ly-editor input[aria-label="이름"]'))`) };
  await jsS(`(() => { const i = document.querySelector('.ly-editor input[aria-label="단축키"]'); if (i) { i.value = 'cmd+shift+p'; i.dispatchEvent(new Event('input', { bubbles: true })); } })()`);
  await wait(200);
  set.autoNameEmpty.after = await jsS(`document.querySelector('.ly-auto-name')?.textContent ?? null`);
  // 단축키 충돌 경고 (2026-10-10): ⌘Space는 macOS Spotlight
  await jsS(`(() => { const i = document.querySelector('.ly-editor input[aria-label="단축키"]'); if (i) { i.value = 'cmd+space'; i.dispatchEvent(new Event('input', { bubbles: true })); } })()`);
  await wait(150);
  set.conflictWarn = await jsS(`document.querySelector('.ly-conflict:not([hidden])')?.textContent ?? null`);
  // 레이어 복제 (2026-10-10): 목록에 '… 복사본'이 생기고 고른 레이어가 된다
  await jsS(`[...document.querySelectorAll('.ly-head3 button')].find((b) => b.textContent === '복제')?.click()`);
  await wait(300);
  set.duplicated = await jsS(`document.querySelector('.ly-list [aria-pressed="true"]')?.textContent ?? null`);
  await c.settings.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find((b) => b.textContent === '되돌리기')?.click()`);
  await wait(400);
  // 앱 고르기 묶음 (2026-10-09): 최근 연결 · 실행 중 · 설치된 앱
  await c.settings.webContents.executeJavaScript(`[...document.querySelectorAll('.layers button')].find((b) => b.textContent.includes('Orca'))?.click()`);
  await wait(800);
  set.appGroups = await c.settings.webContents.executeJavaScript(`[...(document.querySelector('select[aria-label="앱"]')?.querySelectorAll('optgroup') ?? [])].map((g) => g.label + ' ' + g.children.length)`);
  // 레이어·키를 오가기만 했을 때 변경으로 보이지 않는지 (2026-10-10)
  await c.settings.webContents.executeJavaScript(`document.querySelector('[data-layer-slot="key13"]')?.click()`);
  await wait(300);
  set.dirtyAfterNav = await c.settings.webContents.executeJavaScript(`Boolean(document.querySelector('[data-ly-save]')?.classList.contains('dirty'))`);
  const shotsArg = process.argv.find((a) => a.startsWith('--shots='));
  if (shotsArg) {
    const dir = shotsArg.slice('--shots='.length);
    fs.mkdirSync(dir, { recursive: true });
    c.popover.setPosition(40, 40);
    c.popover.showInactive();
    c.settings.setPosition(480, 40);
    c.settings.setSize(1440, 1180);   // 레이어 화면 전체가 한 장에 들어오게
    c.settings.showInactive();
    await wait(800);
    const snap = async (w, name) => fs.writeFileSync(path.join(dir, `${name}.png`), (await w.webContents.capturePage()).toPNG());
    await snap(c.popover, 'popover');
    // 상태판 '키' 탭 (Orca 레이어일 때만 탭이 있다, 2026-10-05). 찍은 뒤 세션 탭으로 되돌린다
    if (await c.popover.webContents.executeJavaScript(`Boolean(document.querySelector('.tabs'))`)) {
      await c.popover.webContents.executeJavaScript(`document.querySelectorAll('.tab')[1].click()`);
      await wait(400);
      await snap(c.popover, 'popover-keys');
      await c.popover.webContents.executeJavaScript(`document.querySelectorAll('.tab')[0].click()`);
    }
    for (const t of ['layers', 'presets', 'prefs', 'setup', 'check', 'logs', 'about']) {
      await c.settings.webContents.executeJavaScript(`document.querySelector('[data-nav="${t}"]').click()`);
      await wait(700);
      await snap(c.settings, `settings-${t}`);
    }
    const js = (code) => c.settings.webContents.executeJavaScript(code);
    // 장치 준비 흐름: 바뀌는 내용까지만 (쓰지는 않는다)
    await js(`document.querySelector('[data-nav="setup"]').click()`);
    await wait(500);
    // 2026-10-11: 장치 칸을 없앴다 — 준비가 안 된 장치에서만 설치 단계 4에 '장치 준비'가 있다
    await js(`[...document.querySelectorAll('button')].find(b => /장치 준비/.test(b.textContent))?.click()`);
    await wait(900);
    await js(`document.querySelector('[data-step="4"]')?.scrollIntoView()`);
    await wait(200);
    await snap(c.settings, 'device-plan');
    // 점검하기 (2026-10-12): LED 테스트까지 돌고 결과 칸이 그려지는지
    await js(`document.querySelector('[data-nav="check"]').click()`);
    await wait(500);
    await js(`[...document.querySelectorAll('button')].find(b => b.textContent === '점검하기')?.click()`);
    for (let i = 0; i < 40 && !(await js(`document.querySelectorAll('[data-check]').length`)); i++) await wait(500);
    await js(`document.querySelector('.check-section')?.scrollIntoView()`);
    await wait(200);
    await snap(c.settings, 'check');
    // 프리셋: 노브 그림이 함께 보인다
    await js(`document.querySelector('[data-nav="presets"]').click()`);
    await wait(500);
    await snap(c.settings, 'presets-orca');
    await js(`document.querySelector('[aria-label="조이스틱 설정 열기"]')?.click()`);
    await wait(300);
    await snap(c.settings, 'presets-orca-joystick');
    // 노브·조이스틱 화면 표시 (2026-10-10): 조이스틱 위로 기울임(유지해야 입력 0.5초 중 절반) · 노브 돌림, 설정 메뉴
    {
      const { joystickHud } = await import('../src/service/hudModel.js');
      const S4 = [{ direction: 'right', from: 0.875, to: 0.125 }, { direction: 'down', from: 0.125, to: 0.375 }, { direction: 'left', from: 0.375, to: 0.625 }, { direction: 'up', from: 0.625, to: 0.875 }];
      const sc2 = (label) => ({ type: 'shortcut', label, keystroke: 'cmd+k' });
      const slots = { joystick_up: sc2('다음 탭'), joystick_left: sc2('뒤로'), joystick_right: sc2('앞으로') };
      c.service.emit('hud', { ...joystickHud({ angle: 0.72, distance: 0.85, dir: 'up', sectors: S4, deadzone: 0.05, dwellMs: 500, slots, enteredAt: 0 }), heldMs: 250 });
      await wait(700);
      fs.writeFileSync(path.join(dir, 'hud-joystick.png'), (await c.hudWin.window().webContents.capturePage()).toPNG());
      c.service.emit('hud', { kind: 'dial', action: 'cw', label: '다음 탭' });
      await wait(500);
      fs.writeFileSync(path.join(dir, 'hud-dial.png'), (await c.hudWin.window().webContents.capturePage()).toPNG());
      c.service.emit('hud', { kind: 'picker', index: 2, items: [{ id: null, name: '자동 (앞 앱 따라)', color: null }, { id: 'default', name: '기본', color: '#5A8CDC' }, { id: 'l-c', name: 'Code', color: '#2BB3E8' }, { id: 'l-orca', name: 'Orca', color: '#1F9E96' }] });
      await wait(500);
      fs.writeFileSync(path.join(dir, 'hud-picker.png'), (await c.hudWin.window().webContents.capturePage()).toPNG());
      await js(`document.querySelector('[data-nav="prefs"]').click()`);
      await wait(500);
      await snap(c.settings, 'settings-prefs');
    }
    // 추천 프리셋 (2026-10-10): 코드 편집기, 미디어(노브 그림)
    await js(`[...document.querySelectorAll('.layers button')].find((b) => b.textContent === '코드 편집기')?.click()`);
    await wait(400);
    await snap(c.settings, 'presets-code');
    await js(`[...document.querySelectorAll('.layers button')].find((b) => b.textContent === '미디어')?.click()`);
    await wait(300);
    await js(`document.querySelector('[aria-label="노브 설정 열기"]')?.click()`);
    await wait(300);
    await snap(c.settings, 'presets-media');
    // 레이어 편집: 기본 레이어 → 키 3 → 레이아웃, 조이스틱 8방향 (저장하지 않는다)
    await js(`document.querySelector('[data-nav="layers"]').click()`);
    await wait(600);
    await js(`[...document.querySelectorAll('.layers button')].find((b) => b.textContent.includes('Orca'))?.click()`);
    await wait(400);
    await snap(c.settings, 'layers-orca');
    // 추천 프리셋 레이어(있으면): 잠긴 키도 LED 색 테두리 (2026-10-10)
    if (await js(`Boolean([...document.querySelectorAll('.ly-list button')].find((b) => b.textContent.includes('코드 편집기')))`)) {
      await js(`[...document.querySelectorAll('.ly-list button')].find((b) => b.textContent.includes('코드 편집기'))?.click()`);
      await wait(400);
      await snap(c.settings, 'layers-code');
      await js(`[...document.querySelectorAll('.ly-list button')].find((b) => b.textContent.includes('Orca'))?.click()`);
      await wait(300);
    }
    // 좁은 창 머리 (2026-10-10): 두 줄, 겹침 없음
    c.settings.setSize(1000, 1180);
    await wait(500);
    await snap(c.settings, 'layers-orca-narrow');
    await js(`[...document.querySelectorAll('.ly-list button')].find((b) => b.textContent.includes('기본'))?.click()`);
    await wait(400);
    await snap(c.settings, 'layers-default-narrow');
    await js(`[...document.querySelectorAll('.ly-list button')].find((b) => b.textContent.includes('Orca'))?.click()`);
    await wait(300);
    c.settings.setSize(1440, 1180);
    await wait(400);
    await js(`document.querySelector('[aria-label="노브 설정 열기"]')?.click()`);
    await wait(300);
    await snap(c.settings, 'layers-orca-knob');
    await js(`document.querySelector('[aria-label="조이스틱 설정 열기"]')?.click()`);
    await wait(300);
    await snap(c.settings, 'layers-orca-joystick');
    await js(`[...document.querySelectorAll('.layers button')].find((b) => b.textContent.includes('기본'))?.click()`);
    await wait(400);
    // 레이어 언더글로우 (2026-10-10): 카드 둘째 줄 — 보기만 하면 변경 아님, 움직임을 바꾸면 변경·속도 칸이 켜짐 (저장하지 않는다)
    const ug = {};
    ug.dirtyAfterView = await js(`Boolean(document.querySelector('[data-ly-save]')?.classList.contains('dirty'))`);
    ug.speedDisabledSolid = await js(`document.querySelector('select[aria-label="언더글로우 속도"]')?.disabled ?? null`);
    await js(`(() => { const s = document.querySelector('select[aria-label="언더글로우 움직임"]'); if (s) { s.value = 'breathe'; s.dispatchEvent(new Event('change')); } })()`);
    await wait(300);
    ug.dirtyAfterEdit = await js(`Boolean(document.querySelector('[data-ly-save]')?.classList.contains('dirty'))`);
    ug.speedEnabled = await js(`!document.querySelector('select[aria-label="언더글로우 속도"]')?.disabled`);
    await snap(c.settings, 'layers-underglow');
    await js(`[...document.querySelectorAll('button')].find((b) => b.textContent === '되돌리기')?.click()`);
    await wait(400);
    fs.writeFileSync(path.join(dir, 'underglow.json'), JSON.stringify(ug));
    // 자동 이름 (2026-10-10): 빈 키 2에 단축키 → 입력 칸 없이 '⌘⇧P (자동) [이름 바꾸기]'
    await js(`document.querySelector('[data-layer-slot="key2"]')?.click()`);
    await wait(300);
    await js(`(() => { const s = document.querySelector('select[aria-label="동작 종류"]'); s.value = 'shortcut'; s.dispatchEvent(new Event('change')); })()`);
    await wait(300);
    await js(`(() => { const i = document.querySelector('.ly-editor input[aria-label="단축키"]'); if (i) { i.value = 'cmd+shift+p'; i.dispatchEvent(new Event('input', { bubbles: true })); } })()`);
    await wait(300);
    await snap(c.settings, 'layers-autoname');
    // 화면 캡처 동작 (2026-10-10): 키 2를 화면 캡처로 → 모니터·저장 칸, 자동 이름
    await js(`(() => { const s = document.querySelector('select[aria-label="동작 종류"]'); s.value = 'screenshot'; s.dispatchEvent(new Event('change')); })()`);
    await wait(300);
    // 모니터 목록은 지금 연결된 것만 (2026-10-12) — 고르지 않고 목록만 찍는다
    console.log(`smoke: 모니터 칸 ${await js(`[...document.querySelectorAll('select[aria-label="캡처할 모니터"] option')].map((o) => o.textContent).join(' | ')`)}`);
    await snap(c.settings, 'layers-screenshot');
    await js(`document.querySelector('[data-layer-slot="key3"]')?.click()`);
    await wait(300);
    await js(`(() => { const s = document.querySelector('select[aria-label="동작 종류"]'); s.value = 'layout'; s.dispatchEvent(new Event('change')); })()`);
    await wait(300);
    await js(`document.querySelector('[aria-label="조이스틱 설정 열기"]')?.click()`);
    await wait(300);
    await js(`[...document.querySelectorAll('.ly-seg button')].find((b) => b.textContent === '8')?.click()`);
    await wait(400);
    await snap(c.settings, 'layers-edit');
    await js(`document.querySelector('[data-layer-slot="key4"]')?.click()`);
    await wait(300);
    await js(`(() => { const s = document.querySelector('select[aria-label="동작 종류"]'); s.value = 'shortcut'; s.dispatchEvent(new Event('change')); })()`);
    await wait(300);
    // 레이어 화면이 스크롤 없이 들어가는 크기 (2026-10-09): 키 설정(고급 닫힘)이 열린 상태의 내용 크기
    set.layersNeed = await js(`(() => { const m = document.getElementById('main'); const w = document.querySelector('.ly-work').getBoundingClientRect(); const l = document.querySelector('.ly-left').getBoundingClientRect(); return { workLeft: Math.ceil(w.left), leftW: Math.ceil(l.width), w: Math.ceil(w.right + 26), h: Math.ceil(m.scrollHeight) }; })()`);
    await js(`[...document.querySelectorAll('.led-box input[type=checkbox]')].forEach((c) => c.click())`);
    await wait(300);
    await js(`document.querySelector('.ly-adv')?.setAttribute('open', '')`);
    await wait(200);
    await js(`document.querySelector('.led-box')?.scrollIntoView()`);
    await wait(200);
    await snap(c.settings, 'layers-led');
    // 동작 종류를 바꿔도 LED 설정이 남는지 (최종 리뷰 #3) — 남으면 고급 체크가 그대로 켜져 있다
    await js(`(() => { const s = document.querySelector('select[aria-label="동작 종류"]'); s.value = 'openUrl'; s.dispatchEvent(new Event('change')); })()`);
    await wait(300);
    set.ledKeptAfterTypeChange = await js(`document.querySelectorAll('.led-box input[type=checkbox]:checked').length`);
  }
  // ⌘Q (2026-10-10): 메뉴의 ⌘Q 항목은 창만 닫고 앱은 계속 돈다
  {
    const all = (items) => items.flatMap((i) => [i, ...(i.submenu ? all(i.submenu.items) : [])]);
    const items = all(Menu.getApplicationMenu()?.items ?? []);
    const cmdQ = items.find((i) => i.accelerator === 'CmdOrCtrl+Q');
    let quitting = false;
    const onQuit = () => { quitting = true; };
    app.once('before-quit', onQuit);
    cmdQ?.click();
    await wait(600);
    app.removeListener('before-quit', onQuit);
    set.cmdQ = { label: cmdQ?.label ?? null, settingsClosed: !c.settings || c.settings.isDestroyed(), appQuitting: quitting, trayAlive: Boolean(c.tray && !c.tray.isDestroyed()) };
  }
  const v = c.currentView();
  console.log(JSON.stringify({
    smoke: true, active: v.active, trayIconEmpty: c.trayImage('#1f9e96').isEmpty(), trayBounds: c.tray?.getBounds?.() ?? null, popover: pop, settings: set,
    device: v.health.device.state, orca: v.health.orca.state, rows: v.rows.filter((r) => !r.empty).length,
  }, null, 2));
  app.quit();
}
