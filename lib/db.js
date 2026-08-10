import pg from "pg";

const { Pool } = pg;

const memory = {
  reactions: new Map(),
  clients: new Map(),
  codes: new Map(),
  refreshTokens: new Map(),
};

let pool;
let schemaReady;

function env(name) {
  return String(process.env[name] || "").trim();
}

export function databaseDriver() {
  return env("DATABASE_DRIVER") || "postgres";
}

export function databaseConfigured() {
  return databaseDriver() === "memory" || Boolean(env("DATABASE_URL"));
}

function postgresPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: env("DATABASE_URL"),
      ssl: env("DATABASE_SSL") === "disable" ? false : { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30_000,
    });
  }
  return pool;
}

const SCHEMA = `
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
`;

export async function ensureSchema() {
  if (databaseDriver() === "memory") return;
  if (!schemaReady) {
    schemaReady = postgresPool().query(SCHEMA).catch((error) => {
      schemaReady = undefined;
      throw error;
    });
  }
  await schemaReady;
}

export async function query(text, params = []) {
  if (databaseDriver() === "memory") {
    throw new Error("Direct SQL is unavailable with DATABASE_DRIVER=memory.");
  }
  await ensureSchema();
  return postgresPool().query(text, params);
}

export function memoryTable(name) {
  if (databaseDriver() !== "memory") {
    throw new Error("The memory adapter is only available in local test mode.");
  }
  const table = memory[name];
  if (!table) throw new Error(`Unknown memory table: ${name}`);
  return table;
}

export async function closeDatabase() {
  if (pool) await pool.end();
  pool = undefined;
  schemaReady = undefined;
}
