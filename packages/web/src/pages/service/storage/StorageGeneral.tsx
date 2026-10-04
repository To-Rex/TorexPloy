/**
 * A file store's General tab: deploy controls, how to reach it (public and
 * internal), a connection guide with ready snippets, backups into it, the
 * public port, and the applications linked to it.
 */
import { useState } from 'react';
import { Link } from 'react-router';
import { Archive, Eye } from 'lucide-react';
import type { ServiceCredentialsDto, ServiceDto, StorageOverviewDto } from '@ploy/shared';
import { CopyButton, ValueField } from '../../../components/Copy.tsx';
import { Card } from '../../../components/Frame.tsx';
import { useToast } from '../../../components/Toast.tsx';
import { Button, Callout, Field, Skeleton } from '../../../components/ui.tsx';
import { useI18n } from '../../../i18n/index.tsx';
import { api } from '../../../lib/api.ts';
import { useAction } from '../../../lib/mutate.ts';
import { fetchServiceCredentials, keys, useBuckets, useStorageOverview } from '../../../lib/queries.ts';
import { DeployCard, ExternalCard } from '../General.tsx';

type Guide = 'cli' | 'rclone' | 'node' | 'python' | 'php' | 'go';
const GUIDES: Guide[] = ['cli', 'rclone', 'node', 'python', 'php', 'go'];
const GUIDE_LABELS: Record<Guide, string> = { cli: 'AWS CLI', rclone: 'rclone', node: 'Node.js', python: 'Python', php: 'PHP / Laravel', go: 'Go' };

function snippet(guide: Guide, endpoint: string, key: string, secret: string, bucket: string): string {
  switch (guide) {
    case 'cli':
      return [`aws configure set aws_access_key_id ${key}`, `aws configure set aws_secret_access_key ${secret}`, `aws --endpoint-url ${endpoint} s3 ls`, `aws --endpoint-url ${endpoint} s3 cp ./photo.png s3://${bucket}/photo.png`].join('\n');
    case 'rclone':
      return [`rclone config create torexploy s3 provider=Other endpoint=${endpoint} access_key_id=${key} secret_access_key=${secret} force_path_style=true`, `rclone copy ./photos torexploy:${bucket}/photos`].join('\n');
    case 'node':
      return [
        "import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';",
        '',
        'const s3 = new S3Client({',
        `  endpoint: '${endpoint}',`,
        "  region: 'us-east-1',",
        '  forcePathStyle: true,',
        `  credentials: { accessKeyId: '${key}', secretAccessKey: '${secret}' },`,
        '});',
        `await s3.send(new PutObjectCommand({ Bucket: '${bucket}', Key: 'photo.png', Body: file, ContentType: 'image/png' }));`,
      ].join('\n');
    case 'python':
      return [
        'import boto3',
        'from botocore.config import Config',
        '',
        's3 = boto3.client(',
        "    's3',",
        `    endpoint_url='${endpoint}',`,
        `    aws_access_key_id='${key}',`,
        `    aws_secret_access_key='${secret}',`,
        "    region_name='us-east-1',",
        "    config=Config(s3={'addressing_style': 'path'}),",
        ')',
        `s3.upload_file('photo.png', '${bucket}', 'photo.png')`,
      ].join('\n');
    case 'php':
      return [
        "// config/filesystems.php → 'disks'",
        "'s3' => [",
        "    'driver' => 's3',",
        `    'key' => '${key}',`,
        `    'secret' => '${secret}',`,
        "    'region' => 'us-east-1',",
        `    'bucket' => '${bucket}',`,
        `    'endpoint' => '${endpoint}',`,
        "    'use_path_style_endpoint' => true,",
        '],',
        '',
        "Storage::disk('s3')->put('photo.png', $contents);",
      ].join('\n');
    case 'go':
      return [
        'cfg, _ := config.LoadDefaultConfig(ctx,',
        '    config.WithRegion("us-east-1"),',
        `    config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider("${key}", "${secret}", "")),`,
        ')',
        'client := s3.NewFromConfig(cfg, func(o *s3.Options) {',
        `    o.BaseEndpoint = aws.String("${endpoint}")`,
        '    o.UsePathStyle = true',
        '})',
        `_, err := client.PutObject(ctx, &s3.PutObjectInput{Bucket: aws.String("${bucket}"), Key: aws.String("photo.png"), Body: file})`,
      ].join('\n');
  }
}

function OverviewCard({ service, overview, credentials, onReveal, loading }: { service: ServiceDto; overview: StorageOverviewDto; credentials: ServiceCredentialsDto | null; onReveal: () => void; loading: boolean }) {
  const { m, formatBytes } = useI18n();
  const f = m.fileStore;
  return (
    <Card
      title={f.overviewTitle}
      description={f.overviewHint}
      actions={
        credentials === null ? (
          <Button icon={<Eye />} busy={loading} onClick={onReveal}>
            {m.services.reveal}
          </Button>
        ) : undefined
      }
    >
      <dl className="facts-strip">
        <div>
          <dt>{f.endpoint}</dt>
          <dd>{overview.endpoint === null ? <Link to={`/services/${service.id}/domains`}>{f.endpointNone}</Link> : <code className="truncate">{overview.endpoint}</code>}</dd>
        </div>
        <div>
          <dt>{f.buckets}</dt>
          <dd>{overview.buckets}</dd>
        </div>
        <div>
          <dt>{f.keysCount}</dt>
          <dd>{overview.keys}</dd>
        </div>
        <div>
          <dt>{f.usage}</dt>
          <dd>{overview.usage === null ? '—' : formatBytes(overview.usage.bytes)}</dd>
        </div>
      </dl>
      <div className="form-grid">
        <Field label={f.internalEndpoint} hint={f.internalHint}>
          <ValueField value={overview.internalEndpoint} />
        </Field>
        <Field label={f.region}>
          <ValueField value={overview.region} />
        </Field>
        <Field label={f.rootKey} hint={f.rootKeyHint}>
          <ValueField value={overview.rootAccessKeyId} />
        </Field>
        {credentials !== null && (
          <Field label={f.secretAccessKey}>
            <ValueField value={credentials.password} secret />
          </Field>
        )}
      </div>
    </Card>
  );
}

function GuideCard({ overview, credentials }: { overview: StorageOverviewDto; credentials: ServiceCredentialsDto | null }) {
  const { m } = useI18n();
  const f = m.fileStore;
  const [guide, setGuide] = useState<Guide>('cli');
  const endpoint = overview.endpoint ?? overview.internalEndpoint;
  const text = snippet(guide, endpoint, overview.rootAccessKeyId, credentials?.password ?? '<SECRET_ACCESS_KEY>', 'uploads');
  return (
    <Card title={f.guideTitle} description={f.guideHint}>
      {overview.endpoint === null && <Callout tone="info">{f.guideNoEndpoint}</Callout>}
      <div className="guide-tabs" role="tablist">
        {GUIDES.map((value) => (
          <button key={value} type="button" role="tab" aria-pressed={guide === value} onClick={() => setGuide(value)}>
            {GUIDE_LABELS[value]}
          </button>
        ))}
      </div>
      <div className="codeblock" style={{ whiteSpace: 'pre', overflow: 'auto' }}>
        {text}
        <CopyButton value={text} />
      </div>
    </Card>
  );
}

function BackupCard({ service, overview }: { service: ServiceDto; overview: StorageOverviewDto }) {
  const { m } = useI18n();
  const f = m.fileStore;
  const enable = useAction(() => api.post(`/api/services/${service.id}/storage/backup-destination`), {
    success: f.backupCreated,
    invalidate: [keys.servicePart(service.id, 'storage'), keys.s3, keys.servicePart(service.id, 'storage', 'keys'), keys.servicePart(service.id, 'storage', 'buckets')],
  });
  return (
    <Card
      icon={<Archive />}
      title={f.backupTitle}
      description={overview.backupDestinationId === null ? f.backupHint : f.backupEnabled}
      actions={
        overview.backupDestinationId === null ? (
          <Button icon={<Archive />} busy={enable.isPending} onClick={() => enable.mutate()}>
            {f.backupEnable}
          </Button>
        ) : (
          <Link className="btn btn--sm" to="/settings/storage" style={{ textDecoration: 'none' }}>
            {f.backupOpen}
          </Link>
        )
      }
    />
  );
}

export function StorageGeneralTab({ service }: { service: ServiceDto }) {
  const { m } = useI18n();
  const toast = useToast();
  const overview = useStorageOverview(service.id);
  const buckets = useBuckets(service.id);
  const [credentials, setCredentials] = useState<ServiceCredentialsDto | null>(null);
  const [loading, setLoading] = useState(false);
  const reveal = async () => {
    setLoading(true);
    try {
      setCredentials(await fetchServiceCredentials(service.id));
    } catch (error) {
      toast.error(error);
    } finally {
      setLoading(false);
    }
  };
  void buckets;
  return (
    <>
      <DeployCard service={service} />
      {overview.isPending ? (
        <Skeleton height={200} />
      ) : overview.isError ? (
        <Callout tone="bad">{m.errors.codes.storage_unavailable}</Callout>
      ) : (
        <>
          <OverviewCard service={service} overview={overview.data} credentials={credentials} onReveal={() => void reveal()} loading={loading} />
          <GuideCard overview={overview.data} credentials={credentials} />
          <BackupCard service={service} overview={overview.data} />
        </>
      )}
      <ExternalCard service={service} credentials={credentials} />
      <Card title={m.services.linkedApps} description={m.services.env}>
        {service.linkedApplications.length === 0 ? (
          <p className="muted" style={{ fontSize: 'var(--text-sm)' }}>{m.services.notLinked}</p>
        ) : (
          <div className="row wrap">
            {service.linkedApplications.map((app) => (
              <Link key={app.id} className="btn btn--sm" to={`/apps/${app.id}/environment`} style={{ textDecoration: 'none' }}>
                {app.name}
              </Link>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
