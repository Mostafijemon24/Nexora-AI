import { useState } from 'react';
import { BackendError } from '../api';
import type { TransferResult } from '../api/backend';
import { Button, Card, ErrorText, PrimaryButton, Seg } from '../components/ui';
import type { ActivationFailure, SeatDevice } from '../lib/types';
import { useApp } from '../state/store';
import { InviteForm, ServerAddress, SignInForm } from './Account';

interface Msg { title: string; body: string; canTransfer?: boolean; devices?: SeatDevice[] }

function failureMessage(f: ActivationFailure): Msg {
  switch (f.code) {
    case 'expired':
      return { title: 'License expired', body: `This license expired${f.expiredOn ? ` on ${f.expiredOn}` : ''}. Renew it from your account, then activate again.` };
    case 'revoked':
      return { title: 'License revoked', body: 'This license was revoked and cannot be activated. Contact support if you think this is a mistake.' };
    case 'in_use': {
      if (f.devices?.length) {
        return { title: 'Every seat of this license is in use', body: `This license runs on ${f.devices.length} devices at a time. To use it here, one of them gives up its seat.`, canTransfer: true, devices: f.devices };
      }
      const where = f.deviceName
        ? `This license is registered to ${f.deviceName}${f.deviceOs || f.activatedAt ? ` (${[f.deviceOs, f.activatedAt && `activated ${f.activatedAt}`].filter(Boolean).join(', ')})` : ''}.`
        : 'This license is registered to another device.';
      return { title: 'Already active on another device', body: `${where} One license runs on one device at a time.`, canTransfer: true };
    }
    case 'not_included':
      return { title: 'The desktop app is not part of this plan', body: `The ${f.plan ?? 'current'} plan runs in the browser. The desktop app comes with the Professional plan and above.` };
    case 'unavailable':
      return { title: 'License server unavailable', body: 'We could not reach the license server. Check your connection and try again. Nothing was changed.' };
    case 'invalid':
      return { title: 'Invalid license key', body: 'No license matches this key. Check for typos or copy it again from your purchase email.' };
  }
}

const MODES = [['key', 'License key'], ['signin', 'Sign in'], ['invite', 'I have an invitation']] as const;
type Mode = (typeof MODES)[number][0];
/** An invitation link opens the app with the code in its address. */
const invitationInAddress = (): string => { try { return new URLSearchParams(window.location.search).get('invite') ?? ''; } catch { return ''; } };

/** Shown before anything else when this device holds no active license. */
export function LicenseGate() {
  const device = useApp((s) => s.device)!;
  const backend = useApp((s) => s.backend)!;
  const onLicensed = useApp((s) => s.onLicensed);
  const invited = invitationInAddress();
  const [mode, setMode] = useState<Mode>(invited && backend.canConnect && !backend.demo ? 'invite' : 'key');
  const [key, setKey] = useState('');
  const [msg, setMsg] = useState<Msg | null>(null);
  const [busy, setBusy] = useState(false);
  const [transfer, setTransfer] = useState(false);
  const [replace, setReplace] = useState('');
  const [code, setCode] = useState('');
  const [codeErr, setCodeErr] = useState('');
  /** Accounts exist only on a server. */
  const accounts = backend.canConnect && !backend.demo;

  const activate = async () => {
    const k = key.trim().toUpperCase();
    if (!k) return setMsg({ title: 'Enter a license key', body: 'The key is in your purchase email.' });
    setBusy(true); setMsg(null); setTransfer(false);
    let r;
    try {
      r = await backend.license.activate(k, device);
    } catch (e) {
      setBusy(false);
      return setMsg(e instanceof BackendError && e.status === 429 ? { title: 'Too many attempts', body: e.message } : failureMessage({ code: 'unavailable' }));
    }
    setBusy(false);
    if (r.ok) return onLicensed(r.license, r.entitlementToken, r.signInRequired);
    const m = failureMessage(r);
    setMsg(m);
    setReplace(m.devices?.[0]?.id ?? '');
    void useApp.getState().refreshLicenseEvents();
  };

  const startTransfer = async () => {
    setTransfer(true); setCode(''); setCodeErr('');
    try {
      await backend.license.requestTransfer(key.trim().toUpperCase(), device);
    } catch {
      setCodeErr('The code could not be sent. Check your connection and try again.');
    }
  };

  const confirmTransfer = async () => {
    if (!/^\d{6}$/.test(code.trim())) return setCodeErr('Enter the 6-digit code.');
    setBusy(true);
    const r: TransferResult = await backend.license
      .confirmTransfer(key.trim().toUpperCase(), code.trim(), device, replace || undefined)
      .catch(() => ({ ok: false as const, code: 'unavailable' as const }));
    setBusy(false);
    if (r.ok) return onLicensed(r.license, r.entitlementToken, r.signInRequired);
    if (r.code === 'bad_code') return setCodeErr('That code is not correct or has expired.');
    setTransfer(false);
    setMsg(failureMessage(r));
  };
  const joined = (r: { license: Parameters<typeof onLicensed>[0]; entitlementToken: string }) => {
    // The invitation code has done its job: take it out of the address.
    if (invited) window.history.replaceState(null, '', window.location.pathname);
    void onLicensed(r.license, r.entitlementToken);
  };
  const replacing = msg?.devices?.find((d) => d.id === replace);

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'grid', placeItems: 'center', padding: 24 }}>
      <Card kicker={`${device.name} · ${device.os}`} className="screen" style={{ width: '100%', maxWidth: 540 }}>
        <h2 style={{ margin: 0 }}>{mode === 'key' ? 'Activate Nexora AI' : mode === 'signin' ? 'Sign in to Nexora AI' : 'Join a workspace'}</h2>
        {accounts && <Seg name="How to get in" value={mode} options={MODES} onChange={(m) => { setMode(m); setMsg(null); setTransfer(false); }} wrap style={{ alignSelf: 'flex-start' }} />}

        {mode === 'signin' && (
          <>
            <p className="card-body">Sign in with your account. This device takes a free seat of your workspace’s license; you do not need the license key.</p>
            <SignInForm onDone={joined} />
          </>
        )}
        {mode === 'invite' && (
          <>
            <p className="card-body">Paste the code from your invitation email, then choose a password. You do not need a license key.</p>
            <InviteForm initialToken={invited} onDone={joined} />
          </>
        )}
        {mode === 'key' && (
          <>
            <p className="card-body">A valid license is required before any feature is available. One license runs on a set number of devices at a time.</p>
            <label className="field">
              <label>License key</label>
              <input
                className="input" placeholder="NXR-XXXXX-0000" autoComplete="off" spellCheck={false} autoFocus value={key}
                onChange={(e) => { setKey(e.target.value); setMsg(null); setTransfer(false); }}
                onKeyDown={(e) => { if (e.key === 'Enter' && !busy) void activate(); }}
              />
            </label>
            {msg && !transfer && (
              <div role="alert" style={{ border: '1px solid var(--color-divider)', background: 'var(--tint)', padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <strong>{msg.title}</strong>
                <span style={{ fontSize: 13 }}>{msg.body}</span>
                {msg.devices && (
                  <label className="field">
                    <label>Device that gives up its seat</label>
                    <select className="input" aria-label="Device that gives up its seat" value={replace} onChange={(e) => setReplace(e.target.value)}>
                      {msg.devices.map((d) => <option key={d.id} value={d.id}>{d.name} · {d.os} · activated {d.activatedAt}</option>)}
                    </select>
                  </label>
                )}
                {msg.canTransfer && <div><Button onClick={() => void startTransfer()}>{msg.devices ? 'Move that seat to this device' : 'Transfer license to this device'}</Button></div>}
              </div>
            )}
            {transfer && (
              <div style={{ border: '1px solid var(--color-divider)', padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <strong>Verify the transfer</strong>
                <span style={{ fontSize: 13 }}>
                  A 6-digit code was sent to the license owner’s email. After verification {replacing ? replacing.name : 'the other device'} is deactivated and this one is registered.
                </span>
                <div className="row">
                  <input
                    className="input" placeholder="6-digit code" inputMode="numeric" maxLength={6} aria-label="6-digit code" value={code}
                    onChange={(e) => { setCode(e.target.value); setCodeErr(''); }}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !busy) void confirmTransfer(); }}
                  />
                  <Button disabled={busy} onClick={() => void confirmTransfer()} style={{ whiteSpace: 'nowrap' }}>Confirm transfer</Button>
                </div>
                {codeErr && <ErrorText>{codeErr}</ErrorText>}
              </div>
            )}
            <PrimaryButton disabled={busy} onClick={() => void activate()}>
              {busy && !transfer ? 'Validating with license server…' : 'Activate license'}
            </PrimaryButton>
            <div className="note">Keys are validated by the license server, never in this app.</div>
          </>
        )}
        <ServerAddress />
      </Card>
    </div>
  );
}
