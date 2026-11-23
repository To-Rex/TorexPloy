/**
 * Export a project: what goes into the archive besides its settings (which
 * always do), the passphrase that locks it (made by the panel, or one's own),
 * and an S3 destination to copy it to. The export runs in the background; its
 * page shows the progress and, once, the passphrase.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { PackageOpen } from 'lucide-react';
import { TRANSFER_PASSPHRASE_MIN, type CreatedExportDto, type CreateExportInput, type TransferInclude } from '@ploy/shared';
import { Dialog } from '../../components/Dialog.tsx';
import { Button, Callout, Checkbox, Field, Input, Segmented, Select } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { useAction } from '../../lib/mutate.ts';
import { keys, useS3Destinations } from '../../lib/queries.ts';

const DEFAULT_INCLUDE: TransferInclude = { databases: true, volumes: true, storage: true, source: true, images: false };

export function ExportDialog({ open, onClose, projectId, projectName }: { open: boolean; onClose: () => void; projectId: string; projectName: string }) {
  const { m, t } = useI18n();
  const d = m.transfers.exportDialog;
  const navigate = useNavigate();
  const destinations = useS3Destinations(open);
  const [include, setInclude] = useState<TransferInclude>(DEFAULT_INCLUDE);
  const [mode, setMode] = useState<'generate' | 'own'>('generate');
  const [passphrase, setPassphrase] = useState('');
  const [destination, setDestination] = useState('');
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setInclude(DEFAULT_INCLUDE);
    setMode('generate');
    setPassphrase('');
    setDestination('');
    setError(null);
    onClose();
  };

  const start = useAction((input: CreateExportInput) => api.post<CreatedExportDto>('/api/transfers/export', input), {
    invalidate: [keys.transfers],
    success: m.transfers.exportStarted,
    onSuccess: (result) => {
      close();
      void navigate(`/transfers/${result.transfer.id}`, { state: { passphrase: result.passphrase } });
    },
  });

  const toggle = (key: keyof TransferInclude) => (value: boolean) => setInclude((current) => ({ ...current, [key]: value }));

  return (
    <Dialog
      open={open}
      onClose={close}
      wide
      title={t(d.title, { name: projectName })}
      description={d.lead}
      onSubmit={() => {
        if (mode === 'own' && passphrase.length < TRANSFER_PASSPHRASE_MIN) {
          setError(t(d.passphraseShort, { min: TRANSFER_PASSPHRASE_MIN }));
          return;
        }
        setError(null);
        start.mutate({ projectId, include, ...(mode === 'own' ? { passphrase } : {}), ...(destination === '' ? {} : { s3DestinationId: destination }) });
      }}
      footer={
        <>
          <Button onClick={close}>{m.common.cancel}</Button>
          <Button type="submit" variant="primary" icon={<PackageOpen />} busy={start.isPending}>
            {d.submit}
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label={d.contents} hint={d.always}>
          <div className="stack" style={{ gap: 10 }}>
            <Checkbox checked={include.databases} onChange={toggle('databases')} label={d.databases} hint={d.databasesHint} />
            <Checkbox checked={include.storage} onChange={toggle('storage')} label={d.storage} hint={d.storageHint} />
            <Checkbox checked={include.volumes} onChange={toggle('volumes')} label={d.volumes} hint={d.volumesHint} />
            <Checkbox checked={include.source} onChange={toggle('source')} label={d.source} hint={d.sourceHint} />
            <Checkbox checked={include.images} onChange={toggle('images')} label={d.images} hint={d.imagesHint} />
          </div>
        </Field>
        <Field label={d.passphrase} hint={mode === 'generate' ? d.passphraseGenerated : t(d.passphraseOwnHint, { min: TRANSFER_PASSPHRASE_MIN })} error={error ?? undefined}>
          <div className="stack" style={{ gap: 10 }}>
            <Segmented
              label={d.passphrase}
              value={mode}
              onChange={setMode}
              options={[
                { value: 'generate', label: d.passphraseGenerate },
                { value: 'own', label: d.passphraseOwn },
              ]}
            />
            {mode === 'own' && <Input type="password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} autoComplete="new-password" placeholder={d.passphrasePlaceholder} />}
          </div>
        </Field>
        {(destinations.data ?? []).length > 0 && (
          <Field label={d.s3} optional={m.common.optional} hint={d.s3Hint}>
            <Select value={destination} onChange={(event) => setDestination(event.target.value)}>
              <option value="">{d.s3None}</option>
              {destinations.data!.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Callout tone="info">{d.secure}</Callout>
      </div>
    </Dialog>
  );
}
