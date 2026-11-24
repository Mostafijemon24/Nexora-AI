import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { runBackground } from './background.ts';
import { maintenance } from './queue.ts';
import { createRuntime } from './runtime.ts';

const rt = createRuntime();
if (!rt.config.smtpUrl) console.warn('[nexora] SMTP_URL is not set: transfer codes are written to this log instead of emailed.');
if (!rt.redis) {
  console.warn('[nexora] REDIS_URL is not set: rate limits are per-process, and housekeeping and background work run in this process.');
  setInterval(() => void maintenance(rt.db, new Date()).catch((e) => console.error('[maintenance]', e)), 3_600_000).unref();
  let busy = false;
  setInterval(() => { if (busy) return; busy = true; void runBackground(rt.ctx).finally(() => { busy = false; }); }, 60_000).unref();
}

const server = serve({ fetch: createApp(rt.ctx).fetch, port: rt.config.port }, (info) => console.log(`[nexora] API listening on :${info.port}`));

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { server.close(() => void rt.close().then(() => process.exit(0))); });
}
