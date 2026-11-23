import { useEffect, useRef, useState } from 'react';
import { useApp } from '../state/store';
import { Button, ErrorText, PrimaryButton } from './ui';

/** Confirmation modal. Shown before every destructive action; optionally collects a required key. */
export function Dialog() {
  const dialog = useApp((s) => s.dialog);
  const close = () => useApp.getState().set({ dialog: null });
  const [value, setValue] = useState('');
  const [err, setErr] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setValue('');
    setErr(false);
    if (!dialog) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input, .btn-primary')?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, [dialog]);

  if (!dialog) return null;
  const confirm = () => {
    if (dialog.field && !value.trim()) return setErr(true);
    close();
    dialog.run(value.trim());
  };

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="dialog blueprint" role="dialog" aria-modal="true" aria-labelledby="dlg-title" ref={ref}>
        <i className="corner tl" /><i className="corner tr" /><i className="corner bl" /><i className="corner br" />
        <div className="dialog-title" id="dlg-title">{dialog.title}</div>
        <div className="dialog-body">{dialog.body}</div>
        {dialog.field && (
          <label className="field">
            <label>{dialog.field}</label>
            <input
              className="input" type="password" autoComplete="off" value={value}
              onChange={(e) => { setValue(e.target.value); setErr(false); }}
              onKeyDown={(e) => { if (e.key === 'Enter') confirm(); }}
            />
          </label>
        )}
        {err && <ErrorText>Enter a key to continue.</ErrorText>}
        <div className="dialog-actions">
          <Button onClick={close}>Cancel</Button>
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
