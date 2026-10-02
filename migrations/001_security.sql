CREATE TABLE mcp_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  allow_purchases BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL,
  last_used_at BIGINT,
  revoked_at BIGINT
);

CREATE INDEX mcp_tokens_active_idx ON mcp_tokens(revoked_at);

CREATE TABLE order_submission_attempts (
  cart_uuid TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  order_uuid TEXT,
  started_at BIGINT NOT NULL,
  finished_at BIGINT,
  error_message TEXT
);

CREATE TABLE doordash_credentials (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  access_token TEXT NOT NULL CHECK (length(access_token) > 0),
  expires_at BIGINT,
  updated_at BIGINT NOT NULL
);

CREATE TABLE sqlite_imports (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  imported_at BIGINT NOT NULL,
  token_count INTEGER NOT NULL,
  submission_count INTEGER NOT NULL
);
