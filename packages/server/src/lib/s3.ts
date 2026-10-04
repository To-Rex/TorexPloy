/**
 * A minimal S3 client: AWS Signature Version 4 over node:http(s).
 *
 * Enough for backups — put (streamed from disk), get, delete, and a
 * credentials/bucket check — against AWS S3 and S3-compatible stores
 * (Cloudflare R2, Backblaze B2, MinIO, SeaweedFS, Wasabi…). Uploads send
 * `UNSIGNED-PAYLOAD` so a multi-gigabyte dump is never read twice to hash it.
 */
import { createHash, createHmac } from 'node:crypto';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Readable } from 'node:stream';

export interface S3Target {
  /** `https://s3.eu-central-1.amazonaws.com`, `https://<account>.r2.cloudflarestorage.com`, `http://minio:9000`… */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** `endpoint/bucket/key` instead of `bucket.endpoint/key` (MinIO and most self-hosted stores). */
  forcePathStyle: boolean;
}

export class S3Error extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'S3Error';
    this.status = status;
    this.code = code;
  }
}

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const hmac = (key: Buffer | string, value: string): Buffer => createHmac('sha256', key).update(value).digest();

/** RFC 3986 encoding as SigV4 wants it (S3 keeps '/' in paths). */
function encode(value: string, keepSlash: boolean): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(keepSlash ? /%2F/g : /$^/, '/');
}

export interface SignInput {
  method: string;
  host: string;
  path: string;
  query?: Record<string, string>;
  headers: Record<string, string>;
  payloadHash: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** `YYYYMMDDTHHMMSSZ` */
  amzDate: string;
}

/** The SigV4 Authorization header for a request (pure: exported for the AWS reference vectors). */
export function signV4(input: SignInput): string {
  const date = input.amzDate.slice(0, 8);
  const scope = `${date}/${input.region}/s3/aws4_request`;
  const headers: Record<string, string> = { host: input.host };
  for (const [name, value] of Object.entries(input.headers)) headers[name.toLowerCase()] = value.trim().replace(/\s+/g, ' ');
  const names = Object.keys(headers).sort();
  const query = Object.entries(input.query ?? {})
    .map(([key, value]) => [encode(key, false), encode(value, false)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  const canonical = [input.method, encode(input.path, true), query, names.map((name) => `${name}:${headers[name]}\n`).join(''), names.join(';'), input.payloadHash].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', input.amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, date), input.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
}

function amzDateNow(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export class S3Client {
  private readonly target: S3Target;
  private readonly base: URL;

  constructor(target: S3Target) {
    this.target = target;
    this.base = new URL(target.endpoint);
  }

  private location(key: string): { host: string; path: string } {
    const cleanKey = key.replace(/^\/+/, '');
    if (this.target.forcePathStyle) return { host: this.base.host, path: `/${this.target.bucket}${cleanKey.length > 0 ? `/${cleanKey}` : ''}` };
    return { host: `${this.target.bucket}.${this.base.host}`, path: `/${cleanKey}` };
  }

  private send(method: string, key: string, options: { body?: Readable | Buffer; size?: number; contentType?: string; timeoutMs?: number } = {}): Promise<IncomingMessage> {
    const { host, path } = this.location(key);
    const amzDate = amzDateNow();
    const payloadHash = options.body === undefined ? EMPTY_SHA256 : Buffer.isBuffer(options.body) ? sha256(options.body) : 'UNSIGNED-PAYLOAD';
    const headers: Record<string, string> = { 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
    if (options.contentType !== undefined) headers['content-type'] = options.contentType;
    const authorization = signV4({ method, host, path, headers, payloadHash, region: this.target.region, accessKeyId: this.target.accessKeyId, secretAccessKey: this.target.secretAccessKey, amzDate });
    const length = options.body === undefined ? 0 : Buffer.isBuffer(options.body) ? options.body.length : (options.size ?? 0);
    const send = this.base.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
      const req = send(
        {
          protocol: this.base.protocol,
          hostname: this.target.forcePathStyle ? this.base.hostname : `${this.target.bucket}.${this.base.hostname}`,
          port: this.base.port.length > 0 ? Number(this.base.port) : undefined,
          method,
          path: encode(path, true),
          headers: { ...headers, host, authorization, 'content-length': String(length) },
          // Backups are a few requests a day; pooled sockets would only linger.
          agent: false,
          timeout: options.timeoutMs ?? 60_000,
        },
        resolve,
      );
      req.on('timeout', () => req.destroy(new Error(`S3 ${method} timed out`)));
      req.on('error', reject);
      if (options.body === undefined) req.end();
      else if (Buffer.isBuffer(options.body)) req.end(options.body);
      else options.body.pipe(req);
    });
  }

  /** Throw a readable error for a non-2xx response (S3 explains itself in XML). */
  private async check(response: IncomingMessage): Promise<void> {
    const status = response.statusCode ?? 0;
    if (status >= 200 && status < 300) {
      response.resume();
      return;
    }
    let body = '';
    for await (const chunk of response) body += String(chunk);
    const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1] ?? `HTTP${status}`;
    const message = /<Message>([^<]+)<\/Message>/.exec(body)?.[1] ?? (body.trim().slice(0, 200) || `HTTP ${status}`);
    throw new S3Error(status, code, `${code}: ${message}`);
  }

  async put(key: string, body: Readable | Buffer, size: number, contentType = 'application/octet-stream'): Promise<void> {
    await this.check(await this.send('PUT', key, { body, size, contentType, timeoutMs: 6 * 3_600_000 }));
  }

  async get(key: string): Promise<IncomingMessage> {
    const response = await this.send('GET', key, { timeoutMs: 6 * 3_600_000 });
    if ((response.statusCode ?? 0) >= 300) await this.check(response);
    return response;
  }

  async delete(key: string): Promise<void> {
    const response = await this.send('DELETE', key);
    if (response.statusCode === 404) {
      response.resume();
      return;
    }
    await this.check(response);
  }

  /** Credentials, bucket and write access, proven by writing and removing a small object. */
  async verify(prefix: string): Promise<void> {
    const key = `${prefix.replace(/\/+$/, '')}/.torexploy-check-${Date.now()}`.replace(/^\/+/, '');
    await this.put(key, Buffer.from('ok'), 2, 'text/plain');
    await this.delete(key);
  }

  async createBucket(): Promise<void> {
    await this.check(await this.send('PUT', ''));
  }
}
