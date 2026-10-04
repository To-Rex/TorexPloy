import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { AppError } from '../lib/errors.ts';
import { composeServices, serviceAlias, transformCompose } from './transform.ts';

const base = { projectNetwork: 'ploy-net-abc', aliasPrefix: 'shop', labels: { 'ploy.managed': 'true', 'ploy.app': 'app_1' } };

type Service = { networks?: Record<string, { aliases?: string[] } | null>; labels?: Record<string, string>; restart?: string; logging?: unknown; image?: string; environment?: unknown };

test('services join the project network under stable aliases and keep their default network', () => {
  const source = `
x-env: &env
  TZ: Asia/Tashkent
services:
  web:
    image: nginx:alpine
    environment: *env
    labels: ["traefik.enable=false"]
  worker:
    build: ./worker
    networks: [backend]
    restart: always
  db:
    image: postgres:17-alpine
    networks:
      backend:
        aliases: [database]
networks:
  backend: {}
`;
  const result = transformCompose({ ...base, source });
  const doc = parse(result.yaml) as { services: Record<string, Service>; networks: Record<string, unknown> };
  assert.deepEqual(Object.keys(doc.networks).sort(), ['backend', 'torexploy_project']);
  assert.deepEqual(doc.networks.torexploy_project, { name: 'ploy-net-abc', external: true });

  assert.deepEqual(doc.services.web!.networks, { default: null, torexploy_project: { aliases: ['shop-web'] } }, 'default stays so services still reach each other');
  assert.deepEqual(doc.services.worker!.networks, { backend: null, torexploy_project: { aliases: ['shop-worker'] } });
  assert.deepEqual(doc.services.db!.networks, { backend: { aliases: ['database'] }, torexploy_project: { aliases: ['shop-db'] } });

  assert.deepEqual(doc.services.web!.labels, { 'traefik.enable': 'false', 'ploy.managed': 'true', 'ploy.app': 'app_1' });
  assert.equal(doc.services.web!.restart, 'unless-stopped');
  assert.equal(doc.services.worker!.restart, 'always', 'an explicit policy is kept');
  assert.deepEqual(doc.services.web!.logging, { driver: 'json-file', options: { 'max-size': '20m', 'max-file': '5' } });
  assert.deepEqual(doc.services.web!.environment, { TZ: 'Asia/Tashkent' }, 'anchors are resolved');

  assert.deepEqual(result.services.map((service) => [service.name, service.alias, service.build]), [
    ['web', 'shop-web', false],
    ['worker', 'shop-worker', true],
    ['db', 'shop-db', false],
  ]);
  assert.deepEqual(result.hostAccess, []);
  assert.equal(result.relativeBinds, false);
});

test('merge keys and ${VARIABLES} survive the rewrite untouched', () => {
  const source = `
x-common: &common
  restart: on-failure
  environment:
    DATABASE_URL: \${DATABASE_URL}
services:
  api:
    <<: *common
    image: ghcr.io/acme/api:\${TAG:-latest}
    ports: ["8080:80", "127.0.0.1:9000:9000", "3000"]
`;
  const result = transformCompose({ ...base, source });
  const api = (parse(result.yaml) as { services: Record<string, Service & { restart: string }> }).services.api!;
  assert.equal(api.image, 'ghcr.io/acme/api:${TAG:-latest}');
  assert.deepEqual(api.environment, { DATABASE_URL: '${DATABASE_URL}' });
  assert.equal(api.restart, 'on-failure', 'merged settings count as the service own');
  assert.deepEqual(result.services[0]!.publishedPorts, [8080, 9000]);
});

test('host-reaching features are reported; relative binds are flagged for remote sync', () => {
  const source = `
services:
  agent:
    image: portainer/agent
    privileged: true
    network_mode: host
    cap_add: [NET_ADMIN, CHOWN]
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./config:/config:ro
      - data:/data
      - type: bind
        source: /etc
        target: /host-etc
    security_opt: ["seccomp:unconfined"]
    devices: ["/dev/fuse"]
volumes:
  data: {}
`;
  const result = transformCompose({ ...base, source });
  assert.deepEqual(result.hostAccess, [
    'agent: privileged',
    'agent: network_mode: host',
    'agent: cap_add NET_ADMIN',
    'agent: devices',
    'agent: security_opt seccomp:unconfined',
    'agent: mounts /var/run/docker.sock',
    'agent: mounts /etc',
  ]);
  assert.equal(result.relativeBinds, true);
  const agent = (parse(result.yaml) as { services: Record<string, Service> }).services.agent!;
  assert.equal(agent.networks, undefined, 'network_mode services cannot join networks');
});

test('invalid files are rejected with a reason the dashboard can show', () => {
  const reject = (source: string, pattern: RegExp, reason = 'compose_invalid') =>
    assert.throws(
      () => transformCompose({ ...base, source }),
      (error: unknown) => error instanceof AppError && pattern.test(error.message) && error.issues?.[0]?.params?.reason === reason,
    );
  reject('services: [', /not valid YAML/);
  reject('- a\n- b', /must be a mapping/);
  reject('services: {}', /defines no services/);
  reject('services:\n  "bad name":\n    image: x', /not valid/);
  reject('services:\n  web:\n    environment: {A: 1}', /needs an image or a build/);
  reject('services:\n  web:\n    image: nginx\n    ports: ["80:80"]', /port 80/, 'compose_port_reserved');
  reject('services:\n  web:\n    image: nginx\n    ports: [{target: 443, published: "443"}]', /port 443/, 'compose_port_reserved');
});

test('aliases are DNS-safe and service names can be listed without rewriting', () => {
  assert.equal(serviceAlias('My_App', 'Web.Front'), 'my-app-web-front');
  assert.equal(serviceAlias('a'.repeat(60), 'service').length, 63);
  assert.deepEqual(composeServices('services:\n  web: {image: x}\n  db: {image: y}'), ['web', 'db']);
  assert.deepEqual(composeServices(':::'), []);
});
