import { useEffect, useRef, useState } from 'react';
import { useApp } from '../state/store';
import { Button, ErrorText, PrimaryButton } from './ui';

/**
 * Modal dialog. Shown before every destructive action; it can also collect one required key,
 * collect several named fields, or show values to copy.
 */
export function Dialog() {
  const dialog = useApp((s) => s.dialog);
  const close = () => useApp.getState().set({ dialog: null });
  const [value, setValue] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setValue('');
    setValues({});
    setErr('');
    setCopied('');
    if (!dialog) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input, .btn-primary')?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, [dialog]);

  if (!dialog) return null;
  const confirm = () => {
    if (dialog.field && !value.trim()) return setErr('Enter a key to continue.');
    const missing = dialog.fields?.find((f) => !f.optional && !(values[f.key] ?? '').trim());
    if (missing) return setErr(`Enter: ${missing.label}.`);
    close();
    dialog.run(value.trim(), Object.fromEntries((dialog.fields ?? []).map((f) => [f.key, (values[f.key] ?? '').trim()])));
  };
  const copy = async (label: string, text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(label); } catch { setCopied(''); }
  };

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !dialog.details) close(); }}>
      <div className="dialog blueprint" role="dialog" aria-modal="true" aria-labelledby="dlg-title" ref={ref} style={dialog.fields || dialog.details ? { maxHeight: '90vh', overflowY: 'auto' } : undefined}>
        <i className="corner tl" /><i className="corner tr" /><i className="corner bl" /><i className="corner br" />
        <div className="dialog-title" id="dlg-title">{dialog.title}</div>
        <div className="dialog-body">{dialog.body}</div>
        {dialog.field && (
          <label className="field">
            <label>{dialog.field}</label>
            <input
              className="input" type="password" autoComplete="off" value={value}
              onChange={(e) => { setValue(e.target.value); setErr(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter') confirm(); }}
            />
          </label>
        )}
        {dialog.fields?.map((f) => (
          <label className="field" key={f.key}>
            <label>{f.label}</label>
            <input
              className="input" type={f.secret ? 'password' : 'text'} autoComplete="off" placeholder={f.placeholder} value={values[f.key] ?? ''}
              onChange={(e) => { setValues({ ...values, [f.key]: e.target.value }); setErr(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter') confirm(); }}
            />
          </label>
        ))}
        {dialog.details?.map((d) => (
          <div className="field" key={d.label}>
            <label>{d.label}</label>
            <div className="row" style={{ alignItems: 'stretch' }}>
              <input className="input" readOnly aria-label={d.label} value={d.value} onFocus={(e) => e.target.select()} />
              <Button onClick={() => void copy(d.label, d.value)}>{copied === d.label ? 'Copied' : 'Copy'}</Button>
            </div>
          </div>
        ))}
        {err && <ErrorText>{err}</ErrorText>}
        <div className="dialog-actions">
          {!dialog.details && <Button onClick={close}>Cancel</Button>}
          <PrimaryButton onClick={confirm}>{dialog.confirm}</PrimaryButton>
        </div>
      </div>
    </div>
  );
}

export function Toast() {
  const toast = useApp((s) => s.toast);
  return <div aria-live="polite">{toast && <div className="toast">{toast}</div>}</div>;
}
