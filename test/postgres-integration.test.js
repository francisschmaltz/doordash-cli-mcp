import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createDatabasePool } from "../src/database.js";
import { createDoorDashApp } from "../src/app.js";
import { DoorDashCredentialManager } from "../src/doordash-credentials.js";
import { runMigrations } from "../src/migrations.js";
import { SecurityStore } from "../src/security-store.js";
import { importSqlite } from "../scripts/import-sqlite.js";

// Never fall back to DATABASE_URL: this suite creates and drops only isolated
// schemas in an explicitly provided test database.
const TEST_DATABASE_URL = String(process.env.TEST_DATABASE_URL || "").trim();
const REQUIRE_DATABASE = ["true", "1"].includes(String(process.env.CI).toLowerCase());
const integrationOptions = {
  skip: !TEST_DATABASE_URL && !REQUIRE_DATABASE ? "TEST_DATABASE_URL is not set" : false
};

async function isolatedDatabase(t) {
  assert.ok(TEST_DATABASE_URL, "CI requires TEST_DATABASE_URL for PostgreSQL integration tests.");
  const schema = `dd_mcp_it_${randomUUID().replaceAll("-", "")}`;
  assert.match(schema, /^dd_mcp_it_[0-9a-f]+$/);
  const options = {
    databaseUrl: TEST_DATABASE_URL,
    databaseSsl: process.env.TEST_DATABASE_SSL || false,
    databaseSslRejectUnauthorized: process.env.TEST_DATABASE_SSL_REJECT_UNAUTHORIZED ?? true,
    application_name: "doordash-cli-mcp-integration-test"
  };
  const control = createDatabasePool(options);
  const pools = new Set();
  await control.query(`CREATE SCHEMA "${schema}"`);
  t.after(async () => {
    try {
      await Promise.all([...pools].map((pool) => pool.end()));
      await control.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await control.end();
    }
  });
  const createPool = () => {
    const pool = createDatabasePool({ ...options, options: `-c search_path=${schema}` });
    pools.add(pool);
    return pool;
  };
  const closePool = async (pool) => {
    pools.delete(pool);
    await pool.end();
  };
  const pool = createPool();
  assert.equal((await pool.query("SELECT current_schema() AS schema")).rows[0].schema, schema);
  return { pool, createPool, closePool, schema, control };
}

async function sqliteFixture(t, { invalidTimestamp = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dd-mcp-sqlite-import-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sqlitePath = path.join(directory, "state.sqlite");
  const database = new DatabaseSync(sqlitePath);
  database.exec(`
    CREATE TABLE mcp_tokens (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      token_prefix TEXT NOT NULL, allow_purchases INTEGER NOT NULL,
      created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER
    );
    CREATE TABLE order_submission_attempts (
      cart_uuid TEXT PRIMARY KEY, status TEXT NOT NULL, order_uuid TEXT,
      started_at INTEGER NOT NULL, finished_at INTEGER, error_message TEXT
    );
  `);
  const originalToken = "ddmcp_existing-imported-token";
  const originalHash = createHash("sha256").update(originalToken).digest("hex");
  const insertToken = database.prepare("INSERT INTO mcp_tokens VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  insertToken.run("legacy-active", "Legacy active", originalHash, "ddmcp_existing…", 1,
    1_700_000_000_000, 1_700_000_001_000, null);
  insertToken.run("legacy-revoked", "Legacy revoked", "revoked-hash",
    "ddmcp_revoked…", 0, invalidTimestamp ? "not-an-integer" : 1_700_000_000_001,
    null, 1_700_000_001_001);
  database.prepare("INSERT INTO order_submission_attempts VALUES (?, ?, ?, ?, ?, ?)")
    .run("legacy-cart", "uncertain", null, 1_700_000_002_000, 1_700_000_003_000,
      "Legacy ambiguous response");
  database.close();
  return { sqlitePath, originalToken, originalHash };
}

test("PostgreSQL migrations, token persistence, live permissions, and revocation", integrationOptions, async (t) => {
  const database = await isolatedDatabase(t);
  const first = new SecurityStore({ pool: database.pool });
  assert.deepEqual(await first.initialize(), ["001_security.sql"]);
  assert.deepEqual(await runMigrations(database.pool), []);
  const created = await first.createToken({ name: "Open WebUI", allowPurchases: false });
  const raw = (await database.pool.query("SELECT * FROM mcp_tokens WHERE id = $1", [created.id])).rows[0];
  assert.notEqual(raw.token_hash, created.token);
  assert.equal(JSON.stringify(raw).includes(created.token), false);
  assert.deepEqual(await first.getTokenCounts(), { activeTokenCount: 1, purchaseTokenCount: 0 });
  assert.deepEqual((await first.verifyToken(created.token)).scopes, ["doordash:tools"]);
  await first.close();
  await database.closePool(database.pool);
  const restarted = new SecurityStore({ pool: database.createPool() });
  await restarted.initialize();
  assert.equal((await restarted.verifyToken(created.token)).id, created.id);
  assert.equal(await restarted.setPurchaseAccess(created.id, true), true);
  assert.deepEqual((await restarted.verifyToken(created.token)).scopes,
    ["doordash:tools", "doordash:purchase"]);
  assert.equal(await restarted.setPurchaseAccess(created.id, false), true);
  assert.deepEqual((await restarted.verifyToken(created.token)).scopes, ["doordash:tools"]);
  assert.equal(await restarted.revokeToken(created.id), true);
  assert.equal(await restarted.verifyToken(created.token), null);
  assert.equal(await restarted.revokeToken(created.id), false);
  assert.equal(await restarted.setPurchaseAccess(created.id, true), false);
  assert.deepEqual(await restarted.listTokens(), []);
  assert.deepEqual(await restarted.getTokenCounts(), { activeTokenCount: 0, purchaseTokenCount: 0 });
});

test("PostgreSQL reservation admits exactly one concurrent submission and survives reconnect", integrationOptions, async (t) => {
  const database = await isolatedDatabase(t);
  const first = new SecurityStore({ pool: database.pool });
  const second = new SecurityStore({ pool: database.createPool() });
  const migrations = await Promise.all([first.initialize(), second.initialize()]);
  assert.deepEqual(migrations.flat(), ["001_security.sql"]);
  const attempts = await Promise.all(Array.from({ length: 20 }, (_, index) =>
    (index % 2 ? first : second).beginSubmission("one-cart")));
  assert.equal(attempts.filter(Boolean).length, 1);
  await first.finishSubmission("one-cart", {
    status: "uncertain", errorMessage: "Connection interrupted after submit."
  });
  const restarted = new SecurityStore({ pool: database.createPool() });
  assert.equal(await restarted.beginSubmission("one-cart"), false);
  assert.equal((await restarted.getSubmissionAttempt("one-cart")).status, "uncertain");
  await restarted.finishSubmission("one-cart", { status: "accepted", orderUuid: "order-1" });
  const attempt = await first.getSubmissionAttempt("one-cart");
  assert.equal(attempt.order_uuid, "order-1");
  assert.equal(attempt.error_message, null);
  assert.equal(typeof attempt.started_at, "number");
  assert.equal(typeof attempt.finished_at, "number");
  assert.equal(await first.getSubmissionAttempt("missing"), null);
});

test("PostgreSQL credential replacement survives restart and ignores stale environment bootstrap", integrationOptions, async (t) => {
  const database = await isolatedDatabase(t);
  const first = new SecurityStore({ pool: database.pool, clock: () => 1_800_000_000_000 });
  await first.initialize();
  assert.equal(await first.getCredential(), null);
  await Promise.all([
    first.bootstrapCredential({ accessToken: "bootstrap-1" }),
    first.bootstrapCredential({ accessToken: "bootstrap-2" })
  ]);
  assert.match((await first.getCredential()).accessToken, /^bootstrap-[12]$/);
  const replacement = await first.setCredential({ accessToken: "replacement", expiresAt: 1_800_010_000_000 });
  assert.deepEqual(replacement, {
    accessToken: "replacement", expiresAt: 1_800_010_000_000, updatedAt: 1_800_000_000_000
  });
  await database.closePool(database.pool);
  const restartedPool = database.createPool();
  const restarted = new SecurityStore({ pool: restartedPool });
  await restarted.initialize();
  await restarted.bootstrapCredential({ accessToken: "stale-environment" });
  assert.deepEqual(await restarted.getCredential(), replacement);
  await assert.rejects(restarted.setCredential({ accessToken: " " }), /access token/);
  assert.deepEqual(await restarted.getCredential(), replacement);
  assert.equal(await restarted.checkHealth(), true);
  await database.closePool(restartedPool);
  assert.equal(await restarted.checkHealth(), false);
});

test("SQLite importer preserves hashes, revoked rows and submission history without changing source", integrationOptions, async (t) => {
  const database = await isolatedDatabase(t);
  const fixture = await sqliteFixture(t);
  const before = await readFile(fixture.sqlitePath);
  assert.deepEqual(await importSqlite({ sqlitePath: fixture.sqlitePath, pool: database.pool }), {
    tokenCount: 2, submissionCount: 1
  });
  assert.deepEqual(await readFile(fixture.sqlitePath), before);
  const rows = (await database.pool.query("SELECT * FROM mcp_tokens ORDER BY id")).rows;
  assert.equal(rows[0].token_hash, fixture.originalHash);
  assert.equal(rows[0].last_used_at, "1700000001000");
  assert.equal(rows[1].revoked_at, "1700000001001");
  const store = new SecurityStore({ pool: database.pool });
  assert.equal((await store.verifyToken(fixture.originalToken)).allowPurchases, true);
  assert.equal(await store.verifyToken("ddmcp_revoked"), null);
  assert.equal(await store.beginSubmission("legacy-cart"), false);
  assert.deepEqual(await store.getSubmissionAttempt("legacy-cart"), {
    cart_uuid: "legacy-cart", status: "uncertain", order_uuid: null,
    started_at: 1_700_000_002_000, finished_at: 1_700_000_003_000,
    error_message: "Legacy ambiguous response"
  });
  await assert.rejects(importSqlite({ sqlitePath: fixture.sqlitePath, pool: database.pool }), /empty destination/);
});

test("SQLite importer rejects an active destination before adding legacy data", integrationOptions, async (t) => {
  const database = await isolatedDatabase(t);
  const fixture = await sqliteFixture(t);
  const store = new SecurityStore({ pool: database.pool });
  await store.initialize();
  await store.setCredential({ accessToken: "existing-credential" });
  await assert.rejects(importSqlite({ sqlitePath: fixture.sqlitePath, pool: database.pool }), /empty destination/);
  assert.deepEqual(await store.listTokens(), []);
  assert.equal((await store.getCredential()).accessToken, "existing-credential");
});

test("SQLite importer rolls back all rows when a later source row is invalid", integrationOptions, async (t) => {
  const database = await isolatedDatabase(t);
  const fixture = await sqliteFixture(t, { invalidTimestamp: true });
  await assert.rejects(importSqlite({ sqlitePath: fixture.sqlitePath, pool: database.pool }),
    (error) => error.code === "22P02");
  assert.equal((await database.pool.query("SELECT COUNT(*) AS count FROM mcp_tokens")).rows[0].count, "0");
  assert.equal((await database.pool.query("SELECT COUNT(*) AS count FROM sqlite_imports")).rows[0].count, "0");
  assert.equal((await database.pool.query("SELECT COUNT(*) AS count FROM order_submission_attempts")).rows[0].count, "0");
});

test("failed PostgreSQL migration rolls back DDL and its version marker", integrationOptions, async (t) => {
  const database = await isolatedDatabase(t);
  await database.pool.query("CREATE TABLE mcp_tokens (conflicting_column TEXT)");
  await assert.rejects(runMigrations(database.pool), (error) => error.code === "42P07");
  assert.equal((await database.pool.query("SELECT to_regclass('schema_migrations') AS table_name")).rows[0].table_name, null);
  await database.pool.query("DROP TABLE mcp_tokens");
  assert.deepEqual(await runMigrations(database.pool), ["001_security.sql"]);
});

test("PostgreSQL-backed HTTP/MCP renews credentials, preserves state, and reports database readiness", integrationOptions, async (t) => {
  const database = await isolatedDatabase(t);
  const store = new SecurityStore({ pool: database.pool });
  await store.initialize();
  await store.bootstrapCredential({ accessToken: "expired-fixture-token", expiresAt: 1 });
  const usedTokens = [];
  const runCli = async (_args, options) => {
    usedTokens.push(options.accessToken);
    return { ok: true, data: { isError: false, structuredContent: { addresses: [] } } };
  };
  const admin = "postgres-http-fixture-admin";
  const { app, mcpHandler, activityLog } = createDoorDashApp({ securityStore: store, adminAccessToken: admin, runCli });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  t.after(async () => {
    await mcpHandler.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" };
  assert.equal((await fetch(`${base}/health/ready`)).status, 200);
  assert.equal((await fetch(`${base}/health/live`)).status, 200);
  const creation = await fetch(`${base}/api/tokens`, {
    method: "POST", headers, body: JSON.stringify({ name: "HTTP recovery", allowPurchases: false })
  });
  assert.equal(creation.status, 201);
  const bearer = await creation.json();
  let id = 0;
  const rpc = async (method, params) => {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json", "MCP-Protocol-Version": "2025-11-25", Authorization: `Bearer ${bearer.token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params })
    });
    const text = await response.text();
    const line = text.split("\n").find((entry) => entry.startsWith("data: "));
    return { status: response.status, body: response.ok ? (line ? JSON.parse(line.slice(6)) : JSON.parse(text)) : null };
  };
  const expired = await rpc("tools/call", { name: "list_addresses", arguments: {} });
  assert.equal(expired.body.result.structuredContent.error.recovery_tool, "doordash_auth");
  assert.equal(usedTokens.length, 0);
  const renewal = await rpc("tools/call", { name: "doordash_auth", arguments: { access_token: "postgres-new-fixture-token" } });
  assert.equal(renewal.body.result.structuredContent.authenticated, true);
  const resumed = await rpc("tools/call", { name: "list_addresses", arguments: {} });
  assert.equal(resumed.body.result.structuredContent.kind, "address_list");
  assert.deepEqual(usedTokens, ["postgres-new-fixture-token", "postgres-new-fixture-token"]);
  assert.equal(JSON.stringify({ renewal, log: activityLog.list() }).includes("postgres-new-fixture-token"), false);
  const restartedStore = new SecurityStore({ pool: database.createPool() });
  const restartedCredentials = new DoorDashCredentialManager({ securityStore: restartedStore, runCli });
  await restartedCredentials.initialize("stale\nbootstrap-fixture-token");
  assert.equal((await restartedCredentials.status()).authenticated, true);
  assert.equal((await restartedStore.getCredential()).accessToken, "postgres-new-fixture-token");
  const permission = await fetch(`${base}/api/tokens/${bearer.id}`, {
    method: "PATCH", headers, body: JSON.stringify({ allowPurchases: true })
  });
  assert.equal(permission.status, 200);
  const tools = await rpc("tools/list", {});
  assert.ok(tools.body.result.tools.some((tool) => tool.name === "order_submit"));
  const status = await (await fetch(`${base}/api/status`, { headers })).json();
  assert.equal(status.purchaseTokenCount, 1);
  const revocation = await fetch(`${base}/api/tokens/${bearer.id}`, { method: "DELETE", headers });
  assert.equal(revocation.status, 200);
  assert.equal((await rpc("tools/list", {})).status, 401);
  await database.closePool(database.pool);
  assert.equal((await fetch(`${base}/health/ready`)).status, 503);
  assert.equal((await fetch(`${base}/health/live`)).status, 200);
});
