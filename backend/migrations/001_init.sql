-- Nexora AI schema. Every tenant-owned row carries workspace_id; the API scopes every query by it.

CREATE TABLE workspaces (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                      text NOT NULL,
  brand_voice               text NOT NULL DEFAULT 'plain, specific, no hype',
  automation_daily_run_limit integer NOT NULL DEFAULT 500 CHECK (automation_daily_run_limit >= 0),
  icp                       jsonb NOT NULL DEFAULT '{"industry":"","title":"","sizeMin":"","sizeMax":"","location":""}',
  routing                   jsonb NOT NULL DEFAULT '{"Content generation":"OpenAI","Lead research":"OpenAI","Reply suggestions":"OpenAI"}',
  openrouter                jsonb NOT NULL DEFAULT '{"defaultModel":"","fallbackModel":"","monthlyBudgetUsd":"20"}',
  sync                      jsonb NOT NULL DEFAULT '{"region":"Singapore","endpoint":"","offlineCache":true,"conflict":"ask"}',
  mfa                       boolean NOT NULL DEFAULT false,
  created_at                timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email        text NOT NULL,
  name         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));
CREATE INDEX users_workspace_idx ON users (workspace_id);

-- ── billing and licensing ────────────────────────────────────────────────
CREATE TABLE subscription_plans (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  period      text NOT NULL DEFAULT 'month' CHECK (period IN ('month', 'year')),
  max_devices integer NOT NULL DEFAULT 1 CHECK (max_devices >= 1),
  features    jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO subscription_plans (code, name, price_cents) VALUES
  ('starter', 'Starter', 900), ('professional', 'Professional', 2900), ('business', 'Business', 7900);

CREATE TABLE subscriptions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plan_id            uuid NOT NULL REFERENCES subscription_plans(id),
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'past_due', 'canceled')),
  current_period_end timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subscriptions_workspace_idx ON subscriptions (workspace_id);

CREATE TABLE licenses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subscription_id uuid NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  owner_user_id   uuid NOT NULL REFERENCES users(id),
  key_hash        text NOT NULL UNIQUE,      -- HMAC of the key; the key itself is never stored
  key_last4       text NOT NULL,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX licenses_workspace_idx ON licenses (workspace_id);

-- Per-license overrides of plan defaults, e.g. feature 'max_devices' → 3.
CREATE TABLE license_entitlements (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  license_id uuid NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
  feature    text NOT NULL,
  value      jsonb NOT NULL,
  UNIQUE (license_id, feature)
);

CREATE TABLE license_devices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text NOT NULL CHECK (kind IN ('web', 'native')),
  client_ref   text,                         -- native: the install's registration id
  platform     text NOT NULL,
  name         text NOT NULL,
  os           text NOT NULL,
  ua_hash      text,                         -- web: binds the device cookie to one browser
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'native') = (client_ref IS NOT NULL))
);
CREATE UNIQUE INDEX license_devices_client_ref_key ON license_devices (client_ref) WHERE client_ref IS NOT NULL;

CREATE TABLE license_activations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  license_id          uuid NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
  device_id           uuid NOT NULL REFERENCES license_devices(id),
  slot                integer NOT NULL CHECK (slot >= 0),
  activated_at        timestamptz NOT NULL DEFAULT now(),
  last_validated_at   timestamptz NOT NULL DEFAULT now(),
  deactivated_at      timestamptz,
  deactivation_reason text CHECK (deactivation_reason IN ('user', 'transferred', 'revoked', 'admin'))
);
-- The database itself refuses a second concurrent activation of the same seat or the same device,
-- whatever the application code does.
CREATE UNIQUE INDEX license_activations_active_slot_key ON license_activations (license_id, slot) WHERE deactivated_at IS NULL;
CREATE UNIQUE INDEX license_activations_active_device_key ON license_activations (license_id, device_id) WHERE deactivated_at IS NULL;
CREATE INDEX license_activations_device_idx ON license_activations (device_id);

CREATE TABLE license_transfers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  license_id  uuid NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
  device_id   uuid NOT NULL REFERENCES license_devices(id),
  code_hash   text NOT NULL,
  attempts    integer NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX license_transfers_lookup_idx ON license_transfers (license_id, device_id, created_at DESC);

-- Audit log. license_id is null when the presented key matched nothing.
CREATE TABLE license_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq        bigserial NOT NULL,           -- insertion order, for a stable audit trail
  license_id uuid REFERENCES licenses(id) ON DELETE CASCADE,
  device_id  uuid REFERENCES license_devices(id),
  type       text NOT NULL CHECK (type IN ('activated', 'activation_failed', 'deactivated', 'transfer_requested',
                                           'transferred', 'transfer_failed', 'revoked', 'renewed', 'created')),
  detail     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX license_events_license_idx ON license_events (license_id, seq DESC);

CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id     uuid NOT NULL REFERENCES license_devices(id),
  activation_id uuid NOT NULL REFERENCES license_activations(id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz
);
CREATE INDEX sessions_workspace_idx ON sessions (workspace_id);
CREATE INDEX sessions_activation_idx ON sessions (activation_id);

CREATE TABLE usage_records (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  license_id    uuid REFERENCES licenses(id) ON DELETE SET NULL,
  kind          text NOT NULL CHECK (kind IN ('chat', 'post', 'draft')),
  provider      text NOT NULL,
  model         text NOT NULL,
  input_tokens  integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  cost_usd      numeric(12, 6),              -- null when the provider did not report a cost
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_records_workspace_idx ON usage_records (workspace_id, created_at DESC);

-- ── workspace data ───────────────────────────────────────────────────────
CREATE TABLE leads (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         text NOT NULL,
  title        text,
  company      text NOT NULL,
  industry     text,
  size         integer,
  country      text,
  status       text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'interested', 'converted')),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX leads_workspace_idx ON leads (workspace_id, created_at);

CREATE TABLE prompts (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title        text NOT NULL,
  text         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX prompts_workspace_idx ON prompts (workspace_id, created_at);

CREATE TABLE posts (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title        text NOT NULL,
  body         text NOT NULL,
  status       text NOT NULL CHECK (status IN ('Draft', 'In review', 'Approved', 'Scheduled', 'Published')),
  date         date,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX posts_workspace_idx ON posts (workspace_id, created_at DESC);

CREATE TABLE conversations (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         text NOT NULL,
  company      text NOT NULL,
  channel      text NOT NULL,
  unread       boolean NOT NULL DEFAULT true,
  important    boolean NOT NULL DEFAULT false,
  intent       text NOT NULL DEFAULT '',
  sentiment    text NOT NULL DEFAULT '',
  suggestion   text NOT NULL DEFAULT '',
  msgs         jsonb NOT NULL DEFAULT '[]',
  notes        jsonb NOT NULL DEFAULT '[]',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_workspace_idx ON conversations (workspace_id, created_at);

CREATE TABLE saved_replies (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title        text NOT NULL,
  text         text NOT NULL,
  position     integer NOT NULL DEFAULT 0
);
CREATE INDEX saved_replies_workspace_idx ON saved_replies (workspace_id, position);

CREATE TABLE workflows (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         text NOT NULL,
  enabled      boolean NOT NULL DEFAULT false,
  steps        jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workflows_workspace_idx ON workflows (workspace_id, created_at);

CREATE TABLE runs (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_id  uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  name         text NOT NULL,
  steps        integer NOT NULL,
  status       text NOT NULL CHECK (status IN ('Completed', 'Awaiting approval')),
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX runs_workspace_idx ON runs (workspace_id, at DESC);

CREATE TABLE tasks (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  text         text NOT NULL,
  due          text NOT NULL DEFAULT '',
  done         boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tasks_workspace_idx ON tasks (workspace_id, created_at DESC);

CREATE TABLE activity (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  text         text NOT NULL,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_workspace_idx ON activity (workspace_id, at DESC);

-- Bring-your-own provider keys, encrypted with DATA_ENCRYPTION_KEY. Never returned by the API.
CREATE TABLE provider_credentials (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider     text NOT NULL CHECK (provider IN ('OpenAI', 'Google Gemini', 'Anthropic Claude', 'OpenRouter')),
  secret_enc   text NOT NULL,
  verified     boolean NOT NULL DEFAULT false,
  verified_at  timestamptz,
  PRIMARY KEY (workspace_id, provider)
);

CREATE TABLE integration_connections (
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  integration_id text NOT NULL,
  secret_enc     text NOT NULL,              -- API key, or OAuth token set as JSON
  connected_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, integration_id)
);

CREATE TABLE oauth_states (
  state_hash     text PRIMARY KEY,
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  integration_id text NOT NULL,
  expires_at     timestamptz NOT NULL
);

CREATE TABLE backups (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  snapshot     jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX backups_workspace_idx ON backups (workspace_id, created_at DESC);

-- Idempotency ledger for client writes: a replayed change id is a no-op.
CREATE TABLE applied_changes (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  change_id    uuid NOT NULL,
  applied_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, change_id)
);
