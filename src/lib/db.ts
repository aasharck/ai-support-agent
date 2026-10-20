// Two database backends with the same SQL:
// - DATABASE_URL set: a real Postgres with pgvector (your Supabase project).
// - otherwise: PGlite, Postgres compiled to WebAssembly, in memory, with pgvector loaded.
//   Nothing to install, and every start is a clean, freshly seeded database.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface Db {
  kind: "pglite" | "postgres";
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export const ROOT = process.cwd();

export async function openPglite(): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite-pgvector");
  const pg = new PGlite({ extensions: { vector } });
  return {
    kind: "pglite",
    query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await pg.query<T>(sql, params)).rows }),
    exec: async (sql) => void (await pg.exec(sql)),
    close: () => pg.close(),
  };
}

export async function openPostgres(connectionString: string): Promise<Db> {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString, max: 5 });
  return {
    kind: "postgres",
    query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await pool.query(sql, params)).rows as T[] }),
    exec: async (sql) => void (await pool.query(sql)),
    close: () => pool.end(),
  };
}

/** Applies supabase/migrations/*.sql in order, then supabase/seed.sql. Idempotent. */
export async function applySchema(db: Db, root = ROOT): Promise<void> {
  const dir = path.join(root, "supabase", "migrations");
  for (const file of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(await readFile(path.join(dir, file), "utf8"));
  }
  await db.exec(await readFile(path.join(root, "supabase", "seed.sql"), "utf8"));
}
