import { useIntl } from 'react-intl';

export function AccessDenied({ message, traceId }: { message: string; traceId?: string }) {
  const intl = useIntl();
  const t = (id: string) => intl.formatMessage({ id });
  return <div className="audit-state audit-denied" role="alert">
    <p className="access-denied-title">{message}</p>
    <a className="btn btn-secondary" href="/polizas">{t('navigation.backToAccount')}</a>
    {traceId && <details className="audit-reference-details access-denied-support"><summary>{t('navigation.supportDetails')}</summary><span className="mono">{traceId}</span></details>}
  </div>;
}
