// Embeddings. Two providers behind one interface:
// - local (default): deterministic feature-hashing embedder. Free, offline, no model
//   download. It matches words, not meaning, so it's for demos and tests.
// - voyage (optional): a real embedding model through Voyage AI's API, used when
//   VOYAGE_API_KEY and VOYAGE_MODEL are both set.
export const DIMENSIONS = 1024;

export interface Embedder {
  /** Stored with each document's checksum, so switching embedders re-ingests. */
  name: string;
  /** Chunks below this cosine similarity are treated as "not about this question". */
  minSimilarity: number;
  embed(texts: string[], kind: "document" | "query"): Promise<number[][]>;
  /** Optional second check on a match, e.g. to drop matches that only come from hash collisions. */
  accept?(query: string, chunkText: string): boolean;
}

const STOPWORDS = new Set(
  (
    "a an and are as at be been but by can could do does did doing for from had has have how i if in into is it its " +
    "me my of on or our ours please should so than that the their them then there these they this to too us was we " +
    "were what when where which while who why will with would you your yours i'm i've it's don't can't what's " +
    "hi hello hey thanks thank about any some get got need want know tell take takes long much many also just " +
    "use used using make made after before again still"
  ).split(" "),
);

/** Very small stemmer: enough to match descale/descaling, return/returns, ship/shipping. */
export function stem(word: string): string {
  let w = word.replace(/'s$/, "");
  for (const suffix of ["ing", "ed", "es", "s"]) {
    if (w.endsWith(suffix) && w.length - suffix.length >= 3 && !(suffix === "s" && w.endsWith("ss"))) {
      w = w.slice(0, -suffix.length);
      break;
    }
  }
  if (/([b-df-hj-np-tv-z])\1$/.test(w) && !/(ll|ss|zz)$/.test(w)) w = w.slice(0, -1);
  if (w.length > 3 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+(?:'[a-z]+)?/g) ?? [])
    .filter((t) => !STOPWORDS.has(t))
    .map(stem)
    .filter((t) => t.length > 1 || /\d/.test(t));
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function hashEmbed(text: string): number[] {
  const v = new Array<number>(DIMENSIONS).fill(0);
  const tokens = tokenize(text);
  const counts = new Map<string, number>();
  for (let i = 0; i < tokens.length; i++) {
    counts.set(tokens[i], (counts.get(tokens[i]) ?? 0) + 1);
    if (i > 0) counts.set(`${tokens[i - 1]} ${tokens[i]}`, (counts.get(`${tokens[i - 1]} ${tokens[i]}`) ?? 0) + 0.5);
  }
  for (const [feature, count] of counts) {
    const h = fnv1a(feature);
    // Sublinear term frequency (bigrams count half); the top bit picks the sign to
    // spread hash collisions.
    const weight = count >= 1 ? 1 + Math.log(count) : count;
    v[h % DIMENSIONS] += (h & 0x80000000 ? -1 : 1) * weight;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

export const localEmbedder: Embedder = {
  name: "local-hash-v1",
  minSimilarity: 0.14,
  embed: async (texts) => texts.map(hashEmbed),
  // Hashing 1,000+ features into 1,024 slots collides, so an unrelated question can
  // score above zero. Keep a match only if it shares at least one real word.
  accept: (query, chunkText) => {
    const words = new Set(tokenize(chunkText));
    return tokenize(query).some((t) => words.has(t));
  },
};

export function voyageEmbedder(apiKey: string, model: string): Embedder {
  return {
    name: `voyage:${model}`,
    // Real embeddings score unrelated text higher than the hash embedder does.
    // Tune this on your own eval set before relying on it.
    minSimilarity: 0.35,
    async embed(texts, kind) {
      const res = await fetch("https://api.voyageai.com/v1/embeddings", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ input: texts, model, input_type: kind, output_dimension: DIMENSIONS }),
      });
      if (!res.ok) throw new Error(`Voyage embeddings failed: ${res.status} ${await res.text()}`);
      const json = (await res.json()) as { data: { embedding: number[] }[] };
      return json.data.map((d) => d.embedding);
    },
  };
}

export function getEmbedder(): Embedder {
  const { VOYAGE_API_KEY, VOYAGE_MODEL } = process.env;
  return VOYAGE_API_KEY && VOYAGE_MODEL ? voyageEmbedder(VOYAGE_API_KEY, VOYAGE_MODEL) : localEmbedder;
}

/** pgvector's text format: '[0.1,0.2,...]'. */
export const toVectorLiteral = (v: number[]) => `[${v.join(",")}]`;
