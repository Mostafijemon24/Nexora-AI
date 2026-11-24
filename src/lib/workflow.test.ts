import { describe, expect, it } from 'vitest';
import { describeStep, makeStep, scheduleDue, STEP_DEFS, triggeredBy, workflowProblem } from './workflow';
import type { Workflow } from './types';

const wf = (steps: Workflow['steps'], on = true): Workflow => ({ id: 'w', name: 'W', on, steps });

describe('workflow steps', () => {
  it('every step kind has defaults that pass validation and a description', () => {
    for (const d of STEP_DEFS) {
      const s = makeStep(d.kind);
      expect(s.type, d.kind).toBe(d.type);
      expect(describeStep(s).length, d.kind).toBeGreaterThan(3);
      const steps = d.type === 'Trigger' ? [s] : d.kind === 'message.send' ? [makeStep('manual'), makeStep('message.draft'), makeStep('approval'), s] : [makeStep('manual'), s];
      expect(workflowProblem(steps), d.kind).toBeNull();
    }
  });

  it('offers nothing that acts on LinkedIn', () => {
    expect(STEP_DEFS.filter((d) => /linkedin|connect|scrape|invite/i.test(d.kind + d.name))).toEqual([]);
  });

  it('explains what is wrong with a workflow', () => {
    expect(workflowProblem([])).toBe('A workflow starts with a trigger.');
    expect(workflowProblem([makeStep('notify')])).toBe('A workflow starts with a trigger.');
    expect(workflowProblem([makeStep('manual'), makeStep('lead.created')])).toBe('A workflow has exactly one trigger.');
    expect(workflowProblem([makeStep('manual'), makeStep('message.draft'), makeStep('message.send')])).toBe('A message can only be sent after an approval step.');
    expect(workflowProblem([makeStep('manual'), makeStep('approval'), makeStep('message.send')])).toMatch(/Draft a message/);
    expect(workflowProblem([makeStep('manual'), makeStep('wait', { amount: 'soon' })])).toMatch(/whole number/);
    expect(workflowProblem([makeStep('manual'), makeStep('lead.set_stage', { stage: 'vip' })])).toMatch(/choose a value/);
    expect(workflowProblem([makeStep('manual'), { type: 'Action', label: 'x', kind: 'linkedin.connect' }])).toMatch(/unknown type/);
    // Free-text steps from an older version are allowed; they are skipped when the workflow runs.
    expect(workflowProblem([{ type: 'Trigger', label: 'Lead created' }, { type: 'Action', label: 'Do something' }])).toBeNull();
  });

  it('matches events to triggers, and never to a workflow that caused the event', () => {
    const any = wf([makeStep('lead.stage_changed')]);
    const toInterested = wf([makeStep('lead.stage_changed', { to: 'interested' })]);
    expect(triggeredBy(any, { kind: 'lead.stage_changed', to: 'lost' })).toBe(true);
    expect(triggeredBy(toInterested, { kind: 'lead.stage_changed', to: 'lost' })).toBe(false);
    expect(triggeredBy(toInterested, { kind: 'lead.stage_changed', to: 'interested' })).toBe(true);
    expect(triggeredBy(toInterested, { kind: 'lead.stage_changed', to: 'interested', chain: ['w'] })).toBe(false);
    expect(triggeredBy(toInterested, { kind: 'lead.created' })).toBe(false);
    expect(triggeredBy(wf([makeStep('lead.created')], false), { kind: 'lead.created' })).toBe(false);
  });

  it('fires a schedule once per day, at its time in its own time zone', () => {
    const weekly = wf([makeStep('schedule', { every: 'week', weekday: '1', time: '09:00', zone: 'America/New_York' })]);
    // Monday 30 November 2026: 09:00 in New York is 14:00 UTC.
    expect(scheduleDue(weekly, new Date('2026-11-30T13:59:00Z'), null)).toBeNull();
    expect(scheduleDue(weekly, new Date('2026-11-30T14:00:00Z'), null)).toBe('2026-11-30');
    expect(scheduleDue(weekly, new Date('2026-11-30T14:30:00Z'), '2026-11-30')).toBeNull();
    expect(scheduleDue(weekly, new Date('2026-11-30T18:00:00Z'), null)).toBeNull(); // more than three hours late
    expect(scheduleDue(weekly, new Date('2026-12-01T14:00:00Z'), '2026-11-30')).toBeNull(); // Tuesday
    const daily = wf([makeStep('schedule', { every: 'day', time: '23:30', zone: 'Asia/Dhaka' })]);
    // 23:30 in Dhaka on the 30th is 17:30 UTC; the day recorded is Dhaka's.
    expect(scheduleDue(daily, new Date('2026-11-30T17:45:00Z'), '2026-11-29')).toBe('2026-11-30');
    expect(scheduleDue(wf([makeStep('schedule', { every: 'day', time: '00:00', zone: 'Not/AZone' })]), new Date('2026-11-30T00:10:00Z'), null)).toBe('2026-11-30');
    expect(scheduleDue({ ...daily, on: false }, new Date('2026-11-30T17:45:00Z'), null)).toBeNull();
  });
});
