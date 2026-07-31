import assert from "node:assert/strict";
import test from "node:test";

import { createTokenVerifier, isLoopbackAddress } from "../src/auth.js";
import { SecurityStore } from "../src/security-store.js";

test("recognizes only socket loopback addresses", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("192.168.1.10"), false);
  assert.equal(isLoopbackAddress(undefined), false);
});

test("bearer verifier returns current token scopes and rejects revoked tokens", async () => {
  const store = new SecurityStore({ databasePath: ":memory:" });
  const created = store.createToken({
    name: "Test",
    allowPurchases: true
  });
  const verifier = createTokenVerifier(store);

  const auth = await verifier.verifyAccessToken(created.token);
  assert.equal(auth.clientId, created.id);
  assert.deepEqual(auth.scopes, ["doordash:tools", "doordash:purchase"]);
  assert.equal(Number.isFinite(auth.expiresAt), true);

  store.revokeToken(created.id);
  await assert.rejects(
    verifier.verifyAccessToken(created.token),
    /Unknown or revoked MCP token/
  );
  store.close();
});
