/**
 * 노브·조이스틱 화면 표시 그리기 (2026-10-10).
 * 조이스틱: 디코더와 같은 구간 · 지금 위치 점 · 들어간 칸 강조 · 길게 칸이면 0.5초 고리. 노브: 동작 이름 한 줄.
 * 장치 각도 규약 right = 0, down = 0.25 (시계 방향) — 캔버스 각도와 방향이 같다.
 */
const root = document.getElementById('hud');
const DIR_ARROW = { up: '↑', down: '↓', left: '←', right: '→', up_left: '↖', up_right: '↗', down_left: '↙', down_right: '↘', any: '•' };
const DIAL_ICON = { cw: '↻', ccw: '↺', press: '●' };
let hud = null;
let recvAt = 0;
let raf = 0;

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }

function drawJoystick(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const S = 188;
  canvas.width = S * dpr; canvas.height = S * dpr;
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  const c = S / 2; const R = c - 6;
  const T = (a) => a * Math.PI * 2;
  // 칸
  for (const s of hud.sectors) {
    const active = s.direction === hud.dir;
    g.beginPath(); g.moveTo(c, c);
    if (s.from === s.to) g.arc(c, c, R, 0, Math.PI * 2);
    else g.arc(c, c, R, T(s.from), T(s.to + (s.to < s.from ? 1 : 0)));
    g.closePath();
    g.fillStyle = active ? 'rgba(255,255,255,.30)' : (s.short || s.long ? 'rgba(255,255,255,.10)' : 'rgba(255,255,255,.04)');
    g.fill();
    g.strokeStyle = 'rgba(255,255,255,.22)'; g.lineWidth = 1; g.stroke();
  }
  // 반응하지 않는 가운데
  g.beginPath(); g.arc(c, c, Math.max(8, R * hud.deadzone), 0, Math.PI * 2);
  g.fillStyle = 'rgba(0,0,0,.35)'; g.fill();
  // 길게: 0.5초 고리
  const held = hud.dir ? hud.heldMs + (performance.now() - recvAt) : 0;
  const p = hud.hold && hud.dir ? Math.min(1, held / hud.holdMs) : 0;
  if (p > 0) {
    g.beginPath(); g.arc(c, c, R - 1, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2);
    g.strokeStyle = p >= 1 ? '#f2a36b' : 'rgba(242,163,107,.75)'; g.lineWidth = 4; g.lineCap = 'round'; g.stroke();
  }
  // 지금 위치
  const r = Math.min(1, hud.distance) * R;
  const x = c + Math.cos(T(hud.angle)) * r; const y = c + Math.sin(T(hud.angle)) * r;
  g.beginPath(); g.arc(x, y, 7, 0, Math.PI * 2);
  g.fillStyle = '#fff'; g.shadowColor = 'rgba(0,0,0,.5)'; g.shadowBlur = 6; g.fill(); g.shadowBlur = 0;
  return p;
}

function render() {
  cancelAnimationFrame(raf);
  root.replaceChildren();
  if (!hud) return;
  if (hud.kind === 'picker') {
    // 노브로 레이어 고르기 (2026-10-10): 돌려서 옮기고 누르면 고름
    const box = el('div', 'plate picker');
    box.append(el('div', 'picker-title', '레이어 고르기'));
    const list = el('div', 'picker-list');
    hud.items.forEach((it, i) => {
      const row = el('div', `picker-item${i === hud.index ? ' on' : ''}`);
      const dot = el('span', 'picker-dot');
      if (it.color) dot.style.background = it.color; else dot.classList.add('auto');
      row.append(dot, el('span', 'picker-name', it.name));
      list.append(row);
    });
    box.append(list, el('div', 'picker-help', '돌려서 고르고 누르세요'));
    root.append(box);
    list.children[hud.index]?.scrollIntoView({ block: 'nearest' });
    return;
  }
  if (hud.kind === 'dial') {
    const box = el('div', 'plate dial');
    box.append(el('span', 'icon', DIAL_ICON[hud.action] ?? '•'), el('span', 'text', hud.label));
    root.append(box);
    return;
  }
  const box = el('div', 'plate joy');
  const canvas = el('canvas');
  const label = el('div', 'label');
  box.append(canvas, label);
  root.append(box);
  const s = hud.sectors.find((x) => x.direction === hud.dir);
  const tick = () => {
    const p = drawJoystick(canvas);
    label.replaceChildren();
    if (!hud.dir) label.append(el('small', '', '가운데'));
    else {
      const arrow = DIR_ARROW[hud.dir] ?? '';
      const long = p >= 1 && s?.long;
      label.append(el('div', '', `${arrow} ${long ? `길게: ${s.long}` : (s?.short ?? '동작 없음')}`));
      if (s?.long && !long) label.append(el('small', '', `길게 누르면: ${s.long}`));
    }
    if (hud.hold && hud.dir && p < 1) raf = requestAnimationFrame(tick);
  };
  tick();
}

window.cb.on('cb:hud', (h) => {
  if (h.fade) { root.classList.remove('on'); return; }
  hud = h; recvAt = performance.now();
  render();
  root.classList.add('on');
});
