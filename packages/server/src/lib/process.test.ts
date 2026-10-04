import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProcessError, commandExists, runProcess, runProcessOrThrow, runQuiet, which } from './process.ts';

const NODE = process.execPath;

test('captures stdout, stderr and a zero exit code', async () => {
  const result = await runProcess(NODE, ['-e', 'process.stdout.write("out"); process.stderr.write("err")']);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'out');
  assert.equal(result.stderr, 'err');
  assert.equal(result.timedOut, false);
  assert.equal(result.aborted, false);
  assert.ok(result.durationMs >= 0);
});

test('a non-zero exit is reported, not thrown', async () => {
  const result = await runProcess(NODE, ['-e', 'process.exit(3)']);
  assert.equal(result.code, 3);
});

test('arguments are passed literally, so shell metacharacters are inert', async () => {
  const hostile = '"; rm -rf /; echo $(whoami) && cat /etc/passwd | tee x';
  const result = await runProcess(NODE, ['-e', 'process.stdout.write(process.argv[1])', hostile]);

  assert.equal(result.code, 0);
  assert.equal(result.stdout, hostile, 'the argument must arrive unchanged and unexecuted');
  assert.equal(result.stderr, '');
});

test('stdin can be piped into the child', async () => {
  const result = await runProcess(NODE, ['-e', 'process.stdin.pipe(process.stdout)'], { stdin: 'piped payload' });
  assert.equal(result.stdout, 'piped payload');
});

test('cwd is honored', async () => {
  const result = await runProcess(NODE, ['-e', 'process.stdout.write(process.cwd())'], { cwd: '/tmp' });
  assert.equal(result.stdout.replace(/\/private\/tmp$/, '/tmp'), '/tmp');
});

test('extra environment variables reach the child', async () => {
  const result = await runProcess(NODE, ['-e', 'process.stdout.write(process.env.PLOY_TEST_VAR ?? "unset")'], {
    env: { PLOY_TEST_VAR: 'injected' },
  });
  assert.equal(result.stdout, 'injected');
});

test('streams output chunks as they arrive', async () => {
  const chunks: string[] = [];
  const result = await runProcess(
    NODE,
    ['-e', 'let i=0; const t=setInterval(()=>{ process.stdout.write(`tick${i++}\\n`); if(i===3){clearInterval(t);} }, 10)'],
    { onOutput: (chunk) => chunks.push(chunk) },
  );

  assert.equal(result.code, 0);
  assert.ok(chunks.length > 0, 'onOutput must be called during the run');
  assert.equal(chunks.join(''), result.stdout);
});

test('a hung process is killed when the timeout fires', async () => {
  const result = await runProcess(NODE, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 300 });

  assert.equal(result.timedOut, true);
  assert.notEqual(result.code, 0);
  assert.ok(result.durationMs < 5_000, 'must not wait for the process to finish naturally');
});

test('an abort signal cancels a running process', async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);

  const result = await runProcess(NODE, ['-e', 'setInterval(() => {}, 1000)'], { signal: controller.signal });

  assert.equal(result.aborted, true);
  assert.notEqual(result.code, 0);
});

test('an already-aborted signal never starts the work', async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await runProcess(NODE, ['-e', 'process.stdout.write("should not run")'], { signal: controller.signal });
  assert.equal(result.aborted, true);
  assert.equal(result.stdout, '');
});

test('a missing binary rejects with the spawn error', async () => {
  await assert.rejects(
    () => runProcess('definitely-not-a-real-binary-xyz', []),
    /ENOENT/,
  );
});

test('output beyond the buffer cap is truncated, not accumulated', async () => {
  const result = await runProcess(
    NODE,
    ['-e', 'for (let i = 0; i < 500; i++) process.stdout.write("0123456789")'],
    { maxBuffer: 100 },
  );

  assert.equal(result.code, 0);
  // Exactly the cap is kept however the pipe chunks the writes, then a note with the dropped count.
  assert.equal(result.stdout.split('\n[output truncated')[0]!.length, 100);
  assert.match(result.stdout, /\[output truncated: 4900 characters dropped\]$/);
});

test('runProcessOrThrow resolves on success and throws ProcessError on failure', async () => {
  const ok = await runProcessOrThrow(NODE, ['-e', 'process.stdout.write("fine")']);
  assert.equal(ok.stdout, 'fine');

  await assert.rejects(
    () => runProcessOrThrow(NODE, ['-e', 'process.stderr.write("bad"); process.exit(2)']),
    (error: unknown) => {
      assert.ok(error instanceof ProcessError);
      assert.equal(error.result.code, 2);
      assert.match(error.result.stderr, /bad/);
      assert.match(error.message, /Command failed \(2\)/);
      return true;
    },
  );
});

test('which and commandExists locate real binaries and reject imaginary ones', async () => {
  const nodePath = await which('node');
  assert.ok(nodePath !== null && nodePath.includes('node'));
  assert.equal(await commandExists('node'), true);
  assert.equal(await which('definitely-not-a-real-binary-xyz'), null);
  assert.equal(await commandExists('definitely-not-a-real-binary-xyz'), false);
});

test('runQuiet returns trimmed output or null on failure', async () => {
  assert.equal(await runQuiet(NODE, ['-e', 'process.stdout.write("  spaced  \\n")']), 'spaced');
  assert.equal(await runQuiet(NODE, ['-e', 'process.exit(1)']), null);
});