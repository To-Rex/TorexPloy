import { useState } from 'react';
import { useNavigate } from 'react-router';
import { createProjectSchema, type ProjectDto } from '@ploy/shared';
import { Dialog } from '../../components/Dialog.tsx';
import { Button, Field, Input, Textarea } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { fieldErrors } from '../../lib/errors.ts';
import { useAction } from '../../lib/mutate.ts';
import { keys } from '../../lib/queries.ts';
import { validate } from '../../lib/validate.ts';

export function NewProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { m } = useI18n();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const create = useAction((input: { name: string; description?: string }) => api.post<ProjectDto>('/api/projects', input), {
    success: m.projects.created,
    invalidate: [keys.projects, keys.overview],
    inlineValidation: true,
    onSuccess: (project) => {
      close();
      void navigate(`/projects/${project.id}`);
    },
  });

  function close() {
    setName('');
    setDescription('');
    setErrors({});
    onClose();
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title={m.projects.createTitle}
      onSubmit={() => {
        const result = validate(m, createProjectSchema, { name, ...(description.trim().length > 0 ? { description } : {}) });
        if (result.errors !== null) {
          setErrors(result.errors);
          return;
        }
        create.mutate(result.data, { onError: (error) => setErrors(fieldErrors(m, error)) });
      }}
      footer={
        <>
          <Button onClick={close}>{m.common.cancel}</Button>
          <Button type="submit" variant="primary" busy={create.isPending}>
            {m.common.create}
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label={m.projects.name} error={errors.name}>
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder={m.projects.namePlaceholder} autoFocus />
        </Field>
        <Field label={m.projects.description} optional={m.common.optional} error={errors.description}>
          <Textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} />
        </Field>
      </div>
    </Dialog>
  );
}
