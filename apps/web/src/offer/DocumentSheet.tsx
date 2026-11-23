import type { ReactNode } from 'react';
import { useIntl } from 'react-intl';
import { brandAssets } from '@solventa/assets/web';
import './document-sheet.css';

export type SheetStatus = 'draft' | 'paid' | 'issued' | 'signed' | 'expired' | 'cancelled';

export function DocumentSheet({ kicker, title, number, meta, status, statusLabel, page, total = 1, watermark, children, label }: {
  kicker: string; title: string; number?: string; meta?: ReactNode; status: SheetStatus; statusLabel: string;
  page?: number; total?: number; watermark?: string; children: ReactNode; label?: string;
}) {
  const intl = useIntl();
  const t = (id: string, values?: Record<string, string>) => intl.formatMessage({ id }, values);
  return <article className={`doc-paper doc-paper-${status}`} aria-label={label ?? title}>
    {watermark && <span className="doc-watermark" aria-hidden="true">{watermark}</span>}
    <header className="doc-letterhead">
      <img className="doc-logo" src={brandAssets.logo.green} alt="Solventa" width={132} height={30} />
      <p className="doc-issuer"><strong>{t('sheet.issuer')}</strong><span>{t('sheet.issuerDetail')}</span><span>{t('sheet.issuerPlace')}</span></p>
    </header>
    <div className="doc-title-block">
      <div className="doc-title-copy">
        <p className="doc-kicker">{kicker}</p>
        <p className="doc-title">{title}</p>
        {(number || meta) && <p className="doc-meta">{number && <span className="doc-number">{t('sheet.number', { number })}</span>}{meta}</p>}
      </div>
      <span className={`doc-stamp doc-stamp-${status}`}>{statusLabel}</span>
    </div>
    <div className="doc-body">{children}</div>
    <footer className="doc-footer">
      <p>{t('sheet.legend')}</p>
      {page !== undefined && <p className="doc-page">{t('sheet.pageOf', { current: String(page), total: String(total) })}</p>}
    </footer>
  </article>;
}

export function DocSection({ number, title, id, children }: { number: number | string; title: string; id?: string; children: ReactNode }) {
  return <section className="doc-section" aria-labelledby={id}>
    <h2 className="doc-section-title" id={id}><span className="doc-section-number" aria-hidden="true">{number}.</span>{title}</h2>
    {children}
  </section>;
}

export type DocRow = { label: string; value: ReactNode; mono?: boolean; wide?: boolean };

export function DocTable({ rows, caption }: { rows: DocRow[]; caption?: string }) {
  return <table className="doc-table">
    {caption && <caption className="visually-hidden">{caption}</caption>}
    <tbody>{rows.map(row => <tr key={row.label} className={row.wide ? 'doc-row-wide' : undefined}>
      <th scope="row">{row.label}</th>
      <td className={row.mono ? 'doc-mono' : undefined}>{row.value}</td>
    </tr>)}</tbody>
  </table>;
}

export function DocSignature({ signed, name, role, signedAt, reference, method, stroke }: {
  signed: boolean; name: string; role: string; signedAt?: string | null; reference?: ReactNode; method: string; stroke: string;
}) {
  const intl = useIntl();
  const t = (id: string) => intl.formatMessage({ id });
  return <div className={`doc-signature${signed ? ' doc-signature-signed' : ''}`}>
    <div className="doc-signature-box">
      <div className="doc-signature-canvas">
        {signed ? <svg className="doc-signature-stroke" viewBox="0 0 260 64" preserveAspectRatio="xMinYMid meet" role="img" aria-label={t('sheet.signatureStroke')}>
          <path d={stroke} />
        </svg> : <span className="doc-signature-placeholder">{t('sheet.signaturePending')}</span>}
      </div>
      <p className="doc-signature-name">{name}</p>
      <p className="doc-signature-role">{role}</p>
    </div>
    <dl className="doc-signature-facts">
      {signed && <div className="doc-signature-seal"><dt className="visually-hidden">{t('sheet.signatureState')}</dt><dd>{t('sheet.signatureTitle')}</dd></div>}
      <div><dt>{t('sheet.signatureWhen')}</dt><dd>{signedAt ?? (signed ? t('sheet.signatureTimeUnavailable') : t('sheet.signatureNotYet'))}</dd></div>
      <div><dt>{t('sheet.signatureMethod')}</dt><dd>{method}</dd></div>
      {reference && <div><dt>{t('sheet.signatureReference')}</dt><dd className="doc-mono">{reference}</dd></div>}
    </dl>
  </div>;
}

function VisualCode({ hash }: { hash: string }) {
  const bits = (hash.match(/[0-9a-f]/gi) ?? []).map(char => parseInt(char, 16));
  const cells: [number, number][] = [];
  for (let row = 0; row < 9; row++) for (let column = 0; column < 5; column++) {
    if ((bits[(row * 5 + column) % Math.max(bits.length, 1)] ?? 0) % 2 === 0) continue;
    cells.push([column, row]);
    if (column < 4) cells.push([8 - column, row]);
  }
  return <svg className="doc-visual-code" viewBox="-1 -1 11 11" aria-hidden="true">
    <rect x="-1" y="-1" width="11" height="11" rx="1" className="doc-visual-frame" />
    {cells.map(([x, y]) => <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" />)}
  </svg>;
}

export function DocVerification({ hash, rows, note }: { hash: string | null; rows: DocRow[]; note?: string }) {
  const intl = useIntl();
  const t = (id: string) => intl.formatMessage({ id });
  return <div className="doc-verify">
    <div className="doc-verify-copy">
      <dl>
        <div><dt>{t('sheet.hashLabel')}</dt><dd className="doc-mono doc-hash">{hash ?? t('sheet.hashUnavailable')}</dd></div>
        {rows.map(row => <div key={row.label}><dt>{row.label}</dt><dd className={row.mono ? 'doc-mono' : undefined}>{row.value}</dd></div>)}
      </dl>
      {note && <p className="doc-verify-note">{note}</p>}
    </div>
    {hash && <figure className="doc-verify-figure"><VisualCode hash={hash} /><figcaption>{t('sheet.visualCode')}</figcaption></figure>}
  </div>;
}

export function DocClauses({ items }: { items: { code: string; text: string }[] }) {
  return <ol className="doc-clauses">{items.map(item => <li key={item.code}><span className="doc-clause-code">{item.code}</span><span>{item.text}</span></li>)}</ol>;
}
