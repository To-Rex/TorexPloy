/**
 * SSH credentials: pasted keys are normalized (passphrase stripped, public key
 * derived), password sessions hand the secret to ssh through an askpass helper,
 * and the authorized_keys installer is idempotent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../lib/logger.ts';
import { runProcess } from '../lib/process.ts';
import { describeSshFailure, importPrivateKey, INSTALL_KEY_COMMAND, sshFailureReason, SshKeyError, SshSession } from './ssh.ts';

const logger = createLogger({ level: 'error', json: true, write: () => {} });

async function keygen(dir: string, name: string, args: string[]): Promise<{ privateKey: string; publicKey: string }> {
  const path = join(dir, name);
  const result = await runProcess('ssh-keygen', ['-q', '-f', path, ...args], { timeoutMs: 30_000 });
  assert.equal(result.code, 0, result.stderr);
  return { privateKey: readFileSync(path, 'utf8'), publicKey: readFileSync(`${path}.pub`, 'utf8').trim() };
}

/** "ssh-ed25519 AAAA… comment" → "ssh-ed25519 AAAA…": comments differ between tools. */
const keyBody = (publicKey: string): string => publicKey.split(/\s+/).slice(0, 2).join(' ');

test('importPrivateKey takes OpenSSH and PEM keys, unlocks a passphrase and refuses what it cannot read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ploy-ssh-'));
  process.env.PLOY_RUN_DIR = join(dir, 'run');
  try {
    const plain = await keygen(dir, 'ed', ['-t', 'ed25519', '-N', '', '-C', 'me@laptop']);
    const imported = await importPrivateKey(plain.privateKey, undefined);
    assert.equal(keyBody(imported.publicKey), keyBody(plain.publicKey));
    assert.ok(imported.privateKey.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----'));
    // Pasted from Windows, or without the final newline: still the same key.
    assert.equal(keyBody((await importPrivateKey(plain.privateKey.trim().replace(/\n/g, '\r\n'), undefined)).publicKey), keyBody(plain.publicKey));

    const pem = await keygen(dir, 'rsa', ['-t', 'rsa', '-b', '2048', '-m', 'PEM', '-N', '']);
    assert.ok(pem.privateKey.startsWith('-----BEGIN RSA PRIVATE KEY-----'));
    assert.equal(keyBody((await importPrivateKey(pem.privateKey, undefined)).publicKey), keyBody(pem.publicKey));

    const locked = await keygen(dir, 'locked', ['-t', 'ed25519', '-N', 'hunter2']);
    const unlocked = await importPrivateKey(locked.privateKey, 'hunter2');
    assert.equal(keyBody(unlocked.publicKey), keyBody(locked.publicKey));
    // The stored copy has no passphrase: it imports again without one.
    assert.equal(keyBody((await importPrivateKey(unlocked.privateKey, undefined)).publicKey), keyBody(locked.publicKey));

    await assert.rejects(importPrivateKey(locked.privateKey, 'wrong'), (error: unknown) => error instanceof SshKeyError && error.reason === 'ssh_key_passphrase');
    await assert.rejects(importPrivateKey(locked.privateKey, undefined), (error: unknown) => error instanceof SshKeyError && error.reason === 'ssh_key_passphrase');
    await assert.rejects(importPrivateKey('not a key at all', undefined), (error: unknown) => error instanceof SshKeyError && error.reason === 'ssh_key_invalid');
    await assert.rejects(importPrivateKey(plain.publicKey, undefined), (error: unknown) => error instanceof SshKeyError && error.reason === 'ssh_key_invalid');
    assert.deepEqual(
      (await runProcess('ls', [join(dir, 'run')])).stdout.trim().split('\n').filter((entry) => entry.startsWith('import-')),
      [],
      'scratch directories are removed',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a password session authenticates through askpass and never writes a key; a key session is batch-only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ploy-ssh-'));
  process.env.PLOY_RUN_DIR = join(dir, 'run');
  try {
    const target = { serverId: 'srv_password_test', host: 'example.test', port: 2222, username: 'deploy', hostKey: null };
    const password = new SshSession({ ...target, auth: { kind: 'password', password: 'correct horse battery' } }, logger);
    const args = password.args();
    assert.ok(!args.includes('-i'));
    assert.ok(args.includes('PubkeyAuthentication=no') && args.includes('BatchMode=no') && args.includes('NumberOfPasswordPrompts=1'));
    assert.ok(args.includes('deploy@example.test') && args.includes('2222'));
    assert.ok(!existsSync(password.keyPath));
    const env = password.env();
    assert.equal(env.SSH_ASKPASS_REQUIRE, 'force');
    assert.equal(statSync(env.SSH_ASKPASS!).mode & 0o777, 0o700);
    const answer = await runProcess(env.SSH_ASKPASS!, ['Password:'], { env });
    assert.equal(answer.stdout, 'correct horse battery\n', 'the helper prints the secret from its environment');
    assert.ok(!readFileSync(env.SSH_ASKPASS!, 'utf8').includes('correct horse'), 'the secret is not written to disk');
    password.dispose();
    assert.ok(!existsSync(env.SSH_ASKPASS!));

    const key = new SshSession({ ...target, serverId: 'srv_key_test', auth: { kind: 'key', privateKey: 'PRIVATE' } }, logger);
    const keyArgs = key.args();
    assert.ok(keyArgs.includes('-i') && keyArgs.includes('BatchMode=yes') && keyArgs.includes('PasswordAuthentication=no'));
    assert.equal(readFileSync(key.keyPath, 'utf8'), 'PRIVATE\n');
    assert.equal(statSync(key.keyPath).mode & 0o777, 0o600);
    assert.deepEqual(key.env(), {});
    key.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a refused password session tells a wrong password from a server that takes no passwords at all', () => {
  const denied = (methods: string) => ({ code: 255, signal: null, stdout: '', stderr: `root@example.test: Permission denied (${methods}).\n`, timedOut: false, aborted: false, durationMs: 1 });
  assert.equal(sshFailureReason(denied('publickey,password'), 'password'), 'ssh_auth');
  assert.equal(sshFailureReason(denied('publickey,keyboard-interactive'), 'password'), 'ssh_auth');
  assert.equal(sshFailureReason(denied('publickey'), 'password'), 'ssh_password_disabled');
  assert.equal(sshFailureReason(denied('publickey'), 'key'), 'ssh_auth');
  assert.equal(sshFailureReason(denied('publickey')), 'ssh_auth');
  assert.match(describeSshFailure(denied('publickey'), 'password'), /does not accept passwords/);
  assert.match(describeSshFailure(denied('publickey,password'), 'password'), /rejected the password/);
  assert.match(describeSshFailure(denied('publickey')), /authorized_keys/);
});

test('the authorized_keys installer creates ~/.ssh with strict modes and adds a key once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ploy-ssh-'));
  try {
    const home = join(dir, 'home');
    const install = (key: string) => runProcess('sh', ['-c', INSTALL_KEY_COMMAND], { env: { HOME: home }, stdin: `${key}\n` });
    assert.equal((await install('ssh-ed25519 AAAAC3 panel')).code, 0);
    assert.equal((await install('ssh-ed25519 AAAAC3 panel')).code, 0);
    assert.equal((await install('ssh-ed25519 AAAAC3other second')).code, 0);
    assert.equal(readFileSync(join(home, '.ssh', 'authorized_keys'), 'utf8'), 'ssh-ed25519 AAAAC3 panel\nssh-ed25519 AAAAC3other second\n');
    assert.equal(statSync(join(home, '.ssh')).mode & 0o777, 0o700);
    assert.equal(statSync(join(home, '.ssh', 'authorized_keys')).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
