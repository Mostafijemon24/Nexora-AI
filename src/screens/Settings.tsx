import { useEffect, useState } from 'react';
import { Button, Card, ErrorText, Field, PrimaryButton, Seg, Switch, TextField } from '../components/ui';
import { backupTime, shortDate } from '../lib/dates';
import { AI_TASKS, PROVIDER_NAMES, type ConflictRule, type OpenRouterModel, type Profile, type ProviderName, type SyncSettings } from '../lib/types';
import { change, useApp, useWs, type SettingsTab } from '../state/store';

const TABS: [SettingsTab, string][] = [
  ['profile', 'My profile'], ['ai', 'AI providers'], ['security', 'Security'],
  ['sync', 'Sync and hosting'], ['license', 'License'], ['appearance', 'Appearance'],
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
        <TextField label="Workspace" value={p.workspace} onChange={set('workspace')} />
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
      {PROVIDER_NAMES.map((name) => (
        <div key={name} className="row wrap center" style={{ padding: '4px 0' }}>
          <span style={{ width: 140 }}>{name}</span>
          <input
            className="input" type="password" autoComplete="off" aria-label={`${name} API key`} style={{ flex: 1, minWidth: 160 }}
            placeholder={verified(name) ? 'Stored · enter a new key to replace' : 'API key'} value={keys[name] ?? ''}
            onChange={(e) => { setKeys({ ...keys, [name]: e.target.value }); if (verified(name)) setVerified(name, false); }}
          />
          <Button disabled={testing === name} onClick={() => void test(name)}>{testing === name ? 'Testing…' : 'Test'}</Button>
          <span className={`tag ${verified(name) ? 'tag-accent' : 'tag-neutral'}`} style={{ minWidth: 86, justifyContent: 'center' }}>{verified(name) ? 'Verified' : 'Not verified'}</span>
        </div>
      ))}
      <div className="note">Usage this month: {Math.round(usage.tokensThisMonth / 1000)}k tokens · est. ${usage.costThisMonthUsd.toFixed(2)}</div>

      <div className="card-kicker mt10">OpenRouter models</div>
      {!orReady && <div className="hint13">Add your OpenRouter key above and press Test to load the model list.</div>}
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

function SecurityTab() {
  const ws = useWs();
  const s = useApp();
  const setMfa = (mfa: boolean) => { s.update(() => ({ mfa })); s.commit(`MFA turned ${mfa ? 'on' : 'off'}`, change('security', 'security', { mfa })); };
  const toggle = () => {
    if (!ws.mfa) return setMfa(true);
    s.confirm({ title: 'Turn off MFA?', body: 'Your account will be protected by password only.', confirm: 'Turn off', run: () => setMfa(false) });
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
      <div className="between center" style={{ gap: 12 }}>
        <div><div className="strong">Multi-factor authentication</div><div className="note">Authenticator app code at sign-in</div></div>
        <Switch on={ws.mfa} onChange={toggle} label="Multi-factor authentication" />
      </div>
      <div className="card-kicker mt10">Active sessions</div>
      {ws.sessions.map((x) => (
        <div className="line center" key={x.id} style={{ gap: 10 }}>
          <div><div>{x.device}</div><div className="note">{x.meta}</div></div>
          {!x.current && <Button variant="ghost" onClick={() => revoke(x.id, x.device)}>Revoke</Button>}
        </div>
      ))}
    </>
  );
}

const CONFLICTS: [ConflictRule, string][] = [['ask', 'Ask me each time'], ['latest', 'Most recent edit wins'], ['cloud', 'Cloud version wins']];
const REGIONS = ['Singapore', 'Frankfurt', 'Virginia'];

function SyncTab() {
  const ws = useWs();
  const s = useApp();
  const sync = ws.sync;
  const [endpoint, setEndpoint] = useState(sync.endpoint);
  const [endpointErr, setEndpointErr] = useState(false);
  const [backing, setBacking] = useState(false);
  const put = (patch: Partial<SyncSettings>, message?: string) => {
    const next = { ...useApp.getState().ws!.sync, ...patch };
    s.update(() => ({ sync: next }));
    if (message) s.commit(message, change('sync', 'sync', next));
    else s.save(change('sync', 'sync', next));
  };
  const saveEndpoint = () => {
    const v = endpoint.trim();
    if (v === sync.endpoint) return;
    if (v && !/^https:\/\/[^\s/]+\.[^\s]+$/.test(v)) return setEndpointErr(true);
    put({ endpoint: v }, v ? 'Self-hosted endpoint saved' : 'Self-hosted endpoint removed');
  };
  const backup = async () => {
    if (s.needsNet('Backup')) return;
    setBacking(true);
    try {
      const at = await s.backend!.system.backup();
      s.update((x) => ({ sync: { ...x.sync, lastBackupAt: at } }));
      s.commit('Backup completed');
    } catch (e) { s.notify(`Backup failed: ${errText(e)}`); } finally { setBacking(false); }
  };
  return (
    <>
      <div className="card-kicker">Hosting · Hybrid</div>
      <div className="grid g220" style={{ gap: 12 }}>
        <label className="field">
          <label>Cloud region</label>
          <select className="input" value={sync.region} onChange={(e) => put({ region: e.target.value }, `Cloud region set to ${e.target.value}`)}>
            {(REGIONS.includes(sync.region) ? REGIONS : [sync.region, ...REGIONS]).map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
        <TextField
          label="Self-hosted endpoint (optional)" type="url" placeholder="https://nexora.yourcompany.com" value={endpoint} aria-invalid={endpointErr}
          onChange={(v) => { setEndpoint(v); setEndpointErr(false); }} onBlur={saveEndpoint} onKeyDown={(e) => { if (e.key === 'Enter') saveEndpoint(); }}
        />
      </div>
      {endpointErr && <ErrorText>Enter a full https:// address, or leave it empty.</ErrorText>}
      <div className="card-kicker mt10">Desktop sync · Hybrid</div>
      <div className="between center" style={{ gap: 12 }}>
        <div><div className="strong">Offline cache</div><div className="note">Leads, drafts and notes stay editable without a connection</div></div>
        <Switch on={sync.offlineCache} onChange={() => put({ offlineCache: !sync.offlineCache }, `Offline cache ${sync.offlineCache ? 'off' : 'on'}`)} label="Offline cache" />
      </div>
      <Field label="When offline and cloud edits conflict">
        <div role="radiogroup" aria-label="Conflict rule" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {CONFLICTS.map(([id, label]) => (
            <label className="radio" key={id}>
              <input type="radio" name="conflict" checked={sync.conflict === id} onChange={() => put({ conflict: id })} />
              <span className="dot" />{label}
            </label>
          ))}
        </div>
      </Field>
      <div className="row wrap center" style={{ gap: 10 }}>
        <Button disabled={backing} onClick={() => void backup()}>{backing ? 'Backing up…' : 'Back up now'}</Button>
        <span className="note">Last backup: {sync.lastBackupAt ? backupTime(sync.lastBackupAt) : 'never'}</span>
      </div>
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
      body: 'The app locks on this device immediately. The license can then be activated on one other device.',
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
          <div className="note">Renews {lic.renewsOn} · {lic.activeDevices} of {lic.maxDevices} device active · key {lic.keyMasked}</div>
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
      {s.platform !== 'android' && (
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
        {tab === 'sync' && <SyncTab />}
        {tab === 'license' && <LicenseTab />}
        {tab === 'appearance' && <AppearanceTab />}
      </Card>
    </div>
  );
}
