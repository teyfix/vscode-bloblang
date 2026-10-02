import { access, chmod, copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const target = process.env.VSCE_TARGET ?? `${process.platform}-${process.arch}`;
const [targetPlatform, targetArch] = target.split('-');
if (!targetPlatform || !targetArch)
  throw new Error(`Invalid VSCE_TARGET: ${target}`);
const runtimePlatform = targetPlatform === 'alpine' ? 'linux' : targetPlatform;
const suffix = runtimePlatform === 'win32' ? '.exe' : '';
const destination = path.resolve(
  'bin',
  `${runtimePlatform}-${targetArch}`,
  `bloblang-lsp${suffix}`,
);
const provided = process.env.BLOBLANG_LSP_BINARY;
const repository = path.resolve(
  process.env.BLOBLANG_LSP_REPO ?? '../bloblang-lsp',
);
await mkdir(path.dirname(destination), { recursive: true });
if (provided) {
  await access(provided);
  await copyFile(provided, destination);
} else {
  if (
    runtimePlatform !== process.platform ||
    targetArch !== process.arch ||
    targetPlatform === 'alpine'
  ) {
    throw new Error(
      'Cross packaging requires BLOBLANG_LSP_BINARY built for VSCE_TARGET; native packaging builds the sibling server automatically.',
    );
  }
  const build = Bun.spawn(
    ['go', 'build', '-a', '-trimpath', '-o', destination, './cmd/bloblang-lsp'],
    {
      cwd: repository,
      stdout: 'inherit',
      stderr: 'inherit',
    },
  );
  if ((await build.exited) !== 0)
    throw new Error(
      'Could not build bloblang-lsp; set BLOBLANG_LSP_BINARY to a prebuilt current server.',
    );
}
if (process.platform !== 'win32') await chmod(destination, 0o755);
console.log(`Bundled ${destination}`);
