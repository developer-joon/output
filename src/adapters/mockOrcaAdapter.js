import { WorkUnit, ChildUnit } from '../core/units.js';
import { Status, Confidence } from '../core/types.js';

const S = Status;

/** @param {string} id @param {string} title @param {Array} children */
const wt = (id, title, children, opts = {}) =>
  new WorkUnit({
    id,
    title,
    source: 'orca',
    kind: 'worktree',
    confidence: opts.confidence ?? Confidence.AUTHORITATIVE,
    createdAt: opts.createdAt ?? 0,
    children: children.map(([cid, status, extra = {}]) =>
      new ChildUnit({
        id: `${id}/${cid}`,
        title: cid,
        kind: extra.kind ?? 'terminal',
        status,
        primaryAgent: extra.primaryAgent ?? false,
        confidence: extra.confidence ?? Confidence.AUTHORITATIVE,
        lastActiveAt: extra.lastActiveAt ?? 0,
      })),
  });

/** 묶음을 10칸으로 채우는 조용한 작업 (2026-10-01: 한 묶음 6칸 → 10칸). 각 묶음의 앞 6칸 배치는 그대로다 */
const quiet = (bank) => [7, 8, 9, 10].map((n) => wt(`quiet/b${bank}-${n}`, `quiet/b${bank}-${n}`, [['shell', S.DONE_SEEN]]));

/**
 * 30개 mock WorkUnit = 3 bank × 10칸.
 * Bank 0 (slot 1~10)은 의도적으로 조용하게 두어
 * hidden bank attention 테스트가 가능하도록 구성한다.
 */
export function seedWorkUnits() {
  return [
    // ---- Bank 0: 조용한 작업들 ----
    wt('payments/fix-timeout', 'payments/fix-timeout', [
      ['codex', S.RUNNING, { kind: 'agent', primaryAgent: true, lastActiveAt: 50 }],
      ['test', S.RUNNING, { lastActiveAt: 40 }],
      ['shell', S.DONE_SEEN, { lastActiveAt: 30 }],
      ['build', S.RUNNING],
      ['lint', S.DONE_SEEN],
      ['typecheck', S.RUNNING],
      ['watch', S.RUNNING],
      ['repl', S.DONE_SEEN],
      ['bench', S.RUNNING],
      ['logs', S.DONE_SEEN],
      ['notes', S.DONE_SEEN],         // 11번째 -> detail bank 2로 (한 묶음 10칸)
    ]),
    wt('api/cache-refactor', 'api/cache-refactor', [
      ['claude', S.RUNNING, { kind: 'agent', primaryAgent: true, lastActiveAt: 20 }],
      ['dev server', S.RUNNING],
    ]),
    wt('platform/helm-cleanup', 'platform/helm-cleanup', [
      ['codex', S.RUNNING, { kind: 'agent', primaryAgent: true }],
      ['shell', S.DONE_SEEN],
    ]),
    wt('web/login-a11y', 'web/login-a11y', [['codex', S.RUNNING, { primaryAgent: true }]]),
    wt('infra/tf-upgrade', 'infra/tf-upgrade', [['shell', S.DONE_SEEN]]),
    wt('docs/api-reference', 'docs/api-reference', [['claude', S.RUNNING, { primaryAgent: true }]]),
    ...quiet(0),

    // ---- Bank 1 ----
    wt('search/index-rebuild', 'search/index-rebuild', [
      ['codex', S.RUNNING, { primaryAgent: true, lastActiveAt: 10 }],
      ['reindex', S.ERROR, { lastActiveAt: 60 }],
      ['shell', S.WAITING_INPUT, { lastActiveAt: 70 }],
    ]),
    wt('billing/invoice-pdf', 'billing/invoice-pdf', [
      ['codex', S.WAITING_APPROVAL, { primaryAgent: true, lastActiveAt: 80 }],
      ['test', S.RUNNING],
    ]),
    wt('mobile/push-token', 'mobile/push-token', [
      ['claude', S.WAITING_INPUT, { primaryAgent: true, lastActiveAt: 15 }],
    ]),
    wt('data/etl-backfill', 'data/etl-backfill', [
      ['codex', S.DONE_UNSEEN, { primaryAgent: true }],
      ['shell', S.DONE_SEEN],
    ]),
    wt('auth/oidc-migrate', 'auth/oidc-migrate', [
      ['codex', S.STALE, { primaryAgent: true, confidence: Confidence.INFERRED }],
    ]),
    wt('sre/alert-tuning', 'sre/alert-tuning', [['shell', S.RUNNING, { primaryAgent: true }]]),
    ...quiet(1),

    // ---- Bank 2 ----
    wt('perf/loadtest-v3', 'perf/loadtest-v3', [['runner', S.WAITING_INPUT, { lastActiveAt: 5 }]]),
    wt('ml/feature-store', 'ml/feature-store', [['codex', S.DONE_UNSEEN, { primaryAgent: true }]]),
    wt('core/logging-cleanup', 'core/logging-cleanup', [['codex', S.RUNNING, { primaryAgent: true }]]),
    wt('qa/e2e-flake', 'qa/e2e-flake', [
      ['runner', S.ERROR, { lastActiveAt: 90 }],
      ['shell', S.RUNNING],
    ]),
    wt('ops/argo-sync-audit', 'ops/argo-sync-audit', [['shell', S.RUNNING, { primaryAgent: true }]]),
    wt('net/cdn-config', 'net/cdn-config', [['probe', S.DISCONNECTED]]),
    ...quiet(2),
  ];
}
