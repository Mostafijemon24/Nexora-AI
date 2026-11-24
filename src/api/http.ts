import type { Backend } from './backend';
import { BackendError } from './backend';
import type { ActivationResult } from '../lib/types';

export interface HttpOptions {
  /** Native: the session token from the OS secure store. Web returns null and relies on the httpOnly cookie. */
  getToken: () => Promise<string | null>;
  setToken: (token: string | null) => Promise<void>;
  /** Called when the server says this device has no active license any more. */
  onLicenseLost: () => void;
}

/** Production backend: the Nexora AI API (backend/). */
export function createHttpBackend(baseUrl: string, opts: HttpOptions): Backend {
  const base = baseUrl.replace(/\/+$/, '');

  async function call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const token = await opts.getToken();
    let res: Response;
    try {
      res = await fetch(base + path, {
        method,
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new BackendError('The server could not be reached.');
    }
    if (!res.ok) {
      let message = `Request failed (${res.status}).`;
      let code: string | undefined;
      try {
        const j = (await res.json()) as { message?: string; code?: string };
        if (j.message) message = j.message;
        code = j.code;
      } catch { /* non-JSON error body */ }
      if (res.status === 401 && code === 'license_required') opts.onLicenseLost();
      throw new BackendError(message, res.status, code);
    }
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  }

  const get = <T>(p: string) => call<T>('GET', p);
  const post = <T>(p: string, b?: unknown) => call<T>('POST', p, b ?? {});

  /** Keeps the session token a native activation returns; browsers receive a cookie instead. */
  const keep = async <R extends ActivationResult | { ok: false; code: 'bad_code' }>(r: R): Promise<R> => {
    if (r.ok && r.sessionToken) await opts.setToken(r.sessionToken);
    return r;
  };

  return {
    demo: false,
    canConnect: true,
    license: {
      status: (device) => post('/v1/license/status', { device }),
      activate: async (key, device) => keep(await post<ActivationResult>('/v1/license/activate', { key, device })),
      requestTransfer: (key, device) => post('/v1/license/transfer/request', { key, device }),
      confirmTransfer: async (key, code, device) =>
        keep(await post<ActivationResult | { ok: false; code: 'bad_code' }>('/v1/license/transfer/confirm', { key, code, device })),
      deactivate: async () => { await post('/v1/license/deactivate'); await opts.setToken(null); },
    },
    workspace: {
      load: () => get('/v1/workspace'),
      metrics: (range) => get(`/v1/workspace/metrics?range=${range}`),
      push: async (changes) => {
        // Sent one at a time and in order; each id is its idempotency key, so a retry cannot duplicate.
        let effects = false;
        for (const c of changes) {
          const r = await call<{ effects?: boolean } | undefined>('POST', '/v1/workspace/changes', c, { 'Idempotency-Key': c.id });
          if (r?.effects) effects = true;
        }
        return { effects };
      },
    },
    ai: {
      chat: (history, task) => post('/v1/ai/chat', { history, task }),
      generatePost: (input) => post('/v1/ai/posts/generate', input),
      draftMessage: (leadId) => post(`/v1/ai/leads/${encodeURIComponent(leadId)}/draft`),
    },
    leads: { importCsv: (csv) => post('/v1/leads/import', { csv }) },
    integrations: {
      test: (id) => post(`/v1/integrations/${encodeURIComponent(id)}/test`),
      connect: (id, apiKey) => post(`/v1/integrations/${encodeURIComponent(id)}/connect`, apiKey ? { apiKey } : {}),
      disconnect: (id) => call('DELETE', `/v1/integrations/${encodeURIComponent(id)}`),
    },
    providers: {
      verifyKey: async (name, key) => (await post<{ verified: boolean }>('/v1/ai/providers/verify', { name, key })).verified,
      openRouterModels: () => get('/v1/ai/openrouter/models'),
    },
    system: {
      backup: async () => (await post<{ completedAt: string }>('/v1/backups')).completedAt,
      revokeSession: (id) => call('DELETE', `/v1/sessions/${encodeURIComponent(id)}`),
    },
  };
}
