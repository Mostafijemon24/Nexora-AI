import { describe, expect, it } from 'vitest';
import { addDays, dayLabel, longDate, relTime, weekOf } from './dates';

describe('dates', () => {
  const mon = new Date(2026, 10, 23, 9, 41);

  it('builds a Monday-first week', () => {
    expect(weekOf(mon)).toEqual(['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29']);
    expect(weekOf(new Date(2026, 10, 29, 23, 0))[0]).toBe('2026-11-23'); // Sunday belongs to the same week
    expect(weekOf(mon).map(dayLabel)[0]).toBe('Mon 23');
  });

  it('crosses month boundaries', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
  });

  it('formats headings and relative times', () => {
    expect(longDate(mon)).toBe('Monday, 23 November');
    expect(relTime(new Date(2026, 10, 23, 9, 40, 30).toISOString(), mon)).toBe('Just now');
    expect(relTime(new Date(2026, 10, 23, 8, 5).toISOString(), mon)).toBe('08:05');
    expect(relTime(new Date(2026, 10, 22, 22, 0).toISOString(), mon)).toBe('Yesterday');
    expect(relTime(new Date(2026, 10, 20, 12, 0).toISOString(), mon)).toBe('Fri');
  });
});
