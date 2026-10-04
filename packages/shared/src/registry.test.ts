import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOCKER_HUB, imageRegistryHost, normalizeRegistryAddress } from './constants.ts';
import { createRegistrySchema, deploymentListQuerySchema, updateRegistrySchema } from './schemas.ts';

test('imageRegistryHost follows Docker: the first component is a host only with a dot, a port or localhost', () => {
  const cases: [string, string][] = [
    ['nginx', DOCKER_HUB],
    ['nginx:1.27-alpine', DOCKER_HUB],
    ['nginx@sha256:' + 'a'.repeat(64), DOCKER_HUB],
    ['bitnami/redis:7', DOCKER_HUB],
    ['library/nginx', DOCKER_HUB],
    ['docker.io/library/nginx', DOCKER_HUB],
    ['index.docker.io/acme/api', DOCKER_HUB],
    ['registry-1.docker.io/acme/api:2', DOCKER_HUB],
    ['ghcr.io/acme/api:1.0', 'ghcr.io'],
    ['registry.gitlab.com/group/sub/app', 'registry.gitlab.com'],
    ['registry.example.uz:5000/team/app:latest', 'registry.example.uz:5000'],
    ['localhost/app', 'localhost'],
    ['localhost:5000/app', 'localhost:5000'],
    ['myregistry:5000/app', 'myregistry:5000'],
    ['10.0.0.5:5000/app', '10.0.0.5:5000'],
    ['Registry/app', 'registry'],
    ['acme/team/app', DOCKER_HUB],
  ];
  for (const [image, host] of cases) assert.equal(imageRegistryHost(image), host, image);
});

test('registry addresses are normalized the way Docker names them', () => {
  assert.equal(normalizeRegistryAddress('https://GHCR.io/'), 'ghcr.io');
  assert.equal(normalizeRegistryAddress('http://registry.example.uz:5000'), 'registry.example.uz:5000');
  assert.equal(normalizeRegistryAddress('https://index.docker.io/v1/'), DOCKER_HUB);
  assert.equal(normalizeRegistryAddress('hub.docker.com'), DOCKER_HUB);
  assert.equal(normalizeRegistryAddress('registry-1.docker.io'), DOCKER_HUB);
  assert.equal(normalizeRegistryAddress(' docker.io '), DOCKER_HUB);
});

test('createRegistrySchema accepts hosts an image can name and rejects the rest', () => {
  const base = { name: 'GitHub', username: 'robot', password: 'ghp_token' };
  assert.equal(createRegistrySchema.parse({ ...base, serverAddress: 'https://ghcr.io/' }).serverAddress, 'ghcr.io');
  assert.equal(createRegistrySchema.parse({ ...base, serverAddress: 'index.docker.io' }).serverAddress, 'docker.io');
  assert.equal(createRegistrySchema.parse({ ...base, serverAddress: 'Registry.Example.uz:5000' }).serverAddress, 'registry.example.uz:5000');
  assert.equal(createRegistrySchema.parse({ ...base, serverAddress: 'localhost:5000' }).serverAddress, 'localhost:5000');
  for (const serverAddress of ['', 'myregistry', 'ghcr.io/acme', 'ftp://ghcr.io', 'reg istry.io', 'ghcr.io:port']) {
    assert.equal(createRegistrySchema.safeParse({ ...base, serverAddress }).success, false, serverAddress);
  }
  assert.equal(createRegistrySchema.safeParse({ ...base, serverAddress: 'ghcr.io', username: ' ' }).success, false);
  assert.equal(createRegistrySchema.safeParse({ ...base, serverAddress: 'ghcr.io', password: '' }).success, false);
  assert.deepEqual(updateRegistrySchema.parse({ name: 'Renamed' }), { name: 'Renamed' }, 'an omitted password keeps the stored one');
});

test('the deployment list filter takes a status or "active"', () => {
  assert.deepEqual(deploymentListQuerySchema.parse({}), { limit: 30 });
  assert.equal(deploymentListQuerySchema.parse({ status: 'active', limit: '5' }).limit, 5);
  assert.equal(deploymentListQuerySchema.parse({ status: 'failed' }).status, 'failed');
  assert.equal(deploymentListQuerySchema.parse({ status: '' }).status, undefined, 'an empty filter means all');
  assert.equal(deploymentListQuerySchema.safeParse({ status: 'running' }).success, false);
});
