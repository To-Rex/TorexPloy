/**
 * The file store's Docs tab: how to put this store into an application —
 * connection parameters, the variables a linked app receives, SDK and tool
 * snippets, public and temporary links, browser uploads, keys, backups,
 * limits, troubleshooting and the panel API. Every snippet carries this
 * store's real endpoint, region, bucket and access key.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { BookOpen, Copy, Download, ExternalLink } from 'lucide-react';
import type { ServiceDto } from '@ploy/shared';
import { CopyButton } from '../../../components/Copy.tsx';
import { Rich } from '../../../components/Rich.tsx';
import { useToast } from '../../../components/Toast.tsx';
import { Button, Callout, Field, Input, Select, Skeleton } from '../../../components/ui.tsx';
import { useI18n } from '../../../i18n/index.tsx';
import { useBuckets, useStorageKeys, useStorageOverview } from '../../../lib/queries.ts';
import { downloadMarkdown, storageDocsMarkdown } from './storageDocsMarkdown.ts';
import { browserUploadSnippet, linkEnvRows, linkedAppSnippet, panelApiSnippet, SDK_LABELS, SDKS, sdkSnippet, type Sdk } from './storageSnippets.ts';

const SECTIONS = ['quickstart', 'connection', 'linked', 'sdk', 'links', 'browser', 'keys', 'backups', 'limits', 'faq', 'api'] as const;
type Section = (typeof SECTIONS)[number];
const SECRET = '<SECRET_ACCESS_KEY>';

function Code({ text }: { text: string }) {
  return (
    <div className="codeblock" style={{ whiteSpace: 'pre', overflow: 'auto' }}>
      {text}
      <CopyButton value={text} />
    </div>
  );
}

function Section({ id, title, children }: { id: Section; title: string; children: ReactNode }) {
  return (
    <article id={`docs-${id}`} className="guide__section" style={{ scrollMarginTop: 84 }}>
      <h3 style={{ margin: 0, fontSize: 'var(--text-lg)', lineHeight: 'var(--lh-lg)', fontWeight: 600 }}>{title}</h3>
      {children}
    </article>
  );
}

function Steps({ items }: { items: readonly { title: string; text: string }[] }) {
  return (
    <ol className="guide__steps">
      {items.map((step, index) => (
        <li key={index}>
          <span className="guide__step-num" aria-hidden="true">
            {index + 1}
          </span>
          <div>
            <strong>
              <Rich text={step.title} />
            </strong>
            <p>
              <Rich text={step.text} />
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}

function Bullets({ items }: { items: readonly string[] }) {
  return (
    <ul className="guide__list">
      {items.map((item, index) => (
        <li key={index}>
          <Rich text={item} />
        </li>
      ))}
    </ul>
  );
}

export function StorageDocsTab({ service }: { service: ServiceDto }) {
  const { m, formatDate } = useI18n();
  const toast = useToast();
  const d = m.fileStore.docs;
  const overview = useStorageOverview(service.id);
  const buckets = useBuckets(service.id);
  const storageKeys = useStorageKeys(service.id);
  const [sdk, setSdk] = useState<Sdk>('node');
  const [keyId, setKeyId] = useState('root');
  const [bucket, setBucket] = useState('');
  const [prefix, setPrefix] = useState('S3_');

  // The docs stay readable while the store is down: known values from the service, placeholders for the rest.
  const fallback = { endpoint: null, internalEndpoint: `http://${service.internalHost}:${service.internalPort}`, region: 'us-east-1', rootAccessKeyId: '<ACCESS_KEY_ID>' };
  const data = overview.data ?? (overview.isError ? fallback : undefined);
  const external = data?.endpoint ?? null;
  const endpoint = external ?? data?.internalEndpoint ?? fallback.internalEndpoint;
  const region = data?.region ?? 'us-east-1';
  const key = keyId === 'root' ? (data?.rootAccessKeyId ?? '<ACCESS_KEY_ID>') : (storageKeys.data?.find((item) => item.id === keyId)?.accessKeyId ?? '<ACCESS_KEY_ID>');
  const bucketName = bucket.length > 0 ? bucket : (buckets.data?.[0]?.name ?? 'uploads');
  const values = useMemo(() => ({ endpoint, region, key, secret: SECRET, bucket: bucketName }), [endpoint, region, key, bucketName]);
  const envPrefix = prefix.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '');
  const panelBase = typeof window === 'undefined' ? '' : window.location.origin;

  const markdown = () =>
    storageDocsMarkdown({
      m,
      serviceName: service.name,
      serviceId: service.id,
      origin: panelBase,
      values,
      external,
      internalEndpoint: data?.internalEndpoint ?? fallback.internalEndpoint,
      rootAccessKeyId: data?.rootAccessKeyId ?? fallback.rootAccessKeyId,
      envPrefix,
      generatedAt: formatDate(new Date(), { dateStyle: 'medium', timeStyle: 'short' }),
    });
  const download = () => downloadMarkdown(`torexploy-${service.slug}-docs.md`, markdown());
  const copyMarkdown = async () => {
    try {
      await navigator.clipboard.writeText(markdown());
      toast.success(d.copied);
    } catch (error) {
      toast.error(error);
    }
  };

  const jump = (section: Section) => document.getElementById(`docs-${section}`)?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });

  if (overview.isPending || data === undefined) return <Skeleton height={320} />;

  return (
    <div className="stack" style={{ gap: 16 }}>
      {overview.isError && <Callout tone="work">{m.errors.codes.storage_unavailable}</Callout>}
      <div className="guide__hero" style={{ paddingBottom: 16, marginBottom: 0 }}>
        <div className="docs__head">
          <span className="guide__section-icon" aria-hidden="true">
            <BookOpen />
          </span>
          <div className="docs__title">
            <h2 style={{ margin: 0, fontSize: 'var(--text-xl)', lineHeight: 'var(--lh-xl)', fontWeight: 650 }}>{d.title}</h2>
            <p className="guide__summary">{d.subtitle}</p>
          </div>
          <div className="docs__actions">
            <Button size="sm" icon={<Copy />} onClick={() => void copyMarkdown()}>
              {d.copyMd}
            </Button>
            <Button size="sm" variant="primary" icon={<Download />} onClick={download}>
              {d.download}
            </Button>
          </div>
        </div>
        <div className="form-grid">
          <Field label={d.pick.key}>
            <Select value={keyId} onChange={(event) => setKeyId(event.target.value)}>
              <option value="root">{d.pick.root}</option>
              {(storageKeys.data ?? []).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {item.accessKeyId}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={d.pick.bucket}>
            <Select value={bucket} onChange={(event) => setBucket(event.target.value)}>
              {(buckets.data ?? []).length === 0 && <option value="">uploads</option>}
              {(buckets.data ?? []).map((item) => (
                <option key={item.name} value={item.name}>
                  {item.name}
                  {item.public ? ` · ${m.fileStore.publicBadge}` : ''}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <p className="guide__note">{d.secretNote}</p>
        <div className="template-cats" role="tablist" aria-label={d.toc}>
          {SECTIONS.map((section) => (
            <button key={section} type="button" role="tab" aria-selected={false} onClick={() => jump(section)}>
              {d[section].title}
            </button>
          ))}
        </div>
      </div>

      <Section id="quickstart" title={d.quickstart.title}>
        <Steps items={d.quickstart.steps} />
      </Section>

      <Section id="connection" title={d.connection.title}>
        <p className="guide__p">
          <Rich text={d.connection.hint} />
        </p>
        {external === null && <Callout tone="info">{d.connection.externalNone}</Callout>}
        <div className="guide__table-wrap">
          <table className="guide__table">
            <tbody>
              <tr>
                <td>{d.connection.rows.endpointExternal}</td>
                <td>{external === null ? <Link to={`/services/${service.id}/domains`}>{m.fileStore.endpointNone}</Link> : <code>{external}</code>}</td>
              </tr>
              <tr>
                <td>{d.connection.rows.endpointInternal}</td>
                <td>
                  <code>{data.internalEndpoint}</code> — {d.connection.internalOnly}
                </td>
              </tr>
              <tr>
                <td>{d.connection.rows.region}</td>
                <td>
                  <code>{region}</code>
                </td>
              </tr>
              <tr>
                <td>{d.connection.rows.pathStyle}</td>
                <td>
                  <code>{`${endpoint}/${bucketName}/<key>`}</code>
                </td>
              </tr>
              <tr>
                <td>{d.connection.rows.key}</td>
                <td>
                  <code>{key}</code>
                </td>
              </tr>
              <tr>
                <td>{d.connection.rows.secret}</td>
                <td>
                  <Rich text={d.connection.rows.secretHint} />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Section>

      <Section id="linked" title={d.linked.title}>
        <p className="guide__p">
          <Rich text={d.linked.text} />
        </p>
        <Steps items={d.linked.steps} />
        <div className="form-grid">
          <Field label={d.linked.prefix} hint={d.linked.prefixHint}>
            <Input mono value={prefix} onChange={(event) => setPrefix(event.target.value)} spellCheck={false} />
          </Field>
        </div>
        <div className="guide__table-wrap">
          <table className="guide__table">
            <thead>
              <tr>
                <th>{d.linked.cols.name}</th>
                <th>{d.linked.cols.value}</th>
                <th>{d.linked.cols.note}</th>
              </tr>
            </thead>
            <tbody>
              {linkEnvRows(envPrefix, data.internalEndpoint, region, data.rootAccessKeyId).map(([name, value, note]) => (
                <tr key={name}>
                  <td>
                    <code>{name}</code>
                  </td>
                  <td>{value.length === 0 ? <span className="faint">—</span> : <code>{value}</code>}</td>
                  <td>{d.linked.notes[note as keyof typeof d.linked.notes]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Callout tone="work">{d.linked.rootWarning}</Callout>
        <Code text={linkedAppSnippet(envPrefix)} />
      </Section>

      <Section id="sdk" title={d.sdk.title}>
        <p className="guide__p">
          <Rich text={d.sdk.hint} />
        </p>
        <div className="guide-tabs" role="tablist">
          {SDKS.map((value) => (
            <button key={value} type="button" role="tab" aria-pressed={sdk === value} onClick={() => setSdk(value)}>
              {SDK_LABELS[value]}
            </button>
          ))}
        </div>
        <Code text={sdkSnippet(sdk, values)} />
        <Bullets items={d.sdk.notes} />
      </Section>

      <Section id="links" title={d.links.title}>
        <p className="guide__p">
          <Rich text={d.links.public} />
        </p>
        <Code text={`${endpoint}/${bucketName}/photos/photo.png`} />
        <p className="guide__p">
          <Rich text={d.links.private} />
        </p>
        <Bullets items={d.links.notes} />
      </Section>

      <Section id="browser" title={d.browser.title}>
        <p className="guide__p">
          <Rich text={d.browser.text} />
        </p>
        <Code text={browserUploadSnippet()} />
        <Callout tone="info">{d.browser.cors}</Callout>
      </Section>

      <Section id="keys" title={d.keys.title}>
        <Bullets items={d.keys.items} />
        <Callout tone="info" title={d.keys.rotateTitle}>
          {d.keys.rotate}
        </Callout>
      </Section>

      <Section id="backups" title={d.backups.title}>
        <p className="guide__p">
          <Rich text={d.backups.text} />
        </p>
        <Link className="btn btn--sm" to={`/services/${service.id}/general`} style={{ textDecoration: 'none', justifySelf: 'start' }}>
          {d.backups.open}
        </Link>
      </Section>

      <Section id="limits" title={d.limits.title}>
        <Bullets items={d.limits.items} />
      </Section>

      <Section id="faq" title={d.faq.title}>
        <div className="guide__faq">
          {d.faq.items.map((item, index) => (
            <details key={index} className="guide__faq-item">
              <summary>
                <Rich text={item.q} />
              </summary>
              <p>
                <Rich text={item.a} />
              </p>
            </details>
          ))}
        </div>
      </Section>

      <Section id="api" title={d.api.title}>
        <p className="guide__p">
          <Rich text={d.api.text} />
        </p>
        <Code text={panelApiSnippet(panelBase, service.id, bucketName)} />
        <Bullets items={d.api.notes} />
        <Link className="btn btn--sm" to="/settings/tokens" style={{ textDecoration: 'none', justifySelf: 'start' }}>
          <ExternalLink width={14} height={14} aria-hidden="true" />
          {d.api.openTokens}
        </Link>
      </Section>
    </div>
  );
}
