/**
 * 진단 내보내기 (M5 설계 §10, AGENTS.md 12).
 *
 * 문제를 보고할 때 붙일 파일이다. **작업 내용을 담지 않는다.**
 *  - 작업 이름·경로 대신 슬롯 번호와 상태만
 *  - 로그는 경로처럼 보이는 조각을 지우고, prompt 류 문장은 통째로 뺀다
 *  - 홈 디렉터리 문자열은 어디에도 남기지 않는다
 * 남기는 것은 "무엇이 어떤 상태였나"이지 "무엇을 하고 있었나"가 아니다.
 */
const PATH_RE = /(\/(?:Users|home|private|var|tmp|Volumes)\/[^\s'"]*)|(~\/[^\s'"]*)/g;
const CONTENT_RE = /(prompt|lastAssistantMessage|toolInput|preview|token|password|secret)/i;

function scrub(text, home) {
  let s = String(text ?? '');
  if (home) s = s.split(home).join('~');
  return s.replace(PATH_RE, '<경로>');
}

export function buildDiagnostics({ snapshot, health, versions = {}, logs = [], home = '', calibration = null }) {
  return {
    kind: 'output-diagnostics',
    version: 1,
    createdAt: new Date().toISOString(),
    versions: {
      app: versions.app ?? null,
      firmware: versions.firmware ?? null,
      orca: versions.orca ?? null,
      node: process.versions.node,
      electron: process.versions.electron ?? null,
      platform: `${process.platform} ${process.arch}`,
    },
    health: {
      device: health?.device?.state ?? null,
      orca: health?.orca?.state ?? null,
      mock: Boolean(health?.mock),
      accessibility: health?.permissions?.accessibility ?? null,
    },
    view: snapshot.view,
    bank: `${snapshot.bank + 1}/${snapshot.bankCount}`,
    source: snapshot.sourceName ?? null,
    active: snapshot.active !== false,
    slots: snapshot.slots.map((s) => ({ slot: s.slot, occupied: Boolean(s.id), status: s.status })),
    attentionCount: snapshot.attentionCount,
    hiddenAttentionCount: snapshot.hiddenAttentionCount,
    calibration: calibration
      ? { appliedAt: calibration.appliedAt ?? null, controllableKeys: calibration.leds?.controllableKeys ?? null }
      : null,
    logs: logs
      .filter((l) => !CONTENT_RE.test(l.messageKo ?? ''))
      .slice(-200)
      .map((l) => ({ at: l.at, level: l.level ?? 'info', messageKo: scrub(l.messageKo, home) })),
  };
}
