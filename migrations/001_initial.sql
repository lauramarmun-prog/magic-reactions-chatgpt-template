CREATE TABLE IF NOT EXISTS magic_reactions (
  id uuid PRIMARY KEY,
  source text NOT NULL CHECK (source IN ('custom', 'giphy')),
  kind text NOT NULL CHECK (kind IN ('sticker', 'gif')),
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  tags text[] NOT NULL DEFAULT '{}',
  moods text[] NOT NULL DEFAULT '{}',
  use_when text[] NOT NULL DEFAULT '{}',
  favorite boolean NOT NULL DEFAULT false,
  priority integer NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 100),
  storage_path text NOT NULL DEFAULT '',
  asset_url text NOT NULL DEFAULT '',
  preview_url text NOT NULL DEFAULT '',
  giphy_id text NOT NULL DEFAULT '',
  giphy_page_url text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS magic_reactions_active_idx
  ON magic_reactions (active, favorite DESC, priority DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id text PRIMARY KEY,
  client_name text NOT NULL DEFAULT 'ChatGPT',
  redirect_uris jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash text PRIMARY KEY,
  client_id text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  redirect_uri text NOT NULL,
  code_challenge text NOT NULL,
  scope text NOT NULL,
  expires_at timestamptz NOT NULL,
  used boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  token_hash text PRIMARY KEY,
  client_id text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  subject text NOT NULL,
  scope text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked boolean NOT NULL DEFAULT false
);
