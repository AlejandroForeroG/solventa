import { assistanceSearchPath, parseAssistanceResults } from '@solventa/contracts';
import type { AssistanceProviderMatch } from '@solventa/contracts';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useIntl } from 'react-intl';
import { fetchWithSession } from '../session-fetch';
import { Icon, type IconName } from '../navigation/Icon';

const kindStyle: Record<AssistanceProviderMatch['kind'], { icon: IconName; tone: string }> = {
  workshop: { icon: 'wrench', tone: 'amber' }, expert: { icon: 'user', tone: 'violet' }, roadside: { icon: 'truck', tone: 'blue' },
};

type Results = { state: 'idle' | 'loading' | 'unavailable' } | { state: 'ready'; providers: AssistanceProviderMatch[] };

export function ProviderSearch({ onSessionLost }: { onSessionLost: () => void }) {
  const intl = useIntl();
  const t = (key: string) => intl.formatMessage({ id: `assistance.${key}` });
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<Results>({ state: 'idle' });
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => {
    active.current?.abort();
    active.current = null;
  }, []);

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
      if (!controller.signal.aborted) setResult({ state: 'ready', providers });
    } catch {
      if (active.current === controller) setResult({ state: 'unavailable' });
    } finally { clearTimeout(timer); }
  }

  return <main className="content assistance">
    <div className="page-title"><span className="page-icon page-icon-amber" aria-hidden="true"><Icon name="location" size={22} /></span><h1>{t('title')}</h1></div>
    <p className="assistance-simulated"><span className="pill pill-pending"><Icon name="info" size={14} />{t('simulation')}</span></p>
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
      </div>
    </article></li>)}</ul>}
  </main>;
}
