import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export class CliExistsError extends Error {
  constructor(public readonly target: string) {
    super(`A different file already exists at ${target}`);
  }
}

export function defaultCliDirectory(
  platform = process.platform,
  home = os.homedir(),
  localAppData = process.env.LOCALAPPDATA,
): string {
  return platform === 'win32'
    ? path.win32.join(
        localAppData || path.win32.join(home, 'AppData', 'Local'),
        'Bloblang',
        'bin',
      )
    : path.posix.join(home, '.local', 'bin');
}

export function directoryOnPath(
  directory: string,
  value = process.env.PATH ?? '',
  platform = process.platform,
): boolean {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const normalize = (entry: string) => {
    const normalized = paths.resolve(entry);
    return platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  return value
    .split(platform === 'win32' ? ';' : ':')
    .filter(Boolean)
    .some((entry) => normalize(entry) === normalize(directory));
}

/** Copies only on an explicit request. Existing external copies stay independent. */
export async function installExternalCli(
  source: string,
  directory: string,
  options: {
    overwrite?: boolean;
    platform?: NodeJS.Platform;
    signal?: AbortSignal;
  } = {},
): Promise<{ target: string; unchanged: boolean }> {
  const platform = options.platform ?? process.platform;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (!paths.isAbsolute(directory))
    throw new Error('Choose an absolute installation folder.');
  options.signal?.throwIfAborted();
  const sourceStat = await lstat(source);
  if (!sourceStat.isFile())
    throw new Error('The managed CLI is not a regular file.');
  const target = paths.join(
    directory,
    platform === 'win32' ? 'blobl.exe' : 'blobl',
  );
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink())
      throw new Error(`Cannot replace a non-regular file at ${target}`);
    if ((await readFile(source)).equals(await readFile(target))) {
      if (platform !== 'win32') await chmod(target, 0o755);
      return { target, unchanged: true };
    }
    if (!options.overwrite) throw new CliExistsError(target);
  }
  options.signal?.throwIfAborted();
  await mkdir(directory, { recursive: true });
  const temporary = paths.join(directory, `.blobl-${randomUUID()}.tmp`);
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL);
    if (platform !== 'win32') await chmod(temporary, 0o755);
    options.signal?.throwIfAborted();
    // Recheck before replacing: a file appearing after the prompt needs approval.
    if (
      !existing &&
      (await lstat(target).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return false;
          throw error;
        },
      ))
    )
      throw new CliExistsError(target);
    await rename(temporary, target);
    return { target, unchanged: false };
  } finally {
    await rm(temporary, { force: true });
  }
}
