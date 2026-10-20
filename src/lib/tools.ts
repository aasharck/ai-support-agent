// The agent's two tools. Every call, from Claude or from mock mode, goes through
// runTool(), which validates the input with zod before touching the database.
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Db } from "./db";

const OrderId = z.string().regex(/^TB-\d{5}$/, "Order numbers look like TB-12345");

export const LookupOrderInput = z.strictObject({
  order_id: OrderId,
  email: z.email("Needs the email address the order was placed with"),
});

export const CreateTicketInput = z.strictObject({
  email: z.email("Needs an email address for the reply"),
  subject: z.string().trim().min(5).max(120),
  description: z.string().trim().min(10).max(2000),
  order_id: OrderId.optional(),
  priority: z.enum(["low", "normal", "urgent"]).default("normal"),
});

/** Tickets one email address can open per hour, so a looping agent can't flood the queue. */
export const TICKETS_PER_HOUR = 3;

export const toolDefinitions: Anthropic.Beta.BetaTool[] = [
  {
    name: "lookup_order",
    description:
      "Look up the status, items, carrier and tracking number of one order. Needs both the order number " +
      "(TB- followed by 5 digits) and the email address the order was placed with; ask the customer for " +
      "whichever is missing instead of guessing. Returns an error if they don't match an order.",
    input_schema: {
      type: "object",
      properties: {
        order_id: { type: "string", description: "Order number, e.g. TB-10042" },
        email: { type: "string", description: "Email address the order was placed with" },
      },
      required: ["order_id", "email"],
      additionalProperties: false,
    },
  },
  {
    name: "create_ticket",
    description:
      "Open a support ticket for the human team (they reply within one business day). Use it when the " +
      "customer asks for a person, wants to start a return or warranty claim, or has a problem the docs " +
      "can't solve. Needs the customer's email address; ask for it if you don't have it.",
    input_schema: {
      type: "object",
      properties: {
        email: { type: "string", description: "Customer's email address for the reply" },
        subject: { type: "string", description: "One-line summary, 5-120 characters" },
        description: { type: "string", description: "What the customer needs, in their words, 10-2000 characters" },
        order_id: { type: "string", description: "Related order number, if any" },
        priority: { type: "string", enum: ["low", "normal", "urgent"] },
      },
      required: ["email", "subject", "description"],
      additionalProperties: false,
    },
  },
];

export interface ToolOutcome {
  name: string;
  input: unknown;
  ok: boolean;
  /** JSON-serialisable result on success, or the reason for the error. */
  result: unknown;
}

interface OrderRow {
  id: string;
  status: string;
  items: { name: string; qty: number }[];
  total_usd: string;
  placed_at: Date | string;
  shipped_at: Date | string | null;
  carrier: string | null;
  tracking_number: string | null;
  estimated_delivery: Date | string | null;
}

const day = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 10) : null);

async function lookupOrder(db: Db, input: z.infer<typeof LookupOrderInput>) {
  const { rows } = await db.query<OrderRow>(
    "select * from orders where id = $1 and lower(customer_email) = lower($2)",
    [input.order_id, input.email],
  );
  // Same message whether the order doesn't exist or the email is wrong, so the tool
  // can't be used to find out which order numbers exist.
  if (!rows[0]) return { ok: false, result: "No order matches that order number and email address." };
  const o = rows[0];
  return {
    ok: true,
    result: {
      order_id: o.id,
      status: o.status,
      items: o.items.map((i) => `${i.qty} × ${i.name}`),
      total_usd: Number(o.total_usd),
      placed_on: day(o.placed_at),
      shipped_on: day(o.shipped_at),
      carrier: o.carrier,
      tracking_number: o.tracking_number,
      estimated_delivery: day(o.estimated_delivery),
    },
  };
}

async function createTicket(db: Db, input: z.infer<typeof CreateTicketInput>) {
  if (input.order_id) {
    const owner = await db.query("select 1 from orders where id = $1 and lower(customer_email) = lower($2)", [
      input.order_id,
      input.email,
    ]);
    if (!owner.rows[0]) return { ok: false, result: "No order matches that order number and email address." };
  }
  const recent = await db.query<{ n: number }>(
    "select count(*)::int as n from tickets where lower(email) = lower($1) and created_at > now() - interval '1 hour'",
    [input.email],
  );
  if (recent.rows[0].n >= TICKETS_PER_HOUR) {
    return { ok: false, result: "This email address already opened 3 tickets in the last hour. The team will reply to those first." };
  }
  const { rows } = await db.query<{ id: number }>(
    "insert into tickets (email, order_id, subject, description, priority) values ($1, $2, $3, $4, $5) returning id",
    [input.email, input.order_id ?? null, input.subject, input.description, input.priority],
  );
  return {
    ok: true,
    result: { ticket: `T-${String(rows[0].id).padStart(5, "0")}`, status: "open", reply_within: "1 business day" },
  };
}

export async function runTool(db: Db, name: string, input: unknown): Promise<ToolOutcome> {
  const schema = name === "lookup_order" ? LookupOrderInput : name === "create_ticket" ? CreateTicketInput : null;
  if (!schema) return { name, input, ok: false, result: `Unknown tool: ${name}` };
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const reason = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
    return { name, input, ok: false, result: `Invalid input. ${reason}` };
  }
  const outcome =
    name === "lookup_order"
      ? await lookupOrder(db, parsed.data as z.infer<typeof LookupOrderInput>)
      : await createTicket(db, parsed.data as z.infer<typeof CreateTicketInput>);
  return { name, input: parsed.data, ...outcome };
}
