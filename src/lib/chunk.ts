// Splits source documents into retrievable chunks. Each chunk keeps the section it
// came from, so answers can cite "returns.md › Refund timing", not just a file.
export interface Chunk {
  section: string;
  content: string;
}

const MAX_CHARS = 1200;

/** Splits text longer than MAX_CHARS on paragraph breaks, repeating one paragraph as overlap. */
function splitLong(section: string, text: string): Chunk[] {
  if (text.length <= MAX_CHARS) return [{ section, content: text }];
  const paragraphs = text.split(/\n{2,}/);
  const chunks: Chunk[] = [];
  let current: string[] = [];
  for (const p of paragraphs) {
    if (current.length && [...current, p].join("\n\n").length > MAX_CHARS) {
      chunks.push({ section, content: current.join("\n\n") });
      current = [current[current.length - 1]];
    }
    current.push(p);
  }
  if (current.length) chunks.push({ section, content: current.join("\n\n") });
  return chunks.map((c, i) => (chunks.length > 1 ? { ...c, section: `${section} (part ${i + 1})` } : c));
}

/** One chunk per heading section. Text before the first `##` becomes "Overview". */
export function chunkMarkdown(markdown: string): { title: string; chunks: Chunk[] } {
  let title = "";
  let section = "Overview";
  let body: string[] = [];
  const chunks: Chunk[] = [];
  const flush = () => {
    const text = body.join("\n").trim();
    const items = text.split("\n").filter((l) => /^[-*]\s+/.test(l));
    if (items.length >= 3 && items.length === text.split("\n").filter((l) => l.trim()).length) {
      // A section that is only a list (error codes, exclusions) gets one chunk per item,
      // so "E3" matches the E3 line instead of a long list where it's one word in fifty.
      for (const item of items) {
        const clean = item.replace(/^[-*]\s+/, "");
        const label = /^\*\*(.+?)\*\*/.exec(clean)?.[1].replace(/[.:]$/, "") ?? clean.split(/[.,:]/)[0];
        chunks.push({ section: `${section}: ${label}`, content: clean });
      }
    } else if (text) {
      chunks.push(...splitLong(section, text));
    }
    body = [];
  };
  for (const line of markdown.split("\n")) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading && heading[1].length === 1 && !title) {
      title = heading[2].trim();
    } else if (heading) {
      flush();
      section = heading[2].trim();
    } else {
      body.push(line);
    }
  }
  flush();
  return { title, chunks };
}

/** One chunk per PDF page; the page's first line is used as its heading. */
export function chunkPdfPages(pages: string[]): { title: string; chunks: Chunk[] } {
  const chunks: Chunk[] = [];
  pages.forEach((page, i) => {
    const [first = "", ...rest] = page.split("\n").map((l) => l.trim());
    const text = rest.join(" ").replace(/\s+/g, " ").trim();
    if (text) chunks.push(...splitLong(`p. ${i + 1}: ${first}`, text));
  });
  return { title: pages[0]?.split("\n")[0]?.trim() ?? "", chunks };
}
