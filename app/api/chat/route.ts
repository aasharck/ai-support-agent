import { z } from "zod";
import { answer } from "@/src/lib/agent";
import { getEmbedder } from "@/src/lib/embed";
import { getDb } from "@/src/lib/store";

export const runtime = "nodejs";

const Body = z.object({
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(2000) }))
    .min(1)
    .max(20),
});

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Send { messages: [{ role, content }] } ending with a user message." }, { status: 400 });
  try {
    const reply = await answer(await getDb(), getEmbedder(), parsed.data.messages);
    // Cost and error logging: one line per answer in the server log.
    console.log(
      JSON.stringify({
        at: new Date().toISOString(),
        mode: reply.mode,
        model: reply.model,
        latencyMs: reply.latencyMs,
        tools: reply.toolCalls.map((t) => `${t.name}:${t.ok ? "ok" : "error"}`),
        refused: reply.refused,
        guarded: reply.guarded,
        costUsd: reply.usage?.costUsd ?? 0,
      }),
    );
    return Response.json(reply);
  } catch (err) {
    console.error(JSON.stringify({ at: new Date().toISOString(), error: String(err) }));
    return Response.json({ error: "The assistant failed to answer. Check the server log." }, { status: 500 });
  }
}
