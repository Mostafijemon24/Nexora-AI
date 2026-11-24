import { describe, expect, it } from 'vitest';
import { createDemoBackend, workspaceMetrics } from './demo';
import type { Conversation } from '../lib/types';

const NOW = new Date(2026, 10, 24, 10, 0); // Tuesday 24 November 2026
const local = () => createDemoBackend(() => NOW, false);

describe('local backend', () => {
  it('starts with an empty workspace and nothing connected', async () => {
    const ws = await local().workspace.load();
    for (const k of ['leads', 'prompts', 'posts', 'conversations', 'savedReplies', 'workflows', 'runs', 'tasks', 'activity'] as const) {
      expect(ws[k], k).toEqual([]);
    }
    expect(ws.profile.name).toBe('');
    expect(ws.integrations.length).toBeGreaterThan(0);
    expect(ws.integrations.some((g) => g.connected)).toBe(false);
    expect(ws.providers.some((p) => p.verified)).toBe(false);
    expect(ws.sessions).toHaveLength(1);
    expect(ws.aiUsage).toEqual({ postsGenerated: 0, tokensThisMonth: 0, costThisMonthUsd: 0 });
  });

  it('reports zero metrics until there is data, then counts imported leads', async () => {
    const b = local();
    for (const range of ['7d', '30d', '90d'] as const) {
      const m = await b.workspace.metrics(range);
      expect(m.funnel).toEqual([0, 0, 0, 0]);
      expect(m.bars.every((x) => x.value === 0)).toBe(true);
    }
    const r = await b.leads.importCsv('name,company\nAda,Engines Ltd\nGrace,Compilers Inc\n,missing name');
    expect(r).toMatchObject({ imported: 2, skipped: 1 });
    expect((await b.workspace.metrics('7d')).funnel).toEqual([2, 0, 0, 0]);
  });

  it('answers a lead question when there are no leads', async () => {
    const a = await local().ai.chat([{ me: true, text: 'Which leads score highest?' }], 'Lead research');
    expect(a.text).toMatch(/no leads/i);
  });

  it('keeps sample data available on request', async () => {
    const ws = await createDemoBackend(() => NOW, true).workspace.load();
    expect(ws.leads.length).toBeGreaterThan(0);
  });
});

describe('workspaceMetrics', () => {
  it('counts replies received in the period they arrived', async () => {
    const ws = await local().workspace.load();
    const at = (daysAgo: number) => new Date(2026, 10, 24 - daysAgo, 9, 0).toISOString();
    const conv: Conversation = {
      id: 'c', name: 'Ada', company: 'Engines Ltd', channel: 'Email', unread: true, important: false, intent: '', sentiment: '', suggestion: '', notes: [],
      msgs: [{ me: false, text: 'today', at: at(0) }, { me: true, text: 'mine', at: at(0) }, { me: false, text: 'last week', at: at(8) }, { me: false, text: 'in October', at: at(40) }],
    };
    const withReplies = { ...ws, conversations: [conv] };
    const week = workspaceMetrics(withReplies, '7d', NOW);
    expect(week.bars.map((b) => b.value)).toEqual([0, 0, 0, 0, 0, 0, 1]);
    expect(week.bars.map((b) => b.label).join('')).toBe('WTFSSMT');
    expect(workspaceMetrics(withReplies, '30d', NOW).bars.map((b) => b.value)).toEqual([0, 0, 1, 1]);
    const quarter = workspaceMetrics(withReplies, '90d', NOW);
    expect(quarter.bars.map((b) => b.label)).toEqual(['Sep', 'Oct', 'Nov']);
    expect(quarter.bars.map((b) => b.value)).toEqual([0, 1, 2]);
  });
});
