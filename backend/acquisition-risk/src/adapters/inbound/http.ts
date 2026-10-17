import { Hono } from 'hono';
import type { CreateQuote } from '../../application/create-quote';
import { quotesHandler } from './quotes-http';
import type { EstimateQuote } from '../../application/estimate-quote';
import { estimateHandler } from './estimate-http';
import { mountOffers, type OffersHttpDependencies } from './offers-http';

export function createHttp(deps: { quotes: CreateQuote; estimates: EstimateQuote; offers?: OffersHttpDependencies }) {
  const app = new Hono<{ Bindings: AcquisitionEnv }>();
  app.get('/health', (c) => c.json({ service: 'acquisition-risk', status: 'alive' }));
  app.post('/api/v1/quote-estimates', estimateHandler(deps.estimates));
  app.post('/api/v1/quotes', quotesHandler(deps.quotes, 'partner'));
  app.post('/api/v1/me/quotes', quotesHandler(deps.quotes, 'web'));
  if (deps.offers) mountOffers(app, deps.offers);
  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  return app;
}
