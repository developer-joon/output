/**
 * FocusRouter interface.
 * AGENTS.md 9: focus만 수행한다. 자동 입력/승인/명령 실행 금지.
 */
export class FocusRouter {
  // eslint-disable-next-line no-unused-vars
  async focus(_target) {
    throw new Error('not implemented');
  }
}

export class MockFocusRouter extends FocusRouter {
  constructor() {
    super();
    this.calls = [];
  }

  async focus(target) {
    this.calls.push(target);
    return { ok: true, target };
  }

  last() {
    return this.calls[this.calls.length - 1] ?? null;
  }
}
