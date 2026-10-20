import { currentMode, DEFAULT_MODEL } from "@/src/lib/agent";
import { getEmbedder } from "@/src/lib/embed";
import { getDb } from "@/src/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const db = await getDb();
  const { rows } = await db.query<{ path: string; title: string; chunks: number }>(
    "select d.path, d.title, count(c.id)::int as chunks from documents d left join chunks c on c.document_id = d.id group by d.id order by d.path",
  );
  const mode = currentMode();
  return Response.json({
    mode,
    model: mode === "live" ? (process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL) : null,
    database: db.kind === "pglite" ? "PGlite (in memory) + pgvector" : "Postgres + pgvector",
    embedder: getEmbedder().name,
    documents: rows,
  });
}
