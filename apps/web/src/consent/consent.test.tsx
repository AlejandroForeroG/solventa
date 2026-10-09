import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { I18n, useLocale } from '../i18n/I18n';
import type { Locale } from '../i18n/messages';
import { LiveRegion } from '../quote/Live';
import { QuoteFlow } from '../quote/QuoteFlow';
import type { Quote } from '../quote/api';
import { declineConsent, getTerms, grantConsent, listConsents, revokeConsent, type Consent, type ConsentApi, type Outcome, type Terms } from './api';
import { ConsentDeclined, ConsentGranted } from './ConsentOutcome';
import { ConsentStep } from './ConsentStep';
import { SUPPORTED_TEXT_VERSION } from './wording';
import { PrivacyPanel } from './PrivacyPanel';

const terms: Terms = {
  purposeCode: 'risk_profiling', textVersion: 1, validityDays: 90,
  sources: [
    { code: 'open_finance_bancolombia', scope: 'income_obligations_12m', kind: 'open_finance' },
    { code: 'datacredito_experian', scope: 'payment_history_score', kind: 'credit_bureau' },
    { code: 'ruaf', scope: 'affiliation_regime', kind: 'open_data' },
    { code: 'registraduria', scope: 'identity_validation', kind: 'open_data' }
  ]
};
const sources = terms.sources.map(s => s.code);
const scopes = terms.sources.map(s => s.scope);
const active: Consent = { consentId: 'CNS-2026-00003', status: 'active', sources, scopes, grantedAt: '2026-10-08T15:00:00Z', expiresAt: '2027-01-06T15:00:00Z', revokedAt: null, seal: 'a'.repeat(64) };
const revoked: Consent = { ...active, consentId: 'CNS-2026-00002', status: 'revoked', revokedAt: '2026-10-09T16:30:00Z', seal: 'b'.repeat(64) };
const expired: Consent = { ...active, consentId: 'CNS-2026-00001', status: 'expired', grantedAt: '2026-06-01T14:00:00Z', expiresAt: '2026-08-30T14:00:00Z', seal: 'c'.repeat(64) };
const quote: Quote = { quoteId: 'COT-2026-08843', premiumMonthly: 86400, currency: 'COP', sumInsured: 320000000, termMonths: 180, validUntil: '2026-11-05T10:47:00-05:00', basis: 'minimum_data', ruleVersion: 'provisional-1', traceId: '7f3c2a9e1b4d4c8aa0d1e2f3a4b5c6d7' };

const ok = <T,>(value: T): Outcome<T> => ({ kind: 'ok', value });
function stubs(over: Partial<Record<keyof ConsentApi, Mock>> = {}): Record<keyof ConsentApi, Mock> {
  return {
    getTerms: vi.fn().mockResolvedValue(ok(terms)),
    grantConsent: vi.fn().mockResolvedValue(ok(active)),
    declineConsent: vi.fn().mockResolvedValue(ok(true)),
    listConsents: vi.fn().mockResolvedValue(ok([active, revoked, expired])),
    revokeConsent: vi.fn().mockResolvedValue(ok({ ...active, status: 'revoked', revokedAt: '2026-10-10T12:00:00Z' })),
    ...over
  };
}
const live = () => screen.getByTestId('live-region');
const wrap = (locale: Locale, children: React.ReactNode) => <I18n initial={locale}><LiveRegion><main>{children}</main></LiveRegion></I18n>;

const text = {
  'es-CO': { authorize: 'Autorizar y continuar', decline: 'No autorizo', revoke: (id: string) => `Revocar la autorización ${id}`, confirm: 'Sí, revocar', cancel: 'Cancelar', retry: 'Reintentar', title: 'Autoriza el uso de tus datos financieros', safe: 'No autorizaste el uso de tus datos financieros', panel: 'Tus datos y quién los usa', revokedPill: 'Revocado', activePill: 'Activo', expiredPill: 'Vencido', days: /90 días/ },
  'en-US': { authorize: 'Authorize and continue', decline: 'I do not authorize', revoke: (id: string) => `Revoke authorization ${id}`, confirm: 'Yes, revoke', cancel: 'Cancel', retry: 'Retry', title: 'Authorize the use of your financial data', safe: 'You did not authorize the use of your financial data', panel: 'Your data and who uses it', revokedPill: 'Revoked', activePill: 'Active', expiredPill: 'Expired', days: /90 days/ }
} as const;

afterEach(() => vi.restoreAllMocks());

describe.each(['es-CO', 'en-US'] as const)('consent step in %s', locale => {
  const t = text[locale];
  function setup(api = stubs(), props: Partial<React.ComponentProps<typeof ConsentStep>> = {}) {
    const onGranted = vi.fn(); const onDeclined = vi.fn(); const onSessionLost = vi.fn();
    const user = userEvent.setup();
    const view = render(wrap(locale, <ConsentStep quoteRef="COT-2026-08843" api={api as never} onGranted={onGranted} onDeclined={onDeclined} onSessionLost={onSessionLost} {...props} />));
    return { user, api, onGranted, onDeclined, onSessionLost, ...view };
  }

  it('shows the purpose, the sources and the validity before asking for the authorization', async () => {
    const { api } = setup();
    expect(await screen.findByRole('heading', { level: 1, name: t.title })).toHaveFocus();
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(3);
    const list = screen.getByRole('list');
    expect(within(list).getAllByRole('listitem')).toHaveLength(4);
    expect(within(list).getByText(/Bancolombia/)).toBeInTheDocument();
    expect(within(list).getByText(/Datacrédito/)).toBeInTheDocument();
    expect(within(list).getByText(/RUAF/)).toBeInTheDocument();
    expect(within(list).getByText(/Registraduría/)).toBeInTheDocument();
    expect(screen.getByText(t.days).closest('p')).toHaveTextContent(/2026|2027/);
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(screen.getByRole('button', { name: t.authorize })).toBeDisabled();
    expect(api.grantConsent).not.toHaveBeenCalled();
    await waitFor(() => expect(live()).toHaveTextContent(locale === 'es-CO' ? 'autorización de datos financieros' : 'authorization screen'));
  });

  it('records the authorization with the text version and the quote only after the checkbox, then reports it', async () => {
    const { user, api, onGranted } = setup();
    await user.click(await screen.findByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: t.authorize }));
    await waitFor(() => expect(onGranted).toHaveBeenCalledWith(active));
    expect(api.grantConsent).toHaveBeenCalledOnce();
    expect(api.grantConsent.mock.calls[0][0]).toEqual({ textVersion: SUPPORTED_TEXT_VERSION, locale, quoteRef: 'COT-2026-08843' });
    expect(api.grantConsent.mock.calls[0][1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(live()).toHaveTextContent(/2027/);
  });

  it('declining records the refusal and grants nothing', async () => {
    const { user, api, onDeclined, onGranted } = setup();
    await user.click(await screen.findByRole('button', { name: t.decline }));
    await waitFor(() => expect(onDeclined).toHaveBeenCalledOnce());
    expect(api.declineConsent).toHaveBeenCalledWith(1);
    expect(api.grantConsent).not.toHaveBeenCalled();
    expect(onGranted).not.toHaveBeenCalled();
  });

  it('works from the keyboard alone', async () => {
    const { user, onGranted } = setup();
    await screen.findByRole('checkbox');
    await user.tab();
    expect(screen.getByRole('checkbox')).toHaveFocus();
    await user.keyboard(' ');
    expect(screen.getByRole('checkbox')).toBeChecked();
    await user.tab();
    expect(screen.getByRole('button', { name: t.decline })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: t.authorize })).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(onGranted).toHaveBeenCalledOnce());
  });

  it('has no accessibility violations', async () => {
    const { container } = setup();
    await screen.findByRole('checkbox');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('safe exit keeps the estimate, says nothing else is issued and offers both ways back', async () => {
    const onReview = vi.fn(); const onBack = vi.fn();
    const user = userEvent.setup();
    const { container } = render(wrap(locale, <ConsentDeclined premium={86400} onReview={onReview} onBack={onBack} />));
    expect(screen.getByRole('heading', { level: 1, name: t.safe })).toHaveFocus();
    expect(screen.getByText(/86[.,]400/)).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: /oferta|offer|póliza|policy|pagar|pay/i })).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
    await user.click(screen.getByRole('button', { name: locale === 'es-CO' ? 'Revisar la autorización' : 'Review the authorization' }));
    await user.click(screen.getByRole('button', { name: locale === 'es-CO' ? 'Volver a mi estimación' : 'Back to my estimate' }));
    expect(onReview).toHaveBeenCalledOnce();
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('confirmation shows the authorization id and its validity and opens the privacy dashboard', async () => {
    const onPanel = vi.fn(); const onBack = vi.fn();
    const user = userEvent.setup();
    const { container } = render(wrap(locale, <ConsentGranted consent={active} onPanel={onPanel} onBack={onBack} />));
    expect(screen.getByText(/CNS-2026-00003/)).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
    await user.click(screen.getByRole('button', { name: locale === 'es-CO' ? 'Ver panel de privacidad' : 'View privacy dashboard' }));
    expect(onPanel).toHaveBeenCalledOnce();
  });
});

describe('consent step failures', () => {
  function setup(api: ReturnType<typeof stubs>) {
    const onGranted = vi.fn(); const onDeclined = vi.fn(); const onSessionLost = vi.fn();
    const user = userEvent.setup();
    render(wrap('es-CO', <ConsentStep api={api as never} onGranted={onGranted} onDeclined={onDeclined} onSessionLost={onSessionLost} />));
    return { user, onGranted, onDeclined, onSessionLost };
  }

  it('offers a retry when the terms cannot be loaded and never shows the authorize button', async () => {
    const api = stubs({ getTerms: vi.fn().mockResolvedValueOnce({ kind: 'unavailable' }).mockResolvedValue(ok(terms)) });
    const { user } = setup(api);
    expect(await screen.findByText(/No pudimos cargar los términos/, { selector: 'p' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Autorizar y continuar' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByRole('button', { name: 'Autorizar y continuar' })).toBeInTheDocument();
  });

  it('keeps the screen when recording fails, says no source was queried and retries with the same key', async () => {
    const api = stubs({ grantConsent: vi.fn().mockResolvedValueOnce({ kind: 'unavailable' }).mockResolvedValue(ok(active)) });
    const { user, onGranted } = setup(api);
    await user.click(await screen.findByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Autorizar y continuar' }));
    expect(await screen.findByText(/No se consultó ninguna fuente/, { selector: 'p' })).toBeInTheDocument();
    expect(onGranted).not.toHaveBeenCalled();
    await waitFor(() => expect(live()).toHaveTextContent('No se pudo registrar la autorización'));
    await user.click(screen.getByRole('button', { name: 'Autorizar y continuar' }));
    await waitFor(() => expect(onGranted).toHaveBeenCalledOnce());
    expect(api.grantConsent.mock.calls[1][1]).toBe(api.grantConsent.mock.calls[0][1]);
  });

  it('reloads the terms and asks again when the text changed meanwhile', async () => {
    const api = stubs({ grantConsent: vi.fn().mockResolvedValue({ kind: 'outdated' }) });
    const { user, onGranted } = setup(api);
    await user.click(await screen.findByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Autorizar y continuar' }));
    expect(await screen.findByText('El texto de la autorización cambió. Revísalo antes de autorizar.')).toBeInTheDocument();
    await waitFor(() => expect(api.getTerms).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('checkbox')).not.toBeChecked();
    expect(onGranted).not.toHaveBeenCalled();
  });

  it('hands over to the sign-in when the session ended', async () => {
    const api = stubs({ grantConsent: vi.fn().mockResolvedValue({ kind: 'unauthenticated' }) });
    const { user, onSessionLost } = setup(api);
    await user.click(await screen.findByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Autorizar y continuar' }));
    await waitFor(() => expect(onSessionLost).toHaveBeenCalledOnce());
  });

  it('a refusal never depends on the audit write', async () => {
    const api = stubs({ declineConsent: vi.fn().mockResolvedValue({ kind: 'unavailable' }) });
    const { user, onDeclined } = setup(api);
    await user.click(await screen.findByRole('button', { name: 'No autorizo' }));
    await waitFor(() => expect(onDeclined).toHaveBeenCalledOnce());
  });

  it('does not offer the authorization when the served terms are another text version than the one the screen shows', async () => {
    const api = stubs({ getTerms: vi.fn().mockResolvedValue(ok({ ...terms, textVersion: SUPPORTED_TEXT_VERSION + 1 })) });
    setup(api);
    expect(await screen.findByText(/no corresponde a los términos vigentes/, { selector: 'p' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Autorizar y continuar' })).toBeNull();
    expect(api.grantConsent).not.toHaveBeenCalled();
  });

  it('sends the language the customer reads, and a new key when the language changes after a failed attempt', async () => {
    const api = stubs({ grantConsent: vi.fn().mockResolvedValueOnce({ kind: 'unavailable' }).mockResolvedValue(ok(active)) });
    const user = userEvent.setup();
    function Switch() { const { setLocale } = useLocale(); return <button type="button" onClick={() => setLocale('en-US')}>to-english</button>; }
    render(wrap('es-CO', <><Switch /><ConsentStep api={api as never} onGranted={vi.fn()} onDeclined={vi.fn()} /></>));
    await user.click(await screen.findByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Autorizar y continuar' }));
    await screen.findByText(/No se consultó ninguna fuente/, { selector: 'p' });
    await user.click(screen.getByRole('button', { name: 'to-english' }));
    await user.click(await screen.findByRole('button', { name: 'Authorize and continue' }));
    await waitFor(() => expect(api.grantConsent).toHaveBeenCalledTimes(2));
    expect(api.grantConsent.mock.calls.map(call => call[0].locale)).toEqual(['es-CO', 'en-US']);
    expect(api.grantConsent.mock.calls[1][1]).not.toBe(api.grantConsent.mock.calls[0][1]);
  });

  it('prevents a double submit while the grant is in flight', async () => {
    let finish: (value: unknown) => void = () => {};
    const api = stubs({ grantConsent: vi.fn().mockReturnValue(new Promise(resolve => { finish = resolve; })) });
    const { user, onGranted } = setup(api);
    await user.click(await screen.findByRole('checkbox'));
    const button = screen.getByRole('button', { name: 'Autorizar y continuar' });
    await user.click(button);
    expect(screen.getByRole('button', { name: 'Registrando tu autorización…' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Registrando tu autorización…' }));
    finish(ok(active));
    await waitFor(() => expect(onGranted).toHaveBeenCalledOnce());
    expect(api.grantConsent).toHaveBeenCalledOnce();
  });
});

describe.each(['es-CO', 'en-US'] as const)('privacy dashboard in %s', locale => {
  const t = text[locale];
  function setup(api = stubs()) {
    const onBack = vi.fn(); const onSessionLost = vi.fn();
    const user = userEvent.setup();
    const view = render(wrap(locale, <PrivacyPanel api={api as never} onBack={onBack} onSessionLost={onSessionLost} />));
    return { user, api, onBack, onSessionLost, ...view };
  }

  it('lists every authorization with its id, status, period, sources and seal, and only an active one can be revoked', async () => {
    const { container } = setup();
    expect(await screen.findByRole('heading', { level: 1, name: t.panel })).toHaveFocus();
    const items = await screen.findAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(within(items[0]).getByText('CNS-2026-00003')).toBeInTheDocument();
    expect(within(items[0]).getByText(t.activePill)).toBeInTheDocument();
    expect(within(items[0]).getByText(/aaaa…aaaa/)).toBeInTheDocument();
    const scope = within(items[0]).getByText(/^(Alcance|Scope):/);
    for (const text of locale === 'es-CO' ? ['Ingresos y obligaciones', 'Historial de pagos', 'Afiliación y régimen', 'Validación de identidad'] : ['Income and obligations', 'Payment history', 'Affiliation and regime', 'Identity validation']) expect(scope).toHaveTextContent(text);
    expect(within(items[1]).getByText(t.revokedPill)).toBeInTheDocument();
    expect(within(items[2]).getByText(t.expiredPill)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Revo/ })).toHaveLength(1);
    expect(screen.getByRole('button', { name: t.revoke('CNS-2026-00003') })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('asks for confirmation, revokes, shows the new status and announces it', async () => {
    const { user, api } = setup();
    await user.click(await screen.findByRole('button', { name: t.revoke('CNS-2026-00003') }));
    expect(screen.getByRole('button', { name: t.confirm })).toHaveFocus();
    expect(api.revokeConsent).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: t.confirm }));
    await waitFor(() => expect(api.revokeConsent).toHaveBeenCalledWith('CNS-2026-00003'));
    await waitFor(() => expect(screen.queryByRole('button', { name: t.revoke('CNS-2026-00003') })).toBeNull());
    expect(screen.getAllByText(t.revokedPill)).toHaveLength(2);
    expect(live()).toHaveTextContent('CNS-2026-00003');
  });

  it('cancelling leaves the authorization active and untouched', async () => {
    const { user, api } = setup();
    await user.click(await screen.findByRole('button', { name: t.revoke('CNS-2026-00003') }));
    await user.click(screen.getByRole('button', { name: t.cancel }));
    expect(api.revokeConsent).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: t.revoke('CNS-2026-00003') })).toBeInTheDocument();
  });

  it('works from the keyboard alone', async () => {
    const { user, api } = setup();
    const button = await screen.findByRole('button', { name: t.revoke('CNS-2026-00003') });
    button.focus();
    await user.keyboard('{Enter}');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(api.revokeConsent).toHaveBeenCalledOnce());
  });
});

describe('privacy dashboard states', () => {
  it('says so when there is nothing to show', async () => {
    render(wrap('es-CO', <PrivacyPanel api={stubs({ listConsents: vi.fn().mockResolvedValue(ok([])) }) as never} onBack={vi.fn()} />));
    expect(await screen.findByText('Aún no has dado ninguna autorización.')).toBeInTheDocument();
  });

  it('offers a retry when the list cannot be loaded', async () => {
    const api = stubs({ listConsents: vi.fn().mockResolvedValueOnce({ kind: 'unavailable' }).mockResolvedValue(ok([active])) });
    const user = userEvent.setup();
    render(wrap('es-CO', <PrivacyPanel api={api as never} onBack={vi.fn()} />));
    expect(await screen.findByText('No pudimos cargar tus autorizaciones.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByText('CNS-2026-00003')).toBeInTheDocument();
  });

  it('keeps the authorization active and says so when the revocation fails', async () => {
    const api = stubs({ revokeConsent: vi.fn().mockResolvedValue({ kind: 'unavailable' }) });
    const user = userEvent.setup();
    render(wrap('es-CO', <PrivacyPanel api={api as never} onBack={vi.fn()} />));
    await user.click(await screen.findByRole('button', { name: 'Revocar la autorización CNS-2026-00003' }));
    await user.click(screen.getByRole('button', { name: 'Sí, revocar' }));
    expect(await screen.findByText(/Sigue vigente/)).toBeInTheDocument();
    expect(screen.getByText('Activo')).toBeInTheDocument();
    await waitFor(() => expect(live()).toHaveTextContent('No se pudo revocar'));
  });

  it('reloads the list when the authorization is no longer there to revoke', async () => {
    const api = stubs({ revokeConsent: vi.fn().mockResolvedValue({ kind: 'conflict' }), listConsents: vi.fn().mockResolvedValueOnce(ok([active])).mockResolvedValue(ok([{ ...active, status: 'expired' }])) });
    const user = userEvent.setup();
    render(wrap('es-CO', <PrivacyPanel api={api as never} onBack={vi.fn()} />));
    await user.click(await screen.findByRole('button', { name: 'Revocar la autorización CNS-2026-00003' }));
    await user.click(screen.getByRole('button', { name: 'Sí, revocar' }));
    expect(await screen.findByText('Vencido')).toBeInTheDocument();
    expect(api.listConsents).toHaveBeenCalledTimes(2);
  });

  it('hands over to the sign-in when the session ended', async () => {
    const onSessionLost = vi.fn();
    render(wrap('es-CO', <PrivacyPanel api={stubs({ listConsents: vi.fn().mockResolvedValue({ kind: 'unauthenticated' }) }) as never} onBack={vi.fn()} onSessionLost={onSessionLost} />));
    await waitFor(() => expect(onSessionLost).toHaveBeenCalledOnce());
  });
});

describe('from the quote to the authorization', () => {
  const request = vi.fn().mockResolvedValue({ kind: 'quote', quote });
  async function toConsent(api: ReturnType<typeof stubs>, onOpenPrivacy = vi.fn()) {
    const user = userEvent.setup();
    render(wrap('es-CO', <QuoteFlow request={request as never} consent={api as never} onOpenPrivacy={onOpenPrivacy} />));
    for (const [label, value] of [[/Nombre completo/, 'Cliente Sintetico Uno'], [/Documento/, '1000000001'], [/Fecha de nacimiento/, '1992-03-14'], [/Ciudad/, 'Bogotá D.C.'], [/Monto/, '320000000'], [/Plazo/, '180']] as const) {
      await user.type(screen.getByLabelText(label), value);
    }
    await user.click(screen.getByRole('button', { name: 'Calcular cotización' }));
    await user.click(await screen.findByRole('button', { name: 'Continuar a autorización de datos' }));
    return user;
  }

  it('authorizing ends on the confirmation and links the quote to the authorization', async () => {
    const api = stubs();
    const onOpenPrivacy = vi.fn();
    const user = await toConsent(api, onOpenPrivacy);
    await user.click(await screen.findByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Autorizar y continuar' }));
    expect(await screen.findByRole('heading', { name: 'Autorización registrada' })).toHaveFocus();
    expect(api.grantConsent.mock.calls[0][0]).toEqual({ textVersion: 1, locale: 'es-CO', quoteRef: 'COT-2026-08843' });
    expect(screen.getByRole('listitem', { current: 'step' })).toHaveTextContent('Paso 3: Consentimiento');
    await user.click(screen.getByRole('button', { name: 'Ver panel de privacidad' }));
    expect(onOpenPrivacy).toHaveBeenCalledOnce();
  });

  it('declining shows the safe exit with the estimate and the way back to it', async () => {
    const api = stubs();
    const user = await toConsent(api);
    await user.click(await screen.findByRole('button', { name: 'No autorizo' }));
    expect(await screen.findByRole('heading', { name: 'No autorizaste el uso de tus datos financieros' })).toHaveFocus();
    expect(screen.getByText(/86[.,]400/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Revisar la autorización' }));
    expect(await screen.findByRole('button', { name: 'Autorizar y continuar' })).toBeDisabled();
    expect(api.getTerms).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole('button', { name: 'No autorizo' }));
    await user.click(await screen.findByRole('button', { name: 'Volver a mi estimación' }));
    expect(await screen.findByText('COT-2026-08843')).toBeInTheDocument();
  });
});

describe('consent client', () => {
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const spy = (...responses: (Response | Error)[]) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    for (const response of responses) fetchMock.mockImplementationOnce(async () => { if (response instanceof Error) throw response; return response; });
    return fetchMock;
  };

  it('sends the grant with the session cookie, the key and no identity of its own', async () => {
    const fetchMock = spy(json({ ...active }, 201));
    const outcome = await grantConsent({ textVersion: 1, locale: 'es-CO', quoteRef: 'COT-2026-00001' }, 'key-1');
    expect(outcome).toEqual({ kind: 'ok', value: { consentId: 'CNS-2026-00003', status: 'active', sources, scopes, grantedAt: active.grantedAt, expiresAt: active.expiresAt, revokedAt: null, seal: active.seal } });
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe('/api/v1/consents');
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin' });
    expect(new Headers(init?.headers).get('idempotency-key')).toBe('key-1');
    expect(JSON.parse(String(init?.body))).toEqual({ textVersion: 1, locale: 'es-CO', quoteRef: 'COT-2026-00001' });
  });

  it('renews the session once on a 401 and repeats the same grant with the same key', async () => {
    const fetchMock = spy(json({ error: 'unauthorized' }, 401), json({ authenticated: true }), json(active, 201));
    expect((await grantConsent({ textVersion: 1, locale: 'es-CO' }, 'key-9')).kind).toBe('ok');
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual(['/api/v1/consents', '/auth/session', '/api/v1/consents']);
    expect(new Headers(fetchMock.mock.calls[2][1]?.headers).get('idempotency-key')).toBe('key-9');
  });

  it('reports an unauthenticated user when the renewal fails', async () => {
    spy(json({ error: 'unauthorized' }, 401), json({ authenticated: false }, 401));
    expect(await listConsents()).toEqual({ kind: 'unauthenticated' });
  });

  it('tells apart an outdated text, another conflict, a missing consent and an outage', async () => {
    spy(json({ error: 'terms_outdated' }, 409)); expect(await grantConsent({ textVersion: 1, locale: 'es-CO' }, 'k')).toEqual({ kind: 'outdated' });
    spy(json({ error: 'idempotency_key_reused' }, 409)); expect(await grantConsent({ textVersion: 1, locale: 'es-CO' }, 'k')).toEqual({ kind: 'conflict' });
    spy(json({ error: 'not_found' }, 404)); expect(await revokeConsent('CNS-2026-00009')).toEqual({ kind: 'notFound' });
    spy(json({ error: 'consent_not_active' }, 409)); expect(await revokeConsent('CNS-2026-00001')).toEqual({ kind: 'conflict' });
    spy(json({ error: 'access_unavailable' }, 503)); expect(await declineConsent(1)).toEqual({ kind: 'unavailable' });
    spy(new TypeError('network')); expect(await getTerms()).toEqual({ kind: 'unavailable' });
  });

  it('does not trust a malformed answer', async () => {
    spy(json({ ...terms, sources: [] })); expect(await getTerms()).toEqual({ kind: 'unavailable' });
    spy(json({ items: [{ ...active, status: 'pending' }] })); expect(await listConsents()).toEqual({ kind: 'unavailable' });
    spy(new Response('not json', { status: 201 })); expect(await grantConsent({ textVersion: 1, locale: 'es-CO' }, 'k')).toEqual({ kind: 'unavailable' });
  });

  it('declining answers 204 and revoking encodes the id in the path', async () => {
    const fetchMock = spy(new Response(null, { status: 204 }), json({ ...active, status: 'revoked', revokedAt: '2026-10-10T12:00:00Z' }));
    expect(await declineConsent(1)).toEqual({ kind: 'ok', value: true });
    expect((await revokeConsent('CNS-2026-00003')).kind).toBe('ok');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/consents/CNS-2026-00003/revoke');
  });
});
