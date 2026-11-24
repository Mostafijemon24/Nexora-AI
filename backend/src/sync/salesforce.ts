// Salesforce Lead records ↔ leads, through the REST API of the org the user signed in to.

import type { Lead, LeadStage } from '../../../src/lib/types.ts';
import { joinName, splitName, str, SyncError, type Api } from './common.ts';
import type { CrmAdapter, RemoteLead } from './leads.ts';

const FIELDS = 'Id, FirstName, LastName, Company, Title, Email, Phone, Industry, Country, NumberOfEmployees, Status, IsConverted, LastModifiedDate';

function base(api: Api, version: string): string {
  const url = api.tokens.instance_url;
  if (typeof url !== 'string' || !/^https:\/\/[a-z0-9.-]+\.(salesforce|force)\.com\/?$/i.test(url)) throw new SyncError('Salesforce did not say which org to use. Reconnect it.');
  return `${url.replace(/\/+$/, '')}/services/data/${version}`;
}

/** Salesforce's default lead statuses. An org's own statuses leave the stage alone. */
const TO_STAGE: Record<string, LeadStage> = {
  'open - not contacted': 'new', 'working - contacted': 'contacted', 'closed - converted': 'converted', 'closed - not converted': 'lost',
};
/** "Converted" cannot be set through the API (Salesforce converts a lead in its own flow), and "Interested" has no default status. */
const FROM_STAGE: Partial<Record<LeadStage, string>> = { new: 'Open - Not Contacted', contacted: 'Working - Contacted', lost: 'Closed - Not Converted' };

function record(l: Lead): Record<string, unknown> {
  const { first, last } = splitName(l.name);
  const r: Record<string, unknown> = { FirstName: first || null, LastName: last, Company: l.company };
  if (l.title) r.Title = l.title;
  if (l.email) r.Email = l.email;
  if (l.phone) r.Phone = l.phone;
  if (l.industry) r.Industry = l.industry;
  if (l.country) r.Country = l.country;
  if (l.size) r.NumberOfEmployees = l.size;
  if (FROM_STAGE[l.stage]) r.Status = FROM_STAGE[l.stage];
  return r;
}

const reason = (json: any): string => (Array.isArray(json) && typeof json[0]?.message === 'string' ? `: ${json[0].message.slice(0, 160)}` : '');
const fail = (what: string, r: { status: number; json: any }): never => { throw new SyncError(`Salesforce could not ${what} (${r.status}${reason(r.json)}).`); };

export function salesforce(version = 'v60.0'): CrmAdapter {
  return {
    id: 'sf', name: 'Salesforce',

    async pull(api, since, cursor) {
      // A cursor is the path Salesforce gave for the next page of the same query.
      const url = cursor
        ? `${String(api.tokens.instance_url).replace(/\/+$/, '')}${cursor}`
        : `${base(api, version)}/query?q=${encodeURIComponent(`SELECT ${FIELDS} FROM Lead WHERE LastModifiedDate > ${new Date(since).toISOString().replace(/\.\d{3}Z$/, 'Z')} ORDER BY LastModifiedDate ASC LIMIT 200`)}`;
      if (cursor && !/^\/services\/data\/v\d+\.\d\/query\/[\w-]+$/.test(cursor)) throw new SyncError('Salesforce returned an unexpected page address.');
      const r = await api.call(url);
      if (!r.ok) fail('list leads', r);
      const records: RemoteLead[] = (Array.isArray(r.json?.records) ? r.json.records : []).map((x: any): RemoteLead => ({
        id: String(x.Id), modifiedAt: new Date(x.LastModifiedDate).toISOString(), name: joinName(x.FirstName, x.LastName), company: str(x.Company), title: str(x.Title),
        email: str(x.Email, 320), phone: str(x.Phone, 40), industry: str(x.Industry), country: str(x.Country),
        size: Number.isInteger(x.NumberOfEmployees) && x.NumberOfEmployees > 0 ? x.NumberOfEmployees : null,
        stage: x.IsConverted ? 'converted' : TO_STAGE[String(x.Status ?? '').toLowerCase()] ?? null,
      }));
      return { records, next: r.json?.done === false && typeof r.json?.nextRecordsUrl === 'string' ? r.json.nextRecordsUrl : null };
    },

    blocked: () => null,

    async create(api, lead) {
      const r = await api.call(`${base(api, version)}/sobjects/Lead`, { method: 'POST', body: record(lead) });
      if (!r.ok || !r.json?.id) fail('create a lead', r);
      return String(r.json.id);
    },

    async update(api, remoteId, lead) {
      const r = await api.call(`${base(api, version)}/sobjects/Lead/${encodeURIComponent(remoteId)}`, { method: 'PATCH', body: record(lead) });
      // 404: deleted. A converted lead can no longer be edited; it stays linked and is left alone.
      if (r.status === 404) return false;
      if (!r.ok && !(Array.isArray(r.json) && r.json[0]?.errorCode === 'CANNOT_UPDATE_CONVERTED_LEAD')) fail('update a lead', r);
      return true;
    },
  };
}
