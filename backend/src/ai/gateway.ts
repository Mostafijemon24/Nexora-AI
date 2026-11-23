// The central AI gateway: routes a task to the workspace's chosen provider, applies the OpenRouter
// fallback and spend limit, records usage, and keeps every provider key on the server.

import { z } from 'zod';
import { rankLeads } from '../../../src/lib/scoring.ts';
import type { AiTask, GeneratedPost, OpenRouterModel, OpenRouterSettings, ProviderName, Tone } from '../../../src/lib/types.ts';
import type { Ctx } from '../context.ts';
import { decrypt, encrypt } from '../crypto.ts';
import { badRequest, HttpError, notFound } from '../errors.ts';
import type { Auth } from '../license/service.ts';
import { loadConversations, loadLeads } from '../workspace/snapshot.ts';
import { allProviders, openRouterModels, ProviderError, type ChatMessage, type Completion } from './providers.ts';

type Kind = 'chat' | 'post' | 'draft';
/** Failures after which the user's configured fallback model may be tried. */
const FALLBACK_ON = new Set(['rate_limited', 'no_credits', 'model_unavailable', 'outage']);

const fail = (e: unknown): never => {
  if (e instanceof ProviderError) throw new HttpError(e.code === 'invalid_key' ? 400 : 502, `ai_${e.code}`, e.message);
  throw e;
};

async function storedKey(ctx: Ctx, workspaceId: string, provider: ProviderName, mustBeVerified = true): Promise<string | null> {
  const r = await ctx.db.query('SELECT secret_enc, verified FROM provider_credentials WHERE workspace_id = $1 AND provider = $2', [workspaceId, provider]);
  const row = r.rows[0];
  if (!row || (mustBeVerified && !row.verified)) return null;
  return decrypt(ctx.config.dataEncryptionKey, row.secret_enc);
}

/**
 * Stores a new key (encrypted) and checks it with the provider; an empty key re-checks the stored one.
 * Returns whether the provider accepted it. The key is never returned to any client.
 */
export async function verifyKey(ctx: Ctx, auth: Auth, provider: ProviderName, key: string): Promise<boolean> {
  const p = allProviders(ctx.fetch)[provider];
  if (!p) throw badRequest('Unknown provider.');
  const candidate = key.trim() || (await storedKey(ctx, auth.workspaceId, provider, false));
  if (!candidate) throw badRequest(`Enter a key for ${provider} first.`);
  const ok = await p.verify(candidate).catch(fail);
  await ctx.db.query(
    `INSERT INTO provider_credentials (workspace_id, provider, secret_enc, verified, verified_at) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (workspace_id, provider) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, verified = EXCLUDED.verified, verified_at = EXCLUDED.verified_at`,
    [auth.workspaceId, provider, encrypt(ctx.config.dataEncryptionKey, candidate), ok, ok ? ctx.now() : null]);
  return ok;
}

export async function removeKey(ctx: Ctx, auth: Auth, provider: ProviderName): Promise<void> {
  await ctx.db.query('DELETE FROM provider_credentials WHERE workspace_id = $1 AND provider = $2', [auth.workspaceId, provider]);
}

export async function listOpenRouterModels(ctx: Ctx, auth: Auth): Promise<OpenRouterModel[]> {
  const key = await storedKey(ctx, auth.workspaceId, 'OpenRouter');
  if (!key) throw badRequest('Add and verify your OpenRouter key first.');
  return openRouterModels(ctx.fetch, key).catch(fail);
}

async function workspaceAi(ctx: Ctx, workspaceId: string) {
  const r = await ctx.db.query('SELECT name, brand_voice, icp, routing, openrouter FROM workspaces WHERE id = $1', [workspaceId]);
  return r.rows[0] as { name: string; brand_voice: string; icp: any; routing: Record<AiTask, ProviderName>; openrouter: OpenRouterSettings };
}

interface RunResult { text: string; notice?: string }

async function run(ctx: Ctx, auth: Auth, task: AiTask, kind: Kind, system: string, messages: ChatMessage[], maxTokens: number): Promise<RunResult> {
  if (!(await ctx.limiter.allow(`ai:${auth.workspaceId}`, 60, 60))) throw new HttpError(429, 'rate_limited', 'Too many AI requests. Wait a minute and try again.');
  const ws = await workspaceAi(ctx, auth.workspaceId);
  const providerName = ws.routing[task];
  const provider = allProviders(ctx.fetch)[providerName];
  const apiKey = await storedKey(ctx, auth.workspaceId, providerName);
  if (!provider || !apiKey) throw badRequest(`${task} is routed to ${providerName}, which has no verified key. Add one in Settings → AI providers.`, 'ai_no_key');

  const record = (c: Completion) => ctx.db.query(
    'INSERT INTO usage_records (workspace_id, license_id, kind, provider, model, input_tokens, output_tokens, cost_usd, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    [auth.workspaceId, auth.licenseId, kind, providerName, c.model, c.inputTokens, c.outputTokens, c.costUsd, ctx.now()]);

  if (providerName !== 'OpenRouter') {
    const model = providerName === 'OpenAI' ? ctx.config.models.openai : providerName === 'Google Gemini' ? ctx.config.models.gemini : ctx.config.models.anthropic;
    const c = await provider.complete({ apiKey, model, system, messages, maxTokens }).catch(fail);
    await record(c);
    return { text: c.text };
  }

  // OpenRouter: user-chosen model, monthly spend limit, and an explicit fallback.
  const or = ws.openrouter;
  if (!or.defaultModel) throw badRequest('Choose a default OpenRouter model in Settings → AI providers.', 'ai_no_model');
  const budget = Number(or.monthlyBudgetUsd);
  if (Number.isFinite(budget) && budget > 0) {
    const now = ctx.now();
    const spent = (await ctx.db.query(
      "SELECT coalesce(sum(cost_usd), 0)::float AS s FROM usage_records WHERE workspace_id = $1 AND provider = 'OpenRouter' AND created_at >= $2",
      [auth.workspaceId, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))])).rows[0].s;
    if (spent >= budget) throw new HttpError(402, 'ai_budget_exceeded', `The monthly OpenRouter spend limit of $${budget.toFixed(2)} has been reached. Raise it in Settings to continue.`);
  }
  try {
    const c = await provider.complete({ apiKey, model: or.defaultModel, system, messages, maxTokens });
    await record(c);
    return { text: c.text };
  } catch (e) {
    const usable = e instanceof ProviderError && FALLBACK_ON.has(e.code) && or.fallbackModel && or.fallbackModel !== or.defaultModel;
    if (!usable) return fail(e);
    // The default failed and the user configured a fallback: use it for this call only, and say so.
    const c = await provider.complete({ apiKey, model: or.fallbackModel, system, messages, maxTokens }).catch(fail);
    await record(c);
    return { text: c.text, notice: `${or.defaultModel} was unavailable (${(e as ProviderError).code.replace('_', ' ')}), so ${or.fallbackModel} answered. Your default model is unchanged.` };
  }
}

const GROUND_RULES = 'Use only the workspace data given below. If something is not in the data, say it is missing; never guess or invent facts about a person or company. '
  + 'You draft text for the user to review: nothing you write is sent or published automatically. Be concise and plain; no hype.';

async function workspaceContext(ctx: Ctx, auth: Auth): Promise<string> {
  const ws = await workspaceAi(ctx, auth.workspaceId);
  const leads = rankLeads(await loadLeads(ctx.db, auth.workspaceId), ws.icp).slice(0, 15);
  const convs = (await loadConversations(ctx.db, auth.workspaceId)).slice(0, 15);
  return JSON.stringify({
    workspace: ws.name,
    targetCustomer: ws.icp,
    leadsRankedByMatch: leads.map((l) => ({
      name: l.name, title: l.title, company: l.company, industry: l.industry, companySize: l.size, country: l.country,
      score: l.score.total, dataConfidenceOutOf10: l.score.conf,
    })),
    conversations: convs.map((c) => ({ name: c.name, company: c.company, channel: c.channel, unread: c.unread, intent: c.intent, sentiment: c.sentiment, lastMessage: c.msgs.at(-1)?.text ?? null })),
  });
}

const History = z.array(z.object({ me: z.boolean(), text: z.string().max(8000) })).min(1).max(60);

export async function chat(ctx: Ctx, auth: Auth, rawHistory: unknown, task: AiTask): Promise<RunResult> {
  const history = History.safeParse(rawHistory);
  if (!history.success) throw badRequest('Malformed conversation.');
  // Providers expect the conversation to open with the user and to alternate.
  const turns = history.data.slice(history.data.findIndex((m) => m.me));
  if (!turns.length || !turns.at(-1)!.me) throw badRequest('Ask a question first.');
  const messages: ChatMessage[] = [];
  for (const t of turns) {
    const role = t.me ? 'user' : 'assistant';
    if (messages.at(-1)?.role === role) messages[messages.length - 1].content += `\n\n${t.text}`;
    else messages.push({ role, content: t.text });
  }
  const system = `You are the assistant inside Nexora AI, a LinkedIn growth and lead-intelligence workspace. You help with lead scores, post drafts and reply suggestions.\n${GROUND_RULES}\n\nWorkspace data (JSON):\n${await workspaceContext(ctx, auth)}`;
  return run(ctx, auth, task, 'chat', system, messages, 2000);
}

const PostInput = z.object({ topic: z.string().trim().min(1, 'Enter a topic to generate a post.').max(300), audience: z.string().max(300), tone: z.enum(['Direct', 'Story', 'Data']), variant: z.number().int().min(0).max(1000) });
const PostOutput = z.object({ hook: z.string().min(1), body: z.string().min(1), cta: z.string().min(1), tags: z.string() });

const TONES: Record<Tone, string> = {
  Direct: 'Direct: short declarative sentences, a numbered list of concrete steps.',
  Story: 'Story: a brief first-person account with a turning point.',
  Data: 'Data: lead with observations stated as bullet points; do not invent statistics — describe patterns qualitatively unless the user supplied numbers.',
};

function parseJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

export async function generatePost(ctx: Ctx, auth: Auth, raw: unknown): Promise<GeneratedPost & { notice?: string }> {
  const input = PostInput.safeParse(raw);
  if (!input.success) throw badRequest(input.error.issues[0]?.message ?? 'Invalid input.');
  const { topic, audience, tone, variant } = input.data;
  const ws = await workspaceAi(ctx, auth.workspaceId);
  const system = `You write LinkedIn posts for ${ws.name}. Brand voice: ${ws.brand_voice}.\nTone — ${TONES[tone]}\n`
    + 'Do not fabricate numbers, clients or results. The post is a draft the user will edit and approve.\n'
    + 'Reply with one JSON object and nothing else: {"hook": string (one line), "body": string (use \\n for line breaks), "cta": string (one closing question or call to action), "tags": string (2-4 hashtags separated by spaces)}.';
  const user = `Topic: ${topic}\nAudience: ${audience.trim() || 'not specified'}${variant ? `\nThis is attempt ${variant + 1}; take a different angle from an obvious first draft.` : ''}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await run(ctx, auth, 'Content generation', 'post', system, [{ role: 'user', content: user }], 2000);
    const post = PostOutput.safeParse(parseJsonObject(r.text));
    if (post.success) return { ...post.data, notice: r.notice };
  }
  throw new HttpError(502, 'ai_bad_output', 'The model did not return a usable post. Try again.');
}

export async function draftMessage(ctx: Ctx, auth: Auth, leadId: string): Promise<RunResult> {
  const lead = (await ctx.db.query('SELECT name, title, company, industry, size, country FROM leads WHERE id::text = $1 AND workspace_id = $2', [leadId, auth.workspaceId])).rows[0];
  if (!lead) throw notFound('Lead not found.');
  const ws = await workspaceAi(ctx, auth.workspaceId);
  const system = `You write first-contact messages on behalf of ${ws.name}. Brand voice: ${ws.brand_voice}.\n${GROUND_RULES}\n`
    + 'Write one message under 60 words that opens with the recipient\'s first name and ends with one easy question. Fields that are null are unknown: do not mention or guess them. Reply with the message text only.';
  return run(ctx, auth, 'Lead research', 'draft', system, [{ role: 'user', content: `Lead (JSON): ${JSON.stringify(lead)}` }], 600);
}
