// Re-ingests docs/ into the database at DATABASE_URL. Unchanged files are skipped.
// Usage: DATABASE_URL=postgresql://... npm run ingest [folder]
import path from "node:path";
import { openPostgres } from "../src/lib/db";
import { getEmbedder } from "../src/lib/embed";
import { ingestDirectory } from "../src/lib/ingest";
import { DOCS_DIR } from "../src/lib/store";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Set DATABASE_URL first. Without it, `npm run dev` ingests docs/ into an in-memory database on start.");
  process.exit(2);
}
const dir = process.argv[2] ? path.resolve(process.argv[2]) : DOCS_DIR;
const db = await openPostgres(url);
try {
  const embedder = getEmbedder();
  const report = await ingestDirectory(db, dir, embedder);
  console.log(`Embedder: ${embedder.name}`);
  for (const f of report.added) console.log(`  + ${f}`);
  for (const f of report.skipped) console.log(`  = ${f} (unchanged)`);
  for (const f of report.removed) console.log(`  - ${f} (removed)`);
  console.log(`${report.chunks} new chunks.`);
} finally {
  await db.close();
}
