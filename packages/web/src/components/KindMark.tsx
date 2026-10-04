/**
 * The tile that says what a card is at a glance: a web app, a worker, a
 * compose stack, or a database in its brand colour.
 */
import { Boxes, Database, Layers, Workflow } from 'lucide-react';
import type { ApplicationDto, ServiceType } from '@ploy/shared';

const BRANDS: Record<ServiceType, string> = {
  postgres: '#336791',
  mysql: '#00758F',
  mariadb: '#B5653F',
  mongo: '#13AA52',
  redis: '#DC382D',
  rabbitmq: '#FF6600',
  minio: '#C72C48',
  clickhouse: '#C9A400',
};

export function AppMark({ kind }: { kind: ApplicationDto['kind'] }) {
  return <span className="kind-mark">{kind === 'worker' ? <Workflow aria-hidden="true" /> : kind === 'compose' ? <Layers aria-hidden="true" /> : <Boxes aria-hidden="true" />}</span>;
}

export function ServiceMark({ type }: { type: ServiceType }) {
  return (
    <span className="kind-mark" data-brand={type} style={{ ['--brand' as string]: BRANDS[type] }}>
      <Database aria-hidden="true" />
    </span>
  );
}
