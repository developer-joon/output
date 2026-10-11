/**
 * 조이스틱 방향 나누기 (사용자 결정 2026-10-01, 레이어 2026-10-03).
 * 노브·조이스틱의 '무엇을 할지'는 레이어(src/apps/layers.js)가 정한다. 여기는 방향 이름과 구간만.
 */
export const DIRS4 = Object.freeze(['up', 'right', 'down', 'left']);
export const DIRS8 = Object.freeze(['up', 'up_right', 'right', 'down_right', 'down', 'down_left', 'left', 'up_left']);
const wrap = (a) => ((a % 1) + 1) % 1;
/** 원 위에서 a에서 b로 시계 방향(각도 증가)으로 가는 거리 */
const ahead = (a, b) => wrap(b - a);

/** 방향 수·축 → 칸 이름 (스펙 레이어 §1.4) */
export function dirsFor(count, axis = 'vertical') {
  if (count === 1) return ['any'];
  if (count === 2) return axis === 'horizontal' ? ['left', 'right'] : ['up', 'down'];
  return count === 8 ? [...DIRS8] : [...DIRS4];
}

/**
 * 조이스틱 구간. 1방향 = 원 전체 하나, 2방향 = 축(세로·가로)으로 반씩, 4방향은 장치 보정 그대로. 8방향은 보정 중심각 사이 가운데에 대각선을 넣고,
 * 이웃 중심각의 가운데를 경계로 삼아 원을 빈틈없이 나눈다. 보정이 없으면 null(추측하지 않는다).
 */
export function sectorsFor(count, calibrated, axis = 'vertical') {
  if (!Array.isArray(calibrated) || calibrated.length !== 4) return calibrated ?? null;
  if (count === 1) return [{ direction: 'any', center: 0, from: 0, to: 1 }];
  if (count === 2) {
    const byDir = Object.fromEntries(calibrated.map((s) => [s.direction, wrap(s.center)]));
    // 축과 수직인 두 방향의 중심을 경계로 원을 반으로 나눈다 (각도 규약 right≈0, down≈0.25, left≈0.5, up≈0.75)
    // 세로: right→left 구간(아래를 지남) = down, left→right = up · 가로: up→down 구간(0을 넘어 오른쪽을 지남) = right, down→up = left
    const [a, b] = axis === 'horizontal' ? ['up', 'down'] : ['right', 'left'];
    const [first, second] = axis === 'horizontal' ? ['right', 'left'] : ['down', 'up'];
    return [
      { direction: first, center: wrap(byDir[a] + ahead(byDir[a], byDir[b]) / 2), from: byDir[a], to: byDir[b] },
      { direction: second, center: wrap(byDir[b] + ahead(byDir[b], byDir[a]) / 2), from: byDir[b], to: byDir[a] },
    ];
  }
  if (count !== 8) return calibrated;
  const byDir = Object.fromEntries(calibrated.map((s) => [s.direction, s.center]));
  if (!DIRS4.every((d) => Number.isFinite(byDir[d]))) return calibrated;
  // 각도가 커지는 순서로 4방향 중심을 늘어놓고, 이웃 사이에 대각선을 넣는다
  const four = [...DIRS4].sort((a, b) => wrap(byDir[a]) - wrap(byDir[b]));
  const diag = (a, b) => {
    const pair = [a, b];
    const name = DIRS8.find((d) => d.includes('_') && pair.every((p) => d.split('_').includes(p)));
    return name;
  };
  const centers = [];
  four.forEach((d, i) => {
    const next = four[(i + 1) % 4];
    centers.push({ direction: d, center: wrap(byDir[d]) });
    centers.push({ direction: diag(d, next), center: wrap(byDir[d] + ahead(byDir[d], byDir[next]) / 2) });
  });
  return centers.map((c, i) => {
    const prev = centers[(i + centers.length - 1) % centers.length];
    const next = centers[(i + 1) % centers.length];
    return {
      direction: c.direction,
      center: c.center,
      from: wrap(prev.center + ahead(prev.center, c.center) / 2),
      to: wrap(c.center + ahead(c.center, next.center) / 2),
    };
  });
}
