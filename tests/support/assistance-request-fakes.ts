import { createHash } from 'node:crypto';
import { findSyntheticProvider } from '../../backend/policy-claims-payments/src/adapters/outbound/synthetic-assistance-directory';
import { AssistanceRequests } from '../../backend/policy-claims-payments/src/application/assistance-requests';
import type { AssistanceRequestStore, CreateOutcome } from '../../backend/policy-claims-payments/src/application/ports/assistance-request';
import type { AssistanceRequestRecord } from '../../backend/policy-claims-payments/src/domain/assistance-request';

type Row = AssistanceRequestRecord & { owner: string; key: string; hash: string };
const strip = ({ owner: _owner, key: _key, hash: _hash, ...request }: Row): AssistanceRequestRecord => request;

export const digest = { sha256Hex: async (text: string) => createHash('sha256').update(text).digest('hex') };
export const directory = { find: (id: string) => findSyntheticProvider(id) };

// A faithful in-memory copy of the store's contract: a request is always resolved through its owner, and a key belongs to one request.
export function fakeAssistanceStore() {
  const rows: Row[] = [];
  const store: AssistanceRequestStore = {
    async create({ owner, provider, place, idempotencyKey, requestHash, newReference }): Promise<CreateOutcome> {
      const existing = rows.find(row => row.owner === owner.subjectToken && row.key === idempotencyKey);
      if (existing) return existing.hash === requestHash ? { status: 'replayed', request: strip(existing) } : { status: 'idempotency_conflict' };
      const row: Row = { id: `40000000-0000-4000-8000-${String(rows.length + 1).padStart(12, '0')}`, reference: newReference(), status: 'requested', provider, place,
        createdAt: new Date(Date.UTC(2026, 10, 12, 22, 30, rows.length)).toISOString(), owner: owner.subjectToken, key: idempotencyKey, hash: requestHash };
      rows.push(row);
      return { status: 'created', request: strip(row) };
    },
    async get(owner, id) { const row = rows.find(entry => entry.id === id && entry.owner === owner.subjectToken); return row ? strip(row) : null; },
    async listOwn(owner, limit) { return rows.filter(row => row.owner === owner.subjectToken).slice().reverse().slice(0, limit).map(strip); },
  };
  return { store, rows };
}

// References count up from a fixed prefix so a test, or a contract, sees the same one every run.
export function sequentialReference() {
  let counter = 0;
  return () => `ASI-${String(++counter).padStart(8, '2')}`;
}

export const assistanceRequests = (store: AssistanceRequestStore, newReference = sequentialReference()) => new AssistanceRequests(store, directory, digest, newReference);

// The body a customer sends, as the edge hands it to the use case once validated.
export const input = (providerId: string, place: { kind: 'address'; address: string } | { kind: 'device'; latitude: number; longitude: number }) => ({ providerId, place });
