/**
 * A minimal S3 client: AWS Signature Version 4 over node:http(s).
 *
 * Enough for backups and the file store — put (streamed), get (with ranges),
 * delete, list, multi-delete, bucket management and presigned links — against
 * AWS S3 and S3-compatible stores (Cloudflare R2, Backblaze B2, MinIO,
 * SeaweedFS, Wasabi…). Uploads send `UNSIGNED-PAYLOAD` so a multi-gigabyte
 * dump is never read twice to hash it. Responses are parsed with a few regular
 * expressions: the S3 XML dialect is flat and stable, and a dependency would
 * be heavier than the parsing.
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
  const encoded = encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return keepSlash ? encoded.replace(/%2F/g, '/') : encoded;
}

/** Query parameters sorted and encoded the way the canonical request lists them (`delete=` for a valueless flag). */
function canonicalQuery(query: Record<string, string>): string {
  return Object.entries(query)
    .map(([key, value]) => [encode(key, false), encode(value, false)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

function signingKey(secretAccessKey: string, date: string, region: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, date), region), 's3'), 'aws4_request');
}

function signature(secretAccessKey: string, amzDate: string, region: string, canonicalRequest: string): string {
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  return createHmac('sha256', signingKey(secretAccessKey, date, region)).update(toSign).digest('hex');
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
  const scope = `${input.amzDate.slice(0, 8)}/${input.region}/s3/aws4_request`;
  const headers: Record<string, string> = { host: input.host };
  for (const [name, value] of Object.entries(input.headers)) headers[name.toLowerCase()] = value.trim().replace(/\s+/g, ' ');
  const names = Object.keys(headers).sort();
  const canonical = [input.method, encode(input.path, true), canonicalQuery(input.query ?? {}), names.map((name) => `${name}:${headers[name]}\n`).join(''), names.join(';'), input.payloadHash].join('\n');
  return `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature(input.secretAccessKey, input.amzDate, input.region, canonical)}`;
}

export interface PresignInput {
  method: string;
  host: string;
  path: string;
  /** Extra parameters that become part of the link (`response-content-disposition`). */
  query?: Record<string, string>;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  amzDate: string;
  /** Seconds the link stays valid. */
  expiresIn: number;
}

/**
 * The query string of a presigned URL (SigV4 query-string authentication,
 * `host` as the only signed header, unsigned payload). Pure: exported for the
 * AWS reference vector.
 */
export function presignV4(input: PresignInput): string {
  const scope = `${input.amzDate.slice(0, 8)}/${input.region}/s3/aws4_request`;
  const query = canonicalQuery({
    ...input.query,
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${input.accessKeyId}/${scope}`,
    'X-Amz-Date': input.amzDate,
    'X-Amz-Expires': String(input.expiresIn),
    'X-Amz-SignedHeaders': 'host',
  });
  const canonical = [input.method, encode(input.path, true), query, `host:${input.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  return `${query}&X-Amz-Signature=${signature(input.secretAccessKey, input.amzDate, input.region, canonical)}`;
}

function amzDateNow(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

// ---------------------------------------------------------------------------
// Response XML
// ---------------------------------------------------------------------------

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith('#x')) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith('#')) return String.fromCodePoint(Number(lower.slice(1)));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[lower] ?? match;
  });
}

/** Text of the first `<name>…</name>` inside `xml`, decoded; null when absent (a self-closing tag counts as empty). */
function tag(xml: string, name: string): string | null {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([^<]*)</${name}>|<${name}(?:\\s[^>]*)?/>`).exec(xml);
  return match === null ? null : decodeXml(match[1] ?? '');
}

/** Every `<name>…</name>` block inside `xml`, inner markup included. */
function blocks(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'g'))].map((match) => match[1]!);
}

export interface S3ObjectSummary {
  key: string;
  size: number;
  /** ISO-8601. */
  lastModified: string;
  /** Without the surrounding quotes; null when the store omits it. */
  etag: string | null;
}

export interface S3Listing {
  /** Common prefixes ("folders") when a delimiter was given. */
  prefixes: string[];
  objects: S3ObjectSummary[];
  truncated: boolean;
  nextContinuationToken: string | null;
}

export function parseListObjects(xml: string): S3Listing {
  return {
    prefixes: blocks(xml, 'CommonPrefixes').map((block) => tag(block, 'Prefix') ?? '').filter((prefix) => prefix.length > 0),
    objects: blocks(xml, 'Contents').map((block) => ({
      key: tag(block, 'Key') ?? '',
      size: Number(tag(block, 'Size') ?? 0),
      lastModified: tag(block, 'LastModified') ?? '',
      etag: tag(block, 'ETag')?.replace(/^"|"$/g, '') ?? null,
    })),
    truncated: tag(xml, 'IsTruncated') === 'true',
    nextContinuationToken: tag(xml, 'NextContinuationToken'),
  };
}

export function parseListBuckets(xml: string): { name: string; createdAt: string | null }[] {
  return blocks(xml, 'Bucket').map((block) => ({ name: tag(block, 'Name') ?? '', createdAt: tag(block, 'CreationDate') })).filter((bucket) => bucket.name.length > 0);
}

export interface S3DeleteResult {
  deleted: string[];
  errors: { key: string; code: string; message: string }[];
}

export function parseDeleteResult(xml: string): S3DeleteResult {
  return {
    deleted: blocks(xml, 'Deleted').map((block) => tag(block, 'Key') ?? ''),
    errors: blocks(xml, 'Error').map((block) => ({ key: tag(block, 'Key') ?? '', code: tag(block, 'Code') ?? 'Error', message: tag(block, 'Message') ?? '' })),
  };
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!);
}

export interface S3ObjectHead {
  size: number;
  contentType: string | null;
  lastModified: string | null;
  etag: string | null;
}

interface SendOptions {
  body?: Readable | Buffer;
  size?: number;
  contentType?: string;
  timeoutMs?: number;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  /** Address the service root (`ListBuckets`) rather than the bucket. */
  root?: boolean;
}

/** Objects per `DeleteObjects` request, the S3 maximum. */
export const DELETE_BATCH = 1000;

export class S3Client {
  private readonly target: S3Target;
  private readonly base: URL;

  constructor(target: S3Target) {
    this.target = target;
    this.base = new URL(target.endpoint);
  }

  private location(key: string, root = false): { host: string; path: string } {
    const cleanKey = key.replace(/^\/+/, '');
    if (root || this.target.forcePathStyle) {
      const bucket = root ? '' : `/${this.target.bucket}`;
      return { host: this.base.host, path: `${bucket}${cleanKey.length > 0 ? `/${cleanKey}` : ''}` || '/' };
    }
    return { host: `${this.target.bucket}.${this.base.host}`, path: `/${cleanKey}` };
  }

  private send(method: string, key: string, options: SendOptions = {}): Promise<IncomingMessage> {
    const { host, path } = this.location(key, options.root);
    const amzDate = amzDateNow();
    const payloadHash = options.body === undefined ? EMPTY_SHA256 : Buffer.isBuffer(options.body) ? sha256(options.body) : 'UNSIGNED-PAYLOAD';
    const headers: Record<string, string> = { ...options.headers, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
    if (options.contentType !== undefined) headers['content-type'] = options.contentType;
    const query = options.query ?? {};
    const authorization = signV4({ method, host, path, query, headers, payloadHash, region: this.target.region, accessKeyId: this.target.accessKeyId, secretAccessKey: this.target.secretAccessKey, amzDate });
    const length = options.body === undefined ? 0 : Buffer.isBuffer(options.body) ? options.body.length : (options.size ?? 0);
    const send = this.base.protocol === 'https:' ? httpsRequest : httpRequest;
    const search = canonicalQuery(query);
    return new Promise((resolve, reject) => {
      const req = send(
        {
          protocol: this.base.protocol,
          hostname: options.root || this.target.forcePathStyle ? this.base.hostname : `${this.target.bucket}.${this.base.hostname}`,
          port: this.base.port.length > 0 ? Number(this.base.port) : undefined,
          method,
          path: `${encode(path, true)}${search.length > 0 ? `?${search}` : ''}`,
          headers: { ...headers, host, authorization, 'content-length': String(length) },
          // A few requests at a time; pooled sockets would only linger.
          agent: false,
          timeout: options.timeoutMs ?? 60_000,
        },
        resolve,
      );
      req.on('timeout', () => req.destroy(new Error(`S3 ${method} timed out`)));
      req.on('error', reject);
      if (options.body === undefined) req.end();
      else if (Buffer.isBuffer(options.body)) req.end(options.body);
      else {
        options.body.on('error', (error) => req.destroy(error));
        options.body.pipe(req);
      }
    });
  }

  /** Throw a readable error for a non-2xx response (S3 explains itself in XML). */
  private async check(response: IncomingMessage): Promise<void> {
    const status = response.statusCode ?? 0;
    if (status >= 200 && status < 300) {
      response.resume();
      return;
    }
    throw await this.failure(response);
  }

  private async failure(response: IncomingMessage): Promise<S3Error> {
    const status = response.statusCode ?? 0;
    const body = await this.text(response);
    const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1] ?? `HTTP${status}`;
    const message = /<Message>([^<]+)<\/Message>/.exec(body)?.[1] ?? (body.trim().slice(0, 200) || `HTTP ${status}`);
    return new S3Error(status, code, `${code}: ${message}`);
  }

  private async text(response: IncomingMessage): Promise<string> {
    let body = '';
    for await (const chunk of response) body += String(chunk);
    return body;
  }

  private async xml(response: IncomingMessage): Promise<string> {
    const status = response.statusCode ?? 0;
    if (status < 200 || status >= 300) throw await this.failure(response);
    return this.text(response);
  }

  async put(key: string, body: Readable | Buffer, size: number, contentType = 'application/octet-stream'): Promise<void> {
    await this.check(await this.send('PUT', key, { body, size, contentType, timeoutMs: 6 * 3_600_000 }));
  }

  /** The object's response stream (status 206 and `Content-Range` when a byte range was asked for). */
  async get(key: string, options: { range?: string } = {}): Promise<IncomingMessage> {
    const response = await this.send('GET', key, { timeoutMs: 6 * 3_600_000, ...(options.range === undefined ? {} : { headers: { range: options.range } }) });
    if ((response.statusCode ?? 0) >= 300) await this.check(response);
    return response;
  }

  /** Size and metadata of an object, or null when there is no such key. */
  async headObject(key: string): Promise<S3ObjectHead | null> {
    const response = await this.send('HEAD', key);
    const status = response.statusCode ?? 0;
    response.resume();
    if (status === 404) return null;
    if (status < 200 || status >= 300) throw new S3Error(status, `HTTP${status}`, `HTTP ${status}`);
    const header = (name: string): string | null => {
      const value = response.headers[name];
      return value === undefined ? null : Array.isArray(value) ? (value[0] ?? null) : value;
    };
    const modified = header('last-modified');
    return {
      size: Number(header('content-length') ?? 0),
      contentType: header('content-type'),
      lastModified: modified === null || Number.isNaN(Date.parse(modified)) ? null : new Date(modified).toISOString(),
      etag: header('etag')?.replace(/^"|"$/g, '') ?? null,
    };
  }

  async delete(key: string): Promise<void> {
    const response = await this.send('DELETE', key);
    if (response.statusCode === 404) {
      response.resume();
      return;
    }
    await this.check(response);
  }

  /** Remove up to {@link DELETE_BATCH} keys in one request; a missing key counts as deleted. */
  async deleteObjects(keys: string[]): Promise<S3DeleteResult> {
    if (keys.length === 0) return { deleted: [], errors: [] };
    if (keys.length > DELETE_BATCH) throw new RangeError(`At most ${DELETE_BATCH} keys per DeleteObjects request`);
    const body = Buffer.from(`<Delete>${keys.map((key) => `<Object><Key>${escapeXml(key)}</Key></Object>`).join('')}</Delete>`, 'utf8');
    const response = await this.send('POST', '', { body, contentType: 'application/xml', query: { delete: '' }, headers: { 'content-md5': createHash('md5').update(body).digest('base64') } });
    return parseDeleteResult(await this.xml(response));
  }

  /** One page of the bucket (`ListObjectsV2`). */
  async listObjects(options: { prefix?: string; delimiter?: string; continuationToken?: string; maxKeys?: number } = {}): Promise<S3Listing> {
    const query: Record<string, string> = { 'list-type': '2' };
    if (options.prefix !== undefined && options.prefix.length > 0) query.prefix = options.prefix;
    if (options.delimiter !== undefined) query.delimiter = options.delimiter;
    if (options.continuationToken !== undefined) query['continuation-token'] = options.continuationToken;
    if (options.maxKeys !== undefined) query['max-keys'] = String(options.maxKeys);
    return parseListObjects(await this.xml(await this.send('GET', '', { query })));
  }

  async listBuckets(): Promise<{ name: string; createdAt: string | null }[]> {
    return parseListBuckets(await this.xml(await this.send('GET', '', { root: true })));
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

  /** Removes the (empty) bucket; a non-empty one fails with `BucketNotEmpty`. */
  async deleteBucket(): Promise<void> {
    await this.check(await this.send('DELETE', ''));
  }

  /**
   * A link that lets its holder `GET` or `PUT` one object without credentials
   * until `expiresIn` seconds pass. `endpoint` overrides the client's own when
   * the link is for a browser rather than for this process (a public domain
   * instead of an in-network address).
   */
  presign(input: { method: 'GET' | 'PUT'; key: string; expiresIn: number; query?: Record<string, string>; endpoint?: string }): { url: string; expiresAt: string } {
    const base = input.endpoint === undefined ? this.base : new URL(input.endpoint);
    const cleanKey = input.key.replace(/^\/+/, '');
    const pathStyle = this.target.forcePathStyle;
    const host = pathStyle ? base.host : `${this.target.bucket}.${base.host}`;
    const path = pathStyle ? `/${this.target.bucket}/${cleanKey}` : `/${cleanKey}`;
    const amzDate = amzDateNow();
    const query = presignV4({ method: input.method, host, path, query: input.query ?? {}, region: this.target.region, accessKeyId: this.target.accessKeyId, secretAccessKey: this.target.secretAccessKey, amzDate, expiresIn: input.expiresIn });
    const issued = Date.UTC(Number(amzDate.slice(0, 4)), Number(amzDate.slice(4, 6)) - 1, Number(amzDate.slice(6, 8)), Number(amzDate.slice(9, 11)), Number(amzDate.slice(11, 13)), Number(amzDate.slice(13, 15)));
    return { url: `${base.protocol}//${host}${encode(path, true)}?${query}`, expiresAt: new Date(issued + input.expiresIn * 1000).toISOString() };
  }
}
