import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SERVICE_TYPES } from '@ploy/shared';
import { CATALOG, catalogEntry, linkEnv, STORAGE_ROOT_ACTIONS, storageIdentityFile } from './catalog.ts';

test('every service type has a catalog entry whose default version is offered', () => {
  for (const type of SERVICE_TYPES) {
    const entry = catalogEntry(type);
    assert.equal(entry.type, type);
    assert.ok(entry.versions.includes(entry.defaultVersion), `${type} offers its default version`);
    const credentials = entry.credentials();
    const template = entry.container(entry.defaultVersion, credentials);
    assert.match(template.image, /^[a-z0-9./-]+:[A-Za-z0-9._-]+$/, `${type} pins an image tag`);
    assert.ok(template.healthcheck.length > 0);
  }
});

test('the file store runs SeaweedFS with the S3 gateway exposed and everything else on loopback, identities seeded from a file', () => {
  const entry = CATALOG.files;
  assert.deepEqual([entry.label, entry.port, entry.memoryMb, entry.versions, entry.defaultVersion, entry.backup], ['File store (S3)', 8333, 512, ['4.48'], '4.48', null]);
  const credentials = entry.credentials();
  assert.match(credentials.username ?? '', /^ploy[a-z0-9]{12}$/, 'the root access key id');
  assert.equal(credentials.password.length, 40, 'the secret has the length of an AWS secret key');
  assert.equal(credentials.database, null);

  const template = entry.container('4.48', credentials);
  assert.equal(template.image, 'chrislusf/seaweedfs:4.48');
  assert.deepEqual(template.entrypoint, ['/usr/bin/weed']);
  assert.equal(template.mountPath, '/data');
  const cmd = template.cmd ?? [];
  assert.equal(cmd[0], 'server');
  for (const flag of ['-dir=/data', '-ip=127.0.0.1', '-ip.bind=127.0.0.1', '-s3.ip.bind=0.0.0.0', '-master.volumeSizeLimitMB=1024', '-volume.max=0', '-filer', '-s3', '-s3.port=8333', '-s3.port.iceberg=0', '-s3.port.lance=0', '-s3.allowDeleteBucketNotEmpty=false', '-s3.autoCreateBucket=false', '-s3.config=/data/s3.json', '-metricsPort=9327']) {
    assert.ok(cmd.includes(flag), `weed server gets ${flag}`);
  }
  assert.ok(!cmd.join(' ').includes(credentials.password), 'the secret is not on the command line');
  assert.deepEqual(Object.keys(template.env), [], 'nothing secret in the environment either');
  assert.deepEqual(template.healthcheck, ['sh', '-c', 'wget -qO- http://127.0.0.1:9333/cluster/status']);

  const seeds = template.files ?? [];
  const identity = seeds.find((file) => file.name === 's3.json');
  assert.ok(identity);
  assert.equal(identity.dir, '/data');
  assert.equal(identity.mode, 0o600);
  assert.deepEqual(JSON.parse(identity.content), { identities: [{ name: 'root', credentials: [{ accessKey: credentials.username, secretKey: credentials.password }], actions: STORAGE_ROOT_ACTIONS }] });
  assert.equal(identity.content, storageIdentityFile(credentials));
  const master = seeds.find((file) => file.name === 'master.toml');
  assert.ok(master);
  assert.equal(master.dir, '/etc/seaweedfs');
  assert.match(master.content, /\[master\.volume_growth\]\ncopy_1 = 1/);

  // What a linked application receives: the in-network S3 address with both naming conventions.
  const env = linkEnv(entry, credentials, 'files', 8333, 'MEDIA_');
  assert.equal(env.MEDIA_S3_ENDPOINT, 'http://files:8333');
  assert.equal(env.MEDIA_AWS_ENDPOINT_URL, 'http://files:8333');
  assert.equal(env.MEDIA_S3_ACCESS_KEY_ID, credentials.username);
  assert.equal(env.MEDIA_AWS_SECRET_ACCESS_KEY, credentials.password);
  assert.deepEqual([env.MEDIA_S3_REGION, env.MEDIA_AWS_REGION, env.MEDIA_S3_FORCE_PATH_STYLE, env.MEDIA_S3_BUCKET], ['us-east-1', 'us-east-1', 'true', '']);
  assert.equal(entry.connection(credentials, 'files', 8333).url, 'http://files:8333');
});
