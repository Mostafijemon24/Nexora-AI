import { useEffect, useState } from 'react';
import { Button, Card, Chip, ErrorText, PrimaryButton, Seg, TextField } from '../components/ui';
import { addDays, relTime, toIsoDate } from '../lib/dates';
import { SEND_CHANNELS, type Conversation, type Message } from '../lib/types';
import { change, newId, useApp, useWs } from '../state/store';

const FILTERS = [['all', 'All'], ['unread', 'Unread'], ['important', 'Important']] as const;
type Filter = (typeof FILTERS)[number][0];
const CHANNELS = ['Email', 'WhatsApp', 'Manual import'];
/** Integration that delivers each sendable channel. */
const CHANNEL_INTEGRATION: Record<string, string> = { Email: 'em', WhatsApp: 'wa' };

function messageStatus(m: Message, now: Date): string {
  if (m.queued) return 'Queued';
  const when = relTime(m.at, now);
  if (!m.me || !m.status) return when;
  if (m.status === 'sent') return `${when} · Sent`;
  return `${when} · Not sent`;
}

function NewConversation({ onDone }: { onDone: (id: string | null) => void }) {
  const s = useApp();
  const [f, setF] = useState({ name: '', company: '', channel: 'Email', address: '' });
  const [err, setErr] = useState('');
  const set = (k: keyof typeof f) => (v: string) => { setF({ ...f, [k]: v }); setErr(''); };
  const add = () => {
    if (!f.name.trim()) return setErr('Enter the person’s name.');
    if (f.channel === 'Email' && !/^\S+@\S+\.\S+$/.test(f.address.trim())) return setErr('Enter their email address.');
    if (f.channel === 'WhatsApp' && f.address.replace(/\D/g, '').length < 8) return setErr('Enter their phone number with the country code.');
    const c: Conversation = {
      id: newId(), name: f.name.trim(), company: f.company.trim(), channel: f.channel, address: f.address.trim() || null, leadId: null,
      unread: false, important: false, intent: '', sentiment: '', suggestion: '', msgs: [], notes: [],
    };
    s.update((x) => ({ conversations: [...x.conversations, c] }));
    s.commit(`Conversation started with ${c.name}`, change('conversation', c.id, c));
    onDone(c.id);
  };
  return (
    <Card kicker="New conversation">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
        <TextField label="Name" value={f.name} onChange={set('name')} autoFocus />
        <TextField label="Company (optional)" value={f.company} onChange={set('company')} />
        <label className="field">
          <label>Channel</label>
          <select className="input" aria-label="Channel" value={f.channel} onChange={(e) => set('channel')(e.target.value)}>{CHANNELS.map((c) => <option key={c} value={c}>{c === 'Manual import' ? 'Keep here only' : c}</option>)}</select>
        </label>
        {f.channel !== 'Manual import' && <TextField label={f.channel === 'Email' ? 'Email address' : 'Phone number (with country code)'} value={f.address} onChange={set('address')} />}
      </div>
      {err && <ErrorText>{err}</ErrorText>}
      <div className="row"><PrimaryButton onClick={add}>Start conversation</PrimaryButton><Button onClick={() => onDone(null)}>Cancel</Button></div>
    </Card>
  );
}

export function Communication() {
  const ws = useWs();
  const s = useApp();
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [activeId, setActiveId] = useState<string | null>(s.inboxId);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState('');
  const [adding, setAdding] = useState(false);
  const now = new Date();
  // Another page asked for one conversation: show it once, then let the list decide.
  useEffect(() => { if (s.inboxId) { setActiveId(s.inboxId); s.set({ inboxId: null }); } }, [s.inboxId]);

  const q = search.toLowerCase();
  const list = ws.conversations.filter((c) =>
    (filter === 'all' || (filter === 'unread' && c.unread) || (filter === 'important' && c.important)) && (c.name + c.company).toLowerCase().includes(q));
  const conv = ws.conversations.find((c) => c.id === activeId) ?? ws.conversations[0];

  const put = (next: Conversation, message?: string) => {
    s.update((x) => ({ conversations: x.conversations.map((c) => (c.id === next.id ? next : c)) }));
    if (message) s.commit(message, change('conversation', next.id, next));
    else s.save(change('conversation', next.id, next));
  };
  const open = (c: Conversation) => {
    setActiveId(c.id); setDraft('');
    if (c.unread) put({ ...c, unread: false });
  };

  const notice = (
    <div className="between center wrap" style={{ gap: 8 }}>
      <div className="note" data-tour="inbox-notice">Conversations come from email and WhatsApp accounts you connect, from workflows and from what you add here. LinkedIn private inbox is not accessed.</div>
      <Button onClick={() => setAdding(true)}>+ New conversation</Button>
    </div>
  );
  const form = adding && <NewConversation onDone={(id) => { setAdding(false); if (id) setActiveId(id); }} />;
  if (!conv) return <div className="screen" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>{notice}{form}<Card tour="inbox-list"><div className="muted">No conversations yet.</div></Card></div>;

  const sendable = (SEND_CHANNELS as readonly string[]).includes(conv.channel);
  const connected = sendable && Boolean(ws.integrations.find((g) => g.id === CHANNEL_INTEGRATION[conv.channel])?.connected);
  const via = conv.channel === 'Email' ? 'by email' : 'on WhatsApp';
  const delivery = !sendable
    ? 'Replies are kept here only. Send them yourself, then come back.'
    : !connected
      ? `${conv.channel} is not connected, so replies are kept here and not sent. Connect it on the Integrations page.`
      : !conv.address
        ? `Add ${conv.channel === 'Email' ? 'an email address' : 'a phone number'} below to send replies ${via}.`
        : `Replies are sent ${via} to ${conv.address}.`;

  const send = () => {
    const t = draft.trim();
    if (!t) return;
    const at = new Date().toISOString();
    const id = newId();
    const off = s.isOffline();
    s.update((x) => ({ conversations: x.conversations.map((c) => (c.id === conv.id ? { ...c, unread: false, msgs: [...c.msgs, { id, me: true, text: t, at, queued: off || undefined }] } : c)) }));
    s.commit(connected && conv.address ? `Reply to ${conv.name} is on its way` : `Reply to ${conv.name} saved`, change('message', id, { id, conversationId: conv.id, text: t, at }));
    setDraft('');
  };
  const addNote = () => {
    const t = note.trim();
    if (!t) return;
    put({ ...conv, notes: [...conv.notes, t] }, `Note added to ${conv.name}`);
    setNote('');
  };
  const makeTask = () => {
    const task = { id: newId(), text: `Follow up with ${conv.name}`, due: '', dueDate: addDays(toIsoDate(new Date()), 1), leadId: conv.leadId ?? null, done: false };
    s.update((x) => ({ tasks: [task, ...x.tasks] }));
    s.commit(`Follow-up task created for ${conv.name}`, change('task', task.id, task));
  };
  const about = [conv.company, conv.intent && `Intent: ${conv.intent}`, conv.sentiment && `Sentiment: ${conv.sentiment}`].filter(Boolean).join(' · ');

  return (
    <div className="screen" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {notice}
      {form}
      <div className="grid g260 start">
        <Card tour="inbox-list">
          <input className="input" type="search" placeholder="Search conversations" aria-label="Search conversations" value={search} onChange={(e) => setSearch(e.target.value)} />
          <Seg name="Conversation filter" value={filter} options={FILTERS} onChange={setFilter} style={{ alignSelf: 'flex-start' }} />
          {list.map((c) => (
            <button type="button" key={c.id} className="pick" aria-selected={c.id === conv.id} onClick={() => open(c)} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span className="between" style={{ gap: 8 }}>
                <span style={{ fontWeight: c.unread ? 700 : 500 }}>{c.name}</span>
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>{c.channel}</span>
              </span>
              <span className="note" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.msgs[c.msgs.length - 1]?.text ?? ''}</span>
            </button>
          ))}
          {!list.length && <div className="muted">No conversations match.</div>}
        </Card>

        <Card className="span-2" tour="inbox-thread">
          <div className="between center wrap" style={{ gap: 8 }}>
            <div>
              <div className="card-title">{conv.name}</div>
              {about && <div className="note">{about}</div>}
            </div>
            <div className="row wrap" style={{ gap: 6 }}>
              {conv.leadId && ws.leads.some((l) => l.id === conv.leadId) && <Button onClick={() => s.go('leads', { leadsTab: 'list' })}>Open leads</Button>}
              <Button onClick={() => put({ ...conv, important: !conv.important })}>{conv.important ? 'Unmark important' : 'Mark important'}</Button>
              <Button onClick={makeTask}>Create follow-up</Button>
            </div>
          </div>
          <div className="row wrap center" style={{ gap: 8 }}>
            <select className="input" aria-label="Channel" style={{ width: 'auto' }} value={conv.channel} onChange={(e) => put({ ...conv, channel: e.target.value })}>
              {(CHANNELS.includes(conv.channel) ? CHANNELS : [conv.channel, ...CHANNELS]).map((c) => <option key={c} value={c}>{c === 'Manual import' ? 'Keep here only' : c}</option>)}
            </select>
            {sendable && (
              <input
                className="input" style={{ flex: 1, minWidth: 200 }} aria-label={conv.channel === 'Email' ? 'Email address' : 'Phone number'}
                placeholder={conv.channel === 'Email' ? 'Email address' : 'Phone number with country code'} defaultValue={conv.address ?? ''} key={`${conv.id}:${conv.channel}`}
                onBlur={(e) => { const v = e.target.value.trim() || null; if (v !== (conv.address ?? null)) put({ ...conv, address: v }); }}
              />
            )}
          </div>
          <div className="note">{delivery}</div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 0', minHeight: 160 }}>
            {conv.msgs.map((m, i) => (
              <div key={m.id ?? i} className="bubble" data-me={m.me} style={{ maxWidth: '78%', whiteSpace: 'pre-wrap' }}>
                {m.text}
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>{messageStatus(m, now)}</div>
                {m.me && m.status && m.status !== 'sent' && m.error && <div style={{ fontSize: 11, color: 'var(--muted)' }}>{m.error}</div>}
              </div>
            ))}
            {!conv.msgs.length && <div className="hint13">No messages yet.</div>}
          </div>
          {conv.suggestion && (
            <div style={{ border: '1px dashed var(--color-divider)', padding: 8, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <div className="card-kicker">AI suggested reply · needs your approval</div>
                <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{conv.suggestion}</div>
              </div>
              <Button onClick={() => setDraft(conv.suggestion)}>Use</Button>
            </div>
          )}
          <div className="row wrap" style={{ gap: 6 }}>
            {ws.savedReplies.map((r) => <Chip key={r.title} onClick={() => setDraft(r.text)}>{r.title}</Chip>)}
          </div>
          <textarea className="input" placeholder="Write a reply" aria-label="Reply" value={draft} onChange={(e) => setDraft(e.target.value)} />
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <PrimaryButton disabled={!draft.trim()} onClick={send}>{connected && conv.address ? 'Send reply' : 'Save reply'}</PrimaryButton>
          </div>
          <div className="section-top" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div className="card-kicker">Internal notes</div>
            {conv.notes.map((n, i) => <div key={i} style={{ fontSize: 13, padding: '4px 8px', background: 'var(--tint)' }}>{n}</div>)}
            <div className="row">
              <input
                className="input" placeholder="Add a note for the team" aria-label="Internal note" value={note}
                onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addNote(); }}
              />
              <Button onClick={addNote}>Add</Button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
