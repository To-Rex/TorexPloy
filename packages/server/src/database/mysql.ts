/**
 * A MySQL and MariaDB client speaking the classic client/server protocol over
 * any duplex stream (the console reaches databases through a Docker tunnel).
 *
 * Authentication: caching_sha2_password (MySQL 8 and later, including the
 * RSA exchange a plain connection needs on first login), sha256_password,
 * mysql_native_password (MariaDB and older MySQL) and switching between them
 * mid-handshake. Queries use the text protocol; results with several result
 * sets (CALL) are read in full. A row limit asks the caller to stop the
 * query on the server (KILL QUERY from another connection) rather than
 * pulling every row through the tunnel.
 */
import { constants, createHash, publicEncrypt } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { Builder, ByteQueue, ConnectionClosedError, Cursor, Mutex, send } from './wire.ts';

const CLIENT_LONG_PASSWORD = 0x1;
const CLIENT_LONG_FLAG = 0x4;
const CLIENT_CONNECT_WITH_DB = 0x8;
const CLIENT_PROTOCOL_41 = 0x200;
const CLIENT_TRANSACTIONS = 0x2000;
const CLIENT_SECURE_CONNECTION = 0x8000;
const CLIENT_MULTI_RESULTS = 0x20000;
const CLIENT_PS_MULTI_RESULTS = 0x40000;
const CLIENT_PLUGIN_AUTH = 0x80000;
const CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA = 0x200000;
const CLIENT_DEPRECATE_EOF = 0x1000000;

const SERVER_STATUS_IN_TRANS = 0x1;
const SERVER_MORE_RESULTS_EXISTS = 0x8;
const SERVER_STATUS_NO_BACKSLASH_ESCAPES = 0x200;

/** utf8mb4_general_ci: known to every MySQL since 5.5 and every MariaDB. */
const UTF8MB4 = 45;
const BINARY_CHARSET = 63;
const MAX_PACKET = 0xffffff;

/** Errors that mean the query was stopped on purpose (KILL QUERY, max_execution_time). */
const INTERRUPTED = new Set([1317, 3024, 1969]);

export interface MysqlColumn {
  name: string;
  schema: string;
  table: string;
  orgTable: string;
  orgName: string;
  charset: number;
  length: number;
  type: number;
  flags: number;
  decimals: number;
}

export interface MysqlResult {
  columns: MysqlColumn[] | null;
  rows: (string | null)[][];
  affectedRows: string | null;
  insertId: string | null;
  warnings: number;
  info: string;
  truncated: boolean;
  clipped: [number, number][];
}

export interface MysqlQueryOptions {
  maxRows?: number;
  maxCellBytes?: number;
  maxBytes?: number;
  /** Called once when the limit is passed: the caller stops the query on the server. */
  onOverflow?: () => void;
}

export class MysqlError extends Error {
  readonly errno: number;
  readonly sqlState: string | null;

  constructor(errno: number, sqlState: string | null, message: string) {
    super(message);
    this.name = 'MysqlError';
    this.errno = errno;
    this.sqlState = sqlState;
  }
}

/** Column type codes, by name, for display. */
const TYPE_NAMES: Record<number, string> = {
  0: 'DECIMAL', 1: 'TINYINT', 2: 'SMALLINT', 3: 'INT', 4: 'FLOAT', 5: 'DOUBLE', 6: 'NULL', 7: 'TIMESTAMP', 8: 'BIGINT', 9: 'MEDIUMINT',
  10: 'DATE', 11: 'TIME', 12: 'DATETIME', 13: 'YEAR', 14: 'DATE', 15: 'VARCHAR', 16: 'BIT', 17: 'TIMESTAMP', 18: 'DATETIME', 19: 'TIME',
  242: 'VECTOR', 245: 'JSON', 246: 'DECIMAL', 247: 'ENUM', 248: 'SET', 249: 'TINYBLOB', 250: 'MEDIUMBLOB', 251: 'LONGBLOB', 252: 'BLOB',
  253: 'VARCHAR', 254: 'CHAR', 255: 'GEOMETRY',
};

const BLOB_TYPES = new Set([249, 250, 251, 252]);
const STRING_TYPES = new Set([15, 253, 254]);

export function mysqlTypeName(column: MysqlColumn): string {
  const binary = column.charset === BINARY_CHARSET;
  let name = TYPE_NAMES[column.type] ?? `TYPE ${column.type}`;
  if (column.flags & 0x100) name = 'ENUM';
  else if (column.flags & 0x800) name = 'SET';
  else if (BLOB_TYPES.has(column.type)) name = binary ? name : name.replace('BLOB', 'TEXT');
  else if (STRING_TYPES.has(column.type) && binary) name = column.type === 254 ? 'BINARY' : 'VARBINARY';
  if (column.flags & 0x20) name += ' UNSIGNED';
  return name;
}

/** Values that are bytes rather than text: shown as 0x… hex. */
export function mysqlIsBinary(column: MysqlColumn): boolean {
  if (column.type === 245) return false;
  return column.charset === BINARY_CHARSET && (BLOB_TYPES.has(column.type) || STRING_TYPES.has(column.type) || column.type === 255);
}

const sha1 = (...parts: Buffer[]): Buffer => {
  const hash = createHash('sha1');
  for (const part of parts) hash.update(part);
  return hash.digest();
};
const sha256 = (...parts: Buffer[]): Buffer => {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest();
};
const xor = (a: Buffer, b: Buffer): Buffer => {
  const out = Buffer.alloc(a.length);
  for (let index = 0; index < a.length; index += 1) out[index] = a[index]! ^ b[index % b.length]!;
  return out;
};

function scramble(plugin: string, password: string, nonce: Buffer): Buffer {
  if (password.length === 0) return Buffer.alloc(0);
  const secret = Buffer.from(password, 'utf8');
  if (plugin === 'mysql_native_password') {
    const stage1 = sha1(secret);
    return xor(stage1, sha1(nonce, sha1(stage1)));
  }
  if (plugin === 'caching_sha2_password') {
    const stage1 = sha256(secret);
    return xor(stage1, sha256(sha256(stage1), nonce));
  }
  if (plugin === 'sha256_password') return Buffer.from([1]);
  if (plugin === 'mysql_clear_password') return Buffer.from(`${password}\0`, 'utf8');
  throw new Error(`Unsupported MySQL authentication plugin: ${plugin}`);
}

export interface MysqlConnectOptions {
  user: string;
  password: string;
  database?: string;
}

export class MysqlConnection {
  private readonly queue: ByteQueue;
  private readonly stream: Duplex;
  private readonly lock = new Mutex();
  private sequence = 0;
  private broken: Error | null = null;
  private capabilities = 0;
  private statusFlags = 0;
  threadId = 0;
  serverVersion = '';
  /** MariaDB announces itself in the version string. */
  mariadb = false;

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

  static async connect(stream: Duplex, options: MysqlConnectOptions): Promise<MysqlConnection> {
    const connection = new MysqlConnection(stream);
    try {
      await connection.handshake(options);
      await connection.query('SET NAMES utf8mb4');
    } catch (error) {
      stream.destroy();
      throw error;
    }
    return connection;
  }

  get alive(): boolean {
    return this.broken === null && !this.queue.closed;
  }

  get transaction(): 'idle' | 'open' {
    return this.statusFlags & SERVER_STATUS_IN_TRANS ? 'open' : 'idle';
  }

  /** Whether backslashes are escapes in string literals (they are unless sql_mode has NO_BACKSLASH_ESCAPES). */
  get backslashEscapes(): boolean {
    return (this.statusFlags & SERVER_STATUS_NO_BACKSLASH_ESCAPES) === 0;
  }

  private async readPacket(): Promise<Buffer> {
    const parts: Buffer[] = [];
    for (;;) {
      const header = await this.queue.read(4);
      const length = header.readUIntLE(0, 3);
      this.sequence = (header[3]! + 1) & 0xff;
      parts.push(length > 0 ? await this.queue.read(length) : Buffer.alloc(0));
      if (length < MAX_PACKET) break;
    }
    return parts.length === 1 ? parts[0]! : Buffer.concat(parts);
  }

  private async writePacket(payload: Buffer): Promise<void> {
    const frames: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const size = Math.min(MAX_PACKET, payload.length - offset);
      const header = Buffer.allocUnsafe(4);
      header.writeUIntLE(size, 0, 3);
      header[3] = this.sequence;
      this.sequence = (this.sequence + 1) & 0xff;
      frames.push(header, payload.subarray(offset, offset + size));
      offset += size;
      if (size < MAX_PACKET) break;
    }
    await send(this.stream, Buffer.concat(frames));
  }

  private errorOf(packet: Buffer): MysqlError {
    const cursor = new Cursor(packet);
    cursor.u8();
    const errno = cursor.u16le();
    let sqlState: string | null = null;
    if (cursor.remaining > 0 && packet[cursor.offset] === 0x23) {
      cursor.u8();
      sqlState = cursor.bytes(5).toString('latin1');
    }
    return new MysqlError(errno, sqlState, cursor.rest().toString('utf8'));
  }

  private async handshake(options: MysqlConnectOptions): Promise<void> {
    const greeting = await this.readPacket();
    if (greeting[0] === 0xff) throw this.errorOf(greeting);
    const cursor = new Cursor(greeting);
    const protocol = cursor.u8();
    if (protocol !== 10) throw new Error(`Unsupported MySQL protocol version ${protocol}`);
    this.serverVersion = cursor.cstring();
    this.mariadb = /mariadb/i.test(this.serverVersion);
    this.serverVersion = this.serverVersion.replace(/^5\.5\.5-/, '');
    this.threadId = cursor.u32le();
    let nonce = cursor.bytes(8);
    cursor.u8();
    let serverCaps = cursor.u16le();
    let plugin = 'mysql_native_password';
    if (cursor.remaining > 0) {
      cursor.u8();
      this.statusFlags = cursor.u16le();
      serverCaps |= cursor.u16le() << 16;
      const authLength = cursor.u8();
      cursor.bytes(10);
      if (serverCaps & CLIENT_SECURE_CONNECTION) {
        const part = cursor.bytes(Math.max(13, authLength - 8));
        nonce = Buffer.concat([nonce, part.subarray(0, part.length - 1)]);
      }
      if (serverCaps & CLIENT_PLUGIN_AUTH && cursor.remaining > 0) plugin = cursor.cstring();
    }
    nonce = nonce.subarray(0, 20);

    const wanted =
      CLIENT_LONG_PASSWORD | CLIENT_LONG_FLAG | CLIENT_PROTOCOL_41 | CLIENT_TRANSACTIONS | CLIENT_SECURE_CONNECTION | CLIENT_MULTI_RESULTS |
      CLIENT_PS_MULTI_RESULTS | CLIENT_PLUGIN_AUTH | CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA | CLIENT_DEPRECATE_EOF |
      (options.database !== undefined && options.database.length > 0 ? CLIENT_CONNECT_WITH_DB : 0);
    this.capabilities = wanted & serverCaps;
    if ((this.capabilities & CLIENT_PROTOCOL_41) === 0) throw new Error('The server is too old for the console (protocol 4.1 required)');

    const response = scramble(plugin, options.password, nonce);
    const builder = new Builder().u32le(this.capabilities).u32le(MAX_PACKET).u8(UTF8MB4).zeros(23).cstring(options.user);
    if (this.capabilities & CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA) builder.lenenc(response.length).push(response);
    else builder.u8(response.length).push(response);
    if (this.capabilities & CLIENT_CONNECT_WITH_DB) builder.cstring(options.database!);
    if (this.capabilities & CLIENT_PLUGIN_AUTH) builder.cstring(plugin);
    await this.writePacket(builder.build());

    for (;;) {
      const packet = await this.readPacket();
      const head = packet[0];
      if (head === 0x00) {
        this.readOk(packet);
        return;
      }
      if (head === 0xff) throw this.errorOf(packet);
      if (head === 0xfe) {
        // Auth switch: the account uses another plugin.
        const switchCursor = new Cursor(packet);
        switchCursor.u8();
        plugin = switchCursor.cstring();
        const data = switchCursor.rest();
        nonce = data.subarray(0, data.length > 0 && data[data.length - 1] === 0 ? data.length - 1 : data.length).subarray(0, 20);
        await this.writePacket(scramble(plugin, options.password, nonce));
        continue;
      }
      if (head === 0x01) {
        const more = packet.subarray(1);
        if (plugin === 'caching_sha2_password' && more.length === 1 && more[0] === 3) continue;
        if ((plugin === 'caching_sha2_password' && more.length === 1 && more[0] === 4) || (plugin === 'sha256_password' && more.length === 0)) {
          // Full authentication on a plain connection: fetch the server's RSA key.
          await this.writePacket(Buffer.from([plugin === 'caching_sha2_password' ? 0x02 : 0x01]));
          continue;
        }
        if (more.toString('latin1').startsWith('-----BEGIN')) {
          const encrypted = publicEncrypt({ key: more.toString('latin1'), padding: constants.RSA_PKCS1_OAEP_PADDING }, xor(Buffer.from(`${options.password}\0`, 'utf8'), nonce));
          await this.writePacket(encrypted);
          continue;
        }
        throw new Error('Unexpected authentication data from the server');
      }
      throw new Error(`Unexpected packet during login (0x${(head ?? 0).toString(16)})`);
    }
  }

  private readOk(packet: Buffer): { affectedRows: string | null; insertId: string | null; warnings: number; info: string } {
    const cursor = new Cursor(packet);
    cursor.u8();
    const affectedRows = cursor.lenencText();
    const insertId = cursor.lenencText();
    this.statusFlags = cursor.remaining >= 2 ? cursor.u16le() : this.statusFlags;
    const warnings = cursor.remaining >= 2 ? cursor.u16le() : 0;
    let rest = cursor.remaining > 0 ? cursor.rest() : Buffer.alloc(0);
    // Some servers send the message length-prefixed even without session tracking.
    if (rest.length > 0 && rest[0] === rest.length - 1) rest = rest.subarray(1);
    const info = rest.toString('utf8');
    return { affectedRows, insertId, warnings, info };
  }

  private assertAlive(): void {
    if (this.broken !== null) throw this.broken instanceof ConnectionClosedError ? this.broken : new ConnectionClosedError(this.broken.message);
  }

  /** Run a statement (or a CALL with several result sets). */
  query(sql: string, options: MysqlQueryOptions = {}): Promise<MysqlResult[]> {
    return this.lock.run(async () => {
      this.assertAlive();
      this.sequence = 0;
      await this.writePacket(Buffer.concat([Buffer.from([0x03]), Buffer.from(sql, 'utf8')]));
      const maxRows = options.maxRows ?? 0;
      const maxCell = options.maxCellBytes ?? Number.POSITIVE_INFINITY;
      const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
      const results: MysqlResult[] = [];
      let overflowed = false;
      let kept = 0;
      for (;;) {
        let packet = await this.readPacket();
        if (packet[0] === 0xfb) {
          // LOAD DATA LOCAL INFILE: refuse by sending an empty file.
          await this.writePacket(Buffer.alloc(0));
          packet = await this.readPacket();
        }
        if (packet[0] === 0xff) {
          const error = this.errorOf(packet);
          if (overflowed && INTERRUPTED.has(error.errno) && results.length > 0) {
            results[results.length - 1]!.truncated = true;
            break;
          }
          throw error;
        }
        if (packet[0] === 0x00) {
          const ok = this.readOk(packet);
          results.push({ columns: null, rows: [], ...ok, truncated: false, clipped: [] });
          if (this.statusFlags & SERVER_MORE_RESULTS_EXISTS) continue;
          break;
        }
        const count = new Cursor(packet).lenenc() ?? 0;
        const columns: MysqlColumn[] = [];
        for (let index = 0; index < count; index += 1) columns.push(this.readColumn(await this.readPacket()));
        if ((this.capabilities & CLIENT_DEPRECATE_EOF) === 0) await this.readPacket();
        const binary = columns.map((column) => mysqlIsBinary(column));
        const bits = columns.map((column) => column.type === 16);
        const result: MysqlResult = { columns, rows: [], affectedRows: null, insertId: null, warnings: 0, info: '', truncated: false, clipped: [] };
        results.push(result);
        let interrupted = false;
        for (;;) {
          const row = await this.readPacket();
          const head = row[0];
          if (head === 0xfe && (this.capabilities & CLIENT_DEPRECATE_EOF ? row.length < MAX_PACKET : row.length < 9)) {
            if (this.capabilities & CLIENT_DEPRECATE_EOF) {
              const ok = this.readOk(row);
              result.warnings = ok.warnings;
            } else {
              const cursor = new Cursor(row);
              cursor.u8();
              result.warnings = cursor.u16le();
              this.statusFlags = cursor.u16le();
            }
            break;
          }
          if (head === 0xff) {
            const error = this.errorOf(row);
            if (overflowed && INTERRUPTED.has(error.errno)) {
              result.truncated = true;
              interrupted = true;
              break;
            }
            throw error;
          }
          if ((maxRows > 0 && result.rows.length >= maxRows) || kept >= maxBytes) {
            result.truncated = true;
            if (!overflowed) {
              overflowed = true;
              options.onOverflow?.();
            }
            continue;
          }
          const cursor = new Cursor(row);
          const values: (string | null)[] = new Array(count);
          for (let index = 0; index < count; index += 1) {
            const bytes = cursor.lenencBytes();
            if (bytes === null) {
              values[index] = null;
              continue;
            }
            let value: string;
            if (bits[index]) {
              let number = 0n;
              for (const byte of bytes) number = (number << 8n) | BigInt(byte);
              value = number.toString();
            } else if (binary[index]) {
              const shown = bytes.length > maxCell / 2 ? bytes.subarray(0, Math.floor(maxCell / 2)) : bytes;
              if (shown !== bytes) result.clipped.push([result.rows.length, index]);
              value = `0x${shown.toString('hex')}`;
            } else if (bytes.length > maxCell) {
              value = bytes.toString('utf8', 0, maxCell);
              result.clipped.push([result.rows.length, index]);
            } else value = bytes.toString('utf8');
            kept += value.length;
            values[index] = value;
          }
          result.rows.push(values);
        }
        result.affectedRows = String(result.rows.length);
        if (interrupted) break;
        if (this.statusFlags & SERVER_MORE_RESULTS_EXISTS) continue;
        break;
      }
      return results;
    });
  }

  private readColumn(packet: Buffer): MysqlColumn {
    const cursor = new Cursor(packet);
    cursor.lenencString();
    const schema = cursor.lenencString() ?? '';
    const table = cursor.lenencString() ?? '';
    const orgTable = cursor.lenencString() ?? '';
    const name = cursor.lenencString() ?? '';
    const orgName = cursor.lenencString() ?? '';
    cursor.lenenc();
    const charset = cursor.u16le();
    const length = cursor.u32le();
    const type = cursor.u8();
    const flags = cursor.u16le();
    const decimals = cursor.u8();
    return { name, schema, table, orgTable, orgName, charset, length, type, flags, decimals };
  }

  /** COM_INIT_DB: switch the default database. */
  useDatabase(name: string): Promise<void> {
    return this.lock.run(async () => {
      this.assertAlive();
      this.sequence = 0;
      await this.writePacket(Buffer.concat([Buffer.from([0x02]), Buffer.from(name, 'utf8')]));
      const packet = await this.readPacket();
      if (packet[0] === 0xff) throw this.errorOf(packet);
      this.readOk(packet);
    });
  }

  /** A string literal, escaped the way this session's SQL mode reads it. */
  literal(value: string | null): string {
    if (value === null) return 'NULL';
    if (!this.backslashEscapes) return `'${value.replace(/'/g, "''")}'`;
    return `'${value.replace(/[\0\n\r\b\t\x1a'"\\]/g, (char) => {
      switch (char) {
        case '\0':
          return '\\0';
        case '\n':
          return '\\n';
        case '\r':
          return '\\r';
        case '\b':
          return '\\b';
        case '\t':
          return '\\t';
        case '\x1a':
          return '\\Z';
        default:
          return `\\${char}`;
      }
    })}'`;
  }

  async close(): Promise<void> {
    if (this.alive) {
      this.sequence = 0;
      await this.writePacket(Buffer.from([0x01])).catch(() => undefined);
    }
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
