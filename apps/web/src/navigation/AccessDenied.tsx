import { useIntl } from 'react-intl';
import { Icon } from './Icon';

export function AccessDenied({ message, traceId }: { message: string; traceId?: string }) {
  const intl = useIntl();
  const t = (id: string) => intl.formatMessage({ id });
  return <div className="audit-state audit-denied" role="alert">
    <h2 className="access-denied-heading">{t('navigation.deniedTitle')}</h2>
    <p className="access-denied-title">{message}</p>
    <p className="note access-denied-hint">{t('navigation.deniedHint')}</p>
    <a className="btn btn-secondary" href="/polizas"><Icon name="back" size={16} />{t('navigation.backToAccount')}</a>
    {traceId && <details className="audit-reference-details access-denied-support"><summary>{t('navigation.supportDetails')}</summary><span className="mono">{traceId}</span></details>}
  </div>;
}
