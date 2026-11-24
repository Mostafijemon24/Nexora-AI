import type { Backend } from './backend';
import { createHttpBackend } from './http';
import { bridge } from '../platform/bridge';

export type { Backend } from './backend';
export { BackendError } from './backend';

const LS_SERVER = 'nexora.server';

/** The address the app was built with, if any. */
export const builtInServer = (): string => ((import.meta.env.VITE_API_URL as string | undefined) ?? '').trim().replace(/\/+$/, '');

/** A server address chosen on this device (a self-hosted server), which takes the place of the built-in one. */
export function chosenServer(): string {
  try { return (localStorage.getItem(LS_SERVER) ?? '').trim(); } catch { return ''; }
}

/** The server this app talks to, or '' when it runs without one. */
export const serverAddress = (): string => chosenServer() || builtInServer();

/**
 * Checks that a Nexora AI server answers at an address, then remembers it for this device. An
 * empty address goes back to the built-in one. The app must be reloaded afterwards.
 */
export async function chooseServer(raw: string): Promise<void> {
  const url = raw.trim().replace(/\/+$/, '');
  if (!url) {
    try { localStorage.removeItem(LS_SERVER); } catch { /* storage unavailable */ }
    return;
  }
  if (!/^https:\/\/[^\s/]+\.[^\s]+$/.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url)) throw new Error('Enter the full https:// address of the server.');
  let ok = false;
  try {
    const res = await fetch(`${url}/healthz`, { headers: { Accept: 'application/json' } });
    ok = res.ok && ((await res.json()) as { ok?: boolean }).ok === true;
  } catch { /* reported below */ }
  if (!ok) throw new Error('No Nexora AI server answered at that address. Check the address, and that the server lists this app’s address in APP_ORIGINS.');
  try { localStorage.setItem(LS_SERVER, url); } catch { throw new Error('This device could not remember the address.'); }
}

export interface BackendEvents {
  onLicenseLost: () => void;
  onAccountNeeded: (what: 'sign_in' | 'mfa_setup') => void;
}

/** The HTTP backend when a server address is known; otherwise the local backend, which starts with an empty workspace. */
export async function createBackend(events: BackendEvents): Promise<Backend> {
  const url = serverAddress();
  if (url) {
    return createHttpBackend(url, {
      getToken: () => bridge.secretGet('session').catch(() => null),
      setToken: (t) => (t ? bridge.secretSet('session', t) : bridge.secretDelete('session')),
      ...events,
    });
  }
  console.warn('[Nexora AI] No server address is set — running on the local backend (data stays on this device, AI is simulated). Not for production.');
  const { createDemoBackend } = await import('./demo');
  return createDemoBackend();
}
