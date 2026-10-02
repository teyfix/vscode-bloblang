import { beforeAll, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { loadWASM, OnigScanner, OnigString } from 'vscode-oniguruma';
import { type IGrammar, INITIAL, Registry } from 'vscode-textmate';

const require = createRequire(import.meta.url);
let registry: Registry;
beforeAll(async () => {
  await loadWASM(
    (await readFile(require.resolve('vscode-oniguruma/release/onig.wasm')))
      .buffer,
  );
  const scopes: Record<string, string> = {
    'source.bloblang.teyfix': 'syntaxes/bloblang.tmLanguage.json',
    'bloblang.injection.yaml': 'syntaxes/bloblang-yaml.tmLanguage.json',
    'bloblang.injection.cue': 'syntaxes/bloblang-cue.tmLanguage.json',
  };
  registry = new Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (patterns) => new OnigScanner(patterns),
      createOnigString: (text) => new OnigString(text),
    }),
    loadGrammar: async (scope) => {
      if (scopes[scope])
        return JSON.parse(await readFile(scopes[scope], 'utf8'));
      if (scope.startsWith('source.yaml')) {
        const name =
          scope === 'source.yaml'
            ? 'yaml'
            : scope === 'source.yaml.embedded'
              ? 'yaml-embedded'
              : scope.replace('source.', '').replace('.1.', '-1.');
        const location =
          process.env.VSCODE_YAML_GRAMMAR_DIR ?? 'test/fixtures/host-grammars';
        return JSON.parse(
          await readFile(
            path.join(location, `${name}.tmLanguage.json`),
            'utf8',
          ),
        );
      }
      if (scope === 'source.cue') {
        const location =
          process.env.VSCODE_CUE_GRAMMAR ??
          'test/fixtures/host-grammars/cue.tmLanguage.json';
        return JSON.parse(await readFile(location, 'utf8'));
      }
      return null;
    },
    getInjections: (scope) =>
      scope.startsWith('source.yaml')
        ? ['bloblang.injection.yaml']
        : scope === 'source.cue'
          ? ['bloblang.injection.cue']
          : [],
  });
});
function tokenize(grammar: IGrammar, text: string) {
  let state = INITIAL;
  return text.split('\n').map((line) => {
    const result = grammar.tokenizeLine(line, state);
    state = result.ruleStack;
    return result.tokens.map((token) => ({
      text: line.slice(token.startIndex, token.endIndex),
      scopes: token.scopes,
    }));
  });
}
function hasToken(
  tokens: ReturnType<typeof tokenize>[number],
  text: string,
  scope: string,
) {
  return tokens.some(
    (token) => token.text === text && token.scopes.includes(scope),
  );
}
test('standalone Bloblang keywords, methods, fields, metadata, directives and nested objects', async () => {
  const grammar = await registry.loadGrammar('source.bloblang.teyfix');
  if (!grammar) throw new Error('Missing grammar');
  const tokens = tokenize(
    grammar,
    '#!input {"name":"Ada"}\nroot.name = this.name.uppercase()\nlet value = @topic\nroot = {"nested": {"id": $value}}',
  );
  expect(
    hasToken(tokens[0] ?? [], 'input', 'keyword.other.directive.bloblang'),
  ).toBe(true);
  expect(hasToken(tokens[1] ?? [], 'root', 'variable.language.bloblang')).toBe(
    true,
  );
  expect(
    hasToken(tokens[1] ?? [], 'uppercase', 'support.function.method.bloblang'),
  ).toBe(true);
  expect(hasToken(tokens[2] ?? [], '@topic', 'variable.other.bloblang')).toBe(
    true,
  );
});
test('YAML mapping scalar forms, interpolation, nesting and return to host YAML', async () => {
  const grammar = await registry.loadGrammar('source.yaml');
  if (!grammar) throw new Error('Missing YAML grammar');
  const text = await readFile('test/fixtures/embedded.yaml', 'utf8');
  const tokens = tokenize(grammar, text);
  for (const line of [3, 4, 7, 8, 9, 10, 11, 13]) {
    expect(
      tokens[line]?.some((token) =>
        token.scopes.some(
          (scope) =>
            scope.startsWith('meta.embedded.') && scope.endsWith('.bloblang'),
        ),
      ),
    ).toBe(true);
  }
  expect(
    hasToken(tokens[4] ?? [], 'uppercase', 'support.function.method.bloblang'),
  ).toBe(true);
  expect(
    hasToken(
      tokens[16] ?? [],
      'format_json',
      'support.function.method.bloblang',
    ),
  ).toBe(true);
  for (const line of [5, 17, 18])
    expect(
      tokens[line]?.some((token) =>
        token.scopes.includes('meta.embedded.block.bloblang'),
      ),
    ).toBe(false);
  expect(
    tokens[17]?.some((token) =>
      token.scopes.includes('variable.language.bloblang'),
    ),
  ).toBe(false);
});
test('real project YAML mapping content highlights and ordinary fields remain YAML', async () => {
  const grammar = await registry.loadGrammar('source.yaml');
  if (!grammar) throw new Error('Missing YAML grammar');
  const file = 'test/fixtures/ingest.yaml';
  const text = await readFile(file, 'utf8');
  const tokens = tokenize(grammar, text);
  expect(
    tokens
      .flat()
      .filter((token) => token.scopes.includes('variable.language.bloblang'))
      .length,
  ).toBeGreaterThan(30);
  const ordinary = text
    .split('\n')
    .findIndex((line) => /^\s*label:/.test(line));
  if (ordinary >= 0)
    expect(
      tokens[ordinary]?.some((token) =>
        token.scopes.includes('meta.embedded.block.bloblang'),
      ),
    ).toBe(false);
});
test('CUE multiline/raw mapping strings and interpolation', async () => {
  const grammar = await registry.loadGrammar('source.cue');
  if (!grammar) throw new Error('Missing CUE grammar');
  const tokens = tokenize(
    grammar,
    'mapping: """\n  root = this\n  """\ncheck: #"this.ok == true"#\ntopic: #"${! meta("topic") }"#\nordinary: "root = this"',
  );
  expect(hasToken(tokens[1] ?? [], 'root', 'variable.language.bloblang')).toBe(
    true,
  );
  expect(hasToken(tokens[3] ?? [], 'this', 'variable.language.bloblang')).toBe(
    true,
  );
  expect(hasToken(tokens[4] ?? [], 'meta', 'keyword.control.bloblang')).toBe(
    true,
  );
  expect(
    tokens[5]?.some((token) =>
      token.scopes.includes('variable.language.bloblang'),
    ),
  ).toBe(false);
});

test('unfinished mapping object does not swallow following YAML fields', async () => {
  const grammar = await registry.loadGrammar('source.yaml');
  if (!grammar) throw new Error('Missing YAML grammar');
  const tokens = tokenize(
    grammar,
    'pipeline:\n  mapping: |\n    root = {\n      "id": this.id\n  label: still_yaml\noutput: {}',
  );
  expect(
    tokens[4]?.some((token) =>
      token.scopes.includes('meta.embedded.block.bloblang'),
    ),
  ).toBe(false);
  expect(
    tokens[5]?.some((token) =>
      token.scopes.includes('meta.embedded.block.bloblang'),
    ),
  ).toBe(false);
});

test('YAML quoted mappings beginning after a key-only line retain Bloblang scopes', async () => {
  const grammar = await registry.loadGrammar('source.yaml');
  if (!grammar) throw new Error('Missing YAML grammar');
  const tokens = tokenize(
    grammar,
    String.raw`pipeline:
  mapping:
    'root.foo = this.foo
     root.message = "it''s fine"'
  label: ordinary_yaml
  check: # expression-only mapping
    "!errored() && this.message != \"ready\"
     && this.ready"
  after: ordinary_yaml
  request_map:
    # a comment before the quoted value
    'root = this'
  "following": "root = this"
  result_map:
  label: ordinary_yaml`,
  );
  expect(hasToken(tokens[2] ?? [], 'root', 'variable.language.bloblang')).toBe(
    true,
  );
  expect(hasToken(tokens[3] ?? [], 'root', 'variable.language.bloblang')).toBe(
    true,
  );
  expect(
    hasToken(tokens[6] ?? [], 'errored', 'support.function.bloblang'),
  ).toBe(true);
  expect(hasToken(tokens[7] ?? [], 'this', 'variable.language.bloblang')).toBe(
    true,
  );
  expect(hasToken(tokens[11] ?? [], 'root', 'variable.language.bloblang')).toBe(
    true,
  );
  for (const line of [4, 8, 12, 14])
    expect(
      tokens[line]?.some((token) =>
        token.scopes.includes('meta.embedded.inline.bloblang'),
      ),
    ).toBe(false);
});

test('next-line quoted sequence values and escaped host quotes return to YAML', async () => {
  const grammar = await registry.loadGrammar('source.yaml');
  if (!grammar) throw new Error('Missing YAML grammar');
  const tokens = tokenize(
    grammar,
    String.raw`processors:
  - mapping:
      "root = \"quoted \\\"value\\\"\"
       root.foo = this.foo"
    label: unchanged
  - check:
      '!errored()'
    label: unchanged`,
  );
  expect(hasToken(tokens[2] ?? [], 'root', 'variable.language.bloblang')).toBe(
    true,
  );
  expect(hasToken(tokens[3] ?? [], 'root', 'variable.language.bloblang')).toBe(
    true,
  );
  expect(
    hasToken(tokens[6] ?? [], 'errored', 'support.function.bloblang'),
  ).toBe(true);
  for (const line of [4, 7])
    expect(
      tokens[line]?.some((token) =>
        token.scopes.includes('meta.embedded.inline.bloblang'),
      ),
    ).toBe(false);
});

test('empty YAML sequence mapping key does not capture a quoted sibling key', async () => {
  const grammar = await registry.loadGrammar('source.yaml');
  if (!grammar) throw new Error('Missing YAML grammar');
  const tokens = tokenize(
    grammar,
    'processors:\n  - mapping:\n    "label": "root = this"\n  - label: unchanged',
  );
  expect(
    tokens[2]?.some((token) =>
      token.scopes.includes('meta.embedded.inline.bloblang'),
    ),
  ).toBe(false);
});
