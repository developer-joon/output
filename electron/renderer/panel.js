import { h } from './dom.js';

/** 도움말: 작은 ? 버튼을 누르면 사용 방법이 뜬다. 바깥을 누르면 닫힌다 */
export function helpBtn(lines) {
  const pop = h('div', { class: 'help-pop', hidden: true, role: 'dialog' }, h('ul', {}, lines.map((l) => h('li', {}, l))));
  const btn = h('button', { class: 'help-btn', 'aria-label': '사용 방법', 'aria-expanded': 'false', onclick: (e) => {
    e.stopPropagation();
    pop.hidden = !pop.hidden;
    btn.setAttribute('aria-expanded', String(!pop.hidden));
  } }, '?');
  return h('span', { class: 'help' }, btn, pop);
}
document.addEventListener('click', (e) => {
  for (const pop of document.querySelectorAll('.help-pop:not([hidden])')) {
    if (pop.contains(e.target)) continue;
    pop.hidden = true;
    pop.parentElement.querySelector('.help-btn')?.setAttribute('aria-expanded', 'false');
  }
});

/** 화면 틀: 제목 + 사용 방법(?) */
export const panel = (title, help, ...body) => h('section', { class: 'panel' },
  h('div', { class: 'panel-head' }, h('h2', {}, title), help ? helpBtn(help) : null), ...body);
