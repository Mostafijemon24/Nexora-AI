import { useMemo } from 'react';
import { Button, Card, Seg } from '../components/ui';
import { buildReport, leadsCsv, reportCsv } from '../lib/analytics';
import { toIsoDate } from '../lib/dates';
import { LEAD_STAGES, STAGE_LABEL, type PostStatus, type Range } from '../lib/types';
import { bridge } from '../platform/bridge';
import { useApp, useWs } from '../state/store';

const RANGES = [['7d', '7 days'], ['30d', '30 days'], ['90d', '90 days']] as const;
const RANGE_NAME: Record<Range, string> = { '7d': 'Last 7 days', '30d': 'Last 30 days', '90d': 'Last 90 days' };
const POST_ORDER: PostStatus[] = ['Draft', 'In review', 'Approved', 'Scheduled', 'Published'];
const pct = (v: number | null) => (v === null ? '—' : `${v}%`);
const usd = (v: number) => `$${v.toFixed(v > 0 && v < 1 ? 3 : 2)}`;

export function Reports() {
  const ws = useWs();
  const s = useApp();
  const range = s.range;
  const r = useMemo(() => buildReport(ws, range, new Date()), [ws, range]);
  const providers = ws.aiUsage.byProvider ?? [];

  const save = async (name: string, contents: string) => {
    try { s.notify(`Saved ${await bridge.saveFile(name, contents)}`); } catch (e) { s.notify(`Export failed: ${e instanceof Error ? e.message : 'unknown error'}`); }
  };
  const day = toIsoDate(new Date());
  const rates: [string, string, string][] = [
    ['Leads added', String(r.leads.total), `${r.leads.highMatch} high match`],
    ['Contacted', pct(r.leads.contactedRate), 'of leads added'],
    ['Replied', pct(r.leads.replyRate), 'of contacted leads'],
    ['Converted', pct(r.leads.conversionRate), 'of leads added'],
  ];

  return (
    <div className="stack screen">
      <div className="row wrap center" style={{ justifyContent: 'space-between', gap: 12 }}>
        <div data-tour="rep-range"><Seg name="Report period" value={range} options={RANGES} onChange={(v) => void s.setRange(v)} /></div>
        <div className="row wrap" data-tour="rep-export">
          <Button onClick={() => void save(`nexora-report-${range}-${day}.csv`, reportCsv(r, RANGE_NAME[range]))}>Export report (CSV)</Button>
          <Button disabled={!ws.leads.length} onClick={() => void save(`nexora-leads-${day}.csv`, leadsCsv(ws.leads, ws.icp, ws.campaigns))}>Export all leads (CSV)</Button>
        </div>
      </div>

      <div className="grid g170" data-tour="rep-rates">
        {rates.map(([label, value, meta]) => (
          <Card key={label} kicker={label}><span className="kpi-num">{value}</span><span className="card-meta">{meta}</span></Card>
        ))}
      </div>

      <div className="grid g300 start">
        <Card kicker={`Leads by stage · ${RANGE_NAME[range]}`}>
          {LEAD_STAGES.map((st) => (
            <div key={st}>
              <div className="between" style={{ fontSize: 13 }}><span>{STAGE_LABEL[st]}</span><span>{r.leads.byStage[st]}</span></div>
              <div className="meter"><i style={{ width: `${r.leads.total ? Math.round((r.leads.byStage[st] / r.leads.total) * 100) : 0}%` }} /></div>
            </div>
          ))}
          {!r.leads.total && <div className="hint13">No leads were added in this period.</div>}
        </Card>

        <Card kicker={`Messages · ${RANGE_NAME[range]}`} style={{ minWidth: 0, overflowX: 'auto' }}>
          <div className="line"><span>Received</span><strong>{r.messages.received}</strong></div>
          <div className="line"><span>Sent</span><strong>{r.messages.sent}</strong></div>
          {r.channels.length > 0 && (
            <table className="table">
              <thead><tr><th>Channel</th><th>Conversations</th><th>Received</th><th>Sent</th></tr></thead>
              <tbody>{r.channels.map((c) => <tr key={c.channel}><td>{c.channel}</td><td>{c.conversations}</td><td>{c.received}</td><td>{c.sent}</td></tr>)}</tbody>
            </table>
          )}
        </Card>

        <Card kicker="Posts by status">
          {POST_ORDER.map((st) => <div className="line" key={st}><span>{st}</span><strong>{r.posts[st]}</strong></div>)}
        </Card>

        <Card kicker={`Workflow runs · ${RANGE_NAME[range]}`}>
          <div className="line"><span>Runs</span><strong>{r.runs.total}</strong></div>
          <div className="line"><span>Completed</span><strong>{r.runs.completed}</strong></div>
          <div className="line"><span>Waiting (delay or approval)</span><strong>{r.runs.waiting}</strong></div>
          <div className="line"><span>Failed</span><strong>{r.runs.failed}</strong></div>
        </Card>

        <Card kicker="Tasks">
          <div className="line"><span>Open</span><strong>{r.tasks.open}</strong></div>
          <div className="line"><span>Overdue</span><strong>{r.tasks.overdue}</strong></div>
          <div className="line"><span>Done</span><strong>{r.tasks.done}</strong></div>
        </Card>

        <Card kicker="AI usage · this month" style={{ minWidth: 0, overflowX: 'auto' }} tour="rep-ai">
          <div className="line"><span>Posts generated (all time)</span><strong>{ws.aiUsage.postsGenerated}</strong></div>
          <div className="line"><span>Tokens</span><strong>{ws.aiUsage.tokensThisMonth.toLocaleString('en')}</strong></div>
          <div className="line"><span>Cost</span><strong>{usd(ws.aiUsage.costThisMonthUsd)}</strong></div>
          {providers.length > 0 && (
            <table className="table">
              <thead><tr><th>Provider</th><th>Requests</th><th>Tokens</th><th>Cost</th></tr></thead>
              <tbody>
                {providers.map((p) => (
                  <tr key={p.provider}><td>{p.provider}</td><td>{p.requests}</td><td>{p.tokens.toLocaleString('en')}</td><td>{p.priced ? usd(p.costUsd) : 'not priced'}</td></tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="note">
            {s.backend!.canConnect
              ? 'Cost is what the provider reported, or the tokens used multiplied by the price set for the model on the server. Your provider’s invoice is the final figure.'
              : 'No AI provider is connected in this build, so no tokens are used and nothing is charged.'}
          </div>
        </Card>
      </div>

      <Card kicker="Campaigns" style={{ minWidth: 0, overflowX: 'auto' }}>
        {!r.campaigns.length && <div className="hint13">No campaigns yet. Create one on the Leads page.</div>}
        {r.campaigns.length > 0 && (
          <table className="table">
            <thead><tr><th>Campaign</th><th>Status</th><th>Leads</th><th>Contacted</th><th>Replied</th><th>Converted</th><th>Reply rate</th><th>Conversion</th></tr></thead>
            <tbody>
              {r.campaigns.map((c) => (
                <tr key={c.id}><td>{c.name}</td><td>{c.status}</td><td>{c.leads}</td><td>{c.contacted}</td><td>{c.replied}</td><td>{c.converted}</td><td>{pct(c.replyRate)}</td><td>{pct(c.conversionRate)}</td></tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="note">Campaign figures count every lead in the campaign, whenever it was added. Acceptance of LinkedIn connection requests is not shown: Nexora AI does not read LinkedIn, so it cannot know it.</div>
      </Card>
    </div>
  );
}
