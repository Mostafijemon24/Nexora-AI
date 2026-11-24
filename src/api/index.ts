import type { Backend } from './backend';
import { createHttpBackend } from './http';
import { bridge } from '../platform/bridge';

export type { Backend } from './backend';
export { BackendError } from './backend';

/** HTTP backend when VITE_API_URL is configured; otherwise the local backend, which starts with an empty workspace. */
export async function createBackend(onLicenseLost: () => void): Promise<Backend> {
  const url = (import.meta.env.VITE_API_URL as string | undefined)?.trim();
  if (url) {
    return createHttpBackend(url, {
      getToken: () => bridge.secretGet('session').catch(() => null),
      setToken: (t) => (t ? bridge.secretSet('session', t) : bridge.secretDelete('session')),
      onLicenseLost,
    });
  }
  console.warn('[Nexora AI] VITE_API_URL is not set — running on the local backend (data stays on this device, AI is simulated). Not for production.');
  const { createDemoBackend } = await import('./demo');
  return createDemoBackend();
}
