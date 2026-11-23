/**
 * Every export and import of the team: what is under way, what finished
 * (and can still be downloaded or shared), what failed and why. Exports start
 * from here or from a project's menu; imports start here.
 */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ArrowLeftRight, Download, PackageOpen, Upload } from 'lucide-react';
import { roleAtLeast } from '@ploy/shared';
import { Dialog } from '../../components/Dialog.tsx';
import { Frame } from '../../components/Frame.tsx';
import { usePageMeta } from '../../components/PageMeta.tsx';
import { RelativeTime } from '../../components/Time.tsx';
import { Button, Callout, EmptyState, Field, Select, SkeletonRows } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { useProjects, useRole, useTransfers } from '../../lib/queries.ts';
import { ExportDialog } from './ExportDialog.tsx';
import { Meter, TransferStatusBadge } from './parts.tsx';

function ExportPicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { m } = useI18n();
  const projects = useProjects();
  const [projectId, setProjectId] = useState('');
  const [chosen, setChosen] = useState<{ id: string; name: string } | null>(null);
  const list = projects.data ?? [];
  const selected = list.find((project) => project.id === (projectId || list[0]?.id));
  return (
    <>
      <Dialog
        open={open && chosen === null}
        onClose={onClose}
        title={m.transfers.pickProject}
        onSubmit={() => {
          if (selected !== undefined) setChosen({ id: selected.id, name: selected.name });
        }}
        footer={
          <>
            <Button onClick={onClose}>{m.common.cancel}</Button>
            <Button type="submit" variant="primary" disabled={selected === undefined}>
              {m.common.continue}
            </Button>
          </>
        }
      >
        {list.length === 0 ? (
          <Callout tone="idle">{m.transfers.noProjects}</Callout>
        ) : (
          <Field label={m.transfers.project}>
            <Select value={selected?.id ?? ''} onChange={(event) => setProjectId(event.target.value)}>
              {list.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </Dialog>
      {chosen !== null && (
        <ExportDialog
          open
          projectId={chosen.id}
          projectName={chosen.name}
          onClose={() => {
            setChosen(null);
            onClose();
          }}
        />
      )}
    </>
  );
}

export function TransfersPage() {
  const { m, formatBytes } = useI18n();
  usePageMeta([{ label: m.transfers.title }]);
  const navigate = useNavigate();
  const transfers = useTransfers();
  const role = useRole();
  const admin = role !== null && roleAtLeast(role, 'admin');
  const [exporting, setExporting] = useState(false);

  return (
    <div className="page">
      <Frame
        icon={<ArrowLeftRight />}
        title={m.transfers.title}
        description={m.transfers.subtitle}
        actions={
          admin ? (
            <>
              <Button icon={<Upload />} onClick={() => setExporting(true)}>
                {m.transfers.export}
              </Button>
              <Button variant="primary" icon={<Download />} onClick={() => void navigate('/transfers/import')}>
                {m.transfers.import}
              </Button>
            </>
          ) : undefined
        }
      >
        {!admin && role !== null ? (
          <Callout tone="idle">{m.transfers.adminOnly}</Callout>
        ) : transfers.isPending ? (
          <SkeletonRows rows={3} />
        ) : (transfers.data ?? []).length === 0 ? (
          <EmptyState
            icon={<PackageOpen />}
            title={m.transfers.emptyTitle}
            action={
              <Button variant="primary" icon={<Download />} onClick={() => void navigate('/transfers/import')}>
                {m.transfers.import}
              </Button>
            }
          >
            {m.transfers.emptyText}
          </EmptyState>
        ) : (
          <div className="list">
            {transfers.data!.map((transfer) => (
              <Link key={transfer.id} className="list__row" to={`/transfers/${transfer.id}`}>
                <span className="kind-mark" aria-hidden="true">
                  {transfer.kind === 'export' ? <Upload /> : <Download />}
                </span>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <span className="list__title">{transfer.projectName ?? transfer.fileName}</span>
                    <span className="faint">{m.transfers.kind[transfer.kind]}</span>
                  </div>
                  <div className="list__meta">
                    <span>{m.transfers.source[transfer.source]}</span>
                    {transfer.sizeBytes !== null && <span>{formatBytes(transfer.sizeBytes)}</span>}
                    {transfer.createdBy !== null && <span>{transfer.createdBy}</span>}
                    <RelativeTime value={transfer.createdAt} />
                  </div>
                  {(transfer.status === 'running' || transfer.status === 'receiving') && (
                    <div style={{ marginTop: 8, maxWidth: 360 }}>
                      <Meter value={transfer.status === 'receiving' ? (transfer.expectedBytes === null ? 0 : (transfer.receivedBytes / transfer.expectedBytes) * 100) : transfer.percent} />
                    </div>
                  )}
                </div>
                <TransferStatusBadge status={transfer.status} />
              </Link>
            ))}
          </div>
        )}
      </Frame>
      <ExportPicker open={exporting} onClose={() => setExporting(false)} />
    </div>
  );
}
