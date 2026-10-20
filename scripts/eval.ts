// Runs the 15 questions in evals/questions.json through the agent and prints a score.
// Mock mode (no ANTHROPIC_API_KEY) is free. Live mode calls Claude once or twice per
// question; the measured cost is printed at the end (estimated $0.01–0.03 per question on Opus 5.5).
// Usage: npm run eval [-- --json]
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { answer, currentMode, type AgentReply } from "../src/lib/agent";
import type { Db } from "../src/lib/db";
import { getEmbedder } from "../src/lib/embed";
import { TOP_K } from "../src/lib/retrieve";
import { createLocalDb } from "../src/lib/store";

interface Case {
  id: string;
  question: string;
  expect: "answer" | "refuse" | "tool";
  source?: string;
  tool?: string;
  toolOk?: boolean;
  mustInclude?: string[];
  mustNotInclude?: string[];
}

// "1–2" in the docs and "1-2" in an expectation should match.
const norm = (s: string) => s.toLowerCase().replace(/[‐-―]/g, "-");

function grade(c: Case, r: AgentReply): string[] {
  const problems: string[] = [];
  const text = norm(r.answer);
  if (c.expect === "refuse") {
    if (!r.refused) problems.push("should have said I don't know");
    if (r.toolCalls.length) problems.push("called a tool");
    return problems;
  }
  if (c.expect === "answer") {
    if (r.refused) return ["said I don't know"];
    if (!r.citations.some((x) => x.kind === "doc" && x.source === c.source)) {
      problems.push(`didn't cite ${c.source} (cited: ${r.citations.map((x) => x.source).join(", ") || "nothing"})`);
    }
  }
  if (c.expect === "tool") {
    const call = r.toolCalls.find((t) => t.name === c.tool);
    if (!call) problems.push(`didn't call ${c.tool}`);
    else if (call.ok !== c.toolOk) problems.push(`${c.tool} ${call.ok ? "succeeded" : "failed"}, expected ${c.toolOk ? "success" : "failure"}`);
  }
  for (const s of c.mustInclude ?? []) if (!text.includes(norm(s))) problems.push(`missing "${s}"`);
  for (const s of c.mustNotInclude ?? []) if (text.includes(norm(s))) problems.push(`leaked "${s}"`);
  return problems;
}

const cases: Case[] = JSON.parse(await readFile("evals/questions.json", "utf8"));
const mode = currentMode();
const embedder = getEmbedder();
// Always a fresh in-memory database, so the eval never writes tickets into a real one.
const db: Db = await createLocalDb();

console.log(`Eval: ${cases.length} questions · mode: ${mode} · embeddings: ${embedder.name}\n`);
const results = [];
let cost = 0;
for (const c of cases) {
  const reply = await answer(db, embedder, [{ role: "user", content: c.question }]);
  const problems = grade(c, reply);
  cost += reply.usage?.costUsd ?? 0;
  results.push({ ...c, pass: problems.length === 0, problems, reply });
  console.log(`${problems.length ? "✗" : "✓"} ${c.id.padEnd(24)} ${problems.join("; ")}`);
  if (problems.length) console.log(`  ${"".padEnd(24)} answer: ${reply.answer.slice(0, 140)}`);
}
await db.close();

const passed = results.filter((r) => r.pass).length;
// Separates retrieval misses (the right file never reached the model) from answer misses.
const docCases = results.filter((r) => r.expect === "answer");
const hits = docCases.filter((r) => r.reply.retrieved.some((c) => c.source === r.source)).length;
console.log(`\nScore: ${passed}/${cases.length} (${Math.round((passed / cases.length) * 100)}%)`);
console.log(`Retrieval: the expected file was in the top ${TOP_K} chunks for ${hits}/${docCases.length} docs questions`);
if (mode === "live") console.log(`API cost: $${cost.toFixed(4)}`);

await mkdir("evals/results", { recursive: true });
const file = `evals/results/${new Date().toISOString().replace(/[:.]/g, "-")}-${mode}.json`;
await writeFile(file, JSON.stringify({ mode, embedder: embedder.name, passed, total: cases.length, costUsd: cost, results }, null, 2));
console.log(`Details: ${file}`);
