import { execFile } from 'node:child_process';

/**
 * Orca CLI 호출 — **읽기와 focus만**.
 *
 * 실측 기준: Orca CLI 1.4.206, `orca --help` (2026-09-21).
 * 허용 목록 밖의 명령은 실행하지 않는다. 문자열을 조립해 셸에 넘기지 않는다.
 *
 * 금지: worktree rm/create/set, terminal close/send/create/split,
 *       orchestration *, computer *, repo add, project *, automations *, account *
 */
export const READ_COMMANDS = Object.freeze({
  status: ['status'],
  worktreeList: ['worktree', 'list'],
  worktreeShow: ['worktree', 'show'],
  // 에이전트 상태(working/blocked/waiting/done)를 주는 유일한 읽기 명령.
  worktreePs: ['worktree', 'ps'],
  terminalList: ['terminal', 'list'],
  terminalShow: ['terminal', 'show'],
});

/** 상태를 바꾸지만 파괴적이지 않은 유일한 명령. */
export const FOCUS_COMMAND = Object.freeze(['terminal', 'switch']);

/** 어떤 경우에도 실행하지 않는다. */
export const FORBIDDEN_VERBS = Object.freeze([
  'rm', 'close', 'send', 'create', 'split', 'set', 'add', 'update', 'delete', 'remove',
  'run', 'dispatch', 'reset', 'stop', 'start', 'install', 'share', 'click', 'type-text',
  'press-key', 'hotkey', 'paste-text', 'set-value', 'drag', 'scroll',
]);

const ALLOWED = [...Object.values(READ_COMMANDS), FOCUS_COMMAND];

export function isAllowed(argv) {
  return ALLOWED.some((cmd) => cmd.every((part, i) => argv[i] === part));
}

export class OrcaCliError extends Error {
  constructor(message, { code = null, stderr = '' } = {}) {
    super(message);
    this.name = 'OrcaCliError';
    this.code = code;
    this.stderr = stderr;
  }
}

/**
 * @param {object} opts
 * @param {string} [opts.bin] orca 실행 파일
 * @param {number} [opts.timeoutMs]
 * @param {Function} [opts.runner] 테스트용 주입
 */
export class OrcaCli {
  constructor({ bin = 'orca', timeoutMs = 15000, runner = null, maxBuffer = 8 * 1024 * 1024 } = {}) {
    this.bin = bin;
    this.timeoutMs = timeoutMs;
    this.maxBuffer = maxBuffer;
    this.runner = runner;
    this.calls = [];
  }

  /**
   * @param {string[]} argv 허용 목록에 있는 명령만
   * @returns {Promise<object>} result 부분
   */
  async run(argv) {
    if (!Array.isArray(argv) || !argv.length) {
      throw new OrcaCliError('명령이 비어 있습니다.');
    }
    if (argv.some((a) => FORBIDDEN_VERBS.includes(a))) {
      throw new OrcaCliError(`파괴적일 수 있는 명령은 실행하지 않습니다: ${argv.join(' ')}`);
    }
    if (!isAllowed(argv)) {
      throw new OrcaCliError(`허용되지 않은 Orca 명령입니다: ${argv.join(' ')}`);
    }
    const full = [...argv, '--json'];
    this.calls.push(full);

    const stdout = this.runner
      ? await this.runner(this.bin, full)
      : await this._exec(full);

    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new OrcaCliError(`Orca 응답을 JSON으로 읽지 못했습니다: ${argv.join(' ')}`);
    }
    if (parsed.ok === false) {
      throw new OrcaCliError(
        `Orca가 명령을 거절했습니다: ${argv.join(' ')}`,
        { code: parsed.error?.code ?? null },
      );
    }
    return parsed.result ?? {};
  }

  _exec(args) {
    return new Promise((resolve, reject) => {
      execFile(this.bin, args, {
        timeout: this.timeoutMs, maxBuffer: this.maxBuffer, encoding: 'utf8',
      }, (err, stdout, stderr) => {
        if (err) {
          reject(new OrcaCliError(
            `Orca CLI 실행 실패 (${args.join(' ')}): ${err.message.split('\n')[0]}`,
            { code: err.code, stderr: String(stderr).slice(0, 500) },
          ));
          return;
        }
        resolve(stdout);
      });
    });
  }
}
