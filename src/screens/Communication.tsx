import { useState } from 'react';
import { Button, Card, Chip, PrimaryButton, Seg } from '../components/ui';
import { relTime } from '../lib/dates';
import type { Conversation } from '../lib/types';
import { change, newId, useApp, useWs } from '../state/store';

const FILTERS = [['all', 'All'], ['unread', 'Unread'], ['important', 'Important']] as const;
type Filter = (typeof FILTERS)[number][0];

export function Communication() {
  const ws = useWs();
  const s = useApp();
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState('');
  const now = new Date();

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

  const notice = <div className="note" data-tour="inbox-notice">Conversations come from manual import and approved connectors only. LinkedIn private inbox is not accessed.</div>;
  if (!conv) return <div className="screen" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>{notice}<Card tour="inbox-list"><div className="muted">No conversations yet.</div></Card></div>;

  const send = () => {
    const t = draft.trim();
    if (!t) return;
    put({ ...conv, unread: false, msgs: [...conv.msgs, { me: true, text: t, at: new Date().toISOString(), queued: s.isOffline() || undefined }] }, `Reply sent to ${conv.name}`);
    setDraft('');
  };
  const addNote = () => {
    const t = note.trim();
    if (!t) return;
    put({ ...conv, notes: [...conv.notes, t] }, `Note added to ${conv.name}`);
    setNote('');
  };
  const makeTask = () => {
    const task = { id: newId(), text: `Follow up with ${conv.name}`, due: 'Tomorrow', done: false };
    s.update((x) => ({ tasks: [task, ...x.tasks] }));
    s.commit(`Follow-up task created for ${conv.name}`, change('task', task.id, task));
  };

  return (
    <div className="screen" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {notice}
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
              <div className="note">{conv.company} · Intent: {conv.intent} · Sentiment: {conv.sentiment}</div>
            </div>
            <div className="row" style={{ gap: 6 }}>
              <Button onClick={() => put({ ...conv, important: !conv.important })}>{conv.important ? 'Unmark important' : 'Mark important'}</Button>
              <Button onClick={makeTask}>Create follow-up</Button>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 0', minHeight: 160 }}>
            {conv.msgs.map((m, i) => (
              <div key={i} className="bubble" data-me={m.me} style={{ maxWidth: '78%' }}>
                {m.text}
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>{m.queued ? 'Queued' : relTime(m.at, now)}</div>
              </div>
            ))}
          </div>
          <div style={{ border: '1px dashed var(--color-divider)', padding: 8, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <div className="card-kicker">AI suggested reply · needs your approval</div>
              <div style={{ fontSize: 13 }}>{conv.suggestion}</div>
            </div>
            <Button onClick={() => setDraft(conv.suggestion)}>Use</Button>
          </div>
          <div className="row wrap" style={{ gap: 6 }}>
            {ws.savedReplies.map((r) => <Chip key={r.title} onClick={() => setDraft(r.text)}>{r.title}</Chip>)}
          </div>
          <textarea className="input" placeholder="Write a reply" aria-label="Reply" value={draft} onChange={(e) => setDraft(e.target.value)} />
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <PrimaryButton disabled={!draft.trim()} onClick={send}>Send reply</PrimaryButton>
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
