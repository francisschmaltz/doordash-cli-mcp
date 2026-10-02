import { createHash, randomBytes, randomUUID } from "node:crypto";

// Regression fixtures only. Production always uses PostgreSQL SecurityStore.
export class MemorySecurityStore {
  #tokens = new Map();
  #submissions = new Map();
  #credential;
  #clock;
  #randomBytes;
  #randomUUID;

  constructor({
    clock = () => Date.now(),
    randomBytesFactory = randomBytes,
    randomUUIDFactory = randomUUID,
    credential = { accessToken: "test-doordash-access-token", expiresAt: null }
  } = {}) {
    this.#clock = clock;
    this.#randomBytes = randomBytesFactory;
    this.#randomUUID = randomUUIDFactory;
    this.#credential = credential ? { ...credential, updatedAt: clock() } : null;
  }

  initialize() { return []; }

  createToken({ name, allowPurchases = false }) {
    const normalizedName = String(name || "").trim();
    if (!normalizedName || normalizedName.length > 80) {
      throw new Error("Token name must be between 1 and 80 characters.");
    }
    const token = `ddmcp_${this.#randomBytes(32).toString("base64url")}`;
    const record = {
      id: this.#randomUUID(), name: normalizedName, prefix: `${token.slice(0, 14)}…`,
      allowPurchases: Boolean(allowPurchases),
      createdAt: new Date(this.#clock()).toISOString(), lastUsedAt: null
    };
    this.#tokens.set(this.#hash(token), record);
    return { ...record, token };
  }

  #hash(token) {
    return createHash("sha256").update(token, "utf8").digest("hex");
  }

  listTokens() {
    return [...this.#tokens.values()]
      .filter((row) => !row.revoked)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(({ revoked, ...row }) => ({ ...row }));
  }

  setPurchaseAccess(id, allowPurchases) {
    const row = [...this.#tokens.values()].find((entry) => entry.id === id && !entry.revoked);
    if (!row) return false;
    row.allowPurchases = Boolean(allowPurchases);
    return true;
  }

  revokeToken(id) {
    const row = [...this.#tokens.values()].find((entry) => entry.id === id && !entry.revoked);
    if (!row) return false;
    row.revoked = true;
    return true;
  }

  verifyToken(token) {
    if (typeof token !== "string" || !token.startsWith("ddmcp_")) return null;
    const row = this.#tokens.get(this.#hash(token));
    if (!row || row.revoked) return null;
    row.lastUsedAt = new Date(this.#clock()).toISOString();
    const { revoked, ...record } = row;
    return {
      ...record,
      scopes: ["doordash:tools", ...(row.allowPurchases ? ["doordash:purchase"] : [])],
      expiresAt: 253_402_300_799
    };
  }

  get activeTokenCount() { return this.listTokens().length; }
  get purchaseTokenCount() { return this.listTokens().filter((row) => row.allowPurchases).length; }

  getTokenCounts() {
    return { activeTokenCount: this.activeTokenCount, purchaseTokenCount: this.purchaseTokenCount };
  }

  beginSubmission(cartUuid) {
    if (this.#submissions.has(cartUuid)) return false;
    this.#submissions.set(cartUuid, {
      cart_uuid: cartUuid, status: "started", order_uuid: null,
      started_at: this.#clock(), finished_at: null, error_message: null
    });
    return true;
  }

  finishSubmission(cartUuid, { status, orderUuid = null, errorMessage = null }) {
    const row = this.#submissions.get(cartUuid);
    if (row) Object.assign(row, {
      status, order_uuid: orderUuid, error_message: errorMessage, finished_at: this.#clock()
    });
  }

  getSubmissionAttempt(cartUuid) {
    const row = this.#submissions.get(cartUuid);
    return row ? { ...row } : null;
  }

  getCredential() { return this.#credential ? { ...this.#credential } : null; }

  setCredential({ accessToken, expiresAt = null }) {
    if (typeof accessToken !== "string" || !accessToken.trim()) {
      throw new Error("A DoorDash access token is required.");
    }
    if (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt < 0)) {
      throw new Error("Credential expiry must be milliseconds since the Unix epoch.");
    }
    this.#credential = { accessToken: accessToken.trim(), expiresAt, updatedAt: this.#clock() };
    return this.getCredential();
  }

  bootstrapCredential(credential) {
    return this.#credential ? this.getCredential() : this.setCredential(credential);
  }

  checkHealth() { return true; }
  close() {}
}
