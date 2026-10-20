# NOTES

> **For Aashar:** run `npm install && npm run dev`, click the six sample questions, and read `README.md` and `~/Projects/Freelancing/upwork/portfolio/ai-support-agent.md` for anything you wouldn't say to a client.
> Then run `npm run eval` once with your Anthropic key (estimated under $0.50); the live path has never made a real call.
> Nothing is pushed: push branch `initial-version` to GitHub yourself when you're happy with it.

## Part 1 (Tue Oct 20, morning AI run)
Built unattended while Aashar was away. Nothing pushed, deployed or published. **$0 spent:** there's no `ANTHROPIC_API_KEY` on this machine, so not one Claude call was made.

## What works (verified)
- `npm install && npm run dev` starts the app with no env vars: in-memory PGlite + pgvector, schema + demo orders + docs ingested on start (about 1 s). Checked in `next dev` and in `next build && next start`, and in the browser (screenshot taken during the run, not saved).
- Ingestion of 6 markdown files + 1 PDF → 39 chunks (section-aware; list-only sections split per item; long sections split with overlap). Re-ingest skips unchanged files.
- Retrieval through the `match_chunks` SQL function (cosine, HNSW index), with a threshold and a "shares at least one real word" check for the local embedder.
- Mock agent: cited answers, "I don't know" for out-of-scope questions, order lookup (asks for the email first), ticket creation.
- Tools validated with zod (strict schemas); order lookup needs number + email and doesn't reveal which order numbers exist; ticket rate limit of 3/hour per email; can't attach someone else's order.
- `npm test`: 46 passing at the end of part 1 (47 after part 2). `npm run typecheck`: clean. `npm run build`: clean.
- `npm run eval`: 15 questions, mock score **13/15**, retrieval hit (right file in top 5) 10/10. Misses: `refund-timing` (mock answers from the top chunk only; the right chunk is #2) and `warranty-burrline` (word-matching embedder ranks the Burrline overview above warranty.md › Coverage, which isn't in the top 5).

## What's mocked or untested
- **No live Claude call has been made.** The live path (`answerLive` in `src/lib/agent.ts`) is typechecked against `@anthropic-ai/sdk` 0.135 and covered by 9 tests with a scripted fake client, but a real response could differ (e.g. how often Claude cites, how the citations split text blocks). Model `claude-opus-5-5`, `output_config.effort: "low"`, `fallbacks: "default"` with beta `server-side-fallback-2026-07-01`, all taken from the claude-api skill, not guessed.
- **Embeddings are a local word-hashing embedder** (`local-hash-v1`), not a model. The Voyage embedder in `src/lib/embed.ts` is written against Voyage's REST API from memory and **never run**; `VOYAGE_MODEL` has no default on purpose (I didn't want to guess a model name). Its `minSimilarity` of 0.35 is a placeholder.
- **Supabase path never run** (no Supabase project, Docker not running). `db:setup` / `ingest` use the same SQL and code as the PGlite path, just through `pg`. Ingest isn't wrapped in a transaction.
- Cost estimate "$0.01–0.03 per answer" in the README is an estimate, not measured.

## Choices made (Aashar wasn't around to ask)
- **Shop name:** Tamp & Bloom; products Bloom One, Burrline 64, Pourwell. Made up; emails use `example.com`/`.example`. Not checked against real trademarks (no web search during the run). Rename in `docs/`, `supabase/seed.sql`, `app/page.tsx` and the system prompt if one turns out to be real.
- **PGlite for local runs** instead of the Supabase CLI: Docker isn't required, so "one command" really is one command. Local Postgres@16 here has no pgvector.
- **Native Claude citations** (document blocks with `citations.enabled`) instead of asking the model to write `[n]` markers. The citations come from the API, so they point at real passages.
- **Grounding guard:** a factual reply with no citation and no tool result is replaced by the refusal. Replies ending in "?" pass, so Claude can still ask for an email. Simple rule; worth checking on real outputs.
- **Effort "low"** for chat (support answers don't need deep reasoning; it keeps latency and cost down).
- Non-streaming responses. Catalog Standard tier promises streaming, so that's a part-2/next item.
- Vitest + tsx instead of `node:test` (the RLS demo's choice) because Next.js projects use path aliases and extensionless imports.

## Part 2 (Tue Oct 20, evening AI run): what changed
Still $0 spent and nothing pushed.
- **Retrieval:** at most 3 of the top 5 chunks can come from one file (`MAX_PER_DOCUMENT`). Before, "warranty on the Burrline 64" filled the top 5 with Burrline chunks; now warranty.md › Coverage is #5. The eval now scores retrieval by **section**, not just file: 10/10.
- **Eval still 13/15 in mock mode.** Both misses have the right section retrieved (#2 for refund timing, #5 for the Burrline warranty), but mock mode quotes only from the #1 chunk. I tried picking the best sentence across the top 3 chunks: it dropped to 12/15 (it broke "Is shipping free?"), and tuning it further would have meant fitting rules to the 15 questions. Reverted. Claude reads all 5 chunks, so the live eval is the real test.
- **Screenshots** (`npm run screenshots`: Playwright driving the installed Google Chrome, mock mode, light theme, 1600×1200): `docs/screenshots/1-cited-answer.png`, `2-refusal.png`, `3-tool-call.png`. They're in a subfolder, which ingestion ignores (it only reads `.md`/`.pdf` at the top of `docs/`). Copies of 1 and 3 are in `upwork/portfolio/`.
- **README** rewritten for a non-technical client: what it does, a 3-step mermaid diagram, the eval score, how to try it, what it would take for their docs; developer details below.
- **Portfolio write-up:** `upwork/portfolio/ai-support-agent.md`. Says it's a demo for a made-up shop, and that it hasn't run with a live key.
- 47 tests, typecheck and `next build` clean.

## Part 2 plan (from the morning run, kept for reference)
1. **Screenshots** for README and portfolio, in mock mode (`npm run dev`, then click the sample questions): (a) a cited docs answer with the sources list, (b) order lookup with the `lookup_order ✓` chip, (c) the "I don't know" reply, (d) the right-hand panel showing retrieved chunks with scores. Save to `docs-assets/` or `screenshots/` (not `docs/`, which is the knowledge base). The UI already has light and dark themes.
2. **README:** add the screenshots at the top; keep the "made-up shop" line. Don't call it a client project anywhere.
3. **Portfolio write-up** in `upwork/portfolio/` (match the SitesGen/TraccoAI write-ups): problem → what it does (cited answers, I-don't-know, tools with guardrails, eval score) → stack → "demo for a fictional shop". Link to catalog-2's Advanced tier (tools + evals + cost logging is exactly what's shown).
4. Optional if time: streaming answers; or a short `docs-assets/architecture.svg` from the README diagram for the catalog gallery image 2 ("How it's built").
5. **Needs Aashar, not a run:** one live eval with a real key (`ANTHROPIC_API_KEY=... npm run eval`, estimated under $0.50) to get a real score and cost to quote; pushing to GitHub (same plan as the RLS checker, branch `initial-version`).

Not worth doing tonight: tuning the hash embedder further. The fix for the two eval misses is real embeddings plus a live run, both need keys.
