import assert from "node:assert/strict";
import test from "node:test";

import { createDatabasePool, databaseConfigFromEnv, withTransaction } from "../src/database.js";
import { SecurityStore } from "../src/security-store.js";
import { MemorySecurityStore } from "./helpers/memory-security-store.js";

test("database config follows Money's connection-scoped SSL switches", async () => {
  assert.deepEqual(databaseConfigFromEnv({ DATABASE_URL: "postgresql://localhost/dd" }), {
    databaseUrl: "postgresql://localhost/dd", databaseSsl: false,
    databaseSslRejectUnauthorized: true
  });
  const options = databaseConfigFromEnv({
    DATABASE_URL: "postgresql://localhost/dd", DATABASE_SSL: "true",
    DATABASE_SSL_REJECT_UNAUTHORIZED: "false"
  });
  const pool = createDatabasePool(options);
  assert.deepEqual(pool.options.ssl, { rejectUnauthorized: false });
  assert.equal(pool.options.application_name, "doordash-cli-mcp");
  await pool.end();
  assert.throws(() => createDatabasePool({ databaseUrl: "" }), /DATABASE_URL is required/);
  assert.throws(() => createDatabasePool({ databaseUrl: "sqlite:state.sqlite" }), /PostgreSQL/);
});

test("transactions roll back failures and release the connection", async () => {
  const commands = [];
  const client = {
    query: async (sql) => { commands.push(sql); },
    release: () => { commands.push("release"); }
  };
  const expected = new Error("operation failed");
  await assert.rejects(withTransaction({ connect: async () => client }, async () => {
    throw expected;
  }), (error) => error === expected);
  assert.deepEqual(commands, ["BEGIN", "ROLLBACK", "release"]);
});

test("malformed credentials and MCP token formats never reach PostgreSQL", async () => {
  let queries = 0;
  const store = new SecurityStore({
    pool: { query: async () => { queries += 1; throw new Error("unexpected query"); } }
  });
  for (const token of [undefined, null, 5, "", "wrong-prefix"]) {
    assert.equal(await store.verifyToken(token), null);
  }
  await assert.rejects(store.createToken({ name: " " }), /Token name/);
  await assert.rejects(store.createToken({ name: "x".repeat(81) }), /Token name/);
  await assert.rejects(store.setCredential({ accessToken: " " }), /access token/);
  await assert.rejects(store.setCredential({ accessToken: "replacement", expiresAt: NaN }), /expiry/);
  assert.equal(queries, 0);
});

test("database readiness reports outages without exposing database errors", async () => {
  const healthy = new SecurityStore({ pool: { query: async () => ({ rows: [{ ok: 1 }] }) } });
  const failed = new SecurityStore({ pool: { query: async () => {
    throw new Error("postgresql://user:password@example/db");
  } } });
  assert.equal(await healthy.checkHealth(), true);
  assert.equal(await failed.checkHealth(), false);
});

test("regression memory store preserves permission, reservation, and bootstrap semantics", () => {
  let now = 1_800_000_000_000;
  const store = new MemorySecurityStore({ credential: null, clock: () => now });
  const created = store.createToken({ name: "Open WebUI" });
  assert.deepEqual(store.verifyToken(created.token).scopes, ["doordash:tools"]);
  assert.equal(store.setPurchaseAccess(created.id, true), true);
  assert.deepEqual(store.getTokenCounts(), { activeTokenCount: 1, purchaseTokenCount: 1 });
  assert.deepEqual(store.verifyToken(created.token).scopes, ["doordash:tools", "doordash:purchase"]);
  assert.equal(store.revokeToken(created.id), true);
  assert.equal(store.verifyToken(created.token), null);
  assert.equal(store.beginSubmission("cart-1"), true);
  assert.equal(store.beginSubmission("cart-1"), false);
  store.finishSubmission("cart-1", { status: "accepted", orderUuid: "order-1" });
  assert.equal(store.getSubmissionAttempt("cart-1").order_uuid, "order-1");
  store.bootstrapCredential({ accessToken: "original" });
  now += 1_000;
  store.setCredential({ accessToken: "replacement" });
  store.bootstrapCredential({ accessToken: "stale-environment" });
  assert.equal(store.getCredential().accessToken, "replacement");
});
