import { useEffect, useState } from 'react';
import { bridge, type AppUpdate } from '../platform/bridge';

/** How often a running app looks for a newer release. */
const RECHECK_MS = 6 * 60 * 60 * 1000;

/**
 * Desktop only: a one-line banner when a newer release has been published. Nothing is rendered on
 * the web, on Android, in a build without an updater key, or while the app is up to date.
 * Installing downloads the release, verifies its signature and restarts the app.
 */
export function UpdateNotice() {
  const [update, setUpdate] = useState<AppUpdate | null>(null);
  const [state, setState] = useState<'idle' | 'installing' | 'failed'>('idle');
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (!bridge.native) return;
    let alive = true;
    const check = () => {
      // Offline, or the release has no build for this computer: there is nothing to offer.
      bridge.updateCheck().then((u) => { if (alive && u) setUpdate(u); }).catch(() => undefined);
    };
    check();
    const timer = setInterval(check, RECHECK_MS);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  if (!update || hidden) return null;

  const install = () => {
    setState('installing');
    // On success the app restarts, so only a failure comes back here.
    bridge.updateInstall().catch(() => setState('failed'));
  };

  return (
    <div
      role="status"
      style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '8px 14px', borderBottom: '1px solid var(--line2)', fontSize: 13 }}
    >
      <span className="tag tag-outline">Update</span>
      <span style={{ flex: '1 1 220px' }}>
        {state === 'failed'
          ? `Version ${update.version} could not be installed. Check your connection and try again.`
          : state === 'installing'
            ? `Installing version ${update.version}. The app will restart.`
            : `Version ${update.version} is available.`}
      </span>
      <button type="button" className="btn btn-secondary" disabled={state === 'installing'} onClick={install}>
        {state === 'installing' ? 'Installing…' : state === 'failed' ? 'Try again' : 'Install and restart'}
      </button>
      {state !== 'installing' && (
        <button type="button" className="btn btn-ghost" onClick={() => setHidden(true)}>Later</button>
      )}
    </div>
  );
}
