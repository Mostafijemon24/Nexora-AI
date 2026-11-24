import { ArrowLeft, ArrowRight, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, ErrorText, PrimaryButton, Seg, TextField } from '../components/ui';
import { buildReport, leadsCsv } from '../lib/analytics';
import { cleanTags } from '../lib/csv';
import { addDays, relTime, toIsoDate } from '../lib/dates';
import { rankLeads, type RankedLead } from '../lib/scoring';
import {
  CAMPAIGN_STATUSES, LEAD_STAGES, newLead, STAGE_LABEL, type Campaign, type CampaignStatus, type Conversation, type Lead, type LeadStage,
} from '../lib/types';
import { bridge } from '../platform/bridge';
import { change, newId, remove, useApp, useWs } from '../state/store';

const TABS = [['list', 'All leads'], ['pipeline', 'Pipeline'], ['campaigns', 'Campaigns']] as const;
export type LeadsTab = (typeof TABS)[number][0];

const stageTag = (s: LeadStage) => `tag ${s === 'converted' ? 'tag-accent' : s === 'lost' ? 'tag-neutral' : 'tag-outline'}`;
const errText = (e: unknown) => (e instanceof Error ? e.message : 'unknown error');

/** Writes a lead locally and sends it; `message` adds an activity entry and a toast. */
function useLeadWriter() {
  const s = useApp();
  return {
    put(next: Lead, message?: string) {
      s.update((x) => ({ leads: x.leads.some((l) => l.id === next.id) ? x.leads.map((l) => (l.id === next.id ? next : l)) : [...x.leads, next] }));
      if (message) s.commit(message, change('lead', next.id, next)); else s.save(change('lead', next.id, next));
    },
    putMany(next: Lead[], message: string) {
      const byId = new Map(next.map((l) => [l.id, l]));
      s.update((x) => ({ leads: x.leads.map((l) => byId.get(l.id) ?? l) }));
      s.commit(message, ...next.map((l) => change('lead', l.id, l)));
    },
    removeMany(ids: string[], message: string) {
      const gone = new Set(ids);
      s.update((x) => ({ leads: x.leads.filter((l) => !gone.has(l.id)) }));
      s.commit(message, ...ids.map((id) => remove('lead', id)));
    },
  };
}

function AddLead({ onDone }: { onDone: (id: string | null) => void }) {
  const w = useLeadWriter();
  const [f, setF] = useState({ name: '', company: '', title: '', email: '' });
  const [err, setErr] = useState('');
  const set = (k: keyof typeof f) => (v: string) => { setF({ ...f, [k]: v }); setErr(''); };
  const add = () => {
    if (!f.name.trim() || !f.company.trim()) return setErr('Name and company are both required.');
    if (f.email.trim() && !/^\S+@\S+\.\S+$/.test(f.email.trim())) return setErr('Enter a valid email address, or leave it empty.');
    const lead = newLead(newId(), f.name.trim(), f.company.trim(), new Date().toISOString(), { title: f.title.trim() || null, email: f.email.trim() || null });
    w.put(lead, `Lead added: ${lead.name}`);
    onDone(lead.id);
  };
  return (
    <Card kicker="New lead">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
        <TextField label="Name" value={f.name} onChange={set('name')} autoFocus />
        <TextField label="Company" value={f.company} onChange={set('company')} />
        <TextField label="Job title (optional)" value={f.title} onChange={set('title')} />
        <TextField label="Email (optional)" type="email" value={f.email} onChange={set('email')} />
      </div>
      {err && <ErrorText>{err}</ErrorText>}
      <div className="row"><PrimaryButton onClick={add}>Add lead</PrimaryButton><Button onClick={() => onDone(null)}>Cancel</Button></div>
    </Card>
  );
}

function LeadDetail({ lead, onClose }: { lead: RankedLead; onClose: () => void }) {
  const ws = useWs();
  const s = useApp();
  const w = useLeadWriter();
  const [tag, setTag] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const now = new Date();
  const current = () => useApp.getState().ws!.leads.find((l) => l.id === lead.id);

  /** Text edits are saved once typing pauses. */
  const edit = (patch: Partial<Lead>) => {
    const next = { ...current()!, ...patch };
    s.update((x) => ({ leads: x.leads.map((l) => (l.id === next.id ? next : l)) }));
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { const l = current(); if (l && l.name.trim() && l.company.trim()) useApp.getState().save(change('lead', l.id, l)); }, 600);
  };
  const text = (k: 'title' | 'industry' | 'country' | 'email' | 'phone' | 'linkedin') => (v: string) => edit({ [k]: v.trim() ? v : null });
  const now_ = () => { clearTimeout(timer.current); return current()!; };

  const addTag = () => {
    const tags = cleanTags([...lead.tags, ...tag.split(',')]);
    setTag('');
    if (tags.length !== lead.tags.length) w.put({ ...now_(), tags });
  };
  const addNote = () => {
    const t = note.trim();
    if (!t) return;
    setNote('');
    w.put({ ...now_(), notes: [...lead.notes, { text: t, at: new Date().toISOString() }] }, `Note added to ${lead.name}`);
  };
  const conversation = ws.conversations.find((c) => c.leadId === lead.id);
  const openConversation = () => {
    if (conversation) return s.go('inbox', { inboxId: conversation.id });
    const channel = lead.email ? 'Email' : lead.phone ? 'WhatsApp' : 'Manual import';
    const c: Conversation = {
      id: newId(), name: lead.name, company: lead.company, channel, leadId: lead.id, address: channel === 'Email' ? lead.email : channel === 'WhatsApp' ? lead.phone : null,
      unread: false, important: false, intent: 'Outreach', sentiment: '', suggestion: '', msgs: [], notes: [],
    };
    s.update((x) => ({ conversations: [...x.conversations, c] }));
    s.commit(`Conversation started with ${lead.name}`, change('conversation', c.id, c));
    s.go('inbox', { inboxId: c.id });
  };
  const draft = async () => {
    if (s.needsNet() || busy) return;
    setBusy(true);
    try {
      const { text: body, notice } = await s.backend!.ai.draftMessage(lead.id);
      if (notice) s.notify(notice);
      s.set({ chat: [...useApp.getState().chat, { me: true, text: `Draft a first message for ${lead.name}` }, { me: false, text: `Draft (needs your approval):\n\n${body}` }] });
      s.go('ai', { aiTab: 'chat' });
    } catch (e) { s.notify(`Could not draft: ${errText(e)}`); } finally { setBusy(false); }
  };
  const makeTask = () => {
    const task = { id: newId(), text: `Follow up with ${lead.name}`, due: '', dueDate: addDays(toIsoDate(new Date()), 1), leadId: lead.id, done: false };
    s.update((x) => ({ tasks: [task, ...x.tasks] }));
    s.commit(`Follow-up task created for ${lead.name}`, change('task', task.id, task));
  };
  const del = () => s.confirm({
    title: 'Delete lead?', body: `${lead.name} and their notes will be removed. Conversations with them are kept.`, confirm: 'Delete',
    run: () => { w.removeMany([lead.id], `Lead deleted: ${lead.name}`); onClose(); },
  });

  return (
    <Card tour="leads-detail">
      <div className="between center" style={{ gap: 8 }}>
        <div className="card-kicker">Lead</div>
        <Button icon title="Close" aria-label="Close lead" onClick={onClose}><X size={14} strokeWidth={1.5} /></Button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
        <TextField label="Name" value={lead.name} onChange={(v) => edit({ name: v })} />
        <TextField label="Company" value={lead.company} onChange={(v) => edit({ company: v })} />
        <TextField label="Job title" value={lead.title ?? ''} onChange={text('title')} />
        <TextField label="Industry" value={lead.industry ?? ''} onChange={text('industry')} />
        <TextField label="Company size" type="number" min={1} value={lead.size === null ? '' : String(lead.size)} onChange={(v) => edit({ size: /^\d+$/.test(v) && +v > 0 ? +v : null })} />
        <TextField label="Country" value={lead.country ?? ''} onChange={text('country')} />
        <TextField label="Email" type="email" value={lead.email ?? ''} onChange={text('email')} />
        <TextField label="Phone (with country code)" value={lead.phone ?? ''} onChange={text('phone')} />
        <TextField label="LinkedIn profile address" value={lead.linkedin ?? ''} onChange={text('linkedin')} placeholder="https://www.linkedin.com/in/…" />
        <label className="field">
          <label>Stage</label>
          <select className="input" aria-label="Stage" value={lead.stage} onChange={(e) => w.put({ ...now_(), stage: e.target.value as LeadStage }, `${lead.name} moved to ${STAGE_LABEL[e.target.value as LeadStage]}`)}>
            {LEAD_STAGES.map((st) => <option key={st} value={st}>{STAGE_LABEL[st]}</option>)}
          </select>
        </label>
        <label className="field">
          <label>Campaign</label>
          <select className="input" aria-label="Campaign" value={lead.campaignId ?? ''} onChange={(e) => w.put({ ...now_(), campaignId: e.target.value || null })}>
            <option value="">None</option>
            {ws.campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
      </div>
      {(!lead.name.trim() || !lead.company.trim()) && <ErrorText>Name and company are required; changes are saved once both are filled in.</ErrorText>}

      <div>
        <div className="card-kicker" style={{ marginBottom: 6 }}>Tags</div>
        <div className="row wrap center" style={{ gap: 6 }}>
          {lead.tags.map((t) => (
            <button type="button" key={t} className="tag tag-outline" title={`Remove the tag ${t}`} onClick={() => w.put({ ...now_(), tags: lead.tags.filter((x) => x !== t) })}>{t} ×</button>
          ))}
          <input
            className="input" style={{ width: 160 }} placeholder="Add a tag" aria-label="Add a tag" value={tag}
            onChange={(e) => setTag(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addTag(); }} onBlur={() => { if (tag.trim()) addTag(); }}
          />
        </div>
      </div>

      <div className="between center wrap" style={{ gap: 8 }}>
        <span>Match score <strong>{lead.score.total}</strong> / 100 · <span className="note">{lead.score.label}, confidence {lead.score.conf}/10</span></span>
        <Button variant="ghost" onClick={() => s.go('ai', { aiTab: 'scoring' })}>Score breakdown</Button>
      </div>
      <div className="row wrap" style={{ gap: 6 }}>
        <Button onClick={openConversation}>{conversation ? 'Open conversation' : 'Start conversation'}</Button>
        <Button disabled={busy} onClick={() => void draft()}>{busy ? 'Drafting…' : 'Draft message'}</Button>
        <Button onClick={makeTask}>Create follow-up</Button>
        <Button variant="ghost" onClick={del}>Delete</Button>
      </div>
      {lead.linkedin && /^https:\/\//.test(lead.linkedin) && (
        <div className="note">
          Profile: <a href={lead.linkedin} target="_blank" rel="noreferrer noopener" onClick={(e) => { e.preventDefault(); void bridge.openExternal(lead.linkedin!); }}>{lead.linkedin}</a>.
          Opening it is up to you; Nexora AI never visits LinkedIn on your behalf.
        </div>
      )}

      <div className="section-top" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div className="card-kicker">Notes</div>
        {lead.notes.map((n, i) => (
          <div key={i} style={{ fontSize: 13, padding: '4px 8px', background: 'var(--tint)' }}>{n.text}<div className="note">{relTime(n.at, now)}</div></div>
        ))}
        {!lead.notes.length && <div className="hint13">No notes yet.</div>}
        <div className="row">
          <input className="input" placeholder="Add a note" aria-label="Lead note" value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addNote(); }} />
          <Button onClick={addNote}>Add</Button>
        </div>
        <div className="note">Added {relTime(lead.createdAt, now)}</div>
      </div>
    </Card>
  );
}

function List({ ranked, campaignFilter, setCampaignFilter }: { ranked: RankedLead[]; campaignFilter: string; setCampaignFilter: (id: string) => void }) {
  const ws = useWs();
  const s = useApp();
  const w = useLeadWriter();
  const [search, setSearch] = useState('');
  const [stage, setStage] = useState<LeadStage | ''>('');
  const [tag, setTag] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [bulkTag, setBulkTag] = useState('');
  const file = useRef<HTMLInputElement>(null);

  const allTags = useMemo(() => [...new Set(ws.leads.flatMap((l) => l.tags))].sort((a, b) => a.localeCompare(b)), [ws.leads]);
  const q = search.trim().toLowerCase();
  const rows = ranked.filter((l) =>
    (!stage || l.stage === stage) && (!tag || l.tags.includes(tag)) && (!campaignFilter || l.campaignId === campaignFilter)
    && (!q || [l.name, l.company, l.title, l.email, l.industry, l.country].some((v) => v?.toLowerCase().includes(q))));
  const open = ranked.find((l) => l.id === openId);
  const chosen = rows.filter((l) => picked.has(l.id));
  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allPicked = rows.length > 0 && chosen.length === rows.length;
  const plural = (n: number) => `${n} lead${n === 1 ? '' : 's'}`;
  const raw = (l: RankedLead): Lead => { const { score: _score, ...lead } = l; return lead; };

  const importCsv = async (f: File | undefined) => {
    if (!f || s.needsNet('Importing leads')) return;
    setImporting(true);
    try {
      const r = await s.backend!.leads.importCsv(await f.text());
      s.update(() => ({ leads: r.leads }));
      const skipped = r.skipped ? ` · ${r.skipped} skipped (no name or company)` : '';
      s.commit(`${r.imported} lead${r.imported === 1 ? '' : 's'} imported from CSV${skipped}`);
      void s.refresh();
    } catch (e) { s.notify(`Import failed: ${errText(e)}`); } finally {
      setImporting(false);
      if (file.current) file.current.value = '';
    }
  };
  const exportCsv = async () => {
    try {
      const where = await bridge.saveFile(`nexora-leads-${toIsoDate(new Date())}.csv`, leadsCsv(rows.map(raw), ws.icp, ws.campaigns));
      s.notify(`${plural(rows.length)} exported to ${where}`);
    } catch (e) { s.notify(`Export failed: ${errText(e)}`); }
  };
  const bulkStage = (to: LeadStage) => { w.putMany(chosen.filter((l) => l.stage !== to).map((l) => ({ ...raw(l), stage: to })), `${plural(chosen.length)} moved to ${STAGE_LABEL[to]}`); setPicked(new Set()); };
  const bulkAddTag = () => {
    const t = bulkTag.trim();
    if (!t) return;
    w.putMany(chosen.map((l) => ({ ...raw(l), tags: cleanTags([...l.tags, t]) })), `Tag “${t}” added to ${plural(chosen.length)}`);
    setBulkTag(''); setPicked(new Set());
  };
  const bulkCampaign = (id: string) => { w.putMany(chosen.map((l) => ({ ...raw(l), campaignId: id || null })), id ? `${plural(chosen.length)} added to the campaign` : `${plural(chosen.length)} removed from their campaign`); setPicked(new Set()); };
  const bulkDelete = () => s.confirm({
    title: `Delete ${plural(chosen.length)}?`, body: 'The selected leads and their notes will be removed. This cannot be undone.', confirm: 'Delete',
    run: () => { w.removeMany(chosen.map((l) => l.id), `${plural(chosen.length)} deleted`); setPicked(new Set()); setOpenId(null); },
  });

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row wrap center" style={{ gap: 8 }} data-tour="leads-tools">
        <input className="input" type="search" placeholder="Search leads" aria-label="Search leads" value={search} onChange={(e) => setSearch(e.target.value)} style={{ flex: 1, minWidth: 180 }} />
        <select className="input" aria-label="Filter by stage" style={{ width: 'auto' }} value={stage} onChange={(e) => setStage(e.target.value as LeadStage | '')}>
          <option value="">All stages</option>
          {LEAD_STAGES.map((st) => <option key={st} value={st}>{STAGE_LABEL[st]}</option>)}
        </select>
        {allTags.length > 0 && (
          <select className="input" aria-label="Filter by tag" style={{ width: 'auto' }} value={tag} onChange={(e) => setTag(e.target.value)}>
            <option value="">All tags</option>
            {allTags.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        )}
        {ws.campaigns.length > 0 && (
          <select className="input" aria-label="Filter by campaign" style={{ width: 'auto' }} value={campaignFilter} onChange={(e) => setCampaignFilter(e.target.value)}>
            <option value="">All campaigns</option>
            {ws.campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
        <PrimaryButton onClick={() => setAdding(true)}>+ Add lead</PrimaryButton>
        <input ref={file} type="file" accept=".csv,text/csv" hidden onChange={(e) => void importCsv(e.target.files?.[0])} />
        <Button disabled={importing} onClick={() => file.current?.click()} title="Header row: name, company, then any of title, industry, size, country, email, phone, linkedin, tags, stage">{importing ? 'Importing…' : 'Import CSV'}</Button>
        <Button disabled={!rows.length} onClick={() => void exportCsv()}>Export CSV</Button>
      </div>

      {adding && <AddLead onDone={(id) => { setAdding(false); if (id) setOpenId(id); }} />}

      {chosen.length > 0 && (
        <Card kicker={`${plural(chosen.length)} selected`}>
          <div className="row wrap center" style={{ gap: 8 }}>
            <select className="input" aria-label="Move selected leads to a stage" style={{ width: 'auto' }} value="" onChange={(e) => { if (e.target.value) bulkStage(e.target.value as LeadStage); }}>
              <option value="">Move to stage…</option>
              {LEAD_STAGES.map((st) => <option key={st} value={st}>{STAGE_LABEL[st]}</option>)}
            </select>
            {ws.campaigns.length > 0 && (
              <select className="input" aria-label="Add selected leads to a campaign" style={{ width: 'auto' }} value="-" onChange={(e) => { if (e.target.value !== '-') bulkCampaign(e.target.value); }}>
                <option value="-">Set campaign…</option>
                <option value="">No campaign</option>
                {ws.campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            )}
            <input className="input" style={{ width: 150 }} placeholder="Tag to add" aria-label="Tag to add to selected leads" value={bulkTag} onChange={(e) => setBulkTag(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') bulkAddTag(); }} />
            <Button disabled={!bulkTag.trim()} onClick={bulkAddTag}>Add tag</Button>
            <Button variant="ghost" onClick={bulkDelete}>Delete</Button>
            <Button variant="ghost" onClick={() => setPicked(new Set())}>Clear selection</Button>
          </div>
        </Card>
      )}

      <div className="grid g300 start">
        <Card className={open ? 'span-2' : 'span-3'} style={{ minWidth: 0, overflowX: 'auto' }} tour="leads-table">
          {!ws.leads.length && <div className="muted">No leads yet. Add one, or import a CSV with name and company columns.</div>}
          {ws.leads.length > 0 && !rows.length && <div className="muted">No leads match these filters.</div>}
          {rows.length > 0 && (
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 28 }}><input type="checkbox" aria-label="Select all shown leads" checked={allPicked} onChange={() => setPicked(allPicked ? new Set() : new Set(rows.map((l) => l.id)))} /></th>
                  <th>Lead</th><th>Stage</th><th>Score</th><th>Tags</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((l) => (
                  <tr key={l.id} aria-selected={l.id === openId} style={{ background: l.id === openId ? 'var(--tint)' : undefined }}>
                    <td><input type="checkbox" aria-label={`Select ${l.name}`} checked={picked.has(l.id)} onChange={() => toggle(l.id)} /></td>
                    <td>
                      <button type="button" className="pick bare" style={{ padding: 0, textAlign: 'left', width: '100%' }} onClick={() => setOpenId(l.id === openId ? null : l.id)}>
                        <div className="strong">{l.name}</div>
                        <div className="note">{[l.title, l.company].filter(Boolean).join(' · ')}</div>
                      </button>
                    </td>
                    <td><span className={stageTag(l.stage)}>{STAGE_LABEL[l.stage]}</span></td>
                    <td><strong>{l.score.total}</strong></td>
                    <td><span className="note">{l.tags.join(', ')}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        {open && <LeadDetail key={open.id} lead={open} onClose={() => setOpenId(null)} />}
      </div>
    </div>
  );
}

function Pipeline({ ranked }: { ranked: RankedLead[] }) {
  const w = useLeadWriter();
  const [drag, setDrag] = useState<string | null>(null);
  const move = (l: RankedLead, to: LeadStage) => {
    if (l.stage === to) return;
    const { score: _score, ...lead } = l;
    w.put({ ...lead, stage: to }, `${l.name} moved to ${STAGE_LABEL[to]}`);
  };
  return (
    <div className="grid g220 start" data-tour="leads-pipeline">
      {LEAD_STAGES.map((st, i) => {
        const col = ranked.filter((l) => l.stage === st);
        return (
          <Card key={st} kicker={`${STAGE_LABEL[st]} · ${col.length}`} style={{ minHeight: 140 }}>
            <div
              style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: 80 }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); const l = ranked.find((x) => x.id === drag); if (l) move(l, st); setDrag(null); }}
            >
              {col.map((l) => (
                <div key={l.id} className="cal-post" draggable data-dragging={drag === l.id} onDragStart={() => setDrag(l.id)} onDragEnd={() => setDrag(null)}>
                  <div><span className="strong">{l.name}</span> <span className="note">· {l.score.total}</span></div>
                  <div className="note">{l.company}</div>
                  <div className="row" style={{ gap: 4 }}>
                    <Button icon disabled={i === 0} title={i ? `Move to ${STAGE_LABEL[LEAD_STAGES[i - 1]]}` : undefined} aria-label={`Move ${l.name} back`} onClick={() => move(l, LEAD_STAGES[i - 1])}><ArrowLeft size={14} strokeWidth={1.5} /></Button>
                    <Button icon disabled={i === LEAD_STAGES.length - 1} title={i < LEAD_STAGES.length - 1 ? `Move to ${STAGE_LABEL[LEAD_STAGES[i + 1]]}` : undefined} aria-label={`Move ${l.name} forward`} onClick={() => move(l, LEAD_STAGES[i + 1])}><ArrowRight size={14} strokeWidth={1.5} /></Button>
                  </div>
                </div>
              ))}
              {!col.length && <div className="hint13">No leads here.</div>}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

const EMPTY: Omit<Campaign, 'id'> = { name: '', goal: '', channel: 'Email', status: 'Draft', startDate: null, endDate: null };
const CHANNEL_OPTIONS = ['Email', 'WhatsApp', 'LinkedIn (manual)', 'Phone', 'Other'];

function Campaigns({ showLeads }: { showLeads: (id: string) => void }) {
  const ws = useWs();
  const s = useApp();
  const [editing, setEditing] = useState<Campaign | null>(null);
  const [err, setErr] = useState('');
  const report = useMemo(() => buildReport(ws, '90d', new Date()).campaigns, [ws]);
  const pct = (v: number | null) => (v === null ? '—' : `${v}%`);

  const save = () => {
    if (!editing) return;
    const c = { ...editing, name: editing.name.trim() };
    if (!c.name) return setErr('Give the campaign a name.');
    if (c.startDate && c.endDate && c.endDate < c.startDate) return setErr('The end date is before the start date.');
    const isNew = !ws.campaigns.some((x) => x.id === c.id);
    s.update((x) => ({ campaigns: isNew ? [...x.campaigns, c] : x.campaigns.map((y) => (y.id === c.id ? c : y)) }));
    s.commit(isNew ? `Campaign created: ${c.name}` : `Campaign saved: ${c.name}`, change('campaign', c.id, c));
    setEditing(null);
  };
  const del = (c: Campaign) => s.confirm({
    title: 'Delete campaign?', body: `“${c.name}” will be removed. Its leads are kept and simply leave the campaign.`, confirm: 'Delete',
    run: () => {
      s.update((x) => ({ campaigns: x.campaigns.filter((y) => y.id !== c.id), leads: x.leads.map((l) => (l.campaignId === c.id ? { ...l, campaignId: null } : l)) }));
      s.commit(`Campaign deleted: ${c.name}`, remove('campaign', c.id));
      if (editing?.id === c.id) setEditing(null);
    },
  });
  const set = <K extends keyof Campaign>(k: K, v: Campaign[K]) => { setEditing({ ...editing!, [k]: v }); setErr(''); };

  return (
    <div className="grid g300 start">
      <Card className="span-2" style={{ minWidth: 0, overflowX: 'auto' }} tour="leads-campaigns">
        <div className="between center">
          <div className="card-kicker">Campaigns</div>
          <Button variant="ghost" onClick={() => { setEditing({ id: newId(), ...EMPTY }); setErr(''); }}>+ New</Button>
        </div>
        {!ws.campaigns.length && <div className="muted">No campaigns yet. A campaign groups leads you are reaching out to for one goal, and shows how that outreach is going.</div>}
        {ws.campaigns.length > 0 && (
          <table className="table">
            <thead><tr><th>Campaign</th><th>Status</th><th>Leads</th><th>Contacted</th><th>Replied</th><th>Converted</th><th>Reply rate</th><th /></tr></thead>
            <tbody>
              {ws.campaigns.map((c) => {
                const r = report.find((x) => x.id === c.id)!;
                return (
                  <tr key={c.id}>
                    <td><div className="strong">{c.name}</div><div className="note">{[c.channel, c.goal].filter(Boolean).join(' · ')}</div></td>
                    <td><span className={`tag ${c.status === 'Active' ? 'tag-accent' : c.status === 'Completed' ? 'tag-neutral' : 'tag-outline'}`}>{c.status}</span></td>
                    <td>{r.leads}</td><td>{r.contacted}</td><td>{r.replied}</td><td>{r.converted}</td><td>{pct(r.replyRate)}</td>
                    <td>
                      <span className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                        <Button variant="ghost" onClick={() => showLeads(c.id)}>Leads</Button>
                        <Button variant="ghost" onClick={() => { setEditing(c); setErr(''); }}>Edit</Button>
                        <Button variant="ghost" onClick={() => del(c)}>Delete</Button>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <div className="note">A lead counts as replied when a conversation with them holds a message they sent. Add leads to a campaign from the lead list.</div>
      </Card>
      {editing && (
        <Card kicker={ws.campaigns.some((x) => x.id === editing.id) ? 'Edit campaign' : 'New campaign'}>
          <TextField label="Name" value={editing.name} onChange={(v) => set('name', v)} autoFocus />
          <TextField label="Goal" value={editing.goal} onChange={(v) => set('goal', v)} placeholder="e.g. Book 10 discovery calls" />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <label className="field">
              <label>Channel</label>
              <select className="input" aria-label="Channel" value={editing.channel} onChange={(e) => set('channel', e.target.value)}>
                {(CHANNEL_OPTIONS.includes(editing.channel) ? CHANNEL_OPTIONS : [editing.channel, ...CHANNEL_OPTIONS]).map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label className="field">
              <label>Status</label>
              <select className="input" aria-label="Status" value={editing.status} onChange={(e) => set('status', e.target.value as CampaignStatus)}>
                {CAMPAIGN_STATUSES.map((st) => <option key={st} value={st}>{st}</option>)}
              </select>
            </label>
            <TextField label="Start date" type="date" value={editing.startDate ?? ''} onChange={(v) => set('startDate', v || null)} />
            <TextField label="End date" type="date" value={editing.endDate ?? ''} onChange={(v) => set('endDate', v || null)} />
          </div>
          {err && <ErrorText>{err}</ErrorText>}
          <div className="row"><PrimaryButton onClick={save}>Save campaign</PrimaryButton><Button onClick={() => setEditing(null)}>Cancel</Button></div>
        </Card>
      )}
    </div>
  );
}

export function Leads() {
  const ws = useWs();
  const tab = useApp((s) => s.leadsTab);
  const [campaign, setCampaign] = useState('');
  const ranked = useMemo(() => rankLeads(ws.leads, ws.icp), [ws.leads, ws.icp]);
  const setTab = (leadsTab: LeadsTab) => useApp.getState().set({ leadsTab });
  return (
    <div className="stack screen">
      <Seg name="Leads view" value={tab} options={TABS} onChange={setTab} style={{ alignSelf: 'flex-start' }} tour="leads-tabs" />
      {tab === 'list' && <List ranked={ranked} campaignFilter={ws.campaigns.some((c) => c.id === campaign) ? campaign : ''} setCampaignFilter={setCampaign} />}
      {tab === 'pipeline' && <Pipeline ranked={ranked} />}
      {tab === 'campaigns' && <Campaigns showLeads={(id) => { setCampaign(id); setTab('list'); }} />}
    </div>
  );
}
