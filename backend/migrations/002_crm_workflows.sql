-- Lead CRM (stages, contact details, tags, notes, campaigns) and workflows that run by themselves.

CREATE TABLE campaigns (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         text NOT NULL,
  goal         text NOT NULL DEFAULT '',
  channel      text NOT NULL DEFAULT '',
  status       text NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Active', 'Paused', 'Completed')),
  start_date   date,
  end_date     date,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX campaigns_workspace_idx ON campaigns (workspace_id, created_at);

ALTER TABLE leads
  ADD COLUMN email       text,
  ADD COLUMN phone       text,
  ADD COLUMN linkedin    text,
  ADD COLUMN tags        jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN notes       jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  -- Ids of the same person in connected systems, e.g. {"hs": "151", "sf": "00Q..."}.
  ADD COLUMN external    jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN updated_at  timestamptz NOT NULL DEFAULT now();
ALTER TABLE leads DROP CONSTRAINT leads_status_check;
ALTER TABLE leads ADD CONSTRAINT leads_status_check CHECK (status IN ('new', 'contacted', 'interested', 'converted', 'lost'));
CREATE INDEX leads_campaign_idx ON leads (campaign_id) WHERE campaign_id IS NOT NULL;

ALTER TABLE tasks
  ADD COLUMN due_date date,
  ADD COLUMN lead_id  uuid REFERENCES leads(id) ON DELETE SET NULL,
  ADD COLUMN external jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE conversations
  ADD COLUMN address  text,
  ADD COLUMN lead_id  uuid REFERENCES leads(id) ON DELETE SET NULL,
  -- Delivery references, e.g. the last email Message-ID to reply to.
  ADD COLUMN external jsonb NOT NULL DEFAULT '{}';
CREATE INDEX conversations_address_idx ON conversations (workspace_id, channel, lower(address)) WHERE address IS NOT NULL;

ALTER TABLE workflows ADD COLUMN last_scheduled_day text;

ALTER TABLE runs DROP CONSTRAINT runs_status_check;
ALTER TABLE runs ADD CONSTRAINT runs_status_check CHECK (status IN ('Completed', 'Awaiting approval', 'Waiting', 'Stopped', 'Rejected', 'Failed'));
ALTER TABLE runs
  ADD COLUMN cursor    integer NOT NULL DEFAULT 1,
  ADD COLUMN subject   jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN log       jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN chain     jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN resume_at timestamptz,
  ADD COLUMN test      boolean NOT NULL DEFAULT false;
CREATE INDEX runs_due_idx ON runs (resume_at) WHERE status = 'Waiting';

-- Messages on their way out, so a reply is delivered once even if the request is retried.
CREATE TABLE outbound_messages (
  id              uuid PRIMARY KEY,
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  channel         text NOT NULL,
  status          text NOT NULL CHECK (status IN ('sent', 'failed', 'saved')),
  error           text,
  provider_ref    text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Per-workspace state of a connected integration: sync cursors, webhook tokens, account ids.
ALTER TABLE integration_connections ADD COLUMN state jsonb NOT NULL DEFAULT '{}';
-- Public tokens in inbound webhook addresses (hashed), one per connection.
CREATE TABLE inbound_hooks (
  token_hash     text PRIMARY KEY,
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  integration_id text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, integration_id)
);
