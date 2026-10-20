import { describe, expect, test } from "vitest";
import { chunkMarkdown, chunkPdfPages } from "../src/lib/chunk";
import { stem, tokenize } from "../src/lib/embed";
import { loadFile } from "../src/lib/ingest";

describe("chunking", () => {
  test("splits markdown into one chunk per heading, keeping the section name", () => {
    const { title, chunks } = chunkMarkdown("# Returns\n\nIntro text.\n\n## Refund timing\n\nRefunds take 5 days.\n\n## Damaged\n\nTell us in 48 hours.");
    expect(title).toBe("Returns");
    expect(chunks.map((c) => c.section)).toEqual(["Overview", "Refund timing", "Damaged"]);
    expect(chunks[1].content).toBe("Refunds take 5 days.");
  });

  test("gives each item of a list-only section its own chunk", () => {
    const { chunks } = chunkMarkdown("# M\n\n## Error codes\n\n- **E1: tank empty.** Refill.\n- **E2: hot.** Cool down.\n- **E3: low pressure.** Descale.");
    expect(chunks.map((c) => c.section)).toEqual(["Error codes: E1: tank empty", "Error codes: E2: hot", "Error codes: E3: low pressure"]);
  });

  test("splits long sections on paragraphs", () => {
    const para = "word ".repeat(150).trim();
    const { chunks } = chunkMarkdown(`# T\n\n## Long\n\n${para}\n\n${para}\n\n${para}`);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].section).toBe("Long (part 1)");
  });

  test("reads the sample PDF into one chunk per page", async () => {
    const { title, chunks } = await loadFile("docs/pourwell-kettle-quickstart.pdf");
    expect(title).toBe("Pourwell kettle: quick start");
    expect(chunks).toHaveLength(2);
    expect(chunks[0].section).toBe("p. 1: Pourwell kettle: quick start");
    expect(chunks[0].content).toContain("96 degrees");
  });

  test("PDF chunker uses each page's first line as its heading", () => {
    const { chunks } = chunkPdfPages(["Heading A\nline one\nline two", "Heading B\nmore"]);
    expect(chunks).toEqual([
      { section: "p. 1: Heading A", content: "line one line two" },
      { section: "p. 2: Heading B", content: "more" },
    ]);
  });

  test("tokenizer drops stopwords and matches word forms", () => {
    expect(stem("descaling")).toBe(stem("descale"));
    expect(stem("shipping")).toBe(stem("ship"));
    expect(stem("returns")).toBe(stem("return"));
    expect(tokenize("How do I descale the machine?")).toEqual(["descal", "machin"]);
  });
});
