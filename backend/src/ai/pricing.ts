// What a request cost, when the provider does not report it. Prices are US dollars per million
// tokens (input, output) for the model that answered. OpenRouter reports its own cost and does not
// use this table.
//
// Providers change prices, so the table can be extended or corrected without a release: set
// AI_PRICES to JSON such as {"gemini-2.0-flash": [0.10, 0.40]}. A model with no price here is
// recorded without a cost and shown as "not priced" rather than guessed.

import type { Config } from '../config.ts';

type Price = [input: number, output: number];

/** Checked against the providers' published prices in November 2026. */
const BUILT_IN: Record<string, Price> = {
  'gpt-4o-mini': [0.15, 0.6],
  'claude-fable-5-2': [8, 40],
  'claude-opus-5-5': [4, 20],
  'claude-opus-5': [5, 25],
  'claude-opus-4-8': [5, 25],
  'claude-sonnet-5-5': [2, 10],
  'claude-sonnet-5': [2, 10],
  'claude-haiku-5-5': [0.1, 0.5],
  'claude-haiku-4-5': [1, 5],
};

const cache = new WeakMap<Config, Record<string, Price>>();

function table(config: Config): Record<string, Price> {
  let t = cache.get(config);
  if (t) return t;
  t = { ...BUILT_IN };
  try {
    const extra = JSON.parse(config.env.AI_PRICES || '{}') as Record<string, unknown>;
    for (const [model, p] of Object.entries(extra)) {
      if (Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number' && n >= 0 && Number.isFinite(n))) t[model] = p as Price;
    }
  } catch {
    console.warn('[nexora] AI_PRICES is not valid JSON and was ignored.');
  }
  cache.set(config, t);
  return t;
}

/** The price of a model: its exact id, or the longest listed id it starts with (providers add a date to the id). */
export function priceFor(config: Config, model: string): Price | null {
  const t = table(config);
  if (t[model]) return t[model];
  const base = Object.keys(t).filter((k) => model.startsWith(`${k}-`) || model.startsWith(`${k}@`)).sort((a, b) => b.length - a.length)[0];
  return base ? t[base] : null;
}

export function costUsd(config: Config, model: string, inputTokens: number, outputTokens: number): number | null {
  const p = priceFor(config, model);
  return p ? (inputTokens * p[0] + outputTokens * p[1]) / 1_000_000 : null;
}
