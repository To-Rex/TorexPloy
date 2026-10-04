import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cpuPercent, DockerClient, DockerError, DockerStreamDemuxer, memoryUsage, type StatsSample } from './client.ts';

/** Engine API wire format for multiplexed streams. */
function frame(stream: 1 | 2, payload: Buffer | string): Buffer {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

interface Recorded {
  method: string;
  url: string;
  body: string;
}

/** A unix-socket HTTP server speaking just enough of the Engine API to exercise the client's protocol handling. */
async function fakeDaemon(handler: (req: IncomingMessage, res: ServerResponse, body: Buffer) => void): Promise<{ socket: string; server: Server; calls: Recorded[]; close: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'ploy-docker-'));
  const socket = join(dir, 'docker.sock');
  const calls: Recorded[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      calls.push({ method: req.method ?? '', url: req.url ?? '', body: body.toString('utf8') });
      if (req.url === '/version') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ Version: '28.0.1', ApiVersion: '1.49', Os: 'linux', Arch: 'amd64' }));
        return;
      }
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  return { socket, server, calls, close: () => { server.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('negotiates and pins the API version, capping newer daemons', async () => {
  const daemon = await fakeDaemon((_req, res) => res.end('[]'));
  const client = new DockerClient(daemon.socket);
  try {
    await client.listContainers({ label: ['ploy.managed=true'] });
    const list = daemon.calls.find((call) => call.url.startsWith('/v1.47/containers/json'));
    assert.ok(list, 'requests are prefixed with the pinned version');
    assert.match(decodeURIComponent(list.url), /filters=\{"label":\["ploy\.managed=true"\]\}/);
  } finally {
    client.close();
    daemon.close();
  }
});

test('maps API errors to DockerError and treats "already gone" as success', async () => {
  const daemon = await fakeDaemon((req, res) => {
    res.statusCode = req.method === 'DELETE' ? 404 : 409;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ message: req.method === 'DELETE' ? 'No such container: x' : 'Conflict. The container name is already in use' }));
  });
  const client = new DockerClient(daemon.socket);
  try {
    await client.removeContainer('x'); // 404 is the desired end state
    await assert.rejects(client.createContainer('x', {}), (error: unknown) => error instanceof DockerError && error.isConflict && /already in use/.test(error.message));
  } finally {
    client.close();
    daemon.close();
  }
});

test('surfaces pull failures reported inside a 200 progress stream', async () => {
  const daemon = await fakeDaemon((_req, res) => {
    res.write(`${JSON.stringify({ status: 'Pulling from library/nope' })}\n`);
    res.end(`${JSON.stringify({ errorDetail: { message: 'manifest unknown' }, error: 'manifest unknown' })}\n`);
  });
  const client = new DockerClient(daemon.socket);
  const lines: string[] = [];
  try {
    await assert.rejects(client.pullImage('nope:1', (line) => lines.push(line)), /manifest unknown/);
    assert.deepEqual(lines, ['Pulling from library/nope']);
    assert.ok(daemon.calls.some((call) => call.url.includes('fromImage=nope&tag=1')));
  } finally {
    client.close();
    daemon.close();
  }
});

test('exec demultiplexes stdout/stderr frames split across packets and reports the exit code', async () => {
  const daemon = await fakeDaemon((req, res) => {
    if (req.url?.endsWith('/exec')) {
      res.end(JSON.stringify({ Id: 'exec1' }));
    } else if (req.url?.endsWith('/exec/exec1/start')) {
      res.setHeader('content-type', 'application/vnd.docker.multiplexed-stream');
      const data = Buffer.concat([frame(1, 'hello '), frame(2, 'warn\n'), frame(1, 'wörld\n')]);
      // Deliberately split mid-header and mid-multibyte character.
      res.write(data.subarray(0, 5));
      setTimeout(() => {
        res.write(data.subarray(5, 30));
        res.end(data.subarray(30));
      }, 5);
    } else if (req.url?.endsWith('/exec/exec1/json')) {
      res.end(JSON.stringify({ ExitCode: 3, Running: false }));
    }
  });
  const client = new DockerClient(daemon.socket);
  try {
    const result = await client.exec('ploy-proxy', ['wget', '-q', 'http://x']);
    assert.deepEqual(result, { exitCode: 3, stdout: 'hello wörld\n', stderr: 'warn\n' });
    const create = daemon.calls.find((call) => call.url.endsWith('/containers/ploy-proxy/exec'));
    assert.deepEqual(JSON.parse(create!.body).Cmd, ['wget', '-q', 'http://x']);
  } finally {
    client.close();
    daemon.close();
  }
});

test('raw demux keeps binary payloads byte-exact (database dumps)', async () => {
  const binary = Buffer.from([0x50, 0x47, 0x44, 0x4d, 0x50, 0xff, 0xfe, 0x00, 0xc3, 0x28]);
  const demux = new DockerStreamDemuxer({ raw: true });
  const chunks: Buffer[] = [];
  demux.on('data', (chunk: { stream: string; data: Buffer }) => {
    if (chunk.stream === 'stdout') chunks.push(chunk.data);
  });
  const done = new Promise((resolve) => demux.on('end', resolve));
  const wire = Buffer.concat([frame(1, binary.subarray(0, 4)), frame(2, 'pg_dump: notice'), frame(1, binary.subarray(4))]);
  for (let i = 0; i < wire.length; i += 3) demux.write(wire.subarray(i, i + 3));
  demux.end();
  await done;
  assert.deepEqual(Buffer.concat(chunks), binary);
});

test('archive uploads carry the tar body and target path', async () => {
  const daemon = await fakeDaemon((_req, res) => res.end());
  const client = new DockerClient(daemon.socket);
  try {
    await client.putArchive('ploy-proxy', '/etc/caddy', Buffer.from('tar-bytes'));
    const call = daemon.calls.find((candidate) => candidate.method === 'PUT');
    assert.ok(call);
    assert.match(call.url, /\/containers\/ploy-proxy\/archive\?path=%2Fetc%2Fcaddy/);
    assert.equal(call.body, 'tar-bytes');
  } finally {
    client.close();
    daemon.close();
  }
});

test('an unreachable socket reports Docker as unavailable instead of crashing', async () => {
  const client = new DockerClient('/nonexistent/docker.sock');
  assert.equal(await client.ping(), false);
  await assert.rejects(client.info(), /not reachable/);
  client.close();
});

test('CPU and memory math matches docker stats semantics', () => {
  const sample = (total: number, system: number, usage: number, inactive: number): StatsSample => ({
    read: '',
    cpu_stats: { cpu_usage: { total_usage: total }, system_cpu_usage: system, online_cpus: 4 },
    memory_stats: { usage, limit: 1_000, stats: { inactive_file: inactive } },
  });
  // 0.5 of total system time across 4 CPUs = 200% (two full cores).
  assert.equal(cpuPercent(sample(100, 1_000, 0, 0), sample(600, 2_000, 0, 0)), 200);
  assert.equal(cpuPercent(sample(100, 1_000, 0, 0), sample(100, 1_000, 0, 0)), 0);
  assert.equal(memoryUsage(sample(0, 0, 500, 120)), 380);
});
