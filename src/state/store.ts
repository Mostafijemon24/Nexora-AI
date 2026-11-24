import { create } from 'zustand';
import type { Backend } from '../api';
import type { ChatTurn } from '../api/backend';
import { bridge, previewPlatform } from '../platform/bridge';
import { NAV } from '../shell/nav';
import { TOUR, type TourTabs } from '../tour/steps';
import type {
  Change, DashboardMetrics, DeviceInfo, LicenseEvent, LicenseState, Platform, Range, ScreenId, Theme, WorkspaceSnapshot,
} from '../lib/types';

export interface DialogSpec {
  title: string;
  body: string;
  confirm: string;
  /** Label of a required secret field (e.g. "API key"); omitted for plain confirmations. */
  field?: string;
  run: (value: string) => void;
}

export type AiTab = 'scoring' | 'chat' | 'prompts';
export type ContentTab = 'gen' | 'posts' | 'cal';
export type SettingsTab = 'profile' | 'ai' | 'security' | 'sync' | 'license' | 'appearance';
export type WidgetId = 'kpi' | 'perf' | 'funnel' | 'tasks' | 'ai' | 'activity' | 'health';

export interface AppState {
  boot: 'loading' | 'gate' | 'ready' | 'error';
  bootError: string;
  backend: Backend | null;
  device: DeviceInfo | null;
  platform: Platform;
  /** True when a platform frame is being previewed in a browser (drawn window chrome is shown). */
  preview: boolean;

  theme: Theme;
  collapsed: boolean;
  widgets: Record<WidgetId, boolean>;

  online: boolean;
  syncing: boolean;
  pending: number;

  screen: ScreenId;
  aiTab: AiTab;
  csTab: ContentTab;
  setTab: SettingsTab;
  range: Range;

  toast: string;
  dialog: DialogSpec | null;
  /** The page tour in progress. `restore` holds the tabs that were open when it started. */
  tour: { screen: ScreenId; step: number; restore: TourTabs } | null;
  /** Pages whose tour has been seen or skipped on this device. */
  toured: ScreenId[];

  license: LicenseState | null;
  licEvents: LicenseEvent[];
  ws: WorkspaceSnapshot | null;
  metrics: Partial<Record<Range, DashboardMetrics>>;
  chat: ChatTurn[];
  chatInput: string;
  thinking: boolean;

  init(backend: Backend): Promise<void>;
  go(screen: ScreenId, tabs?: Partial<Pick<AppState, 'aiTab' | 'csTab' | 'setTab'>>): void;
  set(patch: Partial<AppState>): void;
  setTheme(theme: Theme): void;
  setCollapsed(collapsed: boolean): void;
  toggleWidget(id: WidgetId): void;
  setRange(range: Range): void;
  notify(message: string): void;
  confirm(dialog: DialogSpec): void;
  /** Shows a page's tour from its first step (the current page by default). */
  startTour(screen?: ScreenId): void;
  tourStep(delta: 1 | -1): void;
  /** Closes the tour and remembers it: for this page, or for every page when skipped. */
  endTour(scope: 'page' | 'all'): void;
  /** True on a native target that is working offline. Web is always online. */
  isOffline(): boolean;
  /** Blocks connection-only features while offline, with a clear message. Returns true when blocked. */
  needsNet(what?: string): boolean;
  /** Local, optimistic update of workspace data. */
  update(fn: (ws: WorkspaceSnapshot) => Partial<WorkspaceSnapshot>): void;
  /** Records a write: logs activity, then sends it or (offline) queues it for sync. */
  commit(message: string, ...changes: Change[]): void;
  /** Sends or queues writes without an activity entry or toast (e.g. per-keystroke edits). */
  save(...changes: Change[]): void;
  goOffline(): void;
  goOnline(): Promise<void>;
  onLicensed(license: LicenseState, token: string): Promise<void>;
  refreshLicenseEvents(): Promise<void>;
  deactivate(): Promise<void>;
  /** The server no longer recognises a license on this device (revoked, expired, transferred). */
  licenseLost(): void;
  sendChat(text?: string): Promise<void>;
}

const LS = { theme: 'nexora.theme', collapsed: 'nexora.sidebar', widgets: 'nexora.widgets', toured: 'nexora.toured' };
const read = <T,>(k: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(k);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch { return fallback; }
};
const write = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };

export const newId = (): string => crypto.randomUUID();
/** "" until the profile has a name. */
export const firstName = (name: string): string => name.trim().split(/\s+/)[0];

export function change(entity: string, entityId: string, data?: unknown, op: Change['op'] = 'upsert'): Change {
  return { id: newId(), entity, op, entityId, data, at: new Date().toISOString() };
}
export const remove = (entity: string, entityId: string): Change => change(entity, entityId, undefined, 'delete');

/** Queued user actions. Activity-log entries ride along with an action and are not counted on their own. */
const isAction = (c: Change) => c.entity !== 'activity';
const pendingCount = async () => (await bridge.queueAll()).filter(isAction).length;

const ALL_WIDGETS: Record<WidgetId, boolean> = { kpi: true, perf: true, funnel: true, tasks: true, ai: true, activity: true, health: true };
const CACHE_KEY = 'workspace';
let toastTimer: ReturnType<typeof setTimeout> | undefined;

const prefersDark = () => typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;

export const useApp = create<AppState>((set, get) => {
  const applyTheme = (t: Theme) => { document.documentElement.dataset.theme = t; };
  const cacheWorkspace = () => {
    const { ws, platform } = get();
    if (ws && platform !== 'web' && ws.sync.offlineCache) void bridge.cachePut(CACHE_KEY, ws);
  };
  const errText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');

  const loadWorkspace = async () => {
    const backend = get().backend!;
    const ws = await backend.workspace.load();
    set({
      ws,
      chat: [{ me: false, text: `${firstName(ws.profile.name) ? `Hi ${firstName(ws.profile.name)}` : 'Hi'}. Ask me about lead scores, post drafts or reply suggestions. I only use data in this workspace.` }],
    });
    cacheWorkspace();
    void get().setRange(get().range);
  };

  const flush = async (changes: Change[]) => {
    try {
      await get().backend!.workspace.push(changes);
    } catch (e) {
      if (get().platform === 'web') {
        get().notify(`Could not save: ${errText(e)}`);
        return;
      }
      // Native: keep the write and retry on the next sync instead of losing it.
      for (const c of changes) await bridge.queuePush(c);
      set({ pending: await pendingCount() });
      get().notify('Could not reach the server · saved locally, will sync');
    }
  };

  return {
    boot: 'loading', bootError: '', backend: null, device: null, platform: 'web', preview: false,
    theme: 'light', collapsed: false, widgets: ALL_WIDGETS,
    online: true, syncing: false, pending: 0,
    screen: 'dashboard', aiTab: 'scoring', csTab: 'gen', setTab: 'profile', range: '7d',
    toast: '', dialog: null, tour: null, toured: [],
    license: null, licEvents: [], ws: null, metrics: {}, chat: [], chatInput: '', thinking: false,

    async init(backend) {
      const theme = read<Theme>(LS.theme, prefersDark() ? 'dark' : 'light');
      applyTheme(theme);
      const device = await bridge.deviceInfo();
      set({
        backend, device, platform: device.platform, preview: previewPlatform() !== null,
        theme, collapsed: read(LS.collapsed, false), widgets: { ...ALL_WIDGETS, ...read(LS.widgets, {}) },
        toured: read<ScreenId[]>(LS.toured, []),
        pending: await pendingCount(),
      });
      try {
        const status = await backend.license.status(device);
        set({ licEvents: status.events });
        if (!status.license) return set({ boot: 'gate' });
        if (status.entitlementToken) await bridge.entitlementSave(status.entitlementToken);
        set({ license: status.license });
        await loadWorkspace();
        set({ boot: 'ready' });
        if (get().pending) void get().goOnline();
      } catch (e) {
        // Server unreachable. Native targets may continue inside the signed token's grace period.
        if (device.platform !== 'web') {
          const ent = await bridge.entitlementStatus();
          const cached = ent.valid ? await bridge.cacheGet<WorkspaceSnapshot>(CACHE_KEY) : null;
          const license = ent.valid ? await bridge.cacheGet<LicenseState>('license') : null;
          if (cached && license) {
            set({ ws: cached, license: { ...license, graceUntil: ent.graceUntil }, online: false, boot: 'ready' });
            get().notify('Working offline. Changes are queued locally.');
            return;
          }
          if (!ent.valid && ent.reason) return set({ boot: 'error', bootError: `${ent.reason} Connect to the internet to revalidate your license.` });
        }
        set({ boot: 'error', bootError: errText(e) });
      }
    },

    go(screen, tabs) { set({ screen, ...tabs }); },
    set(patch) { set(patch); },
    setTheme(theme) { applyTheme(theme); write(LS.theme, theme); set({ theme }); },
    setCollapsed(collapsed) { write(LS.collapsed, collapsed); set({ collapsed }); },
    toggleWidget(id) {
      const widgets = { ...get().widgets, [id]: !get().widgets[id] };
      write(LS.widgets, widgets);
      set({ widgets });
    },
    async setRange(range) {
      set({ range });
      if (get().metrics[range] || get().isOffline()) return;
      try {
        const m = await get().backend!.workspace.metrics(range);
        set({ metrics: { ...get().metrics, [range]: m } });
      } catch (e) { get().notify(`Could not load metrics: ${errText(e)}`); }
    },

    notify(message) {
      clearTimeout(toastTimer);
      set({ toast: message });
      toastTimer = setTimeout(() => set({ toast: '' }), 2600);
    },
    confirm(dialog) { set({ dialog }); },

    startTour(screen = get().screen) {
      const { aiTab, csTab, setTab } = get();
      set({ screen, tour: { screen, step: 0, restore: { aiTab, csTab, setTab } }, ...TOUR[screen][0].tabs });
    },
    tourStep(delta) {
      const tour = get().tour;
      const to = tour && TOUR[tour.screen][tour.step + delta];
      if (tour && to) set({ tour: { ...tour, step: tour.step + delta }, ...to.tabs });
    },
    endTour(scope) {
      const tour = get().tour;
      if (!tour) return;
      const toured = scope === 'all' ? NAV.map((n) => n.id) : [...new Set([...get().toured, tour.screen])];
      write(LS.toured, toured);
      set({ tour: null, toured, ...tour.restore });
    },
    isOffline() { return get().platform !== 'web' && !get().online; },
    needsNet(what = 'AI') {
      if (!get().isOffline()) return false;
      get().notify(`${what} needs a connection. Go online to continue.`);
      return true;
    },

    update(fn) {
      const ws = get().ws;
      if (ws) set({ ws: { ...ws, ...fn(ws) } });
    },
    commit(message, ...changes) {
      const off = get().isOffline();
      const entry = { id: newId(), text: message, at: new Date().toISOString() };
      get().update((ws) => ({ activity: [{ text: entry.text, at: entry.at }, ...ws.activity].slice(0, 6) }));
      get().notify(off ? `${message} · saved locally, will sync` : message);
      get().save(...changes, change('activity', entry.id, entry));
    },
    save(...changes) {
      cacheWorkspace();
      if (!changes.length) return;
      if (get().isOffline()) {
        void (async () => {
          for (const c of changes) await bridge.queuePush(c);
          set({ pending: await pendingCount() });
        })();
      } else void flush(changes);
    },

    goOffline() {
      set({ online: false });
      get().notify('Working offline. Changes are queued locally.');
    },
    async goOnline() {
      const queued = await bridge.queueAll();
      set({ online: true, syncing: true });
      try {
        if (queued.length) {
          await get().backend!.workspace.push(queued);
          await bridge.queueRemove(queued.map((c) => c.id));
        }
        get().update((ws) => ({
          conversations: ws.conversations.map((c) => ({ ...c, msgs: c.msgs.map((m) => (m.queued ? { ...m, queued: false } : m)) })),
        }));
        set({ syncing: false, pending: await pendingCount() });
        cacheWorkspace();
        const n = queued.filter(isAction).length;
        get().notify(n ? `${n} change${n > 1 ? 's' : ''} synced to cloud` : 'Back online');
        void get().setRange(get().range);
      } catch {
        set({ online: false, syncing: false, pending: await pendingCount() });
        get().notify('Still offline. Your changes stay queued.');
      }
    },

    async onLicensed(license, token) {
      if (token) await bridge.entitlementSave(token);
      if (get().platform !== 'web') await bridge.cachePut('license', license);
      set({ license });
      try {
        await loadWorkspace();
        set({ boot: 'ready', screen: 'dashboard' });
        get().notify('License activated');
        void get().refreshLicenseEvents();
      } catch (e) {
        set({ boot: 'error', bootError: errText(e) });
      }
    },
    async refreshLicenseEvents() {
      const { backend, device } = get();
      try {
        const s = await backend!.license.status(device!);
        set({ licEvents: s.events });
      } catch { /* the log is informational; keep what we have */ }
    },
    async deactivate() {
      const { backend, device } = get();
      try {
        await backend!.license.deactivate(device!);
      } catch (e) {
        return get().notify(`Could not deactivate: ${errText(e)}`);
      }
      await bridge.entitlementClear();
      await bridge.secretDelete('session');
      await bridge.cacheClear();
      set({ license: null, ws: null, boot: 'gate', chat: [], metrics: {}, tour: null });
      void get().refreshLicenseEvents();
    },

    licenseLost() {
      if (get().boot !== 'ready') return;
      void bridge.entitlementClear();
      void bridge.secretDelete('session');
      set({ license: null, ws: null, boot: 'gate', chat: [], metrics: {}, dialog: null, tour: null });
      get().notify('This device no longer has an active license.');
    },

    async sendChat(text) {
      const t = (text ?? get().chatInput).trim();
      if (!t || get().thinking || get().needsNet()) return;
      const history = [...get().chat, { me: true, text: t }];
      set({ chat: history, chatInput: '', thinking: true });
      try {
        const answer = await get().backend!.ai.chat(history, 'Reply suggestions');
        set({ chat: [...get().chat, { me: false, text: answer.text }] });
        if (answer.notice) get().notify(answer.notice);
      } catch (e) {
        get().notify(`Assistant unavailable: ${errText(e)}`);
      } finally {
        set({ thinking: false });
      }
    },
  };
});

/** Narrowed accessor for screens, which only render once the workspace is loaded. */
export const useWs = (): WorkspaceSnapshot => useApp((s) => s.ws)!;
