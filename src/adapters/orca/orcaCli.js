import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

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

/**
 * CLI 명령이 없는 이동 — Orca 채팅 세션 (실측 Orca 1.4.241, 2026-10-27).
 * 런타임 요청을 Orca CLI 자신의 클라이언트로 보낸다. 작업을 열고(activate) 그 채팅을 띄운다(reveal).
 * 둘 다 terminal.focus와 같은 권한 등급이고 화면만 옮긴다. 이 밖의 요청은 보내지 않는다.
 */
export const RPC_FOCUS_METHODS = Object.freeze(['worktree.activate', 'agentSession.reveal']);

// Orca 앱의 Electron을 노드 모드로 띄워 CLI 클라이언트로 요청 하나를 보낸다. 값은 환경 변수로 받는다 (셸 조립 없음)
const RPC_SCRIPT = `const { RuntimeClient } = require(process.env.ORCA_RPC_CLIENT);
new RuntimeClient().call(process.env.ORCA_RPC_METHOD, JSON.parse(process.env.ORCA_RPC_PARAMS), { timeoutMs: 8000 })
  .then((r) => { process.stdout.write(JSON.stringify(r)); process.exit(0); },
    (e) => { process.stdout.write(JSON.stringify({ ok: false, error: { code: e.code ?? null, message: String(e.message) } })); process.exit(0); });`;

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

  /**
   * @param {string} method RPC_FOCUS_METHODS 중 하나만
   * @returns {Promise<object>} result 부분
   */
  async rpc(method, params) {
    if (!RPC_FOCUS_METHODS.includes(method)) throw new OrcaCliError(`허용되지 않은 Orca 요청입니다: ${method}`);
    const args = ['rpc', method, JSON.stringify(params)];
    this.calls.push(args);
    const stdout = this.runner ? await this.runner(this.bin, args) : await this._execRpc(method, params);
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new OrcaCliError(`Orca 응답을 JSON으로 읽지 못했습니다: ${method}`);
    }
    if (parsed.ok === false) throw new OrcaCliError(`Orca가 요청을 거절했습니다: ${method}`, { code: parsed.error?.code ?? null });
    return parsed.result ?? {};
  }

  /** bin(…/Orca.app/Contents/Resources/bin/orca, 셸 링크면 따라감)에서 Orca 앱 실행 파일과 CLI 클라이언트를 찾는다 */
  _execRpc(method, params) {
    const contents = path.resolve(path.dirname(realpathSync(this._binPath())), '..', '..');
    return new Promise((resolve, reject) => {
      execFile(path.join(contents, 'MacOS', 'Orca'), ['-e', RPC_SCRIPT], {
        timeout: this.timeoutMs, maxBuffer: this.maxBuffer, encoding: 'utf8',
        env: {
          ...process.env, ELECTRON_RUN_AS_NODE: '1',
          ORCA_RPC_CLIENT: path.join(contents, 'Resources', 'app.asar.unpacked', 'out', 'cli', 'runtime', 'client.js'),
          ORCA_RPC_METHOD: method, ORCA_RPC_PARAMS: JSON.stringify(params),
        },
      }, (err, stdout) => {
        if (err) { reject(new OrcaCliError(`Orca 요청 실패 (${method}): ${err.message.split('\n')[0]}`, { code: err.code })); return; }
        resolve(stdout);
      });
    });
  }

  /** 'orca'처럼 이름만 주면 PATH에서 찾는다 */
  _binPath() {
    if (this.bin.includes('/')) return this.bin;
    for (const dir of (process.env.PATH ?? '').split(':')) {
      const p = path.join(dir, this.bin);
      if (existsSync(p)) return p;
    }
    throw new OrcaCliError(`orca 실행 파일을 찾지 못했습니다: ${this.bin}`);
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
