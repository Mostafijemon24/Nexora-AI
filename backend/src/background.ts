// Work the server does on its own, once a minute: continue workflow runs, fire schedules, and
// (as each is connected) read mailboxes, sync connected systems and publish scheduled posts.

import type { Ctx } from './context.ts';
import { pollMailboxes } from './inbound.ts';
import { syncAll } from './sync/index.ts';
import { publishDue } from './sync/linkedin.ts';
import { tick } from './workspace/automation.ts';

export type BackgroundJob = (ctx: Ctx) => Promise<unknown>;
/** Jobs run in order; one failing never stops the others. */
export const JOBS: Record<string, BackgroundJob> = { workflows: tick, mail: (ctx) => pollMailboxes(ctx), sync: syncAll, publish: publishDue };

export async function runBackground(ctx: Ctx): Promise<void> {
  for (const [name, job] of Object.entries(JOBS)) {
    try { await job(ctx); } catch (e) { console.error(`[background] ${name} failed:`, e); }
  }
}
