import { OrcaCli } from './orcaCli.js';
import { OrcaAdapter } from './orcaAdapter.js';
import { OrcaFocusRouter } from './orcaFocusRouter.js';
import { OrcaSync } from './orcaSync.js';
import { OrcaSettings } from './orcaSettings.js';

export { OrcaCli, OrcaCliError, READ_COMMANDS, FOCUS_COMMAND, FORBIDDEN_VERBS, isAllowed }
  from './orcaCli.js';
export { OrcaAdapter, toWorkUnit, toChildUnit, terminalStatus, roleOfTerminal }
  from './orcaAdapter.js';
export { OrcaFocusRouter } from './orcaFocusRouter.js';
export { OrcaSync } from './orcaSync.js';

/** 이 어댑터의 소스 정의. 서비스는 앞 앱이 이 번들 중 하나일 때만 활성이다 (스펙 §2) */
export { OrcaSettings } from './orcaSettings.js';

export const SOURCE = Object.freeze({ name: 'Orca', bundleIds: Object.freeze(['com.stablyai.orca']) });

/**
 * 실기 배선 한 벌.
 * @returns {{cli, adapter, sync, focusRouter}}
 */
export async function createOrcaStack({ store, bin = 'orca', cli = null, settings = undefined } = {}) {
  const theCli = cli ?? new OrcaCli({ bin });
  // Orca 사이드바 필터(기본 브랜치 숨기기)를 따른다. 테스트는 settings를 주입하거나 null로 끈다.
  const adapter = new OrcaAdapter({ cli: theCli, settings: settings === undefined ? new OrcaSettings() : settings });
  const sync = new OrcaSync(store);
  const focusRouter = new OrcaFocusRouter({ cli: theCli, adapter, sync });
  return { cli: theCli, adapter, sync, focusRouter };
}
