import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { router } from 'expo-router';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ActivityIndicator, Image, Linking, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { CachedPolicy } from '../../policy-cache/domain/cached-policy';
import { policyReference } from '../../policy-wallet/domain/wallet';
import type { AuthenticatedSession } from '../../policy-wallet/application/ports';
import { useNow } from '../../policy-wallet/presentation/use-now';
import { createClaimReport } from '../adapters/create-claim-report';
import type { CaptureOutcome } from '../application/ports';
import { descriptionLength, EVENT_TYPES, LIMITS, totalBytes, type EvidenceItem, type Issue } from '../domain/report';
import { DocumentReview } from './DocumentReview';
import { issueText, type ClaimReportCopy, type ClaimReportLocale } from './messages';
import { Action, Page, ui } from './ui';

const megabytes = (bytes: number, locale: ClaimReportLocale) => new Intl.NumberFormat(locale, { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(bytes / 1_048_576);
const RETRYABLE = new Set(['unavailable', 'incomplete', 'invalid_response']);

export function ClaimReportForm({ policy, copy, locale, session }: { policy: CachedPolicy; copy: ClaimReportCopy; locale: ClaimReportLocale; session: AuthenticatedSession & { baseUrl: string } }) {
  const [{ flow, source }] = useState(() => createClaimReport(session.baseUrl, session, policy));
  const state = useSyncExternalStore(flow.subscribe, flow.getSnapshot, flow.getSnapshot);
  // The report lives only while this screen does: leaving it, signing out or switching account releases the files the app copied for it.
  useEffect(() => { flow.open(); return () => { void flow.dispose(); }; }, [flow]);
  const [step, setStep] = useState<'capture' | 'review'>('capture');
  const [permission, setPermission] = useState<'ask' | 'settings' | null>(null);
  const [pickerFailed, setPickerFailed] = useState(false);
  const [picking, setPicking] = useState(false);
  const pickerOpen = useRef(false);
  const now = useNow();
  const { draft, issues, rejected, phase, document } = state;
  const busy = phase.kind === 'sending';
  const header = `${copy.products[policy.product]} · ${policyReference(policy.policyId)}`;

  if (phase.kind === 'submitted') return <Result copy={copy} locale={locale} phase={phase} header={header} />;
  const capture = async (open: () => Promise<CaptureOutcome>, isDocument = false) => {
    if (pickerOpen.current) return;
    pickerOpen.current = true;
    setPicking(true);
    setPermission(null); setPickerFailed(false);
    try {
      if (isDocument) await flow.pickDocument(open);
      else {
        flow.clearDocumentNotice();
        const outcome = await open();
        if (outcome.status === 'ok') flow.add(outcome.candidates);
        else if (outcome.status === 'permission') setPermission(outcome.canAskAgain ? 'ask' : 'settings');
        else if (outcome.status === 'failed') setPickerFailed(true);
      }
    } finally {
      pickerOpen.current = false;
      setPicking(false);
    }
  };
  const goBack = () => { if (step === 'review') { flow.backToEditing(); setStep('capture'); } else router.back(); };

  const report = <Page title={step === 'capture' ? copy.title : copy.review.heading} subtitle={`${copy.step(step === 'capture' ? 1 : 2)} · ${header}`}>
    {step === 'capture' ? <>
      <Group label={copy.fields.eventType} issues={issues} field="eventType" copy={copy}>
        <View style={ui.chips}>
          {EVENT_TYPES.map(type => <Pressable key={type} accessibilityRole="button" accessibilityState={{ selected: draft.eventType === type }}
            onPress={() => flow.setEventType(type)} style={[ui.chip, draft.eventType === type && ui.chipSelected]}>
            <Text style={[ui.chipText, draft.eventType === type && ui.chipTextSelected]}>{copy.eventTypes[type]}</Text>
          </Pressable>)}
        </View>
      </Group>

      <Group label={copy.fields.occurredAt} issues={issues} field="occurredAt" copy={copy}>
        <When value={draft.occurredAt} from={new Date(policy.effectiveFrom)} now={now} copy={copy} locale={locale} onChange={date => flow.setOccurredAt(date)} />
      </Group>

      <Group label={copy.fields.place} issues={issues} field="place" copy={copy}>
        <TextInput accessibilityLabel={copy.fields.place} placeholder={copy.fields.placeHint} placeholderTextColor="#8A9A94" value={draft.place} onChangeText={text => flow.setPlace(text)}
          style={[ui.field, issues.some(issue => issue.field === 'place') && ui.invalid]} maxLength={LIMITS.place + 20} editable={!busy} />
      </Group>

      <Group label={copy.fields.description} issues={issues} field="description" copy={copy}>
        <TextInput accessibilityLabel={copy.fields.description} placeholder={copy.fields.descriptionHint} placeholderTextColor="#8A9A94" value={draft.description}
          onChangeText={text => flow.setDescription(text)} multiline style={[ui.field, ui.multiline, issues.some(issue => issue.field === 'description') && ui.invalid]} editable={!busy} />
        <Text style={ui.caption}>{copy.fields.counter(descriptionLength(draft.description), LIMITS.description.max)}
          {descriptionLength(draft.description) < LIMITS.description.min ? ` · ${copy.fields.minimum(LIMITS.description.min)}` : ''}</Text>
      </Group>

      <Group label={copy.evidence.heading} issues={issues} field="evidence" copy={copy}>
        <Text style={ui.caption}>{copy.evidence.counts(draft.evidence.length, LIMITS.files, megabytes(totalBytes(draft.evidence), locale), LIMITS.bytes / 1_048_576)}</Text>
        {draft.evidence.length === 0 && <Text style={ui.body}>{copy.evidence.empty}</Text>}
        {draft.evidence.map((item, index) => <Item key={item.id} item={item} copy={copy} locale={locale} position={index + 1} onRemove={() => flow.remove(item.id)} />)}
        <Action label={copy.evidence.takePhoto} secondary disabled={picking} onPress={() => void capture(source.takePhoto)} />
        <Action label={copy.evidence.recordVideo} secondary disabled={picking} onPress={() => void capture(source.recordVideo)} />
        <Action label={copy.evidence.choose} secondary disabled={picking} onPress={() => void capture(() => source.choose(LIMITS.files - draft.evidence.length))} />
        <Action label={copy.document.scan} secondary disabled={picking} onPress={() => void capture(source.scanDocument, true)} />
        <Action label={copy.document.choose} secondary disabled={picking} onPress={() => void capture(source.chooseDocument, true)} />
        {document.kind === 'permission' && <View style={ui.group}>
          <Text accessibilityRole="alert" style={ui.notice}>{copy.document.cameraDenied}</Text>
          {!document.canAskAgain && <Action label={copy.permission.openSettings} secondary onPress={() => void Linking.openSettings()} />}
        </View>}
        {document.kind === 'failed' && <Text accessibilityRole="alert" style={ui.error}>
          {document.reason === 'file_type' ? copy.document.fileType : document.reason === 'failed' ? copy.document.pickerFailed : copy.rejected[document.reason]}
        </Text>}
        {permission && <View style={ui.group}>
          <Text accessibilityRole="alert" style={ui.notice}>{copy.permission.camera}</Text>
          {permission === 'settings' && <Action label={copy.permission.openSettings} secondary onPress={() => void Linking.openSettings()} />}
        </View>}
        {rejected.map((reason, index) => <Text key={`${reason}-${index}`} accessibilityRole="alert" style={ui.error}>{copy.rejected[reason]}</Text>)}
        {pickerFailed && <Text accessibilityRole="alert" style={ui.error}>{copy.rejected.failed}</Text>}
      </Group>

      <Action label={copy.review.next(draft.evidence.length)} disabled={picking} onPress={() => { if (!pickerOpen.current && flow.review()) setStep('review'); }} />
      <Action label={copy.back} secondary onPress={goBack} />
    </> : <>
      <View style={ui.card}>
        <Summary label={copy.review.policy} value={`${copy.products[policy.product]} · ${policyReference(policy.policyId)}`} />
        <Summary label={copy.fields.eventType} value={draft.eventType ? copy.eventTypes[draft.eventType] : ''} />
        <Summary label={copy.fields.occurredAt} value={draft.occurredAt.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })} />
        {draft.place.trim() !== '' && <Summary label={copy.fields.place} value={draft.place.trim()} />}
        <Text style={ui.label}>{copy.fields.description}</Text>
        <Text style={ui.body}>{draft.description.trim()}</Text>
        <Action label={copy.review.edit} secondary disabled={busy} onPress={goBack} />
      </View>
      <View style={ui.group}>
        <Text style={ui.label}>{copy.evidence.heading}</Text>
        <Text style={ui.caption}>{copy.review.files(draft.evidence.length, megabytes(totalBytes(draft.evidence), locale))}</Text>
        {draft.evidence.map((item, index) => <Item key={item.id} item={item} copy={copy} locale={locale} position={index + 1} />)}
      </View>
      <Text style={ui.caption}>{copy.review.note}</Text>
      {phase.kind === 'sending' && <View accessibilityLiveRegion="polite" style={ui.banner}>
        <ActivityIndicator color="#0B6B5F" accessibilityLabel={copy.sending.preparing} />
        <Text style={ui.body}>{phase.stage === 'uploading' ? copy.sending.uploading(phase.done, phase.total) : copy.sending[phase.stage]}</Text>
      </View>}
      {phase.kind === 'failed' && <Text accessibilityRole="alert" style={ui.notice}>
        {phase.failure === 'incomplete' ? copy.failures.incomplete(phase.missing) : copy.failures[phase.failure]}</Text>}
      {__DEV__ && phase.kind === 'failed' && phase.cause && <Text selectable style={ui.caption}>{`dev: ${phase.cause}`}</Text>}
      <Action label={phase.kind === 'failed' && RETRYABLE.has(phase.failure) ? copy.retry : copy.review.send} disabled={busy} onPress={() => void flow.send()} />
      <Action label={copy.back} secondary disabled={busy} onPress={goBack} />
    </>}
  </Page>;
  const reviewingDocument = document.kind === 'review';
  return <View style={ui.grow}>
    <View style={ui.grow} accessibilityElementsHidden={reviewingDocument} importantForAccessibility={reviewingDocument ? 'no-hide-descendants' : 'auto'}>
      {report}
    </View>
    {reviewingDocument && <View style={StyleSheet.absoluteFill}>
      <DocumentReview key={document.item.id} uri={document.item.uri} copy={copy} onAttach={() => flow.attachDocument()} onCancel={() => flow.discardDocument()} />
    </View>}
  </View>;
}

function Group({ label, field, issues, copy, children }: { label: string; field: Issue['field']; issues: readonly Issue[]; copy: ClaimReportCopy; children: ReactNode }) {
  return <View style={ui.group}>
    <Text style={ui.label}>{label}</Text>
    {children}
    {issues.filter(issue => issue.field === field).map(issue => <Text key={issue.code} accessibilityRole="alert" style={ui.error}>{issueText(copy, issue)}</Text>)}
  </View>;
}

function Summary({ label, value }: { label: string; value: string }) {
  return <View style={ui.summaryRow}><Text style={ui.caption}>{label}</Text><Text style={ui.summaryValue}>{value}</Text></View>;
}

function Item({ item, copy, locale, position, onRemove }: { item: EvidenceItem; copy: ClaimReportCopy; locale: ClaimReportLocale; position: number; onRemove?: () => void }) {
  const kind = item.document ? copy.document.item : item.kind === 'photo' ? copy.evidence.photo : copy.evidence.video;
  return <View style={ui.item}>
    <View style={ui.thumb} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {item.kind === 'photo' ? <Image source={{ uri: item.uri }} style={{ width: 56, height: 56 }} />
        : item.preview?.status === 'ready' ? <Image source={{ uri: item.preview.uri }} style={{ width: 56, height: 56 }} />
        : item.preview?.status === 'failed' ? <Text style={ui.thumbText}>{kind.toUpperCase()}</Text>
        : <ActivityIndicator color="#0B6B5F" />}
    </View>
    <View style={ui.grow}>
      <Text style={ui.body}>{`${kind} ${position}`}</Text>
      <Text style={ui.caption}>{`${megabytes(item.byteSize, locale)} MB`}</Text>
      {item.preview?.status === 'failed' && <Text accessibilityRole="alert" style={ui.caption}>{copy.evidence.noPreview}</Text>}
      {item.preview?.status === 'pending' && <Text accessibilityLiveRegion="polite" style={ui.caption}>{copy.evidence.previewing}</Text>}
    </View>
    {onRemove && <Pressable accessibilityRole="button" accessibilityLabel={copy.evidence.remove(kind.toLowerCase(), position)} onPress={onRemove} style={ui.remove}><Text style={ui.removeText}>×</Text></Pressable>}
  </View>;
}

// The exact moment of the event is chosen on the system pickers and shown in the phone's time zone; it travels to the server in UTC.
function When({ value, from, now, copy, locale, onChange }: { value: Date; from: Date; now: number; copy: ClaimReportCopy; locale: ClaimReportLocale; onChange: (date: Date) => void }) {
  const merge = (mode: 'date' | 'time', picked: Date) => {
    const next = new Date(value);
    if (mode === 'date') next.setFullYear(picked.getFullYear(), picked.getMonth(), picked.getDate()); else next.setHours(picked.getHours(), picked.getMinutes(), 0, 0);
    onChange(next);
  };
  const open = (mode: 'date' | 'time') => DateTimePickerAndroid.open({ value, mode, maximumDate: new Date(now), ...(mode === 'date' ? { minimumDate: from } : {}),
    onChange: (event, picked) => { if (event.type === 'set' && picked) merge(mode, picked); } });
  if (Platform.OS === 'ios') {
    return <DateTimePicker value={value} mode="datetime" minimumDate={from} maximumDate={new Date(now)} onChange={(_, picked) => { if (picked) onChange(picked); }} />;
  }
  return <View style={ui.row}>
    <Pressable accessibilityRole="button" accessibilityLabel={copy.fields.date} onPress={() => open('date')} style={[ui.picker, ui.grow]}>
      <Text style={ui.pickerText}>{value.toLocaleDateString(locale, { dateStyle: 'medium' })}</Text></Pressable>
    <Pressable accessibilityRole="button" accessibilityLabel={copy.fields.time} onPress={() => open('time')} style={[ui.picker, ui.grow]}>
      <Text style={ui.pickerText}>{value.toLocaleTimeString(locale, { timeStyle: 'short' })}</Text></Pressable>
  </View>;
}

function Result({ copy, locale, phase, header }: { copy: ClaimReportCopy; locale: ClaimReportLocale; phase: { claimNumber: string; submittedAt: string; files: number; bytes: number }; header: string }) {
  return <Page title={copy.done.heading} subtitle={header}>
    <View style={ui.banner} accessibilityLiveRegion="polite">
      <Text style={ui.bannerLabel}>{copy.done.caseNumber.toUpperCase()}</Text>
      <Text accessibilityRole="header" style={ui.caseNumber}>{phase.claimNumber}</Text>
    </View>
    <View style={ui.card}>
      <Summary label={copy.done.filedAt} value={new Date(phase.submittedAt).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })} />
      <Summary label={copy.done.evidence} value={copy.review.files(phase.files, megabytes(phase.bytes, locale))} />
    </View>
    <Text style={ui.caption}>{copy.done.once}</Text>
    <Action label={copy.done.home} onPress={() => router.replace('/')} />
  </Page>;
}
