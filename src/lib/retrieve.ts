import type { Db } from "./db";
import { toVectorLiteral, type Embedder } from "./embed";

export interface Retrieved {
  id: number;
  path: string;
  title: string;
  section: string;
  content: string;
  similarity: number;
}

export const TOP_K = 5;

/** Top chunks for a question, best first. Empty when nothing clears the embedder's threshold. */
export async function retrieve(db: Db, embedder: Embedder, question: string, k = TOP_K): Promise<Retrieved[]> {
  const [vector] = await embedder.embed([question], "query");
  const { rows } = await db.query<Retrieved>(
    "select id, path, title, section, content, similarity from match_chunks($1::vector, $2, $3)",
    [toVectorLiteral(vector), k, embedder.minSimilarity],
  );
  return rows
    .map((r) => ({ ...r, id: Number(r.id), similarity: Number(r.similarity) }))
    .filter((r) => embedder.accept?.(question, `${r.section}\n${r.content}`) ?? true);
}
