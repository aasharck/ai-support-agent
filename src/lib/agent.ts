// The support agent: retrieve → answer with citations → call tools when needed.
//
// Live mode (ANTHROPIC_API_KEY set): Claude answers from the retrieved chunks, passed as
// documents with Anthropic's citations feature on, and can call the two tools.
// Mock mode (no key, or MOCK_LLM=1): the same retrieval and the same tools, but the
// answer is the best-matching sentence from the docs and tool use follows fixed rules.
// No model call, no cost. It exists so tests, the eval and the demo run for free.
import Anthropic from "@anthropic-ai/sdk";
import type { Db } from "./db";
import { tokenize, type Embedder } from "./embed";
import { retrieve, type Retrieved } from "./retrieve";
import { runTool, toolDefinitions, type ToolOutcome } from "./tools";

export type Mode = "live" | "mock";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface Citation {
  /** The [n] marker used in the answer text. */
  n: number;
  kind: "doc" | "tool";
  /** File name for docs ("returns.md"), tool name for tool results ("lookup_order"). */
  source: string;
  /** Section heading for docs, order or ticket id for tools. */
  section: string;
  /** The exact passage or record the answer relied on. */
  quote: string;
}

export interface AgentReply {
  answer: string;
  citations: Citation[];
  toolCalls: ToolOutcome[];
  refused: boolean;
  /** True when the grounding guard replaced an answer that cited nothing. */
  guarded: boolean;
  mode: Mode;
  model: string | null;
  usage: { inputTokens: number; outputTokens: number; costUsd: number | null } | null;
  latencyMs: number;
  retrieved: { source: string; section: string; similarity: number }[];
}

export const REFUSAL =
  "I don't know: our help docs don't cover that. I can open a support ticket so someone from the team can answer it.";

export const DEFAULT_MODEL = "claude-opus-5-5";

// $ per million tokens (input, output), from Anthropic's price list. Used for the cost
// line under each answer; models not listed show no cost.
const PRICES: Record<string, [number, number]> = {
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
};

export const SYSTEM_PROMPT = `You are the customer support assistant for Tamp & Bloom, an online shop for home-barista equipment (espresso machines, grinders, kettles).

How to answer:
- Answer only from the documents attached to the customer's latest message and from tool results. The documents are passages from the shop's own help docs, picked by a search for this question.
- Every factual statement must be supported by those documents or tool results. Don't use outside knowledge about coffee or other shops, and never guess policies, prices, dates or order details.
- If the documents don't answer the question, reply with exactly: "${REFUSAL}" and nothing else.
- To check an order you need its order number (TB- followed by 5 digits) and the email address it was placed with. Ask for whichever is missing.
- Open a support ticket when the customer asks for a person, wants to start a return or warranty claim, or has a problem the documents don't solve. You need their email address first. After opening it, give them the ticket number.
- Keep answers short: 1 to 4 sentences, plain text, no headings. Speak to the customer directly.`;

export function currentMode(): Mode {
  return process.env.ANTHROPIC_API_KEY && process.env.MOCK_LLM !== "1" ? "live" : "mock";
}

/** The one Claude call the live agent makes, injectable so tests can script responses. */
export type CreateMessage = (
  params: Anthropic.Beta.MessageCreateParamsNonStreaming,
) => Promise<Anthropic.Beta.BetaMessage>;

let defaultClient: Anthropic | undefined;
const realCreate: CreateMessage = (params) => {
  defaultClient ??= new Anthropic();
  return defaultClient.beta.messages.create(params);
};

export interface AnswerOptions {
  mode?: Mode;
  create?: CreateMessage;
  model?: string;
}

export async function answer(db: Db, embedder: Embedder, messages: ChatMessage[], opts: AnswerOptions = {}): Promise<AgentReply> {
  const started = Date.now();
  const last = messages.at(-1);
  if (!last || last.role !== "user" || !last.content.trim()) throw new Error("The last message must be a non-empty user message");
  const chunks = await retrieve(db, embedder, last.content);
  const mode = opts.mode ?? currentMode();
  const reply =
    mode === "live"
      ? await answerLive(db, messages, chunks, opts.create ?? realCreate, opts.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL)
      : await answerMock(db, messages, chunks);
  return {
    ...reply,
    mode,
    latencyMs: Date.now() - started,
    retrieved: chunks.map((c) => ({ source: c.path, section: c.section, similarity: Number(c.similarity.toFixed(3)) })),
  };
}

type PartialReply = Omit<AgentReply, "mode" | "latencyMs" | "retrieved">;

const isRefusal = (text: string) => /^i don['’]t know\b/i.test(text.trim());

function toolCitation(n: number, call: ToolOutcome): Citation {
  const result = call.result as Record<string, unknown>;
  return {
    n,
    kind: "tool",
    source: call.name,
    section: String(result.order_id ?? result.ticket ?? ""),
    quote: JSON.stringify(call.result),
  };
}

// ---------------------------------------------------------------- live mode

async function answerLive(
  db: Db,
  messages: ChatMessage[],
  chunks: Retrieved[],
  create: CreateMessage,
  model: string,
): Promise<PartialReply> {
  const documents: Anthropic.Beta.BetaRequestDocumentBlock[] = chunks.map((c) => ({
    type: "document",
    source: { type: "text", media_type: "text/plain", data: c.content },
    title: `${c.path} › ${c.section}`,
    citations: { enabled: true },
  }));
  const question = documents.length ? last(messages) : `(The help-doc search found nothing for this message.)\n\n${last(messages)}`;
  const convo: Anthropic.Beta.BetaMessageParam[] = [
    ...messages.slice(0, -1).map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: [...documents, { type: "text", text: question }] },
  ];

  const toolCalls: ToolOutcome[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let response: Anthropic.Beta.BetaMessage | undefined;

  for (let turn = 0; turn < 5; turn++) {
    response = await create({
      model,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: toolDefinitions,
      messages: convo,
      // Support chat doesn't need deep reasoning; low effort keeps it fast and cheap.
      output_config: { effort: "low" },
      // If a safety classifier declines, retry server-side on Anthropic's default fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    inputTokens += response.usage.input_tokens;
    outputTokens += response.usage.output_tokens;
    if (response.stop_reason !== "tool_use") break;

    // Append the assistant turn unchanged (thinking blocks included), then all results in one message.
    convo.push({ role: "assistant", content: response.content });
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const outcome = await runTool(db, block.name, block.input);
      toolCalls.push(outcome);
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(outcome.result),
        is_error: !outcome.ok,
      });
    }
    convo.push({ role: "user", content: results });
  }

  const price = PRICES[model];
  const usage = {
    inputTokens,
    outputTokens,
    costUsd: price ? (inputTokens * price[0] + outputTokens * price[1]) / 1e6 : null,
  };
  const base = { toolCalls, model: response?.model ?? model, usage };

  if (!response || response.stop_reason === "refusal" || response.stop_reason === "tool_use") {
    return { ...base, answer: REFUSAL, citations: [], refused: true, guarded: true };
  }

  // Turn Claude's citation blocks into numbered [n] markers, one number per chunk.
  const citations: Citation[] = [];
  const numberFor = new Map<number, number>();
  let text = "";
  for (const block of response.content) {
    if (block.type !== "text") continue;
    text += block.text;
    const markers = new Set<number>();
    for (const c of block.citations ?? []) {
      if (c.type !== "char_location" || !chunks[c.document_index]) continue;
      if (!numberFor.has(c.document_index)) {
        const chunk = chunks[c.document_index];
        numberFor.set(c.document_index, citations.length + 1);
        citations.push({ n: citations.length + 1, kind: "doc", source: chunk.path, section: chunk.section, quote: c.cited_text.trim() });
      }
      markers.add(numberFor.get(c.document_index)!);
    }
    if (markers.size) text = text.trimEnd() + " " + [...markers].map((n) => `[${n}]`).join("") + " ";
  }
  text = text.replace(/\s+/g, " ").trim();
  for (const call of toolCalls.filter((t) => t.ok)) citations.push(toolCitation(citations.length + 1, call));

  if (isRefusal(text)) return { ...base, answer: REFUSAL, citations: [], refused: true, guarded: false };

  // Grounding guard: a statement with no doc citation and no tool result behind it is
  // replaced by the refusal. Questions back to the customer ("What's your email?") pass.
  if (!citations.length && !text.endsWith("?")) {
    return { ...base, answer: REFUSAL, citations: [], refused: true, guarded: true };
  }
  return { ...base, answer: text, citations, refused: false, guarded: false };
}

const last = (messages: ChatMessage[]) => messages.at(-1)!.content;

// ---------------------------------------------------------------- mock mode

const ORDER_ID = /\bTB-\d{5}\b/i;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
const WANTS_TICKET = /\b(ticket|human|real person|someone from|speak to|talk to|complain|complaint)\b/i;
const ABOUT_ORDER = /\b(order|tracking|track|deliver(?:y|ed)?|shipped|parcel|package)\b/i;

function findInHistory(messages: ChatMessage[], pattern: RegExp): string | undefined {
  for (const m of [...messages].reverse()) {
    if (m.role !== "user") continue;
    const match = pattern.exec(m.content);
    if (match) return match[0];
  }
}

/** Splits a chunk into readable sentences; markdown tables become "cell · cell" lines. */
function sentences(content: string): string[] {
  const out: string[] = [];
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || /^\|?\s*-{3}/.test(line)) continue;
    if (line.startsWith("|")) {
      out.push(line.split("|").map((c) => c.trim()).filter(Boolean).join(" · "));
      continue;
    }
    const clean = line.replace(/^[-*]\s+/, "").replace(/\*\*/g, "");
    out.push(...clean.split(/(?<=[.!?])\s+(?=[A-Z])/));
  }
  return out;
}

async function answerMock(db: Db, messages: ChatMessage[], chunks: Retrieved[]): Promise<PartialReply> {
  const base = { model: null, usage: null, guarded: false };
  const text = last(messages);
  const email = findInHistory(messages, EMAIL);
  const orderId = findInHistory(messages, ORDER_ID)?.toUpperCase();
  const ask = (question: string): PartialReply => ({ ...base, answer: question, citations: [], toolCalls: [], refused: false });

  // 1. The customer wants a person → open a ticket.
  const ticketRequested = WANTS_TICKET.test(text) || (EMAIL.test(text) && messages.some((m) => m.role === "assistant" && /open a ticket/i.test(m.content)));
  if (ticketRequested) {
    if (!email) return ask("I can open a ticket for you. What email address should the team reply to?");
    const userTexts = messages.filter((m) => m.role === "user").map((m) => m.content);
    const description = [...userTexts].reverse().find((t) => t.replace(EMAIL, "").trim().length >= 10) ?? text;
    const call = await runTool(db, "create_ticket", {
      email,
      subject: description.replace(/\s+/g, " ").slice(0, 80).padEnd(5, "."),
      description: description.slice(0, 2000).padEnd(10, "."),
      ...(orderId ? { order_id: orderId } : {}),
    });
    if (!call.ok) return { ...base, answer: `I couldn't open the ticket: ${String(call.result)}`, citations: [], toolCalls: [call], refused: false };
    const { ticket } = call.result as { ticket: string };
    return {
      ...base,
      answer: `I've opened ticket ${ticket} for you. The team replies within one business day. [1]`,
      citations: [toolCitation(1, call)],
      toolCalls: [call],
      refused: false,
    };
  }

  // 2. An order number in this message, or an order question with one earlier → look it up.
  const orderInText = ORDER_ID.test(text);
  if (orderId && (orderInText || ABOUT_ORDER.test(text) || EMAIL.test(text))) {
    if (!email) return ask(`I can check that. What's the email address on order ${orderId}?`);
    const call = await runTool(db, "lookup_order", { order_id: orderId, email });
    if (!call.ok) {
      return {
        ...base,
        answer: "I couldn't find an order with that order number and email address. Please check both, or I can open a ticket for you.",
        citations: [],
        toolCalls: [call],
        refused: false,
      };
    }
    const o = call.result as Record<string, string | null>;
    const shipped = o.carrier ? ` It shipped with ${o.carrier} on ${o.shipped_on}, tracking number ${o.tracking_number}.` : "";
    const eta = o.estimated_delivery ? ` Estimated delivery: ${o.estimated_delivery}.` : "";
    return {
      ...base,
      answer: `Order ${o.order_id} is ${o.status}.${shipped}${eta} [1]`,
      citations: [toolCitation(1, call)],
      toolCalls: [call],
      refused: false,
    };
  }

  // 3. Otherwise answer from the docs, or say "I don't know".
  if (!chunks.length) return { ...base, answer: REFUSAL, citations: [], toolCalls: [], refused: true };
  // Trust retrieval's top chunk and pick its sentence that shares the most words with
  // the question. Words from the document title don't count ("Pourwell kettle" is in
  // every sentence's context), they only break ties. Add the next sentence for context.
  const chunk = chunks[0];
  const query = tokenize(text);
  const titleWords = new Set(tokenize(chunk.title));
  const list = sentences(chunk.content);
  const score = (s: string) => {
    const words = new Set(tokenize(s));
    const hits = query.filter((t) => words.has(t));
    return hits.filter((t) => !titleWords.has(t)).length * 100 + hits.length;
  };
  let bestIndex = 0;
  list.forEach((s, i) => {
    if (score(s) > score(list[bestIndex])) bestIndex = i;
  });
  const isRow = (s?: string) => !!s && s.includes(" · ");
  const picked = [list[bestIndex]];
  if (!isRow(list[bestIndex]) && list[bestIndex + 1] && !isRow(list[bestIndex + 1])) picked.push(list[bestIndex + 1]);
  const best = { chunk, sentence: picked.join(" ") };
  return {
    ...base,
    answer: `${best.sentence} [1]`,
    citations: [{ n: 1, kind: "doc", source: best.chunk.path, section: best.chunk.section, quote: best.sentence }],
    toolCalls: [],
    refused: false,
  };
}
