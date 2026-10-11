import { h, mount, cb } from './dom.js';
import { panel } from './panel.js';
import { pickKeyColor } from '../../src/apps/keyLed.js';
import { ly, lyPresets, lyBoard, lyKnob, lyJoystick, renderLayers, openLayer } from './layers.js';

/**
 * 설정 창 — 설치 마법사 · 레이어 · 프리셋 · 장치 · 정보/진단.
 * 장치 쓰기는 정보·진단의 장치 칸에서 '장치 준비' → 바뀌는 내용 확인 → '백업하고 쓰기'를 눌러야만 일어난다.
 */
const main = document.getElementById('main');
const nav = [...document.querySelectorAll('[data-nav]')];
// 설치 마법사와 장치는 정보·진단에 합쳤다 (2026-10-04). 'setup'·'device'로 부르면 정보·진단을 연다
// 'layers:<id>' = 레이어 화면에서 그 레이어를 연다 (상태판의 '레이어 만들기', 2026-10-10)
const tabOf = (t) => {
  const m = /^layers:(.+)$/.exec(t ?? '');
  if (m) { openLayer(m[1]); return 'layers'; }
  return t === 'setup' || t === 'device' ? 'about' : t;
};
let tab = tabOf(new URLSearchParams(location.search).get('tab') || 'about');
let view = null;

const TABS = { layers: renderLayers, presets: renderPresets, prefs: renderPrefs, about: renderAbout };

function go(next) {
  next = tabOf(next);
  tab = TABS[next] ? next : 'about';
  for (const b of nav) b.setAttribute('aria-current', b.dataset.nav === tab ? 'page' : 'false');
  document.body.dataset.tabActive = tab;
  main.dataset.tabActive = tab;
  TABS[tab]();
}
for (const b of nav) b.addEventListener('click', () => go(b.dataset.nav));
cb.on('cb:tab', go);
let lastDeviceKey = null;
cb.on('cb:view', (v) => {
  view = v;
  // 장치·정보 화면은 장치·Orca 연결 상태가 바뀔 때만 다시 그린다 (갱신마다 그리면 깜박이고 버튼을 방해한다)
  const key = `${v.health?.device?.state}|${v.deviceLayerKo ?? ''}|${v.health?.orca?.ok}|${v.warnings.map((w) => w.code).join(',')}`;
  if (key !== lastDeviceKey) {
    lastDeviceKey = key;
    if (tab === 'about' && !dv.busy) renderAbout();
  }
});

// ───────────────────────── 설치 마법사

/** 설치 단계 (정보·진단 화면 안). 각 단계는 지금 상태를 보여 준다 */
async function setupSection() {
  view = view ?? await cb.invoke('cb:view');
  const s = await cb.invoke('cb:setup:get');
  const auto = await cb.invoke('cb:autostart:get');
  const dev = view.health.device;
  const orca = view.health.orca;
  const layerWarn = view.warnings.find((w) => w.code === 'layer' || w.code === 'layer-upgrade' || w.code === 'dial-hint');

  const step = (n, ok, title, body, ...btns) => h('div', { class: `step ${ok === true ? 'done' : ok === false ? 'todo' : ''}`, dataset: { step: String(n) } },
    h('span', { class: 'num' }, ok === true ? '✓' : n),
    h('div', { class: 'grow' }, h('h3', {}, title), h('p', {}, body), btns.length ? h('div', { class: 'btns' }, ...btns) : null));

  const permOk = dev.state !== 'denied';
  return h('div', { class: 'setup-section' },
    h('h3', {}, '설치 단계'),
    h('div', { class: 'steps' },
      step(1, permOk ? true : false, '입력 모니터링 권한',
        permOk
          ? '장치를 열 수 있습니다.'
          : '장치를 열 권한이 없습니다. 시스템 설정 → 개인정보 보호 및 보안 → 입력 모니터링에서 Output을 켠 뒤 앱을 다시 시작하세요.',
        permOk ? null : h('button', { class: 'btn primary', onclick: () => cb.invoke('cb:openPermission', 'inputMonitoring') }, '시스템 설정 열기')),
      step(2, dev.ok ? true : false, '장치',
        dev.ok ? `Creator Micro 2 연결됨${view.deviceLayerKo ? ` · 지금 레이어: ${view.deviceLayerKo}` : ''}`
            : dev.state === 'missing' ? '장치를 찾지 못했습니다. USB나 블루투스로 연결하세요.' : `상태: ${dev.labelKo}`),
      step(3, s.calibrated ? true : false, '키 위치 보정',
        s.calibrated ? `보정 있음 — ${s.calibrationKo}` : `보정이 없습니다 (${s.calibrationKo}). 터미널에서 node tools/doctor.mjs --input 과 node tools/calibrate.mjs --apply 를 실행하세요.`),
      step(4, layerWarn ? false : (dev.ok ? true : null), '장치 준비',
        layerWarn ? layerWarn.messageKo : '장치에 Output 레이어 하나만 둡니다. 쓰기 전에 바뀌는 내용을 보여주고, 백업한 뒤, 다시 읽어 대조합니다.',
        h('button', { class: 'btn', onclick: () => document.getElementById('device-section')?.scrollIntoView({ behavior: 'smooth' }) }, '아래 장치 칸으로')),
      step(5, orca.ok ? true : false, 'Orca',
        orca.ok ? 'Orca 연결됨. 에이전트 상태를 2초마다 읽습니다. 읽기와 터미널 전환만 합니다.'
          : 'Orca에 닿지 못했습니다. Orca를 열면 자동으로 다시 읽습니다. 그동안 슬롯은 비어 있습니다 — 모의 데이터를 넣지 않습니다.'),
      step(6, null, '로그인할 때 자동 시작',
        auto.openAtLogin ? '켜져 있습니다.' : '꺼져 있습니다 (기본). 켜기 전에는 등록하지 않습니다.',
        h('button', { class: 'btn', onclick: async () => { await cb.invoke('cb:autostart:set', !auto.openAtLogin); renderAbout(); } }, auto.openAtLogin ? '끄기' : '켜기')),
      step(7, s.accessibility ? true : null, '손쉬운 사용 (선택)',
        s.accessibility ? '단축키·글자 입력을 보낼 수 있습니다.' : '레이어의 단축키·글자 입력을 보내려면 필요합니다. 없어도 상태 표시와 이동은 동작합니다.',
        s.accessibility ? null : h('button', { class: 'btn', onclick: () => cb.invoke('cb:openPermission', 'accessibility') }, '시스템 설정 열기')),
    ),
    h('div', { class: 'row-flex' },
      h('span', { class: 'grow muted small' }, s.completed ? `완료함 (${s.at ?? ''})` : '다 확인했으면 완료를 누르세요. 다음부터 자동으로 열리지 않습니다.'),
      h('button', { class: 'btn primary', onclick: async () => { await cb.invoke('cb:setup:complete'); renderAbout(); } }, '완료'),
    ));
}

// ───────────────────────── 프리셋 (읽기 전용, 프리셋·장치 스펙 §2.2)

const ps = { sel: 'orca', widget: null };

async function renderPresets() {
  lyPresets.list ??= await cb.invoke('cb:presets:list');
  if (!ly.data) { ly.data = await cb.invoke('cb:layers:get'); ly.saved = JSON.stringify(ly.data); }
  const p = lyPresets.list.find((x) => x.id === ps.sel) ?? lyPresets.list[0];
  const users = ly.data.filter((l) => l.preset === p.id).map((l) => l.name || '(이름 없음)');
  const view = { id: `preset-${p.id}`, kind: 'preset', name: p.name, color: '#1F9E96', preset: p.id, locked: true,
    keyLabels: p.keyLabels, keys: p.keys ?? {}, dial: p.dial, joystick: p.joystick };
  const list = h('div', { class: 'layers' }, lyPresets.list.map((x) => h('button', { 'aria-pressed': String(x.id === p.id), onclick: () => { ps.sel = x.id; renderPresets(); } }, x.name)));
  const info = p.info ?? {};
  const copyBtn = h('button', { class: 'btn', onclick: async () => {
    const l = await cb.invoke('cb:presets:copy', p.id);
    if (!l) return;
    ly.data.push(l); ly.sel = l.id; ly.slot = null;
    ly.msg = { tone: 'info', text: `'${l.name}'을(를) 만들었습니다. 저장해야 반영됩니다.` };
    go('layers');
  } }, '복사해서 새 레이어');
  // 이 프리셋을 연결한 새 레이어 (2026-10-10): 기본 앱 중 아직 다른 레이어에 없는 것을 연결한다. 저장은 레이어 화면에서
  const newBtn = h('button', { class: 'btn primary', onclick: () => {
    const taken = new Set(ly.data.flatMap((l) => l.apps.map((a) => a.bundleId)));
    const apps = (p.defaultApps ?? []).filter((a) => !taken.has(a.bundleId)).map((a) => ({ ...a }));
    const l = { id: `l-${p.id}-${Date.now().toString(36)}`, kind: 'user', name: p.name, color: pickKeyColor(ly.data.map((x) => x.color)),
      preset: p.id, apps, keys: {}, dial: {}, joystick: { directions: 4, axis: 'vertical', short: {}, long: {} }, underglow: null };
    ly.data.push(l); ly.sel = l.id; ly.slot = null;
    const skipped = (p.defaultApps ?? []).length - apps.length;
    ly.msg = { tone: 'info', text: `'${l.name}' 레이어를 만들었습니다${apps.length ? ` (앱 ${apps.map((a) => a.name).join(', ')})` : ''}${skipped ? ` — 다른 레이어에 이미 있는 앱 ${skipped}개는 빼 두었습니다` : ''}. 저장해야 반영됩니다.` };
    go('layers');
  } }, '이 프리셋으로 새 레이어');
  mount(main, panel('프리셋', [
    '위에서 프리셋을 고르면 칸 배치를 봅니다. 노브·조이스틱 칸을 누르면 옆에 그림이 열립니다.',
    '레이어 화면의 \'키 배치\'에서 프리셋을 연결해 씁니다. 프리셋이 비운 칸은 그 레이어에서 정합니다.',
    '복사해서 새 레이어: 단축키 같은 일반 동작만 복사한 레이어를 만듭니다. 저장해야 반영됩니다.',
  ],
    h('div', { class: 'row-flex ly-top' }, list, h('span', { class: 'grow' }), p.id === 'orca' ? null : newBtn, copyBtn),
    // 레이어 화면처럼 좌(장치 그림) / 우(설명) (2026-10-10)
    h('div', { class: 'ly-work' },
      h('div', { class: 'ly-left' }, lyBoard(view, renderPresets, { st: ps }),
        ps.widget === 'knob' ? lyKnob(view)
          : ps.widget === 'joystick' ? (p.joystick ? lyJoystick(view, renderPresets)
            : h('div', { class: 'ly-widget' }, h('div', { class: 'ly-title' }, '조이스틱'), h('p', { class: 'small muted' }, '이 프리셋은 조이스틱을 정하지 않습니다. 레이어에서 정합니다.')))
            : null),
      h('div', { class: 'ly-right card preset-info' },
        h('strong', {}, p.name),
        h('p', { class: 'small muted' }, [info.createdKo && `만든 날짜 ${info.createdKo}`, info.basedOnKo].filter(Boolean).join(' · ')),
        info.behaviorKo?.length ? [h('h4', {}, '동작'), h('ul', {}, info.behaviorKo.map((t) => h('li', {}, t)))] : null,
        info.underglowKo?.length ? [h('h4', {}, '언더글로우'), h('ul', {}, info.underglowKo.map((t) => h('li', {}, t)))] : null,
        info.limitsKo?.length ? [h('h4', {}, '제약'), h('ul', {}, info.limitsKo.map((t) => h('li', {}, t)))] : null,
        h('p', { class: 'small muted' }, `이 프리셋을 쓰는 레이어: ${users.length ? users.join(', ') : '없음'}`)))));
}

// ───────────────────────── 설정 (2026-10-10): 노브·조이스틱 화면 표시

async function renderPrefs() {
  const prefs = await cb.invoke('cb:prefs:get');
  const toggle = (key, title, desc) => {
    const input = h('input', { type: 'checkbox', checked: prefs.hud[key], 'aria-label': title, onchange: async () => {
      prefs.hud[key] = input.checked;
      const r = await cb.invoke('cb:prefs:set', prefs);
      if (!r.ok) { input.checked = !input.checked; prefs.hud[key] = input.checked; }
    } });
    return h('label', { class: 'pref-row' }, h('span', { class: 'switch' }, input, h('span', { class: 'switch-knob' })),
      h('span', { class: 'pref-text' }, h('strong', {}, title), h('span', { class: 'small muted' }, desc)));
  };
  mount(main, panel('설정', [
    '화면 표시: 노브·조이스틱을 쓰면 마우스가 있는 화면 아래 가운데에 밝기 조절 표시처럼 잠깐 보여 줍니다.',
    '표시 창은 클릭이 통과하고 포커스를 가져가지 않습니다 — 단축키는 그대로 앞 앱으로 갑니다.',
  ],
  h('div', { class: 'card pref-card' },
    h('h3', {}, '화면 표시'),
    toggle('knob', '노브', '돌리거나 누르면 그 동작 이름을 잠깐 보여 줍니다 (예: ↻ 다음 탭).'),
    toggle('joystick', '조이스틱', '움직이는 동안 지금 위치·방향 칸·동작 이름을 보여 줍니다. 길게 칸이 있으면 0.5초 고리가 찹니다.')),
  nightCard(prefs)));
}

/** 밤 시간 밝기 (2026-10-10): 켜기·끄기와 시작·끝 시각. 구간 안에서는 LED가 한 단계(반) 어둡다 */
function nightCard(prefs) {
  const save = async () => {
    const r = await cb.invoke('cb:prefs:set', prefs);
    if (!r.ok) renderPrefs();
  };
  const on = h('input', { type: 'checkbox', checked: prefs.night.enabled, 'aria-label': '밤 시간 밝기', onchange: () => { prefs.night.enabled = on.checked; from.disabled = to.disabled = !on.checked; save(); } });
  const time = (key, label) => {
    const el = h('input', { type: 'time', value: prefs.night[key], 'aria-label': label, disabled: !prefs.night.enabled, class: 'pref-time' });
    el.addEventListener('change', () => { if (/^\d\d:\d\d$/.test(el.value)) { prefs.night[key] = el.value; save(); } });
    return el;
  };
  const from = time('from', '시작 시각');
  const to = time('to', '끝 시각');
  return h('div', { class: 'card pref-card' },
    h('h3', {}, '밤 시간 밝기'),
    h('label', { class: 'pref-row' }, h('span', { class: 'switch' }, on, h('span', { class: 'switch-knob' })),
      h('span', { class: 'pref-text' }, h('strong', {}, '정한 시간에 LED를 어둡게'), h('span', { class: 'small muted' }, '키·언더글로우 밝기를 반으로 줄입니다. 자정을 넘는 구간(예: 22:00 ~ 07:00)도 됩니다.'))),
    h('div', { class: 'row-flex pref-times' }, h('span', { class: 'small muted' }, '시작'), from, h('span', { class: 'small muted' }, '~ 끝'), to));
}

// ───────────────────────── 장치 (Output 레이어 하나, 프리셋·장치 스펙 §4)

const dv = { plan: null, msg: null, busy: false };

function backupsEl(backups) {
  if (!backups.length) return null;
  return h('div', {},
    h('div', { class: 'small muted', style: { marginBottom: '6px' } }, '백업 — 장치에 쓰기 전마다 만든 것'),
    h('div', { class: 'logs' }, backups.slice(0, 20).map((b) => h('div', { class: 'row-flex' },
      h('span', { class: 'grow mono' }, b.name),
      h('button', {
        class: 'btn', style: { minHeight: '28px', padding: '2px 10px', fontSize: '12px' },
        onclick: async () => {
          const r = await cb.invoke('cb:keymap:restore', b.path);
          dv.msg = { tone: r.ok ? 'info' : (r.stage === 'cancel' ? 'info' : 'error'), text: r.messageKo };
          dv.plan = null;
          renderAbout();
        },
      }, '이것으로 되돌리기')))));
}

/** 장치 칸 (정보·진단 안, 2026-10-04): 상태 · 장치 준비 · 백업 */
async function deviceSection() {
  const s = await cb.invoke('cb:device:status');
  const backups = await cb.invoke('cb:keymap:backups');
  const state = !s.connected
    ? h('div', { class: 'notice warn' }, s.deviceStateKo)
    : s.ready
      ? h('div', { class: 'notice info' }, '● Output 레이어 하나 — 준비됨')
      : h('div', { class: 'notice warn' }, '▲ 고쳐야 함', h('ul', {}, s.reasonsKo.map((r) => h('li', {}, r))));
  const prep = h('button', { class: 'btn primary', disabled: !s.connected || dv.busy, onclick: async () => {
    if (dv.busy) return;
    dv.busy = true; dv.msg = null;
    dv.plan = await cb.invoke('cb:device:plan');
    dv.busy = false;
    if (!dv.plan.ok) { dv.msg = { tone: 'error', text: dv.plan.errorKo }; dv.plan = null; }
    renderAbout();
  } }, s.ready ? '다시 쓰기' : '장치 준비');
  const planEl = dv.plan ? h('div', { class: 'card' },
    h('strong', {}, '바뀌는 내용'),
    h('ul', {}, [...dv.plan.changesKo, ...dv.plan.diffLines].map((l) => h('li', { class: 'mono small' }, l))),
    dv.plan.diffLines.length ? null : h('p', { class: 'muted small' }, '장치에서 바뀌는 것이 없습니다.'),
    h('div', { class: 'row-flex' },
      h('button', { class: 'btn', onclick: () => { dv.plan = null; renderAbout(); } }, '취소'),
      h('button', { class: 'btn primary', disabled: dv.busy || !dv.plan.diffLines.length, onclick: async (e) => {
        if (dv.busy) return;
        dv.busy = true; e.target.disabled = true;
        const r = await cb.invoke('cb:device:apply');
        dv.busy = false; dv.plan = null;
        dv.msg = r.ok ? { tone: 'info', text: `장치를 준비했습니다. 백업: ${r.backupPath}` } : { tone: 'error', text: r.messageKo };
        renderAbout();
      } }, '백업하고 쓰기'))) : null;
  return h('div', { class: 'device-section', id: 'device-section' },
    h('h3', {}, '장치'),
    dv.msg ? h('div', { class: `notice ${dv.msg.tone}` }, dv.msg.text) : null,
    state, h('p', { class: 'small muted' }, '레이어는 장치에 쓰지 않습니다. 레이어 화면에서 저장하면 바로 반영됩니다.'),
    h('div', { class: 'row-flex' }, prep), planEl, backupsEl(backups));
}

// ───────────────────────── 정보 · 진단

async function renderAbout() {
  const info = await cb.invoke('cb:info');
  const logs = await cb.invoke('cb:logs');
  const auto = await cb.invoke('cb:autostart:get');
  let note = h('span', { class: 'small muted' }, '');
  const setup = await setupSection();
  const device = await deviceSection();
  mount(main, panel('정보 · 진단', [
    '설치 단계: 각 단계가 지금 상태를 보여 줍니다. 표시된 단계만 하면 됩니다.',
    '장치: 장치 준비를 누르면 바뀌는 내용이 나옵니다. 확인하고 백업하고 쓰기를 누르세요. 쓰기는 백업 → 쓰기 → 다시 읽어 확인 순서이고, 백업 목록에서 이전 상태로 되돌릴 수 있습니다. 펌웨어 업데이트만 Input 앱으로 하세요.',
    '진단 내보내기: 문제를 알릴 때 이 파일을 붙여 주세요. 작업 이름·경로·대화 내용은 들어가지 않습니다.',
    '상태 폴더 열기: 설정·백업·로그가 있는 폴더를 엽니다.',
  ],
    setup,
    device,
    h('div', { class: 'grid4' },
      h('div', { class: 'card' }, h('label', {}, '앱'), h('b', {}, info.versions.app ?? '—')),
      h('div', { class: 'card' }, h('label', {}, '펌웨어'), h('b', {}, info.versions.firmware ?? '—')),
      h('div', { class: 'card' }, h('label', {}, '로그인 시 시작'), h('b', {}, auto.openAtLogin ? '켜짐' : '꺼짐'))),
    h('div', { class: 'row-flex' },
      h('button', { class: 'btn primary', onclick: async () => { const r = await cb.invoke('cb:diagnostics:export'); note.textContent = r.messageKo; } }, '진단 내보내기'),
      h('button', { class: 'btn', onclick: () => cb.invoke('cb:openStateDir') }, '상태 폴더 열기'),
      note),
    h('div', { class: 'small muted' }, `상태 폴더: ${info.stateDir}`),
    h('div', { class: 'logs' }, logs.length ? logs.slice().reverse().map((l) => h('div', {}, `${new Date(l.at).toLocaleTimeString('ko-KR')}  ${l.messageKo}`)) : h('div', { class: 'muted' }, '기록 없음'))));
}

go(tab);
