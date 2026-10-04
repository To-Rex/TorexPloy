import { useState } from 'react';
import type { MetricRange } from '@ploy/shared';
import { Card } from '../../components/Frame.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { useServiceMetrics } from '../../lib/queries.ts';
import { RangePicker, ResourceCharts } from '../app/Metrics.tsx';
import { useServiceContext } from './ServiceLayout.tsx';

export function ServiceMetricsTab() {
  const service = useServiceContext();
  const { m } = useI18n();
  const [range, setRange] = useState<MetricRange>('1h');
  const metrics = useServiceMetrics(service.id, range);
  return (
    <Card title={m.monitoring.resourcesTitle} description={m.monitoring.resourcesHint} actions={<RangePicker value={range} onChange={setRange} />}>
      <ResourceCharts points={metrics.data?.points} limits={{ cpu: service.cpuLimit, memoryMb: service.memoryLimitMb }} />
    </Card>
  );
}
