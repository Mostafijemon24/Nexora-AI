import type {
  ActivationResult, AiTask, Change, ConnectDetail, DashboardMetrics, DeviceInfo, GeneratedPost, Invitation, Lead, LicenseEvent, LicenseState,
  MfaSetup, OpenRouterModel, ProviderName, Range, Role, SignInResult, Tone, WorkspaceRef, WorkspaceSnapshot,
} from '../lib/types';

export interface LicenseStatus {
  /** null when this device holds no active license. */
  license: LicenseState | null;
  /** Fresh signed entitlement token for offline verification on native targets. */
  entitlementToken?: string;
  events: LicenseEvent[];
}

export type TransferResult = ActivationResult | { ok: false; code: 'bad_code' };

export interface BackupInfo { id: string; createdAt: string; automatic: boolean; sizeBytes: number; leads: number }
export interface InvitationInfo { email: string; workspace: string; role: Role; hasAccount: boolean }

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
    /** On a license with several seats, `replaceDeviceId` names the device that gives up its seat. */
    confirmTransfer(key: string, code: string, device: DeviceInfo, replaceDeviceId?: string): Promise<TransferResult>;
    deactivate(device: DeviceInfo): Promise<void>;
  };

  /** Accounts. Every method needs a server; without one they reject. */
  auth: {
    /** Signs in and gives this device a seat on the license that covers the person's workspace. */
    signIn(input: { email: string; password: string; code?: string }, device: DeviceInfo): Promise<SignInResult>;
    signOut(): Promise<void>;
    /** Sets a first password, or changes it when `current` is given. */
    setPassword(password: string, current?: string): Promise<void>;
    forgotPassword(email: string): Promise<void>;
    resetPassword(email: string, code: string, password: string): Promise<void>;
    mfaSetup(): Promise<MfaSetup>;
    /** Confirms setup. The recovery codes are returned this once. */
    mfaEnable(code: string): Promise<{ recoveryCodes: string[] }>;
    mfaDisable(password: string, code: string): Promise<void>;
    invitationInfo(token: string): Promise<InvitationInfo>;
    acceptInvitation(input: { token: string; name: string; password: string }, device: DeviceInfo): Promise<SignInResult>;
  };

  team: {
    invite(email: string, role: Role): Promise<Invitation>;
    cancelInvitation(id: string): Promise<void>;
    setRole(userId: string, role: Role): Promise<void>;
    remove(userId: string): Promise<void>;
  };

  workspaces: {
    create(name: string): Promise<WorkspaceRef>;
    /** Points this session at another workspace of the account. */
    switchTo(id: string): Promise<void>;
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
    /**
     * Connects with an API key, or with the named fields the integration asks for. Sign-in (OAuth)
     * integrations return the provider URL to open; some return values to copy into the other system.
     */
    connect(id: string, input?: string | Record<string, string>): Promise<{ redirectUrl?: string; details?: ConnectDetail[] }>;
    disconnect(id: string): Promise<void>;
    /** Exchanges data with a connected system now (CRM, calendar, mailbox). */
    sync(id: string): Promise<{ ok: boolean; note: string }>;
  };

  posts: {
    /** Publishes an approved post to LinkedIn through the official API. Returns its address there. */
    publish(id: string): Promise<{ url: string }>;
  };

  providers: {
    /** Stores the key encrypted server-side and verifies it with the provider. */
    verifyKey(name: ProviderName, key: string): Promise<boolean>;
    openRouterModels(): Promise<OpenRouterModel[]>;
  };

  system: {
    /** Returns the backup's completion time (ISO). */
    backup(): Promise<string>;
    backups(): Promise<BackupInfo[]>;
    /** The backup as text, ready to save as a file. */
    downloadBackup(id: string): Promise<string>;
    /** Replaces the workspace's content with a stored backup, or with the contents of a backup file. */
    restoreBackup(source: { id: string } | { file: string }): Promise<void>;
    revokeSession(id: string): Promise<void>;
  };
}

export class BackendError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message);
    this.name = 'BackendError';
  }
}
