// Provider adapters. Each one turns the gateway's neutral request into that provider's API call
// with the workspace's own key (BYOK). Keys are passed in per call and never logged.

import Anthropic from '@anthropic-ai/sdk';
import type { OpenRouterModel, ProviderName } from '../../../src/lib/types.ts';

export interface ChatMessage { role: 'user' | 'assistant'; content: string }
export interface Completion { text: string; model: string; inputTokens: number; outputTokens: number; costUsd: number | null }
export interface CompleteInput { apiKey: string; model: string; system: string; messages: ChatMessage[]; maxTokens: number }

export type ProviderErrorCode = 'invalid_key' | 'rate_limited' | 'no_credits' | 'model_unavailable' | 'outage' | 'refused' | 'bad_request';

export class ProviderError extends Error {
  code: ProviderErrorCode;
  provider: ProviderName;
  constructor(provider: ProviderName, code: ProviderErrorCode, message: string) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.code = code;
  }
}

const MESSAGES: Record<ProviderErrorCode, string> = {
  invalid_key: 'rejected the API key. Check the key in Settings.',
  rate_limited: 'is rate-limiting requests. Try again shortly.',
  no_credits: 'reports insufficient credits on this key.',
  model_unavailable: 'says the selected model is not available.',
  outage: 'is not responding right now.',
  refused: 'declined this request.',
  bad_request: 'rejected the request.',
};
export const providerError = (p: ProviderName, code: ProviderErrorCode) => new ProviderError(p, code, `${p} ${MESSAGES[code]}`);

function codeForStatus(status: number): ProviderErrorCode {
  if (status === 401 || status === 403) return 'invalid_key';
  if (status === 402) return 'no_credits';
  if (status === 404) return 'model_unavailable';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'outage';
  return 'bad_request';
}

export interface Provider {
  name: ProviderName;
  /** True when the provider accepts the key. Network failures throw instead of returning false. */
  verify(apiKey: string): Promise<boolean>;
  complete(input: CompleteInput): Promise<Completion>;
}

type Fetch = typeof fetch;

async function call(f: Fetch, provider: ProviderName, url: string, init: RequestInit): Promise<any> {
  let res: Response;
  try {
    res = await f(url, { ...init, signal: AbortSignal.timeout(60_000) });
  } catch {
    throw providerError(provider, 'outage');
  }
  if (!res.ok) throw providerError(provider, codeForStatus(res.status));
  return res.json();
}

async function accepts(f: Fetch, provider: ProviderName, url: string, headers: Record<string, string>): Promise<boolean> {
  try {
    await call(f, provider, url, { headers });
    return true;
  } catch (e) {
    if (e instanceof ProviderError && e.code === 'invalid_key') return false;
    throw e;
  }
}

/** OpenAI-style chat completions, shared by OpenAI and OpenRouter. */
function chatCompletions(f: Fetch, name: ProviderName, base: string, extraBody: object = {}) {
  return async ({ apiKey, model, system, messages, maxTokens }: CompleteInput): Promise<Completion> => {
    const j = await call(f, name, `${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, max_completion_tokens: maxTokens, messages: [{ role: 'system', content: system }, ...messages], ...extraBody }),
    });
    // OpenRouter can report a provider failure inside a 200 response.
    if (j.error) throw providerError(name, codeForStatus(Number(j.error.code) || 500));
    const text = j.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw providerError(name, 'outage');
    return {
      text, model: j.model ?? model,
      inputTokens: j.usage?.prompt_tokens ?? 0, outputTokens: j.usage?.completion_tokens ?? 0,
      costUsd: typeof j.usage?.cost === 'number' ? j.usage.cost : null,
    };
  };
}

export function openai(f: Fetch): Provider {
  const base = 'https://api.openai.com/v1';
  return {
    name: 'OpenAI',
    verify: (k) => accepts(f, 'OpenAI', `${base}/models`, { Authorization: `Bearer ${k}` }),
    complete: chatCompletions(f, 'OpenAI', base),
  };
}

const OPENROUTER = 'https://openrouter.ai/api/v1';

export function openrouter(f: Fetch): Provider {
  return {
    name: 'OpenRouter',
    verify: (k) => accepts(f, 'OpenRouter', `${OPENROUTER}/key`, { Authorization: `Bearer ${k}` }),
    // `usage.include` asks OpenRouter to report the real cost of the call.
    complete: chatCompletions(f, 'OpenRouter', OPENROUTER, { usage: { include: true } }),
  };
}

const perMillion = (perToken: unknown) => {
  const n = Number(perToken) * 1_000_000;
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : '—';
};
const ctxLabel = (n: unknown) => {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '—';
  return v >= 1_000_000 ? `${+(v / 1_000_000).toFixed(1)}M` : `${Math.round(v / 1000)}k`;
};

/** The live OpenRouter catalogue. Nothing is cached as "free": price and availability are read on every call. */
export async function openRouterModels(f: Fetch, apiKey: string): Promise<OpenRouterModel[]> {
  const j = await call(f, 'OpenRouter', `${OPENROUTER}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
  const list: any[] = Array.isArray(j.data) ? j.data : [];
  return list.map((m) => {
    const free = Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0;
    return {
      id: String(m.id), name: String(m.name ?? m.id), context: ctxLabel(m.context_length), free,
      price: free ? undefined : `${perMillion(m.pricing?.prompt)} in · ${perMillion(m.pricing?.completion)} out`,
      available: true,
    };
  });
}

export function gemini(f: Fetch): Provider {
  const base = 'https://generativelanguage.googleapis.com/v1beta';
  return {
    name: 'Google Gemini',
    verify: (k) => accepts(f, 'Google Gemini', `${base}/models?pageSize=1`, { 'x-goog-api-key': k }),
    async complete({ apiKey, model, system, messages, maxTokens }) {
      const j = await call(f, 'Google Gemini', `${base}/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
          generationConfig: { maxOutputTokens: maxTokens },
        }),
      });
      const parts: any[] = j.candidates?.[0]?.content?.parts ?? [];
      const text = parts.map((p) => p.text ?? '').join('');
      if (!text.trim()) throw providerError('Google Gemini', j.promptFeedback?.blockReason ? 'refused' : 'outage');
      return { text, model, inputTokens: j.usageMetadata?.promptTokenCount ?? 0, outputTokens: j.usageMetadata?.candidatesTokenCount ?? 0, costUsd: null };
    },
  };
}

/** Models that accept the server-side refusal fallback. */
const SUPPORTS_FALLBACKS = /^claude-(fable|mythos|opus-5|sonnet-5-5)/;

export function anthropic(f: Fetch): Provider {
  const name = 'Anthropic Claude' as const;
  const client = (apiKey: string) => new Anthropic({ apiKey, fetch: f, maxRetries: 1 });
  const wrap = (e: unknown): never => {
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw providerError(name, 'invalid_key');
    if (e instanceof Anthropic.NotFoundError) throw providerError(name, 'model_unavailable');
    if (e instanceof Anthropic.RateLimitError) throw providerError(name, 'rate_limited');
    if (e instanceof Anthropic.BadRequestError) throw providerError(name, 'bad_request');
    if (e instanceof Anthropic.APIConnectionError) throw providerError(name, 'outage');
    if (e instanceof Anthropic.APIError) throw providerError(name, (e.status ?? 500) >= 500 ? 'outage' : 'bad_request');
    throw e;
  };
  return {
    name,
    async verify(k) {
      try {
        await client(k).models.list({ limit: 1 });
        return true;
      } catch (e) {
        if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return false;
        return wrap(e);
      }
    },
    async complete({ apiKey, model, system, messages, maxTokens }) {
      try {
        const res = await client(apiKey).beta.messages.create({
          model, max_tokens: maxTokens, system, messages,
          output_config: { effort: 'low' }, // short drafting tasks; thinking stays adaptive
          // If a safety classifier declines, let the API re-run the request on its default fallback model.
          ...(SUPPORTS_FALLBACKS.test(model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
        });
        if (res.stop_reason === 'refusal') throw providerError(name, 'refused');
        const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
        if (!text.trim()) throw providerError(name, 'outage');
        return { text, model: res.model, inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens, costUsd: null };
      } catch (e) {
        if (e instanceof ProviderError) throw e;
        return wrap(e);
      }
    },
  };
}

export function allProviders(f: Fetch): Record<ProviderName, Provider> {
  return { OpenAI: openai(f), 'Google Gemini': gemini(f), 'Anthropic Claude': anthropic(f), OpenRouter: openrouter(f) };
}
