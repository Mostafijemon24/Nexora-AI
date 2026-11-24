// CSV reading and writing shared by the server, the local backend and the exports.

import { LEAD_STAGES, newLead, type Lead, type LeadStage } from './types.ts';

/** Minimal RFC 4180 reader: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') quoted = false; else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim())) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim())) rows.push(row);
  return rows;
}

/**
 * Writes rows as CSV. A cell that a spreadsheet would run as a formula is prefixed with an
 * apostrophe, so an imported name such as "=HYPERLINK(...)" stays text when the export is opened.
 */
export function toCsv(rows: (string | number | null | undefined)[][]): string {
  const cell = (v: string | number | null | undefined) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

export const MAX_IMPORT_ROWS = 5000;
export class CsvError extends Error {}

/**
 * Reads leads from CSV text with a header row. `name` and `company` are required columns;
 * `title`, `industry`, `size`, `country`, `email`, `phone`, `linkedin`, `tags` (separated by ";")
 * and `stage` are optional. An empty cell stays unknown — nothing is filled in or guessed.
 */
export function leadsFromCsv(csv: string, at: string, id: () => string): { leads: Lead[]; skipped: number } {
  const [header, ...rows] = parseCsv(csv.replace(/^﻿/, ''));
  if (!header) throw new CsvError('The file is empty.');
  const col = (n: string) => header.findIndex((h) => h.trim().toLowerCase() === n);
  const idx = {
    name: col('name'), company: col('company'), title: col('title'), industry: col('industry'), size: col('size'), country: col('country'),
    email: col('email'), phone: col('phone'), linkedin: col('linkedin'), tags: col('tags'), stage: col('stage'),
  };
  if (idx.name < 0 || idx.company < 0) throw new CsvError('The CSV needs a header row with at least "name" and "company" columns.');
  if (rows.length > MAX_IMPORT_ROWS) throw new CsvError(`Import at most ${MAX_IMPORT_ROWS} leads at a time.`);
  const cell = (r: string[], i: number) => (i >= 0 && r[i]?.trim() ? r[i].trim().slice(0, 300) : null);
  const leads: Lead[] = [];
  for (const r of rows) {
    const name = cell(r, idx.name), company = cell(r, idx.company);
    if (!name || !company) continue;
    const size = Number(cell(r, idx.size));
    const stage = (cell(r, idx.stage) ?? '').toLowerCase() as LeadStage;
    leads.push(newLead(id(), name, company, at, {
      title: cell(r, idx.title), industry: cell(r, idx.industry), size: Number.isInteger(size) && size > 0 ? size : null, country: cell(r, idx.country),
      email: cell(r, idx.email), phone: cell(r, idx.phone), linkedin: cell(r, idx.linkedin),
      tags: cleanTags((cell(r, idx.tags) ?? '').split(';')),
      stage: LEAD_STAGES.includes(stage) ? stage : 'new',
    }));
  }
  return { leads, skipped: rows.length - leads.length };
}

/** Trimmed, de-duplicated (ignoring case) tags, at most 20 of 40 characters each. */
export function cleanTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const t = raw.trim().slice(0, 40);
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out.slice(0, 20);
}
