// vsce normally shells out to npm for prepublish; this project builds with Bun
// explicitly before packaging and bundles all client dependencies in dist.
const target = process.env.VSCE_TARGET ?? `${process.platform}-${process.arch}`;
const child = Bun.spawn(
  [
    'bun',
    'node_modules/@vscode/vsce/vsce',
    'package',
    '--no-dependencies',
    '--target',
    target,
  ],
  {
    stdout: 'inherit',
    stderr: 'inherit',
  },
);
if ((await child.exited) !== 0) throw new Error('VSIX packaging failed');
