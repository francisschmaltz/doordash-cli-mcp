import pg from "pg";

const { Pool } = pg;

function boolean(value, fallback = false) {
  if (value === undefined || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

export function databaseConfigFromEnv(environment = process.env) {
  return {
    databaseUrl: String(environment.DATABASE_URL || "").trim(),
    databaseSsl: boolean(environment.DATABASE_SSL),
    databaseSslRejectUnauthorized: boolean(
      environment.DATABASE_SSL_REJECT_UNAUTHORIZED,
      true
    )
  };
}

export function createDatabasePool({
  databaseUrl = process.env.DATABASE_URL,
  databaseSsl = process.env.DATABASE_SSL,
  databaseSslRejectUnauthorized = process.env.DATABASE_SSL_REJECT_UNAUTHORIZED,
  ...poolOptions
} = {}) {
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL.");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("DATABASE_URL must use PostgreSQL.");
  }
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: "doordash-cli-mcp",
    ssl: boolean(databaseSsl)
      ? { rejectUnauthorized: boolean(databaseSslRejectUnauthorized, true) }
      : false,
    ...poolOptions
  });
  // Idle connection failures must not terminate the process. Readiness and
  // subsequent requests still report failure through their own database queries.
  pool.on("error", () => {});
  return pool;
}

export async function withTransaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
