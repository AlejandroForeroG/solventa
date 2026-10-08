import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { messages } from './messages';

const es = messages['es-CO'];
const en = messages['en-US'];
// Names, codes and symbols that are the same in both languages.
const SAME_IN_BOTH = new Set(['locale.es-CO', 'locale.en-US', 'source.open_finance_bancolombia.name', 'source.datacredito_experian.name', 'source.registraduria.name', 'kind.open_finance', 'privacy.period']);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) && name !== 'messages.ts' ? [path] : [];
  });
}

describe('message catalogues', () => {
  it('define the same keys in both languages', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(es).sort());
  });

  it('translate every text except names and codes', () => {
    const untranslated = Object.keys(es).filter(key => es[key] === en[key] && !SAME_IN_BOTH.has(key));
    expect(untranslated).toEqual([]);
  });

  it('use the same placeholders in both languages', () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)/g)].map(match => match[1]).sort();
    for (const key of Object.keys(es)) expect(placeholders(en[key]), key).toEqual(placeholders(es[key]));
  });

  it('are the only place where interface text is written: no component hard-codes a message id that is missing', () => {
    const used = new Set<string>();
    for (const file of sources('src')) {
      for (const match of readFileSync(file, 'utf8').matchAll(/id: ['`]([\w.${}-]+)['`]/g)) used.add(match[1]);
    }
    const dynamic = [...used].filter(id => id.includes('${'));
    const fixed = [...used].filter(id => !id.includes('${'));
    expect(fixed.filter(id => !(id in es))).toEqual([]);
    expect(dynamic.length).toBeGreaterThan(0);
  });

  it('keep the dynamic keys complete: every source, type and status has its text', () => {
    for (const code of ['open_finance_bancolombia', 'datacredito_experian', 'ruaf', 'registraduria']) {
      for (const part of ['name', 'detail']) expect(es[`source.${code}.${part}`], code).toBeTruthy();
    }
    for (const kind of ['open_finance', 'credit_bureau', 'open_data']) expect(es[`kind.${kind}`]).toBeTruthy();
    for (const status of ['active', 'revoked', 'expired']) expect(es[`status.${status}`]).toBeTruthy();
    for (const n of [1, 2, 3, 4, 5, 6, 7]) expect(es[`stepper.${n}`]).toBeTruthy();
    for (const code of ['es-CO', 'en-US']) expect(es[`locale.${code}`]).toBeTruthy();
  });
});
