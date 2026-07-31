import path from "node:path";

import { createDoorDashApp } from "./app.js";
import { SecurityStore } from "./security-store.js";

const HOST = process.env.HOST || "127.0.0.1";
const PORT = parsePort(process.env.PORT || "8787");
const CLI_TIMEOUT_MS = parseTimeout(process.env.DD_CLI_TIMEOUT_MS || "120000");
const ALLOWED_HOSTS = parseAllowedHosts(process.env.DD_MCP_ALLOWED_HOSTS);
const DATABASE_PATH = path.resolve(
  process.env.DD_MCP_DB_PATH || ".data/doordash-mcp.sqlite"
);

function parsePort(value) {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid PORT: ${value}`);
  }
  return port;
}

function parseTimeout(value) {
  const timeout = Number.parseInt(value, 10);
  if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 600_000) {
    throw new Error(`Invalid DD_CLI_TIMEOUT_MS: ${value}`);
  }
  return timeout;
}

function parseAllowedHosts(value) {
  const defaults = ["localhost", "127.0.0.1", "[::1]", "host.docker.internal"];
  const hosts = value
    ? value
        .split(",")
        .map((host) => host.trim())
        .filter(Boolean)
    : defaults;
  return [...new Set(hosts)];
}

const securityStore = new SecurityStore({
  databasePath: DATABASE_PATH
});
const { app, mcpHandler } = createDoorDashApp({
  securityStore,
  host: HOST,
  allowedHosts: ALLOWED_HOSTS,
  cliTimeoutMs: CLI_TIMEOUT_MS
});

const httpServer = app.listen(PORT, HOST, () => {
  console.log(`DoorDash MCP listening on http://${HOST}:${PORT}/mcp`);
  console.log("MCP bearer authentication required");
  console.log(`Admin UI available locally at http://127.0.0.1:${PORT}/`);
});

async function shutdown(signal) {
  console.log(`Received ${signal}; shutting down.`);
  httpServer.close(async () => {
    await mcpHandler.close();
    securityStore.close();
    process.exit(0);
  });
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
