/**
 * 장치 소유 상태기계 (M5 설계 §7).
 *
 * 평소에는 우리가 잡는다. 장치가 뽑히거나 권한이 없어도 앱은 죽지 않는다 —
 * 상태를 남기고 다음 tick에 다시 시도할 뿐이다.
 *
 *   connecting → connected
 *              → missing | busy | denied | error   (다음 tick에 재시도)
 *   connected  → missing   (장치 오류 = 끊김)
 *   any        → suspended (절전) → resume 후 tick에서 다시
 *
 * Input 앱(제조사 앱)에 양보하던 확인은 없앴다 (2026-10-11 사용자 결정: Input 앱을 지움).
 */

/** 열기 실패를 사람이 다룰 수 있는 종류로 나눈다. 권한 문제는 busy와 섞지 않는다. */
export function classifyOpenError(err) {
  const text = `${err?.message ?? ''} ${err?.cause?.message ?? ''}`;
  if (/privilege violation|0xE00002C1|not permitted|operation not permitted/i.test(text)) return 'denied';
  if (err?.code === 'DEVICE_NOT_FOUND') return 'missing';
  if (err?.code === 'DEVICE_BUSY') return 'busy';
  return 'error';
}

const MESSAGE_KO = Object.freeze({
  missing: 'Creator Micro 2를 찾지 못했습니다.',
  busy: '다른 앱이 장치를 쓰고 있습니다.',
  denied: '장치를 열 권한이 없습니다 (입력 모니터링).',
  error: '장치를 열지 못했습니다.',
});

export class DeviceGuard {
  /**
   * @param {object} deps
   * @param {() => Promise<object>} deps.open transport를 연다. 실패하면 throw
   * @param {(transport:object) => void} [deps.onConnected]
   * @param {(reason:string) => void} [deps.onDisconnected]
   */
  constructor({ open, onConnected = () => {}, onDisconnected = () => {} }) {
    this.open = open;
    this.onConnected = onConnected;
    this.onDisconnected = onDisconnected;
    this.state = 'connecting';
    this.messageKo = '';
    this.transport = null;
    this._busy = null;
    this._suspended = false;
  }

  /** 한 번 살펴본다. 겹쳐 불려도 한 번만 돈다. */
  tick() {
    if (!this._busy) {
      this._busy = this._tick().finally(() => { this._busy = null; });
    }
    return this._busy;
  }

  async _tick() {
    if (this._suspended) return;
    if (this.transport) return;
    try {
      const t = await this.open();
      if (this._suspended) {
        // 여는 사이 suspend가 왔다 — 잡지 않는다. HID 소유자는 하나다 (AGENTS.md 4)
        try { t.close(); } catch { /* 무시 */ }
        return;
      }
      this.transport = t;
      this.state = 'connected';
      this.messageKo = '';
      t.onError?.(() => {
        if (this.transport !== t) return;
        this._release('lost');
        this.state = 'missing';
        this.messageKo = '장치 연결이 끊어졌습니다.';
      });
      // 연결 직후 처리(장치 정보 읽기 등)를 기다린다. start()가 끝났을 때 deviceInfo가 채워져 있어야
      // 종료 시 레이어 색 복원과 레이어 경고가 제때 동작한다 (실기 2026-09-27).
      try {
        await this.onConnected(t);
      } catch (err) {
        // 연결 직후 처리가 실패해도 연결 자체는 유효하다. 열기 실패로 분류하면 transport를 쥔 채
        // '열지 못했습니다'로 굳고 다음 tick은 건너뛴다 (최종 리뷰 Important 3).
        this.messageKo = `연결 직후 처리 실패: ${err?.message ?? err}`;
      }
    } catch (err) {
      const kind = classifyOpenError(err);
      this.state = kind;
      this.messageKo = MESSAGE_KO[kind];
    }
  }

  _release(reason) {
    const t = this.transport;
    this.transport = null;
    try { t?.close(); } catch { /* 이미 닫혔을 수 있다 */ }
    this.onDisconnected(reason);
  }

  /** 절전 진입. 장치를 놓고 resume 전까지 열지 않는다. */
  suspend() {
    this._suspended = true;
    if (this.transport) this._release('suspended');
    this.state = 'suspended';
    this.messageKo = '';
  }

  resume() {
    this._suspended = false;
    if (!this.transport) this.state = 'connecting';
  }

  /** 진행 중인 tick이 끝나기를 기다린다. suspend 직후 불러 장치를 확실히 놓게 한다 */
  async settle() {
    await this._busy;
  }

  /** 종료. 장치를 놓는다. */
  close() {
    this._suspended = true;
    if (this.transport) this._release('closed');
  }
}
