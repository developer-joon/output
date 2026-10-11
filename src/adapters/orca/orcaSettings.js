import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Orca의 워크스페이스 필터 설정 읽기 — **읽기 전용**.
 *
 * Orca CLI는 사이드바 필터("기본 브랜치 숨기기")를 주지 않는다. 설정은 Orca 프로필의
 * SQLite `profile_state_documents` 테이블, `ui` 문서(JSON)의 `hideDefaultBranchWorkspace`에 있다
 * (실측 2026-09-29, Orca 1.4.215). 옆의 `orca-data.json`은 갱신이 멈춘 옛 사본이라 쓰지 않는다.
 *
 * Orca 내부 파일이므로 언제든 바뀔 수 있다. 못 읽으면 추측하지 않고 `null`과 경고를 돌려준다.
 * 파일을 열 때 읽기 전용으로 열고, 쓰지 않는다 (AGENTS.md 2).
 */
export const DEFAULT_DB_PATH = path.join(
  os.homedir(), 'Library', 'Application Support', 'orca', 'profiles', 'local-default', 'profile-state.db',
);

const QUERY = "SELECT json_extract(payload, '$.hideDefaultBranchWorkspace') AS v, json_extract(payload, '$.projectOrderBy') AS ob, json_extract(payload, '$.manualRepoOrder') AS ro, json_extract(payload, '$.acknowledgedAgentsByPaneKey') AS ak FROM profile_state_documents WHERE domain = 'ui'";

/** Orca가 기록한 에이전트별 '확인함' 시각 {paneKey: ms}. 사용자가 그 세션을 열어 보면 남는다 */
function agentAcksOf(row) {
  if (typeof row?.ak !== 'string') return {};
  try { const m = JSON.parse(row.ak); return m && typeof m === 'object' ? m : {}; } catch { return {}; }
}

/** 사이드바 프로젝트 순서. 수동 정렬일 때만 repoId 목록, 아니면 null */
function repoOrderOf(row) {
  if (row?.ob !== 'manual' || typeof row.ro !== 'string') return null;
  try {
    const list = JSON.parse(row.ro);
    return Array.isArray(list) ? list.map((x) => x?.repoId).filter((x) => typeof x === 'string') : null;
  } catch { return null; }
}

export class OrcaSettings {
  constructor({ dbPath = DEFAULT_DB_PATH } = {}) {
    this.dbPath = dbPath;
  }

  /** @returns {{hideDefaultBranch: boolean|null, repoOrder: string[]|null, agentAcks: object, warningKo: string|null}} */
  read() {
    if (!fs.existsSync(this.dbPath)) {
      return { hideDefaultBranch: null, repoOrder: null, agentAcks: {}, warningKo: 'Orca 설정을 읽지 못했습니다 (파일 없음). 기본 브랜치를 숨기지 않습니다.' };
    }
    let db = null;
    try {
      // node:sqlite는 Node 22.5+ 내장. Electron 44(Node 24)에서 확인.
      const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
      db = new DatabaseSync(this.dbPath, { readOnly: true });
      const row = db.prepare(QUERY).get();
      if (!row || row.v === null || row.v === undefined) {
        return { hideDefaultBranch: null, repoOrder: repoOrderOf(row), agentAcks: agentAcksOf(row), warningKo: 'Orca 설정에 기본 브랜치 숨김 값이 없습니다. 숨기지 않습니다.' };
      }
      return { hideDefaultBranch: Boolean(row.v), repoOrder: repoOrderOf(row), agentAcks: agentAcksOf(row), warningKo: null };
    } catch (err) {
      return { hideDefaultBranch: null, repoOrder: null, agentAcks: {}, warningKo: `Orca 설정을 읽지 못했습니다 (${String(err.message ?? err).split('\n')[0]}). 기본 브랜치를 숨기지 않습니다.` };
    } finally {
      try { db?.close(); } catch { /* 닫기 실패는 무시 */ }
    }
  }
}
