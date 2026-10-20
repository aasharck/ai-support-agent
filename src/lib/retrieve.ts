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
/** At most this many chunks per file, so one file that matches a product name can't fill the top 5. */
export const MAX_PER_DOCUMENT = 3;

/** Top chunks for a question, best first. Empty when nothing clears the embedder's threshold. */
export async function retrieve(db: Db, embedder: Embedder, question: string, k = TOP_K): Promise<Retrieved[]> {
  const [vector] = await embedder.embed([question], "query");
  const { rows } = await db.query<Retrieved>(
    "select id, path, title, section, content, similarity from match_chunks($1::vector, $2, $3)",
    [toVectorLiteral(vector), k * 3, embedder.minSimilarity],
  );
  const perDocument = new Map<string, number>();
  return rows
    .map((r) => ({ ...r, id: Number(r.id), similarity: Number(r.similarity) }))
    .filter((r) => embedder.accept?.(question, `${r.section}\n${r.content}`) ?? true)
    .filter((r) => {
      const n = (perDocument.get(r.path) ?? 0) + 1;
      perDocument.set(r.path, n);
      return n <= MAX_PER_DOCUMENT;
    })
    .slice(0, k);
}
