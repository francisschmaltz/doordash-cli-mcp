import { createHash, randomBytes, randomUUID } from "node:crypto";

import { createDatabasePool } from "./database.js";
import { runMigrations } from "./migrations.js";

const TOKEN_PREFIX = "ddmcp_";
const PERMANENT_TOKEN_EXPIRY_SECONDS = 253_402_300_799;

function hashToken(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function tokenRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    prefix: row.token_prefix,
    allowPurchases: row.allow_purchases === true,
    createdAt: new Date(Number(row.created_at)).toISOString(),
    lastUsedAt: row.last_used_at === null
      ? null
      : new Date(Number(row.last_used_at)).toISOString()
  };
}

function credentialRecord(row) {
  if (!row) return null;
  return {
    accessToken: row.access_token,
    expiresAt: row.expires_at === null ? null : Number(row.expires_at),
    updatedAt: Number(row.updated_at)
  };
}

function validateCredential({ accessToken, expiresAt = null }) {
  if (typeof accessToken !== "string" || !accessToken.trim()) {
    throw new Error("A DoorDash access token is required.");
  }
  if (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt < 0)) {
    throw new Error("Credential expiry must be milliseconds since the Unix epoch.");
  }
  return { accessToken: accessToken.trim(), expiresAt };
}

export class SecurityStore {
  #clock;
  #database;
  #ownsPool;
  #randomBytes;
  #randomUUID;

  constructor({
    pool,
    databaseUrl = process.env.DATABASE_URL,
    databaseSsl = process.env.DATABASE_SSL,
    databaseSslRejectUnauthorized = process.env.DATABASE_SSL_REJECT_UNAUTHORIZED,
    clock = () => Date.now(),
    randomBytesFactory = randomBytes,
    randomUUIDFactory = randomUUID
  } = {}) {
    this.#database = pool || createDatabasePool({
      databaseUrl,
      databaseSsl,
      databaseSslRejectUnauthorized
    });
    this.#ownsPool = !pool;
    this.#clock = clock;
    this.#randomBytes = randomBytesFactory;
    this.#randomUUID = randomUUIDFactory;
  }

  async initialize() {
    return runMigrations(this.#database);
  }

  async createToken({ name, allowPurchases = false }) {
    const normalizedName = String(name || "").trim();
    if (!normalizedName || normalizedName.length > 80) {
      throw new Error("Token name must be between 1 and 80 characters.");
    }
    const token = `${TOKEN_PREFIX}${this.#randomBytes(32).toString("base64url")}`;
    const result = await this.#database.query(`
      INSERT INTO mcp_tokens (
        id, name, token_hash, token_prefix, allow_purchases, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, name, token_prefix, allow_purchases, created_at, last_used_at
    `, [
      this.#randomUUID(), normalizedName, hashToken(token), `${token.slice(0, 14)}…`,
      Boolean(allowPurchases), this.#clock()
    ]);
    return { ...tokenRecord(result.rows[0]), token };
  }

  async listTokens() {
    const result = await this.#database.query(`
      SELECT id, name, token_prefix, allow_purchases, created_at, last_used_at
      FROM mcp_tokens WHERE revoked_at IS NULL ORDER BY created_at DESC
    `);
    return result.rows.map(tokenRecord);
  }

  async setPurchaseAccess(id, allowPurchases) {
    const result = await this.#database.query(`
      UPDATE mcp_tokens SET allow_purchases = $1
      WHERE id = $2 AND revoked_at IS NULL
    `, [Boolean(allowPurchases), id]);
    return result.rowCount === 1;
  }

  async revokeToken(id) {
    const result = await this.#database.query(`
      UPDATE mcp_tokens SET revoked_at = $1 WHERE id = $2 AND revoked_at IS NULL
    `, [this.#clock(), id]);
    return result.rowCount === 1;
  }

  async verifyToken(token) {
    if (typeof token !== "string" || !token.startsWith(TOKEN_PREFIX)) return null;
    // Read current permission and update use time in one statement so revocation
    // cannot slip between a token lookup and its verification update.
    const result = await this.#database.query(`
      UPDATE mcp_tokens SET last_used_at = $1
      WHERE token_hash = $2 AND revoked_at IS NULL
      RETURNING id, name, token_prefix, allow_purchases, created_at, last_used_at
    `, [this.#clock(), hashToken(token)]);
    const row = result.rows[0];
    if (!row) return null;
    return {
      ...tokenRecord(row),
      scopes: ["doordash:tools", ...(row.allow_purchases ? ["doordash:purchase"] : [])],
      expiresAt: PERMANENT_TOKEN_EXPIRY_SECONDS
    };
  }

  async getTokenCounts() {
    const result = await this.#database.query(`
      SELECT COUNT(*)::integer AS active_token_count,
        COUNT(*) FILTER (WHERE allow_purchases)::integer AS purchase_token_count
      FROM mcp_tokens WHERE revoked_at IS NULL
    `);
    return {
      activeTokenCount: result.rows[0].active_token_count,
      purchaseTokenCount: result.rows[0].purchase_token_count
    };
  }

  async beginSubmission(cartUuid) {
    const result = await this.#database.query(`
      INSERT INTO order_submission_attempts (cart_uuid, status, started_at)
      VALUES ($1, 'started', $2) ON CONFLICT (cart_uuid) DO NOTHING
    `, [cartUuid, this.#clock()]);
    return result.rowCount === 1;
  }

  async finishSubmission(cartUuid, { status, orderUuid = null, errorMessage = null }) {
    await this.#database.query(`
      UPDATE order_submission_attempts
      SET status = $1, order_uuid = $2, error_message = $3, finished_at = $4
      WHERE cart_uuid = $5
    `, [status, orderUuid, errorMessage, this.#clock(), cartUuid]);
  }

  async getSubmissionAttempt(cartUuid) {
    const result = await this.#database.query(`
      SELECT cart_uuid, status, order_uuid, started_at, finished_at, error_message
      FROM order_submission_attempts WHERE cart_uuid = $1
    `, [cartUuid]);
    const row = result.rows[0];
    return row ? {
      ...row,
      started_at: Number(row.started_at),
      finished_at: row.finished_at === null ? null : Number(row.finished_at)
    } : null;
  }

  async getCredential() {
    const result = await this.#database.query(`
      SELECT access_token, expires_at, updated_at FROM doordash_credentials WHERE id = 1
    `);
    return credentialRecord(result.rows[0]);
  }

  async setCredential(credential) {
    const { accessToken, expiresAt } = validateCredential(credential);
    const result = await this.#database.query(`
      INSERT INTO doordash_credentials (id, access_token, expires_at, updated_at)
      VALUES (1, $1, $2, $3) ON CONFLICT (id) DO UPDATE
      SET access_token = EXCLUDED.access_token, expires_at = EXCLUDED.expires_at,
        updated_at = EXCLUDED.updated_at
      RETURNING access_token, expires_at, updated_at
    `, [accessToken, expiresAt, this.#clock()]);
    return credentialRecord(result.rows[0]);
  }

  async bootstrapCredential(credential) {
    const { accessToken, expiresAt } = validateCredential(credential);
    await this.#database.query(`
      INSERT INTO doordash_credentials (id, access_token, expires_at, updated_at)
      VALUES (1, $1, $2, $3) ON CONFLICT (id) DO NOTHING
    `, [accessToken, expiresAt, this.#clock()]);
    return this.getCredential();
  }

  async checkHealth() {
    try {
      const result = await this.#database.query("SELECT 1 AS ok");
      return result.rows[0]?.ok === 1;
    } catch {
      return false;
    }
  }

  async close() {
    if (this.#ownsPool) await this.#database.end();
  }
}
