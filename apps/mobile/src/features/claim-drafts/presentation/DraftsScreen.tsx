import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { randomUUID } from 'expo-crypto';
import * as Network from 'expo-network';
import { router, useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { messages } from '../../../shared/i18n/messages';
import { useAppMessages } from '../../../shared/i18n/use-app-messages';
import { useAuthenticatedSession, useAuthentication } from '../../authentication/presentation/AuthenticationProvider';
import { Page, Action, ui } from '../../claim-report/presentation/ui';
import { walletAccessFor, policyReference } from '../../policy-wallet/domain/wallet';
import { useNow } from '../../policy-wallet/presentation/use-now';
import { createDraftApi } from '../adapters/draft-api';
import { openDraftWorkspace } from '../adapters/open-draft-workspace';
import { DraftFailure, emptyDraft, sameOwner, uuid, type DraftContent, type DraftEntry, type DraftFailureKind, type DraftOwner } from '../domain/draft';
import { useDraftSync } from './DraftSyncProvider';
import { draftMessages, type DraftCopy } from './messages';

const REVALIDATING = new Set(['loading', 'locked', 'biometricPrompt', 'authorizing']);

export function DraftsScreen({ policyId }: { policyId?: string }) {
  const auth = useAuthentication();
  const access = walletAccessFor(auth);
  const { snapshot } = useDraftSync();
  const [workspace, setWorkspace] = useState<{ opened: boolean; owner: DraftOwner | null; epoch: number }>(() => ({
    opened: !!access, owner: access?.mode === 'online' ? access.owner : null, epoch: 0,
  }));
  const owner = access?.mode === 'online' ? access.owner : snapshot.status === 'ready' ? snapshot.owner : null;
  if (access && (!workspace.opened || (owner && (!workspace.owner || !sameOwner(owner, workspace.owner))))) {
    setWorkspace({ opened: true, owner: owner ?? workspace.owner,
      epoch: workspace.epoch + (owner && workspace.owner && !sameOwner(owner, workspace.owner) ? 1 : 0) });
  } else if (!access && workspace.opened && !REVALIDATING.has(auth.status)) setWorkspace({ ...workspace, opened: false });
  const locale = useAppMessages() === messages.en ? 'en-US' : 'es-CO';
  const copy = draftMessages[locale];
  if (!access && !workspace.opened) return <Page title={copy.title}><Text style={ui.body}>{copy.signedOut}</Text><Action secondary label={copy.back} onPress={() => router.back()} /></Page>;
  // A system device prompt revalidates Authentication. Retain the editor hidden through it, without cancelling its own opening.
  // A different owner changes the key and drops every unsaved field; permanent denial/sign-out unmounts the workspace.
  return <>
    {!access && <Page title={copy.title}><ActivityIndicator accessibilityLabel={copy.loading} /></Page>}
    <View style={access ? { flex: 1 } : { display: 'none' }}>
      <Workspace key={workspace.epoch} requestedPolicy={uuid(policyId) ? policyId : undefined} copy={copy} locale={locale} />
    </View>
  </>;
}

function Workspace({ requestedPolicy, copy, locale }: { requestedPolicy?: string; copy: DraftCopy; locale: 'es-CO' | 'en-US' }) {
  const auth = useAuthentication();
  const session = useAuthenticatedSession();
  const { sync, snapshot } = useDraftSync();
  const network = Network.useNetworkState();
  const [editing, edit] = useState<{ id: string; content: DraftContent; baseRevision: number } | null>(null);
  const [failure, fail] = useState<DraftFailureKind>();
  const current = useRef({ auth, network });
  useEffect(() => { current.current = { auth, network }; }, [auth, network]);
  const online = auth.status === 'authenticated' && !!auth.principal && network.isConnected !== false && network.isInternetReachable !== false;
  const open = useCallback(async () => {
    edit(null); fail(undefined);
    try {
      const { auth: latestAuth, network: latestNetwork } = current.current;
      const owner = latestAuth.status === 'authenticated' ? latestAuth.principal : undefined;
      await openDraftWorkspace(sync, owner);
      if (owner && latestNetwork.isConnected !== false && latestNetwork.isInternetReachable !== false) {
        await sync.sync(owner); await sync.refresh(owner);
      }
    } catch (error) { fail(error instanceof DraftFailure ? error.kind : 'storage'); }
  }, [sync]);
  useFocusEffect(useCallback(() => { void open(); return () => sync.lock(); }, [open, sync]));
  const act = async (work: () => Promise<void>) => {
    fail(undefined);
    try {
      await work(); edit(null);
      if (online && auth.principal) await sync.sync(auth.principal);
    } catch (error) { fail(error instanceof DraftFailure ? error.kind : 'storage'); }
  };
  if (snapshot.status === 'ready' && auth.status === 'authenticated' && auth.principal && !sameOwner(snapshot.owner, auth.principal)) {
    return <Page title={copy.title}><Action label={copy.unlock} onPress={() => void open()} /></Page>;
  }
  if (snapshot.status !== 'ready') return <Page title={copy.title}>
    {snapshot.status === 'loading' ? <ActivityIndicator accessibilityLabel={copy.loading} /> : <Action label={copy.unlock} onPress={() => void open()} />}
    {(failure ?? snapshot.failure) && <Text accessibilityRole="alert" style={ui.notice}>{copy.failures[(failure ?? snapshot.failure)!]}</Text>}
    <Action secondary label={copy.back} onPress={() => router.back()} />
  </Page>;
  if (editing) return <Editor key={editing.id} content={editing.content} copy={copy} online={online}
    session={session} locale={locale} onSave={content => act(() => sync.save(editing.id, content, editing.baseRevision))} onBack={() => edit(null)} failure={failure} />;
  return <Page title={copy.title}>
    {!online && <Text accessibilityRole="alert" style={ui.notice}>{copy.offline}</Text>}
    <Text style={ui.caption}>{copy.unsent}</Text>
    {(failure ?? snapshot.failure) && <Text accessibilityRole="alert" style={ui.notice}>{copy.failures[(failure ?? snapshot.failure)!]}</Text>}
    {requestedPolicy && <Action label={copy.create} onPress={() => edit({ id: randomUUID(), content: emptyDraft(requestedPolicy), baseRevision: 0 })} />}
    {!snapshot.entries.length && <Text style={ui.body}>{copy.empty}</Text>}
    {snapshot.entries.map(entry => <View key={entry.draftId} style={ui.card}>
      <Text style={ui.subtitle}>{policyReference(entry.content.policyId)}</Text>
      <Text accessibilityLiveRegion="polite" style={ui.label}>{copy.states[entry.status]}</Text>
      <Text style={ui.body}>{entry.content.description || '—'}</Text>
      <Text style={ui.caption}>{copy.savedAt}: {new Date(entry.savedAt).toLocaleString(locale)}</Text>
      {entry.confirmed && <Text style={ui.caption}>{copy.lastSync}: {new Date(entry.confirmed.updatedAt).toLocaleString(locale)}</Text>}
      {entry.failure && <Text accessibilityRole="alert" style={ui.notice}>{copy.failures[entry.failure]}</Text>}
      {online && entry.status === 'confirmed' && !entry.command && <Action label={copy.continueReport}
        onPress={() => router.push({ pathname: '/claim-report', params: { policyId: entry.content.policyId, draftId: entry.draftId } })} />}
      {entry.status === 'conflict' && entry.conflict ? <Conflict entry={entry} copy={copy} locale={locale}
        choose={keep => void act(() => sync.resolve(entry.draftId, keep))} />
        : entry.command && (entry.attempted || entry.command.resolution) && !(entry.status === 'failed' && entry.failure === 'rejected') ? <>
          <Text style={ui.caption}>{copy.immutable}</Text>
          {entry.status !== 'sending' && <Action label={copy.retry} onPress={() => void act(() => sync.retry(entry.draftId))} />}
        </> : <Action secondary label={copy.edit} onPress={() => edit({ id: entry.draftId, content: entry.content, baseRevision: entry.command?.baseRevision ?? entry.confirmed?.revision ?? 0 })} />}
    </View>)}
    <Action secondary label={copy.back} onPress={() => router.back()} />
  </Page>;
}

function Conflict({ entry, copy, locale, choose }: { entry: DraftEntry; copy: DraftCopy; locale: string; choose(keep: 'local' | 'server'): void }) {
  const conflict = entry.conflict!;
  return <View style={ui.section}>
    <Text accessibilityRole="alert" style={ui.notice}>{copy.conflict}</Text>
    {[{ label: copy.local, content: conflict.local }, { label: copy.server, content: conflict.server.content }].map(version => <View key={version.label} style={ui.group}>
      <Text style={ui.subtitle}>{version.label}</Text>
      {conflict.fields.map(field => <View key={field} style={ui.group}>
        <Text style={ui.label}>{copy.fields[field]}</Text>
        <Text selectable style={ui.body}>{field === 'eventType' ? version.content.eventType ? copy.types[version.content.eventType] : '—'
          : field === 'occurredAt' ? version.content.occurredAt ? new Date(version.content.occurredAt).toLocaleString(locale) : '—'
          : field === 'evidence' ? version.content.evidence.map(ref => `${ref.claimId.slice(0, 8)} / ${ref.fileId.slice(0, 8)}`).join('\n') || '—'
          : version.content[field] || '—'}</Text>
      </View>)}
    </View>)}
    <Action label={copy.keepLocal} onPress={() => choose('local')} />
    <Action secondary label={copy.keepServer} onPress={() => choose('server')} />
  </View>;
}

function Editor({ content, copy, online, session, locale, onSave, onBack, failure }: {
  content: DraftContent; copy: DraftCopy; online: boolean; locale: 'es-CO' | 'en-US';
  session: ReturnType<typeof useAuthenticatedSession>; onSave(content: DraftContent): Promise<void>; onBack(): void; failure?: DraftFailureKind;
}) {
  const [draft, setDraft] = useState(content);
  const [busy, setBusy] = useState(false);
  const [evidence, setEvidence] = useState<Awaited<ReturnType<ReturnType<typeof createDraftApi>['evidence']>>>([]);
  const [evidenceFailed, setEvidenceFailed] = useState(false);
  const now = useNow();
  useEffect(() => {
    let active = true;
    if (online) void createDraftApi(session.baseUrl, session).evidence(content.policyId).then(refs => { if (active) setEvidence(refs); }, () => { if (active) setEvidenceFailed(true); });
    return () => { active = false; };
  }, [content.policyId, online, session]);
  const setDate = (mode: 'date' | 'time') => {
    const value = draft.occurredAt ? new Date(draft.occurredAt) : new Date(now);
    DateTimePickerAndroid.open({ value, mode, maximumDate: new Date(now), onChange: (event, picked) => {
      if (event.type !== 'set' || !picked) return;
      const next = new Date(value);
      if (mode === 'date') next.setFullYear(picked.getFullYear(), picked.getMonth(), picked.getDate()); else next.setHours(picked.getHours(), picked.getMinutes(), 0, 0);
      setDraft(d => ({ ...d, occurredAt: next.toISOString() }));
    } });
  };
  return <Page title={copy.title} subtitle={policyReference(draft.policyId)}>
    <Text style={ui.label}>{copy.eventType}</Text>
    <View style={ui.chips}>{(Object.keys(copy.types) as (keyof typeof copy.types)[]).map(type => <Pressable key={type}
      accessibilityRole="button" accessibilityState={{ selected: draft.eventType === type, disabled: busy }} disabled={busy}
      style={[ui.chip, draft.eventType === type && ui.chipSelected]} onPress={() => setDraft(d => ({ ...d, eventType: d.eventType === type ? null : type }))}>
      <Text style={[ui.chipText, draft.eventType === type && ui.chipTextSelected]}>{copy.types[type]}</Text>
    </Pressable>)}</View>
    <Text style={ui.label}>{copy.date}</Text>
    {Platform.OS === 'ios' ? <DateTimePicker disabled={busy} value={draft.occurredAt ? new Date(draft.occurredAt) : new Date(now)} mode="datetime" maximumDate={new Date(now)}
      onChange={(_, date) => { if (date) setDraft(d => ({ ...d, occurredAt: date.toISOString() })); }} /> : <>
      <Action secondary disabled={busy} label={draft.occurredAt ? new Date(draft.occurredAt).toLocaleDateString(locale) : copy.addDate} onPress={() => setDate('date')} />
      {draft.occurredAt && <Action secondary disabled={busy} label={`${copy.time}: ${new Date(draft.occurredAt).toLocaleTimeString(locale, { timeStyle: 'short' })}`} onPress={() => setDate('time')} />}
    </>}
    {draft.occurredAt && <Action secondary disabled={busy} label={copy.clearDate} onPress={() => setDraft(d => ({ ...d, occurredAt: null }))} />}
    <Text style={ui.label}>{copy.place}</Text>
    <TextInput accessibilityLabel={copy.place} value={draft.place} onChangeText={place => setDraft(d => ({ ...d, place }))} editable={!busy} maxLength={120} style={ui.field} />
    <Text style={ui.label}>{copy.description}</Text>
    <TextInput accessibilityLabel={copy.description} value={draft.description} onChangeText={description => setDraft(d => ({ ...d, description }))}
      editable={!busy} multiline maxLength={600} style={[ui.field, ui.multiline]} />
    <Text style={ui.label}>{copy.evidence} ({draft.evidence.length}/10)</Text>
    {(!online || evidenceFailed) && <Text style={ui.caption}>{copy.evidenceOffline}</Text>}
    {online && !evidenceFailed && !evidence.length && <Text style={ui.caption}>{copy.noEvidence}</Text>}
    {[...draft.evidence.filter(ref => !evidence.some(e => e.claimId === ref.claimId && e.fileId === ref.fileId)).map(ref => ({ ...ref, createdAt: '', contentType: '' })), ...evidence].map((ref, i) => {
      const selected = draft.evidence.some(e => e.claimId === ref.claimId && e.fileId === ref.fileId);
      const disabled = busy || (!selected && draft.evidence.length >= 10);
      return <Pressable key={`${ref.claimId}/${ref.fileId}`} accessibilityRole="checkbox" accessibilityState={{ checked: selected, disabled }} disabled={disabled}
        style={[ui.chip, selected && ui.chipSelected]} onPress={() => setDraft(d => ({ ...d, evidence: selected
          ? d.evidence.filter(e => e.claimId !== ref.claimId || e.fileId !== ref.fileId) : d.evidence.length < 10 ? [...d.evidence, { claimId: ref.claimId, fileId: ref.fileId }] : d.evidence }))}>
        <Text style={[ui.chipText, selected && ui.chipTextSelected]}>{copy.evidence} {i + 1} · {ref.fileId.slice(0, 8)}{ref.createdAt ? ` · ${new Date(ref.createdAt).toLocaleDateString(locale)}` : ''}</Text>
      </Pressable>;
    })}
    {failure && <Text accessibilityRole="alert" style={ui.notice}>{copy.failures[failure]}</Text>}
    <Text style={ui.caption}>{copy.unsent}</Text>
    <Action disabled={busy} label={copy.save} onPress={() => { setBusy(true); void onSave(draft).finally(() => setBusy(false)); }} />
    <Action secondary disabled={busy} label={copy.back} onPress={onBack} />
  </Page>;
}
