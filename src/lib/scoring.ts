import type { Icp, Lead } from './types.ts';

export interface ScorePart { name: string; found: string; pts: string }
export interface LeadScore {
  /** 0–100, normalised from the 90 available points. */
  total: number;
  /** 0–10: how many of the four fields were actually available. Separate from the score. */
  conf: number;
  label: 'High match' | 'Medium match' | 'Low match';
  parts: ScorePart[];
}

const WEIGHTS = { industry: 25, title: 25, size: 20, location: 20 } as const;
const MAX = WEIGHTS.industry + WEIGHTS.title + WEIGHTS.size + WEIGHTS.location;

const has = (v: unknown): boolean => v !== null && v !== undefined && v !== '';
const lc = (v: unknown): string => String(v).toLowerCase().trim();

/** Scores a lead against the target criteria. A missing field scores nothing and is never guessed. */
export function scoreLead(lead: Lead, icp: Icp): LeadScore {
  const industry = has(lead.industry)
    ? (lc(icp.industry) && lc(lead.industry).includes(lc(icp.industry)) ? WEIGHTS.industry : 0)
    : null;

  const titles = lc(icp.title).split(/[,/]/).map((s) => s.trim()).filter(Boolean);
  const title = has(lead.title) ? (titles.some((t) => lc(lead.title).includes(t)) ? WEIGHTS.title : 0) : null;

  const min = +icp.sizeMin || 0;
  const max = +icp.sizeMax || 1e9;
  const size = lead.size !== null && has(lead.size)
    ? (lead.size >= min && lead.size <= max ? WEIGHTS.size : lead.size >= min * 0.5 && lead.size <= max * 2 ? 12 : 4)
    : null;

  const location = has(lead.country)
    ? (lc(icp.location) && lc(lead.country).includes(lc(icp.location)) ? WEIGHTS.location : 0)
    : null;

  const raw: [string, number | null, number, string | null][] = [
    ['Industry match', industry, WEIGHTS.industry, lead.industry],
    ['Job title match', title, WEIGHTS.title, lead.title],
    ['Company size', size, WEIGHTS.size, has(lead.size) ? `${lead.size} employees` : null],
    ['Location', location, WEIGHTS.location, lead.country],
  ];

  const total = Math.round((raw.reduce((a, p) => a + (p[1] ?? 0), 0) / MAX) * 100);
  return {
    total,
    conf: Math.round((raw.filter((p) => p[1] !== null).length / raw.length) * 10),
    label: total >= 75 ? 'High match' : total >= 50 ? 'Medium match' : 'Low match',
    parts: raw.map(([name, pts, weight, value]) => ({
      name,
      found: pts === null ? 'Not available — not guessed' : `Found: ${value}`,
      pts: pts === null ? `— / ${weight}` : `${pts} / ${weight}`,
    })),
  };
}

export type RankedLead = Lead & { score: LeadScore };

export function rankLeads(leads: Lead[], icp: Icp): RankedLead[] {
  return leads.map((l) => ({ ...l, score: scoreLead(l, icp) })).sort((a, b) => b.score.total - a.score.total);
}
