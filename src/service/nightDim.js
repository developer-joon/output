/**
 * 밤 시간 밝기 (2026-10-10 사용자 요청): 정한 시간에는 LED를 한 단계(반) 어둡게. 기본 꺼짐, 22:00~07:00.
 */
export const NIGHT_DEFAULT = Object.freeze({ enabled: false, from: '22:00', to: '07:00' });
const HM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function normalizeNight(raw) {
  return {
    enabled: raw?.enabled === true,
    from: HM.test(raw?.from ?? '') && HM.test(raw?.to ?? '') ? raw.from : NIGHT_DEFAULT.from,
    to: HM.test(raw?.from ?? '') && HM.test(raw?.to ?? '') ? raw.to : NIGHT_DEFAULT.to,
  };
}

const minutes = (hm) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };

/** date가 from~to 안인가. from > to면 자정을 넘는 구간 (끝 시각은 포함하지 않는다) */
export function inNight(date, from, to) {
  const t = date.getHours() * 60 + date.getMinutes();
  const a = minutes(from); const b = minutes(to);
  return a <= b ? t >= a && t < b : t >= a || t < b;
}
