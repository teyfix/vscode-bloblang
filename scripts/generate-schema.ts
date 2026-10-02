import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// The server's rule registry owns IDs, options and defaults. Never hand-edit
// the copied schema: regenerate it whenever server configuration changes.
const repository = path.resolve(
  process.env.BLOBLANG_LSP_REPO ?? '../bloblang-lsp',
);
const generated = Bun.spawn(['go', 'run', './cmd/config-schema'], {
  cwd: repository,
  stdout: 'pipe',
  stderr: 'inherit',
});
const schema = await new Response(generated.stdout).text();
if ((await generated.exited) !== 0)
  throw new Error('Could not generate Bloblang configuration schema');
JSON.parse(schema);
await mkdir('schemas', { recursive: true });
await writeFile('schemas/bloblangrc.schema.json', schema);
console.log(
  'Generated schemas/bloblangrc.schema.json from the server rule registry',
);
