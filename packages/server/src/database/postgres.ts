/**
 * A PostgreSQL client speaking protocol 3.0 over any duplex stream.
 *
 * The console reaches databases through a Docker tunnel rather than a TCP
 * socket of its own, so it needs a client that takes a stream it is handed.
 * It covers what the console uses: SCRAM-SHA-256, md5 and cleartext
 * authentication; the extended query protocol with text parameters (values
 * never travel inside SQL); a row limit that stops the server producing rows
 * instead of discarding them here; batched reading for exports; COPY TO
 * STDOUT output; notices; transaction status; and query cancellation.
 */
import { createHash, createHmac, pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { promisify } from 'node:util';
import { Builder, ByteQueue, ConnectionClosedError, Cursor, Mutex, send } from './wire.ts';

const pbkdf2Async = promisify(pbkdf2);

export interface PgField {
  name: string;
  tableOid: number;
  column: number;
  typeOid: number;
  typmod: number;
}

export interface PgNotice {
  severity: string;
  message: string;
}

export interface PgResult {
  command: string;
  rowCount: number | null;
  fields: PgField[] | null;
  rows: (string | null)[][];
  truncated: boolean;
  clipped: [number, number][];
  notices: PgNotice[];
}

export interface PgQueryOptions {
  /** Keep at most this many rows; the server is told to stop after one more. */
  maxRows?: number;
  /** Cells longer than this many bytes are shortened. */
  maxCellBytes?: number;
  /** Stop keeping rows once this many bytes have been kept. */
  maxBytes?: number;
}

/** An ErrorResponse, with every field the server sent. */
export class PgError extends Error {
  readonly severity: string;
  readonly code: string | null;
  readonly detail: string | null;
  readonly hint: string | null;
  /** 1-based character position in the statement. */
  readonly position: number | null;
  readonly fields: Record<string, string>;

  constructor(fields: Record<string, string>) {
    super(fields.M ?? 'PostgreSQL error');
    this.name = 'PgError';
    this.fields = fields;
    this.severity = fields.V ?? fields.S ?? 'ERROR';
    this.code = fields.C ?? null;
    this.detail = fields.D ?? null;
    this.hint = fields.H ?? null;
    this.position = fields.P === undefined ? null : Number(fields.P);
  }

  get fatal(): boolean {
    return this.severity === 'FATAL' || this.severity === 'PANIC';
  }
}

function parseFields(cursor: Cursor): Record<string, string> {
  const fields: Record<string, string> = {};
  while (cursor.remaining > 0) {
    const code = cursor.u8();
    if (code === 0) break;
    fields[String.fromCharCode(code)] = cursor.cstring();
  }
  return fields;
}

function message(type: string, body?: (builder: Builder) => void): Buffer {
  const inner = new Builder();
  body?.(inner);
  const payload = inner.build();
  const out = Buffer.allocUnsafe(5 + payload.length);
  out.write(type, 0, 'latin1');
  out.writeInt32BE(4 + payload.length, 1);
  payload.copy(out, 5);
  return out;
}

const md5 = (value: string | Buffer): string => createHash('md5').update(value).digest('hex');
const hmac = (key: Buffer, value: string): Buffer => createHmac('sha256', key).update(value).digest();

/** Split a CommandComplete tag into the command and its row count ("INSERT 0 5" → INSERT, 5). */
export function parseCommandTag(tag: string): { command: string; rowCount: number | null } {
  const match = /^([A-Z][A-Z ]*?)(?: (\d+))?(?: (\d+))?$/.exec(tag);
  if (match === null) return { command: tag, rowCount: null };
  const command = match[1]!;
  const count = match[3] ?? match[2];
  return { command, rowCount: count === undefined ? null : Number(count) };
}

export interface PgConnectOptions {
  user: string;
  password: string;
  database: string;
  applicationName?: string;
}

export class PgConnection {
  private readonly queue: ByteQueue;
  private readonly lock = new Mutex();
  private status: 'I' | 'T' | 'E' = 'I';
  private notices: PgNotice[] = [];
  private broken: Error | null = null;
  readonly parameters = new Map<string, string>();
  processId = 0;
  secretKey = 0;
  private readonly stream: Duplex;

  private constructor(stream: Duplex) {
    this.stream = stream;
    this.queue = new ByteQueue(stream);
    stream.on('error', (error: Error) => {
      this.broken ??= error;
    });
    stream.on('close', () => {
      this.broken ??= new ConnectionClosedError();
    });
  }

  static async connect(stream: Duplex, options: PgConnectOptions): Promise<PgConnection> {
    const connection = new PgConnection(stream);
    try {
      await connection.startup(options);
    } catch (error) {
      stream.destroy();
      throw error;
    }
    return connection;
  }

  get transaction(): 'idle' | 'open' | 'failed' {
    return this.status === 'T' ? 'open' : this.status === 'E' ? 'failed' : 'idle';
  }

  get alive(): boolean {
    return this.broken === null && !this.queue.closed;
  }

  get serverVersion(): string {
    return this.parameters.get('server_version') ?? '';
  }

  private async next(): Promise<{ type: string; body: Cursor }> {
    for (;;) {
      const header = await this.queue.read(5);
      const type = String.fromCharCode(header[0]!);
      const length = header.readInt32BE(1);
      const body = new Cursor(length > 4 ? await this.queue.read(length - 4) : Buffer.alloc(0));
      if (type === 'N') {
        const fields = parseFields(body);
        this.notices.push({ severity: fields.V ?? fields.S ?? 'NOTICE', message: fields.M ?? '' });
        continue;
      }
      if (type === 'S') {
        const name = body.cstring();
        this.parameters.set(name, body.cstring());
        continue;
      }
      if (type === 'A') continue;
      return { type, body };
    }
  }

  private async startup(options: PgConnectOptions): Promise<void> {
    const params = new Builder()
      .i32(196_608)
      .cstring('user')
      .cstring(options.user)
      .cstring('database')
      .cstring(options.database)
      .cstring('application_name')
      .cstring(options.applicationName ?? 'TorexPloy console')
      .cstring('client_encoding')
      .cstring('UTF8')
      .cstring('DateStyle')
      .cstring('ISO, YMD')
      .u8(0)
      .build();
    const startup = Buffer.allocUnsafe(4 + params.length);
    startup.writeInt32BE(4 + params.length);
    params.copy(startup, 4);
    await send(this.stream, startup);

    let scram: { nonce: string; clientFirstBare: string; serverSignature?: Buffer } | null = null;
    for (;;) {
      const { type, body } = await this.next();
      if (type === 'E') throw new PgError(parseFields(body));
      if (type === 'K') {
        this.processId = body.i32();
        this.secretKey = body.i32();
        continue;
      }
      if (type === 'Z') {
        this.status = String.fromCharCode(body.u8()) as 'I' | 'T' | 'E';
        this.notices = [];
        return;
      }
      if (type === 'v') continue;
      if (type !== 'R') throw new Error(`Unexpected message during startup: ${type}`);
      const code = body.i32();
      if (code === 0) continue;
      if (code === 3) {
        await send(this.stream, message('p', (b) => b.cstring(options.password)));
      } else if (code === 5) {
        const salt = body.bytes(4);
        const inner = md5(options.password + options.user);
        await send(this.stream, message('p', (b) => b.cstring(`md5${md5(Buffer.concat([Buffer.from(inner), salt]))}`)));
      } else if (code === 10) {
        const mechanisms: string[] = [];
        for (let name = body.cstring(); name.length > 0; name = body.cstring()) mechanisms.push(name);
        if (!mechanisms.includes('SCRAM-SHA-256')) throw new Error(`The server offers no supported SASL mechanism (${mechanisms.join(', ')})`);
        const nonce = randomBytes(18).toString('base64');
        const clientFirstBare = `n=*,r=${nonce}`;
        scram = { nonce, clientFirstBare };
        const data = Buffer.from(`n,,${clientFirstBare}`);
        await send(this.stream, message('p', (b) => b.cstring('SCRAM-SHA-256').i32(data.length).push(data)));
      } else if (code === 11) {
        if (scram === null) throw new Error('Unexpected SASL continuation');
        const serverFirst = body.rest().toString('utf8');
        const attributes = Object.fromEntries(serverFirst.split(',').map((part) => [part.slice(0, 1), part.slice(2)]));
        const serverNonce = attributes.r ?? '';
        if (!serverNonce.startsWith(scram.nonce)) throw new Error('The server answered SCRAM with a foreign nonce');
        const salt = Buffer.from(attributes.s ?? '', 'base64');
        const iterations = Number(attributes.i);
        if (!Number.isInteger(iterations) || iterations < 1) throw new Error('The server sent an invalid SCRAM iteration count');
        const salted = await pbkdf2Async(options.password.normalize('NFKC'), salt, iterations, 32, 'sha256');
        const clientKey = hmac(salted, 'Client Key');
        const storedKey = createHash('sha256').update(clientKey).digest();
        const clientFinalBare = `c=biws,r=${serverNonce}`;
        const authMessage = `${scram.clientFirstBare},${serverFirst},${clientFinalBare}`;
        const signature = hmac(storedKey, authMessage);
        const proof = Buffer.alloc(clientKey.length);
        for (let index = 0; index < clientKey.length; index += 1) proof[index] = clientKey[index]! ^ signature[index]!;
        scram.serverSignature = hmac(hmac(salted, 'Server Key'), authMessage);
        await send(this.stream, message('p', (b) => b.push(Buffer.from(`${clientFinalBare},p=${proof.toString('base64')}`))));
      } else if (code === 12) {
        const final = body.rest().toString('utf8');
        const verifier = /(?:^|,)v=([^,]+)/.exec(final)?.[1];
        const expected = scram?.serverSignature;
        const received = verifier === undefined ? Buffer.alloc(0) : Buffer.from(verifier, 'base64');
        if (expected === undefined || received.length !== expected.length || !timingSafeEqual(received, expected)) {
          throw new Error('The server could not prove it knows the password (SCRAM signature mismatch)');
        }
      } else {
        throw new Error(`Unsupported PostgreSQL authentication method (${code})`);
      }
    }
  }

  private assertAlive(): void {
    if (this.broken !== null) throw this.broken instanceof ConnectionClosedError ? this.broken : new ConnectionClosedError(this.broken.message);
  }

  /**
   * Run one statement with optional text parameters. Errors arrive as
   * PgError after the server is ready again, so the connection stays usable.
   */
  query(sql: string, params: (string | null)[] = [], options: PgQueryOptions = {}): Promise<PgResult> {
    return this.lock.run(async () => {
      this.assertAlive();
      const maxRows = options.maxRows ?? 0;
      const maxCell = options.maxCellBytes ?? Number.POSITIVE_INFINITY;
      const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
      this.notices = [];
      await send(this.stream, Buffer.concat([...this.extended(sql, params), message('E', (b) => b.cstring('').i32(maxRows > 0 ? maxRows + 1 : 0)), message('S')]));

      let fields: PgField[] | null = null;
      const rows: (string | null)[][] = [];
      const clipped: [number, number][] = [];
      let kept = 0;
      let truncated = false;
      let command = '';
      let rowCount: number | null = null;
      let error: PgError | null = null;
      let copying = false;
      for (;;) {
        const { type, body } = await this.next();
        if (type === '1' || type === '2' || type === '3') continue;
        if (type === 'T') fields = this.parseRowDescription(body);
        else if (type === 'n') fields = null;
        else if (type === 'D') {
          if ((maxRows > 0 && rows.length >= maxRows) || kept >= maxBytes) {
            truncated = true;
            continue;
          }
          const count = body.i16();
          const row: (string | null)[] = new Array(count);
          for (let column = 0; column < count; column += 1) {
            const length = body.i32();
            if (length < 0) {
              row[column] = null;
              continue;
            }
            const bytes = body.bytes(length);
            if (length > maxCell) {
              row[column] = bytes.toString('utf8', 0, maxCell);
              clipped.push([rows.length, column]);
              kept += maxCell;
            } else {
              row[column] = bytes.toString('utf8');
              kept += length;
            }
          }
          rows.push(row);
        } else if (type === 'C') {
          ({ command, rowCount } = parseCommandTag(body.cstring()));
        } else if (type === 's') truncated = true;
        else if (type === 'I') command = '';
        else if (type === 'E') {
          error = new PgError(parseFields(body));
          if (error.fatal) this.broken = error;
        } else if (type === 'G') {
          // COPY FROM STDIN: the console has no file to send.
          await send(this.stream, Buffer.concat([message('f', (b) => b.cstring('COPY FROM STDIN is not available in the console')), message('S')]));
        } else if (type === 'H') {
          copying = true;
          fields = [{ name: 'copy', tableOid: 0, column: 0, typeOid: 25, typmod: -1 }];
        } else if (type === 'd' && copying) {
          if ((maxRows > 0 && rows.length >= maxRows) || kept >= maxBytes) truncated = true;
          else {
            const line = body.rest().toString('utf8').replace(/\n$/, '');
            kept += line.length;
            rows.push([line]);
          }
        } else if (type === 'c') copying = false;
        else if (type === 'Z') {
          this.status = String.fromCharCode(body.u8()) as 'I' | 'T' | 'E';
          break;
        }
      }
      const notices = this.notices;
      this.notices = [];
      if (error !== null) {
        (error as PgError & { notices?: PgNotice[] }).notices = notices;
        throw error;
      }
      if (fields !== null && rowCount === null) rowCount = rows.length;
      return { command, rowCount, fields, rows, truncated, clipped, notices };
    });
  }

  /**
   * Read a query's rows in batches without holding them all: the server
   * produces the next batch only when asked, so memory stays flat however
   * large the table.
   */
  each(sql: string, params: (string | null)[], batch: number, onBatch: (fields: PgField[], rows: (string | null)[][]) => Promise<void>): Promise<number> {
    return this.lock.run(async () => {
      this.assertAlive();
      this.notices = [];
      const execute = message('E', (b) => b.cstring('').i32(batch));
      const flush = message('H');
      await send(this.stream, Buffer.concat([...this.extended(sql, params), execute, flush]));
      let fields: PgField[] = [];
      let total = 0;
      let synced = false;
      let error: PgError | null = null;
      const finish = async (): Promise<void> => {
        if (!synced) {
          synced = true;
          await send(this.stream, message('S'));
        }
        for (;;) {
          const { type, body } = await this.next();
          if (type === 'E') error ??= new PgError(parseFields(body));
          if (type === 'Z') {
            this.status = String.fromCharCode(body.u8()) as 'I' | 'T' | 'E';
            return;
          }
        }
      };
      try {
        let rows: (string | null)[][] = [];
        for (;;) {
          const { type, body } = await this.next();
          if (type === '1' || type === '2') continue;
          if (type === 'T') fields = this.parseRowDescription(body);
          else if (type === 'n') fields = [];
          else if (type === 'D') {
            const count = body.i16();
            const row: (string | null)[] = new Array(count);
            for (let column = 0; column < count; column += 1) {
              const length = body.i32();
              row[column] = length < 0 ? null : body.bytes(length).toString('utf8');
            }
            rows.push(row);
          } else if (type === 's' || type === 'C') {
            total += rows.length;
            if (rows.length > 0) await onBatch(fields, rows);
            rows = [];
            if (type === 'C') break;
            await send(this.stream, Buffer.concat([execute, flush]));
          } else if (type === 'E') {
            error = new PgError(parseFields(body));
            break;
          }
        }
      } finally {
        await finish();
      }
      if (error !== null) throw error;
      return total;
    });
  }

  private extended(sql: string, params: (string | null)[]): Buffer[] {
    return [
      message('P', (b) => b.cstring('').cstring(sql).i16(0)),
      message('B', (b) => {
        b.cstring('').cstring('').i16(0).i16(params.length);
        for (const value of params) {
          if (value === null) b.i32(-1);
          else {
            const bytes = Buffer.from(value, 'utf8');
            b.i32(bytes.length).push(bytes);
          }
        }
        b.i16(0);
      }),
      message('D', (b) => b.u8('P'.charCodeAt(0)).cstring('')),
    ];
  }

  private parseRowDescription(body: Cursor): PgField[] {
    const count = body.i16();
    const fields: PgField[] = [];
    for (let index = 0; index < count; index += 1) {
      const name = body.cstring();
      const tableOid = body.i32();
      const column = body.i16();
      const typeOid = body.i32();
      body.i16();
      const typmod = body.i32();
      body.i16();
      fields.push({ name, tableOid, column, typeOid, typmod });
    }
    return fields;
  }

  /** Say goodbye and close the stream. */
  async close(): Promise<void> {
    if (this.alive) await send(this.stream, message('X')).catch(() => undefined);
    this.broken ??= new ConnectionClosedError();
    this.queue.abort(this.broken);
    this.stream.end();
    setTimeout(() => this.stream.destroy(), 1_000).unref();
  }

  destroy(): void {
    this.broken ??= new ConnectionClosedError();
    this.queue.abort(this.broken);
    this.stream.destroy();
  }
}

/** Ask the server to cancel whatever the given backend is running (a CancelRequest on a fresh connection). */
export async function pgCancel(stream: Duplex, processId: number, secretKey: number): Promise<void> {
  const request = Buffer.allocUnsafe(16);
  request.writeInt32BE(16, 0);
  request.writeInt32BE(80_877_102, 4);
  request.writeInt32BE(processId, 8);
  request.writeInt32BE(secretKey, 12);
  try {
    await send(stream, request);
    await new Promise<void>((resolve) => {
      const done = (): void => resolve();
      stream.once('close', done);
      stream.once('end', done);
      stream.resume();
      setTimeout(done, 3_000).unref();
    });
  } finally {
    stream.destroy();
  }
}
