import { useEffect, useRef, useState } from 'react';
import { serverAddress } from '../api';
import type { BackupInfo } from '../api/backend';
import { Button, Card, ErrorText, Field, PrimaryButton, Seg, Switch, TextField } from '../components/ui';
import { backupTime, shortDate, toIsoDate } from '../lib/dates';
import {
  AI_TASKS, PROVIDER_NAMES, ROLE_CAN, ROLE_LABEL, type ConflictRule, type OpenRouterModel, type Profile, type ProviderName, type Role, type SyncSettings,
} from '../lib/types';
import { bridge } from '../platform/bridge';
import { change, useApp, useWs, type SettingsTab } from '../state/store';
import { MfaSetupPanel, ServerAddress } from './Account';

const TABS: [SettingsTab, string][] = [
  ['profile', 'My profile'], ['ai', 'AI providers'], ['security', 'Security'], ['team', 'Team and workspaces'],
  ['sync', 'Hosting and backups'], ['license', 'License'], ['appearance', 'Appearance'],
];
const errText = (e: unknown) => (e instanceof Error ? e.message : 'unknown error');

function ProfileTab() {
  const ws = useWs();
  const s = useApp();
  const [p, setP] = useState<Profile>(ws.profile);
  const [err, setErr] = useState(false);
  const set = (k: keyof Profile) => (v: string) => { setP({ ...p, [k]: v }); if (k === 'email') setErr(false); };
  const save = () => {
    if (!/^\S+@\S+\.\S+$/.test(p.email)) return setErr(true);
    setErr(false);
    s.update(() => ({ profile: p }));
    s.commit('Profile saved', change('profile', 'profile', p));
  };
  return (
    <>
      <div className="card-kicker">My profile</div>
      <div className="grid g220" style={{ gap: 12 }}>
        <TextField label="Full name" value={p.name} onChange={set('name')} autoComplete="name" />
        <TextField label="Email" type="email" value={p.email} onChange={set('email')} autoComplete="email" aria-invalid={err} />
        <TextField label="Workspace" value={p.workspace} onChange={set('workspace')} disabled={Boolean(ws.me) && ws.me!.role !== 'owner' && ws.me!.role !== 'admin'} title={ws.me && ws.me.role !== 'owner' && ws.me.role !== 'admin' ? 'Only an owner or admin can rename the workspace' : undefined} />
      </div>
      {err && <ErrorText>Enter a valid email address.</ErrorText>}
      <div><PrimaryButton onClick={save}>Save changes</PrimaryButton></div>
    </>
  );
}

const ctx = (m: OpenRouterModel) => m.context;

function AiTab() {
  const ws = useWs();
  const s = useApp();
  const [keys, setKeys] = useState<Partial<Record<ProviderName, string>>>({});
  const [testing, setTesting] = useState<ProviderName | null>(null);
  const [models, setModels] = useState<OpenRouterModel[] | null>(null);
  const [modelErr, setModelErr] = useState('');
  const [filter, setFilter] = useState<'all' | 'free' | 'paid'>('all');
  const verified = (n: ProviderName) => ws.providers.find((p) => p.name === n)?.verified ?? false;
  const orReady = verified('OpenRouter');
  const canConnect = s.backend!.canConnect;
  const off = s.isOffline();

  useEffect(() => {
    if (!orReady || off) return;
    let live = true;
    setModelErr('');
    s.backend!.providers.openRouterModels()
      .then((m) => { if (live) setModels(m); })
      .catch((e) => { if (live) setModelErr(`The model list could not be loaded: ${errText(e)}`); });
    return () => { live = false; };
  }, [orReady, off]); // eslint-disable-line react-hooks/exhaustive-deps

  const setVerified = (name: ProviderName, v: boolean) =>
    s.update((x) => ({ providers: PROVIDER_NAMES.map((n) => ({ name: n, verified: n === name ? v : (x.providers.find((p) => p.name === n)?.verified ?? false) })) }));

  const test = async (name: ProviderName) => {
    const key = (keys[name] ?? '').trim();
    if (!key && !verified(name)) return s.notify(`Enter a key for ${name} first.`);
    if (s.needsNet('Key verification')) return;
    setTesting(name);
    try {
      // An empty key re-checks the one already stored on the server.
      const ok = await s.backend!.providers.verifyKey(name, key);
      setVerified(name, ok);
      if (ok) setKeys((k) => ({ ...k, [name]: '' }));
      s.notify(ok ? `${name} key verified` : `${name} rejected this key.`);
    } catch (e) {
      s.notify(`Could not verify ${name}: ${errText(e)}`);
    } finally {
      setTesting(null);
    }
  };

  const setOr = (patch: Partial<typeof ws.openRouter>, message?: string) => {
    const next = { ...ws.openRouter, ...patch };
    s.update(() => ({ openRouter: next }));
    if (message) s.commit(message, change('openrouter', 'openrouter', next));
    else s.save(change('openrouter', 'openrouter', next));
  };
  const or = ws.openRouter;
  const shown = (models ?? []).filter((m) => filter === 'all' || (filter === 'free') === m.free);
  const usage = ws.aiUsage;

  return (
    <>
      <div className="card-kicker">Task routing</div>
      {AI_TASKS.map((task) => (
        <div key={task} className="row wrap center" style={{ gap: 12, padding: '4px 0' }}>
          <span style={{ flex: 1, minWidth: 160 }}>{task}</span>
          <select
            className="input" aria-label={`Provider for ${task}`} style={{ width: 'auto', minWidth: 200 }} value={ws.routing[task]}
            onChange={(e) => {
              const routing = { ...ws.routing, [task]: e.target.value as ProviderName };
              s.update(() => ({ routing }));
              s.commit(`${task} now uses ${e.target.value}`, change('routing', 'routing', routing));
            }}
          >
            {PROVIDER_NAMES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
      ))}

      <div className="card-kicker mt10">Provider keys · stored encrypted</div>
      {!canConnect && <div className="hint13">This build runs without a Nexora AI server, so keys cannot be stored or verified yet.</div>}
      {PROVIDER_NAMES.map((name) => (
        <div key={name} className="row wrap center" style={{ padding: '4px 0' }}>
          <span style={{ width: 140 }}>{name}</span>
          <input
            className="input" type="password" autoComplete="off" aria-label={`${name} API key`} style={{ flex: 1, minWidth: 160 }} disabled={!canConnect}
            placeholder={verified(name) ? 'Stored · enter a new key to replace' : 'API key'} value={keys[name] ?? ''}
            onChange={(e) => { setKeys({ ...keys, [name]: e.target.value }); if (verified(name)) setVerified(name, false); }}
          />
          <Button disabled={testing === name || !canConnect} onClick={() => void test(name)}>{testing === name ? 'Testing…' : 'Test'}</Button>
          <span className={`tag ${verified(name) ? 'tag-accent' : 'tag-neutral'}`} style={{ minWidth: 86, justifyContent: 'center' }}>{verified(name) ? 'Verified' : 'Not verified'}</span>
        </div>
      ))}
      <div className="note">Usage this month: {Math.round(usage.tokensThisMonth / 1000)}k tokens · est. ${usage.costThisMonthUsd.toFixed(2)}</div>

      <div className="card-kicker mt10">OpenRouter models</div>
      {!orReady && <div className="hint13">{canConnect ? 'Add your OpenRouter key above and press Test to load the model list.' : 'The model list loads once an OpenRouter key is verified.'}</div>}
      {orReady && (
        <>
          <div className="row wrap center" style={{ gap: 10 }}>
            <Seg name="Model price filter" value={filter} options={[['all', 'All'], ['free', 'Free'], ['paid', 'Paid']] as const} onChange={setFilter} />
            <span className="note" style={{ flex: 1, minWidth: 200 }}>
              {s.backend!.demo ? 'Sample data. The real list, pricing and availability load live from OpenRouter and can change, including free models.'
                : 'Loaded live from OpenRouter. Pricing and availability can change, including free models.'}
            </span>
          </div>
          {modelErr && <ErrorText>{modelErr}</ErrorText>}
          {off && !models && <div className="hint13">The model list needs a connection.</div>}
          {!models && !modelErr && !off && <div className="hint13">Loading models…</div>}
          {models && (
            <>
              <div className="scroll-x">
                <table className="table">
                  <thead><tr><th>Model</th><th>Context</th><th>Price / 1M tokens</th><th>Status</th><th><span className="sr-only">Default</span></th></tr></thead>
                  <tbody>
                    {shown.map((m) => (
                      <tr key={m.id}>
                        <td style={{ minWidth: 200 }}><div className="strong">{m.name}</div><div className="note">{m.id}</div></td>
                        <td>{ctx(m)}</td>
                        <td style={{ whiteSpace: 'nowrap' }}><span className={`tag ${m.free ? 'tag-accent' : 'tag-neutral'}`}>{m.free ? 'Free' : (m.price ?? '—')}</span></td>
                        <td>{m.available ? 'Available' : 'Unavailable'}</td>
                        <td>
                          <Button
                            disabled={!m.available || or.defaultModel === m.id} style={{ whiteSpace: 'nowrap' }}
                            onClick={() => setOr({ defaultModel: m.id, fallbackModel: or.fallbackModel === m.id ? '' : or.fallbackModel }, `OpenRouter default: ${m.name}`)}
                          >
                            {or.defaultModel === m.id ? 'Default' : 'Set default'}
                          </Button>
                        </td>
                      </tr>
                    ))}
                    {!shown.length && <tr><td colSpan={5} className="muted">No models match this filter.</td></tr>}
                  </tbody>
                </table>
              </div>
              <div className="grid g220" style={{ gap: 12 }}>
                <label className="field">
                  <label>Fallback model</label>
                  <select className="input" value={or.fallbackModel} onChange={(e) => setOr({ fallbackModel: e.target.value })}>
                    <option value="">None — show the error</option>
                    {models.filter((m) => m.available && m.id !== or.defaultModel).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </label>
                <TextField
                  label="Monthly spend limit (USD)" type="number" min={0} value={or.monthlyBudgetUsd}
                  onChange={(v) => s.update(() => ({ openRouter: { ...or, monthlyBudgetUsd: v } }))}
                  onBlur={() => s.save(change('openrouter', 'openrouter', useApp.getState().ws!.openRouter))}
                />
              </div>
              <div className="note">The fallback is used only when the default fails (rate limit, no credits, model unavailable). You are told each time, and your default is never changed.</div>
            </>
          )}
        </>
      )}
    </>
  );
}

function PasswordForm({ has }: { has: boolean }) {
  const s = useApp();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ current: '', password: '', again: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (v: string) => { setF({ ...f, [k]: v }); setErr(''); };
  const save = async () => {
    if (f.password.length < 10) return setErr('Use a password of at least 10 characters.');
    if (f.password !== f.again) return setErr('The two new passwords are not the same.');
    setBusy(true);
    try {
      await s.backend!.auth.setPassword(f.password, has ? f.current : undefined);
      s.commit(has ? 'Password changed' : 'Password set. Members now sign in to open this workspace.');
      setOpen(false); setF({ current: '', password: '', again: '' });
      await s.refresh();
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  if (!open) {
    return (
      <div className="between center wrap" style={{ gap: 12 }}>
        <div>
          <div className="strong">Password</div>
          <div className="note">{has ? 'You sign in with your email and this password.' : 'Not set: anyone with the license key can open this workspace. Set a password to make every device sign in, and to invite team members.'}</div>
        </div>
        <Button onClick={() => setOpen(true)}>{has ? 'Change password' : 'Set a password'}</Button>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="strong">{has ? 'Change password' : 'Set a password'}</div>
      <div className="grid g220" style={{ gap: 12 }}>
        {has && <TextField label="Current password" type="password" autoComplete="current-password" value={f.current} onChange={set('current')} />}
        <TextField label="New password (at least 10 characters)" type="password" autoComplete="new-password" value={f.password} onChange={set('password')} />
        <TextField label="New password again" type="password" autoComplete="new-password" value={f.again} onChange={set('again')} />
      </div>
      {err && <ErrorText>{err}</ErrorText>}
      <div className="row"><PrimaryButton disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save password'}</PrimaryButton><Button onClick={() => setOpen(false)}>Cancel</Button></div>
      {has && <div className="note">Your other devices will have to sign in again.</div>}
    </div>
  );
}

function SecurityTab() {
  const ws = useWs();
  const s = useApp();
  const me = ws.me;
  const admin = me?.role === 'owner' || me?.role === 'admin';
  const [setting, setSetting] = useState(false);
  const [off, setOff] = useState<{ password: string; code: string } | null>(null);
  const [err, setErr] = useState('');

  const requireMfa = (mfa: boolean) => { s.update(() => ({ mfa })); s.commit(mfa ? 'Two-step sign-in is now required for everyone' : 'Two-step sign-in is no longer required', change('security', 'security', { mfa })); };
  const disable = async () => {
    try {
      await s.backend!.auth.mfaDisable(off!.password, off!.code.trim());
      setOff(null); setErr('');
      s.commit('Two-step sign-in turned off');
      await s.refresh();
    } catch (e) { setErr(errText(e)); }
  };
  const revoke = (id: string, device: string) => {
    if (s.needsNet('Revoking a session')) return;
    s.confirm({
      title: 'Revoke session?', body: `${device} will be signed out.`, confirm: 'Revoke',
      run: async () => {
        try {
          await s.backend!.system.revokeSession(id);
          s.update((x) => ({ sessions: x.sessions.filter((y) => y.id !== id) }));
          s.commit('Session revoked');
        } catch (e) { s.notify(`Could not revoke: ${errText(e)}`); }
      },
    });
  };

  return (
    <>
      <div className="card-kicker">Security</div>
      {!me && <div className="hint13">Accounts, passwords and two-step sign-in live on a Nexora AI server. This build runs without one, so the license key is what opens the app on this device.</div>}
      {me && (
        <>
          <PasswordForm has={me.hasPassword} />
          {me.hasPassword && !me.mfa && !setting && (
            <div className="between center wrap" style={{ gap: 12 }}>
              <div><div className="strong">Two-step sign-in</div><div className="note">Off. Adds a 6-digit code from an authenticator app after your password.</div></div>
              <Button onClick={() => setSetting(true)}>Set up</Button>
            </div>
          )}
          {setting && !me.mfa && <MfaSetupPanel onDone={() => { setSetting(false); void s.refresh(); }} />}
          {setting && me.mfa && <div><Button onClick={() => setSetting(false)}>Done</Button></div>}
          {me.mfa && !setting && (
            <div className="between center wrap" style={{ gap: 12 }}>
              <div><div className="strong">Two-step sign-in</div><div className="note">On. You are asked for a code from your authenticator app when you sign in.</div></div>
              <Button variant="ghost" onClick={() => { setOff({ password: '', code: '' }); setErr(''); }}>Turn off</Button>
            </div>
          )}
          {off && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div className="grid g220" style={{ gap: 12 }}>
                <TextField label="Your password" type="password" autoComplete="current-password" value={off.password} onChange={(v) => setOff({ ...off, password: v })} />
                <TextField label="Authenticator code or recovery code" autoComplete="one-time-code" value={off.code} onChange={(v) => setOff({ ...off, code: v })} />
              </div>
              {err && <ErrorText>{err}</ErrorText>}
              <div className="row"><Button onClick={() => void disable()}>Turn off two-step sign-in</Button><Button variant="ghost" onClick={() => setOff(null)}>Cancel</Button></div>
            </div>
          )}
          {admin && me.hasPassword && (
            <div className="between center" style={{ gap: 12 }}>
              <div>
                <div className="strong">Require two-step sign-in for everyone</div>
                <div className="note">{me.mfa ? 'Members who have not set it up are asked to before they can open this workspace.' : 'Set it up for your own account first; then you can require it.'}</div>
              </div>
              <Switch on={ws.mfa} onChange={() => (me.mfa || ws.mfa ? requireMfa(!ws.mfa) : s.notify('Set up two-step sign-in for your own account first.'))} label="Require two-step sign-in for everyone" />
            </div>
          )}
          {me.hasPassword && <div><Button onClick={() => void s.signOut()}>Sign out on this device</Button></div>}
        </>
      )}
      <div className="card-kicker mt10">Active sessions</div>
      {ws.sessions.map((x) => (
        <div className="line center" key={x.id} style={{ gap: 10 }}>
          <div><div>{x.device}</div><div className="note">{x.meta}</div></div>
          {!x.current && (!me || admin) && <Button variant="ghost" onClick={() => revoke(x.id, x.device)}>Revoke</Button>}
        </div>
      ))}
      {me && <div className="note">A session’s place is the city of the device’s time zone and the network address the server saw, with its last part hidden.</div>}
    </>
  );
}

const INVITE_ROLES: Role[] = ['admin', 'member', 'viewer'];

function TeamTab() {
  const ws = useWs();
  const s = useApp();
  const me = ws.me;
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const features = ws.plan.features ?? [];
  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true); setErr('');
    try { await fn(); s.commit(done); await s.refresh(); } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  const switchTo = async (id: string) => {
    try { await s.backend!.workspaces.switchTo(id); await s.enter(); s.notify('Workspace opened'); } catch (e) { s.notify(`Could not open the workspace: ${errText(e)}`); }
  };

  if (!me) return <><div className="card-kicker">Team</div><div className="hint13">Team members, roles and other workspaces live on a Nexora AI server. This build runs without one.</div></>;
  const admin = me.role === 'owner' || me.role === 'admin';
  const workspaces = ws.workspaces ?? [];
  return (
    <>
      <div className="card-kicker">Team · {ws.profile.workspace}</div>
      <div className="note">Your role: {ROLE_LABEL[me.role]}. {ROLE_CAN[me.role]}</div>
      {!features.includes('team') && <div className="hint13">Inviting team members is part of the Business plan. Your plan is {ws.plan.name}.</div>}
      {admin && ws.team && (
        <>
          {ws.team.members.map((m) => (
            <div className="line center wrap" key={m.id} style={{ gap: 10 }}>
              <div><div>{m.name}{m.id === me.id ? ' (you)' : ''}</div><div className="note">{m.email}{m.mfa ? ' · two-step sign-in on' : ''}</div></div>
              <span className="row center" style={{ gap: 6 }}>
                {m.role === 'owner' || m.id === me.id || (m.role === 'admin' && me.role !== 'owner')
                  ? <span className="tag tag-neutral">{ROLE_LABEL[m.role]}</span>
                  : (
                    <>
                      <select className="input" aria-label={`Role of ${m.name}`} style={{ width: 'auto' }} value={m.role} disabled={busy} onChange={(e) => void act(() => s.backend!.team.setRole(m.id, e.target.value as Role), `${m.name} is now ${ROLE_LABEL[e.target.value as Role].toLowerCase()}`)}>
                        {INVITE_ROLES.filter((r) => r !== 'admin' || me.role === 'owner').map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                      </select>
                      <Button variant="ghost" disabled={busy} onClick={() => s.confirm({
                        title: `Remove ${m.name}?`, body: 'They are signed out of this workspace at once and their devices give their seats back. What they made stays.', confirm: 'Remove',
                        run: () => void act(() => s.backend!.team.remove(m.id), `${m.name} removed from the workspace`),
                      })}>Remove</Button>
                    </>
                  )}
              </span>
            </div>
          ))}
          {ws.team.invitations.map((i) => (
            <div className="line center wrap" key={i.id} style={{ gap: 10 }}>
              <div><div>{i.email}</div><div className="note">Invited as {ROLE_LABEL[i.role].toLowerCase()} · expires {backupTime(i.expiresAt)}</div></div>
              <Button variant="ghost" disabled={busy} onClick={() => void act(() => s.backend!.team.cancelInvitation(i.id), 'Invitation cancelled')}>Cancel invitation</Button>
            </div>
          ))}
          {features.includes('team') && (
            <>
              <div className="card-kicker mt10">Invite someone</div>
              <div className="row wrap" style={{ alignItems: 'flex-end' }}>
                <div style={{ flex: 1, minWidth: 220 }}><TextField label="Email" type="email" value={email} onChange={(v) => { setEmail(v); setErr(''); }} /></div>
                <label className="field">
                  <label>Role</label>
                  <select className="input" aria-label="Role" style={{ width: 'auto' }} value={role} onChange={(e) => setRole(e.target.value as Role)}>
                    {INVITE_ROLES.filter((r) => r !== 'admin' || me.role === 'owner').map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                  </select>
                </label>
                <PrimaryButton disabled={busy || !email.trim()} onClick={() => void act(async () => { await s.backend!.team.invite(email.trim(), role); setEmail(''); }, `Invitation sent to ${email.trim()}`)}>Send invitation</PrimaryButton>
              </div>
              <div className="note">{ROLE_LABEL[role]}: {ROLE_CAN[role]} They get an email with a link to choose a password; they do not need the license key, and take one of the license’s seats.</div>
            </>
          )}
        </>
      )}
      {err && <ErrorText>{err}</ErrorText>}

      <div className="card-kicker mt10">Workspaces</div>
      {workspaces.map((w) => (
        <div className="line center" key={w.id} style={{ gap: 10 }}>
          <div><div>{w.name}</div><div className="note">{ROLE_LABEL[w.role]}</div></div>
          {w.current ? <span className="tag tag-accent">Open</span> : <Button onClick={() => void switchTo(w.id)}>Open</Button>}
        </div>
      ))}
      {me.role === 'owner' && (features.includes('workspaces') ? (
        <div className="row wrap" style={{ alignItems: 'flex-end' }}>
          <div style={{ flex: 1, minWidth: 220 }}><TextField label="New workspace" placeholder="e.g. a client’s name" value={name} onChange={setName} /></div>
          <Button disabled={busy || !name.trim()} onClick={() => void act(async () => { await s.backend!.workspaces.create(name.trim()); setName(''); }, `Workspace “${name.trim()}” created`)}>Add workspace</Button>
        </div>
      ) : <div className="hint13">Having several workspaces is part of the Business plan.</div>)}
      <div className="note">Each workspace has its own leads, posts, conversations, connections and members. They share this license’s seats.</div>
    </>
  );
}

const CONFLICTS: [ConflictRule, string][] = [['ask', 'Keep Nexora AI’s version and tell me'], ['latest', 'Most recent edit wins'], ['cloud', 'Nexora AI’s version wins']];
const kb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

function SyncTab() {
  const ws = useWs();
  const s = useApp();
  const sync = ws.sync;
  const local = !s.backend!.canConnect || s.backend!.demo;
  const admin = !ws.me || ws.me.role === 'owner' || ws.me.role === 'admin';
  const [backing, setBacking] = useState(false);
  const [list, setList] = useState<BackupInfo[] | null>(null);
  const [busy, setBusy] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const put = (patch: Partial<SyncSettings>, message?: string) => {
    const next = { ...useApp.getState().ws!.sync, ...patch };
    s.update(() => ({ sync: next }));
    if (message) s.commit(message, change('sync', 'sync', next));
    else s.save(change('sync', 'sync', next));
  };
  const load = () => { if (admin && !s.isOffline()) s.backend!.system.backups().then(setList).catch(() => setList([])); };
  useEffect(load, []);

  const backup = async () => {
    if (s.needsNet('Backup')) return;
    setBacking(true);
    try {
      if (local) {
        s.notify(`Saved ${await bridge.saveFile(`nexora-backup-${toIsoDate(new Date())}.json`, await s.backend!.system.downloadBackup('now'))}`);
      } else {
        const at = await s.backend!.system.backup();
        s.update((x) => ({ sync: { ...x.sync, lastBackupAt: at } }));
        s.commit('Backup completed');
        load();
      }
    } catch (e) { s.notify(`Backup failed: ${errText(e)}`); } finally { setBacking(false); }
  };
  const download = async (b: BackupInfo) => {
    setBusy(b.id);
    try { s.notify(`Saved ${await bridge.saveFile(`nexora-backup-${b.createdAt.slice(0, 10)}.json`, await s.backend!.system.downloadBackup(b.id))}`); } catch (e) { s.notify(`Download failed: ${errText(e)}`); } finally { setBusy(''); }
  };
  const restore = (source: { id: string } | { file: string }, what: string) => s.confirm({
    title: 'Restore this backup?', confirm: 'Restore',
    body: `Everything in this workspace (leads, campaigns, posts, conversations, workflows, tasks and prompts) is replaced by ${what}. Connections, team members and settings stay. ${local ? 'Save a backup file first if you may want the current state back.' : 'The current state is saved as a backup first, so you can go back.'} Workflows come back switched off.`,
    run: async () => {
      setBusy('restore');
      try { await s.backend!.system.restoreBackup(source); await s.enter(); s.go('settings', { setTab: 'sync' }); s.notify('Workspace restored'); } catch (e) { s.notify(`Restore failed: ${errText(e)}`); } finally { setBusy(''); load(); }
    },
  });
  const fromFile = async (f: File | undefined) => {
    if (!f) return;
    const text = await f.text();
    if (file.current) file.current.value = '';
    restore({ file: text }, `the contents of ${f.name}`);
  };

  return (
    <>
      <div className="card-kicker">Hosting</div>
      <div className="line"><span>Server</span><span className="note" style={{ textAlign: 'right' }}>{serverAddress() || 'None: data is kept on this device'}</span></div>
      {!local && <div className="line"><span>Data region</span><span className="note" style={{ textAlign: 'right' }}>{sync.region}</span></div>}
      <ServerAddress />
      {!local && (
        <>
          <div className="card-kicker mt10">Desktop sync</div>
          <div className="between center" style={{ gap: 12 }}>
            <div><div className="strong">Offline cache</div><div className="note">Leads, drafts and notes stay editable without a connection</div></div>
            <Switch on={sync.offlineCache} onChange={() => put({ offlineCache: !sync.offlineCache }, `Offline cache ${sync.offlineCache ? 'off' : 'on'}`)} label="Offline cache" />
          </div>
          <Field label="When a lead was changed both here and in a connected CRM">
            <div role="radiogroup" aria-label="Conflict rule" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {CONFLICTS.map(([id, label]) => (
                <label className="radio" key={id}>
                  <input type="radio" name="conflict" checked={sync.conflict === id} onChange={() => put({ conflict: id })} />
                  <span className="dot" />{label}
                </label>
              ))}
            </div>
          </Field>
        </>
      )}

      <div className="card-kicker mt10">Backups</div>
      {admin ? (
        <>
          <div className="row wrap center" style={{ gap: 10 }}>
            <Button disabled={backing} onClick={() => void backup()}>{backing ? 'Backing up…' : local ? 'Save a backup file' : 'Back up now'}</Button>
            <input ref={file} type="file" accept=".json,application/json" hidden onChange={(e) => void fromFile(e.target.files?.[0])} />
            <Button disabled={busy === 'restore'} onClick={() => file.current?.click()}>{busy === 'restore' ? 'Restoring…' : 'Restore from a file'}</Button>
            {!local && <span className="note">Last backup: {sync.lastBackupAt ? backupTime(sync.lastBackupAt) : 'never'}</span>}
          </div>
          {!local && (list ?? []).map((b) => (
            <div className="line center wrap" key={b.id} style={{ gap: 10 }}>
              <div><div>{backupTime(b.createdAt)}</div><div className="note">{b.automatic ? 'Automatic' : 'Made by a person'} · {b.leads} lead{b.leads === 1 ? '' : 's'} · {kb(b.sizeBytes)}</div></div>
              <span className="row" style={{ gap: 6 }}>
                <Button disabled={busy === b.id} onClick={() => void download(b)}>{busy === b.id ? 'Preparing…' : 'Download'}</Button>
                <Button variant="ghost" disabled={busy === 'restore'} onClick={() => restore({ id: b.id }, `the backup of ${backupTime(b.createdAt)}`)}>Restore</Button>
              </span>
            </div>
          ))}
          <div className="note">
            {local
              ? 'Without a server the only copy of your workspace is on this device. A backup file holds your leads, campaigns, posts, conversations, workflows, tasks and prompts.'
              : 'The server also makes a backup by itself once a day and keeps the newest fourteen. A backup holds what people made; keys, connections and team members are not in it.'}
          </div>
        </>
      ) : <div className="hint13">Backups are managed by the workspace’s owner and admins.</div>}
    </>
  );
}

function LicenseTab() {
  const s = useApp();
  const lic = s.license!;
  const native = s.platform !== 'web';
  useEffect(() => { void useApp.getState().refreshLicenseEvents(); }, []);
  const deactivate = () => {
    if (s.needsNet('Deactivation')) return;
    s.confirm({
      title: 'Deactivate this device?',
      body: 'The app locks on this device immediately and its seat becomes free for another device.',
      confirm: 'Deactivate', run: () => void s.deactivate(),
    });
  };
  const grace = lic.graceUntil ? ` (until ${shortDate(new Date(lic.graceUntil))})` : '';
  return (
    <>
      <div className="card-kicker">License</div>
      <div className="between wrap" style={{ gap: 8 }}>
        <div>
          <div className="strong">{lic.plan} · {lic.priceLabel}</div>
          <div className="note">{/^Never/.test(lic.renewsOn) ? lic.renewsOn : `Renews ${lic.renewsOn}`} · {lic.activeDevices} of {lic.maxDevices} device{lic.maxDevices === 1 ? '' : 's'} in use · key {lic.keyMasked}</div>
        </div>
        <span className="tag tag-accent" style={{ alignSelf: 'center' }}>Active</span>
      </div>
      <div className="line center" style={{ gap: 10 }}>
        <div><div>{lic.deviceName} · {lic.deviceOs}</div><div className="note">Activated {lic.activatedAt} · Active</div></div>
        <Button variant="ghost" onClick={deactivate}>Deactivate</Button>
      </div>
      <div className="note">
        {native
          ? `Offline access uses a signed entitlement token, valid 7 days after the last server check${grace}. After that the app requires online revalidation.`
          : 'Every request is checked against the license server. All tabs in this browser count as one device.'}
      </div>
      <div className="note">To move the license, deactivate here, then activate on the new device. A transfer from the new device needs email verification.</div>
      <div className="card-kicker mt10">License events</div>
      {s.licEvents.map((e, i) => (
        <div className="line" key={i}><span>{e.text}</span><span className="note" style={{ whiteSpace: 'nowrap' }}>{backupTime(e.at)}</span></div>
      ))}
      {!s.licEvents.length && <div className="hint13">No events recorded yet.</div>}
    </>
  );
}

function AppearanceTab() {
  const s = useApp();
  return (
    <>
      <div className="card-kicker">Appearance</div>
      <Field label="Theme"><Seg name="Theme" value={s.theme} options={[['light', 'Light'], ['dark', 'Dark']] as const} onChange={s.setTheme} /></Field>
      {!s.compact && (
        <Field label="Sidebar">
          <Seg name="Sidebar" value={s.collapsed ? 'c' : 'e'} options={[['e', 'Expanded'], ['c', 'Collapsed']] as const} onChange={(v) => s.setCollapsed(v === 'c')} />
        </Field>
      )}
    </>
  );
}

export function Settings() {
  const tab = useApp((s) => s.setTab);
  return (
    <div className="grid g200 start screen">
      <div role="tablist" aria-label="Settings" aria-orientation="vertical" style={{ display: 'flex', flexDirection: 'column', gap: 2 }} data-tour="set-tabs">
        {TABS.map(([id, label]) => (
          <button type="button" role="tab" key={id} className="pick bare" aria-selected={tab === id} onClick={() => useApp.getState().set({ setTab: id })}>{label}</button>
        ))}
      </div>
      <Card className="span-3" tour="set-panel">
        {tab === 'profile' && <ProfileTab />}
        {tab === 'ai' && <AiTab />}
        {tab === 'security' && <SecurityTab />}
        {tab === 'team' && <TeamTab />}
        {tab === 'sync' && <SyncTab />}
        {tab === 'license' && <LicenseTab />}
        {tab === 'appearance' && <AppearanceTab />}
      </Card>
    </div>
  );
}
