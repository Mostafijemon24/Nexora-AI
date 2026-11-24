import { useEffect, useState } from 'react';
import { createBackend } from './api';
import { Dialog, Toast } from './components/Overlays';
import { Button, Card } from './components/ui';
import { AiIntelligence } from './screens/AiIntelligence';
import { Automation } from './screens/Automation';
import { Communication } from './screens/Communication';
import { ContentStudio } from './screens/ContentStudio';
import { Dashboard } from './screens/Dashboard';
import { Integrations } from './screens/Integrations';
import { Leads } from './screens/Leads';
import { LicenseGate } from './screens/LicenseGate';
import { Reports } from './screens/Reports';
import { Settings } from './screens/Settings';
import { PreviewChrome, Shell } from './shell/Shell';
import { TITLES } from './shell/nav';
import { useApp } from './state/store';
import { Tour } from './tour/Tour';

function Screen() {
  const screen = useApp((s) => s.screen);
  const [customizing, setCustomizing] = useState(false);
  switch (screen) {
    case 'dashboard': return <Dashboard customizing={customizing} setCustomizing={setCustomizing} />;
    case 'leads': return <Leads />;
    case 'ai': return <AiIntelligence />;
    case 'content': return <ContentStudio />;
    case 'inbox': return <Communication />;
    case 'automation': return <Automation />;
    case 'reports': return <Reports />;
    case 'integrations': return <Integrations />;
    case 'settings': return <Settings />;
  }
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div style={{ flex: 1, minHeight: 0, display: 'grid', placeItems: 'center', padding: 24 }}>{children}</div>;
}

export function App() {
  const boot = useApp((s) => s.boot);
  const platform = useApp((s) => s.platform);
  const preview = useApp((s) => s.preview);
  const compact = useApp((s) => s.compact);
  const screen = useApp((s) => s.screen);
  const bootError = useApp((s) => s.bootError);

  useEffect(() => {
    void createBackend(() => useApp.getState().licenseLost()).then((b) => useApp.getState().init(b));
  }, []);

  // Returning from a provider's OAuth page: report the outcome once and clean the address bar.
  useEffect(() => {
    if (boot !== 'ready') return;
    const q = new URLSearchParams(window.location.search);
    const id = q.get('integration');
    const status = q.get('status');
    if (!id || !status) return;
    const s = useApp.getState();
    const name = s.ws?.integrations.find((g) => g.id === id)?.name ?? 'The integration';
    s.go('integrations');
    s.notify(status === 'connected' ? `${name} connected` : status === 'denied' ? `${name} authorization was cancelled.` : `${name} could not be connected.`);
    q.delete('integration'); q.delete('status');
    window.history.replaceState(null, '', window.location.pathname + (q.size ? `?${q}` : ''));
  }, [boot]);

  // A dropped connection on a native target moves the app into its offline mode.
  useEffect(() => {
    const down = () => { const s = useApp.getState(); if (s.boot === 'ready' && s.platform !== 'web' && s.online) s.goOffline(); };
    window.addEventListener('offline', down);
    return () => window.removeEventListener('offline', down);
  }, []);

  // Picks up what the server did on its own: incoming messages, workflow runs, synced records.
  useEffect(() => {
    if (boot !== 'ready') return;
    const poll = () => { if (document.visibilityState === 'visible') void useApp.getState().refresh(); };
    const timer = setInterval(poll, 30_000);
    document.addEventListener('visibilitychange', poll);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', poll); };
  }, [boot]);

  useEffect(() => {
    document.title = boot === 'ready' ? `${TITLES[screen]} · Nexora AI` : 'Nexora AI';
  }, [boot, screen]);

  return (
    <div className="app" data-plat={platform} data-preview={preview ? '' : undefined} data-compact={compact ? '' : undefined}>
      {preview && <PreviewChrome />}
      {boot === 'loading' && <Centered><span className="muted" role="status">Checking license…</span></Centered>}
      {boot === 'error' && (
        <Centered>
          <Card kicker="Nexora AI" style={{ width: '100%', maxWidth: 540 }}>
            <h3 style={{ margin: 0 }}>Nexora AI could not start</h3>
            <p className="card-body">{bootError}</p>
            <div><Button onClick={() => window.location.reload()}>Try again</Button></div>
          </Card>
        </Centered>
      )}
      {boot === 'gate' && <LicenseGate />}
      {boot === 'ready' && <Shell><Screen key={screen} /></Shell>}
      {boot === 'ready' && <Tour />}
      <Dialog />
      <Toast />
    </div>
  );
}
