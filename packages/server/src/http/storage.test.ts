/**
 * The file store through the real HTTP stack: overview, buckets, objects,
 * presigned links, access keys, the backup destination inside the store and
 * the store's own domains — with roles, validation and error mapping.
 *
 * The engine is a small in-memory S3 server plus an Engine API double whose
 * `exec` plays `weed shell` (identities, usage); with `PLOY_TEST_WEED` set the
 * same scenario runs against a real SeaweedFS, where the shell commands are
 * fed to the real `weed shell` instead.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HttpBindings } from '@hono/node-server';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  API_TOKEN_PREFIX,
  type ApiErrorBody,
  type DomainDto,
  type PlatformEvent,
  type S3DestinationDto,
  type ServiceDto,
  type StorageBucketDto,
  type StorageKeyCreatedDto,
  type StorageKeyDto,
  type StorageListingDto,
  type StorageObjectDto,
  type StorageOverviewDto,
} from '@ploy/shared';
import { resolveAppEnv } from '../deploy/env.ts';
import { generateToken } from '../lib/crypto.ts';
import { S3Client, S3Error } from '../lib/s3.ts';
import { createContext } from '../main.ts';
import type { ServiceRecord } from '../store/index.ts';
import { createHttpApp } from './app.ts';

const BINDINGS = { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as unknown as HttpBindings;
const ROOT_KEY = 'ployrootkey00001';
const ROOT_SECRET = 'rootsecret0123456789abcdefghijklmnopqrstuv';

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!);
}
function unescapeXml(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[name]!);
}

interface FakeObject {
  body: Buffer;
  contentType: string;
  lastModified: string;
  etag: string;
}

/** An in-memory S3 server: buckets, objects, ListObjectsV2 with folders and pages, multi-delete, ranges; access keys it has been told about. */
class FakeS3 {
  readonly buckets = new Map<string, Map<string, FakeObject>>();
  readonly accessKeys = new Set<string>([ROOT_KEY]);
  readonly requests: string[] = [];

  handle(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url ?? '/', 'http://s3');
      const method = req.method ?? 'GET';
      this.requests.push(`${method} ${url.pathname}${url.search}`);
      const xml = (status: number, text: string): void => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/xml');
        res.end(`<?xml version="1.0" encoding="UTF-8"?>\n${text}`);
      };
      const fail = (status: number, code: string, message: string): void => xml(status, `<Error><Code>${code}</Code><Message>${message}</Message></Error>`);
      const credential = /Credential=([^/]+)\//.exec(req.headers.authorization ?? '')?.[1] ?? url.searchParams.get('X-Amz-Credential')?.split('/')[0];
      if (credential === undefined || !this.accessKeys.has(credential)) return fail(403, 'AccessDenied', 'Access Denied');
      const [, bucketName = '', ...rest] = url.pathname.split('/');
      const key = decodeURIComponent(rest.join('/'));
      if (bucketName === '') {
        return xml(200, `<ListAllMyBucketsResult><Owner><ID>root</ID></Owner><Buckets>${[...this.buckets.keys()].sort().map((name) => `<Bucket><Name>${name}</Name><CreationDate>2026-01-01T00:00:00Z</CreationDate></Bucket>`).join('')}</Buckets></ListAllMyBucketsResult>`);
      }
      const bucket = this.buckets.get(bucketName);
      if (key.length === 0) {
        if (method === 'PUT') {
          if (bucket !== undefined) return fail(409, 'BucketAlreadyOwnedByYou', 'Your previous request to create the named bucket succeeded and you already own it.');
          this.buckets.set(bucketName, new Map());
          res.statusCode = 200;
          return res.end();
        }
        if (bucket === undefined) return fail(404, 'NoSuchBucket', 'The specified bucket does not exist');
        if (method === 'HEAD') {
          res.statusCode = 200;
          return res.end();
        }
        if (method === 'DELETE') {
          if (bucket.size > 0) return fail(409, 'BucketNotEmpty', 'The bucket you tried to delete is not empty');
          this.buckets.delete(bucketName);
          res.statusCode = 204;
          return res.end();
        }
        if (method === 'POST' && url.searchParams.has('delete')) {
          const keys = [...body.toString('utf8').matchAll(/<Key>([^<]*)<\/Key>/g)].map((match) => unescapeXml(match[1]!));
          for (const item of keys) bucket.delete(item);
          return xml(200, `<DeleteResult>${keys.map((item) => `<Deleted><Key>${escapeXml(item)}</Key></Deleted>`).join('')}</DeleteResult>`);
        }
        if (method === 'GET') {
          const prefix = url.searchParams.get('prefix') ?? '';
          const delimiter = url.searchParams.get('delimiter') ?? '';
          const maxKeys = Number(url.searchParams.get('max-keys') ?? 1000);
          const after = url.searchParams.get('continuation-token') ?? '';
          const keys = [...bucket.keys()].filter((item) => item.startsWith(prefix) && item > after).sort();
          const prefixes: string[] = [];
          const contents: string[] = [];
          let count = 0;
          let truncated = false;
          let last = '';
          for (const item of keys) {
            if (count >= maxKeys) {
              truncated = true;
              break;
            }
            const tail = item.slice(prefix.length);
            const slash = delimiter.length > 0 ? tail.indexOf(delimiter) : -1;
            if (slash !== -1) {
              const common = prefix + tail.slice(0, slash + 1);
              if (prefixes.at(-1) !== common) {
                prefixes.push(common);
                count += 1;
              }
              last = `${common}\u{10FFFF}`;
              continue;
            }
            const object = bucket.get(item)!;
            contents.push(`<Contents><Key>${escapeXml(item)}</Key><ETag>&#34;${object.etag}&#34;</ETag><Size>${object.body.length}</Size><LastModified>${object.lastModified}</LastModified></Contents>`);
            count += 1;
            last = item;
          }
          return xml(200, `<ListBucketResult><Name>${bucketName}</Name><Prefix>${escapeXml(prefix)}</Prefix><IsTruncated>${truncated}</IsTruncated>${contents.join('')}${prefixes.map((item) => `<CommonPrefixes><Prefix>${escapeXml(item)}</Prefix></CommonPrefixes>`).join('')}${truncated ? `<NextContinuationToken>${escapeXml(last)}</NextContinuationToken>` : ''}</ListBucketResult>`);
        }
        return fail(400, 'InvalidRequest', `unhandled ${method}`);
      }
      if (bucket === undefined) return fail(404, 'NoSuchBucket', 'The specified bucket does not exist');
      if (method === 'PUT') {
        const etag = createHash('md5').update(body).digest('hex');
        bucket.set(key, { body, contentType: String(req.headers['content-type'] ?? 'application/octet-stream'), lastModified: new Date().toISOString().replace(/\.\d{3}/, ''), etag });
        res.setHeader('etag', `"${etag}"`);
        res.statusCode = 200;
        return res.end();
      }
      const object = bucket.get(key);
      if (method === 'DELETE') {
        bucket.delete(key);
        res.statusCode = 204;
        return res.end();
      }
      if (object === undefined) return method === 'HEAD' ? void ((res.statusCode = 404), res.end()) : fail(404, 'NoSuchKey', 'The specified key does not exist.');
      res.setHeader('content-type', object.contentType);
      res.setHeader('etag', `"${object.etag}"`);
      res.setHeader('last-modified', new Date(object.lastModified).toUTCString());
      res.setHeader('accept-ranges', 'bytes');
      const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ''));
      let data = object.body;
      if (range !== null && method === 'GET') {
        const start = Number(range[1]);
        const end = range[2] === '' ? object.body.length - 1 : Math.min(Number(range[2]), object.body.length - 1);
        data = object.body.subarray(start, end + 1);
        res.statusCode = 206;
        res.setHeader('content-range', `bytes ${start}-${end}/${object.body.length}`);
      } else res.statusCode = 200;
      res.setHeader('content-length', String(data.length));
      if (method === 'HEAD') return res.end();
      res.end(data);
    });
  }
}

/** Multiplexed stdout as the Engine API streams exec output. */
function dockerStream(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(8);
  header[0] = 1;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

type Harness = Awaited<ReturnType<typeof harness>>;

async function harness(options: { weed?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ploy-storage-'));
  const dockerSocket = join(dir, 'docker.sock');
  const s3 = new FakeS3();
  /** Identities `s3.configure` created (fake engine): user → access key. */
  const identities = new Map<string, string>();
  const publicBuckets = new Set<string>();
  const execs: { cmd: string[]; env: string[]; exitCode?: number }[] = [];
  let s3Port = 0;
  let weed: ReturnType<typeof spawn> | null = null;
  let closeS3 = (): void => undefined;
  let weedShell: ((commands: string[], keep?: string) => string) | null = null;

  if (options.weed === undefined) {
    const server = createServer((req, res) => s3.handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    s3Port = (server.address() as { port: number }).port;
    closeS3 = (): void => void server.close();
  } else {
    const base = 27_000 + Math.floor(Math.random() * 4_000);
    s3Port = base + 3;
    mkdirSync(join(dir, 'weed'));
    writeFileSync(join(dir, 'weed', 's3.json'), JSON.stringify({ identities: [{ name: 'root', credentials: [{ accessKey: ROOT_KEY, secretKey: ROOT_SECRET }], actions: ['Admin', 'Read', 'Write', 'List', 'Tagging'] }] }));
    // One volume per bucket (what the catalog seeds into the container). Test machines may be nearly full: the free-space
    // guard is off and volumes are small, so `-volume.max=0` still yields a slot for every bucket the scenario creates.
    writeFileSync(join(dir, 'weed', 'master.toml'), '[master.volume_growth]\ncopy_1 = 1\ncopy_2 = 1\ncopy_3 = 1\ncopy_other = 1\n');
    weed = spawn(
      options.weed,
      ['server', `-dir=${join(dir, 'weed')}`, '-ip=127.0.0.1', '-ip.bind=127.0.0.1', `-master.port=${base}`, `-volume.port=${base + 1}`, `-filer.port=${base + 2}`, '-master.volumeSizeLimitMB=128', '-volume.max=0', '-volume.minFreeSpace=0', '-filer', '-s3', `-s3.port=${s3Port}`, '-s3.port.iceberg=0', '-s3.port.lance=0', '-s3.allowDeleteBucketNotEmpty=false', '-s3.autoCreateBucket=false', `-s3.config=${join(dir, 'weed', 's3.json')}`],
      { cwd: join(dir, 'weed'), stdio: 'ignore' },
    );
    weedShell = (commands: string[], keep?: string): string => {
      const result = spawnSync(options.weed!, ['shell', `-master=127.0.0.1:${base}`, `-filer=127.0.0.1:${base + 2}`], { input: `${commands.join('\n')}\n`, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      const lines = `${result.stdout}\n${result.stderr}`.split('\n').filter((line) => line.length > 0 && !/^[IWEF]\d{4} /.test(line));
      if (result.status !== 0) throw new Error(lines.find((line) => /error/i.test(line)) ?? `weed shell exited with ${result.status}`);
      return (keep === undefined ? lines : lines.filter((line) => new RegExp(keep).test(line))).join('\n');
    };
  }

  /** The Engine API double: version, and `exec` playing `weed shell` against the fake S3 state. */
  const daemon = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://docker');
      const path = url.pathname.replace(/^\/v1\.\d+/, '');
      res.setHeader('content-type', 'application/json');
      if (path === '/version') return void res.end(JSON.stringify({ Version: '28.0.1', ApiVersion: '1.47', Os: 'linux', Arch: 'amd64' }));
      if (/^\/containers\/[^/]+\/exec$/.test(path)) {
        const spec = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { Cmd: string[]; Env?: string[] };
        execs.push({ cmd: spec.Cmd, env: spec.Env ?? [] });
        res.statusCode = 201;
        return void res.end(JSON.stringify({ Id: `exec${execs.length}` }));
      }
      const start = /^\/exec\/exec(\d+)\/start$/.exec(path);
      if (start !== null) {
        const exec = execs[Number(start[1]) - 1]!;
        const commands = (exec.env.find((entry) => entry.startsWith('PLOY_WEED_COMMANDS='))?.slice('PLOY_WEED_COMMANDS='.length) ?? '').split('\n');
        const out: string[] = [];
        let exitCode = 0;
        for (const command of commands) {
          const configure = /^s3\.configure -user=(\S+)(.*) -apply$/.exec(command);
          if (configure !== null) {
            const [, user, args] = configure;
            const accessKey = /-access_key=(\S+)/.exec(args!)?.[1];
            const buckets = /-buckets=(\S+)/.exec(args!)?.[1];
            if (/-delete/.test(args!)) {
              if (user === 'anonymous') {
                if (buckets !== undefined) publicBuckets.delete(buckets);
                else publicBuckets.clear();
              } else if (identities.has(user!)) {
                s3.accessKeys.delete(identities.get(user!)!);
                identities.delete(user!);
              } else {
                out.push(`error: rpc error: code = NotFound desc = user ${user} not found`);
                exitCode = 1;
              }
            } else if (user === 'anonymous') publicBuckets.add(buckets ?? '*');
            else {
              identities.set(user!, accessKey!);
              s3.accessKeys.add(accessKey!);
            }
            out.push(`{ "name": "${user}" }`);
            continue;
          }
          const tree = /^fs\.tree \/buckets\/(\S+)$/.exec(command);
          if (tree !== null) {
            const bucket = s3.buckets.get(tree[1]!);
            const keys = [...(bucket?.keys() ?? [])];
            const folders = new Set(keys.flatMap((key) => key.split('/').slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join('/'))));
            out.push(`${folders.size} directories, ${keys.filter((key) => !key.endsWith('/')).length} files`);
            continue;
          }
          const du = /^fs\.du \/buckets\/(\S+)$/.exec(command);
          if (du !== null) {
            const bucket = s3.buckets.get(du[1]!);
            if (bucket !== undefined) out.push(`block: ${bucket.size}\tlogical size: ${[...bucket.values()].reduce((sum, object) => sum + object.body.length, 0)}\t/buckets/${du[1]}`);
            continue;
          }
          out.push(`error: unknown command ${command}`);
          exitCode = 1;
        }
        exec.exitCode = exitCode;
        res.setHeader('content-type', 'application/vnd.docker.multiplexed-stream');
        return void res.end(dockerStream(`${out.join('\n')}\n`));
      }
      const inspect = /^\/exec\/exec(\d+)\/json$/.exec(path);
      if (inspect !== null) return void res.end(JSON.stringify({ ExitCode: execs[Number(inspect[1]) - 1]?.exitCode ?? 0, Running: false }));
      res.statusCode = 404;
      res.end(JSON.stringify({ message: `fake daemon: unhandled ${req.method} ${path}` }));
    });
  });
  await new Promise<void>((resolve) => daemon.listen(dockerSocket, resolve));

  process.env.PLOY_RUN_DIR = join(dir, 'run');
  // A workstation, not a container: the panel reaches the store on loopback through its public port.
  process.env.HOSTNAME = 'test-workstation';
  const ctx = await createContext({ dataDir: join(dir, 'data'), databasePath: join(dir, 'data', 'test.db'), dockerSocket, logLevel: 'error' });
  if (options.weed !== undefined) ctx.storage.shell = async (_service, commands, keep) => weedShell!(commands, keep);
  const { stores } = ctx;
  const local = stores.servers.ensureLocal('local');
  const member = (teamId: string, email: string, role: 'viewer' | 'developer' | 'admin' | 'owner'): string => {
    const user = stores.users.create({ email, name: email.split('@')[0]!, passwordHash: null, isInstanceAdmin: false });
    stores.teams.addMember(teamId, user.id, role);
    return stores.tokens.create({ userId: user.id, teamId, name: 'test', expiresAt: null, tokenPrefix: API_TOKEN_PREFIX }).token;
  };
  const teamA = stores.teams.create('Acme');
  const teamB = stores.teams.create('Rival');
  const tokens = { owner: member(teamA.id, 'owner@acme.uz', 'owner'), developer: member(teamA.id, 'dev@acme.uz', 'developer'), viewer: member(teamA.id, 'viewer@acme.uz', 'viewer'), rival: member(teamB.id, 'owner@rival.uz', 'owner') };
  const project = stores.projects.create(teamA.id, 'Shop', null);
  const store = (name: string, slug: string, type: ServiceRecord['type'] = 'files'): ServiceRecord => {
    const service = stores.services.create({
      id: `svc_${slug.padEnd(14, '0')}`,
      projectId: project.id,
      teamId: teamA.id,
      serverId: local.id,
      name,
      slug,
      type,
      version: type === 'files' ? '4.48' : '17',
      credentials: { username: ROOT_KEY, password: ROOT_SECRET, database: null },
      internalPort: type === 'files' ? 8333 : 5432,
      containerName: `ploy-db-${slug}-test`,
      volumeName: `ploy-data-${slug}`,
      memoryLimitMb: 512,
    });
    stores.services.setStatus(service.id, 'running');
    return stores.services.update(service.id, { publicPort: s3Port });
  };

  const app = createHttpApp(ctx);
  const call = async <T>(token: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T; headers: Headers }> => {
    const raw = body instanceof Buffer ? body : body === undefined ? undefined : JSON.stringify(body);
    const response = await app.request(
      path,
      { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined || body instanceof Buffer ? {} : { 'content-type': 'application/json' }), ...headers }, ...(raw === undefined ? {} : { body: raw }) },
      BINDINGS,
    );
    const type = response.headers.get('content-type') ?? '';
    return { status: response.status, body: (type.includes('json') ? await response.json() : await response.arrayBuffer().then((data) => Buffer.from(data))) as T, headers: response.headers };
  };

  if (weed !== null) {
    // SeaweedFS needs a few seconds for master, volume and filer to come up.
    const admin = new S3Client({ endpoint: `http://127.0.0.1:${s3Port}`, region: 'us-east-1', bucket: 'warmup', accessKeyId: ROOT_KEY, secretAccessKey: ROOT_SECRET, forcePathStyle: true });
    let ready = false;
    for (let attempt = 0; attempt < 240 && !ready; attempt += 1) {
      try {
        await admin.createBucket();
        await admin.deleteBucket();
        ready = true;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    assert.ok(ready, 'the S3 gateway came up');
  }

  return {
    ctx,
    s3,
    s3Port,
    weed: weed !== null,
    identities,
    publicBuckets,
    execs,
    tokens,
    teamA,
    local,
    project,
    store,
    call,
    close: async () => {
      ctx.domains.stop();
      await ctx.deployer.shutdown();
      await ctx.connections.closeAll();
      stores.db.close();
      daemon.close();
      closeS3();
      if (weed !== null) {
        const exited = new Promise((resolve) => weed.once('exit', resolve));
        weed.kill('SIGKILL');
        await exited;
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The whole scenario, run against the fake engine and (when available) against SeaweedFS. */
async function exercise(h: Harness): Promise<void> {
  const { stores } = h.ctx;
  const events: PlatformEvent[] = [];
  h.ctx.bus.onTeamEvent(({ event }) => events.push(event));
  const media = h.store('Media', 'media');
  const db = h.store('DB', 'db', 'postgres');
  const base = `/api/services/${media.id}/storage`;
  const error = async (token: string, method: string, path: string, body?: unknown, headers?: Record<string, string>) => {
    const response = await h.call<ApiErrorBody>(token, method, path, body, headers);
    return { status: response.status, code: response.body.error.code, reason: response.body.error.params?.reason, issues: response.body.error.issues?.map((issue) => issue.path) };
  };

  // Only file stores have storage; other teams never see it.
  assert.deepEqual(await error(h.tokens.viewer, 'GET', `/api/services/${db.id}/storage`), { status: 400, code: 'bad_request', reason: 'not_file_store', issues: undefined });
  assert.equal((await h.call(h.tokens.rival, 'GET', base)).status, 404);
  assert.equal((await h.call('ploy_nope', 'GET', base)).status, 401);

  // The overview before anything exists: no public address, the in-network one, the root key id.
  const empty = await h.call<StorageOverviewDto>(h.tokens.viewer, 'GET', base);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, { endpoint: null, internalEndpoint: 'http://media:8333', region: 'us-east-1', forcePathStyle: true, rootAccessKeyId: ROOT_KEY, buckets: 0, keys: 0, backupDestinationId: null, usage: { objects: 0, bytes: 0 } });
  const detail = await h.call<ServiceDto>(h.tokens.viewer, 'GET', `/api/services/${media.id}`);
  assert.deepEqual([detail.body.type, detail.body.internalHost, detail.body.internalPort], ['files', 'media', 8333]);

  // Buckets: developers create them, viewers only look; names are validated; a public one gets the anonymous identity.
  assert.equal((await h.call(h.tokens.viewer, 'POST', `${base}/buckets`, { name: 'photos' })).status, 403);
  assert.deepEqual((await error(h.tokens.developer, 'POST', `${base}/buckets`, { name: 'No_Caps' })).issues, ['name']);
  const photos = await h.call<StorageBucketDto>(h.tokens.developer, 'POST', `${base}/buckets`, { name: 'photos' });
  assert.equal(photos.status, 201);
  assert.deepEqual([photos.body.name, photos.body.public, photos.body.objects, photos.body.bytes], ['photos', false, 0, 0]);
  const site = await h.call<StorageBucketDto>(h.tokens.developer, 'POST', `${base}/buckets`, { name: 'site', public: true });
  assert.equal(site.body.public, true);
  assert.deepEqual(await error(h.tokens.developer, 'POST', `${base}/buckets`, { name: 'photos' }), { status: 409, code: 'conflict', reason: 'bucket_exists', issues: undefined });
  if (!h.weed) {
    assert.ok(h.publicBuckets.has('site'), 'the engine was told to serve the bucket anonymously');
    const configure = h.execs.find((exec) => exec.env.some((entry) => entry.includes('-user=anonymous')));
    assert.ok(configure);
    assert.match(configure.env.find((entry) => entry.startsWith('PLOY_WEED_COMMANDS='))!, /^PLOY_WEED_COMMANDS=s3\.configure -user=anonymous -buckets=site -actions=Read,List -apply$/);
    assert.deepEqual(configure.cmd.slice(0, 2), ['sh', '-c']);
  }
  const listed = await h.call<StorageBucketDto[]>(h.tokens.viewer, 'GET', `${base}/buckets`);
  assert.deepEqual(listed.body.map((bucket) => [bucket.name, bucket.public]), [['photos', false], ['site', true]]);

  // Objects: uploads stream in with their type and need a length; listings show folders first and page.
  const png = Buffer.from('\u0089PNG fake image bytes of some length');
  const upload = (key: string, data: Buffer, type = 'application/octet-stream') => h.call<StorageObjectDto>(h.tokens.developer, 'PUT', `${base}/buckets/photos/objects/${key}`, data, { 'content-type': type, 'content-length': String(data.length) });
  assert.equal((await h.call(h.tokens.viewer, 'PUT', `${base}/buckets/photos/objects/x.txt`, Buffer.from('x'), { 'content-length': '1' })).status, 403);
  const first = await upload('avatars/2026/me.png', png, 'image/png');
  assert.equal(first.status, 201);
  assert.deepEqual([first.body.key, first.body.name, first.body.size, first.body.contentType], ['avatars/2026/me.png', 'me.png', png.length, 'image/png']);
  assert.ok(first.body.etag !== null && first.body.lastModified.length > 0);
  await upload('avatars/old.png', Buffer.from('old'), 'image/png');
  await upload('readme.txt', Buffer.from('hello world'), 'text/plain');
  await upload('sp ace/ü+plus&amp.txt', Buffer.from('x'), 'text/plain');
  assert.deepEqual(await error(h.tokens.developer, 'PUT', `${base}/buckets/photos/objects/trailing/`, Buffer.from('x'), { 'content-length': '1' }), { status: 422, code: 'validation_failed', reason: undefined, issues: ['key'] });
  // A declared size over the limit is refused before a byte is read (a stream body keeps the declared length).
  const tooBig = await (await import('./app.ts')).createHttpApp(h.ctx).request(
    `${base}/buckets/photos/objects/big.bin`,
    { method: 'PUT', headers: { authorization: `Bearer ${h.tokens.developer}`, 'content-length': String(6 * 1024 * 1024 * 1024) }, body: new ReadableStream({ start: (controller) => (controller.enqueue(new Uint8Array([120])), controller.close()) }), duplex: 'half' } as RequestInit,
    BINDINGS,
  );
  assert.equal(tooBig.status, 413);
  assert.equal(((await tooBig.json()) as ApiErrorBody).error.code, 'payload_too_large');
  assert.equal((await error(h.tokens.developer, 'PUT', `${base}/buckets/nobucket/objects/x.txt`, Buffer.from('x'), { 'content-length': '1' })).status, 404);

  const root = await h.call<StorageListingDto>(h.tokens.viewer, 'GET', `${base}/buckets/photos/objects`);
  assert.equal(root.status, 200);
  assert.deepEqual([root.body.bucket, root.body.prefix, root.body.folders, root.body.objects.map((object) => object.key), root.body.nextCursor], ['photos', '', ['avatars/', 'sp ace/'], ['readme.txt'], null]);
  const avatars = await h.call<StorageListingDto>(h.tokens.viewer, 'GET', `${base}/buckets/photos/objects?prefix=avatars/`);
  assert.deepEqual([avatars.body.folders, avatars.body.objects.map((object) => [object.key, object.name, object.size])], [['avatars/2026/'], [['avatars/old.png', 'old.png', 3]]]);
  const page = await h.call<StorageListingDto>(h.tokens.viewer, 'GET', `${base}/buckets/photos/objects?prefix=avatars/&limit=1`);
  assert.ok(page.body.nextCursor !== null, 'a page smaller than the folder has a cursor');
  const rest = await h.call<StorageListingDto>(h.tokens.viewer, 'GET', `${base}/buckets/photos/objects?prefix=avatars/&limit=1&cursor=${encodeURIComponent(page.body.nextCursor!)}`);
  assert.equal(rest.status, 200);
  assert.deepEqual([...page.body.folders, ...page.body.objects.map((object) => object.key), ...rest.body.folders, ...rest.body.objects.map((object) => object.key)].sort(), ['avatars/2026/', 'avatars/old.png']);
  assert.deepEqual((await error(h.tokens.viewer, 'GET', `${base}/buckets/photos/objects?prefix=no-slash`)).issues, ['prefix']);
  assert.deepEqual((await h.call<StorageListingDto>(h.tokens.viewer, 'GET', `${base}/buckets/photos/objects?prefix=${encodeURIComponent('sp ace/')}`)).body.objects.map((object) => object.key), ['sp ace/ü+plus&amp.txt']);

  // Downloads stream back with their type; ranges pass through; `download=1` makes an attachment.
  const get = await h.call<Buffer>(h.tokens.viewer, 'GET', `${base}/buckets/photos/objects/avatars/2026/me.png`);
  assert.equal(get.status, 200);
  assert.ok(get.body.equals(png));
  assert.equal(get.headers.get('content-type'), 'image/png');
  assert.equal(get.headers.get('content-length'), String(png.length));
  assert.equal(get.headers.get('content-disposition'), null);
  const partial = await h.call<Buffer>(h.tokens.viewer, 'GET', `${base}/buckets/photos/objects/readme.txt`, undefined, { range: 'bytes=6-10' });
  assert.deepEqual([partial.status, partial.headers.get('content-range'), partial.body.toString()], [206, 'bytes 6-10/11', 'world']);
  const attachment = await h.call<Buffer>(h.tokens.viewer, 'GET', `${base}/buckets/photos/objects/${encodeURIComponent('sp ace')}/${encodeURIComponent('ü+plus&amp.txt')}?download=1`);
  assert.equal(attachment.status, 200);
  assert.match(attachment.headers.get('content-disposition') ?? '', /^attachment; filename="_\+plus&amp\.txt"; filename\*=UTF-8''%C3%BC%2Bplus%26amp\.txt$/);
  assert.equal((await h.call(h.tokens.viewer, 'GET', `${base}/buckets/photos/objects/missing.png`)).status, 404);

  // Folders are zero-byte markers; deleting a folder prefix takes everything below it.
  const folder = await h.call<{ prefix: string }>(h.tokens.developer, 'POST', `${base}/buckets/photos/folders`, { prefix: 'docs/2026/' });
  assert.deepEqual([folder.status, folder.body], [201, { prefix: 'docs/2026/' }]);
  assert.deepEqual((await error(h.tokens.developer, 'POST', `${base}/buckets/photos/folders`, { prefix: 'docs' })).issues, ['prefix']);
  const docs = await h.call<StorageListingDto>(h.tokens.viewer, 'GET', `${base}/buckets/photos/objects?prefix=docs/`);
  assert.deepEqual([docs.body.folders, docs.body.objects], [['docs/2026/'], []]);
  const inside = await h.call<StorageListingDto>(h.tokens.viewer, 'GET', `${base}/buckets/photos/objects?prefix=docs/2026/`);
  assert.deepEqual(inside.body.objects, [], 'the marker is the folder, not an object inside it');
  const stats = await h.call<StorageBucketDto[]>(h.tokens.viewer, 'GET', `${base}/buckets`);
  const counted = stats.body.find((bucket) => bucket.name === 'photos')!;
  assert.equal(counted.objects, 4, 'folder markers are not objects');
  assert.equal(counted.bytes, png.length + 3 + 11 + 1);
  assert.equal((await h.call(h.tokens.viewer, 'POST', `${base}/buckets/photos/delete`, { keys: ['readme.txt'] })).status, 403);
  // URL paths are normalized by every client; keys in a body are checked by the server (no `..` segments).
  assert.equal((await error(h.tokens.developer, 'POST', `${base}/buckets/photos/delete`, { keys: ['a/../b.txt'] })).code, 'validation_failed');
  const removed = await h.call<{ deleted: number }>(h.tokens.developer, 'POST', `${base}/buckets/photos/delete`, { keys: ['avatars/', 'readme.txt', 'never-there.txt'] });
  assert.equal(removed.status, 200);
  assert.ok(removed.body.deleted >= 3, `objects and the whole folder went (${removed.body.deleted})`);
  const after = await h.call<StorageListingDto>(h.tokens.viewer, 'GET', `${base}/buckets/photos/objects`);
  assert.deepEqual([after.body.folders, after.body.objects], [['docs/', 'sp ace/'], []]);

  // Presigned links need a public address; a domain on the store provides one.
  assert.deepEqual(await error(h.tokens.viewer, 'POST', `${base}/buckets/photos/presign`, { key: 'sp ace/ü+plus&amp.txt' }), { status: 422, code: 'validation_failed', reason: 'no_public_endpoint', issues: ['key'] });
  assert.equal((await h.call(h.tokens.viewer, 'POST', `/api/services/${media.id}/domains`, { host: 'files.localhost', https: false })).status, 403);
  assert.deepEqual((await error(h.tokens.developer, 'POST', `/api/services/${media.id}/domains`, { https: false })).issues, ['host']);
  const domain = await h.call<DomainDto>(h.tokens.developer, 'POST', `/api/services/${media.id}/domains`, { host: 'Files.localhost', https: false });
  assert.equal(domain.status, 201);
  assert.deepEqual([domain.body.applicationId, domain.body.serviceId, domain.body.host, domain.body.https, domain.body.isGenerated], [null, media.id, 'files.localhost', false, false]);
  assert.ok(events.some((event) => event.type === 'domain.updated' && event.applicationId === null && event.serviceId === media.id));
  assert.deepEqual((await error(h.tokens.developer, 'POST', `/api/services/${media.id}/domains`, { host: 'files.localhost' })).code, 'domain_taken');
  assert.deepEqual((await h.call<DomainDto[]>(h.tokens.viewer, 'GET', `/api/services/${media.id}/domains`)).body.map((item) => item.host), ['files.localhost']);
  assert.equal((await h.call<StorageOverviewDto>(h.tokens.viewer, 'GET', base)).body.endpoint, 'http://files.localhost');
  const link = await h.call<{ url: string; expiresAt: string }>(h.tokens.viewer, 'POST', `${base}/buckets/photos/presign?download=1`, { key: 'sp ace/ü+plus&amp.txt', expiresIn: 600 });
  assert.equal(link.status, 200);
  const url = new URL(link.body.url);
  assert.equal(url.origin + url.pathname, 'http://files.localhost/photos/sp%20ace/%C3%BC%2Bplus%26amp.txt');
  assert.equal(url.searchParams.get('X-Amz-Expires'), '600');
  assert.equal(url.searchParams.get('X-Amz-Credential')?.split('/')[0], ROOT_KEY);
  assert.match(url.searchParams.get('response-content-disposition') ?? '', /^attachment; filename="ü\+plus&amp\.txt"$/);
  assert.match(url.searchParams.get('X-Amz-Signature') ?? '', /^[0-9a-f]{64}$/);
  assert.ok(Date.parse(link.body.expiresAt) > Date.now() + 500_000);
  assert.equal((await h.call(h.tokens.viewer, 'POST', `${base}/buckets/photos/presign`, { key: 'up.bin', method: 'put' })).status, 403, 'uploads links need write access');
  assert.equal((await h.call(h.tokens.developer, 'POST', `${base}/buckets/photos/presign`, { key: 'up.bin', method: 'put' })).status, 200);
  if (h.weed) {
    // Against the real gateway a signed link for the object (addressed to where the gateway listens) serves it.
    const served = new S3Client({ endpoint: `http://127.0.0.1:${h.s3Port}`, region: 'us-east-1', bucket: 'photos', accessKeyId: ROOT_KEY, secretAccessKey: ROOT_SECRET, forcePathStyle: true }).presign({ method: 'GET', key: 'sp ace/ü+plus&amp.txt', expiresIn: 60 });
    assert.equal(await fetch(served.url).then((response) => response.text()), 'x');
  }

  // Service domains go through the shared domain routes, and the proxy routes them to the gateway.
  const checked = await h.call<DomainDto>(h.tokens.viewer, 'POST', `/api/domains/${domain.body.id}/verify`);
  assert.deepEqual([checked.body.dns.status, checked.body.tls.status], ['ok', 'disabled'], '*.localhost never leaves the machine');
  const secured = await h.call<DomainDto>(h.tokens.developer, 'PATCH', `/api/domains/${domain.body.id}`, { https: true });
  assert.deepEqual([secured.body.https, secured.body.serviceId], [true, media.id]);
  assert.equal((await h.call<StorageOverviewDto>(h.tokens.viewer, 'GET', base)).body.endpoint, 'https://files.localhost');
  assert.equal((await h.call(h.tokens.rival, 'DELETE', `/api/domains/${domain.body.id}`)).status, 404);
  const route = h.ctx.proxy.overview(h.local.id).routes.find((candidate) => candidate.host === 'files.localhost');
  assert.deepEqual([route?.upstreams, route?.label, route?.stream], [[`ploy-db-media-test:8333`], 'Media', true]);
  stores.services.setStatus(media.id, 'stopped');
  assert.deepEqual(h.ctx.proxy.overview(h.local.id).routes.find((candidate) => candidate.host === 'files.localhost')?.upstreams, [], 'a stopped store is not routed');
  assert.deepEqual(await error(h.tokens.viewer, 'GET', `${base}/buckets`), { status: 503, code: 'storage_unavailable', reason: 'not_running', issues: undefined });
  const stoppedOverview = await h.call<StorageOverviewDto>(h.tokens.viewer, 'GET', base);
  assert.deepEqual([stoppedOverview.status, stoppedOverview.body.usage, stoppedOverview.body.buckets], [200, null, 2], 'the overview still renders from the panel rows');
  stores.services.setStatus(media.id, 'running');

  // Access keys: admins only; the secret comes back once; the engine gets a scoped identity; secrets stay out of argv.
  assert.equal((await h.call(h.tokens.developer, 'POST', `${base}/keys`, { name: 'app' })).status, 403);
  assert.deepEqual((await error(h.tokens.owner, 'POST', `${base}/keys`, { name: 'app', buckets: ['nope'] })).issues, ['buckets']);
  const created = await h.call<StorageKeyCreatedDto>(h.tokens.owner, 'POST', `${base}/keys`, { name: 'Uploader', buckets: ['photos'], permission: 'read' });
  assert.equal(created.status, 201);
  assert.match(created.body.id, /^sk_/);
  assert.match(created.body.accessKeyId, /^ploy[a-z0-9]{16}$/);
  assert.equal(created.body.secretAccessKey.length, 40);
  assert.deepEqual([created.body.name, created.body.buckets, created.body.permission, created.body.managedBy, created.body.lastUsedAt], ['Uploader', ['photos'], 'read', 'user', null]);
  const everything = await h.call<StorageKeyCreatedDto>(h.tokens.owner, 'POST', `${base}/keys`, { name: 'Everything' });
  assert.deepEqual([everything.body.buckets, everything.body.permission], [null, 'readwrite']);
  if (h.weed) {
    // The identities really exist: read-only on one bucket, read-write everywhere, both refused outside their scope.
    const endpoint = `http://127.0.0.1:${h.s3Port}`;
    const reader = (bucket: string) => new S3Client({ endpoint, region: 'us-east-1', bucket, accessKeyId: created.body.accessKeyId, secretAccessKey: created.body.secretAccessKey, forcePathStyle: true });
    const writer = (bucket: string) => new S3Client({ endpoint, region: 'us-east-1', bucket, accessKeyId: everything.body.accessKeyId, secretAccessKey: everything.body.secretAccessKey, forcePathStyle: true });
    let visible = false;
    for (let attempt = 0; attempt < 20 && !visible; attempt += 1) {
      try {
        await reader('photos').listObjects({});
        visible = true;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    assert.ok(visible, 'the read key lists its bucket');
    await assert.rejects(reader('photos').put('new.txt', Buffer.from('x'), 1), (error: unknown) => error instanceof S3Error && error.status === 403);
    await assert.rejects(reader('site').listObjects({}), (error: unknown) => error instanceof S3Error && error.status === 403);
    await writer('site').put('index.html', Buffer.from('<h1>hi</h1>'), 11, 'text/html');
    assert.equal(await fetch(`${endpoint}/site/index.html`).then((response) => response.status), 200, 'a public bucket is served without credentials');
    assert.equal(await fetch(`${endpoint}/photos/sp%20ace/%C3%BC%2Bplus%26amp.txt`).then((response) => response.status), 403, 'a private one is not');
  } else {
    const configure = h.execs.filter((exec) => exec.env.some((entry) => entry.includes(`-user=${created.body.id}`)));
    assert.equal(configure.length, 1);
    const command = configure[0]!.env.find((entry) => entry.startsWith('PLOY_WEED_COMMANDS='))!;
    assert.equal(command, `PLOY_WEED_COMMANDS=s3.configure -user=${created.body.id} -access_key=${created.body.accessKeyId} -secret_key=${created.body.secretAccessKey} -buckets=photos -actions=Read,List -apply`);
    assert.ok(!configure[0]!.cmd.join(' ').includes(created.body.secretAccessKey), 'the secret travels in the environment, never in argv');
    assert.match(h.execs.find((exec) => exec.env.some((entry) => entry.includes(`-user=${everything.body.id}`)))!.env.join('\n'), /-actions=Read,List,Write,Tagging -apply$/);
    assert.ok(!h.execs.find((exec) => exec.env.some((entry) => entry.includes(`-user=${everything.body.id}`)))!.env.join('\n').includes('-buckets='), 'an unscoped key names no buckets');
    assert.ok(h.s3.accessKeys.has(created.body.accessKeyId));
  }
  const keys = await h.call<StorageKeyDto[]>(h.tokens.viewer, 'GET', `${base}/keys`);
  assert.deepEqual(keys.body.map((key) => key.name), ['Uploader', 'Everything']);
  assert.ok(!JSON.stringify(keys.body).includes(created.body.secretAccessKey), 'the secret is shown once');
  assert.ok(!stores.db.all('SELECT metadata FROM audit_log').some((row) => String(row.metadata).includes(created.body.secretAccessKey)), 'and never reaches the audit log');
  assert.equal((await h.call<StorageOverviewDto>(h.tokens.viewer, 'GET', base)).body.keys, 2);
  assert.equal((await h.call(h.tokens.developer, 'DELETE', `${base}/keys/${created.body.id}`)).status, 403);
  assert.equal((await h.call(h.tokens.owner, 'DELETE', `${base}/keys/sk_missing`)).status, 404);
  assert.deepEqual((await h.call(h.tokens.owner, 'DELETE', `${base}/keys/${created.body.id}`)).body, { ok: true });
  assert.deepEqual((await h.call<StorageKeyDto[]>(h.tokens.viewer, 'GET', `${base}/keys`)).body.map((key) => key.name), ['Everything']);
  if (!h.weed) assert.ok(!h.s3.accessKeys.has(created.body.accessKeyId), 'the identity is gone from the engine');

  // Backups into the store: one call makes the bucket, a scoped key and a destination; a second call returns it.
  assert.equal((await h.call(h.tokens.developer, 'POST', `${base}/backup-destination`)).status, 403);
  const destination = await h.call<S3DestinationDto>(h.tokens.owner, 'POST', `${base}/backup-destination`);
  assert.equal(destination.status, 201);
  assert.deepEqual([destination.body.name, destination.body.bucket, destination.body.endpoint, destination.body.forcePathStyle, destination.body.pathPrefix, destination.body.region], ['Media (fayl ombori)', 'backups', `http://127.0.0.1:${h.s3Port}`, true, '', 'us-east-1']);
  const backupsKey = stores.storageKeys.backupsKey(media.id);
  assert.ok(backupsKey);
  assert.deepEqual([backupsKey.name, backupsKey.buckets, backupsKey.permission, backupsKey.managedBy, destination.body.accessKeyId], ['backups', ['backups'], 'readwrite', 'backups', backupsKey.accessKeyId]);
  const again = await h.call<S3DestinationDto>(h.tokens.owner, 'POST', `${base}/backup-destination`);
  assert.deepEqual([again.status, again.body.id], [200, destination.body.id]);
  assert.equal((await h.call<StorageOverviewDto>(h.tokens.viewer, 'GET', base)).body.backupDestinationId, destination.body.id);
  assert.deepEqual((await h.call<StorageBucketDto[]>(h.tokens.viewer, 'GET', `${base}/buckets`)).body.map((bucket) => bucket.name), ['backups', 'photos', 'site']);
  assert.equal(stores.db.scalar("SELECT COUNT(*) FROM audit_log WHERE action = 'storage.backup_destination_created'"), 1);
  // The database can send its backups there; the panel resolves the store's address when it uploads.
  assert.equal((await h.call(h.tokens.developer, 'PATCH', `/api/services/${db.id}`, { backupDestinationId: destination.body.id })).status, 200);
  const resolved = await h.ctx.storage.destinationTarget(stores.s3.get(destination.body.id)!);
  assert.equal(resolved.endpoint, `http://127.0.0.1:${h.s3Port}`);
  await new S3Client(resolved).verify('torexploy');
  assert.deepEqual(await error(h.tokens.owner, 'DELETE', `${base}/keys/${backupsKey.id}`), { status: 409, code: 'conflict', reason: 'managed_key', issues: undefined });
  assert.deepEqual((await error(h.tokens.owner, 'PATCH', `/api/s3-destinations/${destination.body.id}`, { bucket: 'other' })).reason, 'managed_destination');
  assert.equal((await h.call(h.tokens.owner, 'PATCH', `/api/s3-destinations/${destination.body.id}`, { name: 'Media backups' })).status, 200);
  assert.deepEqual((await h.call(h.tokens.owner, 'POST', `/api/s3-destinations/${destination.body.id}/test`)).body, { ok: true, error: null });
  assert.deepEqual((await h.call(h.tokens.owner, 'DELETE', `/api/s3-destinations/${destination.body.id}`)).body, { ok: true });
  assert.equal(stores.storageKeys.backupsKey(media.id), undefined, 'the destination takes its key along');
  assert.equal(stores.services.get(db.id)!.backupDestinationId, null);
  if (!h.weed) assert.ok(!h.s3.accessKeys.has(backupsKey.accessKeyId));

  // Removing buckets: a bucket with objects needs `force`; a public one also loses its anonymous access.
  assert.deepEqual(await error(h.tokens.developer, 'DELETE', `${base}/buckets/photos`), { status: 409, code: 'bucket_not_empty', reason: undefined, issues: undefined });
  assert.deepEqual((await h.call(h.tokens.developer, 'DELETE', `${base}/buckets/photos?force=true`)).body, { ok: true });
  assert.deepEqual((await h.call(h.tokens.developer, 'DELETE', `${base}/buckets/site?force=true`)).body, { ok: true });
  if (!h.weed) assert.ok(!h.publicBuckets.has('site'));
  assert.deepEqual((await h.call<StorageBucketDto[]>(h.tokens.viewer, 'GET', `${base}/buckets`)).body.map((bucket) => bucket.name), ['backups']);
  assert.equal((await h.call(h.tokens.developer, 'DELETE', `${base}/buckets/photos`)).status, 404);
  assert.deepEqual(stores.db.all("SELECT action FROM audit_log WHERE action LIKE 'storage.%' ORDER BY created_at").map((row) => String(row.action)), [
    'storage.bucket_created',
    'storage.bucket_created',
    'storage.objects_deleted',
    'storage.key_created',
    'storage.key_created',
    'storage.key_revoked',
    'storage.backup_destination_created',
    'storage.bucket_deleted',
    'storage.bucket_deleted',
  ]);

  // Linking the store to an application injects the S3 variables, like any other service.
  const web = stores.applications.create({ projectId: h.project.id, teamId: h.teamA.id, serverId: h.local.id, name: 'Web', slug: 'web', kind: 'web', sourceType: 'image', githubInstallationId: null, repository: null, gitUrl: null, branch: null, image: 'nginx', sealedHookToken: h.ctx.secrets.seal(generateToken(), 'hook') });
  stores.links.create(web.id, media.id, 'MEDIA_');
  const env = resolveAppEnv(stores, web).env;
  assert.deepEqual([env.MEDIA_S3_ENDPOINT, env.MEDIA_S3_ACCESS_KEY_ID, env.MEDIA_AWS_SECRET_ACCESS_KEY, env.MEDIA_S3_FORCE_PATH_STYLE], ['http://media:8333', ROOT_KEY, ROOT_SECRET, 'true']);
  assert.ok(resolveAppEnv(stores, web).secrets.includes(ROOT_SECRET), 'the root secret is masked in logs');
}

test('file store: buckets, objects, links, keys, backups and domains through the API (fake engine)', async () => {
  const h = await harness();
  try {
    await exercise(h);
  } finally {
    await h.close();
  }
});

test('file store: the same scenario against a real SeaweedFS', { timeout: 300_000 }, async (t) => {
  const binary = process.env.PLOY_TEST_WEED;
  if (binary === undefined || spawnSync(binary, ['version']).status !== 0) {
    t.skip('SeaweedFS not available (set PLOY_TEST_WEED)');
    return;
  }
  const h = await harness({ weed: binary });
  try {
    await exercise(h);
  } finally {
    await h.close();
  }
});
