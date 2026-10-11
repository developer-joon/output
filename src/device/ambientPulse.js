import { DEFAULT_PERIOD_MS } from '../core/ambientFallback.js';

/**
 * 점멸 위상 시계.
 *
 * ambient zone이 없는 장치에서 숨은 개입을 알리려면 주기적으로 다시 그려야 한다.
 * 타이머를 주입할 수 있어 장치도 실시간도 없이 테스트할 수 있다.
 *
 * 필요할 때만 돈다 — 알릴 것이 없으면 타이머를 멈춘다.
 */
export class AmbientPulse {
  constructor({
    periodMs = DEFAULT_PERIOD_MS, steps = 8,
    // 점멸 시계가 프로세스를 붙잡으면 안 된다. unref로 이벤트 루프에서 제외한다.
    setTimer = (fn, ms) => {
      const h = setInterval(fn, ms);
      h.unref?.();
      return h;
    },
    clearTimer = (h) => clearInterval(h),
    onTick = () => {},
  } = {}) {
    this.periodMs = periodMs;
    this.steps = steps;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.onTick = onTick;
    this.phase = 0;
    this.running = false;
    this._handle = null;
    this.tickCount = 0;
  }

  start() {
    if (this.running) return this;
    this.running = true;
    this._handle = this.setTimer(() => this.advance(), this.periodMs / this.steps);
    return this;
  }

  stop() {
    if (!this.running) return this;
    this.running = false;
    this.clearTimer(this._handle);
    this._handle = null;
    this.phase = 0;
    return this;
  }

  advance() {
    this.phase = (this.phase + 1 / this.steps) % 1;
    this.tickCount += 1;
    this.onTick(this.phase);
    return this.phase;
  }

  /** 알릴 것이 있을 때만 돌게 한다. */
  syncTo(shouldRun) {
    if (shouldRun && !this.running) this.start();
    else if (!shouldRun && this.running) this.stop();
    return this.running;
  }
}
