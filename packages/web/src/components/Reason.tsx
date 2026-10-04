/** A translated failure reason, with the original technical message tucked behind a disclosure. */
import { useI18n } from '../i18n/index.tsx';
import { reasonText } from '../lib/errors.ts';

export function Reason({ kind, code, message }: { kind: 'server' | 'deploy' | 'service'; code: string | null; message: string | null }) {
  const { m } = useI18n();
  const { text, detail } = reasonText(m, kind, code, message);
  return (
    <>
      <span>{text}</span>
      {detail !== null && (
        <details className="reason-detail">
          <summary>{m.reasons.technicalDetails}</summary>
          <code>{detail}</code>
        </details>
      )}
    </>
  );
}

export function useReasonText(): (kind: 'server' | 'deploy' | 'service', code: string | null, message: string | null) => string {
  const { m } = useI18n();
  return (kind, code, message) => reasonText(m, kind, code, message).text;
}
