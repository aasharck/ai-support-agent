// The live (Claude) code path, with the API call replaced by scripted responses. This
// checks what the code does around the model: request shape, tool loop, citation
// mapping, grounding guard and cost. It says nothing about answer quality; that's
// what `npm run eval` with a real key is for.
import type Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { answer, REFUSAL, type CreateMessage } from "../src/lib/agent";
import type { Db } from "../src/lib/db";
import { localEmbedder } from "../src/lib/embed";
import { createLocalDb } from "../src/lib/store";

type Params = Anthropic.Beta.MessageCreateParamsNonStreaming;
type Block = Record<string, unknown>;

let db: Db;
beforeAll(async () => {
  db = await createLocalDb();
});
afterAll(() => db.close());

const message = (content: Block[], stop_reason: string) =>
  ({
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 1000, output_tokens: 100 },
  }) as unknown as Anthropic.Beta.BetaMessage;

/** A fake API: each call gets the request and returns the next scripted response. */
function script(...steps: ((params: Params) => Anthropic.Beta.BetaMessage)[]) {
  const calls: Params[] = [];
  const create: CreateMessage = async (params) => {
    calls.push(structuredClone(params));
    const step = steps[calls.length - 1];
    if (!step) throw new Error("unexpected extra API call");
    return step(params);
  };
  return { create, calls };
}

const blocks = (m: Anthropic.Beta.BetaMessageParam) => m.content as unknown as Block[];

const documentsOf = (params: Params) => {
  return blocks(params.messages.at(-1)!).filter((b) => b.type === "document") as { title: string; source: { data: string } }[];
};

const ask = (question: string, create: CreateMessage) =>
  answer(db, localEmbedder, [{ role: "user", content: question }], { mode: "live", create, model: "claude-opus-5-5" });

describe("live mode", () => {
  test("sends retrieved chunks as citable documents, with tools, low effort and fallbacks", async () => {
    const { create, calls } = script(() => message([{ type: "text", text: "I don't know: not covered." }], "end_turn"));
    await ask("How often should I descale the Bloom One?", create);
    const p = calls[0];
    expect(p.model).toBe("claude-opus-5-5");
    expect(p.output_config).toEqual({ effort: "low" });
    expect(p.fallbacks).toBe("default");
    expect(p.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(p.tools?.map((t) => (t as { name: string }).name)).toEqual(["lookup_order", "create_ticket"]);
    const docs = documentsOf(p);
    expect(docs[0]).toMatchObject({ title: "bloom-one-espresso-machine.md › Descaling", citations: { enabled: true } });
  });

  test("maps Claude's citations to numbered sources", async () => {
    const { create } = script((params) => {
      const index = documentsOf(params).findIndex((d) => d.title.endsWith("› Descaling"));
      const cited = "Descale the Bloom One every 2 months.";
      return message(
        [
          { type: "text", text: "Every 2 months, or monthly with hard water.", citations: [
            { type: "char_location", cited_text: cited, document_index: index, document_title: "x", start_char_index: 0, end_char_index: cited.length, file_id: null },
          ] },
        ],
        "end_turn",
      );
    });
    const r = await ask("How often should I descale the Bloom One?", create);
    expect(r.answer).toBe("Every 2 months, or monthly with hard water. [1]");
    expect(r.citations).toEqual([
      { n: 1, kind: "doc", source: "bloom-one-espresso-machine.md", section: "Descaling", quote: "Descale the Bloom One every 2 months." },
    ]);
    expect(r).toMatchObject({ refused: false, guarded: false, mode: "live" });
  });

  test("runs a tool call, returns the result to Claude, and cites the tool", async () => {
    const { create, calls } = script(
      () => message([{ type: "tool_use", id: "tu_1", name: "lookup_order", input: { order_id: "TB-10042", email: "sam@example.com" } }], "tool_use"),
      () => message([{ type: "text", text: "It shipped with DHL Express and should arrive on 21 October." }], "end_turn"),
    );
    const r = await ask("Where is TB-10042? I'm sam@example.com", create);
    const toolResult = blocks(calls[1].messages.at(-1)!)[0];
    expect(toolResult).toMatchObject({ type: "tool_result", tool_use_id: "tu_1", is_error: false });
    expect(String(toolResult.content)).toContain("7741029384");
    expect(calls[1].messages.at(-2)).toMatchObject({ role: "assistant" });
    expect(r.citations).toEqual([expect.objectContaining({ kind: "tool", source: "lookup_order", section: "TB-10042" })]);
    expect(r.refused).toBe(false);
  });

  test("sends invalid tool input back as an error instead of running it", async () => {
    const { create, calls } = script(
      () => message([{ type: "tool_use", id: "tu_1", name: "lookup_order", input: { order_id: "10042" } }], "tool_use"),
      () => message([{ type: "text", text: "Could you give me your order number (it starts with TB-) and your email?" }], "end_turn"),
    );
    const r = await ask("where's my order 10042", create);
    const toolResult = blocks(calls[1].messages.at(-1)!)[0];
    expect(toolResult).toMatchObject({ is_error: true });
    expect(String(toolResult.content)).toMatch(/Invalid input/);
    expect(r.toolCalls[0].ok).toBe(false);
    // A question back to the customer passes the grounding guard.
    expect(r).toMatchObject({ refused: false, guarded: false });
  });

  test("grounding guard replaces an uncited statement with the refusal", async () => {
    const { create } = script(() => message([{ type: "text", text: "Yes, students get 10% off." }], "end_turn"));
    const r = await ask("Do you offer a student discount?", create);
    expect(r).toMatchObject({ answer: REFUSAL, refused: true, guarded: true, citations: [] });
  });

  test("Claude's own I-don't-know becomes the standard refusal", async () => {
    const { create, calls } = script(() => message([{ type: "text", text: REFUSAL }], "end_turn"));
    const r = await ask("Can you recommend a good cafe in Lisbon?", create);
    expect(documentsOf(calls[0])).toEqual([]);
    expect(r).toMatchObject({ answer: REFUSAL, refused: true, guarded: false });
  });

  test("a safety refusal from the API ends in the standard refusal", async () => {
    const { create } = script(() => message([], "refusal"));
    expect((await ask("How often should I descale the Bloom One?", create)).refused).toBe(true);
  });

  test("adds up tokens and cost across the tool loop", async () => {
    const { create } = script(
      () => message([{ type: "tool_use", id: "tu_1", name: "lookup_order", input: { order_id: "TB-10042", email: "sam@example.com" } }], "tool_use"),
      () => message([{ type: "text", text: "It shipped with DHL Express." }], "end_turn"),
    );
    const r = await ask("Where is TB-10042? I'm sam@example.com", create);
    // 2 calls × (1,000 in at $4/M + 100 out at $20/M)
    expect(r.usage).toEqual({ inputTokens: 2000, outputTokens: 200, costUsd: 0.012 });
  });

  test("stops after 5 rounds of tool calls", async () => {
    const loop = () => message([{ type: "tool_use", id: "tu", name: "lookup_order", input: { order_id: "TB-10042", email: "sam@example.com" } }], "tool_use");
    const { create, calls } = script(loop, loop, loop, loop, loop);
    const r = await ask("Where is TB-10042? I'm sam@example.com", create);
    expect(calls).toHaveLength(5);
    expect(r).toMatchObject({ refused: true, guarded: true });
  });
});
