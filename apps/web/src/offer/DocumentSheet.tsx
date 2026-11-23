import type { ReactNode } from 'react';
import { useIntl } from 'react-intl';
import { brandAssets } from '@solventa/assets/web';
import { Icon, type IconName } from '../navigation/Icon';
import './document-sheet.css';

export function printSheet() {
  window.print();
}

export function DocumentSheet({ title, number, seal, sealTone = 'ok', children }: {
  title: string; number?: string; seal?: string; sealTone?: 'ok' | 'pending'; children: ReactNode;
}) {
  const intl = useIntl();
  const t = (id: string, values?: Record<string, string>) => intl.formatMessage({ id }, values);
  return <article className="sheet" aria-label={title}>
    <div className="sheet-letterhead">
      <img src={brandAssets.logo.green} alt="" width={128} />
      <p className="sheet-issuer"><strong>{t('sheet.issuer')}</strong><span>{t('sheet.issuerDetail')}</span></p>
    </div>
    <div className="sheet-title-row">
      <div className="sheet-title-copy">
        <p className="sheet-kicker">{t('sheet.kicker')}</p>
        <p className="sheet-title">{title}</p>
        {number && <p className="sheet-number mono">{t('sheet.number', { number })}</p>}
      </div>
      {seal && <span className={`sheet-seal sheet-seal-${sealTone}`}><Icon name={sealTone === 'ok' ? 'seal' : 'pending'} size={18} />{seal}</span>}
    </div>
    {children}
    <p className="sheet-footer"><Icon name="info" size={14} /><span>{t('sheet.legend')}</span></p>
  </article>;
}

export function SheetBlock({ icon, label, children, note }: { icon: IconName; label: string; children: ReactNode; note?: string }) {
  return <div className="sheet-block">
    <span className="sheet-block-icon" aria-hidden="true"><Icon name={icon} size={18} /></span>
    <div className="sheet-block-copy"><dt>{label}</dt><dd>{children}{note && <span className="sheet-block-note">{note}</span>}</dd></div>
  </div>;
}

export function SheetSection({ icon, title, children }: { icon: IconName; title: string; children: ReactNode }) {
  return <div className="sheet-verification">
    <p className="sheet-section-title"><Icon name={icon} size={16} />{title}</p>
    {children}
  </div>;
}
