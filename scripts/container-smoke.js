import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";

const execute = promisify(execFile);
const suffix = randomBytes(6).toString("hex");
const network = `doordash-smoke-${suffix}`;
const database = `${network}-postgres`;
const app = `${network}-app`;
const image = process.env.CONTAINER_IMAGE || "doordash-cli-mcp:test";
const adminToken = randomBytes(32).toString("hex");
let baseUrl;
let rpcId = 0;

async function docker(args) {
  try {
    const { stdout, stderr } = await execute("docker", args, { timeout: 120_000 });
    return (args[0] === "logs" ? `${stdout}${stderr}` : stdout).trim();
  } catch {
    throw new Error(`Docker ${args[0]} failed during container smoke verification.`);
  }
}

async function waitFor(check, description) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {
      // Startup and database recovery can briefly reject connections.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

function request(route, options = {}) {
  return fetch(`${baseUrl}${route}`, {
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
    ...options
  });
}

async function rpc(method, params, token) {
  const response = await request("/mcp", {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-11-25",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params })
  });
  const text = await response.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  let body = null;
  try {
    body = dataLine ? JSON.parse(dataLine.slice(6)) : (text ? JSON.parse(text) : null);
  } catch {
    if (response.ok) throw new Error("MCP returned an invalid protocol response.");
  }
  return {
    status: response.status,
    body
  };
}

try {
  assert.match(await docker(["run", "--rm", "--platform", "linux/amd64", image, "/usr/local/bin/dd-cli", "--version"]), /0\.2\.5/);
  assert.equal(await docker(["run", "--rm", "--platform", "linux/amd64", image, "id", "-u"]), "1000", "The image must run as the non-root node user.");
  await docker(["network", "create", network]);
  await docker([
    "run", "--detach", "--name", database, "--network", network,
    "--env", "POSTGRES_USER=doordash", "--env", "POSTGRES_PASSWORD=container_smoke",
    "--env", "POSTGRES_DB=doordash_smoke", "postgres:17"
  ]);
  await waitFor(async () => {
    await docker(["exec", database, "pg_isready", "-U", "doordash", "-d", "doordash_smoke"]);
    return true;
  }, "PostgreSQL startup");
  await docker([
    "run", "--detach", "--platform", "linux/amd64", "--name", app,
    "--network", network, "--publish", "127.0.0.1::8787",
    "--env", `DATABASE_URL=postgres://doordash:container_smoke@${database}:5432/doordash_smoke`,
    "--env", "DATABASE_SSL=false", "--env", `ADMIN_ACCESS_TOKEN=${adminToken}`, image
  ]);
  const address = await docker(["port", app, "8787/tcp"]);
  baseUrl = `http://${address}`;
  await waitFor(async () => (await request("/health/ready")).status === 200, "server readiness after migrations");
  assert.equal((await request("/health/live")).status, 200);
  assert.notEqual((await request("/api/status")).status, 200, "Admin APIs require authentication.");
  assert.equal((await rpc("tools/list", {})).status, 401, "MCP requires bearer authentication.");
  const creation = await request("/api/tokens", {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Container smoke", allowPurchases: false })
  });
  assert.equal(creation.status, 201);
  const token = await creation.json();
  assert.equal(typeof token.token, "string", "Admin API must return the new bearer once.");
  const listed = await rpc("tools/list", {}, token.token);
  assert.equal(listed.status, 200);
  assert.ok(listed.body.result.tools.some((tool) => tool.name === "doordash_auth"));
  assert.ok(!listed.body.result.tools.some((tool) => tool.name === "order_submit"));
  const auth = await rpc("tools/call", { name: "doordash_auth", arguments: {} }, token.token);
  assert.equal(auth.status, 200, "Missing DoorDash credentials must remain recoverable through MCP.");
  assert.ok(auth.body.result, "Authentication status should return a tool result.");
  assert.ok(!JSON.stringify(auth.body).includes(adminToken), "Tool responses must omit credentials.");

  await docker(["restart", app]);
  await waitFor(async () => (await request("/health/ready")).status === 200, "server readiness after restart");
  assert.equal((await rpc("tools/list", {}, token.token)).status, 200, "Bearer tokens must survive container restart.");

  await docker(["stop", "--time", "5", database]);
  await waitFor(async () => (await request("/health/ready")).status === 503, "unready status during database outage");
  assert.equal((await request("/health/live")).status, 200, "Database failure must not change process liveness.");
  await docker(["start", database]);
  await waitFor(async () => (await request("/health/ready")).status === 200, "readiness after database recovery");
  const revocation = await request(`/api/tokens/${token.id}`, {
    method: "DELETE", headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.ok(revocation.ok);
  assert.equal((await rpc("tools/list", {}, token.token)).status, 401, "Revocation must take effect immediately.");
  const logs = await docker(["logs", app]);
  assert.ok(!logs.includes(adminToken) && !logs.includes(token.token), "Container logs must omit credentials.");
  console.log("Linux container smoke passed: CLI, non-root runtime, migrations, HTTP/MCP authentication, restart persistence, revocation, and database outage/recovery.");
} finally {
  await docker(["rm", "--force", app]).catch(() => {});
  await docker(["rm", "--force", "--volumes", database]).catch(() => {});
  await docker(["network", "rm", network]).catch(() => {});
}
