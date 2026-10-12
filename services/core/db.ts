import pg from "pg";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
export const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgres://concord:local-development-only@localhost:55432/concord",
  max: 20,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000,
});
export type DB = Pick<pg.PoolClient, "query">;
export async function transaction<T>(fn: (db: DB) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
export async function migrate() {
  await transaction(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(712340)");
    await db.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const name of (await fs.readdir("migrations"))
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      const sql = await fs.readFile(`migrations/${name}`, "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const old = await db.query(
        "SELECT checksum FROM schema_migrations WHERE name=$1",
        [name],
      );
      if (old.rowCount) {
        if (old.rows[0].checksum !== checksum)
          throw new Error(`Migration checksum changed: ${name}`);
        continue;
      }
      await db.query(sql);
      await db.query("INSERT INTO schema_migrations VALUES($1,$2,now())", [
        name,
        checksum,
      ]);
    }
  });
}
