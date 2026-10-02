import {
  constants,
  createWriteStream,
  existsSync,
  type PathLike,
} from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { extract as extractTar } from 'tar';
import { Extract as extractZip } from 'unzipper';
import type { ExtensionContext } from 'vscode';
import type { GitHubRelease } from '../types/releases';
import { BloblangError } from './error';
import { clientLogger } from './logger';
import { tryCatch } from './tryCatch';

export class ReleaseError extends BloblangError {
  override name = 'ReleaseError';
}

const logger = clientLogger('Release');

async function exists(pathLike: PathLike) {
  return tryCatch(() => existsSync(pathLike));
}

async function readCache({
  context,
}: {
  context: ExtensionContext;
}): Promise<GitHubRelease[] | null> {
  const cachePath = path.join(
    context.globalStoragePath,
    '.github-api',
    'releases.json',
  );

  const [hasCache, statErr] = await exists(cachePath);

  if (statErr) {
    throw new ReleaseError('Could not stat cache file', statErr);
  }

  if (!hasCache) {
    return null;
  }

  const [content, readErr] = await tryCatch(readFile(cachePath, 'utf-8'));

  if (readErr) {
    throw new ReleaseError('Could not read cache file', readErr);
  }

  try {
    const data = JSON.parse(content) as GitHubRelease[];
    if (!Array.isArray(data)) throw new Error('Expected a release list');

    logger.debug('Read cache file "%s"', cachePath);

    return data;
  } catch (syntaxErr) {
    throw new ReleaseError('Could not parse cache file as JSON', syntaxErr);
  }
}

async function writeCache({
  context,
  releases,
}: {
  context: ExtensionContext;
  releases: GitHubRelease[];
}) {
  const cachePath = path.join(
    context.globalStoragePath,
    '.github-api',
    'releases.json',
  );

  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, JSON.stringify(releases, null, 2));

  logger.debug('Wrote cache file "%s"', cachePath);
}

async function fetchReleases({ context }: { context: ExtensionContext }) {
  const fetchURL = 'https://api.github.com/repos/teyfix/bloblang-lsp/releases';
  const [res, httpErr] = await tryCatch(fetch(fetchURL));

  if (httpErr) {
    throw new ReleaseError('Could not fetch releases', httpErr);
  }
  if (!res.ok) {
    throw new ReleaseError(
      `Could not fetch releases (HTTP ${res.status})`,
      null,
    );
  }

  const [data, jsonErr] = await tryCatch(res.json());

  if (jsonErr) {
    throw new ReleaseError('Could not parse response as JSON', jsonErr);
  }

  const releases = data as GitHubRelease[];
  if (!Array.isArray(releases)) {
    throw new ReleaseError('GitHub returned an invalid release list', null);
  }

  const [, cacheErr] = await tryCatch(writeCache({ context, releases }));

  if (cacheErr) {
    logger.warn('Failed to write cache', cacheErr);
  }

  return releases;
}

export async function getReleases({ context }: { context: ExtensionContext }) {
  // Check GitHub on startup. The metadata cache lets a previously
  // downloaded server start when the machine is offline.
  const [releases, fetchErr] = await tryCatch(fetchReleases({ context }));
  if (!fetchErr) return releases;
  logger.warn('Failed to check releases; trying cached metadata', fetchErr);
  const [cache, cacheErr] = await tryCatch(readCache({ context }));
  if (cacheErr) throw fetchErr;
  if (cache) return cache;
  throw fetchErr;
}

function getOsType(): string {
  const name = os.type().toLowerCase();
  switch (name) {
    case 'win32':
    case 'windows_nt':
      return 'windows';
    default:
      return name;
  }
}

function getOsArch(): string {
  const arch = os.arch().toLowerCase();
  switch (arch) {
    case 'x64':
      return 'amd64';
    default:
      return arch;
  }
}

export async function getAsset({ context }: { context: ExtensionContext }) {
  const [releases, getErr] = await tryCatch(getReleases({ context }));

  if (getErr) {
    throw getErr;
  }

  const osType = getOsType();
  const osArch = getOsArch();

  for (const release of releases) {
    for (const asset of release.assets) {
      if (
        asset.name.startsWith('language-server-') &&
        (asset.name.endsWith('.tar.gz') || asset.name.endsWith('.zip')) &&
        asset.name.includes(`-${osType}-`) &&
        asset.name.includes(`-${osArch}.`)
      ) {
        logger.debug('Found matching asset "%s"', asset.name);

        return asset;
      }
    }
  }

  throw new ReleaseError(
    `Could not find a matching asset for os: "${osType}" and arch: "${osArch}"`,
    null,
  );
}

export async function downloadAsset({
  context,
}: {
  context: ExtensionContext;
}) {
  const [asset, getErr] = await tryCatch(getAsset({ context }));

  if (getErr) {
    throw getErr;
  }

  const binDir = path.resolve(context.globalStoragePath, 'bin');
  const binPath = path.resolve(
    binDir,
    asset.name.replace('.zip', '.exe').replace('.tar.gz', ''),
  );

  const [hasBin] = await exists(binPath);

  if (hasBin) {
    await access(
      binPath,
      process.platform === 'win32' ? constants.F_OK : constants.X_OK,
    );
    logger.debug('Using existing binary at "%s"', binPath);

    return binPath;
  }

  const res = await fetch(asset.browser_download_url);

  logger.info('Downloading asset "%s"', asset.browser_download_url);

  if (!res.ok) {
    throw new ReleaseError(
      `Could not download asset "${asset.browser_download_url}"`,
      'Response not ok',
    );
  }

  if (!res.body) {
    throw new ReleaseError(
      `Could not download asset "${asset.browser_download_url}"`,
      'Response does not have a body',
    );
  }

  const [, mkdirErr] = await tryCatch(mkdir(binDir, { recursive: true }));

  if (mkdirErr) {
    throw new ReleaseError('Could not create bin directory', mkdirErr);
  }

  if (asset.name.toLowerCase().endsWith('.tar.gz')) {
    logger.info('Extracting TAR archive to "%s"', binDir);
    await pipeline(res.body, createGunzip(), extractTar({ cwd: binDir }));
  } else if (asset.name.toLowerCase().endsWith('.zip')) {
    logger.info('Extracting ZIP archive to "%s"', binDir);
    await pipeline(res.body, extractZip({ path: binDir }));
  } else {
    logger.info('Streaming binary asset to "%s"', binPath);
    await pipeline(res.body, createWriteStream(binPath));
  }

  const [hasDownloadedBin, downStatErr] = await exists(binPath);

  if (downStatErr) {
    throw new ReleaseError('Could not stat downloaded file', downStatErr);
  }

  if (hasDownloadedBin) {
    await access(
      binPath,
      process.platform === 'win32' ? constants.F_OK : constants.X_OK,
    );
    return binPath;
  }

  throw new ReleaseError(
    `Could not download asset "${asset.browser_download_url}"`,
    'Downloaded file does not exist',
  );
}
