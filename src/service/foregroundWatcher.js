/**
 * 앞 앱 번들 ID를 1초마다 본다 (스펙 2026-10-03 §3). 모드(Orca·앱·대기)는 서비스가 정한다.
 * 우리 앱(상태판·설정)이 앞에 오는 것과 감지 실패는 무시하고 이전 값을 유지한다.
 */
export class ForegroundWatcher {
  constructor({ frontmost, onFront, ignoreBundleIds = [] }) {
    this.frontmost = frontmost;
    this.onFront = onFront;
    this.ignore = new Set(ignoreBundleIds);
    this.current = null;
  }

  async tick() {
    let bundleId;
    try {
      bundleId = await this.frontmost();
    } catch {
      return this.current;
    }
    if (!bundleId || this.ignore.has(bundleId)) return this.current;
    if (bundleId !== this.current) {
      this.current = bundleId;
      this.onFront(bundleId);
    }
    return this.current;
  }
}
