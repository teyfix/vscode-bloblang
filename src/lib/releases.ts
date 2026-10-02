import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

const latestReleaseURL =
  'https://api.github.com/repos/teyfix/bloblang-lsp/releases/latest';

type Asset = { name: string; browser_download_url: string };
type Release = { tag_name: string; assets: Asset[] };
type Cache = { tag: string; asset: string; sha256: string };
class ReleaseIntegrityError extends Error {}

function safeTag(tag: string): boolean {
  return /^[\w.-]+$/.test(tag) && tag !== '.' && tag !== '..';
}

function assetName(platform: NodeJS.Platform, arch: string): string {
  const os = { linux: 'linux', darwin: 'darwin', win32: 'windows' }[
    platform as 'linux' | 'darwin' | 'win32'
  ];
  const cpu = { x64: 'amd64', arm64: 'arm64' }[arch as 'x64' | 'arm64'];
  if (!os || !cpu)
    throw new Error(
      `No Bloblang server release for ${platform}-${arch}; set bloblang.server.path.`,
    );
  return `bloblang-lsp-${os}-${cpu}${platform === 'win32' ? '.exe' : ''}`;
}

async function response(url: string, fetcher: typeof fetch): Promise<Response> {
  const result = await fetcher(url, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!result.ok) throw new Error(`HTTP ${result.status} from ${url}`);
  return result;
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

async function validBinary(file: string, expected: string): Promise<boolean> {
  try {
    await access(
      file,
      process.platform === 'win32' ? constants.F_OK : constants.X_OK,
    );
    return sha256(await readFile(file)) === expected;
  } catch {
    return false;
  }
}

async function readCache(file: string): Promise<Cache | undefined> {
  try {
    const cache = JSON.parse(await readFile(file, 'utf8')) as Cache;
    if (
      typeof cache.tag === 'string' &&
      safeTag(cache.tag) &&
      typeof cache.asset === 'string' &&
      typeof cache.sha256 === 'string' &&
      /^[a-f\d]{64}$/.test(cache.sha256)
    )
      return cache;
  } catch {
    // No verified server has been cached yet.
  }
  return undefined;
}

export async function downloadLatestServer(
  storagePath: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const name = assetName(platform, arch);
  const cacheFile = path.join(storagePath, 'server-cache.json');
  const cache = await readCache(cacheFile);
  const cachedPath = cache && path.join(storagePath, 'bin', cache.tag, name);

  try {
    const release = (await (
      await response(latestReleaseURL, fetcher)
    ).json()) as Release;
    if (!safeTag(release.tag_name))
      throw new ReleaseIntegrityError(
        'The latest Bloblang server release has an invalid tag',
      );
    const binaryAsset = release.assets.find((asset) => asset.name === name);
    const checksums = release.assets.find(
      (asset) => asset.name === 'SHA256SUMS',
    );
    if (!binaryAsset || !checksums)
      throw new ReleaseIntegrityError(
        `The latest Bloblang server release ${release.tag_name} has no verified ${name} asset`,
      );
    const checksumText = await (
      await response(checksums.browser_download_url, fetcher)
    ).text();
    const checksumLine = checksumText
      .split(/\r?\n/)
      .find((line) => line.endsWith(`  ${name}`));
    const expected = checksumLine?.match(/^([a-f\d]{64}) {2}/)?.[1];
    if (!expected)
      throw new ReleaseIntegrityError(`SHA256SUMS has no checksum for ${name}`);

    const destination = path.join(storagePath, 'bin', release.tag_name, name);
    if (!(await validBinary(destination, expected))) {
      const binary = await response(binaryAsset.browser_download_url, fetcher);
      const declaredSize = Number(binary.headers.get('content-length') ?? 0);
      if (declaredSize > 256 * 1024 * 1024)
        throw new ReleaseIntegrityError(
          `${name} exceeds the maximum download size`,
        );
      const bytes = new Uint8Array(await binary.arrayBuffer());
      if (bytes.length > 256 * 1024 * 1024 || sha256(bytes) !== expected)
        throw new ReleaseIntegrityError(`Checksum mismatch for ${name}`);
      await mkdir(path.dirname(destination), { recursive: true });
      const temporary = `${destination}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, bytes);
        if (platform !== 'win32') await chmod(temporary, 0o755);
        await rm(destination, { force: true });
        await rename(temporary, destination);
      } finally {
        await rm(temporary, { force: true });
      }
    }
    await mkdir(storagePath, { recursive: true });
    await writeFile(
      cacheFile,
      JSON.stringify({ tag: release.tag_name, asset: name, sha256: expected }),
    );
    return destination;
  } catch (error) {
    if (
      !(error instanceof ReleaseIntegrityError) &&
      cache?.asset === name &&
      cachedPath &&
      (await validBinary(cachedPath, cache.sha256))
    )
      return cachedPath;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not download the latest Bloblang server: ${message}`,
    );
  }
}
