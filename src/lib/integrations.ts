// Every integration the app offers. The server and the local backend both read this list;
// whether one is connected belongs to the workspace.

import type { IntegrationCategory, IntegrationField } from './types.ts';

export interface CatalogEntry {
  id: string;
  name: string;
  cat: IntegrationCategory;
  desc: string;
  /**
   * provider: an AI provider key · oauth: sign-in at the service · fields: credentials typed in ·
   * hook: nothing to enter; connecting issues an address the other system posts to.
   */
  kind: 'provider' | 'oauth' | 'fields' | 'hook';
  fields?: IntegrationField[];
}

const HOOK_FIELDS: IntegrationField[] = [
  { key: 'url', label: 'Webhook address', placeholder: 'https://…' },
  { key: 'secret', label: 'Signing secret (optional, at least 16 characters)', secret: true, optional: true },
];

export const CATALOG: CatalogEntry[] = [
  { id: 'li', name: 'LinkedIn', cat: 'Social', desc: 'Official OAuth. Approved scopes only. Publishes posts you approve.', kind: 'oauth' },
  { id: 'oa', name: 'OpenAI', cat: 'AI', desc: 'Text and image generation.', kind: 'provider' },
  { id: 'ge', name: 'Google Gemini', cat: 'AI', desc: 'Content generation and research.', kind: 'provider' },
  { id: 'cl', name: 'Anthropic Claude', cat: 'AI', desc: 'Reply suggestions and analysis.', kind: 'provider' },
  { id: 'or', name: 'OpenRouter', cat: 'AI', desc: 'Bring your own key. Free and paid models from many providers.', kind: 'provider' },
  { id: 'hs', name: 'HubSpot', cat: 'CRM', desc: 'Two-way contact sync.', kind: 'oauth' },
  { id: 'sf', name: 'Salesforce', cat: 'CRM', desc: 'Two-way lead sync.', kind: 'oauth' },
  {
    id: 'em', name: 'Email', cat: 'Communication', desc: 'Send replies from your own mailbox and bring incoming mail into the inbox.', kind: 'fields',
    fields: [
      { key: 'from', label: 'Your email address', placeholder: 'you@company.com' },
      { key: 'host', label: 'Outgoing server (SMTP)', placeholder: 'smtp.company.com' },
      { key: 'port', label: 'SMTP port', placeholder: '465 or 587' },
      { key: 'user', label: 'User name', placeholder: 'usually your email address' },
      { key: 'password', label: 'Password or app password', secret: true },
      { key: 'imapHost', label: 'Incoming server (IMAP) — leave empty to send only', placeholder: 'imap.company.com', optional: true },
      { key: 'imapPort', label: 'IMAP port', placeholder: '993', optional: true },
    ],
  },
  {
    id: 'wa', name: 'WhatsApp Cloud API', cat: 'Communication', desc: 'Send and receive messages on your WhatsApp Business number.', kind: 'fields',
    fields: [
      { key: 'phoneNumberId', label: 'Phone number ID', placeholder: 'from Meta for Developers → WhatsApp → API setup' },
      { key: 'token', label: 'Access token', secret: true },
      { key: 'appSecret', label: 'App secret (verifies incoming messages)', secret: true },
    ],
  },
  { id: 'in', name: 'Incoming messages (webhook)', cat: 'Communication', desc: 'An address another system can post messages to, so they appear in the inbox.', kind: 'hook' },
  { id: 'gc', name: 'Google Calendar', cat: 'Communication', desc: 'Follow-up tasks appear in your calendar; moving one there moves the task.', kind: 'oauth' },
  { id: 'n8', name: 'n8n', cat: 'Automation', desc: 'Trigger external workflows by webhook.', kind: 'fields', fields: HOOK_FIELDS },
  { id: 'wh', name: 'Webhooks', cat: 'Developer', desc: 'Signed events for leads, posts and runs.', kind: 'fields', fields: HOOK_FIELDS },
];

export const catalogEntry = (id: string): CatalogEntry | undefined => CATALOG.find((e) => e.id === id);
