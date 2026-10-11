import { Status, StatusLabelKo, isAttention } from '../core/types.js';
import { THREAD_STYLE } from '../core/lightingPolicy.js';
import { colorToInt } from '../device/deviceDriver.js';
import { SLOT_NAME_KO } from '../apps/layers.js';
import { actionLabel } from '../apps/actionLabel.js';

/**
 * 상태판(메뉴바 팝오버) 뷰모델 (M5 설계 §10, P01).
 *
 * 렌더러에는 정책을 두지 않는다. 이 함수가 Output 스냅샷과 health를
 * 화면에 그릴 값으로 바꾸고, 렌더러는 그대로 그린다.
 *
 * 각 줄이 답하는 것: 지금 어느 묶음인가 · 이 슬롯은 무엇인가 · 누르면 어디로 가는가 ·
 * 무엇이 안 되고 있는가. 안 되는 것은 숨기지 않는다 (P03).
 */

/** LED 색 이름 → 화면 색. 장치와 화면이 같은 말을 하게 한다. */
export const COLOR_HEX = Object.freeze({
  blue: '#3b6fd8',
  orange: '#e8762b',
  amber: '#d9a21b',
  vermilion: '#e0481f',
  rose: '#d6336c',
  apricot: '#f2a36b',
  green: '#3e9b5a',
  teal: '#1f9e96',
  dim_green: '#7fae8c',
  red: '#c0392b',
  purple: '#8b6bc4',
  dim_white: '#9a968d',
  neutral_gray: '#8a8a8a',
  white: '#cfcac0',
  off: '#3a3834',
});

export function colorOf(status) {
  const s = THREAD_STYLE[status];
  return COLOR_HEX[s?.color] ?? COLOR_HEX.dim_white;
}

const DEVICE_LABEL = Object.freeze({
  connected: '장치 ✓',
  connecting: '장치 연결 중…',
  missing: '장치 없음',
  denied: '장치 — 권한 필요',
  busy: '장치 — 다른 앱 사용 중',
  error: '장치 오류',
});

/** 장치 칩: 연결됐으면 연결 방식·배터리를 붙인다 (2026-10-10). 모르는 값은 빼고 예전 그대로 */
function deviceLabel(dev) {
  const base = DEVICE_LABEL[dev.state] ?? dev.state;
  if (dev.state !== 'connected') return base;
  const conn = { usb: 'USB', bluetooth: '블루투스' }[dev.connection];
  const batt = Number.isFinite(dev.battery) ? `${dev.battery}%${dev.charging ? ' 충전 중' : ''}` : null;
  const extra = [conn, batt].filter(Boolean).join(' ');
  return extra ? `${base} · ${extra}` : base;
}

/** 배터리가 이만큼 이하이고 충전 중이 아니면 알린다 */
const BATTERY_LOW = 15;

const ORCA_LABEL = Object.freeze({
  connected: 'Orca ✓',
  unreachable: 'Orca 없음',
  error: 'Orca 오류',
  disabled: 'Orca 꺼짐',
});


/**
 * @param {object} arg
 * @param {object} arg.snapshot Output.render()
 * @param {object} arg.health {device:{state,messageKo?}, orca:{state,version?}, mock, permissions:{accessibility}}
 * @param {boolean} [arg.restoring]
 * @param {Record<string,{agentKo?:string}>} [arg.unitDetails]
 */
export function buildStatusView({
  snapshot, health, restoring = false, unitDetails = {},
}) {
  const rows = snapshot.slots.map((s) => {
    const empty = !s.id;
    return {
      n: s.slot,
      id: s.id,
      title: s.title,
      empty,
      status: s.status,
      labelKo: empty ? '' : (StatusLabelKo[s.status] || s.status),
      color: empty ? COLOR_HEX.off : colorOf(s.status),
      agentKo: s.id ? (unitDetails[s.id]?.agentKo ?? '') : '',
      attention: isAttention(s.status),
    };
  });

  const waiting = snapshot.attentionCount ?? 0;
  const doneUnseen = snapshot.slots.filter((s) => s.status === Status.DONE_UNSEEN).length;

  const warnings = [];
  if (snapshot.active === false && !snapshot.appMode) {
    warnings.push({ code: 'inactive', level: 'info', messageKo: '지금 앞 앱에 연결된 레이어가 없어 키보드는 대기 중입니다. 설정 → 레이어에서 앱을 연결하면 켜집니다.' });
  }
  const dev = health?.device ?? { state: 'missing' };
  if (dev.state === 'connected' && Number.isFinite(dev.battery) && dev.battery <= BATTERY_LOW && !dev.charging) {
    warnings.push({ code: 'battery-low', level: 'warn', messageKo: `키보드 배터리가 ${dev.battery}%입니다. 충전하세요.` });
  }
  if (dev.state === 'denied') {
    warnings.push({
      code: 'device-denied', level: 'error', action: 'open-input-monitoring',
      messageKo: '장치를 열 권한이 없습니다. 시스템 설정 → 개인정보 보호 및 보안 → 입력 모니터링에서 '
        + 'Output을 켠 뒤 앱을 다시 시작하세요.',
    });
  } else if (dev.state === 'missing') {
    warnings.push({ code: 'device-missing', level: 'warn', messageKo: 'Creator Micro 2를 찾지 못했습니다. 연결되면 자동으로 잡습니다.' });
  } else if (dev.state === 'busy') {
    warnings.push({ code: 'device-busy', level: 'warn', messageKo: '다른 앱이 장치를 쓰고 있습니다. 그 앱을 닫으면 자동으로 잡습니다.' });
  } else if (dev.state === 'error') {
    warnings.push({ code: 'device-error', level: 'error', messageKo: `장치 오류: ${dev.messageKo ?? '알 수 없음'}` });
  }
  const orca = health?.orca ?? { state: 'disabled' };
  if (orca.state === 'unreachable') {
    warnings.push({ code: 'orca-unreachable', level: 'warn', messageKo: 'Orca에 닿지 못했습니다. Orca를 열면 자동으로 다시 읽습니다.' });
  } else if (orca.state === 'error') {
    warnings.push({ code: 'orca-error', level: 'warn', messageKo: `Orca 읽기 실패: ${orca.messageKo ?? '알 수 없음'}` });
  }
  if (health?.permissions && health.permissions.accessibility === false) {
    warnings.push({
      code: 'accessibility', level: 'warn', action: 'open-accessibility',
      messageKo: '손쉬운 사용 권한이 없어 조이스틱·노브 단축키는 동작하지 않습니다. 나머지는 모두 동작합니다. 목록에 Output이 켜져 있는데도 이 경고가 보이면 새로 설치해 서명이 바뀐 것입니다 — 목록에서 Output을 −로 지운 뒤 \'손쉬운 사용 열기\'를 다시 누르세요.',
    });
  }
  if (health?.mock) {
    warnings.push({ code: 'mock', level: 'info', messageKo: '모의 데이터입니다. 실제 작업 상태가 아닙니다.' });
  }
  if (health?.persistWarningKo) {
    warnings.push({ code: 'persist', level: 'warn', messageKo: health.persistWarningKo });
  }

  return {
    menu: {
      // 빨강(개입) > 회색(장치 문제) > 호박(진행 중) > 청록(완료·미확인) > 초록(평온) (2026-10-02).
      // 모든 묶음을 센다. 개수는 개입에만 단다.
      tone: waiting ? 'attention'
        : (dev.state === 'denied' || dev.state === 'error') ? 'problem'
          : (snapshot.statusCounts?.[Status.RUNNING] ?? 0) ? 'running'
            : (snapshot.statusCounts?.[Status.DONE_UNSEEN] ?? doneUnseen) ? 'done' : 'calm',
      count: waiting,
    },
    active: snapshot.active !== false,
    appModeKo: snapshot.appMode ? `${snapshot.appMode.name} 레이어` : null,
    bankLabelKo: `묶음 ${snapshot.bank + 1}/${snapshot.bankCount}`,
    view: snapshot.view,
    rows,
    queueLineKo: `개입 대기 ${waiting} · 미확인 완료 ${doneUnseen}`,   // 메뉴바 아이콘 설명 (상태판에는 안 보임, 2026-10-05)
    health: {
      device: { ok: dev.state === 'connected', state: dev.state, labelKo: deviceLabel(dev) },
      orca: {
        ok: orca.state === 'connected', state: orca.state,
        labelKo: ORCA_LABEL[orca.state] ?? orca.state, version: orca.version ?? null,
      },
    },
    mock: Boolean(health?.mock),
    restoring: Boolean(restoring),
    warnings,
  };
}

/** 상태판 키 그림 = 장치 실제 배열 (HARDWARE_CONTRACT). 2026-10-05 사용자 요청 */
export const KEY_GRID = Object.freeze([
  ['dial', 'key1', 'key2', 'joystick'],
  ['key3', 'key4', 'key5', 'key6'],
  ['key7', 'key8', 'key9', 'key10'],
  ['miniled', 'key11', 'key12', 'key13'],
]);

/** 키 칸 id → 장면의 논리 키 */
const SCENE_KEY = (id) => ({ key11: 'attention', key12: 'ack', key13: 'mode_back' })[id] ?? `slot${id.slice(3)}`;

/** 장면 스타일 → 화면 색. 꺼짐은 null. 상태색 이름은 상태판 줄과 같은 색으로 */
function cssColor(st) {
  if (!st || st.color === 'off' || (st.brightness ?? 1) <= 0) return null;
  if (/^#[0-9a-f]{6}$/i.test(st.color)) return st.color.toLowerCase();
  return COLOR_HEX[st.color] ?? `#${colorToInt(st.color, 1).toString(16).padStart(6, '0')}`;
}

/** 노브·조이스틱 칸의 설명: 배정된 칸마다 '이름: 동작' 한 줄 */
function widgetTitle(slots, prefix) {
  const lines = Object.entries(slots)
    .filter(([id]) => id.startsWith(prefix))
    .map(([id, a]) => `${SLOT_NAME_KO(id)}: ${actionLabel(a)}`);
  return lines.length ? lines.join('\n') : '비어 있음';
}

/**
 * 지금 레이어의 키 배치와 지금 LED 색 (상태판 '키' 그림).
 * @param {{mode:'orca'|'app', scene:object, slots:object, titles:(string|null)[], statuses?:(string|null)[],
 *   color?:string, joystick?:{directions:number, axis:string}}} p
 *   scene = 장치에 보내는 장면 그대로 (지금 LED), slots = 레이어 실행 칸, titles·statuses = Orca 작업 칸 이름·상태 글자,
 *   color = 레이어 색, joystick = 지금 방향 수·축 (노브·조이스틱 작은 그림용, 2026-10-06)
 */
export function buildKeyMap({ mode, scene, slots, titles, statuses = [], hints = [], color = null, joystick = { directions: 4, axis: 'vertical' } }) {
  const cells = KEY_GRID.flat().map((id) => {
    if (id === 'dial') return { id, kind: 'dial', labelKo: '노브', title: widgetTitle(slots, 'dial_') };
    if (id === 'joystick') return { id, kind: 'joystick', labelKo: '조이스틱', title: widgetTitle(slots, 'joystick') };
    if (id === 'miniled') return { id, kind: 'miniled', labelKo: 'LED', title: '하드웨어 레이어 표시등' };
    const n = Number(id.slice(3));
    // Orca 모드의 키 1~10은 작업 칸 (Output이 그린다)
    const label = mode === 'orca' && n <= 10 ? titles[n - 1] ?? null : (slots[id] ? actionLabel(slots[id]) : null);
    // 빈 칸은 키 번호만 흐리게
    const statusKo = mode === 'orca' && n <= 10 ? statuses[n - 1] ?? null : null;
    const hintKo = mode === 'orca' && n <= 10 ? hints[n - 1] ?? null : null;
    return { id, n, kind: 'key', labelKo: label ?? String(n), statusKo, color: cssColor(scene.keys?.[SCENE_KEY(id)]), empty: !label, title: `키 ${n}: ${label ?? '비어 있음'}${hintKo ? `\n${hintKo}` : ''}` };
  });
  const name = (id) => (slots[id] ? actionLabel(slots[id]) : '');
  const labels = {};
  for (const id of Object.keys(slots)) {
    const m = /^joystick_(.+)$/.exec(id);
    if (m) labels[m[1]] = name(id);
  }
  return {
    cells, underglow: cssColor(scene.ambientZone), color,
    dial: { ccw: name('dial_ccw'), cw: name('dial_cw'), press: name('dial_press') },
    joystick: { directions: joystick.directions, axis: joystick.axis, labels },
  };
}
