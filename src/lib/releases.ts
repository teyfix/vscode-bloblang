import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants, createWriteStream, renameSync } from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { ExtensionContext } from 'vscode';
import { BloblangError } from './error';

export class ReleaseError extends BloblangError {
  override name = 'ReleaseError';
}

export interface ManagedTool {
  command: string;
  args: string[];
  version: string;
  cliDirectory?: string;
  legacy?: boolean;
}

export interface ToolManager {
  resolve(signal?: AbortSignal): Promise<ManagedTool>;
  checkForUpdates(options?: {
    signal?: AbortSignal;
    force?: boolean;
  }): Promise<ManagedTool | undefined>;
}

export interface ToolManagerDependencies {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
  platform?: string;
  arch?: string;
  timeoutMs?: number;
  validateExecutable?: (
    command: string,
    version: string,
    signal: AbortSignal,
  ) => Promise<void>;
}

type StorageContext = Partial<
  Pick<ExtensionContext, 'globalStorageUri' | 'globalStoragePath'>
>;
const RELEASE_ROOT = 'https://github.com/teyfix/bloblang-lsp/releases';
export const RELEASE_MANIFEST_URL = `${RELEASE_ROOT}/latest/download/blobl-release.json`;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STABLE_VERSION = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const ASSETS: Record<string, string> = Object.fromEntries(
  ['linux', 'darwin', 'windows'].flatMap((os) =>
    ['amd64', 'arm64'].map((arch) => [
      `${os}-${arch}`,
      `blobl-${os}-${arch}${os === 'windows' ? '.exe' : ''}`,
    ]),
  ),
);

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted)
    throw signal.reason ?? new Error('Tool installation cancelled');
}

/** Bound fetch, body consumption and child execution, including injected work. */
async function bounded<T>(
  signal: AbortSignal | undefined,
  timeoutMs: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  throwIfAborted(signal);
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error('Tool operation timed out')),
    timeoutMs,
  );
  let rejectAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
  });
  try {
    return await Promise.race([work(controller.signal), cancelled]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    if (rejectAbort)
      controller.signal.removeEventListener('abort', rejectAbort);
  }
}

async function validateExecutable(
  command: string,
  version: string,
  signal: AbortSignal,
) {
  await new Promise<void>((resolve, reject) => {
    execFile(
      command,
      ['--version'],
      { signal, timeout: 10_000, maxBuffer: 16 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) reject(error);
        else if (stdout.trim().split(/\s+/)[0] !== version)
          reject(
            new ReleaseError(
              'Downloaded tool reports a different version',
              null,
            ),
          );
        else resolve();
      },
    );
  });
}

function compareVersions(a: string, b: string) {
  const aa = a.slice(1).split('.').map(Number);
  const bb = b.slice(1).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const difference = (aa[i] ?? 0) - (bb[i] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

function parseManifest(value: unknown, target: string) {
  if (!value || typeof value !== 'object')
    throw new ReleaseError('Invalid Bloblang release manifest', null);
  const manifest = value as Record<string, unknown>;
  if (
    manifest.schemaVersion !== 1 ||
    typeof manifest.version !== 'string' ||
    !STABLE_VERSION.test(manifest.version) ||
    !manifest.assets ||
    typeof manifest.assets !== 'object' ||
    Array.isArray(manifest.assets)
  ) {
    throw new ReleaseError(
      'Invalid or unsupported Bloblang release manifest',
      null,
    );
  }
  const assets = manifest.assets as Record<string, unknown>;
  for (const [key, name] of Object.entries(ASSETS)) {
    if (assets[key] !== name)
      throw new ReleaseError(
        `Invalid or missing release asset for ${key}`,
        null,
      );
  }
  return { version: manifest.version, asset: assets[target] as string };
}

async function readManifest(response: Response, signal: AbortSignal) {
  if (!response.body)
    throw new ReleaseError('Release manifest has no response body', null);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const abort = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    throwIfAborted(signal);
    while (true) {
      const { done, value } = await reader.read();
      throwIfAborted(signal);
      if (done) break;
      length += value.byteLength;
      if (length > 1024 * 1024)
        throw new ReleaseError('Release manifest is too large', null);
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** The cache belongs to the extension host (including SSH/container hosts). */
export function createToolManager(
  context: StorageContext,
  dependencies: ToolManagerDependencies = {},
): ToolManager {
  const platform = dependencies.platform ?? process.platform;
  const arch = dependencies.arch ?? process.arch;
  const os = platform === 'win32' ? 'windows' : platform;
  const cpu = arch === 'x64' ? 'amd64' : arch;
  const target = `${os}-${cpu}`;
  const storage = context.globalStorageUri?.fsPath ?? context.globalStoragePath;
  const fetchRelease = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? Date.now;
  const timeoutMs = dependencies.timeoutMs ?? 30_000;
  const validate = dependencies.validateExecutable ?? validateExecutable;
  const root = path.join(storage ?? '', 'tools', target);
  const currentFile = path.join(root, 'current.json');
  const checkFile = path.join(root, 'check.json');
  const executableName = os === 'windows' ? 'blobl.exe' : 'blobl';
  let pending: Promise<ManagedTool | undefined> | undefined;

  function checkEnvironment(signal?: AbortSignal) {
    throwIfAborted(signal);
    if (!ASSETS[target])
      throw new ReleaseError(
        `Unsupported Bloblang extension host: ${platform}/${arch}`,
        null,
      );
    if (!storage)
      throw new ReleaseError('Extension storage path is unavailable', null);
  }

  async function readJSON(file: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch {
      return undefined;
    }
  }

  async function atomicJSON(file: string, data: unknown, signal?: AbortSignal) {
    throwIfAborted(signal);
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(data));
      throwIfAborted(signal);
      // Keep the cancellation check and tiny atomic commit in the same turn.
      renameSync(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  function descriptor(version: string): ManagedTool {
    const cliDirectory = path.join(root, version);
    return {
      command: path.join(cliDirectory, executableName),
      args: ['lsp'],
      version,
      cliDirectory,
    };
  }

  async function installed(version: string, signal?: AbortSignal) {
    if (!STABLE_VERSION.test(version)) return undefined;
    const tool = descriptor(version);
    try {
      const info = await stat(tool.command);
      if (!info.isFile() || info.size === 0) return undefined;
      await access(
        tool.command,
        os === 'windows' ? constants.F_OK : constants.X_OK,
      );
      await bounded(signal, timeoutMs, (operationSignal) =>
        validate(tool.command, version, operationSignal),
      );
      throwIfAborted(signal);
      return tool;
    } catch {
      throwIfAborted(signal);
      return undefined;
    }
  }

  async function cached(
    signal?: AbortSignal,
  ): Promise<ManagedTool | undefined> {
    const record = (await readJSON(currentFile)) as
      | Record<string, unknown>
      | undefined;
    if (
      record?.schemaVersion === 1 &&
      record.target === target &&
      typeof record.version === 'string'
    ) {
      const tool = await installed(record.version, signal);
      if (tool) return tool;
    }
    // Recover installations without trusting the old GitHub API metadata cache.
    const entries = await readdir(root).catch(() => [] as string[]);
    for (const version of entries
      .filter((name) => STABLE_VERSION.test(name))
      .sort((a, b) => compareVersions(b, a))) {
      const tool = await installed(version, signal);
      if (tool) {
        await atomicJSON(
          currentFile,
          { schemaVersion: 1, target, version },
          signal,
        );
        return tool;
      }
    }
    const legacyDirectory = path.join(storage ?? '', 'bin');
    const legacyNames = await readdir(legacyDirectory).catch(
      () => [] as string[],
    );
    const legacyPattern = new RegExp(
      `^language-server-(v\\d+\\.\\d+\\.\\d+)-${target}${os === 'windows' ? '\\.exe' : ''}$`,
    );
    const candidates = legacyNames
      .flatMap((name) => {
        const version = legacyPattern.exec(name)?.[1];
        return version && STABLE_VERSION.test(version)
          ? [{ name, version }]
          : [];
      })
      .sort((a, b) => compareVersions(b.version, a.version));
    for (const candidate of candidates) {
      throwIfAborted(signal);
      const command = path.join(legacyDirectory, candidate.name);
      try {
        const info = await stat(command);
        if (!info.isFile() || info.size === 0) continue;
        await access(
          command,
          os === 'windows' ? constants.F_OK : constants.X_OK,
        );
        return { command, args: [], version: candidate.version, legacy: true };
      } catch {
        /* A broken legacy entry must not hide another working copy. */
      }
    }
    throwIfAborted(signal);
    return undefined;
  }

  function retryTime(response: Response) {
    const retryAfter = response.headers.get('retry-after');
    const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
    const retry =
      retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter)
        ? now() + Number(retryAfter) * 1000
        : Date.parse(retryAfter ?? '');
    return Math.max(
      now() + CHECK_INTERVAL_MS,
      Number.isFinite(reset) ? reset : 0,
      Number.isFinite(retry) ? retry : 0,
    );
  }

  async function fetchManifest(signal?: AbortSignal) {
    return bounded(signal, timeoutMs, async (operationSignal) => {
      const response = await fetchRelease(RELEASE_MANIFEST_URL, {
        signal: operationSignal,
      });
      if (!response.ok) {
        await atomicJSON(checkFile, { nextCheck: retryTime(response) }, signal);
        throw new ReleaseError(
          `Could not fetch Bloblang release manifest (HTTP ${response.status})`,
          null,
        );
      }
      return parseManifest(
        await readManifest(response, operationSignal),
        target,
      );
    });
  }

  async function install(version: string, asset: string, signal?: AbortSignal) {
    const existing = await installed(version, signal);
    if (existing) {
      await atomicJSON(
        currentFile,
        { schemaVersion: 1, target, version },
        signal,
      );
      return existing;
    }
    await mkdir(root, { recursive: true });
    const stage = path.join(root, `.staging-${randomUUID()}`);
    const command = path.join(stage, executableName);
    await mkdir(stage);
    try {
      await bounded(signal, timeoutMs, async (operationSignal) => {
        const response = await fetchRelease(
          `${RELEASE_ROOT}/download/${version}/${asset}`,
          { signal: operationSignal },
        );
        if (!response.ok) {
          await atomicJSON(
            checkFile,
            { nextCheck: retryTime(response) },
            signal,
          );
          throw new ReleaseError(
            `Could not download Bloblang tool (HTTP ${response.status})`,
            null,
          );
        }
        if (!response.body)
          throw new ReleaseError('Tool download has no response body', null);
        throwIfAborted(operationSignal);
        await pipeline(
          response.body,
          createWriteStream(command, { flags: 'wx' }),
          { signal: operationSignal },
        );
      });
      throwIfAborted(signal);
      if (os !== 'windows') await chmod(command, 0o755);
      await bounded(signal, timeoutMs, (operationSignal) =>
        validate(command, version, operationSignal),
      );
      throwIfAborted(signal);
      try {
        await rename(stage, path.join(root, version));
      } catch (error) {
        // Another extension window can finish the same version first.
        if (!(await installed(version, signal))) {
          throwIfAborted(signal);
          // Retain corrupt state for inspection instead of pruning cache data.
          const destination = path.join(root, version);
          try {
            await rename(
              destination,
              path.join(root, `.invalid-${version}-${randomUUID()}`),
            );
          } catch (moveError) {
            if ((moveError as NodeJS.ErrnoException).code !== 'ENOENT')
              throw error;
          }
          throwIfAborted(signal);
          try {
            await rename(stage, destination);
          } catch (retryError) {
            if (!(await installed(version, signal))) throw retryError;
          }
        }
      }
      throwIfAborted(signal);
      await atomicJSON(
        currentFile,
        { schemaVersion: 1, target, version },
        signal,
      );
      return descriptor(version);
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }

  async function update(signal?: AbortSignal) {
    // Real failures are throttled, but closing VS Code must not postpone install.
    const priorCheck = await readJSON(checkFile);
    const attempt = randomUUID();
    await atomicJSON(
      checkFile,
      { nextCheck: now() + CHECK_INTERVAL_MS, attempt },
      signal,
    );
    try {
      const manifest = await fetchManifest(signal);
      const current = await cached(signal);
      if (
        current &&
        !current.legacy &&
        compareVersions(current.version, manifest.version) >= 0
      )
        return undefined;
      return await install(manifest.version, manifest.asset, signal);
    } catch (error) {
      if (signal?.aborted) {
        const latest = (await readJSON(checkFile)) as
          | Record<string, unknown>
          | undefined;
        // Preserve another window's newer check rather than resetting its TTL.
        if (latest?.attempt === attempt) {
          await atomicJSON(checkFile, priorCheck ?? { nextCheck: now() });
        }
      }
      throw error;
    }
  }

  return {
    async resolve(signal) {
      checkEnvironment(signal);
      const tool = await cached(signal);
      if (tool) return tool;
      if (pending) {
        const downloaded = await pending;
        throwIfAborted(signal);
        if (downloaded) return downloaded;
      }
      const record = (await readJSON(checkFile)) as
        | Record<string, unknown>
        | undefined;
      if (
        !pending &&
        typeof record?.nextCheck === 'number' &&
        record.nextCheck > now()
      )
        throw new ReleaseError(
          'Bloblang tool is unavailable; download retry is temporarily delayed. Use Check for Updates to retry.',
          null,
        );
      if (!pending)
        pending = update(signal).finally(() => {
          pending = undefined;
        });
      const downloaded = await pending;
      throwIfAborted(signal);
      if (!downloaded)
        throw new ReleaseError('No usable Bloblang tool is installed', null);
      return downloaded;
    },
    async checkForUpdates(options = {}) {
      checkEnvironment(options.signal);
      if (pending) return pending;
      const record = (await readJSON(checkFile)) as
        | Record<string, unknown>
        | undefined;
      if (pending) return pending;
      if (
        !options.force &&
        typeof record?.nextCheck === 'number' &&
        record.nextCheck > now()
      )
        return undefined;
      pending = update(options.signal).finally(() => {
        pending = undefined;
      });
      return pending;
    },
  };
}
