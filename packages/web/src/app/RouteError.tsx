import { isRouteErrorResponse, Link, useRouteError } from 'react-router';
import { RefreshCw } from 'lucide-react';
import { Button } from '../components/ui.tsx';
import { useI18n } from '../i18n/index.tsx';

export function NotFound() {
  const { m } = useI18n();
  return (
    <div className="page">
      <div className="stack" style={{ maxWidth: 480, paddingTop: 40 }}>
        <p className="faint tabular" style={{ fontSize: 'var(--text-3xl)', lineHeight: 'var(--lh-3xl)', fontWeight: 600 }}>404</p>
        <h1>{m.common.notFoundTitle}</h1>
        <p className="muted">{m.common.notFoundText}</p>
        <div>
          <Link className="btn" to="/" style={{ textDecoration: 'none' }}>
            {m.common.goHome}
          </Link>
        </div>
      </div>
    </div>
  );
}

export function RouteError() {
  const error = useRouteError();
  const { m } = useI18n();
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFound />;
  // A failed lazy chunk usually means a new release was deployed; reloading fetches it.
  return (
    <div className="page">
      <div className="stack" style={{ maxWidth: 520, paddingTop: 40 }}>
        <h1>{m.common.crashTitle}</h1>
        <p className="muted">{m.common.crashText}</p>
        <div>
          <Button icon={<RefreshCw />} onClick={() => window.location.reload()}>
            {m.common.reload}
          </Button>
        </div>
      </div>
    </div>
  );
}
