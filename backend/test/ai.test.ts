import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDemo } from '../src/seed.ts';
import { change, Device, harness, type Harness } from './helpers.ts';

// Provider HTTP is scripted here so the gateway's own behaviour can be tested without real keys.
// The adapters' request shapes are asserted; they have not been run against the live services.

let h: Harness;
let d: Device;
let ws: string;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const chatOk = (text: string, extra: object = {}) => json({ model: 'm', choices: [{ message: { content: text } }], usage: { prompt_tokens: 100, completion_tokens: 20, ...extra } });
const bodyOf = (i: number) => JSON.parse(String(h.calls[i].init?.body));

beforeAll(async () => {
  h = await harness();
  const lic = await h.license();
  ws = lic.workspaceId;
  await seedDemo(h.ctx.db, ws, h.ctx.now());
  d = new Device(h, 'native', 'PC');
  await d.activate(lic.key);
});
afterAll(async () => { await h.close(); });
beforeEach(() => { h.calls.length = 0; h.advance(120_000); });

const route = (task: string, provider: string) => d.post('/v1/workspace/changes', change('routing', 'routing', {
  'Content generation': 'OpenAI', 'Lead research': 'OpenAI', 'Reply suggestions': 'OpenAI', [task]: provider }));
const usage = async () => (await h.ctx.db.query('SELECT kind, provider, model, input_tokens, output_tokens, cost_usd FROM usage_records WHERE workspace_id = $1 ORDER BY created_at', [ws])).rows;

describe('provider keys', () => {
  it('refuses AI calls until the routed provider has a verified key', async () => {
    await route('Reply suggestions', 'OpenAI');
    const r = await d.post('/v1/ai/chat', { history: [{ me: true, text: 'hi' }], task: 'Reply suggestions' });
    expect([r.status, r.body.code]).toEqual([400, 'ai_no_key']);
    expect(h.calls).toHaveLength(0);
  });

  it('stores a key encrypted, verifies it with the provider and never returns it', async () => {
    h.respond = (_url, init) => (new Headers(init?.headers).get('authorization') === 'Bearer sk-good' ? json({ data: [] }) : json({}, 401));
    expect((await d.post('/v1/ai/providers/verify', { name: 'OpenAI', key: 'sk-bad' })).body).toEqual({ verified: false });
    expect((await d.post('/v1/ai/providers/verify', { name: 'OpenAI', key: 'sk-good' })).body).toEqual({ verified: true });
    expect(h.calls.at(-1)!.url).toBe('https://api.openai.com/v1/models');
    const row = (await h.ctx.db.query("SELECT secret_enc FROM provider_credentials WHERE workspace_id = $1 AND provider = 'OpenAI'", [ws])).rows[0];
    expect(row.secret_enc).toMatch(/^v1\./);
    expect(row.secret_enc).not.toContain('sk-good');
    const snap = (await d.get('/v1/workspace')).body;
    expect(snap.providers.find((p: any) => p.name === 'OpenAI')).toEqual({ name: 'OpenAI', verified: true });
    expect(snap.integrations.find((g: any) => g.id === 'oa').connected).toBe(true);
    expect(JSON.stringify(snap)).not.toContain('sk-good');
    // An empty key re-checks the stored one.
    expect((await d.post('/v1/ai/providers/verify', { name: 'OpenAI', key: '' })).body).toEqual({ verified: true });
    expect((await d.post('/v1/ai/providers/verify', { name: 'Nope', key: 'x' })).status).toBe(400);
  });

  it('reports a provider outage as an error instead of marking the key bad', async () => {
    h.respond = () => json({}, 503);
    const r = await d.post('/v1/ai/providers/verify', { name: 'OpenAI', key: '' });
    expect([r.status, r.body.code]).toEqual([502, 'ai_outage']);
    expect((await d.get('/v1/workspace')).body.providers[0].verified).toBe(true);
  });
});

describe('chat and drafting', () => {
  it('sends workspace context to the routed provider and records usage', async () => {
    h.respond = () => chatOk('John Smith scores highest.');
    const r = await d.post('/v1/ai/chat', { history: [{ me: false, text: 'Hi Rafiq.' }, { me: true, text: 'Which lead scores best?' }], task: 'Reply suggestions' });
    expect(r.body).toEqual({ text: 'John Smith scores highest.' });
    expect(h.calls[0].url).toBe('https://api.openai.com/v1/chat/completions');
    const body = bodyOf(0);
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.messages.map((m: any) => m.role)).toEqual(['system', 'user']); // leading assistant greeting dropped
    expect(body.messages[0].content).toContain('never guess');
    expect(body.messages[0].content).toContain('"name":"John Smith"');
    expect(body.messages[0].content).toContain('"companySize":null'); // unknown data is passed as unknown
    expect((await usage()).at(-1)).toEqual({ kind: 'chat', provider: 'OpenAI', model: 'm', input_tokens: 100, output_tokens: 20, cost_usd: null });
  });

  it('drafts a lead message only for a lead in this workspace', async () => {
    h.respond = () => chatOk('Hi John — quick question?');
    const lead = (await d.get('/v1/workspace')).body.leads[0];
    expect((await d.post(`/v1/ai/leads/${lead.id}/draft`)).body.text).toBe('Hi John — quick question?');
    expect((await d.post('/v1/ai/leads/00000000-0000-4000-8000-000000000000/draft')).status).toBe(404);
  });

  it('parses a generated post, retries once on unusable output, then fails clearly', async () => {
    const post = { hook: 'H', body: 'B', cta: 'C?', tags: '#a #b' };
    let n = 0;
    h.respond = () => (++n === 1 ? chatOk('Sorry, here you go') : chatOk('```json\n' + JSON.stringify(post) + '\n```'));
    const r = await d.post('/v1/ai/posts/generate', { topic: 'cold outreach', audience: 'founders', tone: 'Data', variant: 0 });
    expect(r.body).toEqual(post);
    expect(n).toBe(2);
    expect((await d.get('/v1/workspace')).body.aiUsage.postsGenerated).toBe(2);
    h.respond = () => chatOk('no json at all');
    const bad = await d.post('/v1/ai/posts/generate', { topic: 't', audience: '', tone: 'Direct', variant: 1 });
    expect([bad.status, bad.body.code]).toEqual([502, 'ai_bad_output']);
    expect((await d.post('/v1/ai/posts/generate', { topic: ' ', audience: '', tone: 'Direct', variant: 0 })).body.message).toBe('Enter a topic to generate a post.');
  });

  it('maps provider failures to clear errors', async () => {
    for (const [status, code] of [[429, 'ai_rate_limited'], [402, 'ai_no_credits'], [500, 'ai_outage'], [401, 'ai_invalid_key']] as const) {
      h.respond = () => json({}, status);
      const r = await d.post('/v1/ai/chat', { history: [{ me: true, text: 'q' }] });
      expect(r.body.code).toBe(code);
    }
  });

  it('calls Gemini and Claude with their own request shapes', async () => {
    h.respond = (url) => (url.includes('generativelanguage') && !url.includes(':generateContent') ? json({ models: [] }) : json({ data: [] }));
    await d.post('/v1/ai/providers/verify', { name: 'Google Gemini', key: 'g-key' });
    await d.post('/v1/ai/providers/verify', { name: 'Anthropic Claude', key: 'a-key' });

    await route('Reply suggestions', 'Google Gemini');
    h.calls.length = 0;
    h.respond = () => json({ candidates: [{ content: { parts: [{ text: 'from gemini' }] } }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 } });
    expect((await d.post('/v1/ai/chat', { history: [{ me: true, text: 'q' }] })).body.text).toBe('from gemini');
    expect(h.calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent');
    expect(new Headers(h.calls[0].init?.headers).get('x-goog-api-key')).toBe('g-key');
    expect(bodyOf(0).contents).toEqual([{ role: 'user', parts: [{ text: 'q' }] }]);

    await route('Reply suggestions', 'Anthropic Claude');
    h.calls.length = 0;
    h.respond = () => json({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'from claude' }], usage: { input_tokens: 11, output_tokens: 5 } });
    expect((await d.post('/v1/ai/chat', { history: [{ me: true, text: 'q' }] })).body.text).toBe('from claude');
    expect(h.calls[0].url.split('?')[0]).toBe('https://api.anthropic.com/v1/messages');
    const hd = new Headers(h.calls[0].init?.headers);
    expect(hd.get('authorization')).toBe('Bearer a-key'); // the SDK chooses the auth header
    expect(hd.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(bodyOf(0)).toMatchObject({ model: 'claude-opus-5-5', fallbacks: 'default', messages: [{ role: 'user', content: 'q' }] });
    expect(bodyOf(0).temperature).toBeUndefined();

    h.respond = () => json({ id: 'msg_2', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'refusal', content: [], usage: { input_tokens: 1, output_tokens: 0 } });
    expect((await d.post('/v1/ai/chat', { history: [{ me: true, text: 'q' }] })).body.code).toBe('ai_refused');
  });
});

describe('OpenRouter', () => {
  const setOr = (o: object) => d.post('/v1/workspace/changes', change('openrouter', 'openrouter', { defaultModel: 'openai/gpt-4o-mini', fallbackModel: '', monthlyBudgetUsd: '20', ...o }));

  it('lists live models with price, context and free/paid, only after the key verifies', async () => {
    expect((await d.get('/v1/ai/openrouter/models')).status).toBe(400);
    h.respond = (url) => (url.endsWith('/key') ? json({ data: {} }) : json({ data: [
      { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B Instruct', context_length: 131072, pricing: { prompt: '0', completion: '0' } },
      { id: 'openai/gpt-4o-mini', name: 'GPT-4o mini', context_length: 128000, pricing: { prompt: '0.00000015', completion: '0.0000006' } },
    ] }));
    expect((await d.post('/v1/ai/providers/verify', { name: 'OpenRouter', key: 'or-key' })).body.verified).toBe(true);
    expect((await d.get('/v1/ai/openrouter/models')).body).toEqual([
      { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B Instruct', context: '131k', free: true, available: true },
      { id: 'openai/gpt-4o-mini', name: 'GPT-4o mini', context: '128k', free: false, price: '$0.15 in · $0.60 out', available: true },
    ]);
  });

  it('uses the chosen model and records the cost OpenRouter reports', async () => {
    await route('Reply suggestions', 'OpenRouter');
    await setOr({});
    h.calls.length = 0;
    h.respond = () => chatOk('ok', { cost: 0.0042 });
    expect((await d.post('/v1/ai/chat', { history: [{ me: true, text: 'q' }] })).body).toEqual({ text: 'ok' });
    expect(bodyOf(0)).toMatchObject({ model: 'openai/gpt-4o-mini', usage: { include: true } });
    expect((await usage()).at(-1)).toMatchObject({ provider: 'OpenRouter', cost_usd: 0.0042 });
    expect((await d.get('/v1/workspace')).body.aiUsage.costThisMonthUsd).toBeCloseTo(0.0042);
  });

  it('shows the error when the default fails and no fallback is set', async () => {
    h.respond = () => json({}, 429);
    const r = await d.post('/v1/ai/chat', { history: [{ me: true, text: 'q' }] });
    expect([r.status, r.body.code]).toEqual([502, 'ai_rate_limited']);
    expect(h.calls).toHaveLength(1);
  });

  it('falls back only when configured, says so, and leaves the default unchanged', async () => {
    await setOr({ fallbackModel: 'mistralai/mistral-small' });
    h.calls.length = 0;
    h.respond = (_u, init) => (JSON.parse(String(init?.body)).model === 'openai/gpt-4o-mini' ? json({}, 503) : chatOk('from fallback'));
    const r = await d.post('/v1/ai/chat', { history: [{ me: true, text: 'q' }] });
    expect(r.body.text).toBe('from fallback');
    expect(r.body.notice).toBe('openai/gpt-4o-mini was unavailable (outage), so mistralai/mistral-small answered. Your default model is unchanged.');
    expect((await d.get('/v1/workspace')).body.openRouter.defaultModel).toBe('openai/gpt-4o-mini');
    // A rejected key is not something a fallback should paper over.
    h.calls.length = 0;
    h.respond = () => json({}, 401);
    expect((await d.post('/v1/ai/chat', { history: [{ me: true, text: 'q' }] })).body.code).toBe('ai_invalid_key');
    expect(h.calls).toHaveLength(1);
  });

  it('stops at the monthly spend limit', async () => {
    await setOr({ monthlyBudgetUsd: '0.004' });
    h.calls.length = 0;
    const r = await d.post('/v1/ai/chat', { history: [{ me: true, text: 'q' }] });
    expect([r.status, r.body.code]).toEqual([402, 'ai_budget_exceeded']);
    expect(r.body.message).toContain('$0.00'); // limit shown to the user
    expect(h.calls).toHaveLength(0);
  });
});
