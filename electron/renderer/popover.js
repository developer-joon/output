import { h, mount, cb } from './dom.js';
import { dirsOf, knobFace, joystickFace } from './widgets.js';

/**
 * 메뉴바 팝오버 = 상태판 (M5 설계 §10).
 * 뷰모델(src/service/uiModel.js)을 그대로 그린다. 여기에는 정책이 없다.
 */
const app = document.getElementById('app');
let busy = false;
// Orca 레이어의 탭 [세션 | 키]: 마지막에 고른 탭을 기억한다 (2026-10-05). 저장이 막혀도 세션 탭으로 동작
let tab = (() => { try { return localStorage.getItem('output.popTab') ?? 'sessions'; } catch { return 'sessions'; } })();
let lastView = null;

/** 지금 레이어의 키 그림: 장치 배열 4×4, 칸마다 지금 LED 색 점과 짧은 이름. 보기 전용 */
/**
 * 지금 레이어의 키 그림 — 설정 화면과 같은 장치 판 (2026-10-06).
 * sessions: 키 1~10 = 작업 이름·상태, 누르면 그 터미널로 (나머지는 흐리게). keys: 동작 이름·지금 LED + 노브·조이스틱 작은 그림
 */
function keyMapEl(m, { sessions = false } = {}) {
  const cell = (c) => {
    if (c.kind === 'dial') return h('div', { class: 'kc round pop-dim', title: c.title }, h('span', { class: 'code' }, '노브'));
    if (c.kind === 'joystick') return h('div', { class: 'kc round pop-dim', title: c.title }, h('span', { class: 'code' }, '조이스틱'));
    if (c.kind === 'miniled') return h('div', { class: 'kc static', title: c.title }, h('span', { class: 'hint' }, '미니 LED'));
    const session = sessions && c.n <= 10;
    const dim = c.empty || (sessions && !session);
    const dot = h('span', { class: `dot kdot${c.color ? '' : ' offdot'}`, style: c.color ? { background: c.color } : {} });
    const body = [dot, h('span', { class: 'code' }, c.empty ? '—' : c.labelKo), h('span', { class: 'hint' }, session && c.statusKo ? c.statusKo : `키 ${c.n}`)];
    if (session && !c.empty) {
      return h('button', { class: 'kc', title: `${c.title} — 누르면 이동`, dataset: { cell: c.id }, onclick: () => cb.invoke('cb:focusSlot', c.n) }, ...body);
    }
    return h('div', { class: `kc${dim ? ' pop-dim' : ''}`, title: c.title, dataset: { cell: c.id } }, ...body);
  };
  const widgets = sessions ? null : h('div', { class: 'pop-widgets', 'aria-label': '노브·조이스틱' },
    h('div', { class: 'ly-widget' }, knobFace({ labels: m.dial, color: m.color ?? '#5A8CDC' }), h('div', { class: 'ly-title' }, '노브')),
    h('div', { class: 'ly-widget' }, joystickFace({ dirs: dirsOf(m.joystick.directions, m.joystick.axis), labels: m.joystick.labels, color: m.color ?? '#5A8CDC' }), h('div', { class: 'ly-title' }, '조이스틱')));
  return h('div', {},
    h('div', { class: 'board pop-board', 'aria-label': '키 배치와 지금 LED' }, m.cells.map(cell)),
    h('div', { class: 'underglow', title: m.underglow ? '언더글로우' : '언더글로우 꺼짐', style: m.underglow ? { background: m.underglow } : {} }),
    widgets);
}

function tabsEl() {
  const pick = (t) => { tab = t; try { localStorage.setItem('output.popTab', t); } catch { /* 기억만 못 함 */ } if (lastView) render(lastView); };
  return h('div', { class: 'tabs', role: 'tablist' },
    h('button', { class: 'tab', role: 'tab', 'aria-selected': String(tab !== 'keys'), onclick: () => pick('sessions') }, '세션'),
    h('button', { class: 'tab', role: 'tab', 'aria-selected': String(tab === 'keys'), onclick: () => pick('keys') }, '키'));
}

function chip(ok, label, state) {
  const cls = ok ? 'chip ok' : (state === 'connecting' || state === 'missing' ? 'chip mid' : 'chip bad');
  return h('span', { class: cls }, label);
}

function warningEl(w) {
  const action = w.action === 'open-input-monitoring'
    ? h('button', { onclick: () => cb.invoke('cb:openPermission', 'inputMonitoring') }, '입력 모니터링 열기')
    : w.action === 'open-accessibility'
      ? h('button', { onclick: () => cb.invoke('cb:openPermission', 'accessibility') }, '손쉬운 사용 열기')
      : w.action === 'open-device'
        ? h('button', { onclick: () => cb.invoke('cb:openSettings', 'about') }, '정보 · 진단')
      : w.action === 'open-setup'
        ? h('button', { onclick: () => cb.invoke('cb:openSettings', 'about') }, '정보 · 진단')
        : null;
  const tone = w.level === 'error' ? 'error' : w.level === 'info' ? 'info' : 'warn';
  return h('div', { class: `notice ${tone}`, dataset: { warning: w.code } }, w.messageKo, action);
}

function render(v) {
  lastView = v;
  // 머리 아이콘 = 메뉴바와 같은 앱 아이콘(두 화살표)을 상태색으로 (2026-10-04)
  const icon = v.paused ? 'gray' : ({ attention: 'red', problem: 'gray', running: 'amber', done: 'teal', calm: 'green' }[v.menu.tone] ?? 'green');
  const header = h('header', {},
    h('img', { class: 'head-icon', src: `../assets/tray-${icon}@2x.png`, width: 18, height: 18, alt: '' }),
    h('strong', { class: 'grow' }, 'Output'),
    chip(v.health.device.ok, v.health.device.labelKo, v.health.device.state),
    // Orca는 문제가 있을 때만 보인다. 모드는 아래 '지금' 줄과 레이어 칩이 알려 준다 (2026-10-04 사용자 요청)
    v.health.orca.ok ? null : chip(false, v.health.orca.labelKo, v.health.orca.state),
  );

  // 지금: 앞 앱 → 고른 레이어. 아래 칩 줄 = 모든 레이어 (활성은 레이어 색으로 채움)
  const sub = h('div', { class: 'sub' },
    h('span', { class: 'grow' }, v.layerLine?.nowKo ?? ''),
    h('span', {}, v.bankLabelKo),
  );
  const layerChips = v.layerLine?.layers?.length ? h('div', { class: 'layer-chips', 'aria-label': '레이어' },
    // 누르면 그 레이어로 (2026-10-11) — 노브로 고른 것과 같다: 지금 앞 앱인 동안만. 고른 동안은 '자동' 칩으로 되돌린다
    v.layerLine.pinned ? h('button', { class: 'lchip auto', title: '앞 앱 따라 레이어 고르기', onclick: () => cb.invoke('cb:layers:pick', null) }, '자동') : null,
    v.layerLine.layers.map((l) => h('button', {
      class: `lchip${l.active ? ' on' : ''}`, title: l.active ? '지금 쓰는 레이어' : `누르면 '${l.name}' 레이어로 (지금 앞 앱인 동안)`,
      // 색이 곧 표시: 지금 레이어는 레이어 색으로 채우고, 나머지는 테두리만
      style: l.active ? { background: l.color, borderColor: l.color } : { borderColor: l.color },
      onclick: () => { if (!l.active) cb.invoke('cb:layers:pick', l.id); },
    }, l.name))) : null;

  const restoring = v.restoring
    ? h('div', { class: 'notice lav', style: { margin: '8px 12px 0' } }, '재시작 후 자리는 되살렸고, 상태는 Orca 확인 전이라 보라색입니다.')
    : null;
  const paused = v.paused
    ? h('div', { class: 'notice info', style: { margin: '8px 12px 0' } }, '일시정지됨 — 장치를 놓았습니다. 다시 시작을 누르세요.')
    : null;

  const warnings = v.warnings.length ? h('div', { class: 'warnings' }, v.warnings.map(warningEl)) : null;
  // 새 버전을 받아 두었으면 누를 때 설치 (2026-10-11 자동 업데이트: 알림 후 사용자가 누르면)
  const update = v.update?.state === 'ready' ? h('div', { class: 'notice info', style: { margin: '8px 12px 0' }, dataset: { warning: 'update' } },
    `새 버전 ${v.update.version}이 준비됐습니다.`,
    h('button', { onclick: () => cb.invoke('cb:update:install') }, '다시 시작해서 업데이트')) : null;
  // 앞 앱에 레이어가 없으면 만들기 제안 (2026-10-10)
  const suggest = v.suggestLayer ? h('div', { class: 'suggest' },
    h('span', { class: 'grow' }, `'${v.suggestLayer.name}'에는 레이어가 없습니다.`),
    h('button', { class: 'btn', onclick: () => cb.invoke('cb:layers:forApp', v.suggestLayer) }, '이 앱 레이어 만들기')) : null;
  const event = h('div', { class: 'event' }, v.lastEventKo || '');

  const footer = h('footer', {},
    h('button', { class: 'btn grow', onclick: () => cb.invoke('cb:openSettings', 'layers') }, '설정…'),
    h('button', { class: 'btn', onclick: () => cb.invoke('cb:pause', !v.paused) }, v.paused ? '다시 시작' : '일시정지'),
    h('button', { class: 'btn', onclick: () => cb.invoke('cb:quit') }, '종료'),
  );

  // Orca 레이어: [세션 | 키] 탭, 다른 앱 레이어: 키 그림만, 대기: 세션 목록 (2026-10-05)
  const tabs = v.tabs ? tabsEl() : null;
  // 키 그림 (Orca 세션 탭도 키 배열, 2026-10-06). 대기에는 아무것도 그리지 않는다 (2026-10-11 사용자 피드백:
  // 키보드가 쉬는데 Orca 세션 목록이 보이면 작업 칸이 켜진 것처럼 보인다). 대기 이유는 아래 안내, 레이어는 위 칩으로 고른다
  const body = !v.keyMap ? null : keyMapEl(v.keyMap, { sessions: v.tabs && tab !== 'keys' });
  mount(app, header, sub, layerChips, update, paused, restoring, suggest, tabs, body, warnings, event, footer);
  // 높이 = 자식 높이 + 바깥 여백(margin) + 틀의 안쪽 여백 (2026-10-10: 여백을 빼먹어 '레이어 만들기' 칸이 뜨면 스크롤이 생겼다)
  const px = (v) => parseFloat(v) || 0;
  const box = getComputedStyle(app);
  // 맨 아래 버튼 줄(footer)은 margin-top:auto로 남는 공간을 다 가져간다 — 그 여백을 더하면 창이 줄지 않고 늘기만 한다
  // (2026-10-11: 아래 여백이 넓어진 원인). footer의 위쪽 여백은 빼고 센다
  const want = [...app.children].reduce((sum, el) => {
    const cs = getComputedStyle(el);
    return sum + el.getBoundingClientRect().height + (el.tagName === 'FOOTER' ? 0 : px(cs.marginTop)) + px(cs.marginBottom);
  }, px(box.paddingTop) + px(box.paddingBottom) + px(box.borderTopWidth) + px(box.borderBottomWidth));
  cb.invoke('cb:resize', want);
}

cb.on('cb:view', (v) => { if (!busy) render(v); });
cb.invoke('cb:view').then(render);
