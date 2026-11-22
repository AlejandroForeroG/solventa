import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';

export function CopyValue({ label, value, copyLabel }: { label: string; value: string; copyLabel?: string }) {
  const intl = useIntl();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    clearTimeout(timer.current);
    try { await navigator.clipboard.writeText(value); setState('copied'); } catch { setState('failed'); }
    timer.current = setTimeout(() => setState('idle'), 2400);
  }
  return <div className="copy-value">
    <span className="copy-value-label">{label}</span>
    <span className="copy-value-row"><code className="mono copy-value-text">{value}</code>
      <button type="button" className="btn btn-secondary btn-small" onClick={() => void copy()}>{copyLabel ?? intl.formatMessage({ id: 'form.copy' })}</button></span>
    <span className="note copy-value-status" aria-live="polite">{state === 'idle' ? '' : intl.formatMessage({ id: state === 'copied' ? 'form.copied' : 'form.copyFailed' })}</span>
  </div>;
}
