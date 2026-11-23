// Sample workspace content for development and demos (the data shown in the design prototype).
// Never run automatically: `npm run cli -- license:create --demo` opts in.

import { randomUUID } from 'node:crypto';
import type { Q } from './db.ts';

export async function seedDemo(q: Q, w: string, now: Date): Promise<void> {
  const at = (dayOffset: number, h: number, m: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayOffset, h, m)).toISOString();
  const day = (offset: number) => at(offset, 0, 0).slice(0, 10);

  await q.query(`UPDATE workspaces SET icp = $2, routing = $3, mfa = true WHERE id = $1`, [w,
    JSON.stringify({ industry: 'Marketing', title: 'Founder, CEO', sizeMin: '10', sizeMax: '100', location: 'United States' }),
    JSON.stringify({ 'Content generation': 'Google Gemini', 'Lead research': 'OpenAI', 'Reply suggestions': 'OpenAI' })]);

  const leads: [string, string | null, string, string | null, number | null, string | null, string, number][] = [
    ['John Smith', 'Founder', 'Brightlane Media', 'Marketing & Advertising', 42, 'United States', 'interested', -1],
    ['Sarah Johnson', 'CEO', 'Peak Digital', 'Marketing', 130, 'United States', 'contacted', -2],
    ['David Miller', 'Head of Growth', 'Orbit Labs', 'Software', 60, 'Canada', 'converted', -3],
    ['Priya Nair', 'Founder & CEO', 'Signal Works', 'Marketing', null, 'United States', 'new', -4],
    ['Tom Becker', 'Marketing Director', 'Kiln Studio', null, 18, 'Germany', 'new', -5],
    ['Aisha Rahman', 'CEO', 'Delta Reach', 'Marketing', 75, null, 'contacted', -20],
  ];
  for (const [name, title, company, industry, size, country, status, off] of leads) {
    await q.query('INSERT INTO leads (workspace_id, name, title, company, industry, size, country, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [w, name, title, company, industry, size, country, status, at(off, 9, 0)]);
  }

  const prompts = [['Top leads today', 'Which leads score highest against my target criteria?'], ['Post idea', 'Suggest a post hook for marketing agency founders.'], ['Inbox triage', 'Which replies should I answer first?']];
  for (const [i, [title, text]] of prompts.entries()) await q.query('INSERT INTO prompts (id, workspace_id, title, text, created_at) VALUES ($1,$2,$3,$4,$5)', [randomUUID(), w, title, text, at(-10, 9, i)]);

  const posts: [string, string, string, string | null][] = [
    ['3 outreach mistakes agencies make', 'Most agencies pitch before they listen.', 'Scheduled', day(1)],
    ['Why lead scoring beats list size', 'A list of 500 means little without fit.', 'In review', null],
    ['14 calls from 200 leads', 'What we changed in the follow-up plan.', 'Draft', null],
    ['Brand voice checklist', 'Five questions to keep every post consistent.', 'Published', day(0)],
  ];
  for (const [i, [title, body, status, date]] of posts.entries()) await q.query('INSERT INTO posts (id, workspace_id, title, body, status, date, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [randomUUID(), w, title, body, status, date, at(-5, 9, 10 - i)]);

  const convs = [
    { name: 'John Smith', company: 'Brightlane Media', channel: 'Email', unread: true, important: true, intent: 'Pricing request', sentiment: 'Positive',
      suggestion: 'Thanks John — happy to share pricing. Would a 20-minute call on Thursday work to match a plan to your team size?',
      msgs: [{ me: false, text: 'Hello! Can you share your pricing?', at: at(0, 9, 2) }], notes: ['Asked about team plan last month.'] },
    { name: 'Sarah Johnson', company: 'Peak Digital', channel: 'Manual import', unread: true, important: false, intent: 'Information request', sentiment: 'Neutral',
      suggestion: 'Hi Sarah — here is a short overview of how we work with agencies. Which service matters most to you right now?',
      msgs: [{ me: true, text: 'Hi Sarah, thanks for connecting.', at: at(-3, 15, 0) }, { me: false, text: 'Please share details about your services.', at: at(0, 8, 47) }], notes: [] },
    { name: 'David Miller', company: 'Orbit Labs', channel: 'WhatsApp', unread: false, important: false, intent: 'Meeting', sentiment: 'Positive',
      suggestion: 'Great — I have Wednesday 3pm or Thursday 11am open. Which suits you?',
      msgs: [{ me: false, text: 'Let’s schedule a call.', at: at(-1, 16, 30) }], notes: [] },
  ];
  for (const [i, c] of convs.entries()) {
    await q.query('INSERT INTO conversations (id, workspace_id, name, company, channel, unread, important, intent, sentiment, suggestion, msgs, notes, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
      [randomUUID(), w, c.name, c.company, c.channel, c.unread, c.important, c.intent, c.sentiment, c.suggestion, JSON.stringify(c.msgs), JSON.stringify(c.notes), at(-6, 9, i)]);
  }

  const replies = [['Pricing overview', 'Thanks for asking — our plans start at $9 per month. I can send a one-page comparison if helpful.'], ['Book a call', 'Happy to walk you through it. Here are two slots: Wednesday 3pm or Thursday 11am.'], ['Send details', 'Sharing a short overview of our services below. Tell me which part is most relevant.']];
  for (const [i, [title, text]] of replies.entries()) await q.query('INSERT INTO saved_replies (workspace_id, title, text, position) VALUES ($1,$2,$3,$4)', [w, title, text, i]);

  const workflows: [string, boolean, [string, string][]][] = [
    ['Score and draft for new leads', true, [['Trigger', 'Lead created'], ['Condition', 'Lead score greater than 70'], ['Action', 'Create AI message draft'], ['Approval', 'Request user approval'], ['Update', 'Change lead status to Contacted']]],
    ['Follow-up reminder', true, [['Trigger', 'Reply received'], ['Delay', 'Wait 24 hours'], ['Notification', 'Notify assigned user']]],
    ['Weekly content review', false, [['Trigger', 'Every Monday 09:00'], ['Notification', 'Notify workspace of drafts in review']]],
  ];
  for (const [i, [name, enabled, steps]] of workflows.entries()) {
    await q.query('INSERT INTO workflows (id, workspace_id, name, enabled, steps, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [randomUUID(), w, name, enabled, JSON.stringify(steps.map(([type, label]) => ({ type, label }))), at(-8, 9, i)]);
  }

  const tasks = [['Follow up with Sarah Johnson', 'Today'], ['Publish “3 outreach mistakes” manually', 'Tue'], ['Review AI drafts awaiting approval', 'Wed']];
  for (const [i, [text, due]] of tasks.entries()) await q.query('INSERT INTO tasks (id, workspace_id, text, due, created_at) VALUES ($1,$2,$3,$4,$5)', [randomUUID(), w, text, due, at(-1, 9, 10 - i)]);
}
