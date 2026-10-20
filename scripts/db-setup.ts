// Sets up a real Postgres/Supabase database: schema, demo orders, then the docs.
// Usage: DATABASE_URL=postgresql://... npm run db:setup
import { applySchema, openPostgres } from "../src/lib/db";
import { getEmbedder } from "../src/lib/embed";
import { ingestDirectory } from "../src/lib/ingest";
import { DOCS_DIR } from "../src/lib/store";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Set DATABASE_URL to your Supabase connection string (Project settings → Database).");
  process.exit(2);
}
const db = await openPostgres(url);
try {
  await applySchema(db);
  console.log("Schema and demo orders applied.");
  const report = await ingestDirectory(db, DOCS_DIR, getEmbedder());
  console.log(`Ingested ${report.added.length} files (${report.chunks} chunks), ${report.skipped.length} unchanged, ${report.removed.length} removed.`);
} finally {
  await db.close();
}
