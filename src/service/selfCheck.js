/**
 * 점검하기 (2026-10-12 사용자 요청: 다른 Mac에서 세션·포커싱은 되는데 키 LED만 안 켜졌다 — 어디가 막혔는지 설정창에서 보기).
 * 권한 · 장치 연결 · 장치 설정 · LED 테스트 · Orca · 지금 레이어 · 환경을 차례로 본다.
 * 결과 글에는 작업 이름·경로·대화 내용을 넣지 않는다 — 개수와 상태만 (AGENTS.md 12).
 * OutputService.prototype에 붙는다 — this는 서비스다.
 */
import { LED_METHOD } from '../device/deviceDriver.js';

const KEY_COUNT = 13;
const UNDERGLOW_ID = 13;
const STEP_MS = 180;          // 한 단계를 눈으로 볼 시간
const GIVE_UP_AFTER = 3;      // 연달아 이만큼 실패하면 멈춘다 (실패마다 1.2초라 오래 걸리지 않게)
const WHITE = 0xffffff;

/** LED 테스트 한 단계: k번(0~12)만 켜거나, k = 13이면 언더글로우만. 나머지는 끈다 */
export function ledTestPayload(k) {
  const out = [];
  for (let id = 0; id < KEY_COUNT; id++) out.push(id === k ? { id, c: WHITE, b: 1, e: 1, s: 0.5 } : { id, c: 0, e: 0 });
  out.push(k === UNDERGLOW_ID ? { id: UNDERGLOW_ID, c: WHITE, b: 1, e: 1, s: 0.5, sa: 1 } : { id: UNDERGLOW_ID, c: 0, e: 0, sa: 1 });
  return out;
}

const MARK = { true: '✓', false: '✗', null: '–' };

export class SelfCheckMethods {
  /**
   * @param {{accessibility:boolean, arch:string, osKo:string, appVersion:string, orcaBin:string}} env main이 채운다
   * @param {{sleep?:(ms:number)=>Promise<void>}} [opts]
   */
  async selfCheck(env, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    const items = [];
    const add = (id, titleKo, ok, detailKo, fixKo = null, action = null) => items.push({ id, titleKo, ok, detailKo, fixKo, action });

    // 1. 권한
    const inputOk = this.guard.state !== 'denied';
    add('permissions', '권한', inputOk && env.accessibility,
      `입력 모니터링 ${inputOk ? '켜짐' : '꺼짐'} · 손쉬운 사용 ${env.accessibility ? '켜짐' : '꺼짐'}`,
      !inputOk ? '시스템 설정 → 개인정보 보호 및 보안 → 입력 모니터링에서 Output을 켜고 다시 시작하세요.'
        : !env.accessibility ? '단축키를 보내려면 손쉬운 사용에서 Output을 켜세요.' : null,
      !inputOk ? 'open-input-monitoring' : !env.accessibility ? 'open-accessibility' : null);

    // 2. 장치 연결
    const t = this.transport;
    const conn = { usb: 'USB', bluetooth: '블루투스' }[t?.connection] ?? t?.connection ?? '';
    const batt = Number.isFinite(this.power?.battery) ? ` · 배터리 ${this.power.battery}%${this.power.charging ? ' 충전 중' : ''}` : '';
    add('device', '장치 연결', Boolean(t),
      t ? `Creator Micro 2 연결됨 · ${conn}${batt}` : (this.guard.messageKo || '연결되어 있지 않습니다.'),
      t ? null : '키보드를 USB로 꽂거나 블루투스로 연결하세요. 다른 Mac에 블루투스로 붙어 있으면 이 Mac에서는 보이지 않습니다.');

    // 3. 장치 설정 (keymap)
    if (!t) add('keymap', '장치 설정', null, '장치가 없어 건너뜀');
    else {
      const ds = this.deviceStatus();
      add('keymap', '장치 설정', ds.ready,
        ds.ready ? `Output 레이어 (키 1~13 = AG00~AG12)` : ds.reasonsKo.join(' · '),
        ds.ready ? null : '설정 → 설치 → 4 장치 준비', ds.ready ? null : 'device-prep');
    }

    // 4. LED 테스트
    if (!t) add('led', 'LED 테스트', null, '장치가 없어 건너뜀');
    else add('led', 'LED 테스트', ...(await this._ledTest(sleep, conn)));

    // 5. Orca
    const units = this.store.allUnits().filter((u) => u.source === 'orca');
    const agents = units.reduce((n, u) => n + (u.children?.length ?? 0), 0);
    const orcaOk = this.orcaState === 'connected';
    add('orca', 'Orca', orcaOk,
      `${orcaOk ? '연결됨' : (this.orcaMessageKo || this.orcaState)} · 명령 ${env.orcaBin || '못 찾음'}${this.versions?.orca ? ` · 버전 ${this.versions.orca}` : ''} · 작업 ${units.length}개 · 에이전트 ${agents}개`,
      orcaOk ? (units.length ? null : '돌고 있는 작업이 없으면 작업 칸 키는 꺼져 있습니다.') : 'Orca를 열면 자동으로 다시 읽습니다.');

    // 6. 지금 레이어
    const line = this._layerLine();
    add('layer', '지금 레이어', null, `${line.nowKo} · ${{ orca: 'Orca 모드 (작업 칸)', app: '앱 모드' }[this.mode] ?? this.mode}`,
      this.mode === 'orca' ? null : 'Orca를 앞에 두면(또는 노브로 Orca 레이어를 고정하면) 작업 칸 키가 작업 상태를 보여 줍니다.');

    // 7. 환경
    add('env', '환경', null, `Output ${env.appVersion} · 펌웨어 ${this.versions?.firmware ?? '—'} · ${env.osKo} · ${env.arch === 'arm64' ? 'Apple 실리콘' : env.arch === 'x64' ? 'Intel' : env.arch} (${env.arch})`);

    const text = ['Output 점검', ...items.map((i) => `${MARK[i.ok]} ${i.titleKo}: ${i.detailKo}${i.fixKo ? ` → ${i.fixKo}` : ''}`)].join('\n');
    return { items, text };
  }

  /** 키 13개와 언더글로우를 하나씩 켠다. 그동안 평소 그리기는 장치에 보내지 않고, 끝나면 처음부터 다시 그린다 */
  async _ledTest(sleep, conn) {
    this._ledTesting = true;
    let ok = 0; let fails = 0; let tried = 0; let lastErr = null;
    try {
      for (let k = 0; k <= UNDERGLOW_ID; k++) {
        tried += 1;
        try { await this.transport.call(LED_METHOD, ledTestPayload(k), 1200); ok += 1; fails = 0; } catch (err) { fails += 1; lastErr = err; }
        if (fails >= GIVE_UP_AFTER) break;
        await sleep(STEP_MS);
      }
      if (fails < GIVE_UP_AFTER) await this.transport?.call(LED_METHOD, ledTestPayload(-1), 1200).catch(() => {});
    } finally {
      this._ledTesting = false;
      this.driver.invalidate();
      this.scheduler.resync();
    }
    const total = UNDERGLOW_ID + 1;
    const stopped = fails >= GIVE_UP_AFTER ? ` (연달아 ${GIVE_UP_AFTER}번 실패해 ${tried}번째에서 멈춤)` : '';
    const err = lastErr ? ` · 마지막 오류 (${conn}): ${lastErr.message}` : '';
    return [ok === total, `${total}개 중 ${ok}개 성공${stopped}${err}`,
      ok === total ? '키가 하나씩 하얗게 켜졌는지 눈으로도 확인하세요.' : `${conn === '블루투스' ? 'USB로 연결해 다시 점검해 보세요. USB에서 되면 블루투스 LED 쓰기 문제입니다.' : 'Output을 다시 시작해 보세요.'}`];
  }
}
