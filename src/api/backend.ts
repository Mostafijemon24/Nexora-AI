import type {
  ActivationResult, AiTask, Change, DashboardMetrics, DeviceInfo, GeneratedPost, Lead, LicenseEvent, LicenseState,
  OpenRouterModel, ProviderName, Range, Tone, WorkspaceSnapshot,
} from '../lib/types';

export interface LicenseStatus {
  /** null when this device holds no active license. */
  license: LicenseState | null;
  /** Fresh signed entitlement token for offline verification on native targets. */
  entitlementToken?: string;
  events: LicenseEvent[];
}

export type TransferResult = ActivationResult | { ok: false; code: 'bad_code' };

export interface ChatTurn { me: boolean; text: string }

/** `notice` is set when a configured fallback model answered instead of the default. */
export interface AiText { text: string; notice?: string }

/**
 * Everything the UI needs from the server. The license server is the only authority on
 * license state, and provider keys never come back from it once stored.
 */
export interface Backend {
  /** True for the in-memory development backend. Never true in a production build with VITE_API_URL set. */
  readonly demo: boolean;
  /**
   * False when no server is behind the app: nothing can hold credentials or call a provider, so
   * integrations and provider keys cannot be connected, and AI answers are built-in examples.
   */
  readonly canConnect: boolean;

  license: {
    status(device: DeviceInfo): Promise<LicenseStatus>;
    activate(key: string, device: DeviceInfo): Promise<ActivationResult>;
    /** Emails a 6-digit code to the license owner. */
    requestTransfer(key: string, device: DeviceInfo): Promise<void>;
    confirmTransfer(key: string, code: string, device: DeviceInfo): Promise<TransferResult>;
    deactivate(device: DeviceInfo): Promise<void>;
  };

  workspace: {
    load(): Promise<WorkspaceSnapshot>;
    metrics(range: Range): Promise<DashboardMetrics>;
    /**
     * Applies writes in order. Each change id is an idempotency key: replays are no-ops.
     * `effects` is true when the write set more in motion (a workflow ran, a reply was delivered), so the workspace should be reloaded.
     */
    push(changes: Change[]): Promise<{ effects: boolean }>;
  };

  ai: {
    chat(history: ChatTurn[], task: AiTask): Promise<AiText>;
    generatePost(input: { topic: string; audience: string; tone: Tone; variant: number }): Promise<GeneratedPost & { notice?: string }>;
    draftMessage(leadId: string): Promise<AiText>;
  };

  leads: {
    /** Imports leads from CSV text (header row with at least name and company). Returns the full lead list. */
    importCsv(csv: string): Promise<{ imported: number; skipped: number; leads: Lead[] }>;
  };

  integrations: {
    test(id: string): Promise<{ latencyMs: number }>;
    /** Key-based integrations connect directly. OAuth ones return the provider URL to open. */
    connect(id: string, apiKey?: string): Promise<{ redirectUrl?: string }>;
    disconnect(id: string): Promise<void>;
  };

  providers: {
    /** Stores the key encrypted server-side and verifies it with the provider. */
    verifyKey(name: ProviderName, key: string): Promise<boolean>;
    openRouterModels(): Promise<OpenRouterModel[]>;
  };

  system: {
    /** Returns the backup's completion time (ISO). */
    backup(): Promise<string>;
    revokeSession(id: string): Promise<void>;
  };
}

export class BackendError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message);
    this.name = 'BackendError';
  }
}
