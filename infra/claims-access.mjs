import { createGrantAdministration } from './grant-administration.mjs';

const administration = createGrantAdministration({ table: 'claims_access_grants', operations: ['claims:read', 'claims:decide'],
  resourceType: 'claims_access_grant', failureCode: 'claims_access_change_failed' });
export const validateClaimsGrantInput = administration.validate;
export const changeClaimsGrant = administration.change;
administration.runWhenInvoked(import.meta.url);
