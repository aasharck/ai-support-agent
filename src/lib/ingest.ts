// Ingestion: markdown/PDF files → chunks → embeddings → pgvector.
// Re-running is cheap: unchanged files (same bytes, same embedder) are skipped, changed
// files are replaced, and files that were deleted from the folder are removed.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { chunkMarkdown, chunkPdfPages, type Chunk } from "./chunk";
import type { Db } from "./db";
import { toVectorLiteral, type Embedder } from "./embed";

export const SUPPORTED = [".md", ".pdf"];

export async function loadFile(filePath: string): Promise<{ title: string; chunks: Chunk[]; bytes: Buffer }> {
  const bytes = await readFile(filePath);
  if (filePath.endsWith(".pdf")) {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractText(pdf, { mergePages: false });
    return { ...chunkPdfPages(text), bytes };
  }
  return { ...chunkMarkdown(bytes.toString("utf8")), bytes };
}

export interface IngestReport {
  added: string[];
  skipped: string[];
  removed: string[];
  chunks: number;
}

export async function ingestDirectory(db: Db, dir: string, embedder: Embedder): Promise<IngestReport> {
  const files = (await readdir(dir)).filter((f) => SUPPORTED.includes(path.extname(f))).sort();
  const report: IngestReport = { added: [], skipped: [], removed: [], chunks: 0 };

  for (const file of files) {
    const { title, chunks, bytes } = await loadFile(path.join(dir, file));
    const checksum = createHash("sha256").update(embedder.name).update(bytes).digest("hex");
    const existing = await db.query<{ checksum: string }>("select checksum from documents where path = $1", [file]);
    if (existing.rows[0]?.checksum === checksum) {
      report.skipped.push(file);
      continue;
    }
    // Embed each chunk with its document title and section heading, so a chunk that
    // says "Descale every 2 months" is still found by "descale the Bloom One".
    const vectors = await embedder.embed(
      chunks.map((c) => `${title}. ${c.section}.\n${c.content}`),
      "document",
    );
    await db.query("delete from documents where path = $1", [file]);
    const doc = await db.query<{ id: number }>(
      "insert into documents (path, title, checksum) values ($1, $2, $3) returning id",
      [file, title || file, checksum],
    );
    for (const [i, c] of chunks.entries()) {
      await db.query(
        "insert into chunks (document_id, ordinal, section, content, embedding) values ($1, $2, $3, $4, $5::vector)",
        [doc.rows[0].id, i, c.section, c.content, toVectorLiteral(vectors[i])],
      );
    }
    report.added.push(file);
    report.chunks += chunks.length;
  }

  const gone = await db.query<{ path: string }>("delete from documents where not (path = any($1)) returning path", [files]);
  report.removed = gone.rows.map((r) => r.path);
  return report;
}
