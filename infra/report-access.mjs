import { createGrantAdministration } from './grant-administration.mjs';

const administration = createGrantAdministration({ table: 'report_access_grants',
  operations: ['reports:generate', 'reports:read', 'reports:download', 'reports:send'],
  resourceType: 'report_access_grant', failureCode: 'report_access_change_failed' });
export const validateReportGrantInput = administration.validate;
export const changeReportGrant = administration.change;
administration.runWhenInvoked(import.meta.url);
