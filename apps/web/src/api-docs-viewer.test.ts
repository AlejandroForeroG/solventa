/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Script } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const viewerSource = readFileSync(resolve('../../tools/api-docs/viewer.js'), 'utf8');
const viewerHtml = readFileSync(resolve('../../tools/api-docs/index.html'), 'utf8');
const catalog = [
  { name: 'Identity', url: '/api/docs/v1/identity-access.json' },
  { name: 'Quotes', url: '/api/docs/v1/quotes.json' },
];

async function loadPage(url: string) {
  const page = new DOMParser().parseFromString(viewerHtml, 'text/html');
  const navigate = vi.fn();
  const location = { href: url, origin: new URL(url).origin, assign: navigate };
  const createApiReference = vi.fn();
  const fetch = vi.fn(async (path: string) => ({
    ok: true,
    headers: new Headers({ 'x-solventa-environment': 'dev' }),
    json: async () => path.endsWith('catalog.json') ? catalog : { info: { title: path } },
  }));
  await new Script(`(async () => {${viewerSource}\n})()`, { filename: 'viewer.js' }).runInNewContext({
    document: page,
    window: {
      location,
      history: { replaceState: (_state: unknown, _title: string, target: URL) => { location.href = target.href; } },
      Scalar: { createApiReference },
    },
    Option,
    URL,
    fetch,
    ResizeObserver: class { observe() {} },
  });
  const selector = page.querySelector<HTMLSelectElement>('#spec-select')!;
  return { page, selector, navigate, location, createApiReference, fetch };
}

describe('API reference specification navigation', () => {
  it.each([
    ['v1/quotes', 'v1/identity-access'],
    ['v1/identity-access', 'v1/quotes'],
  ])('opens a fresh %s → %s reference after Schemas navigation', async (initial, target) => {
    const current = await loadPage(`https://web.example/api/docs/?spec=${initial}`);
    // Scalar changes this URL while it may still have a pending lazy scroll.
    current.location.href = `${current.location.href}#schemas`;
    current.selector.value = `/api/docs/${target}.json`;
    current.selector.dispatchEvent(new Event('change'));

    expect(current.navigate).toHaveBeenCalledTimes(1);
    const destination = new URL(String(current.navigate.mock.calls[0][0]));
    expect(destination.origin).toBe('https://web.example');
    expect(destination.pathname).toBe('/api/docs/');
    expect(destination.searchParams.get('spec')).toBe(target);
    expect(destination.hash).toBe('');
    expect(current.createApiReference).toHaveBeenCalledTimes(1);
    expect(current.fetch).toHaveBeenCalledTimes(2);

    const next = await loadPage(destination.href);
    expect(next.selector.value).toBe(`/api/docs/${target}.json`);
    expect(next.createApiReference.mock.calls[0][1].content.info.title).toBe(`/api/docs/${target}.json`);
    expect(next.page.querySelector('#download-spec')?.getAttribute('href')).toBe(`/api/docs/${target}.json`);
    expect(next.page.querySelector<HTMLElement>('#status')?.hidden).toBe(true);
  });

  it('keeps a shared operation hash and selected domain when loading its page', async () => {
    const url = 'https://web.example/api/docs/?spec=v1/quotes#tag/quotes/POST/quotes';
    const current = await loadPage(url);
    expect(current.selector.value).toBe('/api/docs/v1/quotes.json');
    expect(new URL(current.location.href).hash).toBe('#tag/quotes/POST/quotes');
    expect(current.navigate).not.toHaveBeenCalled();
  });
});
