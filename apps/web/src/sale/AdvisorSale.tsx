import { useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { prepareAdvisorOffer, uuid, type PreparedOffer, type PrepareRequest } from './api';
import { CopyValue } from '../forms/CopyValue';
import '../policies/policies.css';

const empty = { authorizationId: '', fullName: '', documentNumber: '', birthDate: '', city: '', partnerCreditId: '', amount: '', termMonths: '120' };

// The advisor prepares a quote and an offer for the customer who gave the authorization code. Nothing here accepts, pays or signs.
export function AdvisorSale({ onSessionLost }: { onSessionLost(): void }) {
  const intl = useIntl(), t = (key: string) => intl.formatMessage({ id: `sale.${key}` });
  const [form, setForm] = useState(empty), [busy, setBusy] = useState(false), [error, setError] = useState(''), [offer, setOffer] = useState<PreparedOffer | null>(null);
  // The same sale keeps its key across retries, so a lost answer never creates a second offer.
  const command = useRef<{ body: string; key: string } | null>(null);
  const set = (field: keyof typeof empty) => (event: { target: { value: string } }) => { setForm(current => ({ ...current, [field]: event.target.value })); setOffer(null); };
  const amount = Number(form.amount), term = Number(form.termMonths);
  const ready = uuid(form.authorizationId.trim()) && form.fullName.trim() && form.documentNumber.trim() && form.birthDate && form.city.trim() && form.partnerCreditId.trim()
    && Number.isSafeInteger(amount) && amount > 0 && Number.isSafeInteger(term) && term > 0;
  async function submit() {
    if (busy || !ready) return;
    const request: PrepareRequest = { authorizationId: form.authorizationId.trim().toLowerCase(),
      customer: { fullName: form.fullName.trim(), documentType: 'CC', documentNumber: form.documentNumber.trim(), birthDate: form.birthDate, city: form.city.trim() },
      credit: { partnerCreditId: form.partnerCreditId.trim(), amount, termMonths: term } };
    const body = JSON.stringify(request);
    if (command.current?.body !== body) command.current = { body, key: crypto.randomUUID() };
    setBusy(true); setError(''); setOffer(null);
    try {
      const outcome = await prepareAdvisorOffer(request, command.current.key);
      if (outcome.kind === 'unauthenticated') onSessionLost();
      if (outcome.kind === 'ok') setOffer(outcome.value); else setError(outcome.kind);
    } catch { setError('unavailable'); }
    finally { setBusy(false); }
  }
  return <section className="card policy-section" aria-labelledby="advisor-sale-heading">
    <h2 id="advisor-sale-heading" className="h-card">{t('prepareTitle')}</h2>
    <p className="note">{t('prepareScope')}</p>
    <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <div className="grid">
      <div className="field"><label htmlFor="sale-adv-1">{t('code')}</label><input id="sale-adv-1" required value={form.authorizationId} disabled={busy} autoComplete="off" onChange={set('authorizationId')} /></div>
      <div className="field"><label htmlFor="sale-adv-2">{t('fullName')}</label><input id="sale-adv-2" required value={form.fullName} disabled={busy} autoComplete="off" onChange={set('fullName')} /></div>
      <div className="field"><label htmlFor="sale-adv-3">{t('documentNumber')}</label><input id="sale-adv-3" required value={form.documentNumber} disabled={busy} autoComplete="off" inputMode="numeric" onChange={set('documentNumber')} /></div>
      <div className="field"><label htmlFor="sale-adv-4">{t('birthDate')}</label><input id="sale-adv-4" required type="date" value={form.birthDate} disabled={busy} onChange={set('birthDate')} /></div>
      <div className="field"><label htmlFor="sale-adv-5">{t('city')}</label><input id="sale-adv-5" required value={form.city} disabled={busy} autoComplete="off" onChange={set('city')} /></div>
      <div className="field"><label htmlFor="sale-adv-6">{t('creditId')}</label><input id="sale-adv-6" required value={form.partnerCreditId} disabled={busy} autoComplete="off" onChange={set('partnerCreditId')} /></div>
      <div className="field"><label htmlFor="sale-adv-7">{t('amount')}</label><input id="sale-adv-7" required inputMode="numeric" value={form.amount} disabled={busy} onChange={set('amount')} /></div>
      <div className="field"><label htmlFor="sale-adv-8">{t('termMonths')}</label><input id="sale-adv-8" required inputMode="numeric" value={form.termMonths} disabled={busy} onChange={set('termMonths')} /></div>
      </div>
      <div className="actions"><button className="btn btn-primary" type="submit" disabled={busy || !ready}>{busy ? t('preparing') : t('prepare')}</button></div>
    </form>
    {error && <p role="alert">{t(error)}</p>}
    {offer && <div role="status" className="card">
      <p>{offer.contractable ? t('definitive') : t('preliminary')}</p>
      <p>{t('premium')}: {intl.formatNumber(Number(offer.premium), { style: 'currency', currency: 'COP', maximumFractionDigits: 0 })}</p>
      <CopyValue label={t('offerLink')} value={`${window.location.origin}/venta-asistida?oferta=${offer.offerId}`} copyLabel={t('copyLink')} />
      <CopyValue label={t('offerCode')} value={offer.offerId} />
      <p className="note">{t('handoff')}</p>
    </div>}
  </section>;
}
