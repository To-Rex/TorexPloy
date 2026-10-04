import { useState } from 'react';
import type { MetricRange } from '@ploy/shared';
import { useServiceMetrics } from '../../lib/queries.ts';
import { RangePicker, ResourceCharts } from '../app/Metrics.tsx';
import { useServiceContext } from './ServiceLayout.tsx';

export function ServiceMetricsTab() {
  const service = useServiceContext();
  const [range, setRange] = useState<MetricRange>('1h');
  const metrics = useServiceMetrics(service.id, range);
  return (
    <div className="stack">
      <div>
        <RangePicker value={range} onChange={setRange} />
      </div>
      <ResourceCharts points={metrics.data?.points} limits={{ cpu: service.cpuLimit, memoryMb: service.memoryLimitMb }} />
    </div>
  );
}
