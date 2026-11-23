import { z } from 'zod';

const b64len = (n: number, what: string) =>
  z.string().refine((s) => Buffer.from(s, 'base64').length === n, `${what} must be ${n} bytes, base64-encoded`);

const Env = z.object({
  DATABASE_URL: z.string().min(1),
  LICENSE_SIGNING_KEY: b64len(32, 'LICENSE_SIGNING_KEY'),
  DATA_ENCRYPTION_KEY: b64len(32, 'DATA_ENCRYPTION_KEY'),
  HASH_SECRET: z.string().min(24, 'HASH_SECRET must be at least 24 characters'),
  PORT: z.coerce.number().int().default(8787),
  PUBLIC_API_URL: z.string().url().default('http://localhost:8787'),
  APP_ORIGINS: z.string().default('http://localhost:1420'),
  REDIS_URL: z.string().optional(),
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default('Nexora AI <no-reply@nexora.example>'),
  TRUST_PROXY: z.string().default('0'),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  GEMINI_MODEL: z.string().default('gemini-2.0-flash'),
  ANTHROPIC_MODEL: z.string().default('claude-opus-5-5'),
});

export interface Config {
  databaseUrl: string;
  licenseSigningKey: Buffer;
  dataEncryptionKey: Buffer;
  hashSecret: string;
  port: number;
  publicApiUrl: string;
  /** Web origins allowed to call the API with cookies. The first one receives OAuth redirects. */
  appOrigins: string[];
  redisUrl?: string;
  smtpUrl?: string;
  mailFrom: string;
  trustProxy: boolean;
  models: { openai: string; gemini: string; anthropic: string };
  /** Raw environment, for per-integration OAuth settings. */
  env: Record<string, string | undefined>;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${lines}`);
  }
  const e = parsed.data;
  return {
    databaseUrl: e.DATABASE_URL,
    licenseSigningKey: Buffer.from(e.LICENSE_SIGNING_KEY, 'base64'),
    dataEncryptionKey: Buffer.from(e.DATA_ENCRYPTION_KEY, 'base64'),
    hashSecret: e.HASH_SECRET,
    port: e.PORT,
    publicApiUrl: e.PUBLIC_API_URL.replace(/\/+$/, ''),
    appOrigins: e.APP_ORIGINS.split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean),
    redisUrl: e.REDIS_URL || undefined,
    smtpUrl: e.SMTP_URL || undefined,
    mailFrom: e.MAIL_FROM,
    trustProxy: e.TRUST_PROXY === '1',
    models: { openai: e.OPENAI_MODEL, gemini: e.GEMINI_MODEL, anthropic: e.ANTHROPIC_MODEL },
    env,
  };
}
