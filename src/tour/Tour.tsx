import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button, PrimaryButton } from '../components/ui';
import { NAV, TITLES } from '../shell/nav';
import { useApp } from '../state/store';
import { TOUR } from './steps';

interface Box { top: number; left: number; width: number; height: number }
interface Point { top: number; left: number }

const EDGE = 8; // closest the card may sit to the window edge
const GAP = 12; // between the highlighted element and the card
const PAD = 4; // highlight margin around the element
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/** Step-by-step guide for the current page: highlights one element at a time and explains it. */
export function Tour() {
  const tour = useApp((s) => s.tour);
  const screen = useApp((s) => s.screen);
  const toured = useApp((s) => s.toured);
  const steps = tour ? TOUR[tour.screen] : [];
  const step = tour ? steps[tour.step] : undefined;
  const card = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Box | null>(null);
  const [at, setAt] = useState<Point | null>(null);

  // A page that has not been toured starts its tour when it is opened.
  useEffect(() => {
    if (!tour && !toured.includes(screen)) useApp.getState().startTour(screen);
  }, [screen, tour, toured]);

  const place = useCallback(() => {
    const el = card.current;
    if (!el || !step) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const r = step.target ? document.querySelector(`[data-tour="${step.target}"]`)?.getBoundingClientRect() : undefined;
    // The part of the element that is inside the window; none when it is absent or scrolled away.
    const top = r ? Math.max(r.top - PAD, 0) : 0;
    const left = r ? Math.max(r.left - PAD, 0) : 0;
    const bottom = r ? Math.min(r.bottom + PAD, vh) : 0;
    const right = r ? Math.min(r.right + PAD, vw) : 0;
    if (!r || !r.width || !r.height || bottom - top < 8 || right - left < 8) {
      setBox(null);
      return setAt({ top: clamp((vh - h) / 2, EDGE, vh - h - EDGE), left: clamp((vw - w) / 2, EDGE, vw - w - EDGE) });
    }
    setBox({ top, left, width: right - left, height: bottom - top });
    const centred = clamp((left + right) / 2 - w / 2, EDGE, vw - w - EDGE);
    const beside = clamp(top, EDGE, vh - h - EDGE);
    if (bottom + GAP + h <= vh - EDGE) setAt({ top: bottom + GAP, left: centred });
    else if (top - GAP - h >= EDGE) setAt({ top: top - GAP - h, left: centred });
    else if (right + GAP + w <= vw - EDGE) setAt({ top: beside, left: right + GAP });
    else if (left - GAP - w >= EDGE) setAt({ top: beside, left: left - GAP - w });
    else setAt({ top: vh - h - GAP, left: centred }); // the element fills the window: sit inside it
  }, [step]);

  useLayoutEffect(() => {
    if (!step) return;
    if (step.target) document.querySelector(`[data-tour="${step.target}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    place();
    // Again once the page's entry animation and any scrolling have settled.
    const settled = setTimeout(place, 260);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      clearTimeout(settled);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [step, place]);

  const stepKey = tour ? `${tour.screen}:${tour.step}` : '';
  const placed = at !== null; // the card is hidden, and cannot take focus, until it has a position
  useEffect(() => {
    if (!stepKey || !placed) return;
    card.current?.querySelector<HTMLElement>('.btn-primary')?.focus();
    const onKey = (e: KeyboardEvent) => {
      const s = useApp.getState();
      if (e.key === 'Escape') return s.endTour('page');
      if (e.key === 'ArrowRight') return s.tourStep(1);
      if (e.key === 'ArrowLeft') return s.tourStep(-1);
      if (e.key !== 'Tab') return;
      // The page behind the tour is not reachable: keep focus on the card's buttons.
      const buttons = [...(card.current?.querySelectorAll<HTMLElement>('button') ?? [])];
      if (!buttons.length) return;
      const i = buttons.indexOf(document.activeElement as HTMLElement);
      e.preventDefault();
      buttons[(i + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stepKey, placed]);

  if (!tour || !step) return null;
  const s = useApp.getState();
  const last = tour.step === steps.length - 1;
  const next = NAV[NAV.findIndex((n) => n.id === tour.screen) + 1];
  const nextPage = next && !toured.includes(next.id) ? next : undefined;

  return (
    <div className="tour">
      {box ? <div className="tour-spot" style={box} /> : <div className="tour-dim" />}
      <div
        className="tour-card blueprint" role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-body"
        key={stepKey} ref={card} style={at ?? { top: 0, left: 0, visibility: 'hidden' }}
      >
        <i className="corner tl" /><i className="corner tr" /><i className="corner bl" /><i className="corner br" />
        <div className="card-kicker">{TITLES[tour.screen]} · Step {tour.step + 1} of {steps.length}</div>
        <div className="dialog-title" id="tour-title">{step.title}</div>
        <div className="dialog-body" id="tour-body">{step.body}</div>
        <div className="tour-actions">
          <Button variant="ghost" title="Stop the tours on every page" onClick={() => s.endTour('all')}>Skip tour</Button>
          <span className="tour-space" />
          {tour.step > 0 && <Button onClick={() => s.tourStep(-1)}>Back</Button>}
          {!last && <PrimaryButton onClick={() => s.tourStep(1)}>Next</PrimaryButton>}
          {last && nextPage && <Button onClick={() => s.endTour('page')}>Done</Button>}
          {last && nextPage && <PrimaryButton onClick={() => { s.endTour('page'); s.go(nextPage.id); }}>Next: {nextPage.label}</PrimaryButton>}
          {last && !nextPage && <PrimaryButton onClick={() => s.endTour('page')}>Finish</PrimaryButton>}
        </div>
      </div>
    </div>
  );
}
