import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button, Card, PrimaryButton, Switch } from '../components/ui';
import { relTime } from '../lib/dates';
import { statusTag } from '../lib/posts';
import type { Run, StepType, Workflow } from '../lib/types';
import { change, newId, remove, useApp, useWs } from '../state/store';

/** Step types a user may add. None performs an action LinkedIn does not permit. */
const STEP_DEFAULTS: Record<Exclude<StepType, 'Trigger'>, string> = {
  Condition: 'Lead score greater than 70',
  Action: 'Create AI message draft',
  Delay: 'Wait 24 hours',
  Approval: 'Request user approval',
  Notification: 'Notify workspace',
  Update: 'Change lead status',
  Stop: 'End workflow',
};

export function Automation() {
  const ws = useWs();
  const s = useApp();
  const [activeId, setActiveId] = useState<string | null>(null);
  const wf = ws.workflows.find((f) => f.id === activeId) ?? ws.workflows[0];
  const now = new Date();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const put = (next: Workflow, debounce = false) => {
    s.update((x) => ({ workflows: x.workflows.map((f) => (f.id === next.id ? next : f)) }));
    clearTimeout(timer.current);
    const send = () => {
      const cur = useApp.getState().ws?.workflows.find((f) => f.id === next.id);
      if (cur) useApp.getState().save(change('workflow', cur.id, cur));
    };
    if (debounce) timer.current = setTimeout(send, 600); else send();
  };

  const create = () => {
    const f: Workflow = { id: newId(), name: 'Untitled workflow', on: false, steps: [{ type: 'Trigger', label: 'Lead created' }] };
    s.update((x) => ({ workflows: [...x.workflows, f] }));
    s.save(change('workflow', f.id, f));
    setActiveId(f.id);
  };
  const toggle = (f: Workflow) => {
    const next = { ...f, on: !f.on };
    s.update((x) => ({ workflows: x.workflows.map((y) => (y.id === f.id ? next : y)) }));
    s.commit(`“${f.name}” ${f.on ? 'disabled' : 'enabled'}`, change('workflow', f.id, next));
  };

  if (!wf) return <Card kicker="Workflows" className="screen"><div className="muted">No workflows yet.</div><div><Button onClick={create}>+ New</Button></div></Card>;

  const runs = ws.runs.filter((r) => r.workflowId === wf.id);
  const run = () => {
    if (wf.steps.length < 2) return s.notify('Add at least one step after the trigger.');
    const r: Run = {
      id: newId(), workflowId: wf.id, name: wf.name, steps: wf.steps.length,
      status: wf.steps.some((x) => x.type === 'Approval') ? 'Awaiting approval' : 'Completed', at: new Date().toISOString(),
    };
    s.update((x) => ({ runs: [r, ...x.runs] }));
    s.commit(`Test run: ${wf.name}`, change('run', r.id, r));
  };
  const approve = (r: Run) => {
    const next: Run = { ...r, status: 'Completed' };
    s.update((x) => ({ runs: x.runs.map((y) => (y.id === r.id ? next : y)) }));
    s.commit('Run approved', change('run', r.id, next));
  };
  const del = () => {
    if (ws.workflows.length < 2) return s.notify('Keep at least one workflow.');
    s.confirm({
      title: 'Delete workflow?', body: `“${wf.name}” and its run history will be removed.`, confirm: 'Delete',
      run: () => {
        s.update((x) => ({ workflows: x.workflows.filter((f) => f.id !== wf.id), runs: x.runs.filter((r) => r.workflowId !== wf.id) }));
        setActiveId(null);
        s.commit('Workflow deleted', remove('workflow', wf.id));
      },
    });
  };

  return (
    <div className="grid g280 start screen">
      <Card>
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
              <div className="note">{f.steps.length} steps · {f.on ? 'Enabled' : 'Disabled'}</div>
            </div>
            <Switch on={f.on} onChange={() => toggle(f)} label={`${f.on ? 'Disable' : 'Enable'} ${f.name}`} />
          </div>
        ))}
      </Card>

      <Card className="span-2">
        <div className="row wrap center">
          <input
            className="input" aria-label="Workflow name" value={wf.name} onChange={(e) => put({ ...wf, name: e.target.value }, true)}
            style={{ flex: 1, minWidth: 180, fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 18 }}
          />
          <PrimaryButton onClick={run}>Test run</PrimaryButton>
          <Button variant="ghost" onClick={del}>Delete</Button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {wf.steps.map((st, i) => (
            <div className="step" key={i}>
              <div className="step-rail"><span>{i + 1}</span><i /></div>
              <div className="step-body">
                <span className="tag tag-accent" style={{ width: 92, justifyContent: 'center' }}>{st.type}</span>
                <input
                  className="input" aria-label={`Step ${i + 1} (${st.type})`} value={st.label} style={{ flex: 1, minWidth: 160 }}
                  onChange={(e) => put({ ...wf, steps: wf.steps.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) }, true)}
                />
                {i > 0 && (
                  <Button icon title="Remove step" aria-label={`Remove step ${i + 1}`} onClick={() => put({ ...wf, steps: wf.steps.filter((_, j) => j !== i) })}>
                    <X size={14} strokeWidth={1.5} />
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
        <div>
          <div className="card-kicker" style={{ marginBottom: 6 }}>Add step</div>
          <div className="row wrap" style={{ gap: 6 }}>
            {(Object.keys(STEP_DEFAULTS) as (keyof typeof STEP_DEFAULTS)[]).map((type) => (
              <Button key={type} onClick={() => put({ ...wf, steps: [...wf.steps, { type, label: STEP_DEFAULTS[type] }] })}>+ {type}</Button>
            ))}
          </div>
        </div>
        <div className="note">
          Actions that LinkedIn does not permit are not available as steps. Loop protection and a {ws.automationDailyRunLimit}-run daily limit apply.
        </div>
        <div className="section-top">
          <div className="card-kicker">Run history</div>
          {runs.map((r) => (
            <div className="line center wrap" key={r.id} style={{ gap: 10 }}>
              <span>{r.name} · {r.steps} steps</span>
              <span className="row center">
                <span className={statusTag(r.status)}>{r.status}</span>
                {r.status === 'Awaiting approval' && <Button onClick={() => approve(r)}>Approve</Button>}
                <span className="note">{relTime(r.at, now)}</span>
              </span>
            </div>
          ))}
          {!runs.length && <div className="muted">No runs yet. Use Test run to execute this workflow once.</div>}
        </div>
      </Card>
    </div>
  );
}
