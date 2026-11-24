import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, Chip, ErrorText, PrimaryButton, Seg, TextField } from '../components/ui';
import { rankLeads, type RankedLead } from '../lib/scoring';
import type { Icp } from '../lib/types';
import { change, newId, remove, useApp, useWs } from '../state/store';

const TABS = [['scoring', 'Lead scoring'], ['chat', 'AI assistant'], ['prompts', 'Prompt library']] as const;

function Scoring() {
  const ws = useWs();
  const s = useApp();
  const [sel, setSel] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const ranked = useMemo(() => rankLeads(ws.leads, ws.icp), [ws.leads, ws.icp]);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(saveTimer.current), []);

  const setIcp = (k: keyof Icp) => (v: string) => {
    const icp = { ...useApp.getState().ws!.icp, [k]: v };
    s.update(() => ({ icp }));
    // Scores update on every keystroke; the server copy is written once typing pauses.
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => useApp.getState().save(change('icp', 'icp', useApp.getState().ws!.icp)), 600);
  };

  const lead: RankedLead | undefined = ranked.find((l) => l.id === sel) ?? ranked[0];

  const draft = async () => {
    if (!lead || s.needsNet() || drafting) return;
    setDrafting(true);
    try {
      const { text, notice } = await s.backend!.ai.draftMessage(lead.id);
      if (notice) s.notify(notice);
      s.set({ chat: [...useApp.getState().chat, { me: true, text: `Draft a first message for ${lead.name}` }, { me: false, text: `Draft (needs your approval):\n\n${text}` }] });
      s.go('ai', { aiTab: 'chat' });
    } catch (e) {
      s.notify(`Could not draft: ${e instanceof Error ? e.message : 'unknown error'}`);
    } finally {
      setDrafting(false);
    }
  };

  return (
    <div className="grid g280 start">
      <Card kicker="Target customer criteria" tour="ai-icp">
        <TextField label="Industry" value={ws.icp.industry} onChange={setIcp('industry')} />
        <TextField label="Job titles (comma separated)" value={ws.icp.title} onChange={setIcp('title')} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <TextField label="Company size min" type="number" min={0} value={ws.icp.sizeMin} onChange={setIcp('sizeMin')} />
          <TextField label="Company size max" type="number" min={0} value={ws.icp.sizeMax} onChange={setIcp('sizeMax')} />
        </div>
        <TextField label="Location" value={ws.icp.location} onChange={setIcp('location')} />
        <div className="note">Scores update as you type. Missing data is never guessed.</div>
      </Card>

      {!lead && (
        <Card kicker="Leads ranked by match" tour="ai-leads">
          <div className="muted">No leads yet. Import a CSV to score them against your criteria.</div>
          <div><Button onClick={() => s.go('integrations')}>Open Integrations</Button></div>
        </Card>
      )}
      {lead && <Card kicker="Leads ranked by match" style={{ minWidth: 0, overflowX: 'auto' }} tour="ai-leads">
        <table className="table">
          <thead><tr><th>Lead</th><th>Score</th><th>Conf.</th></tr></thead>
          <tbody>
            {ranked.map((l) => (
              <tr
                key={l.id} tabIndex={0} aria-selected={l.id === lead.id} onClick={() => setSel(l.id)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSel(l.id); } }}
                style={{ cursor: 'pointer', background: l.id === lead.id ? 'var(--tint)' : undefined }}
              >
                <td><div className="strong">{l.name}</div><div className="note">{[l.title, l.company].filter(Boolean).join(' · ')}</div></td>
                <td><strong>{l.score.total}</strong></td>
                <td>{l.score.conf}/10</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>}

      {lead && <Card kicker={`Score breakdown · ${lead.name}`}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span className="score-num">{lead.score.total}</span>
          <span className="muted">/ 100</span>
          <span className="tag tag-accent" style={{ marginLeft: 'auto' }}>{lead.score.label}</span>
        </div>
        {lead.score.parts.map((p) => (
          <div className="line" key={p.name} style={{ gap: 10 }}>
            <div><div>{p.name}</div><div className="note">{p.found}</div></div>
            <strong style={{ whiteSpace: 'nowrap' }}>{p.pts}</strong>
          </div>
        ))}
        <div className="between" style={{ paddingTop: 4 }}><span>Data confidence</span><strong>{lead.score.conf} / 10</strong></div>
        <Button disabled={drafting} onClick={() => void draft()}>{drafting ? 'Drafting…' : 'Draft personalized message'}</Button>
      </Card>}
    </div>
  );
}

function Assistant() {
  const ws = useWs();
  const s = useApp();
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [s.chat.length, s.thinking]);
  return (
    <Card kicker={`AI assistant · ${ws.routing['Reply suggestions']}`} style={{ maxWidth: 820 }} tour="ai-chat">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: 220 }} aria-live="polite">
        {s.chat.map((m, i) => <div key={i} className="bubble" data-me={m.me} style={{ maxWidth: '80%', whiteSpace: 'pre-wrap' }}>{m.text}</div>)}
        {s.thinking && <div className="hint13">Thinking…</div>}
        <div ref={end} />
      </div>
      <div className="row wrap" style={{ gap: 6 }}>
        {ws.prompts.map((p) => <Chip key={p.id} onClick={() => s.set({ chatInput: p.text })}>{p.title}</Chip>)}
      </div>
      <div className="row">
        <input
          className="input" placeholder="Ask about leads, posts or replies" aria-label="Message" value={s.chatInput}
          onChange={(e) => s.set({ chatInput: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Enter') void s.sendChat(); }}
        />
        <PrimaryButton disabled={s.thinking} onClick={() => void s.sendChat()}>Send</PrimaryButton>
      </div>
    </Card>
  );
}

function Prompts() {
  const ws = useWs();
  const s = useApp();
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [err, setErr] = useState(false);

  const add = () => {
    if (!title.trim() || !text.trim()) return setErr(true);
    const p = { id: newId(), title: title.trim(), text: text.trim() };
    s.update((x) => ({ prompts: [...x.prompts, p] }));
    setTitle(''); setText(''); setErr(false);
    s.commit('Prompt saved', change('prompt', p.id, p));
  };
  const del = (id: string, name: string) => s.confirm({
    title: 'Delete prompt?', body: `“${name}” will be removed from the prompt library.`, confirm: 'Delete',
    run: () => { s.update((x) => ({ prompts: x.prompts.filter((p) => p.id !== id) })); s.commit('Prompt deleted', remove('prompt', id)); },
  });

  return (
    <div className="grid g300 start">
      <Card kicker="Prompt library">
        {ws.prompts.map((p) => (
          <div key={p.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--line2)' }}>
            <div className="between center" style={{ gap: 8 }}>
              <strong>{p.title}</strong>
              <span className="row" style={{ gap: 4 }}>
                <Button variant="ghost" onClick={() => { s.set({ chatInput: p.text }); s.go('ai', { aiTab: 'chat' }); }}>Use</Button>
                <Button variant="ghost" onClick={() => del(p.id, p.title)}>Delete</Button>
              </span>
            </div>
            <div className="hint13">{p.text}</div>
          </div>
        ))}
        {!ws.prompts.length && <div className="muted">No prompts yet. Add one to reuse it in the assistant.</div>}
      </Card>
      <Card kicker="New prompt" tour="ai-prompt-new">
        <TextField label="Title" value={title} onChange={(v) => { setTitle(v); setErr(false); }} />
        <label className="field">
          <label>Prompt</label>
          <textarea className="input" value={text} onChange={(e) => { setText(e.target.value); setErr(false); }} />
        </label>
        {err && <ErrorText>Title and prompt are both required.</ErrorText>}
        <PrimaryButton onClick={add}>Save prompt</PrimaryButton>
      </Card>
    </div>
  );
}

export function AiIntelligence() {
  const tab = useApp((s) => s.aiTab);
  return (
    <div className="stack screen">
      <Seg name="AI Intelligence view" value={tab} options={TABS} onChange={(aiTab) => useApp.getState().set({ aiTab })} style={{ alignSelf: 'flex-start' }} tour="ai-tabs" />
      {tab === 'scoring' && <Scoring />}
      {tab === 'chat' && <Assistant />}
      {tab === 'prompts' && <Prompts />}
    </div>
  );
}
