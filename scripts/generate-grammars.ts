import { mkdir, writeFile } from 'node:fs/promises';

type Rule = Record<string, unknown>;
const include = (name: string): Rule => ({ include: name });
const bloblang = {
  name: 'Bloblang',
  scopeName: 'source.bloblang.teyfix',
  patterns: [
    include('#comments'),
    include('#strings'),
    {
      match: '\\b(map)(\\s+)([A-Za-z_][A-Za-z0-9_]*)',
      captures: {
        1: { name: 'keyword.declaration.bloblang' },
        3: { name: 'entity.name.function.bloblang' },
      },
    },
    {
      match: '\\b(let)(\\s+)([A-Za-z_][A-Za-z0-9_]*)',
      captures: {
        1: { name: 'keyword.declaration.bloblang' },
        3: { name: 'variable.other.bloblang' },
      },
    },
    { match: '\\b(this|root)\\b', name: 'variable.language.bloblang' },
    {
      match: '\\b(map|let|meta|import|from|if|else|match)\\b',
      name: 'keyword.control.bloblang',
    },
    { match: '\\b(true|false|null)\\b', name: 'constant.language.bloblang' },
    {
      match:
        '(?<![\\w.])-?\\b(?:0[xX][0-9a-fA-F]+|[0-9]+(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)\\b',
      name: 'constant.numeric.bloblang',
    },
    { match: '[$@][A-Za-z_][A-Za-z0-9_]*|@', name: 'variable.other.bloblang' },
    {
      match: '(\\.)([A-Za-z_][A-Za-z0-9_]*)(?=\\s*\\()',
      captures: {
        1: { name: 'punctuation.accessor.bloblang' },
        2: { name: 'support.function.method.bloblang' },
      },
    },
    {
      match: '\\b[A-Za-z_][A-Za-z0-9_]*(?=\\s*\\()',
      name: 'support.function.bloblang',
    },
    {
      match: '\\b[A-Za-z_][A-Za-z0-9_]*(?=\\s*->)',
      name: 'variable.parameter.bloblang',
    },
    {
      match: '(\\.)([A-Za-z_][A-Za-z0-9_]*)',
      captures: {
        1: { name: 'punctuation.accessor.bloblang' },
        2: { name: 'variable.other.property.bloblang' },
      },
    },
    {
      match: '\\b[A-Za-z_][A-Za-z0-9_]*(?=\\s*:)',
      name: 'variable.other.property.bloblang',
    },
    {
      match: '=>|->|==|!=|>=|<=|&&|\\|\\||[-+*/%=!<>|]',
      name: 'keyword.operator.bloblang',
    },
    include('#braces'),
    { match: '[\\[\\]()]', name: 'punctuation.section.brackets.bloblang' },
    { match: '[.,:;]', name: 'punctuation.separator.bloblang' },
    { match: '\\b[A-Za-z_][A-Za-z0-9_]*\\b', name: 'variable.other.bloblang' },
  ],
  repository: {
    comments: {
      patterns: [
        {
          begin: '#!([A-Za-z_][A-Za-z0-9_]*)',
          end: '$',
          name: 'comment.line.directive.bloblang',
          beginCaptures: { 1: { name: 'keyword.other.directive.bloblang' } },
        },
        { match: '#.*$', name: 'comment.line.number-sign.bloblang' },
      ],
    },
    strings: {
      patterns: [
        {
          begin: '"""',
          end: '"""',
          name: 'string.quoted.triple.bloblang',
          patterns: [include('#escapes')],
        },
        {
          begin: '"',
          end: '"|$',
          name: 'string.quoted.double.bloblang',
          patterns: [include('#escapes')],
        },
      ],
    },
    escapes: {
      match: '\\\\(?:["\\\\/bfnrt]|u[0-9a-fA-F]{4})',
      name: 'constant.character.escape.bloblang',
    },
    braces: {
      match: '[{}]',
      name: 'punctuation.section.braces.bloblang',
    },
  },
};
const keys =
  '(?:mapping|request_map|result_map|args_mapping|fields_mapping|check|bloblang)';
const keyPrefix = `(?<=^([ \t]*)(?:-[ \t]+)*)((?:["']?${keys}["']?))[ \t]*(:)[ \t]*`;
const keyCaptures = {
  2: { name: 'entity.name.tag.yaml' },
  3: { name: 'punctuation.separator.key-value.yaml' },
};
const interpolation = {
  begin: '\\$\\{!',
  end: '\\}',
  contentName: 'meta.embedded.inline.bloblang',
  beginCaptures: {
    0: { name: 'punctuation.section.interpolation.begin.bloblang' },
  },
  endCaptures: {
    0: { name: 'punctuation.section.interpolation.end.bloblang' },
  },
  patterns: [include('#interpolation-content')],
};
const interpolationContent = {
  patterns: [
    { begin: '\\{', end: '\\}', patterns: [include('#interpolation-content')] },
    include('source.bloblang.teyfix'),
  ],
};
const yamlSingleQuote = {
  begin: "(')",
  end: "'(?!')",
  contentName: 'meta.embedded.inline.bloblang',
  beginCaptures: { 1: { name: 'punctuation.definition.string.begin.yaml' } },
  endCaptures: { 0: { name: 'punctuation.definition.string.end.yaml' } },
  patterns: [
    { match: "''", name: 'constant.character.escape.yaml' },
    include('source.bloblang.teyfix'),
  ],
};
const yamlDoubleQuote = {
  begin: '(")',
  end: '"',
  contentName: 'meta.embedded.inline.bloblang',
  beginCaptures: { 1: { name: 'punctuation.definition.string.begin.yaml' } },
  endCaptures: { 0: { name: 'punctuation.definition.string.end.yaml' } },
  patterns: [
    {
      begin: '\\\\"',
      end: '\\\\"',
      name: 'string.quoted.double.bloblang',
      patterns: [
        { match: '\\\\\\\\.', name: 'constant.character.escape.bloblang' },
      ],
    },
    { match: '\\\\.', name: 'constant.character.escape.yaml' },
    include('source.bloblang.teyfix'),
  ],
};
const yaml = {
  scopeName: 'bloblang.injection.yaml',
  injectionSelector:
    'L:source.yaml -comment -meta.embedded.block.bloblang -meta.embedded.inline.bloblang, L:source.yaml.1.2 -comment -meta.embedded.block.bloblang -meta.embedded.inline.bloblang',
  patterns: [
    {
      begin: `(?<=^([ \t]*)-([ \t]+))((?:["']?${keys}["']?))[ \t]*(:)[ \t]*([|>][+-]?[1-9]?|[|>][1-9][+-]?)[ \t]*(?:#.*)?$`,
      end: '(?<=^[ \t]*)(?<!^\\1[ \t]\\2[ \t]+)(?=\\S)',
      contentName: 'meta.embedded.block.bloblang',
      beginCaptures: {
        3: { name: 'entity.name.tag.yaml' },
        4: { name: 'punctuation.separator.key-value.yaml' },
      },
      patterns: [include('source.bloblang.teyfix')],
    },
    {
      begin: `${keyPrefix}([|>][+-]?[1-9]?|[|>][1-9][+-]?)[ \\t]*(?:#.*)?$`,
      end: '(?<=^[ \\t]*)(?<!^\\1[ \\t]+)(?=\\S)',
      contentName: 'meta.embedded.block.bloblang',
      beginCaptures: {
        ...keyCaptures,
        4: { name: 'punctuation.definition.block.scalar.yaml' },
      },
      patterns: [include('source.bloblang.teyfix')],
    },
    {
      ...yamlSingleQuote,
      begin: `${keyPrefix}(')`,
      beginCaptures: {
        ...keyCaptures,
        4: { name: 'punctuation.definition.string.begin.yaml' },
      },
    },
    {
      ...yamlDoubleQuote,
      begin: `${keyPrefix}(")`,
      beginCaptures: {
        ...keyCaptures,
        4: { name: 'punctuation.definition.string.begin.yaml' },
      },
    },
    {
      begin: `(?<=^([ \t]*)-([ \t]+))((?:["']?${keys}["']?))[ \t]*(:)[ \t]*(?:#.*)?$`,
      end: `(?<=^[ \\t]*)(?=\\S)(?<!^\\1[ \\t]\\2[ \\t]+)|(?<=^[ \\t]*)(?=[^"'#\\s])|(?<=["'])(?=[ \\t]*(?:#|$))`,
      beginCaptures: {
        3: { name: 'entity.name.tag.yaml' },
        4: { name: 'punctuation.separator.key-value.yaml' },
      },
      patterns: [
        { match: '(?<=^[ \\t]*)#.*$', name: 'comment.line.number-sign.yaml' },
        { ...yamlSingleQuote, begin: `(?<=^[ \\t]+)(')` },
        { ...yamlDoubleQuote, begin: `(?<=^[ \\t]+)(")` },
      ],
    },
    {
      // Hold a key-only scalar while its indented value begins on a later line.
      // Lookbehinds cooperate with indentation consumed by the host grammar.
      // Dedentation or a nested YAML collection returns control to the host.
      begin: `${keyPrefix}(?:#.*)?$`,
      end: `(?<=^[ \\t]*)(?=\\S)(?<!^\\1[ \\t]+)|(?<=^[ \\t]*)(?=(?:-[ \\t]+|[A-Za-z_][A-Za-z0-9_-]*[ \\t]*:))`,
      beginCaptures: keyCaptures,
      patterns: [
        { match: '(?<=^[ \\t]*)#.*$', name: 'comment.line.number-sign.yaml' },
        { ...yamlSingleQuote, begin: `(?<=^[ \\t]+)(')` },
        { ...yamlDoubleQuote, begin: `(?<=^[ \\t]+)(")` },
        {
          // A plain YAML scalar can span lines below the key.
          begin: `(?<=^[ \\t]+)(?=[^"\\x27#\\s])`,
          end: '$',
          contentName: 'meta.embedded.inline.bloblang',
          patterns: [include('source.bloblang.teyfix')],
        },
      ],
    },
    {
      begin: `${keyPrefix}(?=\\S)(?![|>"'#{\\[]|(?:true|false|null)[ \\t]*(?:#.*)?$)`,
      end: '$',
      contentName: 'meta.embedded.inline.bloblang',
      beginCaptures: keyCaptures,
      patterns: [include('source.bloblang.teyfix')],
    },
    interpolation,
  ],
  repository: { 'interpolation-content': interpolationContent },
};
const cuePrefix = `(?<![\\w])(${keys})[ \\t]*(:)[ \\t]*`;
const cue = {
  scopeName: 'bloblang.injection.cue',
  injectionSelector:
    'L:source.cue -comment -meta.embedded.block.bloblang -meta.embedded.inline.bloblang',
  patterns: [
    {
      begin: `${cuePrefix}(#{0,})(""")`,
      end: '"""\\3',
      contentName: 'meta.embedded.block.bloblang',
      beginCaptures: {
        1: { name: 'variable.other.property.cue' },
        2: { name: 'punctuation.separator.key-value.cue' },
      },
      patterns: [include('source.bloblang.teyfix')],
    },
    {
      begin: `${cuePrefix}(#+)(")`,
      end: '"\\3',
      contentName: 'meta.embedded.inline.bloblang',
      beginCaptures: {
        1: { name: 'variable.other.property.cue' },
        2: { name: 'punctuation.separator.key-value.cue' },
      },
      patterns: [include('source.bloblang.teyfix')],
    },
    {
      begin: `${cuePrefix}(")`,
      end: '"',
      contentName: 'meta.embedded.inline.bloblang',
      patterns: [
        { match: '\\\\.', name: 'constant.character.escape.cue' },
        include('source.bloblang.teyfix'),
      ],
    },
    interpolation,
  ],
  repository: { 'interpolation-content': interpolationContent },
};
await mkdir('syntaxes', { recursive: true });
for (const [name, grammar] of Object.entries({
  bloblang,
  'bloblang-yaml': yaml,
  'bloblang-cue': cue,
})) {
  await writeFile(
    `syntaxes/${name}.tmLanguage.json`,
    `${JSON.stringify(grammar, null, 2)}\n`,
  );
}
