import { LOGICAL_KEYS } from './deviceScene.js';

/**
 * DeviceScene(13개 논리 키) → 실제 장치 payload.
 *
 * 실기 확정 사실:
 *   - LED method는 v.oai.thstatus 하나
 *   - **배열 위치가 곧 키**다. 13개를 한 번에 보내야 한다
 *   - id는 AG 번호다. AG 코드가 묶인 키가 켜진다 (실기 16차). Output 레이어는 13키 전부 AG
 *   - 물리 키 없는 id(13)에 sa:1을 실으면 언더글로우만 그 색이 된다 (실기 16차)
 *   - 빈 배열은 해제가 아니다
 *
 * 제어할 수 없는 키를 조용히 버리지 않고 unsupported로 보고한다.
 */
export const LED_METHOD = 'v.oai.thstatus';
/** 런타임 transport가 부를 수 있는 method 전부. 쓰기(fs.write)는 없다. */
export const RUNTIME_METHODS = Object.freeze(['sys.version', 'device.status', 'fs.read', LED_METHOD]);

/**
 * 스타일 pattern → 장치 효과 파라미터 (실기 2026-10-02, 주황으로 e·s 값 비교).
 *   e: 0·2·5 꺼짐 · 1 고정 · 3 숨쉬며 회전·색 변화 · 4 완전히 꺼졌다 켜짐 · 6 연해졌다 진해짐
 *   s: 속도 (0.2 느림 ~ 0.9 빠름). 사용자 선택: e=6, s=0.9
 * 숨쉬기는 장치가 스스로 한다. 앱이 밝기를 반복해 보내면 깜박여 보였다.
 * 표에 없는 pattern은 고정으로 나간다.
 */
export const PATTERN_PARAMS = Object.freeze({
  // 상태별 움직임 (2026-10-10, 실기: 키·언더글로우 모두 e 6·3·4가 먹는다)
  breathing_fast: Object.freeze({ e: 6, s: 0.9 }),
  breathing: Object.freeze({ e: 6, s: 0.5 }),
  breathing_slow: Object.freeze({ e: 6, s: 0.25 }),
  blink_fast: Object.freeze({ e: 4, s: 0.9 }),
  rotate: Object.freeze({ e: 3, s: 0.5 }),
});
/** 스타일 → 장치 e·s. 키 LED 설정처럼 e를 직접 담았으면 그것, 아니면 움직임 이름으로 (모르면 고정) */
const effectOf = (st, s) => (st.e !== undefined ? { e: st.e, s: st.s ?? s } : (PATTERN_PARAMS[st.pattern] ?? {}));

/** 논리 키 → LED 배열 index (calibration 기준) */
export function indexOfLogical(calibration, logical) {
  const map = calibration?.led?.indexToLogical ?? {};
  for (const [idx, l] of Object.entries(map)) {
    if (l === logical) return Number(idx);
  }
  return -1;
}

const DEFAULT_PAYLOAD_PARAMS = Object.freeze({ b: 1, e: 1, s: 0.5, sk: 0, sa: 0 });

/**
 * 장치로 보낼 짧은 항목 (실기 2026-10-10): sk와 꺼진 칸의 s는 빼도 같은 색이다. 꺼진 칸의 e(0)는 빼면 안 된다.
 * 켜진 칸은 키도 언더글로우도 b를 남긴다 (실기 2026-10-12 다른 Mac: 장치가 다시 켜져 b가 초기값이면 b 없는 키는
 * 색을 보내도 꺼져 있었다 — 10-10 확인은 b가 이미 1이던 장치에서 한 것). 언더글로우는 sa:1도.
 */
export function slimEntry(e) {
  const o = { id: e.id, c: e.c };
  if (e.c) o.b = e.b;                  // 켜진 칸은 b — 없으면 장치에 남은 b(초기값이면 꺼짐)를 쓴다 (실기 2026-10-10 언더글로우, 10-12 키)
  if (e.c) { o.e = e.e; o.s = e.s; } else o.e = 0;   // 꺼진 칸도 e:0 — 빼면 장치가 앞 효과(인사 회전 등)를 계속 쓴다 (실기 2026-10-10)
  if (e.sk) o.sk = e.sk;
  if (e.sa) o.sa = e.sa;
  return o;
}

/** 언더글로우(가상 스레드) 꺼짐 항목 */
const ambientOffEntry = (id, s) => ({ id, c: 0, b: 0, e: 0, s, sk: 0, sa: 1 });

export class DeviceDriver {
  /**
   * @param {object} opts
   * @param {object} opts.calibration
   * @param {(payload:any[])=>Promise<any>} opts.send  thstatus 호출
   */
  constructor({ calibration, send }) {
    this.calibration = calibration;
    this.send = send;
    this.appliedCount = 0;
    this.lastPayload = null;
    /** 밤 시간 밝기 배율 (2026-10-10). 1 = 그대로, 0.5 = 반 */
    this.brightnessScale = 1;
    /** 대기·종료 시 되돌릴 레이어색 (0xRRGGBB). 모르면 null → 전부 꺼짐 */
    this.restoreColor = null;
  }

  get capabilities() {
    return this._capabilities ?? {};
  }

  set capabilities(v) {
    this._capabilities = v;
  }

  get keyCount() {
    return this.calibration?.led?.keyCount ?? 13;
  }

  get controllableIndices() {
    return this.calibration?.led?.controllableIndices ?? [];
  }

  /** 대기·종료 시 페이로드: 13키를 레이어색(모르면 꺼짐)으로, 언더글로우는 끈다. 항목 수는 평소와 같다 */
  restorePayload() {
    const params = this.calibration?.led?.payloadParams ?? DEFAULT_PAYLOAD_PARAMS;
    const c = Number.isInteger(this.restoreColor) ? this.restoreColor : null;
    const payload = Array.from({ length: this.keyCount }, (_, id) => ({
      id, c: c ?? 0, b: c ? 1 : 0, e: c ? 1 : 0, s: params.s, sk: 0, sa: 0,
    }));
    const ambient = this.calibration?.led?.ambient;
    if (ambient?.method === 'virtual_thread') payload.push(ambientOffEntry(ambient.id, params.s));
    return payload;
  }

  /**
   * scene을 payload로 바꾼다.
   * @returns {{payload:any[], unsupportedKeys:string[], appliedKeys:string[]}}
   */
  toPayload(scene) {
    if (scene.inactive) return { payload: this.restorePayload(), unsupportedKeys: [], appliedKeys: [], ambientApplied: false, restored: true };
    const params = this.calibration?.led?.payloadParams ?? DEFAULT_PAYLOAD_PARAMS;
    const payload = [];
    const unsupportedKeys = [];
    const appliedKeys = [];

    for (let index = 0; index < this.keyCount; index += 1) {
      const logical = this.calibration?.led?.indexToLogical?.[String(index)] ?? null;
      const style = logical ? scene.keys?.[logical] : null;
      const controllable = this.controllableIndices.includes(index);

      if (!controllable || !style) {
        // 제어할 수 없는 자리도 배열 길이를 맞추기 위해 채운다. 꺼진 값으로 보낸다.
        payload.push({ id: index, c: 0, b: 0, e: 0, s: params.s, sk: 0, sa: 0 });
        continue;
      }
      payload.push({
        id: index,
        c: colorToInt(style.color, (style.brightness ?? 1) * this.brightnessScale),
        ...params,
        // 키별 LED 설정(2026-10-04)은 e·s를 직접 담는다. 없으면 패턴 이름으로
        ...effectOf(style, params.s),
      });
      appliedKeys.push(logical);
    }

    for (const key of LOGICAL_KEYS) {
      if (!appliedKeys.includes(key)) unsupportedKeys.push(key);
    }

    // 언더글로우: 가상 스레드 항목. 항상 보낸다 — 빼면 장치에 이전 색이 남는다.
    let ambientApplied = false;
    const ambient = this.calibration?.led?.ambient;
    if (ambient?.method === 'virtual_thread') {
      const z = scene.ambientZone;
      const on = Boolean(z) && z.color !== 'off' && (z.brightness ?? 0) > 0;
      payload.push(on
        // 언더글로우도 숨쉬기 등 효과가 먹는다 (실기 2026-10-10, b:1이 있어야 켜짐)
        ? { id: ambient.id, c: colorToInt(z.color, (z.brightness ?? 1) * this.brightnessScale), b: 1, e: 1, s: params.s, sk: 0, sa: 1, ...effectOf(z, params.s) }
        : ambientOffEntry(ambient.id, params.s));
      ambientApplied = on;
    }
    return { payload, unsupportedKeys, appliedKeys, ambientApplied };
  }

  async applyScene(scene) {
    if (this.calibration?.led?.addressing !== 'array_position') {
      return { ok: false, reasonKo: 'LED 주소 방식이 확정되지 않아 장치에 보내지 않습니다.' };
    }
    const { payload, unsupportedKeys, appliedKeys, ambientApplied, restored = false } = this.toPayload(scene);
    this.lastPayload = payload;
    const slim = payload.map(slimEntry);
    // 직전에 보낸 것과 같으면 보내지 않는다 (2026-10-11 실기: Orca 모드에서 같은 명령이 2초마다 나가 블루투스가 밀렸다).
    // 실패했거나 다시 연결되면(invalidate) 같아도 보낸다
    const key = JSON.stringify(slim);
    if (key === this._lastSentKey) return { ok: true, skipped: true, appliedKeys, unsupportedKeys, ambientApplied, restored };
    try {
      await this.send(slim);
    } catch (err) {
      this._lastSentKey = null;
      // 쓰기 실패는 잠시 뒤 다시 보낼 수 있다 (스케줄러가 다시 그린다, 2026-10-11)
      return { ok: false, retryable: true, reasonKo: `장치 쓰기 실패: ${err.message}` };
    }
    this._lastSentKey = key;
    this.appliedCount += 1;
    return { ok: true, appliedKeys, unsupportedKeys, ambientApplied, restored };
  }

  /** 다음 장면은 직전과 같아도 보낸다 (다시 연결·장치 쪽 색이 바뀌었을 수 있을 때) */
  invalidate() {
    this._lastSentKey = null;
  }
}

/** 이름색 + 밝기 → 0xRRGGBB. 장치는 정수 색을 받는다. */
const NAMED = Object.freeze({
  off: [0, 0, 0],
  red: [255, 0, 0],
  orange: [255, 128, 0],
  vermilion: [255, 48, 0],
  rose: [255, 0, 90],
  apricot: [255, 150, 90],
  amber: [255, 191, 0],
  green: [0, 255, 0],
  blue: [0, 128, 255],
  purple: [160, 0, 255],
  white: [255, 255, 255],
  // 대기 칸 흐린 흰색 (2026-10-10: 표에 없어 꺼짐으로 나가던 것)
  dim_white: [255, 255, 255],
  neutral_dim: [128, 128, 128],
  neutral_gray: [160, 160, 160],
  indigo: [75, 0, 200],
  muted_violet: [150, 120, 200],
  muted_blue: [90, 140, 220],
  warm_white: [255, 230, 190],
  teal: [0, 180, 170],
  muted_purple: [150, 100, 200],
});

export function colorToInt(color, brightness = 1) {
  // 이름색 또는 '#RRGGBB' (앱 키 세트 색, 2026-10-03)
  const hex = /^#([0-9a-f]{6})$/i.exec(color ?? '');
  const base = hex
    ? [16, 8, 0].map((shift) => (parseInt(hex[1], 16) >> shift) & 0xff)
    : (NAMED[color] ?? NAMED.off);
  const b = Math.max(0, Math.min(1, brightness ?? 1));
  const [r, g, bl] = base.map((v) => Math.round(v * b));
  return (r << 16) | (g << 8) | bl;
}
