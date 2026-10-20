import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Db } from "../src/lib/db";
import { createLocalDb } from "../src/lib/store";
import { runTool, TICKETS_PER_HOUR } from "../src/lib/tools";

let db: Db;
beforeAll(async () => {
  db = await createLocalDb();
});
afterAll(() => db.close());

describe("lookup_order validation", () => {
  test("rejects a malformed order number", async () => {
    const r = await runTool(db, "lookup_order", { order_id: "10042", email: "sam@example.com" });
    expect(r.ok).toBe(false);
    expect(r.result).toMatch(/order_id: Order numbers look like TB-12345/);
  });

  test("rejects a missing or invalid email", async () => {
    expect((await runTool(db, "lookup_order", { order_id: "TB-10042" })).ok).toBe(false);
    expect((await runTool(db, "lookup_order", { order_id: "TB-10042", email: "not-an-email" })).result).toMatch(/^Invalid input\. email/);
  });

  test("rejects extra properties", async () => {
    const r = await runTool(db, "lookup_order", { order_id: "TB-10042", email: "sam@example.com", sql: "drop table orders" });
    expect(r.ok).toBe(false);
    expect(r.result).toMatch(/Unrecognized key/i);
  });

  test("returns the order when number and email match (email case doesn't matter)", async () => {
    const r = await runTool(db, "lookup_order", { order_id: "TB-10042", email: "Sam@Example.com" });
    expect(r.ok).toBe(true);
    expect(r.result).toMatchObject({ order_id: "TB-10042", status: "shipped", carrier: "DHL Express", tracking_number: "7741029384" });
  });

  test("gives the same answer for a wrong email and a non-existent order", async () => {
    const wrongEmail = await runTool(db, "lookup_order", { order_id: "TB-10042", email: "maya@example.com" });
    const noOrder = await runTool(db, "lookup_order", { order_id: "TB-99999", email: "sam@example.com" });
    expect(wrongEmail.ok).toBe(false);
    expect(wrongEmail.result).toBe(noOrder.result);
  });

  test("rejects unknown tools", async () => {
    expect(await runTool(db, "refund_order", { order_id: "TB-10042" })).toMatchObject({ ok: false, result: "Unknown tool: refund_order" });
  });
});

describe("create_ticket validation", () => {
  const valid = { email: "lena@example.com", subject: "Kettle shows 'dry'", description: "The kettle shows 'dry' even when it's full." };

  test("opens a ticket with default priority", async () => {
    const r = await runTool(db, "create_ticket", valid);
    expect(r.ok).toBe(true);
    expect(r.result).toMatchObject({ status: "open", reply_within: "1 business day" });
    expect((r.result as { ticket: string }).ticket).toMatch(/^T-\d{5}$/);
    const { rows } = await db.query<{ priority: string }>("select priority from tickets where email = $1", [valid.email]);
    expect(rows[0].priority).toBe("normal");
  });

  test("rejects a too-short description and a bad priority", async () => {
    expect((await runTool(db, "create_ticket", { ...valid, description: "help" })).result).toMatch(/description/);
    expect((await runTool(db, "create_ticket", { ...valid, priority: "asap" })).result).toMatch(/priority/);
  });

  test("won't attach someone else's order to a ticket", async () => {
    const r = await runTool(db, "create_ticket", { ...valid, email: "omar@example.com", order_id: "TB-10042" });
    expect(r).toMatchObject({ ok: false, result: "No order matches that order number and email address." });
  });

  test(`limits one email address to ${TICKETS_PER_HOUR} tickets an hour`, async () => {
    const email = "flood@example.com";
    for (let i = 0; i < TICKETS_PER_HOUR; i++) expect((await runTool(db, "create_ticket", { ...valid, email })).ok).toBe(true);
    const r = await runTool(db, "create_ticket", { ...valid, email });
    expect(r.ok).toBe(false);
    expect(r.result).toMatch(/already opened 3 tickets/);
  });
});
