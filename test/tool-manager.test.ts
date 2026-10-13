import { afterEach, expect, test } from 'bun:test';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createToolManager,
  RELEASE_MANIFEST_URL,
  type ToolManagerDependencies,
} from '../src/lib/releases';

const roots: string[] = [];
const DAY = 24 * 60 * 60 * 1000;
const assets = Object.fromEntries(
  ['linux', 'darwin', 'windows'].flatMap((platform) =>
    ['amd64', 'arm64'].map((arch) => [
      `${platform}-${arch}`,
      `blobl-${platform}-${arch}${platform === 'windows' ? '.exe' : ''}`,
    ]),
  ),
);
const manifest = (version = 'v1.2.3') => ({
  schemaVersion: 1,
  version,
  assets,
});

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture(overrides: ToolManagerDependencies = {}) {
  const storage = await mkdtemp(
    path.join(os.tmpdir(), 'bloblang cache with spaces '),
  );
  roots.push(storage);
  const requests: string[] = [];
  const validations: { command: string; version: string }[] = [];
  let time = 1_000_000;
  const dependencies: ToolManagerDependencies = {
    platform: 'linux',
    arch: 'x64',
    now: () => time,
    fetch: async (url) => {
      requests.push(url);
      return url === RELEASE_MANIFEST_URL
        ? Response.json(manifest())
        : new Response('raw executable');
    },
    validateExecutable: async (command, version) => {
      expect(await readFile(command, 'utf8')).toBe('raw executable');
      validations.push({ command, version });
    },
    ...overrides,
  };
  const create = (extra: ToolManagerDependencies = {}) =>
    createToolManager(
      { globalStoragePath: storage },
      { ...dependencies, ...extra },
    );
  const target = `${dependencies.platform === 'win32' ? 'windows' : dependencies.platform}-${dependencies.arch === 'x64' ? 'amd64' : dependencies.arch}`;
  const directory = path.join(storage, 'tools', target);
  const seed = async (version: string, current = true) => {
    const executable = path.join(
      directory,
      version,
      dependencies.platform === 'win32' ? 'blobl.exe' : 'blobl',
    );
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, 'raw executable');
    await chmod(executable, 0o755);
    if (current)
      await writeFile(
        path.join(directory, 'current.json'),
        JSON.stringify({ schemaVersion: 1, target, version }),
      );
    return executable;
  };
  return {
    storage,
    directory,
    requests,
    validations,
    create,
    seed,
    advance: (amount: number) => {
      time += amount;
    },
    time: () => time,
  };
}

for (const platform of ['linux', 'darwin', 'win32']) {
  for (const arch of ['x64', 'arm64']) {
    test(`downloads raw executable for extension host ${platform}/${arch}`, async () => {
      const f = await fixture({ platform, arch });
      const tool = await f.create().resolve();
      const target = `${platform === 'win32' ? 'windows' : platform}-${arch === 'x64' ? 'amd64' : arch}`;
      expect(f.requests).toEqual([
        RELEASE_MANIFEST_URL,
        `https://github.com/teyfix/bloblang-lsp/releases/download/v1.2.3/${assets[target]}`,
      ]);
      expect(tool).toEqual({
        command: path.join(
          f.directory,
          'v1.2.3',
          platform === 'win32' ? 'blobl.exe' : 'blobl',
        ),
        args: ['lsp'],
        version: 'v1.2.3',
        cliDirectory: path.join(f.directory, 'v1.2.3'),
      });
      expect(await readFile(tool.command, 'utf8')).toBe('raw executable');
      expect(
        JSON.parse(
          await readFile(path.join(f.directory, 'current.json'), 'utf8'),
        ).version,
      ).toBe('v1.2.3');
      expect(
        (await readdir(f.directory)).some((name) =>
          name.startsWith('.staging'),
        ),
      ).toBe(false);
      // A fresh extension process needs no network for a validated cache.
      expect(
        (
          await f
            .create({
              fetch: async () => {
                throw new Error('offline');
              },
            })
            .resolve()
        ).command,
      ).toBe(tool.command);
    });
  }
}

test('cached startup is offline and background update activates only after validation', async () => {
  const f = await fixture();
  const old = await f.seed('v1.0.0');
  const manager = f.create();
  const running = await manager.resolve();
  expect(running.command).toBe(old);
  expect(f.requests).toEqual([]);
  const updated = await manager.checkForUpdates();
  expect(updated?.version).toBe('v1.2.3');
  expect(running.version).toBe('v1.0.0');
  expect(await readFile(old, 'utf8')).toBe('raw executable');
  expect((await manager.resolve()).version).toBe('v1.2.3');
});

test('failed update retains last working binary and offline startup ignores stale API metadata', async () => {
  const f = await fixture();
  await f.seed('v1.0.0');
  await mkdir(path.join(f.storage, '.github-api'));
  await writeFile(
    path.join(f.storage, '.github-api', 'releases.json'),
    JSON.stringify([{ tag_name: 'v9.9.9' }]),
  );
  const manager = f.create({
    fetch: async (url) =>
      url === RELEASE_MANIFEST_URL
        ? Response.json(manifest())
        : new Response('unavailable', { status: 503 }),
  });
  await expect(manager.checkForUpdates()).rejects.toThrow('HTTP 503');
  expect((await manager.resolve()).version).toBe('v1.0.0');
  expect(
    (
      await f
        .create({
          fetch: async () => {
            throw new Error('offline');
          },
        })
        .resolve()
    ).version,
  ).toBe('v1.0.0');
  expect(
    JSON.parse(await readFile(path.join(f.directory, 'current.json'), 'utf8'))
      .version,
  ).toBe('v1.0.0');
  expect(await manager.checkForUpdates()).toBeUndefined();
});

test('validation rejects a downloaded binary before publishing current metadata', async () => {
  const f = await fixture();
  await f.seed('v1.0.0');
  const manager = f.create({
    validateExecutable: async (_, version) => {
      if (version === 'v1.2.3') throw new Error('wrong executable version');
    },
  });
  await expect(manager.checkForUpdates()).rejects.toThrow(
    'wrong executable version',
  );
  expect((await manager.resolve()).version).toBe('v1.0.0');
  expect((await readdir(f.directory)).sort()).toEqual([
    'check.json',
    'current.json',
    'v1.0.0',
  ]);
});

test('corrupt, missing and stale current records recover highest valid installed version offline', async () => {
  for (const record of [
    undefined,
    '{broken json',
    JSON.stringify({ schemaVersion: 1, version: 'v9.9.9' }),
  ]) {
    const f = await fixture();
    await f.seed('v1.2.0', false);
    await f.seed('v1.10.0', false);
    if (record) await writeFile(path.join(f.directory, 'current.json'), record);
    expect((await f.create().resolve()).version).toBe('v1.10.0');
    expect(f.requests).toEqual([]);
  }
});

test('broken newest cached executable falls back to another installed version', async () => {
  const f = await fixture();
  await f.seed('v1.0.0', false);
  await f.seed('v2.0.0');
  const tool = await f
    .create({
      validateExecutable: async (_, version) => {
        if (version === 'v2.0.0') throw new Error('bad binary');
      },
    })
    .resolve();
  expect(tool.version).toBe('v1.0.0');
  expect(f.requests).toEqual([]);
});

test('a corrupt version directory can be repaired while retaining original contents', async () => {
  const f = await fixture();
  const command = await f.seed('v1.2.3');
  await writeFile(command, 'broken executable');
  const manager = f.create({
    validateExecutable: async (candidate) => {
      if ((await readFile(candidate, 'utf8')) !== 'raw executable')
        throw new Error('bad executable');
    },
  });
  const repaired = await manager.checkForUpdates();
  expect(repaired?.version).toBe('v1.2.3');
  expect(await readFile(command, 'utf8')).toBe('raw executable');
  const retained = (await readdir(f.directory)).find((name) =>
    name.startsWith('.invalid-v1.2.3-'),
  );
  expect(retained).toBeDefined();
  expect(
    await readFile(path.join(f.directory, retained ?? '', 'blobl'), 'utf8'),
  ).toBe('broken executable');
});

test('current metadata records the selected host target', async () => {
  const f = await fixture({ platform: 'darwin', arch: 'arm64' });
  await f.create().resolve();
  expect(
    JSON.parse(await readFile(path.join(f.directory, 'current.json'), 'utf8'))
      .target,
  ).toBe('darwin-arm64');
});

test('legacy cached server preserves no-argument launch and upgrades to CLI', async () => {
  const f = await fixture();
  const legacy = path.join(
    f.storage,
    'bin',
    'language-server-v1.2.3-linux-amd64',
  );
  await mkdir(path.dirname(legacy));
  await writeFile(legacy, 'old language server');
  await chmod(legacy, 0o755);
  const manager = f.create();
  expect(await manager.resolve()).toEqual({
    command: legacy,
    version: 'v1.2.3',
    args: [],
    legacy: true,
  });
  expect(f.requests).toEqual([]);
  const upgraded = await manager.checkForUpdates();
  expect(upgraded?.args).toEqual(['lsp']);
  expect(upgraded?.cliDirectory).toBeDefined();
  expect(await readFile(legacy, 'utf8')).toBe('old language server');
});

test('strict manifest rejects schema, prerelease, absent target, and unexpected asset paths', async () => {
  for (const invalid of [
    null,
    [],
    { ...manifest(), schemaVersion: 2 },
    manifest('v1.2.3-beta.1'),
    { ...manifest(), assets: {} },
    { ...manifest(), assets: { ...assets, 'linux-amd64': '../evil' } },
  ]) {
    const f = await fixture({ fetch: async () => Response.json(invalid) });
    await expect(f.create().resolve()).rejects.toThrow();
    expect((await readdir(f.directory)).sort()).toEqual(['check.json']);
  }
});

test('unsupported extension hosts fail clearly without network', async () => {
  const f = await fixture({ platform: 'freebsd', arch: 'riscv64' });
  await expect(f.create().resolve()).rejects.toThrow(
    'Unsupported Bloblang extension host: freebsd/riscv64',
  );
  expect(f.requests).toEqual([]);
});

test('successful and failed checks persist 24-hour throttle with explicit force override', async () => {
  const f = await fixture();
  await f.seed('v1.2.3');
  expect(await f.create().checkForUpdates()).toBeUndefined();
  expect(f.requests).toHaveLength(1);
  expect(await f.create().checkForUpdates()).toBeUndefined();
  expect(f.requests).toHaveLength(1);
  await f.create().checkForUpdates({ force: true });
  expect(f.requests).toHaveLength(2);
  f.advance(DAY + 1);
  await f.create().checkForUpdates();
  expect(f.requests).toHaveLength(3);

  const offline = f.create({
    fetch: async () => {
      f.requests.push('offline');
      throw new Error('offline');
    },
  });
  await expect(offline.checkForUpdates({ force: true })).rejects.toThrow(
    'offline',
  );
  expect(await f.create().checkForUpdates()).toBeUndefined();
  expect(f.requests).toHaveLength(4);
});

test('Retry-After and rate-limit reset extend persisted retry time', async () => {
  for (const headers of [
    { 'Retry-After': String((DAY / 1000) * 2) },
    { 'X-RateLimit-Reset': String((1_000_000 + DAY * 3) / 1000) },
    { 'Retry-After': new Date(1_000_000 + DAY * 2).toUTCString() },
  ]) {
    const f = await fixture({
      fetch: async () => new Response('', { status: 429, headers }),
    });
    await expect(f.create().resolve()).rejects.toThrow('HTTP 429');
    const record = JSON.parse(
      await readFile(path.join(f.directory, 'check.json'), 'utf8'),
    );
    expect(record.nextCheck).toBeGreaterThanOrEqual(f.time() + DAY * 2);
    f.advance(DAY + 1);
    expect(await f.create().checkForUpdates()).toBeUndefined();
  }
});

test('first-install failure is throttled across startups', async () => {
  let requests = 0;
  const f = await fixture({
    fetch: async () => {
      requests++;
      throw new Error('offline');
    },
  });
  await expect(f.create().resolve()).rejects.toThrow('offline');
  await expect(f.create().resolve()).rejects.toThrow(
    'download retry is temporarily delayed',
  );
  expect(requests).toBe(1);
});

test('manifest request, manifest body, executable stream and validation are bounded', async () => {
  const never = () => new Promise<never>(() => {});
  const body = () => new ReadableStream({ start() {} });
  const scenarios: ToolManagerDependencies[] = [
    { fetch: never },
    { fetch: async () => new Response(body()) },
    {
      fetch: async (url) =>
        url === RELEASE_MANIFEST_URL
          ? Response.json(manifest())
          : new Response(body()),
    },
    { validateExecutable: never },
  ];
  for (const scenario of scenarios) {
    const f = await fixture({ timeoutMs: 30, ...scenario });
    await expect(f.create().resolve()).rejects.toThrow('timed out');
    expect(
      (await readdir(f.directory)).some((name) => name.startsWith('.staging')),
    ).toBe(false);
    expect(
      await readFile(path.join(f.directory, 'current.json'), 'utf8').catch(
        () => undefined,
      ),
    ).toBeUndefined();
  }
});

test('cancellation during download and validation never changes current metadata', async () => {
  for (const phase of ['download', 'validation']) {
    const abort = new AbortController();
    const f = await fixture();
    await f.seed('v1.0.0');
    const manager = f.create({
      fetch: async (url) => {
        if (url === RELEASE_MANIFEST_URL) return Response.json(manifest());
        if (phase === 'download') {
          abort.abort(new Error('extension stopped'));
          return new Response(new ReadableStream({ start() {} }));
        }
        return new Response('raw executable');
      },
      validateExecutable: async (_, version) => {
        if (phase === 'validation' && version === 'v1.2.3') {
          abort.abort(new Error('extension stopped'));
          await new Promise(() => {});
        }
      },
    });
    await expect(
      manager.checkForUpdates({ signal: abort.signal }),
    ).rejects.toThrow('extension stopped');
    expect(
      JSON.parse(await readFile(path.join(f.directory, 'current.json'), 'utf8'))
        .version,
    ).toBe('v1.0.0');
    expect(
      (await readdir(f.directory)).some((name) => name.startsWith('.staging')),
    ).toBe(false);
  }
});

test('cancelling cold startup permits the next startup to download immediately', async () => {
  const f = await fixture();
  const abort = new AbortController();
  let requested: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    requested = resolve;
  });
  const cancelled = f
    .create({
      fetch: async () => {
        requested?.();
        await new Promise(() => {});
        throw new Error('unreachable');
      },
    })
    .resolve(abort.signal);
  await started;
  abort.abort(new Error('extension stopped'));
  await expect(cancelled).rejects.toThrow('extension stopped');
  expect((await f.create().resolve()).version).toBe('v1.2.3');
});

test('a cancelled forced check preserves the previous completed check throttle', async () => {
  const f = await fixture();
  await f.seed('v1.2.3');
  await f.create().checkForUpdates();
  const prior = await readFile(path.join(f.directory, 'check.json'), 'utf8');
  const abort = new AbortController();
  const manager = f.create({
    fetch: async () => {
      abort.abort(new Error('extension stopped'));
      await new Promise(() => {});
      throw new Error('unreachable');
    },
  });
  await expect(
    manager.checkForUpdates({ force: true, signal: abort.signal }),
  ).rejects.toThrow('extension stopped');
  expect(await readFile(path.join(f.directory, 'check.json'), 'utf8')).toBe(
    prior,
  );
});

test('concurrent resolves share a single install', async () => {
  const f = await fixture();
  const manager = f.create();
  const tools = await Promise.all([
    manager.resolve(),
    manager.resolve(),
    manager.resolve(),
  ]);
  expect(new Set(tools.map((tool) => tool.command)).size).toBe(1);
  expect(f.requests).toHaveLength(2);
});

test('separate extension windows safely publish the same version', async () => {
  const f = await fixture();
  const updates = await Promise.all([
    f.create().checkForUpdates({ force: true }),
    f.create().checkForUpdates({ force: true }),
  ]);
  expect(
    updates.every((tool) => tool?.version === 'v1.2.3' || tool === undefined),
  ).toBe(true);
  expect((await f.create().resolve()).version).toBe('v1.2.3');
  expect(
    (await readdir(f.directory)).some((name) => name.startsWith('.staging')),
  ).toBe(false);
});

test('default validator executes --version safely from a storage path containing spaces', async () => {
  if (process.platform === 'win32') return;
  const f = await fixture({
    platform: process.platform,
    arch: process.arch,
    validateExecutable: undefined,
    fetch: async (url) =>
      url === RELEASE_MANIFEST_URL
        ? Response.json(manifest())
        : new Response('#!/bin/sh\nprintf "v1.2.3 (built today)\\n"\n'),
  });
  expect((await f.create().resolve()).version).toBe('v1.2.3');
});
