import { randomUUID } from 'node:crypto';
import { CsvError, leadsFromCsv } from '../../../src/lib/csv.ts';
import type { Ctx } from '../context.ts';
import { tx } from '../db.ts';
import { badRequest } from '../errors.ts';
import type { Auth } from '../license/service.ts';
import { emit } from './automation.ts';
import { saveLead } from './store.ts';

export { parseCsv } from '../../../src/lib/csv.ts';

/**
 * Imports leads from CSV text with a header row (see leadsFromCsv for the columns). Returns the
 * ids of the new leads so the caller can start the workflows a new lead triggers.
 */
export async function importLeads(ctx: Ctx, workspaceId: string, csv: string): Promise<{ imported: number; skipped: number; ids: { id: string; name: string }[] }> {
  let parsed: ReturnType<typeof leadsFromCsv>;
  const now = ctx.now();
  try { parsed = leadsFromCsv(csv, now.toISOString(), randomUUID); } catch (e) {
    if (e instanceof CsvError) throw badRequest(e.message);
    throw e;
  }
  await tx(ctx.db, async (q) => { for (const l of parsed.leads) await saveLead(q, workspaceId, l, now); });
  return { imported: parsed.leads.length, skipped: parsed.skipped, ids: parsed.leads.map((l) => ({ id: l.id, name: l.name })) };
}

export const importLeadsFor = async (ctx: Ctx, auth: Auth, csv: unknown) => {
  if (typeof csv !== 'string' || !csv.trim()) throw badRequest('Choose a CSV file to import.');
  const r = await importLeads(ctx, auth.workspaceId, csv);
  await emit(ctx, auth, r.ids.map((l) => ({ kind: 'lead.created' as const, leadId: l.id, label: l.name })));
  return { imported: r.imported, skipped: r.skipped };
};
