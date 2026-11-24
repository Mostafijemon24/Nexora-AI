// Operator commands. Run with: npm run cli -- <command> [options]

import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { publicKeyBase64 } from './crypto.ts';
import { migrate } from './db.ts';
import { createLicense, renewLicense, revokeLicense } from './license/service.ts';
import { seedDemo } from './seed.ts';
import { importLeads } from './workspace/leads.ts';

const HELP = `Nexora AI backend

  keygen                              print fresh secrets for .env and the client's public key
  pubkey                              print the client's public key for the LICENSE_SIGNING_KEY in the environment
  migrate                             apply database migrations
  license:create --email E --name N --workspace W [--plan professional] [--months 1] [--max-devices 1] [--demo]
                                      issue a license (the key is shown once); --demo adds sample workspace data
  license:revoke --key K              revoke a license and sign out every device
  license:renew  --key K [--months 1] extend a license
  leads:import --workspace ID --file leads.csv
                                      import leads from CSV; header: name,company[,title,industry,size,country,email,phone,linkedin,tags,stage]
`;

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

  if (command === 'pubkey') {
    const seed = Buffer.from(process.env.LICENSE_SIGNING_KEY ?? '', 'base64');
    if (seed.length !== 32) throw new Error('LICENSE_SIGNING_KEY is not set to a 32-byte base64 value.');
    return void console.log(publicKeyBase64(seed));
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
        const r = await importLeads(rt.ctx, need('workspace'), await readFile(need('file'), 'utf8'));
        console.log(`Imported ${r.imported} lead${r.imported === 1 ? '' : 's'}; ${r.skipped} skipped (missing name or company).`);
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
