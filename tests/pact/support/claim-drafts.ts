import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import examples from '../../../packages/contracts/examples/claim-drafts.json';
import { mountClaimDrafts } from '../../../backend/policy-claims-payments/src/adapters/inbound/claim-drafts-http';
import { ClaimDrafts } from '../../../backend/policy-claims-payments/src/application/claim-drafts';
import type { ClaimDraftStore } from '../../../backend/policy-claims-payments/src/application/ports/claim-drafts';
import type { DraftCommand, DraftVersion } from '../../../backend/policy-claims-payments/src/domain/claim-draft';

export const draftVersion = examples.version as DraftVersion;
export const draftCommand = examples.command as DraftCommand;
export const draftConflict = { conflictId: draftCommand.commandId, draftId: examples.draftId, base: draftVersion,
  server: { ...draftVersion, revision: 2, content: { ...draftVersion.content, description: 'Synthetic server note' } },
  local: draftCommand.content, fields: ['description'] as const, policy: 'claim-draft.fields.v1' as const };

// Persistence and Identity are substituted here; consumer parsing, routing and the actual policy use case are exercised.
// Concurrency, ownership, ledger and audit transactions are covered against CockroachDB by the SQL suite.
export function draftPactWorld(mode: 'ready' | 'conflict' | 'resolved' | 'unavailable') {
  const store: ClaimDraftStore = { list: async () => [draftVersion], get: async () => draftVersion, evidence: async () => [],
    sync: async input => {
      if (mode === 'unavailable') throw Error('synthetic persistence outage');
      return mode === 'conflict' ? { status: 'conflict', conflict: { ...draftConflict, fields: [...draftConflict.fields] } }
        : { status: 'confirmed', merged: false, draft: { ...draftVersion, revision: 2, content: input.command.content } };
    } };
  const app = new Hono<{ Bindings: PolicyEnv }>();
  mountClaimDrafts(app, { drafts: new ClaimDrafts(store, { sha256Hex: async text => createHash('sha256').update(text).digest('hex') }),
    authorize: async input => input.token === 'synthetic.jwt.token' ? { allowed: true, actor: { kind: 'user', channel: 'mobile', principal: examples.owner, operations: ['claims:report'] } }
      : { allowed: false, status: 401, error: 'unauthorized' } });
  return { fetch: (request: Request) => Promise.resolve(app.fetch(request, {} as PolicyEnv)) };
}
