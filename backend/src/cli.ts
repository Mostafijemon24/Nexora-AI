// Operator commands. Run with: npm run cli -- <command> [options]

import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { publicKeyBase64 } from './crypto.ts';
import { migrate } from './db.ts';
import { createLicense, renewLicense, revokeLicense } from './license/service.ts';
import { seedDemo } from './seed.ts';

const HELP = `Nexora AI backend

  keygen                              print fresh secrets for .env and the client's public key
  migrate                             apply database migrations
  license:create --email E --name N --workspace W [--plan professional] [--months 1] [--max-devices 1] [--demo]
                                      issue a license (the key is shown once); --demo adds sample workspace data
  license:revoke --key K              revoke a license and sign out every device
  license:renew  --key K [--months 1] extend a license
  leads:import --workspace ID --file leads.csv
                                      import leads from CSV with the header: name,title,company,industry,size,country
`;

/** Minimal RFC 4180 reader: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') quoted = false; else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim())) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim())) rows.push(row);
  return rows;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values: o } = parseArgs({
    args: rest, strict: true,
    options: {
      email: { type: 'string' }, name: { type: 'string' }, workspace: { type: 'string' }, plan: { type: 'string', default: 'professional' },
      months: { type: 'string', default: '1' }, 'max-devices': { type: 'string', default: '1' }, key: { type: 'string' }, file: { type: 'string' },
      demo: { type: 'boolean', default: false },
    },
  });
  const need = (k: keyof typeof o): string => { const v = o[k]; if (typeof v !== 'string' || !v) throw new Error(`--${k} is required`); return v; };
  const months = Number(o.months);
  if (!Number.isInteger(months) || months < 1) throw new Error('--months must be a whole number of at least 1');

  if (!command || command === 'help' || command === '--help') return void console.log(HELP);
  if (command === 'keygen') {
    const seed = randomBytes(32);
    console.log(`# Server .env\nLICENSE_SIGNING_KEY=${seed.toString('base64')}\nDATA_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}\nHASH_SECRET=${randomBytes(36).toString('base64url')}\n`);
    console.log(`# Native client build environment\nNEXORA_LICENSE_PUBLIC_KEY=${publicKeyBase64(seed)}`);
    return;
  }

  const { createRuntime } = await import('./runtime.ts');
  const rt = createRuntime();
  try {
    switch (command) {
      case 'migrate': {
        const applied = await migrate(rt.db);
        console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
        break;
      }
      case 'license:create': {
        const maxDevices = Number(o['max-devices']);
        const r = await createLicense(rt.ctx, { email: need('email'), name: need('name'), workspace: need('workspace'), plan: o.plan!, months, maxDevices });
        if (o.demo) await seedDemo(rt.db, r.workspaceId, new Date());
        console.log(`License key (shown once): ${r.key}\nWorkspace: ${r.workspaceId}${o.demo ? '\nSample data added.' : ''}`);
        break;
      }
      case 'license:revoke':
        console.log((await revokeLicense(rt.ctx, need('key'))) ? 'License revoked.' : 'No active license matches that key.');
        break;
      case 'license:renew': {
        const end = await renewLicense(rt.ctx, need('key'), months);
        console.log(end ? `Renewed until ${end.toISOString().slice(0, 10)}.` : 'No license matches that key.');
        break;
      }
      case 'leads:import': {
        const w = need('workspace');
        const [header, ...rows] = parseCsv(await readFile(need('file'), 'utf8'));
        const col = (n: string) => header.findIndex((h) => h.trim().toLowerCase() === n);
        const idx = { name: col('name'), title: col('title'), company: col('company'), industry: col('industry'), size: col('size'), country: col('country') };
        if (idx.name < 0 || idx.company < 0) throw new Error('The CSV needs at least "name" and "company" columns.');
        const cell = (r: string[], i: number) => (i >= 0 && r[i]?.trim() ? r[i].trim() : null);
        let n = 0;
        for (const r of rows) {
          const name = cell(r, idx.name), company = cell(r, idx.company);
          if (!name || !company) continue;
          const size = Number(cell(r, idx.size));
          await rt.db.query('INSERT INTO leads (workspace_id, name, title, company, industry, size, country) VALUES ($1,$2,$3,$4,$5,$6,$7)',
            [w, name, cell(r, idx.title), company, cell(r, idx.industry), Number.isInteger(size) && size > 0 ? size : null, cell(r, idx.country)]);
          n++;
        }
        console.log(`Imported ${n} lead${n === 1 ? '' : 's'}; ${rows.length - n} skipped (missing name or company).`);
        break;
      }
      default:
        throw new Error(`Unknown command "${command}".\n\n${HELP}`);
    }
  } finally {
    await rt.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
