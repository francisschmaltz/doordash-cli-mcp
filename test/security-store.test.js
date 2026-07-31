import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { SecurityStore } from "../src/security-store.js";

test("stores only token hashes and applies per-token purchase access", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dd-mcp-store-"));
  const databasePath = path.join(directory, "state.sqlite");
  let now = 1_800_000_000_000;
  const store = new SecurityStore({
    databasePath,
    clock: () => now,
    randomBytesFactory: (size) => Buffer.alloc(size, 7),
    randomUUIDFactory: () => "token-id"
  });

  const created = store.createToken({
    name: "Open WebUI",
    allowPurchases: false
  });
  assert.match(created.token, /^ddmcp_/);
  assert.equal(created.allowPurchases, false);
  assert.equal(store.activeTokenCount, 1);
  assert.equal(store.purchaseTokenCount, 0);

  const rawDatabase = new Database(databasePath, { readonly: true });
  const raw = rawDatabase
    .prepare("SELECT token_hash, token_prefix FROM mcp_tokens")
    .get();
  rawDatabase.close();
  assert.notEqual(raw.token_hash, created.token);
  assert.equal(JSON.stringify(raw).includes(created.token), false);

  now += 1_000;
  const verifiedSafe = store.verifyToken(created.token);
  assert.deepEqual(verifiedSafe.scopes, ["doordash:tools"]);
  assert.equal(verifiedSafe.lastUsedAt, new Date(now).toISOString());

  assert.equal(store.setPurchaseAccess(created.id, true), true);
  assert.equal(store.purchaseTokenCount, 1);
  const verifiedPurchase = store.verifyToken(created.token);
  assert.deepEqual(verifiedPurchase.scopes, [
    "doordash:tools",
    "doordash:purchase"
  ]);

  assert.equal(store.revokeToken(created.id), true);
  assert.equal(store.verifyToken(created.token), null);
  assert.equal(store.activeTokenCount, 0);
  store.close();
});

test("submission ledger refuses a second attempt for the same cart", () => {
  const store = new SecurityStore({
    databasePath: ":memory:"
  });

  assert.equal(store.beginSubmission("cart-1"), true);
  assert.equal(store.beginSubmission("cart-1"), false);
  store.finishSubmission("cart-1", {
    status: "accepted",
    orderUuid: "order-1"
  });
  assert.equal(store.getSubmissionAttempt("cart-1").status, "accepted");
  assert.equal(store.getSubmissionAttempt("cart-1").order_uuid, "order-1");
  store.close();
});
