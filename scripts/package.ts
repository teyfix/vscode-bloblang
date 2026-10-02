// vsce normally shells out to npm for prepublish; this project builds with Bun
// explicitly before packaging and bundles all client dependencies in dist.
const child = Bun.spawn(
  ['bun', 'node_modules/@vscode/vsce/vsce', 'package', '--no-dependencies'],
  {
    stdout: 'inherit',
    stderr: 'inherit',
  },
);
if ((await child.exited) !== 0) throw new Error('VSIX packaging failed');
