import qrcode from 'qrcode-generator';
import { useEffect, useState } from 'react';
import { BackendError, builtInServer, chooseServer, chosenServer, serverAddress } from '../api';
import type { InvitationInfo } from '../api/backend';
import { Button, Card, ErrorText, PrimaryButton, TextField } from '../components/ui';
import { ROLE_LABEL, type MfaSetup, type SignInResult } from '../lib/types';
import { bridge } from '../platform/bridge';
import { useApp } from '../state/store';

const errText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');
const box: React.CSSProperties = { border: '1px solid var(--color-divider)', background: 'var(--tint)', padding: 10, display: 'flex', flexDirection: 'column', gap: 8 };

/** What to tell someone whose sign-in or invitation did not go through. */
function failure(r: Exclude<SignInResult, { ok: true }>): string {
  switch (r.code) {
    case 'bad_credentials': return 'That email and password do not match an account.';
    case 'bad_code': return 'That code is not correct. Wait for the next code and try again, or use a recovery code.';
    case 'mfa_required': return 'Enter the 6-digit code from your authenticator app.';
    case 'no_workspace': return 'This account is not in any workspace with an active license. Ask the workspace owner.';
    case 'in_use': return `Every seat of this license is in use${r.devices?.length ? ` (${r.devices.map((d) => d.name).join(', ')})` : ''}. Ask the owner to free one in Settings → License, or to add seats.`;
    case 'not_included': return `The ${r.plan ?? 'current'} plan does not include the desktop app. Use the web app, or ask the owner to upgrade.`;
    case 'expired': return `The workspace’s license expired${r.expiredOn ? ` on ${r.expiredOn}` : ''}. Ask its owner to renew it.`;
    case 'revoked': return 'The workspace’s license was revoked. Ask its owner.';
    default: return 'The server could not be reached. Check your connection and try again.';
  }
}

/** Email and password, the second step when the account has one, and the way back in after a forgotten password. */
export function SignInForm({ onDone }: { onDone: (r: Extract<SignInResult, { ok: true }>) => void }) {
  const s = useApp();
  const [f, setF] = useState({ email: '', password: '', code: '' });
  const [needCode, setNeedCode] = useState(false);
  const [mode, setMode] = useState<'sign_in' | 'forgot' | 'reset'>('sign_in');
  const [reset, setReset] = useState({ code: '', password: '' });
  const [err, setErr] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (v: string) => { setF({ ...f, [k]: v }); setErr(''); };
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setErr('');
    try { await fn(); } catch (e) { setErr(e instanceof BackendError && e.status === 429 ? 'Too many attempts. Wait a few minutes and try again.' : errText(e)); } finally { setBusy(false); }
  };

  const signIn = () => run(async () => {
    if (!f.email.trim() || !f.password) return setErr('Enter your email and password.');
    const r = await s.backend!.auth.signIn({ email: f.email.trim(), password: f.password, code: needCode ? f.code.trim() : undefined }, s.device!);
    if (r.ok) return onDone(r);
    if (r.code === 'mfa_required') { setNeedCode(true); return setInfo('Enter the 6-digit code from your authenticator app, or one of your recovery codes.'); }
    setErr(failure(r));
  });
  const sendCode = () => run(async () => {
    if (!/^\S+@\S+\.\S+$/.test(f.email.trim())) return setErr('Enter your email address.');
    await s.backend!.auth.forgotPassword(f.email.trim());
    setMode('reset');
    setInfo('If that address has an account, a 6-digit code is on its way. It expires in 15 minutes.');
  });
  const doReset = () => run(async () => {
    await s.backend!.auth.resetPassword(f.email.trim(), reset.code.trim(), reset.password);
    setMode('sign_in'); setF({ ...f, password: '' }); setReset({ code: '', password: '' });
    setInfo('Your password was changed. Sign in with the new one.');
  });
  const enter = (fn: () => void) => (e: React.KeyboardEvent) => { if (e.key === 'Enter' && !busy) fn(); };

  if (mode !== 'sign_in') {
    return (
      <>
        <TextField label="Email" type="email" autoComplete="username" value={f.email} onChange={set('email')} disabled={mode === 'reset'} />
        {mode === 'reset' && (
          <>
            <TextField label="6-digit code from the email" inputMode="numeric" maxLength={6} autoComplete="one-time-code" value={reset.code} onChange={(v) => { setReset({ ...reset, code: v }); setErr(''); }} />
            <TextField label="New password (at least 10 characters)" type="password" autoComplete="new-password" value={reset.password} onChange={(v) => { setReset({ ...reset, password: v }); setErr(''); }} onKeyDown={enter(() => void doReset())} />
          </>
        )}
        {info && <div className="note" role="status">{info}</div>}
        {err && <ErrorText>{err}</ErrorText>}
        <div className="row wrap">
          {mode === 'forgot'
            ? <PrimaryButton disabled={busy} onClick={() => void sendCode()}>{busy ? 'Sending…' : 'Email me a reset code'}</PrimaryButton>
            : <PrimaryButton disabled={busy} onClick={() => void doReset()}>{busy ? 'Saving…' : 'Set new password'}</PrimaryButton>}
          <Button onClick={() => { setMode('sign_in'); setErr(''); setInfo(''); }}>Back to sign in</Button>
        </div>
      </>
    );
  }
  return (
    <>
      <TextField label="Email" type="email" autoComplete="username" value={f.email} onChange={set('email')} autoFocus />
      <TextField label="Password" type="password" autoComplete="current-password" value={f.password} onChange={set('password')} onKeyDown={enter(() => void signIn())} />
      {needCode && <TextField label="Authenticator code or recovery code" autoComplete="one-time-code" value={f.code} onChange={set('code')} onKeyDown={enter(() => void signIn())} autoFocus />}
      {info && <div className="note" role="status">{info}</div>}
      {err && <ErrorText>{err}</ErrorText>}
      <div className="row wrap">
        <PrimaryButton disabled={busy} onClick={() => void signIn()}>{busy ? 'Signing in…' : 'Sign in'}</PrimaryButton>
        <Button variant="ghost" onClick={() => { setMode('forgot'); setErr(''); setInfo(''); }}>Forgot password?</Button>
      </div>
    </>
  );
}

/** Joining a workspace from an emailed invitation: choose a name and a password, and this device is signed in. */
export function InviteForm({ initialToken = '', onDone }: { initialToken?: string; onDone: (r: Extract<SignInResult, { ok: true }>) => void }) {
  const s = useApp();
  const [token, setToken] = useState(initialToken);
  const [inv, setInv] = useState<InvitationInfo | null>(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const look = async (t = token) => {
    if (!t.trim()) return setErr('Paste the invitation code from the email.');
    setBusy(true); setErr('');
    try { setInv(await s.backend!.auth.invitationInfo(t.trim())); } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  useEffect(() => { if (initialToken) void look(initialToken); }, []);
  const join = async () => {
    setBusy(true); setErr('');
    try {
      const r = await s.backend!.auth.acceptInvitation({ token: token.trim(), name: name.trim(), password }, s.device!);
      if (r.ok) return onDone(r);
      setErr(r.code === 'bad_credentials' ? 'That is not the password of your existing account.' : failure(r));
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };

  if (!inv) {
    return (
      <>
        <TextField label="Invitation code" value={token} onChange={(v) => { setToken(v); setErr(''); }} autoComplete="off" spellCheck={false} onKeyDown={(e) => { if (e.key === 'Enter' && !busy) void look(); }} autoFocus />
        {err && <ErrorText>{err}</ErrorText>}
        <div><PrimaryButton disabled={busy} onClick={() => void look()}>{busy ? 'Checking…' : 'Continue'}</PrimaryButton></div>
      </>
    );
  }
  return (
    <>
      <div style={box}>
        <strong>Join {inv.workspace}</strong>
        <span style={{ fontSize: 13 }}>You were invited as {inv.email}, with the role {ROLE_LABEL[inv.role]}.</span>
      </div>
      {!inv.hasAccount && <TextField label="Your name" autoComplete="name" value={name} onChange={setName} autoFocus />}
      <TextField
        label={inv.hasAccount ? 'Your Nexora AI password' : 'Choose a password (at least 10 characters)'} type="password" autoComplete={inv.hasAccount ? 'current-password' : 'new-password'}
        value={password} onChange={(v) => { setPassword(v); setErr(''); }} onKeyDown={(e) => { if (e.key === 'Enter' && !busy) void join(); }}
      />
      {err && <ErrorText>{err}</ErrorText>}
      <div><PrimaryButton disabled={busy} onClick={() => void join()}>{busy ? 'Joining…' : `Join ${inv.workspace}`}</PrimaryButton></div>
    </>
  );
}

function Qr({ text }: { text: string }) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const cells: string[] = [];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) cells.push(`M${x} ${y}h1v1h-1z`);
  return (
    <svg viewBox={`-2 -2 ${n + 4} ${n + 4}`} width={176} height={176} role="img" aria-label="QR code for your authenticator app" style={{ background: '#fff', flexShrink: 0 }}>
      <path d={cells.join('')} fill="#000" />
    </svg>
  );
}

/** Setting up two-step sign-in: scan the code, confirm with a code from the app, then keep the recovery codes. */
export function MfaSetupPanel({ onDone }: { onDone: () => void }) {
  const s = useApp();
  const [setup, setSetup] = useState<MfaSetup | null>(null);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true); setErr('');
    try { setSetup(await s.backend!.auth.mfaSetup()); } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  const confirm = async () => {
    setBusy(true); setErr('');
    try { setRecovery((await s.backend!.auth.mfaEnable(code.trim())).recoveryCodes); } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  const save = async () => {
    try { s.notify(`Saved ${await bridge.saveFile('nexora-recovery-codes.txt', `Nexora AI recovery codes\nEach code works once.\n\n${recovery!.join('\n')}\n`)}`); } catch (e) { s.notify(`Could not save: ${errText(e)}`); }
  };

  if (recovery) {
    return (
      <>
        <div style={box}>
          <strong>Two-step sign-in is on. Keep these recovery codes.</strong>
          <span style={{ fontSize: 13 }}>Each one signs you in once if your phone is not at hand. They are shown only now.</span>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 6, fontFamily: 'monospace' }}>{recovery.map((c) => <span key={c}>{c}</span>)}</div>
        </div>
        <div className="row wrap"><Button onClick={() => void save()}>Save as a file</Button><PrimaryButton onClick={onDone}>I have kept them</PrimaryButton></div>
      </>
    );
  }
  if (!setup) {
    return (
      <>
        <div className="hint13">Two-step sign-in asks for a 6-digit code from an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password and others) after your password.</div>
        {err && <ErrorText>{err}</ErrorText>}
        <div><PrimaryButton disabled={busy} onClick={() => void start()}>{busy ? 'Starting…' : 'Set up two-step sign-in'}</PrimaryButton></div>
      </>
    );
  }
  return (
    <>
      <div className="row wrap" style={{ gap: 16, alignItems: 'flex-start' }}>
        <Qr text={setup.uri} />
        <div style={{ flex: 1, minWidth: 220, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="hint13">1. Scan this code with your authenticator app, or enter the key by hand:</div>
          <code style={{ wordBreak: 'break-all', fontSize: 13 }}>{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
          <TextField label="2. Enter the 6-digit code the app shows" inputMode="numeric" maxLength={6} autoComplete="one-time-code" value={code} onChange={(v) => { setCode(v); setErr(''); }} onKeyDown={(e) => { if (e.key === 'Enter' && !busy) void confirm(); }} />
        </div>
      </div>
      {err && <ErrorText>{err}</ErrorText>}
      <div><PrimaryButton disabled={busy || code.trim().length < 6} onClick={() => void confirm()}>{busy ? 'Checking…' : 'Turn on two-step sign-in'}</PrimaryButton></div>
    </>
  );
}

/** Choosing the server this app talks to: the one it was built for, or a self-hosted one. */
export function ServerAddress() {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState(chosenServer());
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const current = serverAddress();
  const apply = async (value: string) => {
    setBusy(true); setErr('');
    try { await chooseServer(value); window.location.reload(); } catch (e) { setErr(errText(e)); setBusy(false); }
  };
  if (!open) {
    return (
      <div className="note">
        Server: {current || 'none — this app keeps its data on this device'}. <button type="button" className="btn btn-ghost" style={{ padding: '0 4px', fontSize: 12 }} onClick={() => setOpen(true)}>Use a different server</button>
      </div>
    );
  }
  return (
    <div style={box}>
      <strong>Server address</strong>
      <span style={{ fontSize: 13 }}>Enter the address of a Nexora AI server, for example one you host yourself. The app reloads and uses it from then on; nothing is moved between servers.</span>
      <input className="input" type="url" aria-label="Server address" placeholder="https://api.yourcompany.com" value={url} onChange={(e) => { setUrl(e.target.value); setErr(''); }} onKeyDown={(e) => { if (e.key === 'Enter' && !busy) void apply(url); }} />
      {err && <ErrorText>{err}</ErrorText>}
      <div className="row wrap">
        <Button disabled={busy || !url.trim()} onClick={() => void apply(url)}>{busy ? 'Checking…' : 'Check and use this server'}</Button>
        {chosenServer() && <Button variant="ghost" disabled={busy} onClick={() => void apply('')}>{builtInServer() ? 'Go back to the built-in server' : 'Run without a server'}</Button>}
        <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </div>
  );
}

/** Shown when this device has its seat but the workspace is closed: nobody is signed in, or two-step sign-in must be set up. */
export function AccountGate() {
  const s = useApp();
  const what = s.account ?? 'sign_in';
  const giveUp = () => s.confirm({
    title: 'Deactivate this device?', body: 'This device gives its seat back. The app returns to the first screen.', confirm: 'Deactivate', run: () => void s.deactivate(),
  });
  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'grid', placeItems: 'center', padding: 24 }}>
      <Card kicker={`${s.device?.name ?? ''} · ${s.license?.plan ?? ''}`} className="screen" style={{ width: '100%', maxWidth: 540 }}>
        {what === 'sign_in' ? (
          <>
            <h2 style={{ margin: 0 }}>Sign in</h2>
            <p className="card-body">This device is licensed. Sign in with your own account to open the workspace.</p>
            <SignInForm onDone={(r) => void s.onLicensed(r.license, r.entitlementToken)} />
          </>
        ) : (
          <>
            <h2 style={{ margin: 0 }}>Set up two-step sign-in</h2>
            <p className="card-body">This workspace requires a second step at sign-in. Set it up once to continue.</p>
            <MfaSetupPanel onDone={() => void s.enter()} />
          </>
        )}
        <div className="note">
          <button type="button" className="btn btn-ghost" style={{ padding: '0 4px', fontSize: 12 }} onClick={giveUp}>Deactivate this device</button>
        </div>
      </Card>
    </div>
  );
}
