import assert from "node:assert/strict";
import test from "node:test";

import { createDoorDashApp } from "../src/app.js";
import { DoorDashCliError } from "../src/dd-cli.js";
import { DoorDashCredentialManager, accessTokenExpiry } from "../src/doordash-credentials.js";
import { MemorySecurityStore } from "./helpers/memory-security-store.js";

function execution(data) {
  return { ok: true, exitCode: 0, stderr: null, data: { isError: false, structuredContent: data } };
}

function jwt(exp) {
  return `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.test-signature`;
}

function manager(store, runCli = async () => execution({ addresses: [] }), options = {}) {
  return new DoorDashCredentialManager({ securityStore: store, runCli, ...options });
}

async function rpc(handler, authInfo, name, args = {}, id = 1) {
  const response = await handler.fetch(new Request("http://localhost/mcp", {
    method: "POST",
    headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json", "MCP-Protocol-Version": "2025-11-25" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })
  }), { authInfo });
  const body = await response.text();
  const line = body.split("\n").find((entry) => entry.startsWith("data: "));
  return (line ? JSON.parse(line.slice(6)) : JSON.parse(body)).result;
}

function auth(store) {
  const token = store.createToken({ name: "Recovery", allowPurchases: false });
  const record = store.verifyToken(token.token);
  return { token: token.token, clientId: record.id, scopes: record.scopes, expiresAt: record.expiresAt };
}

test("missing and expired credentials stop before any CLI execution", async () => {
  let calls = 0;
  for (const credential of [null, { accessToken: "expired-token", expiresAt: 1 }]) {
    const credentials = manager(new MemorySecurityStore({ credential }), async () => { calls++; });
    await assert.rejects(credentials.run(["cart", "list"]), (error) =>
      error.details.code === "DOORDASH_AUTH_REQUIRED" && error.details.commandStarted === false);
    const status = await credentials.status();
    assert.equal(status.authenticated, false);
    assert.match(status.message, /doordash_auth/);
  }
  assert.equal(calls, 0);
});

test("replacement validates read-only, updates immediately, and survives a manager restart", async () => {
  const store = new MemorySecurityStore({ credential: null });
  const calls = [];
  const runCli = async (args, options) => {
    calls.push({ args, options });
    return execution(args[0] === "address" ? { addresses: [] } : { carts: [] });
  };
  const credentials = manager(store, runCli);
  const token = jwt(Math.floor(Date.now() / 1_000) + 3_600);
  const updated = await credentials.replace(token);
  assert.equal(updated.authenticated, true);
  assert.equal(updated.expires_at, new Date(accessTokenExpiry(token)).toISOString());
  assert.equal(JSON.stringify(updated).includes(token), false);
  assert.deepEqual(calls[0].args, ["address", "list"]);
  assert.equal(calls[0].options.allowPurchases, false);
  await credentials.run(["cart", "list"]);
  assert.equal(calls.at(-1).options.accessToken, token);
  const restarted = manager(store, runCli);
  await restarted.initialize("malformed\nstale-env-token");
  await restarted.run(["cart", "list"]);
  assert.equal(calls.at(-1).options.accessToken, token);
});

test("environment token only seeds an empty credential store", async () => {
  const store = new MemorySecurityStore({ credential: null });
  const credentials = manager(store);
  await credentials.initialize("initial-token");
  assert.equal(store.getCredential().accessToken, "initial-token");
  await credentials.replace("replacement-token");
  await credentials.initialize("stale-token");
  assert.equal(store.getCredential().accessToken, "replacement-token");
});

test("invalid replacement retains the saved token and exposes no credential", async () => {
  const store = new MemorySecurityStore();
  const invalidToken = "secret-invalid-replacement";
  const credentials = manager(store, async () => {
    throw new DoorDashCliError(`Invalid token ${invalidToken}`, { data: { access_token: invalidToken } });
  });
  await assert.rejects(credentials.replace(invalidToken), (error) => {
    assert.equal(JSON.stringify({ message: error.message, details: error.details }).includes(invalidToken), false);
    return error.details.code === "CREDENTIAL_VALIDATION_FAILED";
  });
  assert.equal(store.getCredential().accessToken, "test-doordash-access-token");
});

test("token is removed from CLI successes, stderr, nested values, and failure details", async () => {
  const token = "test-doordash-access-token";
  const store = new MemorySecurityStore();
  const success = manager(store, async () => ({
    ...execution({ note: token, nested: [{ access_token: token, refresh_token: "refresh-secret" }] }),
    stderr: `echoed ${token}`
  }));
  const result = await success.run(["cart", "list"]);
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.equal(JSON.stringify(result).includes("refresh-secret"), false);
  const failure = manager(store, async () => { throw new DoorDashCliError(`upstream echoed ${token}`, { stderr: token }); });
  await assert.rejects(failure.run(["cart", "list"]), (error) => {
    assert.equal(JSON.stringify({ message: error.message, details: error.details }).includes(token), false);
    return true;
  });
});

test("structured authentication errors become renewal errors even with process exit zero", async () => {
  for (const shape of [
    { isError: true, structuredContent: { error: { code: "TOKEN_EXPIRED", message: "expired" } } },
    { isError: false, structuredContent: { success: false, error_reason: "TOKEN_EXPIRED", error_message: "expired" } }
  ]) {
    const credentials = manager(new MemorySecurityStore(), async () => ({ ok: true, data: shape }));
    await assert.rejects(credentials.run(["cart", "list"]), (error) =>
      error.details.code === "DOORDASH_AUTH_REQUIRED" && error.details.commandStarted === true);
  }
});

test("authorization failures retain the credential and do not request renewal", async () => {
  let calls = 0;
  const credentials = manager(new MemorySecurityStore(), async () => {
    if (++calls === 1) throw new DoorDashCliError("Insufficient payment scope", { statusCode: 403 });
    return execution({ carts: [] });
  });
  await assert.rejects(credentials.run(["payment-method", "list"]), /Insufficient payment scope/);
  await credentials.run(["cart", "list"]);
  assert.equal(calls, 2);
});

test("MCP renews an expired credential and continues without restart or secret logging", async () => {
  const store = new MemorySecurityStore({ credential: { accessToken: "old-secret", expiresAt: 1 } });
  const info = auth(store);
  const tokens = [];
  const { mcpHandler, activityLog } = createDoorDashApp({
    securityStore: store, adminAccessToken: "test-admin-secret",
    runCli: async (_args, options) => { tokens.push(options.accessToken); return execution({ addresses: [] }); }
  });
  const failure = await rpc(mcpHandler, info, "list_addresses");
  assert.equal(failure.isError, true);
  assert.equal(failure.structuredContent.error.code, "DOORDASH_AUTH_REQUIRED");
  assert.equal(failure.structuredContent.error.recovery_tool, "doordash_auth");
  assert.equal(tokens.length, 0);
  const status = await rpc(mcpHandler, info, "doordash_auth");
  assert.equal(status.structuredContent.authenticated, false);
  const renewed = await rpc(mcpHandler, info, "doordash_auth", { access_token: "new-secret" });
  assert.equal(renewed.structuredContent.authenticated, true);
  const resumed = await rpc(mcpHandler, info, "list_addresses");
  assert.equal(resumed.isError, undefined);
  assert.deepEqual(tokens, ["new-secret", "new-secret"]);
  assert.equal(JSON.stringify({ renewed, resumed, log: activityLog.list() }).includes("new-secret"), false);
  await mcpHandler.close();
});

test("MCP revocation during validation prevents credential replacement", async () => {
  const store = new MemorySecurityStore();
  const info = auth(store);
  const { mcpHandler } = createDoorDashApp({
    securityStore: store, adminAccessToken: "test-admin-secret",
    runCli: async () => { store.revokeToken(info.clientId); return execution({ addresses: [] }); }
  });
  const result = await rpc(mcpHandler, info, "doordash_auth", { access_token: "replacement-secret" });
  assert.equal(result.structuredContent.error.code, "MCP_ACCESS_REVOKED");
  assert.equal(store.getCredential().accessToken, "test-doordash-access-token");
  await mcpHandler.close();
});

test("simultaneous MCP credential replacements are serialized with checkout state", async () => {
  const store = new MemorySecurityStore();
  const info = auth(store);
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  const { mcpHandler } = createDoorDashApp({
    securityStore: store, adminAccessToken: "test-admin-secret",
    runCli: async () => { started(); await released; return execution({ addresses: [] }); }
  });
  const first = rpc(mcpHandler, info, "doordash_auth", { access_token: "first-secret" }, 1);
  await startedPromise;
  const second = await rpc(mcpHandler, info, "doordash_auth", { access_token: "second-secret" }, 2);
  assert.equal(second.isError, true);
  assert.equal(second.structuredContent.error.code, "CHECKOUT_STATE_CHANGE_IN_PROGRESS");
  release();
  assert.equal((await first).structuredContent.authenticated, true);
  assert.equal(store.getCredential().accessToken, "first-secret");
  await mcpHandler.close();
});
