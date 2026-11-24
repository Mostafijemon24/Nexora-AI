import { CircleHelp, Globe, Minus, Moon, PanelLeft, Square, Sun, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '../components/ui';
import { useApp } from '../state/store';
import { NAV, TITLES } from './nav';

const OS_LABEL = { web: 'Web', windows: 'Windows 11', macos: 'macOS 15', linux: 'Ubuntu 24.04', android: 'Android 15' } as const;

/**
 * Drawn window chrome. Only rendered when a platform frame is previewed in a browser:
 * real builds use the browser's own chrome or the OS's native window decorations.
 */
export function PreviewChrome() {
  const platform = useApp((s) => s.platform);
  const screen = useApp((s) => s.screen);
  const version = useApp((s) => s.device?.appVersion ?? '');
  const os = `v${version} · Rust core${platform === 'android' ? '' : ` · ${OS_LABEL[platform]}`}`;
  const ctl = (
    <div className="ctl" aria-hidden="true">
      <span><Minus size={14} strokeWidth={1.5} /></span>
      <span><Square size={14} strokeWidth={1.5} /></span>
      <span><X size={14} strokeWidth={1.5} /></span>
    </div>
  );
  switch (platform) {
    case 'web':
      return (
        <div className="chrome chrome-web">
          <div className="tab">Nexora AI</div>
          <div className="url"><Globe size={14} strokeWidth={1.5} /><span>app.nexora.ai/{screen}</span></div>
        </div>
      );
    case 'windows':
      return <div className="chrome chrome-win"><span className="chrome-title">Nexora AI</span><span className="muted">{os}</span>{ctl}</div>;
    case 'macos':
      return (
        <div className="chrome chrome-mac">
          <div className="lights" aria-hidden="true"><span /><span /><span /></div>
          <span className="chrome-title">Nexora AI</span>
          <span className="os">{os}</span>
        </div>
      );
    case 'linux':
      return <div className="chrome chrome-linux"><span className="muted" style={{ whiteSpace: 'nowrap' }}>{os}</span><span className="chrome-title">Nexora AI</span>{ctl}</div>;
    case 'android':
      return <div className="chrome chrome-android"><span>9:41</span><span className="muted">{os}</span><span>5G · 87%</span></div>;
  }
}

function useUnread() {
  return useApp((s) => s.ws?.conversations.filter((c) => c.unread).length ?? 0);
}

export function Sidebar() {
  const screen = useApp((s) => s.screen);
  const collapsed = useApp((s) => s.collapsed);
  const profile = useApp((s) => s.ws?.profile);
  const plan = useApp((s) => s.ws?.plan);
  const unread = useUnread();
  const go = useApp((s) => s.go);
  return (
    <aside className="sidebar" data-collapsed={collapsed} data-tour="nav">
      <div className="brand">
        <span className="brand-mark">N</span>
        {!collapsed && <span className="brand-name">Nexora AI</span>}
      </div>
      <nav aria-label="Main" style={{ display: 'contents' }}>
        {NAV.map(({ id, label, icon: Icon }) => (
          <button type="button" key={id} className="nav-item" title={label} aria-current={screen === id ? 'page' : undefined} onClick={() => go(id)}>
            <span className="ico"><Icon size={18} strokeWidth={1.5} /></span>
            {!collapsed && <span className="lbl">{label}</span>}
            {id === 'inbox' && unread > 0 && !collapsed && <span className="tag tag-accent" style={{ padding: '1px 7px' }}>{unread}</span>}
          </button>
        ))}
      </nav>
      {!collapsed && profile && plan && (
        <div className="sidebar-foot">
          <div className="ws">{profile.workspace}</div>
          <div>{plan.name} · {plan.hosting}</div>
        </div>
      )}
    </aside>
  );
}

export function BottomNav() {
  const screen = useApp((s) => s.screen);
  const go = useApp((s) => s.go);
  return (
    <nav className="bottom-nav" aria-label="Main" data-tour="nav">
      {NAV.map(({ id, label, icon: Icon }) => (
        <button type="button" key={id} title={label} aria-label={label} aria-current={screen === id ? 'page' : undefined} onClick={() => go(id)}>
          <Icon size={18} strokeWidth={1.5} />
        </button>
      ))}
    </nav>
  );
}

export function Header() {
  const s = useApp();
  const native = s.platform !== 'web';
  const off = s.isOffline();
  const syncLabel = s.syncing ? 'Syncing…' : off ? `Offline · ${s.pending} pending` : native ? 'Synced with cloud' : 'Live';
  return (
    <header className="header">
      {s.platform !== 'android' && (
        <Button icon title="Toggle sidebar" aria-label="Toggle sidebar" onClick={() => s.setCollapsed(!s.collapsed)}>
          <PanelLeft size={16} strokeWidth={1.5} />
        </Button>
      )}
      <h4>{TITLES[s.screen]}</h4>
      <span className="sync" data-off={off} role="status"><i />{syncLabel}</span>
      {native && <Button disabled={s.syncing} onClick={() => (off ? void s.goOnline() : s.goOffline())}>{off ? 'Go online' : 'Go offline'}</Button>}
      <Button icon title="Show the tour for this page" aria-label="Show the tour for this page" data-tour="tour-help" onClick={() => s.startTour()}>
        <CircleHelp size={16} strokeWidth={1.5} />
      </Button>
      <Button icon title="Toggle theme" aria-label="Toggle theme" onClick={() => s.setTheme(s.theme === 'dark' ? 'light' : 'dark')}>
        {s.theme === 'dark' ? <Sun size={16} strokeWidth={1.5} /> : <Moon size={16} strokeWidth={1.5} />}
      </Button>
    </header>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const android = useApp((s) => s.platform === 'android');
  return (
    <>
      <div className="app-body">
        {!android && <Sidebar />}
        <div className="app-col">
          <Header />
          <main className="app-main">{children}</main>
        </div>
      </div>
      {android && <BottomNav />}
    </>
  );
}
