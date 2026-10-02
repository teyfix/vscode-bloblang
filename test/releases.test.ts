import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { downloadLatestServer } from '../src/lib/releases';

test('downloads the latest verified server, updates it, and uses cache offline', async () => {
  const storage = await mkdtemp(path.join(os.tmpdir(), 'bloblang-release-'));
  let tag = 'v0.2.1';
  const downloads: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    downloads.push(url);
    const binary = Buffer.from(`server ${tag}`);
    const checksum = createHash('sha256').update(binary).digest('hex');
    if (url.endsWith('/releases/latest'))
      return Response.json({
        tag_name: tag,
        assets: [
          {
            name: 'bloblang-lsp-linux-amd64',
            browser_download_url: 'https://example.test/server',
          },
          {
            name: 'SHA256SUMS',
            browser_download_url: 'https://example.test/checksums',
          },
        ],
      });
    if (url.endsWith('/checksums'))
      return new Response(`${checksum}  bloblang-lsp-linux-amd64\n`);
    if (url.endsWith('/server')) return new Response(binary);
    throw new Error(`Unexpected URL: ${url}`);
  }) as unknown as typeof fetch;
  try {
    const first = await downloadLatestServer(storage, 'linux', 'x64', fetcher);
    expect((await readFile(first)).toString()).toBe('server v0.2.1');
    expect(downloads.filter((url) => url.endsWith('/server'))).toHaveLength(1);

    expect(await downloadLatestServer(storage, 'linux', 'x64', fetcher)).toBe(
      first,
    );
    expect(downloads.filter((url) => url.endsWith('/server'))).toHaveLength(1);

    tag = 'v0.2.2';
    const updated = await downloadLatestServer(
      storage,
      'linux',
      'x64',
      fetcher,
    );
    expect(updated).not.toBe(first);
    expect((await readFile(updated)).toString()).toBe('server v0.2.2');
    expect(downloads.filter((url) => url.endsWith('/server'))).toHaveLength(2);

    const offline = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await downloadLatestServer(storage, 'linux', 'x64', offline)).toBe(
      updated,
    );
  } finally {
    await rm(storage, { recursive: true, force: true });
  }
});

test('rejects an unverified download with no cached server', async () => {
  const storage = await mkdtemp(path.join(os.tmpdir(), 'bloblang-release-'));
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/releases/latest'))
      return Response.json({
        tag_name: 'v0.2.1',
        assets: [
          {
            name: 'bloblang-lsp-linux-amd64',
            browser_download_url: 'https://example.test/server',
          },
          {
            name: 'SHA256SUMS',
            browser_download_url: 'https://example.test/checksums',
          },
        ],
      });
    if (url.endsWith('/checksums'))
      return new Response(`${'0'.repeat(64)}  bloblang-lsp-linux-amd64\n`);
    return new Response('wrong binary');
  }) as unknown as typeof fetch;
  try {
    await expect(
      downloadLatestServer(storage, 'linux', 'x64', fetcher),
    ).rejects.toThrow('Checksum mismatch');
  } finally {
    await rm(storage, { recursive: true, force: true });
  }
});
