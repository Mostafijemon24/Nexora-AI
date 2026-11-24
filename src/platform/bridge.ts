// The only door between the UI and the OS. On native targets every call is a typed Tauri
// command implemented by the Rust core (src-tauri). In a browser the same interface is
// served by a small in-memory fallback, because the web build has no offline mode.

import type { Change, DeviceInfo, Platform } from '../lib/types';

export interface EntitlementStatus {
  /** True when a stored token has a valid signature, matches this device and is inside its grace period. */
  valid: boolean;
  graceUntil?: string;
  reason?: string;
}

/** A release newer than the running app. */
export interface AppUpdate {
  version: string;
  /** Release notes, when the release has any. */
  notes?: string | null;
}

export interface Bridge {
  readonly native: boolean;
  deviceInfo(): Promise<DeviceInfo>;
  entitlementSave(token: string): Promise<void>;
  entitlementStatus(): Promise<EntitlementStatus>;
  entitlementClear(): Promise<void>;
  queuePush(change: Change): Promise<void>;
  queueAll(): Promise<Change[]>;
  queueRemove(ids: string[]): Promise<void>;
  queueLen(): Promise<number>;
  cachePut(key: string, value: unknown): Promise<void>;
  cacheGet<T>(key: string): Promise<T | null>;
  cacheClear(): Promise<void>;
  secretSet(name: string, value: string): Promise<void>;
  secretGet(name: string): Promise<string | null>;
  secretDelete(name: string): Promise<void>;
  /**
   * Saves a text file for the user. Native: written to the Downloads folder without replacing an
   * existing file; resolves to the full path. Web: downloaded by the browser; resolves to the file name.
   */
  saveFile(name: string, contents: string): Promise<string>;
  /** Opens an https address in the default browser (web: a new tab). Other schemes are refused. */
  openExternal(url: string): Promise<void>;
  /** The newer release, or null. Always null on the web, on Android and in a build without an updater key. */
  updateCheck(): Promise<AppUpdate | null>;
  /** Downloads and installs the newer release, then restarts the app. */
  updateInstall(): Promise<void>;
}

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

function tauriBridge(): Bridge {
  const invoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    const { invoke: inv } = await import('@tauri-apps/api/core');
    return inv<T>(cmd, args);
  };
  return {
    native: true,
    deviceInfo: () => invoke('device_info'),
    entitlementSave: (token) => invoke('entitlement_save', { token }),
    entitlementStatus: () => invoke('entitlement_status'),
    entitlementClear: () => invoke('entitlement_clear'),
    queuePush: (change) => invoke('queue_push', { change }),
    queueAll: () => invoke('queue_all'),
    queueRemove: (ids) => invoke('queue_remove', { ids }),
    queueLen: () => invoke('queue_len'),
    cachePut: (key, value) => invoke('cache_put', { key, value: JSON.stringify(value) }),
    cacheGet: async <T>(key: string) => {
      const raw = await invoke<string | null>('cache_get', { key });
      return raw === null ? null : (JSON.parse(raw) as T);
    },
    cacheClear: () => invoke('cache_clear'),
    secretSet: (name, value) => invoke('secret_set', { name, value }),
    secretGet: (name) => invoke('secret_get', { name }),
    secretDelete: (name) => invoke('secret_delete', { name }),
    saveFile: (name, contents) => invoke('save_file', { name, contents }),
    openExternal: (url) => invoke('open_external', { url }),
    updateCheck: () => invoke('update_check'),
    updateInstall: () => invoke('update_install'),
  };
}

function browserName(ua: string): string {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

/** Stand-in device labels used only when previewing a native frame in a browser. */
const PREVIEW_DEVICES: Record<Exclude<Platform, 'web'>, [string, string]> = {
  windows: ['RAFIQ-WORKSTATION', 'Windows 11'],
  macos: ['RAFIQ-MACBOOK', 'macOS 15'],
  linux: ['RAFIQ-THINKPAD', 'Ubuntu 24.04'],
  android: ['RAFIQ-PIXEL', 'Android 15'],
};

function webBridge(): Bridge {
  let queue: Change[] = [];
  const cache = new Map<string, string>();
  const secrets = new Map<string, string>();
  const preview = previewPlatform();
  return {
    native: false,
    async deviceInfo() {
      const appVersion = __APP_VERSION__;
      if (preview && preview !== 'web') {
        const [name, os] = PREVIEW_DEVICES[preview];
        return { id: `preview-${preview}`, name, os, platform: preview, appVersion };
      }
      // The browser has no trustworthy device id; the server registers it via its own session cookie.
      return { id: '', name: browserName(navigator.userAgent), os: 'this browser', platform: 'web', appVersion };
    },
    async entitlementSave() {},
    async entitlementStatus() { return { valid: false, reason: 'web revalidates every session' }; },
    async entitlementClear() {},
    async queuePush(c) { if (!queue.some((q) => q.id === c.id)) queue.push(c); },
    async queueAll() { return [...queue]; },
    async queueRemove(ids) { queue = queue.filter((q) => !ids.includes(q.id)); },
    async queueLen() { return queue.length; },
    async cachePut(k, v) { cache.set(k, JSON.stringify(v)); },
    async cacheGet<T>(k: string) { const r = cache.get(k); return r === undefined ? null : (JSON.parse(r) as T); },
    async cacheClear() { cache.clear(); },
    async secretSet(n, v) { secrets.set(n, v); },
    async secretGet(n) { return secrets.get(n) ?? null; },
    async secretDelete(n) { secrets.delete(n); },
    async saveFile(name, contents) {
      const file = name.split(/[\\/]/).pop()?.trim() || 'nexora-export.txt';
      const url = URL.createObjectURL(new Blob([contents], { type: 'application/octet-stream' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = file;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
      // The download reads the blob after the click, so it is released a little later.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      return file;
    },
    async openExternal(url) {
      if (!/^https:\/\/[^\s/]/i.test(url.trim())) throw new Error('Only https:// addresses can be opened.');
      window.open(url.trim(), '_blank', 'noopener');
    },
    async updateCheck() { return null; },
    async updateInstall() {},
  };
}

/**
 * `?platform=windows|macos|linux|android|web` renders that target's frame in a browser.
 * It is a review aid for development and demo builds and is ignored inside the native app.
 */
export function previewPlatform(): Platform | null {
  if (isTauri || typeof window === 'undefined') return null;
  if (!import.meta.env.DEV && import.meta.env.VITE_API_URL) return null;
  const p = new URLSearchParams(window.location.search).get('platform');
  return p === 'web' || p === 'windows' || p === 'macos' || p === 'linux' || p === 'android' ? p : null;
}

export const bridge: Bridge = isTauri ? tauriBridge() : webBridge();
