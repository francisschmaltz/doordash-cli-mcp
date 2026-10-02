import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { createDatabasePool, databaseConfigFromEnv, withTransaction } from "../src/database.js";
import { runMigrations } from "../src/migrations.js";

export async function importSqlite({ sqlitePath, pool, clock = () => Date.now() }) {
  if (!sqlitePath) throw new Error("A source SQLite file is required.");
  const source = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    // A read transaction preserves a coherent snapshot of token and ledger rows.
    source.exec("BEGIN");
    const tokens = source.prepare(`
      SELECT id, name, token_hash, token_prefix, allow_purchases,
        created_at, last_used_at, revoked_at FROM mcp_tokens
    `).all();
    const submissions = source.prepare(`
      SELECT cart_uuid, status, order_uuid, started_at, finished_at, error_message
      FROM order_submission_attempts
    `).all();
    await runMigrations(pool);
    return await withTransaction(pool, async (client) => {
      // Block concurrent server writes until the empty-store check and full
      // import commit together. A failed row rolls back every imported row.
      await client.query(`
        LOCK TABLE mcp_tokens, order_submission_attempts, doordash_credentials,
          sqlite_imports IN SHARE ROW EXCLUSIVE MODE
      `);
      const existing = await client.query(`
        SELECT (SELECT COUNT(*) FROM mcp_tokens)
          + (SELECT COUNT(*) FROM order_submission_attempts)
          + (SELECT COUNT(*) FROM doordash_credentials)
          + (SELECT COUNT(*) FROM sqlite_imports) AS count
      `);
      if (Number(existing.rows[0].count) !== 0) {
        throw new Error("SQLite import requires an empty destination and can run only once.");
      }
      for (const row of tokens) {
        await client.query(`
          INSERT INTO mcp_tokens (
            id, name, token_hash, token_prefix, allow_purchases, created_at,
            last_used_at, revoked_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [
          row.id, row.name, row.token_hash, row.token_prefix, row.allow_purchases === 1,
          row.created_at, row.last_used_at, row.revoked_at
        ]);
      }
      for (const row of submissions) {
        await client.query(`
          INSERT INTO order_submission_attempts (
            cart_uuid, status, order_uuid, started_at, finished_at, error_message
          ) VALUES ($1, $2, $3, $4, $5, $6)
        `, [
          row.cart_uuid, row.status, row.order_uuid, row.started_at,
          row.finished_at, row.error_message
        ]);
      }
      await client.query(`
        INSERT INTO sqlite_imports (id, imported_at, token_count, submission_count)
        VALUES (1, $1, $2, $3)
      `, [clock(), tokens.length, submissions.length]);
      return { tokenCount: tokens.length, submissionCount: submissions.length };
    });
  } finally {
    source.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let pool;
  try {
    const sqlitePath = process.argv[2];
    if (!sqlitePath || process.argv.length !== 3) {
      throw new Error("Usage: npm run import:sqlite -- /path/to/state.sqlite");
    }
    pool = createDatabasePool(databaseConfigFromEnv());
    const result = await importSqlite({ sqlitePath, pool });
    console.log(`SQLite import complete: ${result.tokenCount} tokens, ${result.submissionCount} submission attempts.`);
  } catch (error) {
    const expected = error?.message?.startsWith("SQLite import requires an empty destination")
      || error?.message?.startsWith("Usage:");
    console.error(expected ? error.message : "SQLite import failed. Check the source file and destination database; imported rows were rolled back.");
    process.exitCode = 1;
  } finally {
    await pool?.end();
  }
}
