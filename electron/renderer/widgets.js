import { h } from './dom.js';

/**
 * 노브·조이스틱 그림 (2026-10-06). 설정 화면(편집)과 상태판(보기 전용)이 같은 그림을 쓴다.
 * 무엇을 고를 수 있는지·눌렀을 때 무엇을 하는지는 부르는 쪽이 정한다 — 여기는 그리기만.
 */
export const DIR_LABEL = { any: '모든 방향', up: '위', up_right: '오른쪽 위', right: '오른쪽', down_right: '오른쪽 아래', down: '아래', down_left: '왼쪽 아래', left: '왼쪽', up_left: '왼쪽 위' };
// 화면 각도(도): 0 = 오른쪽, 90 = 아래
const DIR_DEG = { right: 0, down_right: 45, down: 90, down_left: 135, left: 180, up_left: 225, up: 270, up_right: 315 };
export const dirsOf = (n, axis) => (n === 1 ? ['any'] : n === 2 ? (axis === 'horizontal' ? ['left', 'right'] : ['up', 'down'])
  : n === 8 ? ['up', 'up_right', 'right', 'down_right', 'down', 'down_left', 'left', 'up_left'] : ['up', 'right', 'down', 'left']);

const SVG_NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}, text = null) => {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if (text !== null) el.textContent = text;
  return el;
};

/**
 * 노브: 둥근 다이얼 왼쪽 ↺ · 오른쪽 ↻ · 가운데 누름.
 * @param {{labels:{ccw?:string,cw?:string,press?:string}, color:string,
 *   on?:(dir:string)=>boolean, part?:(dir:'ccw'|'cw'|'press')=>object}} p
 *   on = 동작이 있는 칸(색칠), part = 칸마다 덧붙일 속성(onclick·aria 등, 보기 전용이면 없음)
 */
export function knobFace({ labels, color, on = (dir) => Boolean(labels[dir]), part = () => ({}) }) {
  const half = (dir, sym, side) => {
    const extra = part(dir);
    return h('button', {
      ...extra, class: `ly-knob-half ${side}${extra.class ? ` ${extra.class}` : ''}`,
      style: on(dir) ? { background: `${color}33` } : {},
    }, h('span', { class: 'sym' }, sym), h('span', { class: 'lbl' }, labels[dir] || '—'));
  };
  const extra = part('press');
  const press = h('button', {
    ...extra, class: `ly-knob-center${extra.class ? ` ${extra.class}` : ''}`,
    style: on('press') ? { boxShadow: `inset 0 0 0 2px ${color}` } : {},
  }, h('span', { class: 'sym' }, '누름'), h('span', { class: 'lbl' }, labels.press || '—'));
  return h('div', { class: 'ly-knob' }, half('ccw', '↺', 'l'), half('cw', '↻', 'r'), press);
}

/**
 * 조이스틱: 방향 수만큼 부채꼴.
 * @param {{dirs:string[], labels:Record<string,string>, color:string,
 *   on?:(dir:string)=>boolean, wedge?:(dir:string)=>{attrs?:object, onClick?:Function}}} p
 *   on = 동작이 있는 칸(색칠), wedge = 칸마다 덧붙일 속성·클릭 (보기 전용이면 없음)
 */
export function joystickFace({ dirs, labels, color, on = (d) => Boolean(labels[d]), wedge = () => ({}) }) {
  const R = 92; const C = 100;
  const pt = (deg, r) => [C + r * Math.cos((deg * Math.PI) / 180), C + r * Math.sin((deg * Math.PI) / 180)];
  const box = svg('svg', { viewBox: '0 0 200 200', width: 200, height: 200, class: 'ly-joy' });
  const span = 360 / dirs.length;
  for (const d of dirs) {
    const label = labels[d];
    const w = wedge(d);
    const attrs = { class: 'ly-wedge', fill: on(d) ? color : '#3a3834', 'fill-opacity': on(d) ? 0.45 : 1, ...(w.attrs ?? {}) };
    let shape;
    if (dirs.length === 1) {
      shape = svg('circle', { cx: C, cy: C, r: R, ...attrs });
    } else {
      const mid = DIR_DEG[d];
      const [x1, y1] = pt(mid - span / 2, R); const [x2, y2] = pt(mid + span / 2, R);
      shape = svg('path', { d: `M${C},${C} L${x1},${y1} A${R},${R} 0 ${span > 180 ? 1 : 0} 1 ${x2},${y2} Z`, ...attrs });
    }
    if (w.onClick) shape.addEventListener('click', w.onClick);
    box.append(shape);
    const [tx, ty] = dirs.length === 1 ? [C, C] : pt(DIR_DEG[d], R * 0.6);
    box.append(svg('text', { x: tx, y: ty - 4, 'text-anchor': 'middle', class: 'ly-joy-dir' }, DIR_LABEL[d]));
    box.append(svg('text', { x: tx, y: ty + 10, 'text-anchor': 'middle', class: 'ly-joy-lbl' }, (label || '—').slice(0, 8)));
  }
  box.append(svg('circle', { cx: C, cy: C, r: 14, class: 'ly-joy-hub' }));
  return box;
}
