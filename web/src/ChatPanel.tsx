/**
 * Conversational AI chat — Smart Feature #3.
 *
 * Local Ollama-backed Q&A over the user's financial data. The
 * client is dumb — it streams turns to /api/chat/ask and renders
 * what comes back. All the hard work (context building, prompt
 * composition, model call) is server-side.
 *
 * Design principles:
 *   - Single-column message list, slack/iMessage style. Newest at
 *     bottom. The list scrolls as you converse.
 *   - Suggested-prompt chips on first load so the user has a
 *     concrete jumping-off point — empty inputs are death.
 *   - Model availability is checked on mount via /chat/status; if
 *     Ollama isn't running, render a clear setup CTA instead of
 *     letting the user type into a broken box.
 *   - History is kept in component state (no persistence yet) and
 *     trimmed to last 6 turns when sent to the backend so context
 *     window doesn't blow.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, type ChatToolCall, type ChatTurn, type Category } from "./api/client";

/* Augmented chat turn — assistant turns may carry the tool-call
 * trace from the LLM, which we render in a collapsible block so the
 * user can see exactly what queries ran. */
type AugmentedTurn = ChatTurn & { tool_calls?: ChatToolCall[] };

const SUGGESTED_PROMPTS: string[] = [
  "How much did I spend on dining out in the last 30 days?",
  "What were my top 5 merchants over the last 90 days?",
  "What's my biggest spending category this month vs. last month?",
  "Am I on track for my goals?",
  "How much am I paying for subscriptions every month?",
  "What's my net worth and how is it split between assets and liabilities?",
];

/* ------------------------------------------------------------------ */
/*  Subcomponents                                                      */
/* ------------------------------------------------------------------ */

function StatusBanner() {
  const status = useQuery({
    queryKey: ["chatStatus"],
    queryFn: api.chatStatus,
    staleTime: 60_000,
    retry: false,
  });

  if (!status.data) return null;
  if (status.data.ollama_available) {
    return (
      <div className="text-[11px] text-text-soft mb-3">
        Local model: <span className="font-mono">{status.data.model}</span> ·{" "}
        <span className="text-inflow">connected</span>
      </div>
    );
  }
  return (
    <div className="bg-amber-50 border border-amber-200 rounded-md p-4 mb-3 text-sm">
      <div className="font-semibold text-warn mb-1">
        Local AI model not running
      </div>
      <div className="text-xs text-text-muted leading-snug">
        Chat needs Ollama running locally on{" "}
        <span className="font-mono">{status.data.base_url}</span>. To set up:
        <ol className="list-decimal pl-5 mt-2 space-y-0.5">
          <li>
            Install Ollama from{" "}
            <a
              href="https://ollama.com/download"
              target="_blank"
              rel="noreferrer"
              className="text-brand hover:underline"
            >
              ollama.com/download
            </a>
          </li>
          <li>
            Pull the model:{" "}
            <code className="font-mono bg-card px-1 rounded">
              ollama pull {status.data.model}
            </code>
          </li>
          <li>
            Start it:{" "}
            <code className="font-mono bg-card px-1 rounded">ollama serve</code>{" "}
            (or just open the Ollama app)
          </li>
        </ol>
      </div>
    </div>
  );
}

function ToolCallTrace({ calls }: { calls: ChatToolCall[] }) {
  const [open, setOpen] = useState(false);
  if (!calls || calls.length === 0) return null;
  return (
    <div className="mt-1.5">
      <button
        onClick={() => setOpen((p) => !p)}
        className="text-[10px] text-text-soft hover:text-brand"
      >
        {open ? "▾" : "▸"} {calls.length} quer{calls.length === 1 ? "y" : "ies"} ran
      </button>
      {open && (
        <div className="mt-1 bg-slate-50 border border-border rounded p-2 max-h-64 overflow-y-auto">
          {calls.map((c, i) => (
            <div key={i} className="mb-2 last:mb-0">
              <div className="font-mono text-[10px] text-brand">
                {c.tool}({Object.keys(c.args).length > 0 ? "…" : ""})
              </div>
              {Object.keys(c.args).length > 0 && (
                <div className="font-mono text-[10px] text-text-muted ml-3">
                  args: {JSON.stringify(c.args)}
                </div>
              )}
              <div className="font-mono text-[10px] text-text-muted ml-3 break-all">
                → {JSON.stringify(c.result).slice(0, 300)}
                {JSON.stringify(c.result).length > 300 ? "…" : ""}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MessageBubble({
  turn,
  categories,
}: {
  turn: AugmentedTurn;
  categories: Category[];
}) {
  if (turn.role === "user") {
    return (
      <div className="flex justify-end mb-3">
        <div className="max-w-[75%] bg-brand text-white rounded-lg px-3 py-2 text-sm shadow-sm">
          {turn.content}
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-start mb-3">
      <div className="max-w-[80%]">
        <div className="bg-card border border-border rounded-lg px-3 py-2 text-sm text-text whitespace-pre-wrap leading-relaxed shadow-sm">
          <CitedAnswer text={turn.content} categories={categories} />
        </div>
        {turn.tool_calls && turn.tool_calls.length > 0 && (
          <ToolCallTrace calls={turn.tool_calls} />
        )}
      </div>
    </div>
  );
}

/**
 * CitedAnswer — scan the assistant's text for category-name mentions
 * and wrap each in a clickable chip that navigates to the Budgets panel
 * (which opens the CategoryDrawer for that category). Provides clickable
 * provenance for any number the LLM attributes to a category.
 *
 * Heuristic: case-insensitive whole-word match of any known category
 * name. Skips matches inside numbers/punctuation so "Card" doesn't
 * match in "Credit Card $200". Sorts by name length desc so multi-word
 * names ("Credit Card Payment") match before sub-strings ("Credit").
 */
function CitedAnswer({
  text,
  categories,
}: {
  text: string;
  categories: Category[];
}) {
  const segments = useMemo(() => {
    if (!categories.length) return [{ kind: "text" as const, text }];
    // Build a regex of all category names, longest first.
    const names = categories
      .map((c) => c.name)
      .filter((n) => n && n.length >= 3)
      .sort((a, b) => b.length - a.length)
      .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    if (names.length === 0) return [{ kind: "text" as const, text }];
    const re = new RegExp(`\\b(${names.join("|")})\\b`, "gi");
    const out: Array<
      | { kind: "text"; text: string }
      | { kind: "cite"; text: string; category: Category }
    > = [];
    let lastIdx = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m.index > lastIdx) {
        out.push({ kind: "text", text: text.slice(lastIdx, m.index) });
      }
      const matchText = m[0];
      const cat = categories.find(
        (c) => c.name.toLowerCase() === matchText.toLowerCase(),
      );
      if (cat) {
        out.push({ kind: "cite", text: matchText, category: cat });
      } else {
        out.push({ kind: "text", text: matchText });
      }
      lastIdx = m.index + matchText.length;
    }
    if (lastIdx < text.length) {
      out.push({ kind: "text", text: text.slice(lastIdx) });
    }
    return out;
  }, [text, categories]);

  return (
    <>
      {segments.map((seg, i) =>
        seg.kind === "text" ? (
          <span key={i}>{seg.text}</span>
        ) : (
          <button
            key={i}
            type="button"
            onClick={() => {
              // Stash the target so BudgetsPanel can open the drawer
              // on mount, then navigate. This avoids a complex global
              // state lift just for chat → drawer linkage.
              try {
                sessionStorage.setItem(
                  "pendingCategoryDrawer",
                  JSON.stringify({
                    category_id: seg.category.id,
                    name: seg.category.name,
                  }),
                );
              } catch {
                // sessionStorage can throw in private-mode; ignore.
              }
              window.location.hash = "#budgets";
            }}
            className="inline-flex items-baseline gap-0.5 text-brand underline decoration-dotted underline-offset-2 hover:bg-brand/10 rounded px-0.5 -mx-0.5 focus:outline-none focus:bg-brand/10"
            title={`View ${seg.category.name} transactions`}
          >
            {seg.text}
            <span aria-hidden className="text-[9px] text-brand/60">↗</span>
          </button>
        ),
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Main panel                                                         */
/* ------------------------------------------------------------------ */

export default function ChatPanel() {
  const [history, setHistory] = useState<AugmentedTurn[]>([]);
  const [input, setInput] = useState("");
  const scrollerRef = useRef<HTMLDivElement>(null);
  // Categories power the citation-chip linking in assistant answers.
  // Cached for the session — they don't change often.
  const catsQuery = useQuery({
    queryKey: ["categories"],
    queryFn: api.listCategories,
    staleTime: 5 * 60 * 1000,
  });
  const categories = catsQuery.data ?? [];

  // Auto-scroll to bottom whenever a new turn arrives.
  useEffect(() => {
    if (scrollerRef.current) {
      scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
    }
  }, [history]);

  // Read a prefilled prompt from the URL hash on mount. The "Ask AI"
  // button in the header navigates to "#chat?prompt=<encoded>" — we
  // pick that up, prefill the input, and auto-submit so the user
  // gets an answer without an extra tap. The hash is then cleared
  // so a refresh doesn't double-submit.
  useEffect(() => {
    const hash = window.location.hash;
    const qIdx = hash.indexOf("?");
    if (qIdx === -1) return;
    const params = new URLSearchParams(hash.slice(qIdx + 1));
    const prefill = params.get("prompt");
    if (prefill && prefill.trim()) {
      // Clear the param so navigating away + back doesn't re-fire.
      window.location.hash = "#chat";
      // Defer auto-send to next tick so React's hash listener doesn't
      // re-trigger this effect mid-mount.
      setTimeout(() => {
        sendRef.current?.(prefill);
      }, 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stable ref so the prefill effect can call send() without listing
  // it as a dependency (which would re-run on every history change).
  const sendRef = useRef<((text: string) => void) | null>(null);

  const ask = useMutation({
    // Send only role+content to the backend (the tool_calls trace is a
    // local display detail — the planner doesn't need the prior trace).
    mutationFn: (q: string) =>
      api.chatAsk(
        q,
        history.map((t) => ({ role: t.role, content: t.content })),
      ),
    onSuccess: (resp) => {
      setHistory((prev) => [
        ...prev,
        {
          role: "assistant",
          content: resp.answer,
          tool_calls: resp.tool_calls,
        },
      ]);
    },
    onError: (err) => {
      // Surface as an assistant turn so the chat flow doesn't break.
      const msg = err instanceof Error ? err.message : String(err);
      setHistory((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `Sorry, the request failed: ${msg}`,
        },
      ]);
    },
  });

  const send = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (ask.isPending) return; // prevent double-fire while one is in flight
    setHistory((prev) => [...prev, { role: "user", content: trimmed }]);
    setInput("");
    ask.mutate(trimmed);
  };
  // Keep the ref pointed at the latest send fn so prefill auto-submit works.
  sendRef.current = send;

  return (
    <div>
      <StatusBanner />

      <div className="bg-card border border-border rounded-md shadow-card flex flex-col h-[70vh]">
        {/* Message list */}
        <div
          ref={scrollerRef}
          className="flex-1 overflow-y-auto px-4 py-4"
          aria-live="polite"
          aria-atomic="false"
          aria-label="Chat messages"
        >
          {history.length === 0 ? (
            <div className="text-center text-text-muted text-sm py-12">
              <div className="text-3xl mb-3">💬</div>
              <div className="font-semibold text-text mb-1">
                Ask anything about your money
              </div>
              <div className="text-xs mb-6 max-w-md mx-auto leading-snug">
                Your data stays local. The model runs on your machine — no
                cloud calls.
              </div>
              <div className="flex flex-wrap gap-2 justify-center max-w-2xl mx-auto">
                {SUGGESTED_PROMPTS.map((p) => (
                  <button
                    key={p}
                    onClick={() => send(p)}
                    className="px-3 py-1.5 text-xs border border-border rounded-full hover:border-brand hover:text-brand text-text-muted bg-card text-left"
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <>
              {history.map((turn, i) => (
                <MessageBubble key={i} turn={turn} categories={categories} />
              ))}
              {ask.isPending && (
                <div className="flex justify-start mb-3">
                  <div className="bg-card border border-border rounded-lg px-3 py-2 text-sm text-text-muted shadow-sm">
                    <span className="inline-block animate-pulse">
                      Thinking…
                    </span>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Composer */}
        <div className="border-t border-border p-3 bg-hover">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
            className="flex gap-2"
          >
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask about your money…"
              className="flex-1 px-3 py-2 text-sm border border-border rounded-md bg-card focus:outline-none focus:border-brand"
              autoFocus
              disabled={ask.isPending}
            />
            <button
              type="submit"
              disabled={!input.trim() || ask.isPending}
              className="px-4 py-2 text-sm font-semibold bg-brand text-white rounded-md hover:bg-brand-navy disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {ask.isPending ? "…" : "Send"}
            </button>
            {history.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setHistory([]);
                  setInput("");
                  ask.reset();
                }}
                className="px-3 py-2 text-xs text-text-muted hover:text-outflow"
                title="Clear conversation"
              >
                Clear
              </button>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}
