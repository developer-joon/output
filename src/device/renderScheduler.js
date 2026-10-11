import { Events } from '../core/eventBus.js';
import { buildDeviceScene } from './deviceScene.js';
import { AmbientPulse } from './ambientPulse.js';
import { NOTICE_BLINK_MS } from '../core/attentionNotice.js';

/**
 * 새 개입 알림을 다시 그리는 간격. 깜빡임 반주기보다 촘촘해야 보인다.
 * ambient 점멸(200ms 간격)로는 창 안에서 한 번밖에 못 바뀐다 (13차).
 */
export const NOTICE_TICK_MS = NOTICE_BLINK_MS / 2;

/**
 * EventBus의 실제 소비자 (CODEX_NEXT_TASK_KO.md 3절).
 *
 *   Store commit(revision) → COMMITTED → RenderScheduler
 *   → 같은 revision의 snapshot/DeviceScene → 출력 어댑터
 *
 * - 쓰기는 단일 직렬 writer. 동시에 두 개가 나가지 않는다.
 * - burst는 최신 것으로 병합한다. 중간 프레임은 버려도 되지만
 *   업무 이벤트(Store commit) 자체는 이미 Store에 반영되어 있으므로 유실되지 않는다 (C18).
 * - 늦게 끝난 옛 렌더가 새 상태를 덮지 않는다 (C17).
 * - 재연결 시 현재 원하는 전체 상태를 다시 적용한다 (C34).
 *
 * 이 클래스는 두 번째 업무 상태 저장소가 아니다. 장치 동기화 bookkeeping만 한다.
 */
export class RenderScheduler {
  constructor({
    bridge, device, bus = bridge.bus, ambientPulse = null, noticePulse = null, overlays = () => ({}), flash = () => null,
    setTimer = (fn, ms) => { const h = setTimeout(fn, ms); h.unref?.(); return h; }, clearTimer = (h) => clearTimeout(h),
  }) {
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this._retryMs = 0;
    this._retryTimer = null;
    this.bridge = bridge;
    this.flash = flash;         // 연결 인사 공급자 (2026-10-10)
    this.overlays = overlays;   // 키 LED 덧칠 공급자 (2026-10-04)
    this.device = device;
    this.bus = bus;
    // ambient zone이 없는 장치에서만 쓰는 점멸 시계.
    this.ambientPulse = ambientPulse
      ?? (device.capabilities?.supportsAmbientZone === false
        ? new AmbientPulse({ onTick: () => this.requestRender() })
        : null);

    // 새 개입 알림 전용 시계. ambient보다 빠르게 돌아야 깜빡임이 보인다.
    this.noticePulse = noticePulse
      ?? new AmbientPulse({
        periodMs: NOTICE_TICK_MS * 2, steps: 2, onTick: () => this.requestRender(),
      });

    this.desiredRevision = -1;
    this.lastAppliedRevision = -1;
    this.coalescedCount = 0;

    this._running = false;
    this._pending = false;
    this._idleWaiters = [];
    this._unsubscribes = [];
  }

  start() {
    // 업무 상태 변경
    this._unsubscribes.push(this.bus.on(Events.COMMITTED, () => this.requestRender()));
    // Store commit이 없는 표시 전용 변경도 장치에 반영되어야 한다.
    for (const e of [Events.ACTIVE_CHANGED, Events.BANK_CHANGED, Events.VIEW_CHANGED]) {
      this._unsubscribes.push(this.bus.on(e, () => this.requestRender()));
    }
    this._unsubscribes.push(this.bus.on(Events.DEVICE_CONNECTED, () => this.resync()));
    this.requestRender();
    return this;
  }

  stop() {
    if (this._retryTimer) { this.clearTimer(this._retryTimer); this._retryTimer = null; }
    for (const off of this._unsubscribes) off();
    this._unsubscribes = [];
    this.ambientPulse?.stop();
    this.noticePulse?.stop();
  }

  /** 뷰 전용 변경(bank 이동 등 Store commit이 없는 경우)에도 쓸 수 있다. */
  requestRender() {
    if (this._running) {
      this._pending = true;
      this.coalescedCount += 1;
      return;
    }
    this._pump();
  }

  _scheduleRetry() {
    if (this._retryTimer) return;
    this._retryMs = Math.min(2000, this._retryMs ? this._retryMs * 2 : 200);
    this._retryTimer = this.setTimer(() => { this._retryTimer = null; this.requestRender(); }, this._retryMs);
  }

  /** 재연결: 최신 원하는 상태를 통째로 다시 적용한다. */
  resync() {
    this.lastAppliedRevision = -1;
    this.requestRender();
  }

  async _pump() {
    this._running = true;
    try {
      do {
        this._pending = false;
        // 항상 '지금' 상태로 다시 만든다. 큐에 쌓인 옛 프레임을 쓰지 않는다.
        const snapshot = this.bridge.render();
        this.desiredRevision = snapshot.revision;
        const scene = buildDeviceScene(snapshot, this.device.capabilities, {
          ambientPhase: this.ambientPulse ? this.ambientPulse.phase : null,
          overlays: this.overlays(),
          flash: this.flash(),
        });
        // 알릴 것이 있을 때만 점멸 시계를 돌린다.
        this.ambientPulse?.syncTo(Boolean(scene.ambientFallback?.active));
        this.noticePulse?.syncTo(Boolean(scene.notice?.active));
        const result = await this.device.applyScene(scene);
        // 쓰기 실패(블루투스에서 입력과 겹칠 때 등)는 0.2초부터 두 배씩(최대 2초) 뒤 다시 그려 보낸다 (2026-10-11 실기:
        // 노브로 레이어를 고른 직후 쓰기가 실패하면 다음 변화가 올 때까지 키 LED가 그대로였다)
        if (!result.ok && result.retryable) this._scheduleRetry();
        else if (result.ok) this._retryMs = 0;
        if (result.ok) {
          // 쓰기 도중 더 새로운 상태가 생겼다면 그 결과로 덮지 않는다.
          if (scene.revision >= this.lastAppliedRevision) {
            this.lastAppliedRevision = scene.revision;
          }
        }
      } while (this._pending);
    } finally {
      this._running = false;
      const waiters = this._idleWaiters;
      this._idleWaiters = [];
      for (const w of waiters) w();
    }
  }

  /** 테스트/데모용: 대기 중인 렌더가 모두 끝날 때까지 기다린다. */
  async idle() {
    if (!this._running) return;
    await new Promise((resolve) => this._idleWaiters.push(resolve));
  }

  get inSync() {
    return this.lastAppliedRevision === this.desiredRevision;
  }
}
