import { clearCustomerDestination, customerDestination, customerDestinationPath, readCustomerDestination, saveCustomerDestination } from '../navigation/customer-destination';
export type PolicyDocumentDestination = { policyId: string };
export const clearPolicyDocumentDestination = clearCustomerDestination;
export function policyDocumentDestination(location: Pick<Location, 'pathname' | 'hash'> = window.location): PolicyDocumentDestination | null {
  const destination = customerDestination(location);
  return destination?.kind === 'policy' && destination.section === 'documents' ? { policyId: destination.policyId } : null;
}
export function policyDocumentPath(destination: PolicyDocumentDestination): string {
  return customerDestinationPath({ kind: 'policy', section: 'documents', ...destination });
}
export function savePolicyDocumentDestination(destination: PolicyDocumentDestination, now = Date.now()): boolean {
  return saveCustomerDestination({ kind: 'policy', section: 'documents', ...destination }, now);
}
export function readPolicyDocumentDestination(now = Date.now()): PolicyDocumentDestination | null {
  const destination = readCustomerDestination(now);
  return destination?.kind === 'policy' && destination.section === 'documents' ? { policyId: destination.policyId } : null;
}
