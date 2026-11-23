import type { ReactNode } from 'react';
import type { Approval } from './api';

const statusClass: Record<Approval['status'], string> = {
  active: 'pill-ok',
  executed: 'pill-ok',
  expired: 'pill-status-expired',
  revoked: 'pill-status-expired',
};

export function OwnerApprovalTable({ approvals, feedback, busy, t, timestamp, onRevoke }: {
  approvals: Approval[];
  feedback?: ReactNode;
  busy: boolean;
  t(key: string): string;
  timestamp(value: string): string;
  onRevoke(approval: Approval): void;
}) {
  const columns = ['action', 'status', 'grantedAt', 'expires', 'options'] as const;
  return <div className="policy-table-wrap">
    <table className="policy-table advisor-approval-table">
      <caption className="visually-hidden">{t('authorizations')}</caption>
      <thead><tr>{columns.map(column => <th key={column} scope="col">{t(column)}</th>)}</tr></thead>
      <tbody>
        {approvals.map(approval => <tr key={approval.authorizationId}>
        <td data-label={t('action')}>
          <div>
            <strong>{t(approval.action)}</strong>
            <details className="advisor-approval-references">
              <summary>{t('viewReferences')}</summary>
              <dl>
                <dt>{t('reference')}</dt><dd className="mono">{approval.advisorReference}</dd>
                {approval.replacementPolicyId && <>
                  <dt>{t('replacement')}</dt><dd className="mono">{approval.replacementPolicyId}</dd>
                </>}
              </dl>
            </details>
          </div>
        </td>
        <td data-label={t('status')}>
          <div>
            <span className={`pill ${statusClass[approval.status]}`}>{t(approval.status === 'active' ? 'approved' : approval.status)}</span>
            {approval.revokedAt && <span className="note advisor-revoked-date">
              {t('revoked')}: <time dateTime={approval.revokedAt}>{timestamp(approval.revokedAt)}</time>
            </span>}
          </div>
        </td>
        <td data-label={t('grantedAt')}><time dateTime={approval.grantedAt}>{timestamp(approval.grantedAt)}</time></td>
        <td data-label={t('expires')}><time dateTime={approval.expiresAt}>{timestamp(approval.expiresAt)}</time></td>
        <td data-label={t('options')}>{approval.revokedAt ? '—' : <button type="button" className="btn btn-secondary btn-small"
          disabled={busy} onClick={() => onRevoke(approval)}>{t('revoke')}</button>}</td>
      </tr>)}
        {feedback && <tr className="advisor-table-feedback"><td colSpan={columns.length}>{feedback}</td></tr>}
      </tbody>
    </table>
  </div>;
}
