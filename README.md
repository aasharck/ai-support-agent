# ai-support-agent

A customer-support agent that answers from a business's own docs. Every answer cites the doc section it came from, it says "I don't know" when the docs don't cover a question, and it can look up an order or open a support ticket.

It's a demo built for **Tamp & Bloom, a made-up coffee-equipment shop**: 6 markdown help pages, 1 PDF quick-start guide, 4 demo orders. Swap `docs/` for your own files and it answers from those instead.

**Stack:** Next.js 16 · Postgres + pgvector (Supabase, or an embedded PGlite database locally) · Claude API (`claude-opus-5-5`) with tool use and citations · TypeScript · Vitest.

## What it does
| | |
|---|---|
| **Answers from your docs** | Markdown and PDF files are split by section, embedded, and stored in pgvector. Each question pulls the 5 closest chunks. |
| **Cites every answer** | Chunks go to Claude as documents with Anthropic's citations feature on, so each claim points at the exact passage: `[1] returns.md › Refund timing`. |
| **Says "I don't know"** | When nothing relevant is retrieved, or Claude can't support an answer with a citation, the reply is a fixed "I don't know… I can open a ticket" message. A **grounding guard** in code replaces any factual answer that cites nothing. |
| **Takes actions** | Two tools: `lookup_order` (needs the order number *and* the email on it) and `create_ticket`. Every tool call is validated with zod before it touches the database. |
| **Shows its cost** | Each answer shows model, latency and dollar cost; the server logs one JSON line per answer. |

### Guardrails
- Order lookup needs both order number and email, and gives the same "no match" message whether the order doesn't exist or the email is wrong, so it can't be used to discover orders.
- A ticket can't be attached to someone else's order, and one email address can open at most 3 tickets an hour.
- Tool inputs are strict: unknown fields, malformed order numbers or bad emails go back to Claude as an error instead of running.
- The tool loop stops after 5 rounds.
- Tables have row-level security on with no policies, so Supabase's public `anon` key can't read orders or tickets. Only the server talks to the database.

## Run it
Needs Node 22.9+.
```bash
npm install
npm run dev        # http://localhost:3000
```
That's the whole setup. With no environment variables it runs in **mock mode** on an in-memory Postgres (PGlite with pgvector) that's created, seeded and filled from `docs/` on start.

| Mode | When | Answers come from |
|---|---|---|
| **Mock** (labelled in the UI) | No `ANTHROPIC_API_KEY`, or `MOCK_LLM=1` | The best-matching sentence of the top chunk, picked by fixed rules. No AI model is called, nothing costs money. Retrieval, citations, tools and the database are the real code. |
| **Live** | `ANTHROPIC_API_KEY` set | Claude (`claude-opus-5-5` by default, `ANTHROPIC_MODEL` to change), low effort, with server-side refusal fallback on. Estimated $0.01–0.03 per answer; the UI and eval show the measured cost. |

Copy `.env.example` to `.env` to set keys.

### With Supabase
```bash
# .env: DATABASE_URL=postgresql://... (Supabase → Project settings → Database)
npm run db:setup   # applies supabase/migrations + seed.sql, then ingests docs/
npm run dev
```
`npm run ingest` re-ingests after you change `docs/`: unchanged files are skipped, changed ones replaced, deleted ones removed.

### Better embeddings
The default embedder is a local word-hashing embedder: free, offline, deterministic, but it matches words, not meaning. For real use, set `VOYAGE_API_KEY` and `VOYAGE_MODEL` and re-ingest; vectors are 1024-dimensional either way.

## Tests
```bash
npm test           # 46 tests, no network, no API key
```
- **Retrieval:** the right chunk comes back first for 6 questions across markdown and the PDF; out-of-scope questions return nothing; re-ingesting is a no-op.
- **Citations:** every answer carries `[n]` markers and each cited passage exists in the database.
- **Refusal:** out-of-scope questions get the "I don't know" reply with no citations and no tool calls.
- **Tools:** malformed order numbers, missing emails, extra fields, someone else's order and ticket flooding are all rejected.
- **Live path:** the Claude code path runs against a scripted fake client: request shape, the tool loop, invalid tool input sent back as an error, citation mapping, the grounding guard, the 5-round limit and cost.

## Eval
```bash
npm run eval       # 15 questions, prints a score
```
10 questions the docs answer (each must cite the right file and include the key fact), 2 the docs don't cover (must say "I don't know"), 3 tool cases (order status, wrong email must not leak the order, open a ticket). In live mode it also prints the API cost.

Mock mode output:
```
✓ shipping-uae
✓ shipping-free
✓ return-used-grinder
✗ refund-timing            missing "5-7 business days"
✗ warranty-burrline        didn't cite warranty.md (cited: burrline-64-grinder.md); missing "1-year"
✓ descale
...
Score: 13/15 (87%)
Retrieval: the expected file was in the top 5 chunks for 10/10 docs questions
```
The two misses are the point of having an eval: mock mode answers from the top chunk only, and the word-matching embedder ranks "Burrline 64" over "warranty". Live mode reads all 5 chunks; real embeddings fix the ranking.

## How it works
```
docs/*.md, *.pdf ──► chunk by heading / page ──► embed ──► pgvector (chunks)
                                                               │
question ──► embed ──► match_chunks() top 5 ─────────────────┘
                              │
                              ▼
            Claude: system prompt + chunks as citable documents + 2 tools
                              │
         tool_use? ──► zod validation ──► orders / tickets tables ──► tool_result
                              │
                              ▼
          answer + [n] citations ──► grounding guard ──► UI (sources, tools, cost)
```

| File | What's in it |
|---|---|
| `src/lib/ingest.ts`, `chunk.ts` | Markdown/PDF → chunks (section-aware, list items split, long sections split with overlap) → embeddings |
| `src/lib/retrieve.ts` | Similarity search through the `match_chunks` SQL function |
| `src/lib/agent.ts` | System prompt, Claude tool loop, citation mapping, grounding guard, mock mode |
| `src/lib/tools.ts` | Tool schemas and validated handlers |
| `supabase/migrations/` | Tables, HNSW index, `match_chunks`, RLS |

## Limits
- One question at a time: retrieval uses the latest message only, so a vague follow-up ("and for grinders?") can miss.
- Answers aren't streamed yet.
- In mock mode, answers are extracted sentences, not written replies.
- The demo shop, its docs, orders and emails are made up.

MIT licence.
