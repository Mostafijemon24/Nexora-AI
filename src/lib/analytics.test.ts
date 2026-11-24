import { describe, expect, it } from 'vitest';
import { buildReport, funnel, leadsCsv, reportCsv } from './analytics';
import { leadsFromCsv, parseCsv, toCsv } from './csv';
import { newLead, type Conversation, type Lead } from './types';

const NOW = new Date('2026-11-24T10:00:00Z');
const at = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString();
const lead = (id: string, rest: Partial<Lead> = {}) => newLead(id, `Lead ${id}`, 'Acme', at(1), rest);
const conv = (id: string, leadId: string | null, msgs: [boolean, number][], rest: Partial<Conversation> = {}): Conversation => ({
  id, name: `Lead ${leadId}`, company: 'Acme', channel: 'Email', leadId, unread: false, important: false, intent: '', sentiment: '', suggestion: '', notes: [],
  msgs: msgs.map(([me, d]) => ({ me, text: 'x', at: at(d) })), ...rest,
});
const icp = { industry: '', title: '', sizeMin: '', sizeMax: '', location: '' };

describe('funnel', () => {
  it('counts each lead in every step up to the one it reached; a lost lead only entered', () => {
    expect(funnel([{ stage: 'new' }, { stage: 'contacted' }, { stage: 'interested' }, { stage: 'converted' }, { stage: 'lost' }])).toEqual([5, 3, 2, 1]);
    expect(funnel([])).toEqual([0, 0, 0, 0]);
  });
});

describe('report', () => {
  const leads = [
    lead('1', { stage: 'contacted', campaignId: 'c1' }), lead('2', { stage: 'converted', campaignId: 'c1' }), lead('3', { campaignId: 'c1' }),
    lead('4', { stage: 'lost' }), lead('old', { stage: 'converted', createdAt: at(60) }),
  ];
  const ws = {
    leads, icp,
    campaigns: [{ id: 'c1', name: 'Q4', goal: '', channel: 'Email', status: 'Active' as const, startDate: null, endDate: null }, { id: 'c2', name: 'Empty', goal: '', channel: '', status: 'Draft' as const, startDate: null, endDate: null }],
    conversations: [conv('a', '2', [[true, 2], [false, 1]]), conv('b', '3', [[false, 1]]), conv('c', '1', [[true, 1]]), conv('d', null, [[false, 20]], { channel: 'WhatsApp', name: 'Stranger' })],
    posts: [{ id: 'p', title: 't', body: '', status: 'Draft' as const, date: null }],
    runs: [{ id: 'r', workflowId: 'w', name: 'W', steps: 2, status: 'Failed' as const, at: at(1) }, { id: 'r2', workflowId: 'w', name: 'W', steps: 2, status: 'Completed' as const, at: at(40) }],
    tasks: [{ id: 't', text: 'x', due: '', dueDate: '2026-11-01', done: false }, { id: 'u', text: 'y', due: 'Tue', done: true }],
  };

  it('computes rates from the leads added in the period', () => {
    const r = buildReport(ws, '7d', NOW);
    expect(r.leads.total).toBe(4);
    expect(r.leads.byStage).toEqual({ new: 1, contacted: 1, interested: 0, converted: 1, lost: 1 });
    // Lead 3 is still "new" but replied, so it counts as contacted: 3 of 4 contacted, 2 of those replied.
    expect([r.leads.contactedRate, r.leads.replyRate, r.leads.conversionRate]).toEqual([75, 67, 25]);
    expect(r.messages).toEqual({ received: 2, sent: 2 });
    expect(r.runs).toEqual({ total: 1, completed: 0, waiting: 0, failed: 1 });
    expect(r.tasks).toEqual({ open: 1, done: 1, overdue: 1 });
    expect(buildReport(ws, '90d', NOW).leads.total).toBe(5);
  });

  it('shows a dash-worthy null instead of dividing by zero', () => {
    const r = buildReport({ ...ws, leads: [], conversations: [] }, '7d', NOW);
    expect([r.leads.contactedRate, r.leads.replyRate, r.leads.conversionRate]).toEqual([null, null, null]);
    expect(r.campaigns.map((c) => [c.name, c.leads, c.replyRate])).toEqual([['Q4', 0, null], ['Empty', 0, null]]);
  });

  it('reports each campaign over all its leads', () => {
    const q4 = buildReport(ws, '7d', NOW).campaigns[0];
    expect(q4).toMatchObject({ leads: 3, contacted: 3, replied: 2, converted: 1, replyRate: 67, conversionRate: 33 });
  });

  it('exports CSV that reads back, and keeps formulas as text', () => {
    const rows = parseCsv(reportCsv(buildReport(ws, '7d', NOW), 'Last 7 days'));
    expect(rows[0]).toEqual(['section', 'measure', 'value']);
    expect(rows).toContainEqual(['Leads', 'Reply rate', '67%']);
    const csv = leadsCsv([lead('x', { name: '=HYPERLINK("http://evil","click")', tags: ['a', 'b'], email: 'x@example.com', campaignId: 'c1' })], icp, ws.campaigns);
    const [header, row] = parseCsv(csv);
    expect(row[header.indexOf('name')]).toBe('\'=HYPERLINK("http://evil","click")');
    expect(row[header.indexOf('tags')]).toBe('a; b');
    expect(row[header.indexOf('campaign')]).toBe('Q4');
    expect(toCsv([['a,b', 'line\nbreak', null, 5]])).toBe('"a,b","line\nbreak",,5\r\n');
  });
});

describe('lead import', () => {
  it('reads optional columns, cleans tags and ignores unknown stages', () => {
    let n = 0;
    const r = leadsFromCsv('﻿Name,Company,Email,Tags,Stage,Size\n"Okafor, Ada",Lumen,ada@lumen.example,"vip; VIP ;  agency",Interested,40\nBen,Kite,,,royal,many\n,NoName\n', at(0), () => `id${++n}`);
    expect(r.skipped).toBe(1);
    expect(r.leads).toMatchObject([
      { id: 'id1', name: 'Okafor, Ada', email: 'ada@lumen.example', tags: ['vip', 'agency'], stage: 'interested', size: 40, title: null },
      { id: 'id2', name: 'Ben', email: null, tags: [], stage: 'new', size: null },
    ]);
    expect(() => leadsFromCsv('email\nx@y.z', at(0), () => 'x')).toThrow(/"name" and "company"/);
    expect(() => leadsFromCsv('', at(0), () => 'x')).toThrow('The file is empty.');
  });
});
