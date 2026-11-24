// The first-run tour: a few steps for every page. A page's steps are shown the first time the
// page is opened, and again from the "?" button in the header.

import type { ScreenId } from '../lib/types';
import type { AiTab, ContentTab, SettingsTab } from '../state/store';

export interface TourTabs { aiTab?: AiTab; csTab?: ContentTab; setTab?: SettingsTab }

export interface TourStep {
  /** `data-tour` value of the element to point at. Without one, or when it is not on screen, the step is centred. */
  target?: string;
  title: string;
  body: string;
  /** Tab to open before the step is shown. */
  tabs?: TourTabs;
}

export const TOUR: Record<ScreenId, TourStep[]> = {
  dashboard: [
    {
      title: 'Welcome to Nexora AI',
      body: 'Your workspace starts empty: everything here will come from your own leads, posts and conversations. This tour shows what each page is for. You can skip it at any time.',
    },
    {
      target: 'nav',
      title: 'Seven pages',
      body: 'One page for each part of the work. Every page shows its own short tour the first time you open it.',
    },
    {
      target: 'dash-kpi',
      title: 'Today at a glance',
      body: 'Leads, unread conversations, scheduled posts and active workflows. Select a card to open that page.',
    },
    {
      target: 'dash-range',
      title: 'Date range and layout',
      body: 'Switch between 7, 30 and 90 days. Customize hides the widgets you do not need.',
    },
    {
      target: 'dash-perf',
      title: 'Results fill in as you work',
      body: 'Replies received and the lead funnel start at zero and are counted from your own data.',
    },
    {
      target: 'dash-tasks',
      title: 'Tasks',
      body: 'Follow-ups you create from a conversation are listed here. Tick one off when it is done.',
    },
    {
      target: 'tour-help',
      title: 'See a tour again',
      body: 'This button replays the tour for the page you are on.',
    },
  ],
  ai: [
    {
      target: 'ai-tabs',
      title: 'Three tools on one page',
      body: 'Lead scoring, the AI assistant and your prompt library.',
    },
    {
      target: 'ai-icp',
      tabs: { aiTab: 'scoring' },
      title: 'Describe your target customer',
      body: 'Enter the industry, job titles, company size and location you sell to. Every lead is scored against these criteria as you type.',
    },
    {
      target: 'ai-leads',
      tabs: { aiTab: 'scoring' },
      title: 'Leads ranked by match',
      body: 'Import leads as a CSV on the Integrations page. Each one gets a score and a confidence value; missing data is never guessed.',
    },
    {
      target: 'ai-chat',
      tabs: { aiTab: 'chat' },
      title: 'Ask the assistant',
      body: 'Ask about lead scores, post ideas or which replies to answer first. It only uses data in this workspace.',
    },
    {
      target: 'ai-prompt-new',
      tabs: { aiTab: 'prompts' },
      title: 'Save prompts you reuse',
      body: 'Store a question once, then send it to the assistant with Use.',
    },
  ],
  content: [
    {
      target: 'content-tabs',
      title: 'From idea to calendar',
      body: 'Generate a post, take it through approval, then place it on the week.',
    },
    {
      target: 'content-topic',
      tabs: { csTab: 'gen' },
      title: 'Start with a topic',
      body: 'Enter a topic, an audience and a tone, then generate a draft.',
    },
    {
      target: 'content-edit',
      tabs: { csTab: 'gen' },
      title: 'Edit before you approve',
      body: 'The draft appears here. Change anything, then save it. Nothing is published without your approval.',
    },
    {
      target: 'content-posts',
      tabs: { csTab: 'posts' },
      title: 'Track every post',
      body: 'A post moves from Draft to In review, Approved, Scheduled and Published, one step at a time.',
    },
    {
      target: 'content-cal',
      tabs: { csTab: 'cal' },
      title: 'Plan the week',
      body: 'Scheduled posts appear on their day. Drag a post to another day, or use its arrow buttons.',
    },
  ],
  inbox: [
    {
      target: 'inbox-notice',
      title: 'Where conversations come from',
      body: 'Only manual import and approved connectors. Your LinkedIn private inbox is never accessed.',
    },
    {
      target: 'inbox-list',
      title: 'Your conversations',
      body: 'Search them, or filter by unread and important. This list is empty until a conversation arrives.',
    },
    {
      target: 'inbox-thread',
      title: 'Reply with help',
      body: 'An open conversation shows its intent, a suggested reply that needs your approval, and internal notes. Create follow-up adds a task to the dashboard.',
    },
  ],
  automation: [
    {
      target: 'auto-list',
      title: 'Your workflows',
      body: 'Create a workflow with + New. Each one can be switched on or off from this list.',
    },
    {
      target: 'auto-editor',
      title: 'Build it step by step',
      body: 'A workflow starts with a trigger. Add conditions, delays, approvals and actions after it. Actions LinkedIn does not permit are not offered.',
    },
    {
      target: 'auto-runs',
      title: 'Run history',
      body: 'Every workflow has a Test run button and a history of its runs. A run with an approval step waits until you approve it.',
    },
  ],
  integrations: [
    {
      target: 'int-strategy',
      title: 'How LinkedIn is handled',
      body: 'Only the official API and actions you control. No password collection, no scraping, no automated clicking.',
    },
    {
      target: 'int-import',
      title: 'Import your leads',
      body: 'A good first step: choose a CSV with name and company columns. Title, industry, size and country are optional. The leads are scored on the AI Intelligence page.',
    },
    {
      target: 'int-list',
      title: 'Connect your tools',
      body: 'AI providers, CRM, messaging and automation services. Filter by category, then choose Connect.',
    },
  ],
  settings: [
    {
      target: 'set-tabs',
      title: 'Settings sections',
      body: 'Profile, AI providers, security, sync, license and appearance.',
    },
    {
      target: 'set-panel',
      tabs: { setTab: 'profile' },
      title: 'Start with your profile',
      body: 'Add your name, email and workspace name. Your name is used in greetings and the workspace name in your brand voice.',
    },
    {
      target: 'set-panel',
      tabs: { setTab: 'ai' },
      title: 'AI providers',
      body: 'Choose which provider handles each task, add its key and press Test.',
    },
    {
      target: 'set-panel',
      tabs: { setTab: 'license' },
      title: 'Your license',
      body: 'Your plan and the device it is active on. Deactivate here before you move the license to another device.',
    },
  ],
};
