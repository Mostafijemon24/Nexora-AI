// The first-run tour: a few steps for every page. A page's steps are shown the first time the
// page is opened, and again from the "?" button in the header.

import type { ScreenId } from '../lib/types';
import type { AiTab, ContentTab, LeadsTab, SettingsTab } from '../state/store';

export interface TourTabs { aiTab?: AiTab; csTab?: ContentTab; setTab?: SettingsTab; leadsTab?: LeadsTab }

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
      title: 'Nine pages',
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
  leads: [
    {
      target: 'leads-tabs',
      title: 'Your leads, three ways',
      body: 'A list you can search and filter, a pipeline by stage, and campaigns that group leads around one goal.',
    },
    {
      target: 'leads-tools',
      tabs: { leadsTab: 'list' },
      title: 'Add, import and export',
      body: 'Add a lead by hand or import a CSV with name and company columns. Export gives you the list you are looking at, with scores, as a spreadsheet file.',
    },
    {
      target: 'leads-table',
      tabs: { leadsTab: 'list' },
      title: 'Open a lead, or change many at once',
      body: 'Select a name to see and edit its details, tags and notes. Tick several leads to move them to a stage, tag them, add them to a campaign or delete them together.',
    },
    {
      target: 'leads-pipeline',
      tabs: { leadsTab: 'pipeline' },
      title: 'Move leads through the pipeline',
      body: 'New, Contacted, Interested, Converted and Lost. Drag a lead to another stage or use its arrow buttons. A stage change can start a workflow.',
    },
    {
      target: 'leads-campaigns',
      tabs: { leadsTab: 'campaigns' },
      title: 'Measure a campaign',
      body: 'Create a campaign, add leads to it from the list, and see how many were contacted, replied and converted.',
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
      body: 'Every lead on the Leads page gets a score and a confidence value here; missing data is never guessed.',
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
      body: 'From the email and WhatsApp accounts you connect, from workflows, and from what you add yourself. Your LinkedIn private inbox is never accessed.',
    },
    {
      target: 'inbox-list',
      title: 'Your conversations',
      body: 'Search them, or filter by unread and important. This list is empty until a conversation arrives.',
    },
    {
      target: 'inbox-thread',
      title: 'Reply with help',
      body: 'Write a reply or use the suggested one. It is sent by email or WhatsApp when that channel is connected and the conversation has an address; otherwise it is kept here and marked as not sent. Create follow-up adds a task to the dashboard.',
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
      body: 'A workflow starts with a trigger: a new lead, a stage change, a received message, a post status or a schedule. Add conditions, waits, approvals and actions after it, each with its own settings. Actions LinkedIn does not permit are not offered.',
    },
    {
      target: 'auto-runs',
      title: 'Run history',
      body: 'A workflow that is switched on runs by itself when its trigger fires. Test run shows what each step would do without changing anything. A run with an approval step waits until you approve or reject it.',
    },
  ],
  reports: [
    {
      target: 'rep-range',
      title: 'Choose the period',
      body: 'The report covers leads added, and messages and workflow runs dated, in the last 7, 30 or 90 days.',
    },
    {
      target: 'rep-rates',
      title: 'How outreach is going',
      body: 'The share of leads you contacted, of contacted leads who replied, and of all leads who converted. A rate shows a dash until there is something to measure.',
    },
    {
      target: 'rep-ai',
      title: 'AI usage and cost',
      body: 'Requests, tokens and cost for each AI provider this month. With no server connected, nothing is sent to a provider, so this stays at zero.',
    },
    {
      target: 'rep-export',
      title: 'Take the numbers with you',
      body: 'Export the report, or every lead with its score, as a CSV file for a spreadsheet.',
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
      body: 'Choose a CSV with name and company columns. Title, industry, size, country, email, phone, tags and stage are optional. The leads appear on the Leads page with a score.',
    },
    {
      target: 'int-list',
      title: 'Connect your tools',
      body: 'AI providers, CRM, email, WhatsApp and automation services. Filter by category, then choose Connect. Connecting needs a Nexora AI server, so it is switched off in a build that runs without one.',
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
      body: 'Choose which provider handles each task, add its key and press Test. Keys are stored on the Nexora AI server, so they can be added once a server is connected.',
    },
    {
      target: 'set-panel',
      tabs: { setTab: 'license' },
      title: 'Your license',
      body: 'Your plan and the device it is active on. Deactivate here before you move the license to another device.',
    },
  ],
};
