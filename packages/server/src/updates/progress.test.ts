/** Progress markers: written by the updater, read back by the control plane. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStepFraction, formatProgress, latestProgress, parseProgress, stagePercent, stripTimestamps } from './progress.ts';

test('a marker survives the round trip through the log, under any number of timestamp prefixes', () => {
  const line = formatProgress({ stage: 'build', percent: 42, message: '#7 [stage-1 3/9] RUN npm ci' });
  assert.equal(line, '::progress {"stage":"build","percent":42,"message":"#7 [stage-1 3/9] RUN npm ci"}');
  assert.deepEqual(parseProgress(line), { stage: 'build', percent: 42, message: '#7 [stage-1 3/9] RUN npm ci' });
  assert.deepEqual(parseProgress(`2026-10-05T10:00:20.123Z 2026-10-05T10:00:20.000Z ${line}`), { stage: 'build', percent: 42, message: '#7 [stage-1 3/9] RUN npm ci' });
  assert.equal(stripTimestamps('2026-10-05T10:00:20.123Z 2026-10-05T10:00:20Z hello'), 'hello');
  assert.equal(parseProgress('2026-10-05T10:00:20.123Z   #7 DONE 0.4s'), null);
  assert.equal(parseProgress('::progress not json'), null);
  assert.equal(parseProgress('::progress {"stage":"nope","percent":5}'), null, 'unknown stages are ignored');
  assert.deepEqual(parseProgress('::progress {"stage":"health","percent":140}'), { stage: 'health', percent: 100, message: '' }, 'percent is clamped and the message optional');
});

test('the latest marker wins and BuildKit steps move the bar within the build stage', () => {
  const text = [formatProgress({ stage: 'fetch', percent: 1, message: 'Cloning' }), 'plain line', formatProgress({ stage: 'build', percent: 30, message: 'RUN' }), '  #9 [stage-1 5/9] COPY . .'].join('\n');
  assert.deepEqual(latestProgress(text), { stage: 'build', percent: 30, message: 'RUN' });
  assert.equal(latestProgress('nothing here'), null);
  assert.equal(buildStepFraction('#7 [stage-1 3/9] RUN npm ci'), 1 / 3);
  assert.equal(buildStepFraction('#3 [5/8] RUN apk add git'), 5 / 8);
  assert.equal(buildStepFraction('#7 DONE 0.4s'), null);
  assert.equal(buildStepFraction('#2 [internal] load .dockerignore'), null);
  assert.equal(stagePercent('build', 0), 10);
  assert.equal(stagePercent('build', 0.5), 45);
  assert.equal(stagePercent('replace', 0.5), 86);
  assert.equal(stagePercent('health', 0), 92);
  assert.equal(stagePercent('done', 1), 100);
});
