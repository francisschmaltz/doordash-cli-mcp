import { pathToFileURL } from "node:url";

import { createDatabasePool, databaseConfigFromEnv } from "../src/database.js";
import { runMigrations } from "../src/migrations.js";

export async function migrate(environment = process.env) {
  const pool = createDatabasePool(databaseConfigFromEnv(environment));
  try {
    return await runMigrations(pool);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const applied = await migrate();
    console.log(`PostgreSQL migrations complete (${applied.length} applied).`);
  } catch {
    console.error("PostgreSQL migration failed. Check database connectivity and permissions.");
    process.exitCode = 1;
  }
}
