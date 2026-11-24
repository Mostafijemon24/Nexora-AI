import { startWorker } from './queue.ts';
import { createRuntime } from './runtime.ts';

const rt = createRuntime();
if (!rt.redis) {
  console.error('[nexora] The worker needs REDIS_URL. Without Redis the API process does this work itself.');
  process.exit(1);
}
const worker = await startWorker(rt.db, rt.mailer, rt.redis, rt.ctx);
worker.on('failed', (job, err) => console.error(`[worker] ${job?.name} failed:`, err.message));
console.log('[nexora] worker running');

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { void worker.close().then(() => rt.close()).then(() => process.exit(0)); });
}
