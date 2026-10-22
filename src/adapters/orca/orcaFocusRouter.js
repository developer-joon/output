import { FocusRouter } from '../../core/focusRouter.js';
import { OrcaCli, FOCUS_COMMAND } from './orcaCli.js';
import { CHAT_CHILD_PREFIX } from './orcaAdapter.js';

/**
 * Orca 포커스 — **이동만** 한다.
 *
 * 입력을 보내지 않고, 승인하지 않고, 터미널을 만들거나 닫지 않는다.
 * 핸들이 만료되면 한 번만 다시 찾아 재시도하고, 실패는 실패로 보고한다
 * (엉뚱한 대상으로 대신 이동하지 않는다).
 */
export class OrcaFocusRouter extends FocusRouter {
  constructor({ cli = new OrcaCli(), adapter = null, sync = null } = {}) {
    super();
    this.cli = cli;
    this.adapter = adapter;
    // handle → {tabId, leafId} 색인. stale 복구에 쓴다.
    this.sync = sync;
    this.calls = [];
    this.recoveries = 0;
  }

  /**
   * @param {{kind:string, unitId:string, childId:string|null, reason:string,
   *          tabId?:string, leafId?:string}} target
   */
  async focus(target) {
    this.calls.push(target);

    if (!target.childId) {
      return {
        ok: false,
        reasonKo: 'worktree 자체로 이동하는 경로는 아직 확인되지 않았습니다. '
          + '터미널을 지정해 주세요.',
        unsupported: true,
      };
    }

    // 내장 채팅은 터미널이 아니다. CLI에 채팅으로 데려가는 명령이 없다 (Orca 1.4.227, 2026-10-22)
    if (target.childId.startsWith(CHAT_CHILD_PREFIX)) {
      return { ok: false, reasonKo: 'Orca 채팅 세션으로 이동하는 명령이 없습니다. Orca에서 직접 열어 주세요.', unsupported: true };
    }

    // 바로 이동한다. 평소에는 CLI 한 번이면 된다 (노브를 빨리 돌릴 때 반응, 2026-10-04).
    // 실패하면(오래된 핸들이면 Orca가 terminal_handle_stale로 거절 — 실측) 목록에서 같은 자리를 다시 찾아 한 번만 재시도한다.
    const handle = target.childId;
    let firstError;
    try {
      await this.cli.run([...FOCUS_COMMAND, '--terminal', handle]);
      return { ok: true, handle, recovered: false };
    } catch (err) {
      firstError = err;
    }
    if (!this.adapter) return { ok: false, reasonKo: `이동하지 못했습니다: ${firstError.message}` };

    let resolved;
    try {
      const located = this.sync?.locate(handle) ?? null;
      resolved = await this.adapter.resolveHandle({
        handle,
        worktreeId: target.unitId,
        tabId: target.tabId ?? located?.tabId,
        leafId: target.leafId ?? located?.leafId,
      });
    } catch (err) {
      return { ok: false, reasonKo: `이동하지 못했습니다: ${err.message}` };
    }
    if (!resolved.handle) return { ok: false, reasonKo: resolved.reasonKo };
    // 다시 찾아도 같은 핸들이면 재시도해도 같다 — 실패로 알린다 (엉뚱한 곳으로 가지 않는다)
    if (resolved.handle === handle) return { ok: false, reasonKo: `이동하지 못했습니다: ${firstError.message}` };
    try {
      await this.cli.run([...FOCUS_COMMAND, '--terminal', resolved.handle]);
    } catch (err) {
      return { ok: false, reasonKo: `이동하지 못했습니다: ${err.message}` };
    }
    this.recoveries += 1;
    return { ok: true, handle: resolved.handle, recovered: true };
  }
}
