import { assistanceSearchPath, parseAssistanceResults } from '@solventa/contracts';
import type { AssistanceProviderMatch, AssistanceRequestView } from '@solventa/contracts';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useIntl } from 'react-intl';
import { fetchWithSession } from '../session-fetch';
import { createRequest, listRequests, RequestError } from './requests';
import type { RequestFailure } from './requests';
import { Icon, type IconName } from '../navigation/Icon';

const kindStyle: Record<AssistanceProviderMatch['kind'], { icon: IconName; tone: string }> = {
  workshop: { icon: 'wrench', tone: 'amber' }, expert: { icon: 'user', tone: 'violet' }, roadside: { icon: 'truck', tone: 'blue' },
};

type Results = { state: 'idle' | 'loading' | 'unavailable' } | { state: 'ready'; providers: AssistanceProviderMatch[]; address: string };
// What the customer is doing with a provider: reviewing the request, sending it, being told it failed, or seeing it stored.
type Asking = { kind: 'idle' } | { kind: 'review' | 'sending'; provider: AssistanceProviderMatch; address: string }
  | { kind: 'failed'; provider: AssistanceProviderMatch; address: string; failure: RequestFailure } | { kind: 'done'; request: AssistanceRequestView };
type Own = { state: 'loading' | 'failed' } | { state: 'ready'; requests: AssistanceRequestView[] };

export function ProviderSearch({ onSessionLost }: { onSessionLost: () => void }) {
  const intl = useIntl();
  const t = (key: string) => intl.formatMessage({ id: `assistance.${key}` });
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<Results>({ state: 'idle' });
  const [asking, setAsking] = useState<Asking>({ kind: 'idle' });
  const [own, setOwn] = useState<Own>({ state: 'loading' });
  const active = useRef<AbortController | null>(null);
  const reading = useRef<AbortController | null>(null);
  // One key for the whole confirmation: a retry after a failure or an uncertain answer returns the stored request instead of making another.
  const key = useRef<string | null>(null);
  useEffect(() => () => {
    active.current?.abort();
    active.current = null;
    reading.current?.abort();
  }, []);

  async function refresh() {
    reading.current?.abort();
    const controller = new AbortController();
    reading.current = controller;
    try {
      const requests = await listRequests(controller.signal);
      if (!controller.signal.aborted) setOwn({ state: 'ready', requests });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof RequestError && error.code === 'unauthorized') { onSessionLost(); return; }
      setOwn({ state: 'failed' });
    }
  }
  useEffect(() => { void refresh(); }, []);

  function review(provider: AssistanceProviderMatch, address: string) {
    key.current = null;
    setAsking({ kind: 'review', provider, address });
  }

  async function confirm() {
    if (asking.kind !== 'review' && asking.kind !== 'failed') return;
    const { provider, address } = asking;
    key.current ??= crypto.randomUUID();
    setAsking({ kind: 'sending', provider, address });
    try {
      const request = await createRequest({ providerId: provider.id, place: { kind: 'address', address } }, key.current);
      key.current = null;
      setAsking({ kind: 'done', request });
      void refresh();
    } catch (error) {
      if (error instanceof RequestError && error.code === 'unauthorized') { onSessionLost(); return; }
      const failure: RequestFailure = error instanceof RequestError && error.code !== 'unauthorized' ? error.code : 'unavailable';
      // A refusal the same key would meet again is not retried with it.
      if (failure === 'conflict' || failure === 'invalid' || failure === 'not_found') key.current = null;
      setAsking({ kind: 'failed', provider, address, failure });
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (query.trim().length < 2) return;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setResult({ state: 'loading' });
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetchWithSession(assistanceSearchPath, {
        method: 'POST', credentials: 'same-origin', signal: controller.signal,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'manual', query: query.trim() }),
      });
      if (controller.signal.aborted) return;
      if (response.status === 401) { onSessionLost(); return; }
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('directory_unavailable');
      const raw = await response.text();
      const providers = raw.length <= 64 * 1024 ? parseAssistanceResults(JSON.parse(raw)) : null;
      if (!providers) throw new Error('invalid_response');
      if (!controller.signal.aborted) setResult({ state: 'ready', providers, address: query.trim() });
    } catch {
      if (active.current === controller) setResult({ state: 'unavailable' });
    } finally { clearTimeout(timer); }
  }

  const busy = asking.kind !== 'idle';
  return <main className="content assistance">
    <div className="page-title"><span className="page-icon page-icon-amber" aria-hidden="true"><Icon name="location" size={22} /></span><h1>{t('title')}</h1></div>
    <p className="assistance-simulated"><span className="pill pill-pending"><Icon name="info" size={14} />{t('simulation')}</span></p>
    {asking.kind === 'done' && <section className="card assistance-result" aria-labelledby="assistance-done" aria-live="polite">
      <h2 id="assistance-done">{t('done.title')}</h2>
      <p>{t('reference')}</p>
      <p className="assistance-reference" aria-label={`${t('reference')} ${asking.request.reference}`}>{asking.request.reference}</p>
      <p>{t('provider')} · {asking.request.provider.name}</p>
      <p>{t('status')} · {t('status.' + asking.request.status)}</p>
      <p>{t('simulatedNote')}</p>
      <button className="btn btn-primary" type="button" onClick={() => setAsking({ kind: 'idle' })}>{t('done')}</button>
    </section>}
    {(asking.kind === 'review' || asking.kind === 'sending' || asking.kind === 'failed') && <section className="card assistance-result" aria-labelledby="assistance-review">
      <h2 id="assistance-review">{t('review')}</h2>
      <p>{t('provider')} · {asking.provider.name}</p>
      <p>{asking.provider.address}, {asking.provider.city}</p>
      <p>{t('where')} · {t('address')}: {asking.address}</p>
      {asking.kind === 'sending' && <p role="status">{t('sending')}</p>}
      {asking.kind === 'failed' && <p role="alert">{t('failure.' + asking.failure)}</p>}
      <button className="btn btn-primary" type="button" disabled={asking.kind === 'sending'} onClick={() => void confirm()}>{t('confirm')}</button>
      <button className="btn btn-secondary" type="button" disabled={asking.kind === 'sending'} onClick={() => { key.current = null; setAsking({ kind: 'idle' }); }}>{t('back')}</button>
    </section>}
    {!busy && <>
    <form className="card field assistance-search" onSubmit={event => void submit(event)}>
      <label htmlFor="provider-place">{t('place')}</label>
      <div className="assistance-search-row">
        <span className="assistance-input"><Icon name="location" size={18} /><input id="provider-place" value={query} onChange={event => setQuery(event.target.value)} maxLength={160} /></span>
        <button className="btn btn-primary" type="submit" disabled={query.trim().length < 2}><Icon name="search" size={18} />{t('search')}</button>
      </div>
    </form>
    {result.state === 'idle' && <div className="card empty-state assistance-idle"><span className="empty-state-art" aria-hidden="true"><Icon name="search" size={30} /></span><h2>{t('idleTitle')}</h2><p className="note">{t('idleDetail')}</p></div>}
    {result.state === 'loading' && <p role="status" className="assistance-status"><span className="spinner" aria-hidden="true" />{t('loading')}</p>}
    {result.state === 'unavailable' && <p role="alert" className="banner banner-error"><Icon name="alert" size={18} className="banner-icon" /><span>{t('unavailable')}</span></p>}
    {result.state === 'ready' && result.providers.length === 0 && <p role="status" className="empty-inline"><Icon name="search" size={18} />{t('empty')}</p>}
    {result.state === 'ready' && result.providers.length > 0 && <p className="note assistance-count" role="status">{intl.formatMessage({ id: 'assistance.count' }, { count: result.providers.length })}</p>}
    {result.state === 'ready' && result.providers.length > 0 && <ul className="assistance-results">{result.providers.map(provider => <li key={provider.id}><article className="card assistance-result">
      <span className={`icon-chip icon-chip-${kindStyle[provider.kind].tone}`} aria-hidden="true"><Icon name={kindStyle[provider.kind].icon} size={20} /></span>
      <div className="assistance-result-copy">
        <p className="assistance-kind">{t(provider.kind)}</p>
        <h2>{provider.name}</h2>
        <ul className="assistance-facts">
          <li><Icon name="location" size={16} /><span>{provider.address}, {provider.city}</span></li>
          <li><Icon name="phone" size={16} /><a href={`tel:${provider.phone}`}>{t('contact')} · {provider.phone}</a></li>
          <li><Icon name="clock" size={16} /><span>{t('hours')} · {provider.hours}</span></li>
        </ul>
        <button className="btn btn-primary" type="button" onClick={() => review(provider, result.address)}>{t('request')}</button>
      </div>
    </article></li>)}</ul>}
    </>}
    <section className="card assistance-result" aria-labelledby="assistance-mine">
      <h2 id="assistance-mine">{t('mine')}</h2>
      {own.state === 'loading' && <p role="status">{t('mineLoading')}</p>}
      {own.state === 'failed' && <><p role="alert">{t('mineFailed')}</p><button className="btn btn-secondary" type="button" onClick={() => void refresh()}>{t('retry')}</button></>}
      {own.state === 'ready' && own.requests.length === 0 && <p>{t('mineEmpty')}</p>}
      {own.state === 'ready' && own.requests.map(item => <article key={item.id} className="assistance-own">
        <p className="assistance-reference">{item.reference}</p>
        <p>{item.provider.name} · {t('status.' + item.status)}</p>
        <p>{new Date(item.createdAt).toLocaleString(intl.locale, { dateStyle: 'medium', timeStyle: 'short' })}</p>
      </article>)}
    </section>
  </main>;
}
