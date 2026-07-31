import Database from "better-sqlite3";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";

const TOKEN_PREFIX = "ddmcp_";
const PERMANENT_TOKEN_EXPIRY_SECONDS = 253_402_300_799;

function hashToken(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function tokenRecord(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    name: row.name,
    prefix: row.token_prefix,
    allowPurchases: row.allow_purchases === 1,
    createdAt: new Date(row.created_at).toISOString(),
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null
  };
}

export class SecurityStore {
  #clock;
  #database;
  #randomBytes;
  #randomUUID;

  constructor({
    databasePath,
    clock = () => Date.now(),
    randomBytesFactory = randomBytes,
    randomUUIDFactory = randomUUID
  } = {}) {
    if (!databasePath) {
      throw new Error("SecurityStore requires databasePath.");
    }

    this.#clock = clock;
    this.#randomBytes = randomBytesFactory;
    this.#randomUUID = randomUUIDFactory;

    if (databasePath !== ":memory:") {
      mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    }

    this.#database = new Database(databasePath);
    this.#database.pragma("foreign_keys = ON");
    if (databasePath !== ":memory:") {
      this.#database.pragma("journal_mode = WAL");
      chmodSync(databasePath, 0o600);
    }

    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS mcp_tokens (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        token_prefix TEXT NOT NULL,
        allow_purchases INTEGER NOT NULL DEFAULT 0 CHECK (allow_purchases IN (0, 1)),
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS mcp_tokens_active_idx
        ON mcp_tokens(revoked_at);

      CREATE TABLE IF NOT EXISTS order_submission_attempts (
        cart_uuid TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        order_uuid TEXT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        error_message TEXT
      );
    `);
  }

  createToken({ name, allowPurchases = false }) {
    const normalizedName = String(name || "").trim();
    if (!normalizedName || normalizedName.length > 80) {
      throw new Error("Token name must be between 1 and 80 characters.");
    }

    const token = `${TOKEN_PREFIX}${this.#randomBytes(32).toString("base64url")}`;
    const now = this.#clock();
    const row = {
      id: this.#randomUUID(),
      name: normalizedName,
      tokenHash: hashToken(token),
      tokenPrefix: `${token.slice(0, 14)}…`,
      allowPurchases: allowPurchases ? 1 : 0,
      createdAt: now
    };

    this.#database
      .prepare(`
        INSERT INTO mcp_tokens (
          id,
          name,
          token_hash,
          token_prefix,
          allow_purchases,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        row.id,
        row.name,
        row.tokenHash,
        row.tokenPrefix,
        row.allowPurchases,
        row.createdAt
      );

    return {
      ...tokenRecord({
        id: row.id,
        name: row.name,
        token_prefix: row.tokenPrefix,
        allow_purchases: row.allowPurchases,
        created_at: row.createdAt,
        last_used_at: null
      }),
      token
    };
  }

  listTokens() {
    return this.#database
      .prepare(`
        SELECT id, name, token_prefix, allow_purchases, created_at, last_used_at
        FROM mcp_tokens
        WHERE revoked_at IS NULL
        ORDER BY created_at DESC
      `)
      .all()
      .map(tokenRecord);
  }

  setPurchaseAccess(id, allowPurchases) {
    const result = this.#database
      .prepare(`
        UPDATE mcp_tokens
        SET allow_purchases = ?
        WHERE id = ? AND revoked_at IS NULL
      `)
      .run(allowPurchases ? 1 : 0, id);

    return result.changes === 1;
  }

  revokeToken(id) {
    const result = this.#database
      .prepare(`
        UPDATE mcp_tokens
        SET revoked_at = ?
        WHERE id = ? AND revoked_at IS NULL
      `)
      .run(this.#clock(), id);

    return result.changes === 1;
  }

  verifyToken(token) {
    if (typeof token !== "string" || !token.startsWith(TOKEN_PREFIX)) {
      return null;
    }

    const row = this.#database
      .prepare(`
        SELECT id, name, token_prefix, allow_purchases, created_at, last_used_at
        FROM mcp_tokens
        WHERE token_hash = ? AND revoked_at IS NULL
      `)
      .get(hashToken(token));

    if (!row) {
      return null;
    }

    const now = this.#clock();
    this.#database
      .prepare("UPDATE mcp_tokens SET last_used_at = ? WHERE id = ?")
      .run(now, row.id);

    return {
      ...tokenRecord({ ...row, last_used_at: now }),
      scopes: [
        "doordash:tools",
        ...(row.allow_purchases === 1 ? ["doordash:purchase"] : [])
      ],
      expiresAt: PERMANENT_TOKEN_EXPIRY_SECONDS
    };
  }

  get activeTokenCount() {
    return this.#database
      .prepare("SELECT COUNT(*) AS count FROM mcp_tokens WHERE revoked_at IS NULL")
      .get().count;
  }

  get purchaseTokenCount() {
    return this.#database
      .prepare(`
        SELECT COUNT(*) AS count
        FROM mcp_tokens
        WHERE revoked_at IS NULL AND allow_purchases = 1
      `)
      .get().count;
  }

  beginSubmission(cartUuid) {
    try {
      this.#database
        .prepare(`
          INSERT INTO order_submission_attempts (cart_uuid, status, started_at)
          VALUES (?, 'started', ?)
        `)
        .run(cartUuid, this.#clock());
      return true;
    } catch (error) {
      if (String(error?.code || "").startsWith("SQLITE_CONSTRAINT")) {
        return false;
      }
      throw error;
    }
  }

  finishSubmission(cartUuid, { status, orderUuid = null, errorMessage = null }) {
    this.#database
      .prepare(`
        UPDATE order_submission_attempts
        SET status = ?, order_uuid = ?, error_message = ?, finished_at = ?
        WHERE cart_uuid = ?
      `)
      .run(status, orderUuid, errorMessage, this.#clock(), cartUuid);
  }

  getSubmissionAttempt(cartUuid) {
    return (
      this.#database
        .prepare(`
          SELECT cart_uuid, status, order_uuid, started_at, finished_at, error_message
          FROM order_submission_attempts
          WHERE cart_uuid = ?
        `)
        .get(cartUuid) || null
    );
  }

  close() {
    this.#database.close();
  }
}

