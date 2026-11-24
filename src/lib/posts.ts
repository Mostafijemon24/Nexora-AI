import type { Post, PostStatus, RunStatus } from './types';

/** Draft → In review → Approved → Scheduled → Published. One action per status. */
export const NEXT_ACTION: Partial<Record<PostStatus, { label: string; next: PostStatus }>> = {
  Draft: { label: 'Request review', next: 'In review' },
  'In review': { label: 'Approve', next: 'Approved' },
  Approved: { label: 'Schedule', next: 'Scheduled' },
  Scheduled: { label: 'Mark published', next: 'Published' },
};

const TAG: Record<PostStatus | RunStatus, string> = {
  Draft: 'tag-neutral',
  'In review': 'tag-outline',
  Approved: 'tag-accent',
  Scheduled: 'tag-accent',
  Published: 'tag-neutral',
  Completed: 'tag-accent',
  'Awaiting approval': 'tag-outline',
  Waiting: 'tag-outline',
  Stopped: 'tag-neutral',
  Rejected: 'tag-neutral',
  Failed: 'tag-outline',
};
export const statusTag = (s: PostStatus | RunStatus): string => `tag ${TAG[s] ?? 'tag-neutral'}`;

/** The least-loaded day among `days`; earlier days win ties. */
export function leastLoadedDay(days: string[], posts: Post[]): string {
  const load = (d: string) => posts.filter((p) => p.date === d).length;
  return [...days].sort((a, b) => load(a) - load(b))[0];
}

/** Scheduling candidates: the rest of this week after today, or today if the week is over. */
export function schedulableDays(week: string[], today: string): string[] {
  const later = week.filter((d) => d > today);
  return later.length ? later : [today];
}

export const excerpt = (body: string): string => body.split('\n')[0].slice(0, 70);
