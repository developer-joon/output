/**
 * 설정 화면 앱 고르기의 묶음 (2026-10-09 사용자 요청): 최근 연결 → 실행 중 → 설치된 앱.
 * 앞 묶음에 있는 앱은 뒤 묶음에서 뺀다. 순수 모듈 — 렌더러가 그대로 쓴다.
 */

/** 레이어들이 이미 쓰는 앱(연결 앱 · 앱 열기 · 레이아웃 항목), 처음 나온 순서 */
function recentApps(layers) {
  const out = [];
  const push = (bundleId, name) => { if (bundleId && !out.some((a) => a.bundleId === bundleId)) out.push({ bundleId, name: name || bundleId }); };
  const fromAction = (a) => {
    if (a?.type === 'openApp') push(a.bundleId, a.appName);
    if (a?.type === 'layout') for (const it of a.items ?? []) push(it.bundleId, it.appName);
  };
  for (const l of layers ?? []) {
    for (const app of l.apps ?? []) push(app.bundleId, app.name);
    for (const a of Object.values(l.keys ?? {})) fromAction(a);
    for (const a of Object.values(l.dial ?? {})) fromAction(a);
    for (const a of Object.values(l.joystick?.short ?? {})) fromAction(a);
  }
  return out;
}

/** @returns {{labelKo:string, apps:{bundleId:string,name:string}[]}[]} 빈 묶음은 뺀다 */
export function groupApps({ layers = [], running = [], installed = [], exclude = [] }) {
  const seen = new Set(exclude);
  const take = (list) => list.filter((a) => a?.bundleId && !seen.has(a.bundleId) && seen.add(a.bundleId));
  return [
    { labelKo: '최근 연결', apps: take(recentApps(layers)) },
    { labelKo: '실행 중', apps: take(running) },
    { labelKo: '설치된 앱', apps: take(installed) },
  ].filter((g) => g.apps.length);
}
