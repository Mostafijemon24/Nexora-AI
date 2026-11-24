import { Card, CardButton, Seg, Button } from '../components/ui';
import { funnel, inRange } from '../lib/analytics';
import { dueLabel, greeting, longDate, relTime, toIsoDate } from '../lib/dates';
import type { Range } from '../lib/types';
import { change, firstName, useApp, useWs, type WidgetId } from '../state/store';

const RANGES = [['7d', '7 days'], ['30d', '30 days'], ['90d', '90 days']] as const;
const RANGE_NAME: Record<Range, string> = { '7d': 'Last 7 days', '30d': 'Last 30 days', '90d': 'Last 90 days' };
const WIDGETS: [WidgetId, string][] = [
  ['kpi', 'KPI cards'], ['perf', 'Replies chart'], ['funnel', 'Lead funnel'], ['tasks', 'Tasks'],
  ['ai', 'AI activity'], ['activity', 'Recent activity'], ['health', 'System health'],
];
const FUNNEL = ['New', 'Contacted', 'Interested', 'Converted'];

export function Dashboard({ customizing, setCustomizing }: { customizing: boolean; setCustomizing: (v: boolean) => void }) {
  const ws = useWs();
  const s = useApp();
  const w = s.widgets;
  const m = s.metrics[s.range];
  const now = new Date();
  const off = s.isOffline();

  // Counted here, from the leads on screen, so a stage change shows at once.
  const stages = funnel(ws.leads.filter((l) => inRange(l.createdAt, s.range, now)));
  const today = toIsoDate(now);
  const unread = ws.conversations.filter((c) => c.unread).length;
  const kpis = [
    { label: 'New leads', value: stages[0], meta: 'Open leads', go: () => s.go('leads', { leadsTab: 'list' }) },
    { label: 'Unread conversations', value: unread, meta: 'Open inbox', go: () => s.go('inbox') },
    { label: 'Scheduled posts', value: ws.posts.filter((p) => p.status === 'Scheduled').length, meta: 'Open calendar', go: () => s.go('content', { csTab: 'cal' }) },
    { label: 'Active workflows', value: ws.workflows.filter((f) => f.on).length, meta: 'Open automation', go: () => s.go('automation') },
  ];
  const max = m ? Math.max(1, ...m.bars.map((b) => b.value)) : 1;
  const health = [
    ['API', off ? 'Unreachable' : 'Operational'],
    ['Background workers', off ? 'Paused' : 'Running'],
    ['Sync', s.pending ? `${s.pending} pending` : 'Up to date'],
  ];
  const awaiting = ws.posts.filter((p) => p.status === 'In review').length + ws.runs.filter((r) => r.status === 'Awaiting approval').length;
  const aiStats: [string, number][] = [['Posts generated', ws.aiUsage.postsGenerated], ['Assistant messages', s.chat.filter((x) => x.me).length], ['Drafts awaiting approval', awaiting]];

  const toggleTask = (id: string) => {
    const t = ws.tasks.find((x) => x.id === id)!;
    const next = { ...t, done: !t.done };
    s.update((x) => ({ tasks: x.tasks.map((y) => (y.id === id ? next : y)) }));
    s.save(change('task', id, next));
  };
  const name = firstName(ws.profile.name);
  const noData = <div className="hint13">{off ? 'Not available offline.' : 'Loading…'}</div>;

  return (
    <div className="stack screen">
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end', justifyContent: 'space-between' }}>
        <div>
          <h2 style={{ margin: 0 }}>{greeting(now)}{name && `, ${name}`}</h2>
          <div className="hint13">{longDate(now)} · {RANGE_NAME[s.range]}</div>
        </div>
        <div className="row wrap center" data-tour="dash-range">
          <Seg name="Date range" value={s.range} options={RANGES} onChange={(r) => void s.setRange(r)} />
          <Button onClick={() => setCustomizing(!customizing)}>{customizing ? 'Done' : 'Customize'}</Button>
        </div>
      </div>

      {customizing && (
        <Card kicker="Widgets">
          <div className="row wrap">
            {WIDGETS.map(([id, label]) => (
              <Button key={id} aria-pressed={w[id]} onClick={() => s.toggleWidget(id)} style={{ background: w[id] ? 'var(--tint)' : 'transparent' }}>
                {w[id] ? '✓' : '+'} {label}
              </Button>
            ))}
          </div>
        </Card>
      )}

      {w.kpi && (
        <div className="grid g170" data-tour="dash-kpi">
          {kpis.map((k) => (
            <CardButton key={k.label} onClick={k.go}>
              <span className="card-kicker">{k.label}</span>
              <span className="kpi-num">{k.value}</span>
              <span className="card-meta">{k.meta} →</span>
            </CardButton>
          ))}
        </div>
      )}

      <div className="grid g300">
        {w.perf && (
          <Card kicker="Replies received" tour="dash-perf">
            {m ? (
              <div className="bars">
                {m.bars.map((b, i) => (
                  <div className="bar" key={i} title={String(b.value)}>
                    <span>{b.value}</span>
                    <i style={{ height: `${Math.round((b.value / max) * 100)}%` }} />
                    <span>{b.label}</span>
                  </div>
                ))}
              </div>
            ) : noData}
          </Card>
        )}
        {w.funnel && (
          <Card kicker="Lead funnel">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 6 }}>
              {FUNNEL.map((label, i) => (
                <div key={label}>
                  <div className="between" style={{ fontSize: 13 }}><span>{label}</span><span>{stages[i]}</span></div>
                  <div className="meter"><i style={{ width: `${stages[0] ? Math.round((stages[i] / stages[0]) * 100) : 0}%` }} /></div>
                </div>
              ))}
            </div>
          </Card>
        )}
        {w.tasks && (
          <Card kicker="Upcoming tasks" tour="dash-tasks">
            {ws.tasks.map((t) => (
              <label key={t.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '6px 0', borderBottom: '1px solid var(--line2)', cursor: 'pointer' }}>
                <input type="checkbox" checked={t.done} onChange={() => toggleTask(t.id)} style={{ accentColor: 'var(--color-accent)', marginTop: 3 }} />
                <span style={{ flex: 1, textDecoration: t.done ? 'line-through' : 'none', opacity: t.done ? 0.5 : 1 }}>{t.text}</span>
                <span className="note" style={{ whiteSpace: 'nowrap', color: !t.done && t.dueDate && t.dueDate < today ? 'var(--color-error, #b3261e)' : undefined }}>{dueLabel(t, now)}</span>
              </label>
            ))}
            {!ws.tasks.length && <div className="hint13">No tasks. Create a follow-up from a lead or a conversation, or let a workflow create them.</div>}
          </Card>
        )}
        {w.ai && (
          <Card kicker="AI activity">
            {aiStats.map(([l, v]) => <div className="line" key={l}><span>{l}</span><strong>{v}</strong></div>)}
          </Card>
        )}
        {w.activity && (
          <Card kicker="Recent activity">
            {ws.activity.map((a, i) => (
              <div className="line" key={i}><span>{a.text}</span><span className="note" style={{ whiteSpace: 'nowrap' }}>{relTime(a.at, now)}</span></div>
            ))}
            {!ws.activity.length && <div className="hint13">Nothing yet. Changes you make appear here.</div>}
          </Card>
        )}
        {w.health && (
          <Card kicker="System health">
            {health.map(([l, v]) => (
              <div className="line center" key={l}><span>{l}</span><span className={`tag ${/Oper|Run|Up/.test(v) ? 'tag-accent' : 'tag-outline'}`}>{v}</span></div>
            ))}
          </Card>
        )}
      </div>
    </div>
  );
}
