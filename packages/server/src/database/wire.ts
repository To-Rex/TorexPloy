/**
 * Byte-level plumbing shared by the PostgreSQL and MySQL clients: a pull
 * reader over a duplex stream (so a slow consumer leaves bytes in the socket
 * and TCP pushes back), and cursor helpers for parsing and building messages.
 */
import type { Duplex } from 'node:stream';

export class ConnectionClosedError extends Error {
  constructor(message = 'The database connection closed') {
    super(message);
    this.name = 'ConnectionClosedError';
  }
}

const HIGH_WATER = 4 * 1024 * 1024;
const LOW_WATER = 1024 * 1024;

/** Read exact byte counts from a stream, waiting as needed. */
export class ByteQueue {
  private chunks: Buffer[] = [];
  private size = 0;
  private wake: (() => void) | null = null;
  private failure: Error | null = null;
  private ended = false;
  private readonly source: Duplex;

  constructor(source: Duplex) {
    this.source = source;
    source.on('data', (chunk: Buffer) => {
      this.chunks.push(chunk);
      this.size += chunk.length;
      if (this.size > HIGH_WATER) source.pause();
      this.notify();
    });
    source.on('end', () => this.finish());
    source.on('close', () => this.finish());
    source.on('error', (error: Error) => {
      this.failure ??= error;
      this.notify();
    });
  }

  get closed(): boolean {
    return this.ended || this.failure !== null;
  }

  /** Fail pending and future reads with this error (used when the connection is torn down on purpose). */
  abort(error: Error): void {
    this.failure ??= error;
    this.notify();
  }

  private finish(): void {
    this.ended = true;
    this.notify();
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  async read(count: number): Promise<Buffer> {
    while (this.size < count) {
      if (this.failure !== null) throw this.failure;
      if (this.ended) throw new ConnectionClosedError();
      if (this.source.isPaused()) this.source.resume();
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
    let out: Buffer;
    const first = this.chunks[0]!;
    if (first.length >= count) {
      out = first.subarray(0, count);
      if (first.length === count) this.chunks.shift();
      else this.chunks[0] = first.subarray(count);
    } else {
      out = Buffer.allocUnsafe(count);
      let filled = 0;
      while (filled < count) {
        const chunk = this.chunks[0]!;
        const take = Math.min(chunk.length, count - filled);
        chunk.copy(out, filled, 0, take);
        filled += take;
        if (take === chunk.length) this.chunks.shift();
        else this.chunks[0] = chunk.subarray(take);
      }
    }
    this.size -= count;
    if (this.size < LOW_WATER && this.source.isPaused()) this.source.resume();
    return out;
  }
}

/** A cursor over one message. */
export class Cursor {
  offset = 0;
  readonly buffer: Buffer;

  constructor(buffer: Buffer) {
    this.buffer = buffer;
  }

  get remaining(): number {
    return this.buffer.length - this.offset;
  }

  u8(): number {
    const value = this.buffer.readUInt8(this.offset);
    this.offset += 1;
    return value;
  }

  i16(): number {
    const value = this.buffer.readInt16BE(this.offset);
    this.offset += 2;
    return value;
  }

  i32(): number {
    const value = this.buffer.readInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  u16le(): number {
    const value = this.buffer.readUInt16LE(this.offset);
    this.offset += 2;
    return value;
  }

  u24le(): number {
    const value = this.buffer.readUIntLE(this.offset, 3);
    this.offset += 3;
    return value;
  }

  u32le(): number {
    const value = this.buffer.readUInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  bytes(count: number): Buffer {
    const value = this.buffer.subarray(this.offset, this.offset + count);
    this.offset += count;
    return value;
  }

  rest(): Buffer {
    return this.bytes(this.remaining);
  }

  /** NUL-terminated string. */
  cstring(): string {
    const end = this.buffer.indexOf(0, this.offset);
    const stop = end === -1 ? this.buffer.length : end;
    const value = this.buffer.toString('utf8', this.offset, stop);
    this.offset = end === -1 ? stop : stop + 1;
    return value;
  }

  /** MySQL length-encoded integer; null for the NULL marker (0xfb). Returned as a number when exact, else as a string. */
  lenenc(): number | null {
    const first = this.u8();
    if (first < 0xfb) return first;
    if (first === 0xfb) return null;
    if (first === 0xfc) return this.u16le();
    if (first === 0xfd) return this.u24le();
    const low = this.u32le();
    const high = this.u32le();
    return high * 0x1_0000_0000 + low;
  }

  /** MySQL length-encoded integer as a decimal string (row counts and insert ids can exceed 2^53). */
  lenencText(): string | null {
    const first = this.buffer[this.offset];
    if (first === 0xfe) {
      this.offset += 1;
      const value = this.buffer.readBigUInt64LE(this.offset);
      this.offset += 8;
      return value.toString();
    }
    const value = this.lenenc();
    return value === null ? null : String(value);
  }

  lenencBytes(): Buffer | null {
    const length = this.lenenc();
    return length === null ? null : this.bytes(length);
  }

  lenencString(): string | null {
    const bytes = this.lenencBytes();
    return bytes === null ? null : bytes.toString('utf8');
  }
}

/** Builds a message from parts. */
export class Builder {
  private parts: Buffer[] = [];
  private size = 0;

  push(buffer: Buffer): this {
    this.parts.push(buffer);
    this.size += buffer.length;
    return this;
  }

  u8(value: number): this {
    return this.push(Buffer.from([value]));
  }

  i16(value: number): this {
    const buffer = Buffer.allocUnsafe(2);
    buffer.writeInt16BE(value);
    return this.push(buffer);
  }

  i32(value: number): this {
    const buffer = Buffer.allocUnsafe(4);
    buffer.writeInt32BE(value);
    return this.push(buffer);
  }

  u32le(value: number): this {
    const buffer = Buffer.allocUnsafe(4);
    buffer.writeUInt32LE(value >>> 0);
    return this.push(buffer);
  }

  cstring(value: string): this {
    return this.push(Buffer.from(`${value}\0`, 'utf8'));
  }

  zeros(count: number): this {
    return this.push(Buffer.alloc(count));
  }

  lenenc(value: number): this {
    if (value < 0xfb) return this.u8(value);
    if (value <= 0xffff) {
      const buffer = Buffer.allocUnsafe(3);
      buffer[0] = 0xfc;
      buffer.writeUInt16LE(value, 1);
      return this.push(buffer);
    }
    if (value <= 0xffffff) {
      const buffer = Buffer.allocUnsafe(4);
      buffer[0] = 0xfd;
      buffer.writeUIntLE(value, 1, 3);
      return this.push(buffer);
    }
    const buffer = Buffer.allocUnsafe(9);
    buffer[0] = 0xfe;
    buffer.writeBigUInt64LE(BigInt(value), 1);
    return this.push(buffer);
  }

  get length(): number {
    return this.size;
  }

  build(): Buffer {
    return Buffer.concat(this.parts, this.size);
  }
}

/** Run operations on a connection one at a time. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/** Write to a stream and wait until it has been flushed to the kernel (or failed). */
export function send(stream: Duplex, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    if (stream.destroyed || stream.writableEnded) {
      reject(new ConnectionClosedError());
      return;
    }
    stream.write(data, (error) => (error === null || error === undefined ? resolve() : reject(error)));
  });
}
