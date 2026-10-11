/**
 * --preview 시나리오.
 *
 * 실기에 런타임 scene을 그려 눈으로 확인한다.
 * 각 시나리오는 '무엇이 보여야 하는지'를 미리 알려준다 — 보고 나서 판단할 수 있게.
 *
 * 순수 함수로 두어 장치 없이 테스트한다.
 */
import { StateStore } from '../../src/core/stateStore.js';
import { WorkUnit, ChildUnit } from '../../src/core/units.js';
import { Status, StatusLabelKo } from '../../src/core/types.js';
import { THREAD_STYLE } from '../../src/core/lightingPolicy.js';
import { SLOTS_PER_BANK } from '../../src/core/hardware.js';
import { readingOrderPositions } from './layout.js';

const child = (id, status) => new ChildUnit({ id, status });

/** 6개 슬롯에 서로 다른 상태를 채운다. 물리 위치와 색을 한 번에 확인한다. */
export const STATUS_SEQUENCE = Object.freeze([
  Status.RUNNING, Status.WAITING_INPUT, Status.WAITING_APPROVAL,
  Status.DONE_UNSEEN, Status.ERROR, Status.STALE,
]);

export function buildStatusStore() {
  const store = new StateStore();
  STATUS_SEQUENCE.forEach((status, i) => {
    store.addUnit(new WorkUnit({
      id: `preview/slot${i + 1}`,
      title: `preview/slot${i + 1}`,
      children: [child(`preview/slot${i + 1}/a`, status)],
    }));
  });
  return store;
}

/** 보이는 묶음은 조용하고 숨은 묶음에만 개입이 있는 상태. 점멸을 본다. */
export function buildPulseStore() {
  const store = new StateStore();
  for (let i = 0; i < SLOTS_PER_BANK; i += 1) {
    store.addUnit(new WorkUnit({
      id: `preview/calm${i + 1}`,
      title: `preview/calm${i + 1}`,
      children: [child(`preview/calm${i + 1}/a`, Status.RUNNING)],
    }));
  }
  // 두 번째 묶음(보이지 않는 곳)에 개입을 둔다
  store.addUnit(new WorkUnit({
    id: 'preview/hidden',
    title: 'preview/hidden',
    children: [child('preview/hidden/a', Status.WAITING_APPROVAL)],
  }));
  return store;
}

/** 빈 슬롯이 있는 상태. 점멸이 빈 자리만 쓰는지 본다. */
export function buildSparseStore() {
  const store = new StateStore();
  for (let i = 0; i < 3; i += 1) {
    store.addUnit(new WorkUnit({
      id: `preview/few${i + 1}`,
      title: `preview/few${i + 1}`,
      children: [child(`preview/few${i + 1}/a`, Status.RUNNING)],
    }));
  }
  // 첫 bank의 남은 자리를 '작업 없는 자리'로 막아 빈 슬롯을 만든다.
  // 개입은 그 뒤 bank에 들어가야 '숨은' 개입이 된다.
  for (let i = 3; i < SLOTS_PER_BANK; i += 1) store.globalSlots.assign(`preview/spacer${i - 2}`);
  store.addUnit(new WorkUnit({
    id: 'preview/hidden2',
    title: 'preview/hidden2',
    children: [child('preview/hidden2/a', Status.ERROR)],
  }));
  return store;
}

/** 물리 위치별로 무엇이 보여야 하는지 */
export function expectationsFor(statuses) {
  const positions = readingOrderPositions().slice(0, 6);
  return positions.map((p, i) => {
    const status = statuses[i] ?? Status.EMPTY;
    const style = THREAD_STYLE[status] ?? THREAD_STYLE[Status.EMPTY];
    return {
      row: p.row,
      col: p.col,
      logical: p.logical,
      status,
      labelKo: StatusLabelKo[status] || '없음',
      color: style.color,
      brightness: style.brightness,
    };
  });
}

export const SCENARIOS = Object.freeze([
  {
    id: 'status',
    titleKo: '슬롯 6개에 서로 다른 상태',
    seconds: 8,
    build: buildStatusStore,
    statuses: STATUS_SEQUENCE,
    lookKo: [
      '여섯 키의 색이 아래 표와 같은지 보세요.',
      'RUNNING(파랑)이 가장 어둡고, 오류(빨강)와 답변 필요(호박)가 가장 밝아야 합니다.',
      '물리 위치와 색이 표와 다르면 매핑이 틀린 것입니다.',
    ],
  },
  {
    id: 'pulse',
    titleKo: '숨은 묶음의 개입 → 슬롯 점멸',
    seconds: 10,
    build: buildPulseStore,
    statuses: Array(SLOTS_PER_BANK).fill(Status.RUNNING),
    lookKo: [
      '키 1~10이 모두 조용한 색이어야 합니다 (보이는 묶음은 정상).',
      '그 위로 주황색이 짧게 스쳐야 합니다 — 숨은 묶음의 승인 대기를 알리는 점멸입니다.',
      '점멸이 너무 잦거나 산만하면 알려주세요. 듀티와 주기를 조정합니다.',
    ],
  },
  {
    id: 'sparse',
    titleKo: '빈 슬롯이 있을 때의 점멸',
    seconds: 8,
    build: buildSparseStore,
    statuses: [Status.RUNNING, Status.RUNNING, Status.RUNNING,
      Status.EMPTY, Status.EMPTY, Status.EMPTY],
    lookKo: [
      '앞 세 키만 파랑이고 뒤 세 자리는 꺼져 있어야 합니다.',
      '빨강 점멸이 **꺼진 자리에서만** 일어나야 합니다.',
      '파란 키가 같이 깜빡이면 정보를 덮는 것이니 알려주세요.',
    ],
  },
]);

export function formatExpectations(statuses) {
  const L = [];
  L.push('    위치        논리        상태            색');
  for (const e of expectationsFor(statuses)) {
    L.push(`    ${e.row}행 ${e.col}열     ${String(e.logical).padEnd(10, ' ')}`
      + `${String(e.labelKo).padEnd(14, ' ')}${e.color}`
      + (e.brightness ? ` (밝기 ${e.brightness})` : ''));
  }
  return L.join('\n');
}
