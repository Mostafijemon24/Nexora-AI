import { useRef, useState } from 'react';
import { Button, Card, Seg } from '../components/ui';
import { relTime } from '../lib/dates';
import type { Integration } from '../lib/types';
import { useApp, useWs } from '../state/store';

const CATS = ['All', 'AI', 'CRM', 'Automation', 'Communication', 'Developer', 'Social'].map((c) => [c, c] as const);
const errText = (e: unknown) => (e instanceof Error ? e.message : 'unknown error');

export function Integrations() {
  const ws = useWs();
  const s = useApp();
  const [cat, setCat] = useState('All');
  const [testing, setTesting] = useState<string | null>(null);

  const fileInput = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const importLeads = async (file: File | undefined) => {
    if (!file) return;
    if (s.needsNet('Importing leads')) return;
    setImporting(true);
    try {
      const r = await s.backend!.leads.importCsv(await file.text());
      s.update(() => ({ leads: r.leads }));
      const skipped = r.skipped ? ` · ${r.skipped} skipped (no name or company)` : '';
      s.commit(`${r.imported} lead${r.imported === 1 ? '' : 's'} imported from CSV${skipped}`);
      void s.refresh(); // an import can start workflows
    } catch (e) {
      s.notify(`Import failed: ${errText(e)}`);
    } finally {
      setImporting(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const mark = (id: string, connected: boolean) =>
    s.update((x) => ({ integrations: x.integrations.map((g) => (g.id === id ? { ...g, connected } : g)) }));

  const test = async (g: Integration) => {
    if (s.needsNet('Connection tests')) return;
    setTesting(g.id);
    try {
      const { latencyMs } = await s.backend!.integrations.test(g.id);
      s.notify(`${g.name} healthy · ${latencyMs} ms`);
    } catch (e) {
      s.notify(`${g.name} test failed: ${errText(e)}`);
    } finally {
      setTesting(null);
    }
  };

  const canConnect = s.backend!.canConnect;
  const connect = (g: Integration) => {
    if (s.needsNet('Connecting')) return;
    s.confirm({
      title: `Connect ${g.name}`,
      body: g.oauth
        ? `You will authorize on ${g.name}’s own sign-in page. Nexora AI never sees your password and requests approved scopes only.`
        : g.hook
          ? 'Connecting creates a private address for this workspace. Any system that posts a message to it adds that message to your inbox. Connecting again replaces the address.'
          : g.fields
            ? 'These details are checked with the service, then encrypted before storage. They are scoped to this workspace and never shown again.'
            : 'Paste a key. It is encrypted before storage and scoped to this workspace.',
      confirm: g.oauth ? 'Authorize' : g.hook ? 'Create address' : 'Test and connect',
      field: g.oauth || g.hook || g.fields ? undefined : 'API key',
      fields: g.fields,
      run: async (key, values) => {
        try {
          const { redirectUrl, details } = await s.backend!.integrations.connect(g.id, g.fields ? values : key || undefined);
          // OAuth: the provider's own page takes over; the server marks it connected on callback.
          if (redirectUrl) return void window.location.assign(redirectUrl);
          mark(g.id, true);
          s.commit(`${g.name} connected`);
          if (details?.length) {
            s.confirm({
              title: `${g.name} connected`, confirm: 'Done', details, run: () => {},
              body: 'Copy these into the other system now. For your security they are shown only once; connect again to get new ones.',
            });
          }
        } catch (e) {
          s.notify(`Could not connect ${g.name}: ${errText(e)}`);
        }
      },
    });
  };

  const disconnect = (g: Integration) => {
    if (s.needsNet('Disconnecting')) return;
    s.confirm({
      title: `Disconnect ${g.name}?`,
      body: `Syncs and workflows using ${g.name} will stop. Stored credentials are deleted.`,
      confirm: 'Disconnect',
      run: async () => {
        try {
          await s.backend!.integrations.disconnect(g.id);
          mark(g.id, false);
          s.commit(`${g.name} disconnected`);
        } catch (e) {
          s.notify(`Could not disconnect ${g.name}: ${errText(e)}`);
        }
      },
    });
  };

  return (
    <div className="stack screen">
      <Card kicker="LinkedIn integration strategy" tour="int-strategy">
        <div className="grid g220" style={{ gap: 16 }}>
          <div><h5>Approved API</h5><div className="hint13">OAuth connection · permitted organization content · available analytics</div></div>
          <div data-tour="int-import">
            <h5>Manual, user-controlled</h5>
            <div className="hint13">CSV lead import · message drafts · connection, publishing and follow-up reminders</div>
            <input ref={fileInput} type="file" accept=".csv,text/csv" hidden onChange={(e) => void importLeads(e.target.files?.[0])} />
            <Button disabled={importing} onClick={() => fileInput.current?.click()} style={{ marginTop: 8 }} title="Header row: name, company, then any of title, industry, size, country, email, phone, linkedin, tags, stage">
              {importing ? 'Importing…' : 'Import leads from CSV'}
            </Button>
          </div>
          <div><h5>Not included</h5><div className="hint13">Credential collection · scraping · automated clicking · private inbox extraction</div></div>
        </div>
      </Card>
      {!canConnect && (
        <Card kicker="Connections need a server">
          <div className="hint13">
            This build runs without a Nexora AI server, so the services below cannot be connected yet. Signing in to LinkedIn or a CRM,
            and storing an API key, both happen on the server. Importing leads from a CSV works now.
          </div>
        </Card>
      )}
      <Seg name="Category" value={cat} options={CATS} onChange={setCat} wrap style={{ alignSelf: 'flex-start' }} />
      <div className="grid g240fill" data-tour="int-list">
        {ws.integrations.filter((g) => cat === 'All' || g.cat === cat).map((g) => (
          <Card key={g.id}>
            <div className="between center">
              <span className="card-kicker">{g.cat}</span>
              <span className={`tag ${g.connected ? 'tag-accent' : 'tag-neutral'}`}>{g.connected ? 'Connected' : 'Not connected'}</span>
            </div>
            <div className="card-title">{g.name}</div>
            <p className="card-body">{g.desc}</p>
            {g.connected && g.sync && <div className="note" style={{ color: g.sync.ok ? undefined : 'var(--color-error, #b3261e)' }}>{g.sync.note} · {relTime(g.sync.at)}</div>}
            <div className="row wrap" style={{ gap: 6 }}>
              {g.connected ? (
                <>
                  <Button disabled={testing === g.id} onClick={() => void test(g)}>{testing === g.id ? 'Testing…' : 'Test connection'}</Button>
                  <Button variant="ghost" onClick={() => disconnect(g)}>Disconnect</Button>
                </>
              ) : (
                <Button disabled={!canConnect} title={canConnect ? undefined : 'Needs a Nexora AI server'} onClick={() => connect(g)}>Connect</Button>
              )}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
