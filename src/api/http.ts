import type { Backend } from './backend';
import { BackendError } from './backend';
import type { ActivationResult, SignInResult } from '../lib/types';

export interface HttpOptions {
  /** Native: the session token from the OS secure store. Web returns null and relies on the httpOnly cookie. */
  getToken: () => Promise<string | null>;
  setToken: (token: string | null) => Promise<void>;
  /** Called when the server says this device has no active license any more. */
  onLicenseLost: () => void;
  /** Called when the device has its seat but nobody is signed in on it, or two-step sign-in must be set up first. */
  onAccountNeeded: (what: 'sign_in' | 'mfa_setup') => void;
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
      if (res.status === 401 && code === 'sign_in_required') opts.onAccountNeeded('sign_in');
      if (res.status === 403 && code === 'mfa_setup_required' && !path.startsWith('/v1/workspace/changes')) opts.onAccountNeeded('mfa_setup');
      throw new BackendError(message, res.status, code);
    }
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  }

  const get = <T>(p: string) => call<T>('GET', p);
  const post = <T>(p: string, b?: unknown) => call<T>('POST', p, b ?? {});

  /** Keeps the session token a native activation returns; browsers receive a cookie instead. */
  const keep = async <R extends SignInResult | { ok: false; code: 'bad_code' }>(r: R): Promise<R> => {
    if (r.ok && r.sessionToken) await opts.setToken(r.sessionToken);
    return r;
  };
  const del = (p: string) => call<void>('DELETE', p);
  const enc = encodeURIComponent;

  return {
    demo: false,
    canConnect: true,
    license: {
      status: (device) => post('/v1/license/status', { device }),
      activate: async (key, device) => keep(await post<ActivationResult>('/v1/license/activate', { key, device })),
      requestTransfer: (key, device) => post('/v1/license/transfer/request', { key, device }),
      confirmTransfer: async (key, code, device, replaceDeviceId) =>
        keep(await post<ActivationResult | { ok: false; code: 'bad_code' }>('/v1/license/transfer/confirm', { key, code, device, replaceDeviceId })),
      deactivate: async () => { await post('/v1/license/deactivate'); await opts.setToken(null); },
    },
    auth: {
      signIn: async (input, device) => keep(await post<SignInResult>('/v1/auth/sign-in', { ...input, device })),
      signOut: () => post('/v1/auth/sign-out'),
      setPassword: (password, current) => post('/v1/auth/password', { password, current }),
      forgotPassword: (email) => post('/v1/auth/password/forgot', { email }),
      resetPassword: (email, code, password) => post('/v1/auth/password/reset', { email, code, password }),
      mfaSetup: () => post('/v1/auth/mfa/setup'),
      mfaEnable: (code) => post('/v1/auth/mfa/enable', { code }),
      mfaDisable: (password, code) => post('/v1/auth/mfa/disable', { password, code }),
      invitationInfo: (token) => post('/v1/auth/invite/info', { token }),
      acceptInvitation: async (input, device) => keep(await post<SignInResult>('/v1/auth/invite/accept', { ...input, device })),
    },
    team: {
      invite: (email, role) => post('/v1/team/invitations', { email, role }),
      cancelInvitation: (id) => del(`/v1/team/invitations/${enc(id)}`),
      setRole: (userId, role) => post(`/v1/team/members/${enc(userId)}/role`, { role }),
      remove: (userId) => del(`/v1/team/members/${enc(userId)}`),
    },
    workspaces: {
      create: (name) => post('/v1/workspaces', { name }),
      switchTo: (id) => post('/v1/workspaces/switch', { id }),
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
      connect: (id, input) => post(`/v1/integrations/${encodeURIComponent(id)}/connect`, typeof input === 'string' ? (input ? { apiKey: input } : {}) : input ? { fields: input } : {}),
      disconnect: (id) => call('DELETE', `/v1/integrations/${encodeURIComponent(id)}`),
      sync: (id) => post(`/v1/integrations/${encodeURIComponent(id)}/sync`),
    },
    posts: { publish: (id) => post(`/v1/posts/${encodeURIComponent(id)}/publish`) },
    providers: {
      verifyKey: async (name, key) => (await post<{ verified: boolean }>('/v1/ai/providers/verify', { name, key })).verified,
      openRouterModels: () => get('/v1/ai/openrouter/models'),
    },
    system: {
      backup: async () => (await post<{ completedAt: string }>('/v1/backups')).completedAt,
      backups: () => get('/v1/backups'),
      downloadBackup: async (id) => JSON.stringify(await get(`/v1/backups/${enc(id)}`), null, 2),
      restoreBackup: async (source) => {
        if ('id' in source) return void (await post(`/v1/backups/${enc(source.id)}/restore`));
        let backup: unknown;
        try { backup = JSON.parse(source.file); } catch { throw new BackendError('This file is not a Nexora AI backup.'); }
        await post('/v1/backups/restore', { backup });
      },
      revokeSession: (id) => call('DELETE', `/v1/sessions/${encodeURIComponent(id)}`),
    },
  };
}
