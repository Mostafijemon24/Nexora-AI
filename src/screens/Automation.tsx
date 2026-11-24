import { ArrowDown, ArrowUp, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button, Card, ErrorText, PrimaryButton, Switch } from '../components/ui';
import { relTime } from '../lib/dates';
import { statusTag } from '../lib/posts';
import type { Run, Step, StepType, Workflow } from '../lib/types';
import { describeStep, makeStep, STEP_DEFS, stepDef, workflowProblem, type FieldDef } from '../lib/workflow';
import { change, newId, remove, useApp, useWs } from '../state/store';

const TRIGGERS = STEP_DEFS.filter((d) => d.type === 'Trigger');
const ADDABLE = STEP_DEFS.filter((d) => d.type !== 'Trigger');
const GROUPS: [string, StepType[]][] = [['Conditions', ['Condition']], ['Changes to the lead', ['Update']], ['Actions', ['Action', 'Notification']], ['Flow', ['Delay', 'Approval', 'Stop']]];
const zone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };

/** A trigger of the given kind. A schedule remembers the time zone it was set in. */
const trigger = (kind: string): Step => makeStep(kind, kind === 'schedule' ? { zone: zone() } : {});

function FieldInput({ f, value, onChange, label }: { f: FieldDef; value: string; onChange: (v: string) => void; label: string }) {
  if (f.type === 'select') {
    return (
      <select className="input" aria-label={label} title={f.label} style={{ width: 'auto', maxWidth: '100%' }} value={value} onChange={(e) => onChange(e.target.value)}>
        {f.options!.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    );
  }
  return (
    <input
      className="input" aria-label={label} title={f.label} placeholder={f.placeholder ?? f.label} value={value}
      type={f.type === 'number' ? 'number' : f.type === 'time' ? 'time' : 'text'} min={f.type === 'number' ? 0 : undefined}
      style={f.type === 'text' ? { flex: 1, minWidth: 160 } : { width: f.type === 'time' ? 120 : 90 }}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function Automation() {
  const ws = useWs();
  const s = useApp();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [adding, setAdding] = useState('');
  const [subject, setSubject] = useState('');
  const [openRun, setOpenRun] = useState<string | null>(null);
  const wf = ws.workflows.find((f) => f.id === activeId) ?? ws.workflows[0];
  const now = new Date();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  /** Saves a workflow. A workflow with a problem is kept on screen and switched off, so it cannot run half-built. */
  const put = (next: Workflow, debounce = false) => {
    const safe = workflowProblem(next.steps) ? { ...next, on: false } : next;
    s.update((x) => ({ workflows: x.workflows.map((f) => (f.id === safe.id ? safe : f)) }));
    clearTimeout(timer.current);
    const send = () => {
      const cur = useApp.getState().ws?.workflows.find((f) => f.id === safe.id);
      if (cur && !workflowProblem(cur.steps)) useApp.getState().save(change('workflow', cur.id, cur));
    };
    if (debounce) timer.current = setTimeout(send, 600); else send();
  };

  const create = () => {
    const f: Workflow = { id: newId(), name: 'Untitled workflow', on: false, steps: [trigger('lead.created')] };
    s.update((x) => ({ workflows: [...x.workflows, f] }));
    s.save(change('workflow', f.id, f));
    setActiveId(f.id);
  };
  const toggle = (f: Workflow) => {
    const problem = workflowProblem(f.steps);
    if (!f.on && problem) return s.notify(problem);
    if (!f.on && f.steps.length < 2) return s.notify('Add at least one step after the trigger.');
    const next = { ...f, on: !f.on };
    s.update((x) => ({ workflows: x.workflows.map((y) => (y.id === f.id ? next : y)) }));
    s.commit(`“${f.name}” ${f.on ? 'switched off' : 'switched on'}`, change('workflow', f.id, next));
  };

  if (ws.plan.features && !ws.plan.features.includes('workflows')) {
    return (
      <Card kicker="Workflows" className="screen" tour="auto-list">
        <div className="muted">Workflows are part of the Professional plan. Your plan is {ws.plan.name}.</div>
        <div className="hint13">A workflow carries out steps by itself when something happens: a new lead, a stage change, a received message or a schedule.</div>
        <div data-tour="auto-editor" /><div data-tour="auto-runs" />
      </Card>
    );
  }
  if (!wf) {
    return (
      <Card kicker="Workflows" className="screen" tour="auto-list">
        <div className="muted">No workflows yet. A workflow carries out a set of steps by itself when something happens, such as a new lead or a received message.</div>
        <div><Button onClick={create}>+ New</Button></div>
      </Card>
    );
  }

  const problem = workflowProblem(wf.steps);
  const runs = ws.runs.filter((r) => r.workflowId === wf.id);
  const needsLead = wf.steps.some((x) => stepDef(x.kind)?.needs === 'lead');
  const manual = wf.steps[0].kind === 'manual';

  const setStep = (i: number, config: Record<string, string>) => {
    const d = stepDef(wf.steps[i].kind)!;
    const steps = wf.steps.map((x, j) => (j === i ? { ...x, config, label: d.describe(config) } : x));
    put({ ...wf, steps }, true);
  };
  const move = (i: number, by: -1 | 1) => {
    const steps = [...wf.steps];
    [steps[i], steps[i + by]] = [steps[i + by], steps[i]];
    put({ ...wf, steps });
  };
  const start = (test: boolean) => {
    if (problem) return s.notify(problem);
    if (wf.steps.length < 2) return s.notify('Add at least one step after the trigger.');
    if (needsLead && !subject) return s.notify('Choose the lead to run this for.');
    const lead = ws.leads.find((l) => l.id === subject);
    const r: Run = {
      id: newId(), workflowId: wf.id, name: wf.name, steps: wf.steps.length, status: 'Waiting', at: new Date().toISOString(),
      test: test || undefined, subject: lead ? { leadId: lead.id, label: lead.name } : {}, log: [],
    };
    s.update((x) => ({ runs: [r, ...x.runs] }));
    setOpenRun(r.id);
    s.commit(`${test ? 'Test run' : 'Run started'}: ${wf.name}`, change('run', r.id, r));
  };
  const decide = (r: Run, approve: boolean) => {
    const next: Run = { ...r, status: approve ? 'Waiting' : 'Rejected' };
    s.update((x) => ({ runs: x.runs.map((y) => (y.id === r.id ? next : y)) }));
    s.commit(approve ? 'Run approved' : 'Run rejected', change('run', r.id, { ...r, status: approve ? 'Completed' : 'Rejected' }));
  };
  const del = () => s.confirm({
    title: 'Delete workflow?', body: `“${wf.name}” and its run history will be removed.`, confirm: 'Delete',
    run: () => {
      s.update((x) => ({ workflows: x.workflows.filter((f) => f.id !== wf.id), runs: x.runs.filter((r) => r.workflowId !== wf.id) }));
      setActiveId(null);
      s.commit('Workflow deleted', remove('workflow', wf.id));
    },
  });

  return (
    <div className="grid g280 start screen">
      <Card tour="auto-list">
        <div className="between center">
          <div className="card-kicker">Workflows</div>
          <Button variant="ghost" onClick={create}>+ New</Button>
        </div>
        {ws.workflows.map((f) => (
          <div
            key={f.id} className="pick" role="button" tabIndex={0} aria-selected={f.id === wf.id} onClick={() => setActiveId(f.id)}
            onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setActiveId(f.id); } }}
            style={{ display: 'flex', alignItems: 'center', gap: 10 }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="strong">{f.name}</div>
              <div className="note">{describeStep(f.steps[0])} · {f.on ? 'On' : 'Off'}</div>
            </div>
            <Switch on={f.on} onChange={() => toggle(f)} label={`Switch ${f.name} ${f.on ? 'off' : 'on'}`} />
          </div>
        ))}
      </Card>

      <Card className="span-2" tour="auto-editor">
        <div className="row wrap center">
          <input
            className="input" aria-label="Workflow name" value={wf.name} onChange={(e) => put({ ...wf, name: e.target.value }, true)}
            style={{ flex: 1, minWidth: 180, fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 18 }}
          />
          <Button variant="ghost" onClick={del}>Delete</Button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {wf.steps.map((st, i) => {
            const d = stepDef(st.kind);
            const c = st.config ?? {};
            return (
              <div className="step" key={i}>
                <div className="step-rail"><span>{i + 1}</span><i /></div>
                <div className="step-body">
                  <span className="tag tag-accent" style={{ width: 92, justifyContent: 'center' }}>{st.type}</span>
                  {i === 0 && (
                    <select className="input" aria-label="Trigger" style={{ width: 'auto', maxWidth: '100%' }} value={st.kind ?? ''} onChange={(e) => put({ ...wf, steps: [trigger(e.target.value), ...wf.steps.slice(1)] })}>
                      {!d && <option value="">{st.label} (choose a trigger)</option>}
                      {TRIGGERS.map((t) => <option key={t.kind} value={t.kind}>{t.name}</option>)}
                    </select>
                  )}
                  {i > 0 && <span className="strong" style={{ minWidth: 150 }}>{d ? d.name : st.label}</span>}
                  {d?.fields.filter((f) => !(st.kind === 'schedule' && f.key === 'weekday' && c.every === 'day')).map((f) => (
                    <FieldInput key={f.key} f={f} value={c[f.key] ?? f.default} label={`Step ${i + 1}: ${f.label}`} onChange={(v) => setStep(i, { ...c, [f.key]: v })} />
                  ))}
                  {i > 0 && !d && <span className="note">A note from an earlier version. It is skipped when the workflow runs; remove it or add a step in its place.</span>}
                  {i > 0 && (
                    <span className="row" style={{ gap: 4, marginLeft: 'auto' }}>
                      <Button icon disabled={i === 1} title="Move up" aria-label={`Move step ${i + 1} up`} onClick={() => move(i, -1)}><ArrowUp size={14} strokeWidth={1.5} /></Button>
                      <Button icon disabled={i === wf.steps.length - 1} title="Move down" aria-label={`Move step ${i + 1} down`} onClick={() => move(i, 1)}><ArrowDown size={14} strokeWidth={1.5} /></Button>
                      <Button icon title="Remove step" aria-label={`Remove step ${i + 1}`} onClick={() => put({ ...wf, steps: wf.steps.filter((_, j) => j !== i) })}><X size={14} strokeWidth={1.5} /></Button>
                    </span>
                  )}
                  {d && <div className="note" style={{ flexBasis: '100%' }}>{d.describe(c)}{st.kind === 'schedule' ? ` (${c.zone || 'UTC'} time)` : ''}</div>}
                </div>
              </div>
            );
          })}
        </div>

        <div className="row wrap center" style={{ gap: 8 }}>
          <select className="input" aria-label="Step to add" style={{ width: 'auto', maxWidth: '100%' }} value={adding} onChange={(e) => setAdding(e.target.value)}>
            <option value="">Add a step…</option>
            {GROUPS.map(([name, types]) => (
              <optgroup key={name} label={name}>
                {ADDABLE.filter((d) => types.includes(d.type)).map((d) => <option key={d.kind} value={d.kind}>{d.name}</option>)}
              </optgroup>
            ))}
          </select>
          <Button disabled={!adding} onClick={() => { put({ ...wf, steps: [...wf.steps, makeStep(adding)] }); setAdding(''); }}>+ Add step</Button>
        </div>
        {problem && <ErrorText>{problem} The workflow stays off, and unsaved, until this is fixed.</ErrorText>}
        <div className="note">
          Text can include {'{{lead.name}}'}, {'{{lead.first_name}}'}, {'{{lead.company}}'} and {'{{post.title}}'}. A message is only ever sent after an approval step.
          Nothing here acts on LinkedIn. A workflow is never started by a change it made itself, and at most {ws.automationDailyRunLimit} runs start per day.
          {!s.backend!.canConnect && ' This build has no server, so workflows run only while the app is open, AI drafts are built-in examples, and messages and webhooks are not sent.'}
        </div>

        <div className="row wrap center" style={{ gap: 8 }}>
          {needsLead && (
            <select className="input" aria-label="Lead to run for" style={{ width: 'auto', maxWidth: '100%' }} value={subject} onChange={(e) => setSubject(e.target.value)}>
              <option value="">Choose a lead…</option>
              {ws.leads.map((l) => <option key={l.id} value={l.id}>{l.name} · {l.company}</option>)}
            </select>
          )}
          <PrimaryButton onClick={() => start(true)}>Test run</PrimaryButton>
          {manual && <Button onClick={() => start(false)}>Run now</Button>}
          <span className="note">A test run shows what each step would do and changes nothing.</span>
        </div>

        <div className="section-top" data-tour="auto-runs">
          <div className="card-kicker">Run history</div>
          {runs.map((r) => (
            <div key={r.id} style={{ borderBottom: '1px solid var(--line2)' }}>
              <div className="between center wrap" style={{ gap: 10, padding: '6px 0' }}>
                <button type="button" className="pick bare" style={{ padding: 0, textAlign: 'left' }} aria-expanded={openRun === r.id} onClick={() => setOpenRun(openRun === r.id ? null : r.id)}>
                  {r.test ? 'Test run' : 'Run'}{r.subject?.label ? ` · ${r.subject.label}` : ''} <span className="note">· {relTime(r.at, now)}</span>
                </button>
                <span className="row center">
                  <span className={statusTag(r.status)}>{r.status}</span>
                  {r.status === 'Awaiting approval' && <><Button onClick={() => decide(r, true)}>Approve</Button><Button variant="ghost" onClick={() => decide(r, false)}>Reject</Button></>}
                </span>
              </div>
              {openRun === r.id && (
                <div style={{ padding: '0 0 8px 12px', fontSize: 13 }}>
                  {(r.log ?? []).map((l, i) => <div key={i} style={{ color: l.ok ? undefined : 'var(--color-error, #b3261e)' }}>{l.step}. {l.text}</div>)}
                  {!(r.log ?? []).length && <div className="note">Starting…</div>}
                  {r.status === 'Waiting' && r.resumeAt && <div className="note">Continues {relTime(r.resumeAt, now)}.</div>}
                </div>
              )}
            </div>
          ))}
          {!runs.length && <div className="muted">No runs yet. Switch the workflow on to let it run by itself, or use Test run.</div>}
        </div>
      </Card>
    </div>
  );
}
