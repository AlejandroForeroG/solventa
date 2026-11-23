export const operationsSessionHeader = 'X-Solventa-Session-Include';
export const operationalWorkspaces = ['claims', 'reports', 'audit', 'advisor', 'partner'] as const;
export type OperationalWorkspace = typeof operationalWorkspaces[number];
