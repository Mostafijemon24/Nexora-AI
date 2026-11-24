// HubSpot contacts ↔ leads, through the CRM v3 API.

import type { Lead, LeadStage } from '../../../src/lib/types.ts';
import { joinName, splitName, str, SyncError, type Api } from './common.ts';
import type { CrmAdapter, RemoteLead } from './leads.ts';

const BASE = 'https://api.hubapi.com/crm/v3/objects/contacts';
const PROPS = ['firstname', 'lastname', 'email', 'phone', 'company', 'jobtitle', 'industry', 'country', 'numemployees', 'hs_lead_status', 'lastmodifieddate'];

/** HubSpot's standard "Lead status" values. A status this map does not know leaves the stage alone. */
const TO_STAGE: Record<string, LeadStage> = {
  NEW: 'new', OPEN: 'new', ATTEMPTED_TO_CONTACT: 'contacted', IN_PROGRESS: 'contacted', CONNECTED: 'interested', OPEN_DEAL: 'converted', UNQUALIFIED: 'lost', BAD_TIMING: 'lost',
};
const FROM_STAGE: Record<LeadStage, string> = { new: 'NEW', contacted: 'ATTEMPTED_TO_CONTACT', interested: 'CONNECTED', converted: 'OPEN_DEAL', lost: 'UNQUALIFIED' };

function properties(l: Lead): Record<string, string> {
  const { first, last } = splitName(l.name);
  const p: Record<string, string> = { firstname: first, lastname: last, company: l.company, hs_lead_status: FROM_STAGE[l.stage] };
  if (l.email) p.email = l.email;
  if (l.phone) p.phone = l.phone;
  if (l.title) p.jobtitle = l.title;
  if (l.country) p.country = l.country;
  return p;
}

const fail = (what: string, r: { status: number; json: any }): never => {
  throw new SyncError(`HubSpot could not ${what} (${r.status}${typeof r.json?.message === 'string' ? `: ${r.json.message.slice(0, 160)}` : ''}).`);
};

export const hubspot: CrmAdapter = {
  id: 'hs', name: 'HubSpot',

  async pull(api: Api, since, cursor) {
    const r = await api.call(`${BASE}/search`, { method: 'POST', body: {
      filterGroups: [{ filters: [{ propertyName: 'lastmodifieddate', operator: 'GT', value: String(Date.parse(since)) }] }],
      sorts: [{ propertyName: 'lastmodifieddate', direction: 'ASCENDING' }], properties: PROPS, limit: 100, ...(cursor ? { after: cursor } : {}),
    } });
    if (!r.ok) fail('list contacts', r);
    const records: RemoteLead[] = (Array.isArray(r.json?.results) ? r.json.results : []).map((c: any): RemoteLead => {
      const p = c.properties ?? {};
      const size = Number(p.numemployees);
      return {
        id: String(c.id), modifiedAt: new Date(p.lastmodifieddate ?? c.updatedAt ?? 0).toISOString(), name: joinName(p.firstname, p.lastname) || (str(p.email) ?? ''),
        company: str(p.company), title: str(p.jobtitle), email: str(p.email, 320), phone: str(p.phone, 40), industry: str(p.industry), country: str(p.country),
        size: Number.isInteger(size) && size > 0 ? size : null, stage: TO_STAGE[String(p.hs_lead_status ?? '').toUpperCase()] ?? null,
      };
    });
    return { records, next: typeof r.json?.paging?.next?.after === 'string' ? r.json.paging.next.after : null };
  },

  // HubSpot identifies a contact by its email address; without one every sync would add a duplicate.
  blocked: (l) => (l.email ? null : 'they have no email address'),

  async create(api, lead) {
    const r = await api.call(BASE, { method: 'POST', body: { properties: properties(lead) } });
    if (r.ok && r.json?.id) return String(r.json.id);
    // 409: a contact with this email already exists. Link to it and bring it up to date.
    const existing = r.status === 409 ? /Existing ID:\s*(\d+)/i.exec(String(r.json?.message ?? ''))?.[1] : undefined;
    if (!existing) return fail('create a contact', r);
    await this.update(api, existing, lead);
    return existing;
  },

  async update(api, remoteId, lead) {
    const r = await api.call(`${BASE}/${encodeURIComponent(remoteId)}`, { method: 'PATCH', body: { properties: properties(lead) } });
    if (r.status === 404) return false;
    if (!r.ok) fail('update a contact', r);
    return true;
  },
};
