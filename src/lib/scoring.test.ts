import { describe, expect, it } from 'vitest';
import { rankLeads, scoreLead } from './scoring';
import { newLead, type Icp, type Lead } from './types';

const icp: Icp = { industry: 'Marketing', title: 'Founder, CEO', sizeMin: '10', sizeMax: '100', location: 'United States' };
const lead = (o: Partial<Lead>): Lead => newLead('1', 'A', 'C', '2026-11-23T09:00:00Z', { title: 'Founder', industry: 'Marketing', size: 42, country: 'United States', ...o });

describe('scoreLead', () => {
  it('gives a full match 100 with full confidence', () => {
    const s = scoreLead(lead({}), icp);
    expect(s).toMatchObject({ total: 100, conf: 10, label: 'High match' });
  });

  it('gives partial credit for a company size near the range', () => {
    const s = scoreLead(lead({ size: 130 }), icp); // within 2x max → 12 of 20
    expect(s.total).toBe(Math.round((82 / 90) * 100));
    expect(s.parts[2].pts).toBe('12 / 20');
    expect(scoreLead(lead({ size: 5000 }), icp).parts[2].pts).toBe('4 / 20');
  });

  it('never guesses missing data and lowers confidence, not just score', () => {
    const s = scoreLead(lead({ size: null, country: null }), icp);
    expect(s.conf).toBe(5);
    expect(s.total).toBe(Math.round((50 / 90) * 100));
    expect(s.parts[2]).toEqual({ name: 'Company size', found: 'Not available — not guessed', pts: '— / 20' });
    expect(s.parts[3].pts).toBe('— / 20');
  });

  it('labels by threshold: >=75 high, >=50 medium, else low', () => {
    expect(scoreLead(lead({ industry: 'Software', country: 'Canada' }), icp).label).toBe('Medium match'); // 45/90 = 50
    expect(scoreLead(lead({ industry: 'Software', country: 'Canada', title: 'Engineer' }), icp).label).toBe('Low match');
  });

  it('matches any of several comma or slash separated titles', () => {
    expect(scoreLead(lead({ title: 'Founder & CEO' }), icp).parts[1].pts).toBe('25 / 25');
    expect(scoreLead(lead({ title: 'Head of Growth' }), icp).parts[1].pts).toBe('0 / 25');
  });

  it('scores nothing for a blank criterion instead of matching everything', () => {
    expect(scoreLead(lead({}), { ...icp, industry: '' }).parts[0].pts).toBe('0 / 25');
  });
});

describe('rankLeads', () => {
  it('sorts by score, highest first', () => {
    const r = rankLeads([lead({ id: 'low', industry: 'Software', country: 'Canada' }), lead({ id: 'top' })], icp);
    expect(r.map((l) => l.id)).toEqual(['top', 'low']);
  });
});
