-- Accounts (password, two-step sign-in), team members with roles, invitations, several
-- workspaces per account, and what each plan includes.

ALTER TABLE users
  ADD COLUMN password_hash   text,
  ADD COLUMN totp_secret_enc text,
  ADD COLUMN totp_enabled    boolean NOT NULL DEFAULT false,
  ADD COLUMN totp_last_step  bigint NOT NULL DEFAULT 0,
  ADD COLUMN recovery_hashes jsonb NOT NULL DEFAULT '[]';

-- The account a workspace belongs to: the license owner who created it.
ALTER TABLE workspaces ADD COLUMN owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
UPDATE workspaces w SET owner_user_id = (SELECT u.id FROM users u WHERE u.workspace_id = w.id ORDER BY u.created_at LIMIT 1);

CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_members_user_idx ON workspace_members (user_id);
INSERT INTO workspace_members (workspace_id, user_id, role, created_at) SELECT workspace_id, id, 'owner', created_at FROM users;

CREATE TABLE invitations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email        text NOT NULL,
  role         text NOT NULL CHECK (role IN ('admin', 'member', 'viewer')),
  token_hash   text NOT NULL UNIQUE,
  invited_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at   timestamptz NOT NULL,
  accepted_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX invitations_open_key ON invitations (workspace_id, lower(email)) WHERE accepted_at IS NULL;

-- Emailed codes for resetting a password.
CREATE TABLE auth_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash   text NOT NULL,
  attempts    integer NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_codes_user_idx ON auth_codes (user_id, created_at DESC);

-- A session opened by a license key alone, on an account that has sign-in switched on, is not
-- signed in yet: it holds the device's seat but cannot read the workspace.
ALTER TABLE sessions
  ADD COLUMN signed_in boolean NOT NULL DEFAULT true,
  ADD COLUMN time_zone text,
  ADD COLUMN ip        text;

-- ── plans ────────────────────────────────────────────────────────────────
ALTER TABLE subscription_plans DROP CONSTRAINT subscription_plans_period_check;
ALTER TABLE subscription_plans ADD CONSTRAINT subscription_plans_period_check CHECK (period IN ('month', 'year', 'once'));

-- features: what the plan adds to the base product (lead scoring, assistant, content, inbox).
UPDATE subscription_plans SET features = '["workflows", "integrations", "desktop"]' WHERE code = 'professional';
UPDATE subscription_plans SET features = '["workflows", "integrations", "desktop", "team", "workspaces", "priority_support"]', max_devices = 5 WHERE code = 'business';
UPDATE subscription_plans SET features = '[]' WHERE code = 'starter';
INSERT INTO subscription_plans (code, name, price_cents, period, max_devices, features) VALUES
  ('starter-annual', 'Starter (annual)', 9000, 'year', 1, '[]'),
  ('professional-annual', 'Professional (annual)', 29000, 'year', 1, '["workflows", "integrations", "desktop"]'),
  ('business-annual', 'Business (annual)', 79000, 'year', 5, '["workflows", "integrations", "desktop", "team", "workspaces", "priority_support"]'),
  ('lifetime', 'Lifetime desktop', 34900, 'once', 1, '["workflows", "integrations", "desktop"]'),
  ('enterprise', 'Enterprise', 0, 'year', 25, '["workflows", "integrations", "desktop", "team", "workspaces", "priority_support", "enterprise"]');

-- Automatic daily backups are told apart from ones a person asked for.
ALTER TABLE backups ADD COLUMN automatic boolean NOT NULL DEFAULT false;
