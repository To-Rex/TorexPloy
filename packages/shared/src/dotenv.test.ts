import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDotenv, mergeDotenv, parseDotenv, sameVariables, toDotenv } from './dotenv.ts';
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

test('toDotenv writes values that read back unchanged, whatever they contain', () => {
  const variables = [
    { key: 'PLAIN', value: 'value' },
    { key: 'URL', value: 'postgres://user:p%40ss@db:5432/app?sslmode=disable' },
    { key: 'EMPTY', value: '' },
    { key: 'SPACED', value: 'hello world' },
    { key: 'HASH', value: 'colour #fff' },
    { key: 'WINDOWS', value: 'C:\\dir\\new' },
    { key: 'REGEX', value: '^\\d+\\s"quoted"$' },
    { key: 'APOSTROPHE', value: "it's here" },
    { key: 'BOTH', value: `she said "it's"` },
    { key: 'LINES', value: '-----BEGIN KEY-----\nabc\\ndef\n-----END KEY-----' },
    { key: 'TABS', value: 'a\tb\r\nc' },
    { key: 'QUOTED', value: '"already"' },
    { key: 'SINGLE', value: "'already'" },
    { key: 'EDGES', value: '  padded  ' },
    { key: 'TRAILING', value: 'ends with \\' },
  ];
  const text = toDotenv(variables);
  assert.deepEqual(parseDotenv(text), { variables, badLine: null });
  assert.equal(text.split('\n').length, variables.length, 'one line each');
  // The common cases stay as people write them.
  assert.equal(toDotenv([{ key: 'A', value: 'b' }, { key: 'C', value: 'd e' }, { key: 'E', value: '' }]), "A=b\nC='d e'\nE=\"\"");
  // A quoted value may be followed by a comment; the quotes are not part of the value.
  assert.deepEqual(parseDotenv(`A="one two" # why\nB='three'   # because\nC="say \\"hi\\" # not a comment"`).variables, [
    { key: 'A', value: 'one two' },
    { key: 'B', value: 'three' },
    { key: 'C', value: 'say "hi" # not a comment' },
  ]);
  // Escapes in double quotes; an unknown one keeps its backslash.
  assert.deepEqual(parseDotenv('A="one\\ttwo\\\\three \\d"').variables, [{ key: 'A', value: 'one\ttwo\\three \\d' }]);
});

test('analyzeDotenv tells comments, switched-off variables, overridden and broken lines apart', () => {
  const text = ['# Database', 'DATABASE_URL=postgres://db', '', '# DEBUG=1', '#export TRACE = yes', 'PORT=3000', 'not a variable', 'PORT=8080', '#just=words here'].join('\n');
  const result = analyzeDotenv(text);
  assert.deepEqual(result.lines.map((line) => line.kind), ['comment', 'assign', 'blank', 'disabled', 'disabled', 'assign', 'bad', 'assign', 'disabled']);
  assert.deepEqual(result.lines.map((line) => line.key), [null, 'DATABASE_URL', null, 'DEBUG', 'TRACE', 'PORT', null, 'PORT', 'just']);
  assert.deepEqual(result.lines.map((line) => line.shadowed), [false, false, false, false, false, true, false, false, false]);
  assert.deepEqual([result.variables, result.comments, result.disabled, result.badLine], [2, 1, 3, 7]);
  assert.deepEqual(analyzeDotenv(''), { lines: [{ kind: 'blank', key: null, shadowed: false }], variables: 0, comments: 0, disabled: 0, badLine: null });
});

test('mergeDotenv updates the text and keeps what else it says', () => {
  const text = ['# Database', 'export DATABASE_URL="postgres://db"   # primary', '', '# DEBUG=1', 'PORT=3000', 'PORT = 8080', 'OLD=gone', ''].join('\n');
  const variables = [
    { key: 'DATABASE_URL', value: 'postgres://db' },
    { key: 'PORT', value: '9090' },
    { key: 'NEW', value: 'a b' },
  ];
  const merged = mergeDotenv(text, variables);
  assert.equal(merged, ['# Database', 'export DATABASE_URL="postgres://db"   # primary', '', '# DEBUG=1', 'PORT=9090', "NEW='a b'"].join('\n'));
  assert.ok(sameVariables(parseDotenv(merged).variables, variables));
  // Nothing to change: the text comes back as it was, formatting and all.
  const untouched = ['# note', 'A = 1', "B='two'  # why", '', '# C=3'].join('\n');
  assert.equal(mergeDotenv(untouched, [{ key: 'A', value: '1' }, { key: 'B', value: 'two' }]), untouched);
  // An `export` survives a changed value; a text with no variables left keeps its comments.
  assert.equal(mergeDotenv('export A=1', [{ key: 'A', value: '2' }]), 'export A=2');
  assert.equal(mergeDotenv('# only a note\nA=1', []), '# only a note');
  assert.equal(mergeDotenv('', [{ key: 'A', value: '1' }]), 'A=1');
  // The text's own order wins over the list's.
  const reordered = mergeDotenv('A=1\nB=2', [{ key: 'B', value: '2' }, { key: 'A', value: '1' }]);
  assert.deepEqual(parseDotenv(reordered).variables.map((variable) => variable.key), ['A', 'B']);
  assert.equal(sameVariables([{ key: 'A', value: '1' }], [{ key: 'A', value: '2' }]), false);
});
