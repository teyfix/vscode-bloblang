import { strict as assert } from 'node:assert';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';

async function until<T>(
  work: () => PromiseLike<T>,
  valid: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + 20000;
  let value: T;
  do {
    value = await work();
    if (valid(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  } while (Date.now() < deadline);
  throw new Error(
    `Extension smoke condition timed out: ${JSON.stringify(value)}`,
  );
}

function hoverText(hovers: vscode.Hover[] | undefined): string {
  return (hovers ?? [])
    .flatMap((hover) => hover.contents)
    .map((content) =>
      typeof content === 'string'
        ? content
        : 'value' in content
          ? content.value
          : '',
    )
    .join('\n');
}

export async function run(): Promise<void> {
  const folder = path.join(
    os.tmpdir(),
    `bloblang-extension-smoke-${process.pid}`,
  );
  await mkdir(folder, { recursive: true });
  const mappingFile = path.join(folder, 'mapping.blobl');
  await writeFile(
    path.join(folder, 'mapping.sample.json'),
    JSON.stringify({
      $bloblang: { input: { name: 'Ada' }, meta: { topic: 'smoke' } },
    }),
  );
  await writeFile(
    mappingFile,
    'root.name=this.name.uppercase()\nroot.topic=meta("topic")\nlet person = this.name\nroot.person = $person\n',
  );
  const document = await vscode.workspace.openTextDocument(mappingFile);
  await vscode.window.showTextDocument(document);
  assert.equal(document.languageId, 'bloblang');
  const extension = vscode.extensions.getExtension('teyfix.vscode-bloblang');
  assert.ok(extension, 'Bloblang package is registered');
  await extension.activate();
  const hovers = await until(
    () =>
      vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        document.uri,
        new vscode.Position(0, 26),
      ),
    (value) => hoverText(value).includes('uppercase'),
  );
  assert.ok(
    hoverText(hovers).includes('uppercase'),
    'Function documentation hover',
  );
  const completion =
    await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      document.uri,
      new vscode.Position(0, 19),
      '.',
    );
  assert.ok(completion?.items.length, 'Completions available');
  const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
    'vscode.executeFormatDocumentProvider',
    document.uri,
    { tabSize: 2, insertSpaces: true },
  );
  assert.ok(edits?.length, 'Bloblang formatting changes unformatted mapping');
  const inputHover = await vscode.commands.executeCommand<vscode.Hover[]>(
    'vscode.executeHoverProvider',
    document.uri,
    new vscode.Position(0, 12),
  );
  assert.ok(hoverText(inputHover).includes('Ada'), 'Sample input hover');
  const definitions = await vscode.commands.executeCommand<
    (vscode.Location | vscode.LocationLink)[]
  >(
    'vscode.executeDefinitionProvider',
    document.uri,
    new vscode.Position(3, 16),
  );
  assert.ok(definitions?.length, 'Variable definition navigation');
  const references = await vscode.commands.executeCommand<vscode.Location[]>(
    'vscode.executeReferenceProvider',
    document.uri,
    new vscode.Position(3, 16),
  );
  assert.ok(references?.length, 'Variable references');
  const yamlFile = path.join(folder, 'pipeline.yaml');
  await writeFile(
    yamlFile,
    'pipeline:\n  processors:\n    - mapping: |\n        root.name=this.name.uppercase()\n      label: processor_unchanged\noutput:\n  label: unchanged\n',
  );
  const yaml = await vscode.workspace.openTextDocument(yamlFile);
  await vscode.window.showTextDocument(yaml);
  const yamlHover = await until(
    () =>
      vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        yaml.uri,
        new vscode.Position(3, 34),
      ),
    (value) => hoverText(value).includes('uppercase'),
  );
  assert.ok(
    hoverText(yamlHover).includes('uppercase'),
    'YAML source mapped hover',
  );
  await vscode.commands.executeCommand('bloblang.formatEmbeddedMappings');
  assert.ok(
    yaml.getText().includes('label: unchanged'),
    'YAML host content preserved',
  );
  assert.ok(
    yaml.getText().includes('label: processor_unchanged'),
    'YAML processor sibling preserved',
  );
  assert.ok(
    yaml.getText().includes('root.name = this.name.uppercase()'),
    'YAML embedded formatting applied',
  );
  const invalidFile = path.join(folder, 'invalid.blobl');
  await writeFile(invalidFile, 'root = this.\n');
  const invalid = await vscode.workspace.openTextDocument(invalidFile);
  await until(
    async () => vscode.languages.getDiagnostics(invalid.uri),
    (value) =>
      value.some(
        (diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error,
      ),
  );
  const untitled = await vscode.workspace.openTextDocument({
    language: 'bloblang',
    content: 'root = this.\n',
  });
  await until(
    async () => vscode.languages.getDiagnostics(untitled.uri),
    (value) =>
      value.some(
        (diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error,
      ),
  );
  const registered = await vscode.commands.getCommands();
  assert.ok(registered.includes('bloblang.restartServer'));
  assert.ok(registered.includes('bloblang.formatEmbeddedMappings'));
  await vscode.commands.executeCommand('bloblang.restartServer');
  console.log(
    'Bloblang extension smoke passed: offline bundled startup, registration, static/sample hover, completion, formatting, YAML mapping, diagnostics, untitled, restart',
  );
  await writeFile(path.join(folder, 'passed.txt'), 'passed\n');
}
