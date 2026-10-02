import { readFile } from "node:fs/promises";

import { withTransaction } from "./database.js";

const MIGRATIONS = ["001_security.sql", "002_order_preferences.sql"];

export async function runMigrations(pool) {
  return withTransaction(pool, async (client) => {
    // Serialize migration runners across allocations before checking versions.
    await client.query("SELECT pg_advisory_xact_lock(214760, 1)");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at BIGINT NOT NULL
      )
    `);
    const applied = new Set(
      (await client.query("SELECT version FROM schema_migrations")).rows
        .map((row) => row.version)
    );
    const completed = [];
    for (const version of MIGRATIONS) {
      if (applied.has(version)) continue;
      const sql = await readFile(new URL(`../migrations/${version}`, import.meta.url), "utf8");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)",
        [version, Date.now()]
      );
      completed.push(version);
    }
    return completed;
  });
}
