import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { randomUUID } from 'node:crypto';

const mobile = new URL('../apps/mobile/src/', import.meta.url);
type Node = { type: unknown; props: Record<string, unknown>; children: unknown[] };
let auth: Record<string, unknown>, snapshot: Record<string, unknown>;
let sync: Record<string, unknown> = {};
let hooks: unknown[] = [], cursor = 0, changed = false;
const createElement = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Node => ({ type, props: props ?? {}, children: children.flat() });
mock.module('react', { defaultExport: { createElement, Fragment: 'fragment' }, namedExports: {
  useState(initial: unknown) { const index = cursor++; if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial;
    return [hooks[index], (next: unknown) => { hooks[index] = typeof next === 'function' ? next(hooks[index]) : next; changed = true; }]; },
  useCallback: (callback: unknown) => callback, useEffect() {}, useRef: (current: unknown) => ({ current }),
} });
mock.module('react-native', { namedExports: { ActivityIndicator: 'ActivityIndicator', Platform: { OS: 'android' }, Pressable: 'Pressable', Text: 'Text', TextInput: 'TextInput', View: 'View' } });
mock.module('expo-router', { namedExports: { router: { back() {}, push() {} }, useFocusEffect() {} } });
mock.module('expo-crypto', { namedExports: { randomUUID } });
mock.module('expo-network', { namedExports: { useNetworkState: () => ({ isConnected: true, isInternetReachable: true }) } });
mock.module('@react-native-community/datetimepicker', { defaultExport: {}, namedExports: { DateTimePickerAndroid: { open() {} } } });
mock.module(new URL('features/authentication/presentation/AuthenticationProvider.tsx', mobile).href,
  { namedExports: { useAuthentication: () => auth, useAuthenticatedSession: () => ({ baseUrl: 'https://dev.solventa.site', execute() {} }) } });
mock.module(new URL('features/claim-drafts/presentation/DraftSyncProvider.tsx', mobile).href,
  { namedExports: { useDraftSync: () => ({ sync, snapshot }) } });
mock.module(new URL('features/claim-drafts/adapters/open-draft-workspace.ts', mobile).href, { namedExports: { openDraftWorkspace() {} } });
mock.module(new URL('features/claim-drafts/adapters/draft-api.ts', mobile).href, { namedExports: { createDraftApi() {} } });
mock.module(new URL('features/claim-report/presentation/ui.tsx', mobile).href, { namedExports: { Page: 'Page', Action: 'Action', ui: {} } });
mock.module(new URL('features/policy-wallet/presentation/use-now.ts', mobile).href, { namedExports: { useNow: () => 123 } });
mock.module(new URL('shared/i18n/use-app-messages.ts', mobile).href, { namedExports: { useAppMessages: () => ({}) } });
const { DraftsScreen } = await import('../apps/mobile/src/features/claim-drafts/presentation/DraftsScreen');
const owner = () => ({ clientId: randomUUID(), subjectToken: randomUUID() });
function render() {
  for (let i = 0; i < 8; i++) { changed = false; cursor = 0; const result = DraftsScreen({}) as Node; if (!changed) return result; }
  throw Error('render did not settle');
}
function workspace(node: unknown): Node | undefined {
  if (!node || typeof node !== 'object') return;
  const value = node as Node;
  if (typeof value.type === 'function' && value.type.name === 'Workspace') return value;
  return value.children?.map(workspace).find(Boolean);
}
function hiddenWorkspace(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  const value = node as Node;
  return value.type === 'View' && (value.props.style as { display?: string })?.display === 'none' && !!workspace(value)
    || !!value.children?.some(hiddenWorkspace);
}
test('device authentication and session restoration retain one hidden workspace instead of cancelling their own opening', () => {
  hooks = []; const who = owner(); auth = { status: 'authenticated', principal: who }; snapshot = { status: 'ready', owner: who, entries: [] };
  const key = workspace(render())?.props.key; assert.ok(workspace(render()));
  for (const status of ['locked', 'loading', 'biometricPrompt', 'authenticated']) {
    auth = { status, ...(status === 'authenticated' ? { principal: who } : {}) };
    const tree = render(); assert.ok(workspace(tree)); assert.equal(workspace(tree)?.props.key, key);
    assert.equal(hiddenWorkspace(tree), status !== 'authenticated');
  }
});
test('offline owner identification and same-owner reconnection preserve the editor, but an account change resets it', () => {
  hooks = []; const first = owner(); auth = { status: 'blocked', failure: 'unavailable' }; snapshot = { status: 'locked' };
  const key = workspace(render())?.props.key;
  snapshot = { status: 'ready', owner: first, entries: [] }; assert.equal(workspace(render())?.props.key, key);
  auth = { status: 'authenticated', principal: first }; assert.equal(workspace(render())?.props.key, key);
  auth = { status: 'authenticated', principal: owner() }; assert.notEqual(workspace(render())?.props.key, key);
});
test('sign-out and permanent access denial unmount the workspace; an initially locked session cannot open it', () => {
  hooks = []; auth = { status: 'locked' }; snapshot = { status: 'locked' }; assert.equal(workspace(render()), undefined);
  const who = owner(); auth = { status: 'authenticated', principal: who }; snapshot = { status: 'ready', owner: who, entries: [] }; assert.ok(workspace(render()));
  auth = { status: 'blocked', failure: 'forbidden' }; assert.equal(workspace(render()), undefined);
  auth = { status: 'signedOut' }; assert.equal(workspace(render()), undefined);
});

test('saving an open editor keeps its content revision after a remote refresh', async () => {
  const who = owner(), draftId = randomUUID(), policyId = randomUUID();
  const content = { policyId, eventType: null, occurredAt: null, place: 'Original place', description: 'Original note', evidence: [] };
  const original = { draftId, content, confirmed: { draftId, revision: 1, content, updatedAt: '2026-11-12T12:00:00Z' }, command: null, status: 'confirmed', attempted: false, savedAt: 123 };
  hooks = []; auth = { status: 'authenticated', principal: who }; snapshot = { status: 'ready', owner: who, entries: [original] };
  let saved: unknown[] | undefined;
  sync = { save: async (...args: unknown[]) => { saved = args; }, sync: async () => {} };
  const node = workspace(render())!;
  hooks = [];
  const renderWorkspace = () => { cursor = 0; return (node.type as (props: unknown) => Node)(node.props); };
  const find = (value: Node, match: (node: Node) => boolean): Node | undefined => match(value) ? value
    : value.children?.filter((child): child is Node => !!child && typeof child === 'object').map(child => find(child, match)).find(Boolean);
  const editAction = find(renderWorkspace(), value => value.type === 'Action' && value.props.label === 'Abrir')!;
  assert.ok(editAction); (editAction.props.onPress as () => void)();
  snapshot = { status: 'ready', owner: who, entries: [{ ...original, confirmed: { ...original.confirmed, revision: 2 }, content: { ...content, place: 'Remote place' } }] };
  const editor = renderWorkspace(); assert.equal((editor.type as { name: string }).name, 'Editor');
  await (editor.props.onSave as (content: unknown) => Promise<void>)({ ...content, description: 'Local note' });
  assert.equal(saved?.[0], draftId); assert.equal(saved?.[2], 1);
  assert.deepEqual(saved?.[1], { ...content, description: 'Local note' });
  sync = {};
});
