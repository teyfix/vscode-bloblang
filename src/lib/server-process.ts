import { type ChildProcess, spawn } from 'node:child_process';
import type { ManagedTool } from './releases';

export interface OwnedServerProcess {
  start(): Promise<ChildProcess>;
  terminate(): Promise<void>;
}

/** Own the child even while LanguageClient is still waiting for initialize. */
export function createServerProcess(
  tool: ManagedTool,
  signal: AbortSignal,
  cwd?: string,
): OwnedServerProcess {
  let child: ChildProcess | undefined;
  let closed: Promise<void> = Promise.resolve();
  let closing = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const kill = () => {
    if (
      !child ||
      closing ||
      child.exitCode !== null ||
      child.signalCode !== null
    )
      return;
    closing = true;
    child.kill();
    killTimer = setTimeout(() => {
      if (child && child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
    }, 500);
    killTimer.unref();
  };
  return {
    async start() {
      signal.throwIfAborted();
      if (child) {
        // The language client's crash recovery can request another transport.
        // Retire the previous child before replacing it, even if only its
        // connection closed and the process itself stayed alive.
        kill();
        await closed;
        signal.throwIfAborted();
        closing = false;
      }
      child = spawn(tool.command, tool.args, {
        cwd,
        stdio: 'pipe',
        windowsHide: true,
      });
      const process = child;
      closed = new Promise<void>((resolve) => {
        process.once('close', () => {
          if (killTimer) clearTimeout(killTimer);
          signal.removeEventListener('abort', kill);
          resolve();
        });
      });
      signal.addEventListener('abort', kill, { once: true });
      return await new Promise<ChildProcess>((resolve, reject) => {
        // Keep an error listener after spawn too: asynchronous process errors must
        // never become an unhandled EventEmitter error during cancellation.
        process.on('error', reject);
        process.once('spawn', () => {
          if (signal.aborted) {
            kill();
            reject(signal.reason);
          } else resolve(process);
        });
        process.once('close', () => {
          reject(
            signal.aborted
              ? signal.reason
              : new Error('Language server exited before starting.'),
          );
        });
        if (signal.aborted) kill();
      });
    },
    async terminate() {
      kill();
      await closed;
    },
  };
}

export function waitForStartup(
  start: Promise<void>,
  controller: AbortController,
  timeoutMs = 30_000,
): Promise<void> {
  const timer = setTimeout(
    () =>
      controller.abort(
        new Error('Language server initialization timed out after 30 seconds.'),
      ),
    timeoutMs,
  );
  let abort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(controller.signal.reason);
    if (controller.signal.aborted) abort();
    else controller.signal.addEventListener('abort', abort, { once: true });
  });
  return Promise.race([start, aborted]).finally(() => {
    clearTimeout(timer);
    if (abort) controller.signal.removeEventListener('abort', abort);
  });
}
