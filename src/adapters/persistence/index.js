import os from 'node:os';
import path from 'node:path';
import { FileStore } from './fileStore.js';
import { PersistenceAdapter } from './persistenceAdapter.js';

export { FileStore } from './fileStore.js';
export { PersistenceAdapter } from './persistenceAdapter.js';
export { SCHEMA_VERSION, emptyState, validateState } from './schema.js';

/** 장치 보정용 config/ 와 섞지 않는다. 하나는 기계의 사실, 하나는 사람의 의도다. */
export function defaultDir() {
  return process.env.OUTPUT_HOME ?? path.join(os.homedir(), '.output');
}

/** 실기 배선 한 벌. */
export function createPersistence({ store, dir = defaultDir(), now } = {}) {
  const fileStore = new FileStore({ dir });
  const adapter = new PersistenceAdapter({ store, fileStore, ...(now ? { now } : {}) });
  return { fileStore, adapter, dir };
}
