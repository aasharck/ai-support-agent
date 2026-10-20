import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Db } from "../src/lib/db";
import { localEmbedder } from "../src/lib/embed";
import { ingestDirectory } from "../src/lib/ingest";
import { MAX_PER_DOCUMENT, retrieve } from "../src/lib/retrieve";
import { createLocalDb, DOCS_DIR } from "../src/lib/store";

let db: Db;
beforeAll(async () => {
  db = await createLocalDb();
});
afterAll(() => db.close());

const top = async (q: string) => (await retrieve(db, localEmbedder, q))[0];

describe("retrieval", () => {
  test("ingests every markdown file and the PDF into pgvector", async () => {
    const { rows } = await db.query<{ path: string; n: number }>(
      "select d.path, count(*)::int as n from chunks c join documents d on d.id = c.document_id group by d.path order by d.path",
    );
    expect(rows.map((r) => r.path)).toEqual([
      "bloom-one-espresso-machine.md",
      "burrline-64-grinder.md",
      "pourwell-kettle-quickstart.pdf",
      "returns.md",
      "shipping.md",
      "store-faq.md",
      "warranty.md",
    ]);
    expect(rows.every((r) => r.n > 0)).toBe(true);
  });

  test.each([
    ["How often should I descale the Bloom One?", "bloom-one-espresso-machine.md", "Descaling"],
    ["My Bloom One shows error E3, what do I do?", "bloom-one-espresso-machine.md", "Error codes: E3: low pump pressure"],
    ["What grind setting should I use for pour-over?", "burrline-64-grinder.md", "Grind settings"],
    ["Can I return a grinder I've already used?", "returns.md", "Opened grinders and machines"],
    ["Do you have a showroom where I can pick up my order?", "store-faq.md", "Showroom"],
    ["What temperature should I use for a light roast with the Pourwell kettle?", "pourwell-kettle-quickstart.pdf", "p. 1: Pourwell kettle: quick start"],
  ])("%s → %s › %s", async (question, path, section) => {
    const hit = await top(question);
    expect(hit).toMatchObject({ path, section });
  });

  test("returns results best first", async () => {
    const hits = await retrieve(db, localEmbedder, "How do I clean the steam wand?");
    const scores = hits.map((h) => h.similarity);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  test(`keeps at most ${MAX_PER_DOCUMENT} chunks per file, so other files still get a look in`, async () => {
    const hits = await retrieve(db, localEmbedder, "How long is the warranty on the Burrline 64 grinder?");
    expect(hits.filter((h) => h.path === "burrline-64-grinder.md")).toHaveLength(MAX_PER_DOCUMENT);
    expect(hits.map((h) => `${h.path} › ${h.section}`)).toContain("warranty.md › Coverage");
  });

  test("returns nothing for questions the docs don't cover", async () => {
    expect(await retrieve(db, localEmbedder, "Do you offer a student discount?")).toEqual([]);
    expect(await retrieve(db, localEmbedder, "Can you recommend a good cafe in Lisbon?")).toEqual([]);
  });

  test("re-ingesting unchanged docs is a no-op", async () => {
    const before = await db.query<{ n: number }>("select count(*)::int as n from chunks");
    const report = await ingestDirectory(db, DOCS_DIR, localEmbedder);
    expect(report.added).toEqual([]);
    expect(report.skipped).toHaveLength(7);
    const after = await db.query<{ n: number }>("select count(*)::int as n from chunks");
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});
