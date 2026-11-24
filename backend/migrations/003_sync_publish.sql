-- Publishing to LinkedIn and syncing with connected systems.

ALTER TABLE posts
  ADD COLUMN published_url text,
  ADD COLUMN publish_error text,
  ADD COLUMN external      jsonb NOT NULL DEFAULT '{}';

-- Off by default: a scheduled post is only published by itself when the workspace asked for that.
ALTER TABLE workspaces ADD COLUMN auto_publish boolean NOT NULL DEFAULT false;
