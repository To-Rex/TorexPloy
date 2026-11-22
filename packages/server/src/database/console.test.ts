/**
 * The database console.
 *
 * The pure parts (splitting scripts, export formats, MySQL helpers) always
 * run. The rest goes through the HTTP API, a Docker double that answers the
 * tunnel's attach by bridging to a real database, and the console's own
 * wire clients — against a PostgreSQL and a MySQL named by
 * PLOY_TEST_POSTGRES and PLOY_TEST_MYSQL (user:password@host:port, a
 * superuser), and skipped without them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HttpBindings } from '@hono/node-server';
import { createServer, type IncomingMessage } from 'node:http';
import { connect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  API_TOKEN_PREFIX,
  splitSql,
  statementAt,
  type ApiErrorBody,
  type DbActivityDto,
  type DbChangesResultDto,
  type DbOverviewDto,
  type DbRoleDto,
  type DbRowsDto,
  type DbRunResultDto,
  type DbTableDto,
  type DbTreeDto,
  type ServiceType,
} from '@ploy/shared';
import { createContext } from '../main.ts';
import { createHttpApp } from '../http/app.ts';
import { csvCell, exportWriter, jsonValue } from './export.ts';
import { commandOf, enumOptions } from './my-engine.ts';
import { MysqlConnection } from './mysql.ts';
import { parseCommandTag, PgConnection } from './postgres.ts';

const BINDINGS = { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as unknown as HttpBindings;

// ------------------------------------------------------------------ pure parts

test('scripts split into statements the way psql and the mysql client do', () => {
  const pg = splitSql(
    `-- leading comment
SELECT 'a;b', "x;y" FROM t; /* block ; /* nested ; */ */
CREATE FUNCTION f() RETURNS int AS $body$ BEGIN RETURN 1; END $body$ LANGUAGE plpgsql;
SELECT E'it\\'s;' ;
CREATE FUNCTION g() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; SELECT CASE WHEN true THEN 2 END; END;
SELECT $1::int;
-- only a comment;
`,
    'postgres',
  );
  assert.deepEqual(
    pg.map((statement) => statement.text.split('\n')[0]),
    [`SELECT 'a;b', "x;y" FROM t`, 'CREATE FUNCTION f() RETURNS int AS $body$ BEGIN RETURN 1; END $body$ LANGUAGE plpgsql', "SELECT E'it\\'s;'", 'CREATE FUNCTION g() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; SELECT CASE WHEN true THEN 2 END; END', 'SELECT $1::int'],
  );
  assert.equal(pg[0]!.start, `-- leading comment\n`.length);

  const my = splitSql(
    `SELECT 'it\\'s;', "a;b", \`c;d\` FROM t; # hash comment ;
CREATE PROCEDURE p() BEGIN DECLARE x INT; IF x THEN SELECT 1; END IF; SELECT CASE WHEN 1 THEN 2 END; END;
DELIMITER $$
CREATE TRIGGER tr BEFORE INSERT ON t FOR EACH ROW BEGIN SET NEW.a = 1; END$$
DELIMITER ;
SELECT 2;--not a comment in MySQL
SELECT 3 -- a comment ;
;`,
    'mysql',
  );
  assert.deepEqual(
    my.map((statement) => statement.text),
    [
      "SELECT 'it\\'s;', \"a;b\", `c;d` FROM t",
      'CREATE PROCEDURE p() BEGIN DECLARE x INT; IF x THEN SELECT 1; END IF; SELECT CASE WHEN 1 THEN 2 END; END',
      'CREATE TRIGGER tr BEFORE INSERT ON t FOR EACH ROW BEGIN SET NEW.a = 1; END',
      'SELECT 2',
      '--not a comment in MySQL\nSELECT 3 -- a comment ;',
    ],
  );

  const script = 'SELECT 1;\n\nSELECT 2;';
  const statements = splitSql(script, 'postgres');
  assert.equal(statementAt(statements, script.length)?.text, 'SELECT 2');
  assert.equal(statementAt(statements, 3)?.text, 'SELECT 1');
});

test('command tags, MySQL commands and ENUM values are read', () => {
  assert.deepEqual(parseCommandTag('INSERT 0 5'), { command: 'INSERT', rowCount: 5 });
  assert.deepEqual(parseCommandTag('UPDATE 3'), { command: 'UPDATE', rowCount: 3 });
  assert.deepEqual(parseCommandTag('CREATE TABLE'), { command: 'CREATE TABLE', rowCount: null });
  assert.equal(commandOf('/* hi */ create or replace view v as select 1'), 'CREATE VIEW');
  assert.equal(commandOf('  insert into t values (1)'), 'INSERT');
  assert.deepEqual(enumOptions("enum('a','it''s','b\\\\c')"), ['a', "it's", 'b\\c']);
  assert.equal(enumOptions('varchar(20)'), null);
});

test('exports write CSV, JSON and SQL', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,"b"'), '"a,""b"""');
  assert.equal(csvCell(null), '');
  assert.equal(jsonValue('12', 'number'), 12);
  assert.equal(jsonValue('12345678901234567890', 'number'), '12345678901234567890');
  assert.equal(jsonValue('12.50', 'number'), 12.5);
  assert.equal(jsonValue('0.12345678901234567891', 'number'), '0.12345678901234567891');
  assert.deepEqual(jsonValue('{"a":1}', 'json'), { a: 1 });
  assert.equal(jsonValue('t', 'boolean'), true);
  const table = {
    schema: 'public',
    name: 'people',
    columns: [
      { name: 'id', kind: 'number' },
      { name: 'name', kind: 'text' },
      { name: 'data', kind: 'binary' },
    ],
  } as DbTableDto;
  const json = exportWriter('json', table, 'postgres');
  assert.equal(`${json.head()}${json.rows(['id', 'name', 'data'], [['1', 'Ali', null]])}${json.tail()}`, '[\n  {"id":1,"name":"Ali","data":null}\n]\n');
  const empty = exportWriter('json', table, 'postgres');
  assert.equal(`${empty.head()}${empty.tail()}`, '[]\n');
  const sql = exportWriter('sql', table, 'mysql');
  assert.equal(sql.rows(['id', 'name', 'data'], [['1', "it's", '0xff00']]), "INSERT INTO `people` (`id`, `name`, `data`) VALUES (1, 'it\\'s', X'ff00');\n");
});

// ------------------------------------------------------------- live databases

interface Server {
  user: string;
  password: string;
  host: string;
  port: number;
}

function parseServer(value: string | undefined): Server | null {
  const match = /^([^:]+):(.*)@([^:@]+):(\d+)$/.exec(value ?? '');
  return match === null ? null : { user: match[1]!, password: match[2]!, host: match[3]!, port: Number(match[4]) };
}

const POSTGRES = parseServer(process.env.PLOY_TEST_POSTGRES);
const MYSQL = parseServer(process.env.PLOY_TEST_MYSQL);

const frame = (data: Buffer): Buffer => {
  const header = Buffer.alloc(8);
  header[0] = 1;
  header.writeUInt32BE(data.length, 4);
  return Buffer.concat([header, data]);
};

/** A Docker daemon that knows just enough to run tunnel containers: create, attach, start and remove. */
async function harness(type: ServiceType, database: Server, credentials: { username: string; password: string; database: string; rootPassword?: string }) {
  const dir = mkdtempSync(join(tmpdir(), 'ploy-dbconsole-'));
  const dockerSocket = join(dir, 'docker.sock');
  const containers = new Map<string, { cmd: string[]; network: string; logs: string; client?: Duplex; upstream?: Socket }>();
  let nextId = 0;

  const daemon = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://docker');
      const path = url.pathname.replace(/^\/v1\.\d+/, '');
      const json = (status: number, body: unknown) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(body));
      };
      if (path === '/version') return json(200, { Version: '28.0.1', ApiVersion: '1.47', Os: 'linux', Arch: 'amd64' });
      if (path === '/_ping') return json(200, 'OK');
      if (path === '/containers/json') return json(200, []);
      if (/^\/images\/.+\/json$/.test(path)) return json(200, { Id: 'sha256:caddy', RepoTags: [], Config: { Labels: {} } });
      if (path === '/containers/create' && req.method === 'POST') {
        const spec = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { Cmd: string[]; Entrypoint: string[]; HostConfig: { NetworkMode: string; LogConfig: { Type: string } } };
        assert.deepEqual(spec.Entrypoint, ['nc']);
        assert.equal(spec.HostConfig.LogConfig.Type, 'none', 'database replies never reach a log file');
        const id = `tunnel${++nextId}`;
        containers.set(id, { cmd: spec.Cmd, network: spec.HostConfig.NetworkMode, logs: spec.HostConfig.LogConfig.Type });
        return json(201, { Id: id });
      }
      let match = /^\/containers\/([^/]+)\/start$/.exec(path);
      if (match !== null) {
        const container = containers.get(match[1]!);
        if (container === undefined) return json(404, { message: 'no such container' });
        const upstream = connect(database.port, database.host);
        container.upstream = upstream;
        upstream.on('data', (data: Buffer) => container.client?.write(frame(data)));
        upstream.on('close', () => container.client?.end());
        upstream.on('error', () => container.client?.destroy());
        container.client?.on('data', (data: Buffer) => upstream.write(data));
        container.client?.on('end', () => upstream.end());
        container.client?.on('close', () => upstream.destroy());
        res.statusCode = 204;
        return res.end();
      }
      match = /^\/containers\/([^/]+)$/.exec(path);
      if (match !== null && req.method === 'DELETE') {
        const container = containers.get(match[1]!);
        container?.upstream?.destroy();
        container?.client?.destroy();
        containers.delete(match[1]!);
        res.statusCode = 204;
        return res.end();
      }
      json(404, { message: `fake daemon: unhandled ${req.method} ${path}` });
    });
  });
  daemon.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
    const match = /\/containers\/([^/]+)\/attach/.exec(req.url ?? '');
    const container = match === null ? undefined : containers.get(match[1]!);
    if (container === undefined) {
      socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    socket.write('HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
    container.client = socket;
  });
  await new Promise<void>((resolve) => daemon.listen(dockerSocket, resolve));

  process.env.PLOY_RUN_DIR = join(dir, 'run');
  const ctx = await createContext({ dataDir: join(dir, 'data'), databasePath: join(dir, 'data', 'test.db'), dockerSocket, logLevel: 'error' });
  ctx.proxy.requestSync = async () => undefined;
  const { stores } = ctx;
  const local = stores.servers.ensureLocal('local');
  const team = stores.teams.create('Acme');
  const member = (email: string, role: 'viewer' | 'developer'): { token: string; id: string } => {
    const user = stores.users.create({ email, name: email.split('@')[0]!, passwordHash: null, isInstanceAdmin: false });
    stores.teams.addMember(team.id, user.id, role);
    return { token: stores.tokens.create({ userId: user.id, teamId: team.id, name: 'test', expiresAt: null, tokenPrefix: API_TOKEN_PREFIX }).token, id: user.id };
  };
  const developer = member('dev@acme.uz', 'developer');
  const viewer = member('viewer@acme.uz', 'viewer');
  const project = stores.projects.create(team.id, 'Shop', null);
  const service = stores.services.create({
    id: `svc_${type}test`,
    projectId: project.id,
    teamId: team.id,
    serverId: local.id,
    name: 'Main DB',
    slug: 'main-db',
    type,
    version: type === 'postgres' ? '17' : '8.4',
    credentials: { username: credentials.username, password: credentials.password, database: credentials.database, ...(credentials.rootPassword === undefined ? {} : { rootPassword: credentials.rootPassword }) },
    internalPort: type === 'postgres' ? 5432 : 3306,
    containerName: 'ploy-db-main-db-test',
    volumeName: 'ploy-db-main-db-test',
    memoryLimitMb: null,
  });
  stores.services.setStatus(service.id, 'running');

  const app = createHttpApp(ctx);
  const call = async <T>(method: string, path: string, body?: unknown, token = developer.token): Promise<{ status: number; body: T }> => {
    const response = await app.request(
      `/api/services/${service.id}/db${path}`,
      { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
      BINDINGS,
    );
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // a download
    }
    return { status: response.status, body: parsed as T };
  };
  const run = async (sql: string, extra: Record<string, unknown> = {}): Promise<DbRunResultDto> => {
    const response = await call<DbRunResultDto>('POST', '/run', { database: credentials.database, session: 'tab-aaaaaaaa', sql, ...extra });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
  };
  return {
    ctx,
    service,
    developer,
    viewer,
    containers,
    call,
    run,
    close: async () => {
      await ctx.dbConsole.stop();
      await ctx.deployer.shutdown();
      await ctx.connections.closeAll();
      stores.db.close();
      daemon.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function dial(server: Server): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(server.port, server.host);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

test('PostgreSQL: browse, query, edit rows, export and watch sessions through the tunnel', { skip: POSTGRES === null ? 'PLOY_TEST_POSTGRES is not set' : false }, async () => {
  const admin = await PgConnection.connect(await dial(POSTGRES!), { user: POSTGRES!.user, password: POSTGRES!.password, database: 'postgres' });
  await admin.query('DROP DATABASE IF EXISTS ploy_console_test WITH (FORCE)');
  await admin.query('DROP ROLE IF EXISTS ploy_console_user');
  await admin.query("CREATE ROLE ploy_console_user LOGIN SUPERUSER PASSWORD 'Console-Secret'");
  await admin.query('CREATE DATABASE ploy_console_test OWNER ploy_console_user');
  const h = await harness('postgres', POSTGRES!, { username: 'ploy_console_user', password: 'Console-Secret', database: 'ploy_console_test' });
  try {
    assert.equal((await h.call('GET', '/overview', undefined, h.viewer.token)).status, 403, 'viewers cannot open the console');

    const overview = await h.call<DbOverviewDto>('GET', '/overview');
    assert.equal(overview.status, 200, JSON.stringify(overview.body));
    assert.equal(overview.body.type, 'postgres');
    assert.equal(overview.body.user, 'ploy_console_user');
    assert.ok(overview.body.databases.some((db) => db.name === 'ploy_console_test' && db.primary));
    assert.equal([...h.containers.values()][0]!.cmd.join(' '), 'ploy-db-main-db-test 5432', 'the tunnel dials the service container');

    const created = await h.run(`
      CREATE TYPE mood AS ENUM ('happy', 'sad');
      CREATE TABLE people (id serial PRIMARY KEY, name text NOT NULL, feeling mood, data jsonb, born date, avatar bytea);
      COMMENT ON TABLE people IS 'Everyone';
      CREATE INDEX people_name ON people (name);
      INSERT INTO people (name, feeling, data, born) VALUES ('Ali', 'happy', '{"a": 1}', '1990-01-02'), ('Vali', NULL, NULL, NULL), ('Gani', 'sad', '[1,2]', NULL);
      SELECT id, name, feeling, data FROM people ORDER BY id;
    `);
    assert.equal(created.error, null, JSON.stringify(created.error));
    assert.equal(created.newSession, true);
    assert.deepEqual(created.results.map((result) => result.command), ['CREATE TYPE', 'CREATE TABLE', 'COMMENT', 'CREATE INDEX', 'INSERT', 'SELECT']);
    const select = created.results[5]!;
    assert.equal(select.rowCount, 3);
    assert.deepEqual(select.rows[0], ['1', 'Ali', 'happy', '{"a": 1}']);
    assert.deepEqual(
      select.columns!.map((column) => `${column.type}:${column.kind}`),
      ['integer:number', 'text:text', 'mood:enum', 'jsonb:json'],
      'the enum got its name from the catalog',
    );
    assert.equal(created.results[4]!.rowCount, 3);

    const failed = await h.run('SELECT 1;\nSELECT nme FROM people;');
    assert.equal(failed.results.length, 1);
    assert.equal(failed.error?.code, '42703');
    assert.equal(failed.error?.statement, 1);
    assert.equal('SELECT 1;\nSELECT nme FROM people;'.slice(failed.error!.position!).startsWith('nme'), true, 'the position points at the bad column');

    const begun = await h.run("BEGIN; UPDATE people SET name = 'Alisher' WHERE id = 1;");
    assert.equal(begun.transaction, 'open');
    assert.equal(begun.newSession, false);
    assert.equal((await h.run('ROLLBACK')).transaction, 'idle');

    const limited = await h.run('SELECT generate_series(1, 50) AS n', { limit: 10 });
    assert.equal(limited.results[0]!.rows.length, 10);
    assert.equal(limited.results[0]!.truncated, true);

    const readOnly = await h.run('CREATE TABLE nope (id int)', { readOnly: true, session: 'tab-readonly' });
    assert.equal(readOnly.error?.code, '25006');

    const notice = await h.run("DO $$ BEGIN RAISE NOTICE 'hello %', 42; END $$");
    assert.deepEqual(notice.results[0]!.notices, [{ severity: 'NOTICE', message: 'hello 42' }]);

    const tree = await h.call<DbTreeDto>('GET', '/tree?database=ploy_console_test');
    const publicSchema = tree.body.schemas.find((schema) => schema.name === 'public')!;
    assert.ok(publicSchema.objects.some((object) => object.name === 'people' && object.kind === 'table' && object.comment === 'Everyone'));
    assert.ok(publicSchema.objects.some((object) => object.name === 'people_id_seq' && object.kind === 'sequence'));

    const table = await h.call<DbTableDto>('GET', '/table?database=ploy_console_test&schema=public&name=people');
    assert.equal(table.status, 200, JSON.stringify(table.body));
    assert.deepEqual(table.body.keyColumns, ['id']);
    assert.deepEqual(
      table.body.columns.map((column) => [column.name, column.kind, column.nullable, column.autoIncrement]),
      [
        ['id', 'number', false, true],
        ['name', 'text', false, false],
        ['feeling', 'enum', true, false],
        ['data', 'json', true, false],
        ['born', 'date', true, false],
        ['avatar', 'binary', true, false],
      ],
    );
    assert.deepEqual(table.body.columns[2]!.options, ['happy', 'sad']);
    assert.ok(table.body.indexes.some((index) => index.name === 'people_name' && !index.unique));
    assert.match(table.body.ddl, /CREATE TABLE "public"."people" \(/);
    assert.match(table.body.ddl, /CREATE INDEX people_name ON public.people USING btree \(name\);/);

    const rows = await h.call<DbRowsDto>('POST', '/rows', {
      database: 'ploy_console_test',
      schema: 'public',
      table: 'people',
      filters: [{ column: 'name', op: 'contains', value: 'al' }],
      sort: [{ column: 'id', direction: 'desc' }],
      limit: 50,
    });
    assert.equal(rows.status, 200, JSON.stringify(rows.body));
    assert.deepEqual(
      rows.body.rows.map((row) => row[1]),
      ['Vali', 'Ali'],
    );
    assert.equal(rows.body.total, 2);
    const wildcard = await h.call<DbRowsDto>('POST', '/rows', { database: 'ploy_console_test', schema: 'public', table: 'people', filters: [{ column: 'name', op: 'contains', value: '%' }] });
    assert.equal(wildcard.body.total, 0, 'a % in a filter is a character, not a wildcard');

    const changes = await h.call<DbChangesResultDto>('POST', '/changes', {
      database: 'ploy_console_test',
      schema: 'public',
      table: 'people',
      changes: [
        { kind: 'update', key: { id: '1' }, values: { name: "O'Neil", data: '{"b": 2}' } },
        { kind: 'insert', values: { name: 'Hasan', feeling: 'sad', avatar: '\\x00ff' } },
        { kind: 'delete', key: { id: '2' } },
      ],
    });
    assert.deepEqual(changes.body, { inserted: 1, updated: 1, deleted: 1 });
    const after = (await h.run('SELECT id, name, data, avatar FROM people ORDER BY id')).results[0]!.rows;
    assert.deepEqual(after, [
      ['1', "O'Neil", '{"b": 2}', null],
      ['3', 'Gani', '[1, 2]', null],
      ['4', 'Hasan', null, '\\x00ff'],
    ]);
    const missing = await h.call<ApiErrorBody>('POST', '/changes', { database: 'ploy_console_test', schema: 'public', table: 'people', changes: [{ kind: 'update', key: { id: '999' }, values: { name: 'x' } }] });
    assert.equal(missing.status, 422);
    assert.equal(missing.body.error.code, 'database_error');

    const csv = await h.call<string>('GET', '/export?database=ploy_console_test&schema=public&table=people&format=csv');
    assert.equal(csv.status, 200);
    assert.equal(csv.body.split('\r\n')[0], 'id,name,feeling,data,born,avatar');
    assert.equal(csv.body.split('\r\n')[1], `1,O'Neil,happy,"{""b"": 2}",1990-01-02,`);
    const json = await h.call<{ id: number; name: string; data: unknown }[]>('GET', `/export?database=ploy_console_test&schema=public&table=people&format=json&view=${encodeURIComponent(JSON.stringify({ filters: [{ column: 'id', op: 'gt', value: '1' }] }))}`);
    assert.deepEqual(
      json.body.map((row) => [row.id, row.name, row.data]),
      [
        [3, 'Gani', [1, 2]],
        [4, 'Hasan', null],
      ],
    );

    const activity = await h.call<DbActivityDto>('GET', '/activity');
    assert.ok(activity.body.sessions.some((session) => session.own && session.database === 'ploy_console_test'));
    assert.ok(activity.body.counters.connections >= 2);

    const roles = await h.call<DbRoleDto[]>('GET', '/roles');
    assert.ok(roles.body.some((role) => role.name === 'ploy_console_user' && role.primary && role.superuser));

    // A long query, cancelled from the dashboard.
    const sleeping = h.run('SELECT pg_sleep(20)', { session: 'tab-sleeper' });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const cancelled = await h.call<{ cancelled: boolean }>('POST', '/cancel', { session: 'tab-sleeper' });
    assert.equal(cancelled.body.cancelled, true);
    const stopped = await sleeping;
    assert.equal(stopped.cancelled, true);
    assert.equal(stopped.error?.code, '57014');

    // A query that outlives its time limit.
    const slow = await h.run('SELECT pg_sleep(10)', { session: 'tab-slowpoke', timeoutSec: 1 });
    assert.equal(slow.cancelled, true);
    assert.equal(slow.error?.code, '57014');

    assert.equal((await h.call('POST', '/close', { session: 'tab-slowpoke' })).status, 200);
    await h.ctx.dbConsole.closeService(h.service.id);
    for (let attempt = 0; attempt < 50 && h.containers.size > 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(h.containers.size, 0, 'every tunnel container is removed with its connection');
  } finally {
    await h.close();
    await admin.query('DROP DATABASE IF EXISTS ploy_console_test WITH (FORCE)').catch(() => undefined);
    await admin.query('DROP ROLE IF EXISTS ploy_console_user').catch(() => undefined);
    await admin.query('DROP TYPE IF EXISTS mood').catch(() => undefined);
    await admin.close();
  }
});

test('MySQL: browse, query, edit rows and export through the tunnel', { skip: MYSQL === null ? 'PLOY_TEST_MYSQL is not set' : false }, async () => {
  const admin = await MysqlConnection.connect(await dial(MYSQL!), { user: MYSQL!.user, password: MYSQL!.password });
  await admin.query('DROP DATABASE IF EXISTS ploy_console_test');
  await admin.query('CREATE DATABASE ploy_console_test');
  const h = await harness('mysql', MYSQL!, { username: 'appuser', password: 'unused', database: 'ploy_console_test', rootPassword: MYSQL!.password });
  try {
    const overview = await h.call<DbOverviewDto>('GET', '/overview');
    assert.equal(overview.status, 200, JSON.stringify(overview.body));
    assert.ok(overview.body.databases.some((db) => db.name === 'ploy_console_test' && db.primary));
    assert.ok(overview.body.databases.some((db) => db.name === 'mysql' && db.system));

    const created = await h.run(`
      CREATE TABLE people (id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(40) NOT NULL, feeling ENUM('happy','sad'), data JSON, avatar VARBINARY(8), flags BIT(4), INDEX people_name (name)) COMMENT 'Everyone';
      INSERT INTO people (name, feeling, data, avatar, flags) VALUES ('Ali', 'happy', '{"a": 1}', x'00ff', b'0101'), ('Vali', NULL, NULL, NULL, NULL), ('Gani', 'sad', '[1, 2]', NULL, NULL);
      SELECT id, name, feeling, data, avatar, flags FROM people ORDER BY id;
    `);
    assert.equal(created.error, null, JSON.stringify(created.error));
    assert.deepEqual(created.results.map((result) => result.command), ['CREATE TABLE', 'INSERT', 'SELECT']);
    assert.equal(created.results[1]!.rowCount, 3);
    assert.equal(created.results[1]!.insertId, '1');
    assert.deepEqual(created.results[2]!.rows[0], ['1', 'Ali', 'happy', '{"a": 1}', '0x00ff', '5']);
    assert.deepEqual(
      created.results[2]!.columns!.map((column) => column.kind),
      ['number', 'text', 'enum', 'json', 'binary', 'number'],
    );

    const failed = await h.run('SELECT 1;\nSELEC name FROM people;');
    assert.equal(failed.error?.code, '1064');
    assert.equal('SELECT 1;\nSELEC name FROM people;'.slice(failed.error!.position!).startsWith('SELEC'), true);

    const limited = await h.run('SELECT a.id FROM people a, people b, people c', { limit: 5 });
    assert.equal(limited.results[0]!.rows.length, 5);
    assert.equal(limited.results[0]!.truncated, true);
    const counted = await h.run('SELECT COUNT(*) FROM (SELECT a.id FROM people a, people b, people c) x');
    assert.deepEqual(counted.results[0]!.rows, [['27']], 'the row limit does not reach into subqueries');

    const begun = await h.run("START TRANSACTION; UPDATE people SET name = 'Alisher' WHERE id = 1;");
    assert.equal(begun.transaction, 'open');
    assert.equal((await h.run('ROLLBACK')).transaction, 'idle');

    const warning = await h.run("SELECT CAST('12abc' AS SIGNED)");
    assert.equal(warning.results[0]!.notices.length > 0, true, 'warnings show as notices');

    const table = await h.call<DbTableDto>('GET', '/table?database=ploy_console_test&name=people');
    assert.equal(table.status, 200, JSON.stringify(table.body));
    assert.deepEqual(table.body.keyColumns, ['id']);
    assert.deepEqual(table.body.columns[2]!.options, ['happy', 'sad']);
    assert.match(table.body.ddl, /CREATE TABLE `people`/);
    assert.equal(table.body.comment, 'Everyone');

    const changes = await h.call<DbChangesResultDto>('POST', '/changes', {
      database: 'ploy_console_test',
      schema: null,
      table: 'people',
      changes: [
        { kind: 'update', key: { id: '1' }, values: { name: "O'Neil \\ back", flags: '3', avatar: '0xbeef' } },
        { kind: 'update', key: { id: '3' }, values: { name: 'Gani' } },
        { kind: 'insert', values: { name: 'Hasan' } },
        { kind: 'delete', key: { id: '2' } },
      ],
    });
    assert.equal(changes.status, 200, JSON.stringify(changes.body));
    assert.deepEqual(changes.body, { inserted: 1, updated: 2, deleted: 1 }, 'an update that changes nothing still matched its row');
    const after = (await h.run('SELECT id, name, avatar, flags FROM people ORDER BY id')).results[0]!.rows;
    assert.deepEqual(after, [
      ['1', "O'Neil \\ back", '0xbeef', '3'],
      ['3', 'Gani', null, null],
      ['4', 'Hasan', null, null],
    ]);

    const rows = await h.call<DbRowsDto>('POST', '/rows', { database: 'ploy_console_test', schema: null, table: 'people', filters: [{ column: 'name', op: 'in', value: 'Gani, Hasan' }] });
    assert.deepEqual(
      rows.body.rows.map((row) => row[1]),
      ['Gani', 'Hasan'],
    );
    assert.equal(rows.body.total, 2);

    const sql = await h.call<string>('GET', '/export?database=ploy_console_test&table=people&format=sql');
    assert.match(sql.body, /INSERT INTO `people` \(`id`, `name`, `feeling`, `data`, `avatar`, `flags`\) VALUES \(1, 'O\\'Neil \\\\ back', 'happy', '\{"a": 1\}', X'beef', 3\);/);

    const tree = await h.call<DbTreeDto>('GET', '/tree?database=ploy_console_test');
    assert.ok(tree.body.schemas[0]!.objects.some((object) => object.name === 'people' && object.kind === 'table'));

    const activity = await h.call<DbActivityDto>('GET', '/activity');
    assert.ok(activity.body.sessions.some((session) => session.own));

    const roles = await h.call<DbRoleDto[]>('GET', '/roles');
    assert.ok(roles.body.some((role) => role.name === 'root'));
    assert.ok(!roles.body.some((role) => role.name.startsWith('mysql.')));

    const sleeping = h.run('SELECT SLEEP(20)', { session: 'tab-sleeper' });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal((await h.call<{ cancelled: boolean }>('POST', '/cancel', { session: 'tab-sleeper' })).body.cancelled, true);
    const stopped = await sleeping;
    assert.equal(stopped.cancelled, true);
  } finally {
    await h.close();
    await admin.query('DROP DATABASE IF EXISTS ploy_console_test').catch(() => undefined);
    await admin.close();
  }
});
