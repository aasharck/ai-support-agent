// The agent in mock mode: same retrieval, tools and database as live mode, no model call.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { answer, REFUSAL, type ChatMessage } from "../src/lib/agent";
import type { Db } from "../src/lib/db";
import { localEmbedder } from "../src/lib/embed";
import { createLocalDb } from "../src/lib/store";

let db: Db;
beforeAll(async () => {
  db = await createLocalDb();
});
afterAll(() => db.close());

const ask = (...turns: string[]) => {
  const messages: ChatMessage[] = turns.map((content, i) => ({ role: i % 2 ? "assistant" : "user", content }));
  return answer(db, localEmbedder, messages, { mode: "mock" });
};

describe("answers cite their sources", () => {
  test("a docs answer carries a [1] marker and the file › section it came from", async () => {
    const r = await ask("How often should I descale the Bloom One?");
    expect(r.refused).toBe(false);
    expect(r.answer).toMatch(/every 2 months.*\[1\]$/);
    expect(r.citations).toEqual([
      expect.objectContaining({ n: 1, kind: "doc", source: "bloom-one-espresso-machine.md", section: "Descaling" }),
    ]);
    expect(r.mode).toBe("mock");
    expect(r.usage).toBeNull();
  });

  test.each([
    "Can I return a grinder I've already used?",
    "What grind setting should I use for pour-over?",
    "My Bloom One shows error E3, what do I do?",
    "What temperature should I use for a light roast with the Pourwell kettle?",
  ])("every answer cites a real chunk: %s", async (q) => {
    const r = await ask(q);
    expect(r.citations.length).toBeGreaterThan(0);
    for (const c of r.citations) {
      const { rows } = await db.query(
        "select 1 from chunks c join documents d on d.id = c.document_id where d.path = $1 and c.section = $2 and position($3 in replace(c.content, '**', '')) > 0",
        // Table rows come back as "cell · cell", so check the first cell.
        [c.source, c.section, c.quote.split(" · ")[0]],
      );
      expect(rows, `${c.source} › ${c.section}`).toHaveLength(1);
    }
  });
});

describe("says I don't know when the docs don't cover it", () => {
  test.each(["Do you offer a student discount?", "Can you recommend a good cafe in Lisbon?", "Can I pay with crypto?"])("%s", async (q) => {
    const r = await ask(q);
    expect(r).toMatchObject({ refused: true, answer: REFUSAL, citations: [], toolCalls: [] });
  });
});

describe("tools", () => {
  test("asks for the email before looking up an order, then looks it up", async () => {
    const first = await ask("Where is my order TB-10042?");
    expect(first.toolCalls).toEqual([]);
    expect(first.answer).toMatch(/email address/);
    const second = await ask("Where is my order TB-10042?", first.answer, "It's sam@example.com");
    expect(second.toolCalls).toEqual([expect.objectContaining({ name: "lookup_order", ok: true })]);
    expect(second.answer).toContain("DHL Express");
    expect(second.citations[0]).toMatchObject({ kind: "tool", source: "lookup_order", section: "TB-10042" });
  });

  test("doesn't reveal an order to someone with a different email", async () => {
    const r = await ask("Where is order TB-10042? My email is maya@example.com");
    expect(r.toolCalls[0].ok).toBe(false);
    expect(r.answer).not.toMatch(/DHL|7741029384|Burrline/);
  });

  test("opens a ticket and stores it", async () => {
    const r = await ask("Please open a ticket: my Bloom One keeps showing E2 after cooling down. I'm maya@example.com, order TB-10041");
    expect(r.toolCalls).toEqual([expect.objectContaining({ name: "create_ticket", ok: true })]);
    const ticket = (r.toolCalls[0].result as { ticket: string }).ticket;
    expect(r.answer).toContain(ticket);
    const { rows } = await db.query<{ email: string; order_id: string }>("select email, order_id from tickets where id = $1", [Number(ticket.slice(2))]);
    expect(rows[0]).toEqual({ email: "maya@example.com", order_id: "TB-10041" });
  });
});
