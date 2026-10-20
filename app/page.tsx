"use client";

import { useEffect, useRef, useState } from "react";
import type { AgentReply, ChatMessage } from "@/src/lib/agent";

interface Status {
  mode: "live" | "mock";
  model: string | null;
  database: string;
  embedder: string;
  documents: { path: string; title: string; chunks: number }[];
}

type Turn = { role: "user"; content: string } | { role: "assistant"; content: string; reply?: AgentReply; error?: boolean };

const SAMPLES = [
  "How often should I descale the Bloom One?",
  "Can I return a grinder I've already used?",
  "What grind setting should I use for pour-over?",
  "Where is my order TB-10042? My email is sam@example.com",
  "Do you offer a student discount?",
  "Please open a ticket: my Bloom One shows E2 again. I'm maya@example.com",
];

/** Renders "text [1]" with the markers as small superscripts. */
function WithMarkers({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\[\d+\])/).map((part, i) =>
        /^\[\d+\]$/.test(part) ? (
          <span key={i} className="marker">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}

function AssistantMessage({ turn }: { turn: Extract<Turn, { role: "assistant" }> }) {
  const r = turn.reply;
  return (
    <div className={`msg assistant${turn.error ? " error" : ""}`}>
      <WithMarkers text={turn.content} />
      {r && r.citations.length > 0 && (
        <ul className="sources">
          {r.citations.map((c) => (
            <li key={c.n}>
              <span className="marker">[{c.n}]</span>{" "}
              <span className="where">{c.kind === "doc" ? `${c.source} › ${c.section}` : `${c.source} tool · ${c.section}`}</span>
              {c.kind === "doc" && <span className="quote">“{c.quote}”</span>}
            </li>
          ))}
        </ul>
      )}
      {r && (
        <div className="meta">
          {r.toolCalls.map((t, i) => (
            <span key={i} className={`chip ${t.ok ? "ok" : "bad"}`}>
              {t.name} {t.ok ? "✓" : "✗"}
            </span>
          ))}
          {r.refused && <span className="chip">no answer in docs</span>}
          {r.guarded && <span className="chip bad">grounding guard</span>}
          <span>
            {r.mode === "live" ? r.model : "mock"} · {(r.latencyMs / 1000).toFixed(1)} s ·{" "}
            {r.usage?.costUsd != null ? `$${r.usage.costUsd.toFixed(4)}` : "$0"}
          </span>
        </div>
      )}
    </div>
  );
}

export default function Page() {
  const [status, setStatus] = useState<Status | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/status").then((r) => r.json()).then(setStatus).catch(() => setStatus(null));
  }, []);
  useEffect(() => {
    // Braces matter: newer browsers return a Promise from scrollIntoView, and React
    // would treat a returned value as the effect's cleanup function.
    end.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns]);

  async function send(text: string) {
    const content = text.trim();
    if (!content || busy) return;
    const next: Turn[] = [...turns, { role: "user", content }];
    setTurns(next);
    setInput("");
    setBusy(true);
    try {
      const messages: ChatMessage[] = next.filter((t) => !("error" in t && t.error)).map(({ role, content }) => ({ role, content }));
      const res = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages }) });
      const json = await res.json();
      setTurns([...next, res.ok ? { role: "assistant", content: json.answer, reply: json } : { role: "assistant", content: json.error ?? "Something went wrong.", error: true }]);
    } catch {
      setTurns([...next, { role: "assistant", content: "Couldn't reach the server.", error: true }]);
    } finally {
      setBusy(false);
    }
  }

  const lastReply = [...turns].reverse().find((t): t is Extract<Turn, { role: "assistant" }> => t.role === "assistant" && !!t.reply)?.reply;

  return (
    <main>
      <header>
        <h1>Tamp &amp; Bloom support agent</h1>
        <p className="sub">
          Answers from the shop&apos;s own help docs, cites the source for every answer, says &ldquo;I don&apos;t know&rdquo; when the docs
          don&apos;t cover it, and can look up an order or open a ticket. Tamp &amp; Bloom is a fictional shop made for this demo.
        </p>
        {status?.mode === "mock" && (
          <div className="banner">
            <b>Mock mode.</b> No ANTHROPIC_API_KEY is set, so no AI model is called: answers are the best-matching sentences from the
            docs, picked by fixed rules. Retrieval, citations, tools and the database are real.
          </div>
        )}
      </header>

      <section className="panel chat">
        <div className="messages">
          {turns.length === 0 && <p className="sub">Ask a question, or pick one on the right.</p>}
          {turns.map((t, i) =>
            t.role === "user" ? (
              <div key={i} className="msg user">
                {t.content}
              </div>
            ) : (
              <AssistantMessage key={i} turn={t} />
            ),
          )}
          {busy && <div className="msg assistant sub">Searching the docs…</div>}
          <div ref={end} />
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
        >
          <input type="text" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask about shipping, returns, a machine…" aria-label="Your question" />
          <button className="send" disabled={busy || !input.trim()}>
            Send
          </button>
        </form>
      </section>

      <aside>
        <div className="panel">
          <h2>Try</h2>
          <div className="samples">
            {SAMPLES.map((s) => (
              <button key={s} onClick={() => void send(s)} disabled={busy}>
                {s}
              </button>
            ))}
          </div>
        </div>
        {lastReply && (
          <div className="panel">
            <h2>Retrieved for the last question</h2>
            {lastReply.retrieved.length === 0 ? (
              <p className="kv">Nothing in the docs matched.</p>
            ) : (
              <ul className="retrieved">
                {lastReply.retrieved.map((c, i) => (
                  <li key={i}>
                    <span>
                      {c.source} › {c.section}
                    </span>
                    <span className="score">{c.similarity.toFixed(2)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {status && (
          <div className="panel">
            <h2>Knowledge base</h2>
            <ul className="docs">
              {status.documents.map((d) => (
                <li key={d.path}>
                  <span>{d.path}</span>
                  <span className="n">{d.chunks} chunks</span>
                </li>
              ))}
            </ul>
            <p className="kv" style={{ marginTop: 10 }}>
              <b>Model:</b> {status.model ?? "none (mock)"}
              <br />
              <b>Database:</b> {status.database}
              <br />
              <b>Embeddings:</b> {status.embedder}
            </p>
          </div>
        )}
      </aside>
    </main>
  );
}
