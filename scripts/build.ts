import { chmod, copyFile, mkdir } from 'node:fs/promises';
import { build, context } from 'esbuild';

await mkdir('dist', { recursive: true });
// The language client uses this helper if graceful shutdown times out. Bundled
// Node __dirname points at dist, so ship the helper beside extension.js.
await copyFile(
  'node_modules/vscode-languageclient/lib/node/terminateProcess.sh',
  'dist/terminateProcess.sh',
);
await chmod('dist/terminateProcess.sh', 0o755);
const options = {
  entryPoints: ['src/index.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node' as const,
  format: 'cjs' as const,
  target: 'node20',
  external: ['vscode'],
  minify: process.argv.includes('--minify'),
  logLevel: 'info' as const,
};
if (process.argv.includes('--watch')) await (await context(options)).watch();
else await build(options);
