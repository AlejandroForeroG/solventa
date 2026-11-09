import { assistanceSearchPath, parseAssistanceResults } from '@solventa/contracts';
import type { AssistanceProviderMatch } from '@solventa/contracts';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useIntl } from 'react-intl';

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
      const response = await fetch(assistanceSearchPath, {
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

  return <main className="content">
    <h1>{t('title')}</h1>
    <p>{t('simulation')}</p>
    <form className="card field assistance-search" onSubmit={event => void submit(event)}>
      <label htmlFor="provider-place">{t('place')}</label>
      <input id="provider-place" value={query} onChange={event => setQuery(event.target.value)} maxLength={160} />
      <button className="btn btn-primary" type="submit" disabled={query.trim().length < 2}>{t('search')}</button>
    </form>
    {result.state === 'loading' && <p role="status">{t('loading')}</p>}
    {result.state === 'unavailable' && <p role="alert">{t('unavailable')}</p>}
    {result.state === 'ready' && result.providers.length === 0 && <p role="status">{t('empty')}</p>}
    {result.state === 'ready' && result.providers.map(provider => <article className="card assistance-result" key={provider.id}>
      <p>{t(provider.kind)}</p>
      <h2>{provider.name}</h2>
      <p>{provider.address}, {provider.city}</p>
      <p>{t('contact')} · {provider.phone}</p>
      <p>{t('hours')} · {provider.hours}</p>
    </article>)}
  </main>;
}
