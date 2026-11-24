import { describe, expect, it } from 'vitest';
import { NAV } from '../shell/nav';
import { TOUR } from './steps';

/** The source of every component, to check that each step's target is really in the UI. */
const ui = Object.values(import.meta.glob<string>('../**/*.tsx', { query: '?raw', import: 'default', eager: true })).join('\n');

describe('page tour', () => {
  it('has steps for every page', () => {
    for (const { id } of NAV) expect(TOUR[id].length, id).toBeGreaterThan(0);
  });

  it('points only at elements that exist in the UI', () => {
    expect(ui.length).toBeGreaterThan(1000);
    for (const [screen, steps] of Object.entries(TOUR)) {
      for (const s of steps) {
        if (s.target) expect(ui.includes(`tour="${s.target}"`), `${screen}: ${s.target}`).toBe(true);
      }
    }
  });
});
