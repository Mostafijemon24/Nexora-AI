import type { Ctx } from '../context.ts';
import { tx } from '../db.ts';
import { badRequest } from '../errors.ts';
import type { Auth } from '../license/service.ts';

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

export const MAX_IMPORT_ROWS = 5000;

/**
 * Imports leads from CSV text with a header row. `name` and `company` are required columns;
 * `title`, `industry`, `size` and `country` are optional. An empty cell stays unknown (null) —
 * nothing is filled in or guessed.
 */
export async function importLeads(ctx: Ctx, workspaceId: string, csv: string): Promise<{ imported: number; skipped: number }> {
  const [header, ...rows] = parseCsv(csv.replace(/^﻿/, ''));
  if (!header) throw badRequest('The file is empty.');
  const col = (n: string) => header.findIndex((h) => h.trim().toLowerCase() === n);
  const idx = { name: col('name'), title: col('title'), company: col('company'), industry: col('industry'), size: col('size'), country: col('country') };
  if (idx.name < 0 || idx.company < 0) throw badRequest('The CSV needs a header row with at least "name" and "company" columns.');
  if (rows.length > MAX_IMPORT_ROWS) throw badRequest(`Import at most ${MAX_IMPORT_ROWS} leads at a time.`);
  const cell = (r: string[], i: number) => (i >= 0 && r[i]?.trim() ? r[i].trim().slice(0, 300) : null);
  const now = ctx.now();
  let imported = 0;
  await tx(ctx.db, async (q) => {
    for (const r of rows) {
      const name = cell(r, idx.name), company = cell(r, idx.company);
      if (!name || !company) continue;
      const size = Number(cell(r, idx.size));
      await q.query('INSERT INTO leads (workspace_id, name, title, company, industry, size, country, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [workspaceId, name, cell(r, idx.title), company, cell(r, idx.industry), Number.isInteger(size) && size > 0 ? size : null, cell(r, idx.country), now]);
      imported++;
    }
  });
  return { imported, skipped: rows.length - imported };
}

export const importLeadsFor = (ctx: Ctx, auth: Auth, csv: unknown) => {
  if (typeof csv !== 'string' || !csv.trim()) throw badRequest('Choose a CSV file to import.');
  return importLeads(ctx, auth.workspaceId, csv);
};
