import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDotenv } from './dotenv.ts';
import { updateApplicationSchema } from './schemas.ts';

test('parseDotenv reads pasted .env text: export, quotes, comments, last value wins', () => {
  const text = [
    '# shared by every preview',
    'export API_URL=https://api.example.uz',
    'GREETING="hello\\nworld"',
    "QUOTED='kept # as is'",
    'PLAIN=value # trailing comment',
    '',
    'EMPTY=',
    'API_URL=https://staging.example.uz',
  ].join('\r\n');
  assert.deepEqual(parseDotenv(text), {
    variables: [
      { key: 'GREETING', value: 'hello\nworld' },
      { key: 'QUOTED', value: 'kept # as is' },
      { key: 'PLAIN', value: 'value' },
      { key: 'EMPTY', value: '' },
      { key: 'API_URL', value: 'https://staging.example.uz' },
    ],
    badLine: null,
  });
  assert.equal(parseDotenv('A=1\njust words\nB=2').badLine, 2);
  assert.equal(parseDotenv('1ST=x').badLine, 1, 'keys follow the variable name rules');
  assert.deepEqual(parseDotenv(''), { variables: [], badLine: null });
});

test('preview settings validate as part of an application update', () => {
  assert.ok(updateApplicationSchema.safeParse({ previewsEnabled: true, previewLimit: 20, previewEnv: '' }).success);
  const bad = updateApplicationSchema.safeParse({ previewEnv: 'A=1\noops' });
  assert.equal(bad.success, false);
  assert.deepEqual(bad.error?.issues.map((issue) => issue.path.join('.')), ['previewEnv']);
  assert.equal(updateApplicationSchema.safeParse({ previewLimit: 21 }).success, false);
  assert.equal(updateApplicationSchema.safeParse({ previewEnv: 'A='.padEnd(32 * 1024 + 1, 'x') }).success, false);
});
