import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

/**
 * TTY 대화 입력.
 * 사람이 보고 있지 않으면 점등 확인은 의미가 없으므로 TTY가 아니면 거부한다.
 */
export function isInteractive() {
  return Boolean(stdin.isTTY && stdout.isTTY);
}

/**
 * 입력이 닫히면(EOF, Ctrl+D, 파이프 종료) 예외로 죽지 않고 중단('q')으로 처리한다.
 * 중단은 안전한 경로다 — 호출부가 소등하고 부분 결과를 그대로 기록한다.
 */
export function createPrompt({ onClosed = null } = {}) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  let closed = false;
  let notified = false;

  const markClosed = () => {
    closed = true;
    if (!notified) {
      notified = true;
      onClosed?.();
    }
  };
  rl.once('close', markClosed);

  return {
    get closed() { return closed; },
    async ask(q) {
      if (closed) return 'q';
      try {
        return await rl.question(q);
      } catch (err) {
        if (err?.code === 'ERR_USE_AFTER_CLOSE') {
          markClosed();
          return 'q';
        }
        throw err;
      }
    },
    close() {
      try { rl.close(); } catch { /* 이미 닫혔을 수 있다 */ }
    },
  };
}
