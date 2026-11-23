import { useState } from 'react';
import { Button, Card, ErrorText, Field, PrimaryButton, Seg, TextField } from '../components/ui';
import { addDays, dayLabel, toIsoDate, weekOf } from '../lib/dates';
import { NEXT_ACTION, excerpt, leastLoadedDay, schedulableDays, statusTag } from '../lib/posts';
import type { GeneratedPost, Post, Tone } from '../lib/types';
import { change, newId, remove, useApp, useWs } from '../state/store';

const TABS = [['gen', 'Generator'], ['posts', 'Posts'], ['cal', 'Calendar']] as const;
const TONES = [['Direct', 'Direct'], ['Story', 'Story'], ['Data', 'Data']] as const;

function usePostActions() {
  const s = useApp();
  const up = (id: string, patch: Partial<Post>, message: string) => {
    const cur = useApp.getState().ws!.posts.find((p) => p.id === id);
    if (!cur) return;
    const next = { ...cur, ...patch };
    s.update((x) => ({ posts: x.posts.map((p) => (p.id === id ? next : p)) }));
    s.commit(message, change('post', id, next));
  };
  return { up };
}

function Generator() {
  const ws = useWs();
  const s = useApp();
  const [topic, setTopic] = useState('');
  const [audience, setAudience] = useState('marketing agency founders');
  const [tone, setTone] = useState<Tone>('Direct');
  const [gen, setGen] = useState<GeneratedPost | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);
  const [variant, setVariant] = useState(0);

  const generate = async () => {
    if (!topic.trim()) return setErr(true);
    if (s.needsNet()) return;
    setBusy(true); setErr(false);
    try {
      const { notice, ...post } = await s.backend!.ai.generatePost({ topic, audience, tone, variant });
      setGen(post);
      if (notice) s.notify(notice);
      setVariant(variant + 1);
      s.update((x) => ({ aiUsage: { ...x.aiUsage, postsGenerated: x.aiUsage.postsGenerated + 1 } }));
    } catch (e) {
      s.notify(`Could not generate: ${e instanceof Error ? e.message : 'unknown error'}`);
    } finally {
      setBusy(false);
    }
  };
  const edit = (k: keyof GeneratedPost) => (v: string) => setGen((g) => (g ? { ...g, [k]: v } : g));
  const saveDraft = () => {
    if (!gen) return;
    const post: Post = { id: newId(), title: gen.hook, body: `${gen.body}\n\n${gen.cta}\n${gen.tags}`, status: 'Draft', date: null };
    s.update((x) => ({ posts: [post, ...x.posts] }));
    setGen(null); setTopic('');
    s.set({ csTab: 'posts' });
    s.commit('Draft saved', change('post', post.id, post));
  };

  return (
    <div className="grid g300 start">
      <Card kicker="01 · Topic">
        <TextField label="Topic" placeholder="e.g. cold outreach follow-ups" value={topic} onChange={(v) => { setTopic(v); setErr(false); }} aria-invalid={err} />
        {err && <ErrorText>Enter a topic to generate a post.</ErrorText>}
        <TextField label="Audience" value={audience} onChange={setAudience} />
        <Field label="Tone"><Seg name="Tone" value={tone} options={TONES} onChange={setTone} /></Field>
        <div className="note">Brand voice: {ws.profile.workspace} — {ws.brandVoice}.</div>
        <PrimaryButton disabled={busy} onClick={() => void generate()}>{busy ? 'Generating…' : 'Generate post'}</PrimaryButton>
      </Card>
      <Card kicker="02 · Edit and approve">
        {gen ? (
          <>
            <TextField label="Hook" value={gen.hook} onChange={edit('hook')} />
            <label className="field">
              <label>Body</label>
              <textarea className="input" style={{ minHeight: 150 }} value={gen.body} onChange={(e) => edit('body')(e.target.value)} />
            </label>
            <TextField label="Call to action" value={gen.cta} onChange={edit('cta')} />
            <TextField label="Hashtags" value={gen.tags} onChange={edit('tags')} />
            <div className="row wrap">
              <PrimaryButton onClick={saveDraft}>Save as draft</PrimaryButton>
              <Button disabled={busy} onClick={() => void generate()}>Regenerate</Button>
            </div>
          </>
        ) : (
          <div className="muted" style={{ padding: '30px 0' }}>Enter a topic and generate. Nothing is published without your approval.</div>
        )}
      </Card>
    </div>
  );
}

function Posts() {
  const ws = useWs();
  const s = useApp();
  const { up } = usePostActions();
  const now = new Date();

  const advance = (p: Post) => {
    const a = NEXT_ACTION[p.status];
    if (!a) return;
    if (a.next === 'In review') return up(p.id, { status: a.next }, `Review requested for “${p.title}”`);
    if (a.next === 'Approved') return up(p.id, { status: a.next }, 'Post approved');
    if (a.next === 'Scheduled') {
      const date = leastLoadedDay(schedulableDays(weekOf(now), toIsoDate(now)), ws.posts);
      return up(p.id, { status: a.next, date }, `Scheduled for ${dayLabel(date)}`);
    }
    up(p.id, { status: a.next }, 'Marked as published');
  };
  const del = (p: Post) => s.confirm({
    title: 'Delete post?', body: `“${p.title}” will be removed from this workspace.`, confirm: 'Delete',
    run: () => { s.update((x) => ({ posts: x.posts.filter((y) => y.id !== p.id) })); s.commit('Post deleted', remove('post', p.id)); },
  });

  return (
    <Card style={{ overflowX: 'auto' }}>
      <table className="table">
        <thead><tr><th>Post</th><th>Status</th><th>Day</th><th><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>
          {ws.posts.map((p) => {
            const a = NEXT_ACTION[p.status];
            return (
              <tr key={p.id}>
                <td style={{ minWidth: 220 }}><div className="strong">{p.title}</div><div className="note">{excerpt(p.body)}</div></td>
                <td><span className={statusTag(p.status)}>{p.status}</span></td>
                <td style={{ whiteSpace: 'nowrap' }}>{p.date ? dayLabel(p.date) : '—'}</td>
                <td>
                  <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                    {a && <Button onClick={() => advance(p)} style={{ whiteSpace: 'nowrap' }}>{a.label}</Button>}
                    <Button variant="ghost" onClick={() => del(p)}>Delete</Button>
                  </div>
                </td>
              </tr>
            );
          })}
          {!ws.posts.length && <tr><td colSpan={4} className="muted">No posts yet. Generate one to start.</td></tr>}
        </tbody>
      </table>
      <div className="note">Publishing is a manual reminder unless an approved LinkedIn API scope is connected.</div>
    </Card>
  );
}

function Calendar() {
  const ws = useWs();
  const { up } = usePostActions();
  const now = new Date();
  const week = weekOf(now);
  const today = toIsoDate(now);
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  const moveTo = (p: Post, date: string) => {
    if (date === p.date || !week.includes(date)) return;
    up(p.id, { date }, `Moved to ${dayLabel(date)}`);
  };

  return (
    <div className="scroll-x" style={{ padding: 6 }}>
      <div className="cal">
        {week.map((d) => (
          <div
            key={d} className="cal-day" data-today={d === today} data-over={over === d}
            onDragOver={(e) => { if (dragId) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOver(d); } }}
            onDragLeave={() => setOver((o) => (o === d ? null : o))}
            onDrop={(e) => {
              e.preventDefault();
              const p = ws.posts.find((x) => x.id === dragId);
              setOver(null); setDragId(null);
              if (p) moveTo(p, d);
            }}
          >
            <h6 style={{ margin: 0 }}>{dayLabel(d)}</h6>
            {ws.posts.filter((p) => p.date === d).map((p) => (
              <div
                key={p.id} className="cal-post" draggable data-dragging={dragId === p.id}
                onDragStart={(e) => { e.dataTransfer.setData('text/plain', p.id); e.dataTransfer.effectAllowed = 'move'; setDragId(p.id); }}
                onDragEnd={() => { setDragId(null); setOver(null); }}
              >
                <span>{p.title}</span>
                <span className={statusTag(p.status)} style={{ alignSelf: 'flex-start' }}>{p.status}</span>
                {/* Keyboard and touch equivalent of dragging. */}
                <span className="row" style={{ gap: 4 }}>
                  <Button style={{ padding: '2px 8px' }} title="Move earlier" aria-label={`Move “${p.title}” a day earlier`} disabled={d === week[0]} onClick={() => moveTo(p, addDays(d, -1))}>‹</Button>
                  <Button style={{ padding: '2px 8px' }} title="Move later" aria-label={`Move “${p.title}” a day later`} disabled={d === week[6]} onClick={() => moveTo(p, addDays(d, 1))}>›</Button>
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function ContentStudio() {
  const tab = useApp((s) => s.csTab);
  return (
    <div className="stack screen">
      <Seg name="Content Studio view" value={tab} options={TABS} onChange={(csTab) => useApp.getState().set({ csTab })} style={{ alignSelf: 'flex-start' }} />
      {tab === 'gen' && <Generator />}
      {tab === 'posts' && <Posts />}
      {tab === 'cal' && <Calendar />}
    </div>
  );
}
