import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

const schema = JSON.parse(
  await readFile('schemas/bloblangrc.schema.json', 'utf8'),
);
const manifest = JSON.parse(await readFile('package.json', 'utf8'));

test('bundled configuration schema associates automatically and completes flat namespaced rules', () => {
  expect(manifest.contributes.jsonValidation).toEqual([
    {
      fileMatch: ['**/.bloblangrc.json'],
      url: './schemas/bloblangrc.schema.json',
    },
  ]);
  expect(schema.properties.formatter.properties.printWidth.default).toBe(80);
  expect(schema.properties.preview.properties.format.default).toBe('yaml');
  expect(schema.properties.preview.properties.format.enum).toEqual([
    'yaml',
    'json',
  ]);
  const rules = schema.properties.lint.properties.rules;
  expect(rules.additionalProperties).toBe(false);
  expect(Object.keys(rules.properties).sort()).toEqual([
    'correctness/environment/require-fallback',
    'correctness/variables/no-unused-let',
    'style/arrays/prefer-any',
    'style/assignments/prefer-grouped',
    'style/objects/combine-without',
    'style/objects/prefer-with',
    'style/objects/prefer-without',
  ]);
  expect(
    rules.properties['style/assignments/prefer-grouped'].oneOf[1].properties
      .minAssignments.default,
  ).toBe(3);
  for (const rule of Object.values(rules.properties) as {
    oneOf: { enum?: string[]; additionalProperties?: boolean }[];
  }[]) {
    expect(rule.oneOf[0]?.enum).toEqual([
      'off',
      'hint',
      'info',
      'warn',
      'error',
    ]);
    expect(rule.oneOf[1]?.additionalProperties).toBe(false);
  }
});
