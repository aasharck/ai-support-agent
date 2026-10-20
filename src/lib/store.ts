// One database per server process. Without DATABASE_URL the embedded database is
// created, migrated, seeded and filled from docs/ on first use (about a second).
import path from "node:path";
import { applySchema, openPglite, openPostgres, ROOT, type Db } from "./db";
import { getEmbedder } from "./embed";
import { ingestDirectory } from "./ingest";

export const DOCS_DIR = path.join(ROOT, "docs");

export async function createLocalDb(docsDir = DOCS_DIR): Promise<Db> {
  const db = await openPglite();
  await applySchema(db);
  await ingestDirectory(db, docsDir, getEmbedder());
  return db;
}

const g = globalThis as { __supportDb?: Promise<Db> };

export function getDb(): Promise<Db> {
  g.__supportDb ??= (process.env.DATABASE_URL ? openPostgres(process.env.DATABASE_URL) : createLocalDb()).catch((err) => {
    g.__supportDb = undefined;
    throw err;
  });
  return g.__supportDb;
}
