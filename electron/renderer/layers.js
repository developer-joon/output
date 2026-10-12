import { h, mount, cb } from './dom.js';
import { DIR_LABEL, dirsOf, knobFace, joystickFace } from './widgets.js';
import { actionLabel, autoLabel, POSITION_LABEL } from '../../src/apps/actionLabel.js';
import { groupApps } from '../../src/apps/appGroups.js';
import { pickKeyColor, UNDERGLOW_DEFAULT } from '../../src/apps/keyLed.js';
import { duplicateLayer, slotsOf } from '../../src/apps/layers.js';
import { shortcutConflicts } from '../../src/apps/shortcutConflicts.js';
import { panel } from './panel.js';

/**
 * 설정 창의 레이어 화면 (2026-10-10 settings.js에서 나눔): 키·노브·조이스틱 그림, 키 설정, 저장 안 한 변경.
 * 프리셋 화면도 그림(lyBoard·lyKnob·lyJoystick)을 빌려 쓴다.
 */
const main = document.getElementById('main');
const activeTab = () => document.body.dataset.tabActive;

/** 상태판 '레이어 만들기'가 연 레이어 — 다음 renderLayers에서 고른다 */
let pendingLayer = null;
export function openLayer(id) { pendingLayer = id; }

// ───────────────────────── 레이어 (2026-10-03, 'Orca 키'·'앱별 키' 통합)
// 레이어 = 키 배치 + 연결된 앱. 앞 앱이 연결된 레이어로 동작한다. 장치에는 쓰지 않는다.

let recording = null;    // 단축키 기록 해제 함수 | null

/** keydown → 'cmd+shift+p'. e.code를 써서 한글 입력기 상태와 무관하게 물리 키를 읽는다 */
function keyNameOf(e) {
  const c = e.code;
  if (/^Key[A-Z]$/.test(c)) return c.slice(3).toLowerCase();
  if (/^Digit\d$/.test(c)) return c.slice(5);
  const f = /^F(\d+)$/.exec(c);
  if (f) return `f${f[1]}`;
  const map = {
    Enter: 'enter', Escape: 'esc', Space: 'space', Tab: 'tab', Backspace: 'backspace', Delete: 'delete',
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown',
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Backquote: '`', Comma: ',', Period: '.', Slash: '/',
  };
  return map[c] ?? null;
}

/** 다음 키 조합 하나를 잡는다. 수식 키 단독은 무시, 수식 없는 Esc는 취소 */
function captureKeystroke(onDone) {
  const handler = (e) => {
    if (['Meta', 'Shift', 'Control', 'Alt'].includes(e.key)) return;
    e.preventDefault(); e.stopPropagation();
    const mods = [e.metaKey && 'cmd', e.ctrlKey && 'ctrl', e.altKey && 'alt', e.shiftKey && 'shift'].filter(Boolean);
    if (e.code === 'Escape' && !mods.length) { off(); onDone(null); return; }
    const key = keyNameOf(e);
    if (!key) return;
    off(); onDone([...mods, key].join('+'));
  };
  const off = () => window.removeEventListener('keydown', handler, true);
  window.addEventListener('keydown', handler, true);
  return off;
}

const LY_TYPES = [
  ['none', '없음'], ['shortcut', '단축키'], ['sequence', '매크로 (단축키 여러 개)'], ['openApp', '앱 열기'],
  ['openUrl', 'URL 열기'], ['insertText', '글자 입력'], ['exec', '명령 실행'], ['moveWindow', '앞 창 위치'], ['layout', '레이아웃 (여러 앱 배치)'], ['screenshot', '화면 캡처 (모니터 선택)'],
];
const LY_POSITIONS = Object.entries(POSITION_LABEL);
const LY_SHOT_SAVES = [['desktop', '파일 (스크린샷 저장 위치)'], ['clipboard', '클립보드'], ['both', '파일 + 클립보드']];
const LY_DIR_LABEL = DIR_LABEL;
const lyDirs = dirsOf;

export const ly = { data: null, sel: 'l-orca', slot: null, widget: null, running: null, errors: [], msg: null };
const lyLayer = () => ly.data.find((l) => l.id === ly.sel) ?? ly.data[0];
const lySel = (options, value, onchange, label) => {
  const sel = h('select', { 'aria-label': label, onchange: () => onchange(sel.value) },
    ...options.map(([v, t]) => h('option', { value: String(v), selected: String(v) === String(value) }, t)));
  return sel;
};
const lyDisplay = (v) => (v === 'main' ? 'main' : Number(v));
/**
 * 모니터 목록 (2026-10-12 사용자 요청: 고정 1~4가 아니라 연결된 모니터). 캡처·앞 창 위치·레이아웃 같은 이름·번호
 * (1 = 주 모니터, 나머지는 시스템 순서 = 화면 캡처 번호). 저장된 모니터가 지금 없으면 '연결 안 됨'으로 남겨 설정을 잃지 않는다
 */
function lyDisplaySel(cur, onPick, label) {
  const list = ly.displays ?? [];
  const name = (d) => `${d.n === 1 ? '주 모니터' : `모니터 ${d.n}`}${d.label ? ` · ${d.label}` : ''}`;
  const opts = list.length ? list.map((d) => [d.n === 1 ? 'main' : d.n, name(d)]) : [['main', '주 모니터']];
  if (cur !== 'main' && !list.some((d) => d.n === cur)) opts.push([cur, `모니터 ${cur} (지금 연결 안 됨)`]);
  const sel = lySel(opts, cur, (v) => onPick(lyDisplay(v)), label);
  sel.dataset.displaySelect = '';
  return sel;
}
// 모니터를 꽂거나 빼면 목록을 바로 바꾼다 (모니터 칸이 보일 때만 다시 그린다)
cb.on('cb:displays', (d) => { ly.displays = d; if (document.querySelector('[data-display-select]')) renderLayers(); });

/** 칸 id ↔ 레이어 경로 (keys / dial / joystick.short) */
function lyGet(layer, id) {
  let m;
  if ((m = /^dial_(cw|ccw|press)$/.exec(id))) return layer.dial[m[1]] ?? null;
  if ((m = /^joystick_(.+)$/.exec(id))) return layer.joystick.short[m[1]] ?? null;
  return layer.keys[id] ?? null;
}
function lySet(layer, id, action) {
  let m; let bag; let key;
  if ((m = /^dial_(cw|ccw|press)$/.exec(id))) { bag = layer.dial; key = m[1]; }
  else if ((m = /^joystick_(.+)$/.exec(id))) { bag = layer.joystick.short; key = m[1]; }
  else { bag = layer.keys; key = id; }
  if (action) bag[key] = action; else delete bag[key];
}
function lySlotName(id) {
  if (/^key\d+$/.test(id)) return `키 ${id.slice(3)}`;
  if (id === 'dial_cw') return '노브 시계 방향 ↻';
  if (id === 'dial_ccw') return '노브 반시계 방향 ↺';
  if (id === 'dial_press') return '노브 누름';
  const m = /^joystick_(.+)$/.exec(id);
  return `조이스틱 ${LY_DIR_LABEL[m?.[1]] ?? m?.[1]}`;
}

async function lyApps() {
  ly.running ??= await cb.invoke('cb:apps:running');
  ly.installed ??= await cb.invoke('cb:apps:installed');
  return ly.running;
}

function lyAppPicker(current, onPick, { column = false, placeholder = '앱 고르기…', pickLabel = '응용 프로그램에서…' } = {}) {
  // 묶음: 최근 연결 → 실행 중 → 설치된 앱 (2026-10-09). 고른 앱이 어느 묶음에도 없으면 맨 위에 한 줄
  const curId = current?.bundleId;
  const groups = groupApps({ layers: ly.data ?? [], running: ly.running ?? [], installed: ly.installed ?? [] });
  const all = groups.flatMap((g) => g.apps);
  const extra = curId && !all.some((a) => a.bundleId === curId) ? { bundleId: curId, name: current.appName || current.name || curId } : null;
  const apps = extra ? [extra, ...all] : all;
  const sel = h('select', { 'aria-label': '앱', onchange: () => { const a = apps.find((x) => x.bundleId === sel.value); if (a) onPick(a); } },
    curId ? null : h('option', { value: '' }, placeholder),
    extra ? h('option', { value: extra.bundleId, selected: true }, extra.name) : null,
    ...groups.map((g) => h('optgroup', { label: g.labelKo },
      ...g.apps.map((a) => h('option', { value: a.bundleId, selected: a.bundleId === curId }, a.name)))));
  const pick = h('button', { class: 'btn', onclick: async () => {
    const a = await cb.invoke('cb:apps:pick');
    if (a?.bundleId) onPick(a);
    else if (a?.errorKo) { ly.msg = { tone: 'error', text: a.errorKo }; renderLayers(); }
  }, title: '응용 프로그램 폴더에서 앱 고르기' }, pickLabel);
  return h('div', { class: 'row-flex', style: column ? { flexDirection: 'column', alignItems: 'stretch' } : {} }, sel, pick);
}

function lyKeystrokeInput(obj, key, label, conflict = null) {
  const ks = h('input', { type: 'text', value: obj[key] ?? '', placeholder: '예: cmd+shift+]', class: 'mono', 'aria-label': label });
  // 충돌 경고 (2026-10-10): 같은 레이어의 다른 칸·macOS 단축키와 겹치면 아래에 알린다 (막지는 않는다)
  const warn = h('div', { class: 'small ly-conflict' });
  const check = () => { const w = conflict ? conflict(obj[key]) : []; warn.textContent = w.join(' '); warn.hidden = !w.length; };
  ks.addEventListener('input', () => { obj[key] = ks.value.trim(); check(); });
  check();
  const mine = recording?.owner === obj && recording?.key === key;
  const rec = h('button', { class: 'btn', onclick: () => {
    recording?.off();
    const off = captureKeystroke((s) => { recording = null; if (s) obj[key] = s; if (activeTab() === 'layers') renderLayers(); });
    recording = { off, owner: obj, key };
    renderLayers();
  } }, mine ? '누르세요… (Esc 취소)' : '눌러서 기록');
  return [h('div', { class: 'row-flex' }, ks, rec), warn];
}

const LY_LED_EFFECTS = [['solid', '고정'], ['breathe', '숨쉬기'], ['blink', '깜박임'], ['rainbow', '무지개']];
const LY_LED_SPEEDS = [['slow', '느림'], ['normal', '보통'], ['fast', '빠름']];
const LY_LED_BRIGHT = [['low', '약'], ['mid', '중'], ['high', '강']];
const LY_LED_TIMES = [['short', '짧게 (0.15초)'], ['normal', '보통 (0.3초)'], ['long', '길게 (0.6초)']];
const LED_DEFAULT = {
  normal: { color: 'layer', effect: 'solid', speed: 'normal', brightness: 'mid' },
  press: { color: '#FFFFFF', brightness: 'high', duration: 'short' },
  hold: { color: 'layer', effect: 'solid', speed: 'normal', brightness: 'high' },
};

/** LED 한 부분 편집 (색·움직임·속도·밝기 / 눌렀을 때는 색·밝기·시간) */
function lyLedPart(part, layer, kind) {
  const colorSel = lySel([['layer', '레이어 색'], ['custom', '직접 고르기']], part.color === 'layer' ? 'layer' : 'custom',
    (v) => { part.color = v === 'layer' ? 'layer' : (part.color === 'layer' ? layer.color : part.color); renderLayers(); }, `${kind} 색`);
  const picker = part.color === 'layer' ? null
    : h('input', { type: 'color', value: part.color, 'aria-label': `${kind} 색 고르기`, style: { width: '44px', height: '28px', padding: 0, flex: '0 0 auto' } });
  picker?.addEventListener('input', () => { part.color = picker.value.toUpperCase(); });
  const row = [h('label', {}, '색'), h('div', { class: 'row-flex' }, colorSel, picker)];
  if (kind !== '눌렀을 때') {
    row.push(h('label', {}, '움직임'), lySel(LY_LED_EFFECTS, part.effect, (v) => { part.effect = v; renderLayers(); }, `${kind} 움직임`));
    if (part.effect !== 'solid') row.push(h('label', {}, '속도'), lySel(LY_LED_SPEEDS, part.speed, (v) => { part.speed = v; }, `${kind} 속도`));
    if (part.effect === 'rainbow') row.push(h('div', { class: 'small muted' }, '무지개는 장치가 색을 돌려서 색 설정은 쓰지 않습니다.'));
  }
  row.push(h('label', {}, '밝기'), lySel(LY_LED_BRIGHT, part.brightness, (v) => { part.brightness = v; }, `${kind} 밝기`));
  if (kind === '눌렀을 때') row.push(h('label', {}, '시간'), lySel(LY_LED_TIMES, part.duration, (v) => { part.duration = v; }, '눌렀을 때 시간'));
  // 이름 : 선택 두 칸 격자 (무지개 안내처럼 한 줄짜리는 두 칸을 다 쓴다)
  return [h('div', { class: 'led-part' }, ...row)];
}

/**
 * 키 칸의 고급 설정 (2026-10-09 사용자 요청): 누르고 있으면 반복(단축키, 기본 켬) · LED 평소·눌렀을 때·누르고 있을 때.
 * 손대지 않으면 기본값(반복 켬, LED 레이어 색·고정·중)이다. 무엇이든 기본과 다르면 열린 채로 보인다.
 */
function lyAdvanced(a, layer) {
  const rows = [];
  if (a.type === 'shortcut') {
    const c = h('input', { type: 'checkbox', checked: a.repeat !== false, 'aria-label': '누르고 있으면 반복' });
    c.addEventListener('change', () => { if (c.checked) delete a.repeat; else a.repeat = false; });
    rows.push(h('label', { class: 'led-toggle' }, c, '누르고 있으면 반복 (macOS 키 반복 속도)'));
  }
  // 색은 키마다 무작위가 기본이라 '바꿨는지'에서 뺀다 — 움직임·속도·밝기와 눌렀을 때·누르고 있을 때만 본다
  const plain = (n) => JSON.stringify({ ...n, color: undefined });
  const ledCustom = a.led && (a.led.press || a.led.hold || plain(a.led.normal) !== plain(LED_DEFAULT.normal));
  return h('details', { class: 'ly-adv', open: Boolean(a.repeat === false || ledCustom) },
    h('summary', {}, '고급 — 반복 · LED'), ...rows, lyLedEditor(a, layer));
}

function lyLedEditor(a, layer) {
  // 열기만 해서는 저장할 값을 만들지 않는다 (2026-10-10: 저장 안 한 변경 표시가 보기만 해도 켜지지 않게).
  // LED 칸을 실제로 바꾸는 순간(아래 capture 단계) 이 값이 키에 붙는다
  const led = a.led ?? structuredClone({ normal: LED_DEFAULT.normal, press: null, hold: null });
  const adv = (key, kind) => {
    const on = Boolean(led[key]);
    const toggle = h('label', { class: 'led-toggle' },
      h('input', { type: 'checkbox', checked: on, onchange: (e) => { a.led = led; led[key] = e.target.checked ? structuredClone(LED_DEFAULT[key]) : null; renderLayers(); } }),
      kind);
    return [toggle, ...(on ? lyLedPart(led[key], layer, kind) : [])];
  };
  const box = h('div', { class: 'led-box' }, h('h4', {}, 'LED'), ...lyLedPart(led.normal, layer, '평소'),
    ...adv('press', '눌렀을 때'), ...adv('hold', '누르고 있을 때'));
  // 칸을 바꾸면(자식 처리보다 먼저) 이 키에 LED 값을 붙인다
  for (const ev of ['input', 'change']) box.addEventListener(ev, () => { a.led ??= led; }, true);
  return box;
}

/** 칸 하나의 편집기 */
function lyEditor(layer, slotId) {
  const a = lyGet(layer, slotId) ?? { type: 'none', label: '' };
  const types = LY_TYPES;     // Orca 동작은 Orca 프리셋에만 있다 (2026-10-04)
  const setType = (t) => {
    // 동작 종류를 바꿔도 이름과 키 LED 설정은 남긴다 (최종 리뷰)
    const fresh = { type: t, label: a.label || '', ...(a.led ? { led: a.led } : {}) };
    // 키에 처음 동작을 넣을 때 LED 기본 색은 무작위 (2026-10-09) — 레이어에서 이미 쓴 색은 피한다
    if (!a.led && a.type === 'none' && t !== 'none' && /^key\d+$/.test(slotId)) {
      const used = Object.values(layer.keys ?? {}).map((x) => x?.led?.normal?.color).filter((c) => c && c !== 'layer');
      fresh.led = { normal: { ...LED_DEFAULT.normal, color: pickKeyColor(used) }, press: null, hold: null };
    }
    if (t === 'sequence') fresh.steps = [{ keystroke: '', delayMs: 0 }];
    if (t === 'moveWindow') Object.assign(fresh, { position: 'left', display: 'main' });
    if (t === 'screenshot') Object.assign(fresh, { display: 'main', save: 'desktop' });
    if (t === 'layout') fresh.items = [{ bundleId: '', appName: '', position: 'left', display: 'main' }];
    lySet(layer, slotId, t === 'none' ? null : fresh);
    renderLayers();
  };
  const body = [h('h3', {}, lySlotName(slotId)), lySel(types, a.type, setType, '동작 종류')];
  if (a.type === 'none') return h('div', { class: 'card ly-editor' }, ...body, h('div', { class: 'small muted' }, '이 칸은 아무것도 하지 않습니다.'));
  // 단축키·앱 열기·앞 창 위치는 비우면 자동 이름 (2026-10-09). 이름을 넣지 않았으면 입력 칸 대신 자동 이름과
  // '이름 바꾸기'만 보인다 (2026-10-10 사용자 요청) — 단축키를 바꾸면 자동 이름도 바로 따라 바뀐다
  const auto = autoLabel(a);
  if (LY_AUTO_NAMED.includes(a.type) && !a.label && ly.nameEdit !== slotId) {
    const span = h('strong', { class: 'ly-auto-name' }, auto || '—');
    lyAuto = { el: span, a };
    body.push(h('label', {}, '이름'), h('div', { class: 'row-flex' }, span, h('span', { class: 'small muted' }, '(자동)'), h('span', { class: 'grow' }),
      h('button', { class: 'btn small', onclick: () => {
        ly.nameEdit = slotId;
        renderLayers();
        setTimeout(() => document.querySelector('.ly-editor input[aria-label="이름"]')?.focus());
      } }, '이름 바꾸기')));
  } else {
    lyAuto = null;
    const label = h('input', { type: 'text', value: a.label, placeholder: auto ? `비우면 '${auto}'` : '이름 (상태판·로그에 보임)', 'aria-label': '이름' });
    label.addEventListener('input', () => { a.label = label.value; });
    body.push(h('label', {}, '이름'), label);
  }
  const text = (k, ph, mono = false, area = false) => {
    const el = h(area ? 'textarea' : 'input', { type: 'text', placeholder: ph, class: mono ? 'mono' : '', rows: area ? 4 : undefined, 'aria-label': ph });
    el.value = a[k] ?? '';
    el.addEventListener('input', () => { a[k] = el.value; });
    return el;
  };
  switch (a.type) {
    case 'shortcut':
      body.push(h('label', {}, '단축키'), lyKeystrokeInput(a, 'keystroke', '단축키', (k) => shortcutConflicts(k, slotId, slotsOf(layer))));
      break;
    case 'sequence':
      body.push(h('label', {}, '단계 (위에서부터 차례로)'));
      a.steps.forEach((s, i) => {
        const d = h('input', { type: 'number', min: 0, max: 5000, value: s.delayMs, style: { width: '80px' }, 'aria-label': `${i + 1}단계 뒤 지연` });
        d.addEventListener('input', () => { s.delayMs = Number(d.value) || 0; });
        body.push(h('div', { class: 'row-flex' }, h('span', { class: 'mono small' }, `${i + 1}`), lyKeystrokeInput(s, 'keystroke', `${i + 1}단계 단축키`), d, h('span', { class: 'small muted' }, 'ms'),
          h('button', { class: 'btn', onclick: () => { a.steps.splice(i, 1); renderLayers(); } }, '삭제')));
      });
      if (a.steps.length < 20) body.push(h('button', { class: 'btn', onclick: () => { a.steps.push({ keystroke: '', delayMs: 0 }); renderLayers(); } }, '단계 추가'));
      break;
    case 'openApp': body.push(h('label', {}, '앱'), lyAppPicker(a, (p) => { a.bundleId = p.bundleId; a.appName = p.name; renderLayers(); })); break;
    case 'openUrl': body.push(h('label', {}, 'URL'), text('url', 'https://…', true)); break;
    case 'insertText': body.push(h('label', {}, '입력할 글자'), text('text', '자주 쓰는 문구', false, true)); break;
    case 'exec':
      body.push(h('label', {}, '명령'), text('command', '예: open ~/Downloads', true),
        h('div', { class: 'notice warn' }, '키를 누르면 이 명령을 바로 실행합니다 (zsh). 믿을 수 있는 명령만 넣으세요.'));
      break;
    case 'moveWindow':
      body.push(h('label', {}, '위치'), lySel(LY_POSITIONS, a.position, (v) => { a.position = v; }, '위치'),
        h('label', {}, '모니터'), lyDisplaySel(a.display, (v) => { a.display = v; }, '모니터'));
      break;
    case 'screenshot':
      body.push(h('label', {}, '모니터'), lyDisplaySel(a.display, (v) => { a.display = v; }, '캡처할 모니터'),
        h('label', {}, '저장'), lySel(LY_SHOT_SAVES, a.save, (v) => { a.save = v; }, '캡처 저장'),
        h('div', { class: 'small muted' }, '지금 연결된 모니터가 보입니다 (주 모니터 = 메뉴 막대가 있는 화면). 처음 찍을 때 화면 기록 권한을 묻습니다.'));
      break;
    case 'layout':
      body.push(h('label', {}, '앱 · 위치 · 모니터 (아래 앱일수록 나중에 열리고 마지막 앱이 앞에 옴)'));
      a.items.forEach((it, i) => {
        body.push(h('div', { class: 'card' },
          lyAppPicker(it, (p) => { it.bundleId = p.bundleId; it.appName = p.name; renderLayers(); }),
          h('div', { class: 'row-flex' },
            lySel(LY_POSITIONS, it.position, (v) => { it.position = v; }, `${i + 1}번째 위치`),
            lyDisplaySel(it.display, (v) => { it.display = v; }, `${i + 1}번째 모니터`),
            h('button', { class: 'btn', disabled: i === 0, onclick: () => { a.items.splice(i - 1, 0, a.items.splice(i, 1)[0]); renderLayers(); } }, '↑'),
            h('button', { class: 'btn', onclick: () => { a.items.splice(i, 1); renderLayers(); } }, '삭제'))));
      });
      if (a.items.length < 8) body.push(h('button', { class: 'btn', onclick: () => { a.items.push({ bundleId: '', appName: '', position: 'right', display: 'main' }); renderLayers(); } }, '앱 추가'));
      break;
    default: break;
  }
  // 지금 실행해 보기 (2026-10-10: 모든 동작). 키 입력·앞 창 위치는 3초 뒤 — 그 사이 보낼 앱을 앞으로
  const later = ['shortcut', 'sequence', 'insertText', 'moveWindow'].includes(a.type);
  const tryBtn = h('button', { class: 'btn', onclick: async () => {
    tryBtn.disabled = true;
    if (later) tryBtn.textContent = '3초 뒤 실행 — 보낼 앱을 앞으로…';
    const r = await cb.invoke('cb:action:try', a);
    ly.msg = { tone: r.ok ? 'info' : 'error', text: r.ok ? `'${actionLabel(a)}'을(를) 실행했습니다.` : r.reasonKo ?? r.errorKo };
    renderLayers();
  } }, later ? '3초 뒤 실행해 보기' : '지금 실행해 보기');
  if (later) tryBtn.title = '누른 뒤 3초 안에 보낼 앱을 앞으로 가져오세요';
  // 제목 줄 오른쪽에 둔다 — 키 설정이 길어져 스크롤이 생기지 않게 (2026-10-10)
  body[0] = h('div', { class: 'row-flex ly-ed-head' }, body[0], h('span', { class: 'grow' }), tryBtn);
  if (/^key\d+$/.test(slotId)) body.push(lyAdvanced(a, layer));   // 고급: 반복·LED (2026-10-09) — 노브·조이스틱엔 없음
  return h('div', { class: 'card ly-editor' }, ...body);
}

/** 프리셋이 정한 칸인가 (프리셋 화면은 전부, 프리셋 레이어는 프리셋이 정한 칸만) */
const slotLocked = (layer, id) => Boolean(layer.locked || layer.lockedSlots?.has(id));

function lyKey(layer, n) {
  const id = `key${n}`;
  const used = ly.usage?.[layer.id]?.[id] ?? 0;
  const badge = used ? h('span', { class: 'kc-count', title: `오늘 ${used}번 눌렀습니다` }, String(used)) : null;
  const ledColor = (a) => (a?.led?.normal && a.led.normal.color !== 'layer' ? a.led.normal.color : layer.color);
  if (slotLocked(layer, id)) {
    // 프리셋 키도 LED 색을 테두리로 보인다 (2026-10-10: 추천 프리셋 키 색이 화면에 안 보였다)
    const pa = layer.keys[id];
    return h('div', { class: 'kc locked', title: '프리셋 칸 (고칠 수 없음)', style: pa?.led ? { boxShadow: `inset 0 0 0 2px ${ledColor(pa)}` } : {} },
      h('span', { class: 'code' }, layer.keyLabels?.[id] ?? layer.keys[id]?.label ?? '—'), h('span', { class: 'hint' }, `키 ${n}`), badge);
  }
  const a = layer.keys[id];
  return h('button', {
    class: 'kc', dataset: { layerSlot: id }, 'aria-pressed': String(ly.slot === id), 'aria-label': `키 ${n} ${a ? actionLabel(a) : '비어 있음'}`,
    // 키 LED 평소 색을 미리 보기 (직접 고른 색이면 그 색), 움직임은 hint에 한 글자
    style: a ? { boxShadow: `inset 0 0 0 2px ${ledColor(a)}` } : {},
    // 키를 고르면 열려 있던 노브·조이스틱 그림은 닫는다 (두 곳이 선택돼 보이지 않게)
    onclick: () => { ly.slot = id; ly.widget = null; renderLayers(); },
  }, h('span', { class: 'code' }, a ? actionLabel(a) : '—'),
  h('span', { class: 'hint' }, `키 ${n}${a?.led?.normal?.effect && a.led.normal.effect !== 'solid' ? ` · ${({ breathe: '숨', blink: '깜', rainbow: '무' })[a.led.normal.effect]}` : ''}`), badge);
}

/** 노브 그림: 둥근 다이얼 왼쪽 ↺ · 오른쪽 ↻ */
export function lyKnob(layer) {
  const part = (dir) => {
    const id = `dial_${dir}`;
    const a = layer.dial[dir];
    const locked = slotLocked(layer, id);
    return {
      class: locked ? 'is-locked' : '', title: locked ? '프리셋 칸 (고칠 수 없음)' : null, dataset: { layerSlot: id }, 'aria-pressed': String(ly.slot === id), 'aria-label': `${lySlotName(id)} ${a ? actionLabel(a) : '비어 있음'}`,
      onclick: locked ? null : () => { ly.slot = id; renderLayers(); },
    };
  };
  const labels = Object.fromEntries(['ccw', 'cw', 'press'].map((d) => [d, (layer.dial[d] ? actionLabel(layer.dial[d]) : '')]));
  return h('div', { class: `ly-widget${layer.locked ? ' ly-locked' : ''}` }, h('div', { class: 'ly-title' }, '노브'),
    knobFace({ labels, color: layer.color, on: (d) => Boolean(layer.dial[d]), part }));
}

/** 조이스틱 그림: 방향 수만큼 부채꼴. 칸을 고르는 곳은 여기 하나 (길게는 2026-10-12에 없앰 — 설정의 '유지해야 입력') */
export function lyJoystick(layer, redraw = renderLayers) {
  const j = layer.joystick;
  const seg = (opts, cur, onPick, label) => h('div', { class: 'layers ly-seg', role: 'group', 'aria-label': label },
    ...opts.map(([v, t]) => h('button', { 'aria-pressed': String(String(v) === String(cur)), onclick: () => onPick(v) }, t)));
  const dirs = lyDirs(j.directions, j.axis);
  const bag = j.short;
  const prefix = 'joystick_';
  const box = joystickFace({
    dirs, labels: Object.fromEntries(dirs.map((d) => [d, (bag[d] ? actionLabel(bag[d]) : '')])), color: layer.color, on: (d) => Boolean(bag[d]),
    wedge: (d) => {
      const id = prefix + d;
      const a = bag[d];
      const locked = slotLocked(layer, id);
      return {
        attrs: { class: `ly-wedge${ly.slot === id ? ' sel' : ''}${locked ? ' is-locked' : ''}`, 'data-layer-slot': id, role: 'button', tabindex: 0, 'aria-label': `${lySlotName(id)} ${a ? actionLabel(a) : '비어 있음'}` },
        onClick: locked ? null : () => { ly.slot = id; renderLayers(); },
      };
    },
  });
  return h('div', { class: `ly-widget${layer.locked ? ' ly-locked' : ''}` }, h('div', { class: 'ly-title' }, '조이스틱'),
    layer.locked || layer.fixedDirections ? null : seg([[1, '1'], [2, '2'], [4, '4'], [8, '8']], j.directions, (v) => { j.directions = Number(v); ly.slot = null; renderLayers(); }, '방향 수'),
    !layer.locked && !layer.fixedDirections && j.directions === 2 ? seg([['vertical', '위/아래'], ['horizontal', '왼쪽/오른쪽']], j.axis, (v) => { j.axis = v; ly.slot = null; renderLayers(); }, '축') : null,
    box,
    h('div', { class: 'small muted' }, layer.locked ? '프리셋 칸은 볼 수만 있습니다.' : layer.fixedDirections ? '진한 칸은 프리셋 칸, 빈 칸은 눌러서 정합니다.' : '부채꼴을 눌러 동작을 정하세요.'));
}

/** 레이어 머리: 이름·색·연결된 앱 */
function lyHeader(layer) {
  // 카드 세 줄 (2026-10-10 사용자 요청): 1 이름·삭제 / 2 키 배치·언더글로우(색·움직임·밝기·속도) / 3 연결된 앱.
  // 줄마다 높이를 고정해 레이어를 바꿔도 흔들리지 않는다
  const fixed = layer.kind === 'default';
  const name = fixed ? h('strong', {}, layer.name) : h('input', { type: 'text', value: layer.name, 'aria-label': '레이어 이름', class: 'ly-name' });
  if (!fixed) name.addEventListener('input', () => { layer.name = name.value; });
  const row1 = h('div', { class: 'row-flex ly-row' }, h('span', { class: 'small muted ly-cap' }, '이름'), name, h('span', { class: 'grow' }),
    fixed ? h('span', { class: 'small muted' }, '기본 레이어는 지울 수 없습니다')
      : h('button', { class: 'btn danger', onclick: () => { ly.data = ly.data.filter((l) => l !== layer); ly.sel = 'default'; ly.slot = null; renderLayers(); } }, '이 레이어 삭제'));
  // 복제 (2026-10-10): 앱은 비운 복사본. 저장해야 반영된다
  row1.insertBefore(h('button', { class: 'btn', title: '키 배치·동작·언더글로우를 복사한 새 레이어 (앱 연결은 비움)', onclick: () => {
    const c = duplicateLayer(layer, ly.data, `l-copy-${Date.now().toString(36)}`);
    ly.data.push(c); ly.sel = c.id; ly.slot = null;
    ly.msg = { tone: 'info', text: `'${c.name}'을(를) 만들었습니다. 앱을 연결하고 저장하세요.` };
    renderLayers();
  } }, '복제'), row1.lastChild);

  const presetSel = lySel([['', '직접 설정'], ...lyPresets.list.map((p) => [p.id, `프리셋: ${p.name}`])], layer.preset ?? '',
    (v) => { layer.preset = v || null; ly.slot = null; renderLayers(); }, '키 배치');
  // 레이어 색 = 언더글로우 색 (2026-10-10). '레이어 색'으로 둔 키도 이 색을 따른다
  const color = h('input', { type: 'color', value: layer.color, 'aria-label': '언더글로우 색 (레이어 색)', title: '레이어 색 — 언더글로우와 \'레이어 색\' 키가 이 색', class: 'ly-color' });
  color.addEventListener('input', () => { layer.color = color.value.toUpperCase(); });
  let ug;
  if (layer.preset === 'orca') {
    ug = [h('span', { class: 'small muted ly-cap' }, '언더글로우'), color, h('span', { class: 'small muted ly-ug-fixed', title: '승인 주황·답변 살구 빠른 숨쉬기 · 오류 빨강 빠른 깜박임 · 진행 중 호박 회전 · 완료·미확인 청록 · 중단됨 회색 · 평온 초록 느린 숨쉬기' }, 'Orca 상태 (프리셋 고정)')];
  } else {
    // 보기만 해서는 값을 만들지 않는다 — 칸을 바꾸는 순간 레이어에 붙는다 (저장 안 한 변경 표시)
    const u = layer.underglow ?? { ...UNDERGLOW_DEFAULT };
    const attach = () => { layer.underglow ??= u; };
    const sel = (opts, key, label) => lySel(opts, u[key], (v) => { attach(); u[key] = v; if (key === 'effect') speed.disabled = v === 'solid'; }, label);
    const speed = sel(LY_LED_SPEEDS, 'speed', '언더글로우 속도');
    speed.disabled = u.effect === 'solid';   // 고정이면 회색으로 — 칸을 숨기지 않아 흔들리지 않는다
    const sub = (t) => h('span', { class: 'small muted ly-sub' }, t);
    ug = [h('span', { class: 'small muted ly-cap' }, '언더글로우'), color,
      sub('움직임'), sel(LY_LED_EFFECTS, 'effect', '언더글로우 움직임'), sub('밝기'), sel(LY_LED_BRIGHT, 'brightness', '언더글로우 밝기'), sub('속도'), speed];
  }
  const row2 = h('div', { class: 'row-flex ly-row' }, h('span', { class: 'small muted ly-cap' }, '키 배치'), presetSel, h('span', { class: 'ly-sep' }), ...ug);

  let apps;
  if (fixed) apps = h('span', { class: 'small muted' }, '다른 레이어에 연결되지 않은 모든 앱');
  else {
    apps = h('div', { class: 'row-flex ly-apps' },
      h('div', { class: 'ly-app-chips' }, ...layer.apps.map((a) => h('span', { class: 'ly-chip' }, a.name, h('button', { 'aria-label': `${a.name} 연결 끊기`, onclick: () => { layer.apps = layer.apps.filter((x) => x.bundleId !== a.bundleId); renderLayers(); } }, '×')))),
      lyAppPicker(null, (p) => {
        const prev = ly.data.find((l) => l.kind === 'user' && l !== layer && l.apps.some((x) => x.bundleId === p.bundleId));
        if (prev) { prev.apps = prev.apps.filter((x) => x.bundleId !== p.bundleId); ly.msg = { tone: 'info', text: `'${p.name}'을(를) '${prev.name}' 레이어에서 옮겼습니다.` }; }
        if (!layer.apps.some((x) => x.bundleId === p.bundleId)) layer.apps.push({ bundleId: p.bundleId, name: p.name });
        renderLayers();
      }, { placeholder: '+ 앱 연결', pickLabel: '앱 찾기…' }));
  }
  const row3 = h('div', { class: 'row-flex ly-row' }, h('span', { class: 'small muted ly-cap' }, '연결된 앱'), apps);
  return h('div', { class: 'card ly-head ly-head3' }, row1, row2, row3);
}

export const lyPresets = { list: null };
/** 프리셋이 정한 칸 id (서버 presetLockedSlots와 같은 규칙) */
function lyLockedOf(p) {
  // 이름만 있는 키(Orca 작업 칸) + 동작을 정한 키(추천 프리셋, 2026-10-10) — presetLockedSlots와 같은 규칙
  const s = new Set([...Object.keys(p.keyLabels ?? {}), ...Object.keys(p.keys ?? {})]);
  for (const k of Object.keys(p.dial)) s.add(`dial_${k}`);
  for (const d of Object.keys(p.joystick?.short ?? {})) s.add(`joystick_${d}`);
  return s;
}
/** 프리셋을 연결한 레이어의 그림용 보기: 프리셋 칸은 잠그고, 빈 칸은 레이어 것을 보여 준다 (2026-10-04) */
function lyPresetView(layer) {
  const p = lyPresets.list.find((x) => x.id === layer.preset);
  // 조이스틱을 정하지 않은 프리셋(Orca)이면 조이스틱은 방향 수까지 레이어 것
  const j = p.joystick
    ? { directions: p.joystick.directions, axis: p.joystick.axis, short: { ...layer.joystick.short, ...p.joystick.short } }
    : layer.joystick;
  return { ...layer, lockedSlots: lyLockedOf(p), fixedDirections: Boolean(p.joystick), keyLabels: p.keyLabels,
    keys: { ...layer.keys, ...p.keys }, dial: { ...layer.dial, ...p.dial }, joystick: j };
}

/** 장치 그림 (레이어·프리셋 화면 공용). 노브·조이스틱은 칸을 눌러 옆에 연다 */
export function lyBoard(layer, redraw, { toggles = true, st = ly } = {}) {
  const widgetBtn = (w, label, round) => (!toggles
    ? h('div', { class: `kc static${round ? ' round' : ''}` }, h('span', { class: 'code' }, label), h('span', { class: 'hint' }, '옆 그림'))
    : h('button', {
    class: `kc${round ? ' round' : ''}`, 'aria-pressed': String(st.widget === w), 'aria-label': `${label} 설정 열기`,
    onclick: () => { st.widget = st.widget === w ? null : w; ly.slot = null; redraw(); },
  }, h('span', { class: 'code' }, label), h('span', { class: 'hint' }, st.widget === w ? '닫기' : '열기')));
  return h('div', { class: 'board' },
    widgetBtn('knob', '노브', false),
    lyKey(layer, 1), lyKey(layer, 2),
    widgetBtn('joystick', '조이스틱', true),
    [3, 4, 5, 6].map((n) => lyKey(layer, n)),
    [7, 8, 9, 10].map((n) => lyKey(layer, n)),
    h('div', { class: 'kc static' }, h('span', { class: 'hint' }, '미니 LED')),
    lyKey(layer, 11), lyKey(layer, 12), lyKey(layer, 13));
}


/**
 * 알림 토스트 (2026-10-10): 화면 위에 끼워 넣지 않고 오른쪽 아래에 띄운다 — 레이아웃이 밀리지 않게.
 * 일반 알림은 4초 뒤 사라지고, 오류·Orca 연결 경고는 닫을 때까지 남는다
 */
function lyToasts(orcaUnlinked) {
  const box = h('div', { class: 'ly-toasts', role: 'status', 'aria-live': 'polite' });
  const close = (onClose) => h('button', { class: 'toast-x', 'aria-label': '닫기', onclick: (e) => { onClose(); e.target.closest('.notice')?.remove(); } }, '×');
  if (ly.errors.length) {
    box.append(h('div', { class: 'notice error' }, h('ul', { class: 'errors' }, ly.errors.map((e) => h('li', {}, e))), close(() => { ly.errors = []; })));
  }
  if (orcaUnlinked && !ly.orcaWarnClosed) {
    box.append(h('div', { class: 'notice warn' }, 'Orca가 앞에 와도 작업 칸·상태 LED가 동작하지 않습니다. Orca 프리셋 레이어에 Orca를 연결하세요. (저장된 설정 기준)',
      close(() => { ly.orcaWarnClosed = true; })));
  }
  if (ly.msg) {
    const m = ly.msg;
    const el = h('div', { class: `notice ${m.tone}` }, m.text, close(() => { if (ly.msg === m) ly.msg = null; }));
    box.append(el);
    if (m.tone !== 'error') setTimeout(() => { if (ly.msg === m) ly.msg = null; el.remove(); }, 4000);
  }
  return box;
}

/** 저장 안 한 변경이 있나 (2026-10-10). 불러온 그대로와 비교한다 */
export function lyDirty() {
  return Boolean(ly.data && ly.saved !== undefined && JSON.stringify(ly.data) !== ly.saved);
}

/** 자동 이름을 보이는 키 편집기 (2026-10-10): 단축키·앱·위치를 바꾸면 그 자리에서 이름을 다시 쓴다 */
const LY_AUTO_NAMED = ['shortcut', 'openApp', 'moveWindow', 'screenshot'];
let lyAuto = null;

/** 입력할 때마다(다시 그리지 않아도) 저장 버튼 표시를 맞춘다 */
function lyDirtyUi() {
  if (lyAuto?.el.isConnected) lyAuto.el.textContent = autoLabel(lyAuto.a) || '—';
  const dirty = lyDirty();
  const btn = document.querySelector('[data-ly-save]');
  if (btn) { btn.classList.toggle('dirty', dirty); btn.textContent = dirty ? '저장 •' : '저장'; }
  const note = document.querySelector('[data-ly-dirty]');
  if (note) note.classList.toggle('is-off', !dirty);   // 자리를 비워 두고 글자만 숨긴다 (흔들림 없음)
}
main.addEventListener('input', () => { if (activeTab() === 'layers') setTimeout(lyDirtyUi); }, true);
main.addEventListener('change', () => { if (activeTab() === 'layers') setTimeout(lyDirtyUi); }, true);
// 저장하지 않고 닫으려 하면 메인 프로세스가 묻는다 (will-prevent-unload)
window.addEventListener('beforeunload', (e) => { if (lyDirty()) { e.preventDefault(); e.returnValue = ''; } });

/** 되돌리기·저장 버튼 */
function lySaveButtons() {
  const dirty = lyDirty();
  return [
    h('span', { class: `small ly-dirty${dirty ? '' : ' is-off'}`, dataset: { lyDirty: '' } }, '저장 안 한 변경이 있습니다'),
    h('button', { class: 'btn', onclick: () => { ly.data = null; ly.errors = []; ly.msg = null; ly.slot = null; renderLayers(); } }, '되돌리기'),
    h('button', { class: `btn primary${dirty ? ' dirty' : ''}`, onclick: async (e) => {
      // 저장 직후 다시 불러오는 사이(ly.data = null)의 두 번째 클릭이 빈 값을 저장하지 않게
      if (!ly.data || ly.saving) return;
      ly.saving = true; e.target.disabled = true;
      let r;
      try { r = await cb.invoke('cb:layers:save', ly.data); } finally { ly.saving = false; }
      ly.errors = r.ok ? [] : r.errorsKo ?? [r.errorKo];
      ly.msg = r.ok ? { tone: 'info', text: '저장했습니다.' } : null;
      if (r.ok) ly.data = null;
      renderLayers();
    }, dataset: { lySave: '' } }, dirty ? '저장 •' : '저장'),
  ];
}

export async function renderLayers() {
  if (pendingLayer) {
    // 서비스가 막 만든 레이어: 저장 안 한 변경이 없으면 새로 읽고, 있으면 그 레이어만 붙인다
    const fresh = await cb.invoke('cb:layers:get');
    if (!ly.data || !lyDirty()) { ly.data = fresh; ly.saved = JSON.stringify(fresh); }
    else if (!ly.data.some((l) => l.id === pendingLayer)) { const n = fresh.find((l) => l.id === pendingLayer); if (n) ly.data.push(n); }
    ly.sel = pendingLayer; ly.slot = null; pendingLayer = null;
  }
  if (!ly.data) { ly.data = await cb.invoke('cb:layers:get'); ly.saved = JSON.stringify(ly.data); }
  // 고른 레이어가 없어졌으면(되돌리기·가져오기·삭제) 첫 레이어를 고른다 — 목록에서 아무것도 강조되지 않는 일이 없게 (2026-10-10)
  if (!ly.data.some((l) => l.id === ly.sel)) { ly.sel = ly.data[0]?.id ?? 'default'; ly.slot = null; }
  lyPresets.list ??= await cb.invoke('cb:presets:list');
  ly.usage = await cb.invoke('cb:usage:get').catch(() => ({}));   // 오늘 키별 사용 횟수 (2026-10-10)
  ly.displays = await cb.invoke('cb:displays').catch(() => ly.displays ?? []);   // 연결된 모니터 (2026-10-12)
  await lyApps();
  const orcaUnlinked = await cb.invoke('cb:layers:orcaUnlinked');
  const layer = lyLayer();
  const shown = layer.preset ? lyPresetView(layer) : layer;

  const list = h('div', { class: 'layers ly-list' },
    ...ly.data.map((l) => h('button', { 'aria-pressed': String(ly.sel === l.id), onclick: () => { ly.sel = l.id; ly.slot = null; renderLayers(); } },
      h('span', { class: 'ly-dot', style: { background: l.color } }), ` ${l.name || '(이름 없음)'}`,
      l.preset ? h('span', { class: 'small muted' }, ` · 프리셋 ${lyPresets.list.find((p) => p.id === l.preset)?.name ?? l.preset}`) : null,
      l.kind === 'user' ? h('span', { class: 'small muted' }, ` · 앱 ${l.apps.length}`) : null)),
    h('button', { class: 'btn', onclick: () => {
      const id = `l-new-${Date.now()}`;
      // 다른 레이어와 겹치지 않는 색 (2026-10-10)
      ly.data.push({ id, kind: 'user', name: '새 레이어', color: pickKeyColor(ly.data.map((l) => l.color)), preset: null, apps: [], keys: {}, dial: {}, joystick: { directions: 4, axis: 'vertical', short: {} } });
      ly.sel = id; ly.slot = null; renderLayers();
    } }, '+ 레이어'));
  // 고른 레이어가 보이게 옆으로 스크롤 (세로는 움직이지 않는다)
  setTimeout(() => { const b = document.querySelector('.ly-list [aria-pressed="true"]'); b?.parentElement?.scrollTo?.({ left: Math.max(0, b.offsetLeft - 40), behavior: 'smooth' }); });

  const page = panel('레이어', [
    '위에서 레이어를 고르거나 + 레이어로 만듭니다.',
    '앱 연결: 이 레이어를 쓸 앱을 고릅니다. 어느 레이어에도 연결 안 된 앱은 \'기본\'을 씁니다.',
    '키 배치: 직접 설정 또는 프리셋. 프리셋이 정한 칸은 잠기고, 빈 칸은 직접 정할 수 있습니다.',
    '키를 누르거나, 노브·조이스틱 칸을 눌러 아래 그림을 열고 칸을 골라 동작을 정합니다. 키 설정은 오른쪽에 나옵니다.',
    '저장을 누르면 바로 반영됩니다. 장치에는 쓰지 않습니다.',
    '키 설정의 고급: 누르고 있으면 반복(기본 켬)과 LED(평소·눌렀을 때·누르고 있을 때)를 바꿉니다. 손대지 않으면 기본값입니다.',
    '언더글로우: 레이어 카드 둘째 줄에서 색(= 레이어 색)·움직임·밝기·속도. Orca 레이어는 Orca 상태로 고정입니다.',
    '단축키·글자 입력에는 손쉬운 사용, 창 이동에는 자동화 권한이 필요합니다.',
  ],
    // 흔들림 없게 (2026-10-10 사용자 요청): 알림은 오른쪽 아래 토스트, 위는 높이가 정해진 두 줄 —
    // 동작 줄(저장 안 한 변경 · 내보내기·가져오기·되돌리기·저장)과 한 줄 레이어 목록(길면 옆으로 스크롤)
    lyToasts(orcaUnlinked),
    h('div', { class: 'row-flex ly-actions' }, lySaveButtons()[0], h('span', { class: 'grow' }),
      h('button', { class: 'btn', title: '레이어 전부를 JSON 파일로', onclick: async () => {
        const r = await cb.invoke('cb:layers:export');
        if (!r.canceled) { ly.msg = { tone: r.ok ? 'info' : 'error', text: r.messageKo ?? '내보내지 못했습니다.' }; renderLayers(); }
      } }, '내보내기'),
      h('button', { class: 'btn', title: '내보낸 파일을 불러와 저장 전 확인', onclick: async () => {
        const r = await cb.invoke('cb:layers:import');
        if (r.canceled) return;
        if (r.ok) { ly.data = r.layers; ly.sel = r.layers[0]?.id ?? 'default'; ly.slot = null; ly.errors = []; ly.msg = { tone: 'info', text: '가져왔습니다. 확인하고 저장을 누르면 적용됩니다.' }; }
        else { ly.errors = r.errorsKo ?? ['가져오지 못했습니다.']; ly.msg = null; }
        renderLayers();
      } }, '가져오기'),
      ...lySaveButtons().slice(1)),
    list,
    h('div', { class: 'cols' },
      h('div', { class: 'ly-main' }, lyHeader(layer),
        // 왼쪽 = 장치 그림(노브·조이스틱 그림은 그 아래), 오른쪽 = 키 설정 — 스크롤해도 오른쪽은 보인다 (2026-10-09 사용자 요청)
        h('div', { class: 'ly-work' },
          h('div', { class: 'ly-left' }, lyBoard(shown, renderLayers),
            ly.widget === 'knob' ? lyKnob(shown) : ly.widget === 'joystick' ? lyJoystick(shown) : null),
          h('div', { class: 'ly-right' },
            ly.slot && !slotLocked(shown, ly.slot) ? lyEditor(layer, ly.slot)
              : layer.preset ? h('div', { class: 'muted small' }, '잠긴 칸은 프리셋이 정한 칸입니다. 빈 칸(노브 누름 등)을 눌러 동작을 정하세요.')
                : h('div', { class: 'muted small' }, '키를 누르거나, 노브·조이스틱 칸을 눌러 열고 방향을 골라 동작을 정하세요.'))))),
  );
  // 동작 줄은 제목 줄 오른쪽에 (2026-10-10: 위쪽 높이를 늘리지 않게)
  const actions = page.querySelector('.ly-actions');
  page.querySelector('.panel-head')?.append(actions);
  mount(main, page);
}
