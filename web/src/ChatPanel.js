import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
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
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "./api/client";
const SUGGESTED_PROMPTS = [
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
    if (!status.data)
        return null;
    if (status.data.ollama_available) {
        return (_jsxs("div", { className: "text-[11px] text-text-soft mb-3", children: ["Local model: ", _jsx("span", { className: "font-mono", children: status.data.model }), " \u00B7", " ", _jsx("span", { className: "text-inflow", children: "connected" })] }));
    }
    return (_jsxs("div", { className: "bg-amber-50 border border-amber-200 rounded-md p-4 mb-3 text-sm", children: [_jsx("div", { className: "font-semibold text-warn mb-1", children: "Local AI model not running" }), _jsxs("div", { className: "text-xs text-text-muted leading-snug", children: ["Chat needs Ollama running locally on", " ", _jsx("span", { className: "font-mono", children: status.data.base_url }), ". To set up:", _jsxs("ol", { className: "list-decimal pl-5 mt-2 space-y-0.5", children: [_jsxs("li", { children: ["Install Ollama from", " ", _jsx("a", { href: "https://ollama.com/download", target: "_blank", rel: "noreferrer", className: "text-brand hover:underline", children: "ollama.com/download" })] }), _jsxs("li", { children: ["Pull the model:", " ", _jsxs("code", { className: "font-mono bg-card px-1 rounded", children: ["ollama pull ", status.data.model] })] }), _jsxs("li", { children: ["Start it:", " ", _jsx("code", { className: "font-mono bg-card px-1 rounded", children: "ollama serve" }), " ", "(or just open the Ollama app)"] })] })] })] }));
}
function ToolCallTrace({ calls }) {
    const [open, setOpen] = useState(false);
    if (!calls || calls.length === 0)
        return null;
    return (_jsxs("div", { className: "mt-1.5", children: [_jsxs("button", { onClick: () => setOpen((p) => !p), className: "text-[10px] text-text-soft hover:text-brand", children: [open ? "▾" : "▸", " ", calls.length, " quer", calls.length === 1 ? "y" : "ies", " ran"] }), open && (_jsx("div", { className: "mt-1 bg-slate-50 border border-border rounded p-2 max-h-64 overflow-y-auto", children: calls.map((c, i) => (_jsxs("div", { className: "mb-2 last:mb-0", children: [_jsxs("div", { className: "font-mono text-[10px] text-brand", children: [c.tool, "(", Object.keys(c.args).length > 0 ? "…" : "", ")"] }), Object.keys(c.args).length > 0 && (_jsxs("div", { className: "font-mono text-[10px] text-text-muted ml-3", children: ["args: ", JSON.stringify(c.args)] })), _jsxs("div", { className: "font-mono text-[10px] text-text-muted ml-3 break-all", children: ["\u2192 ", JSON.stringify(c.result).slice(0, 300), JSON.stringify(c.result).length > 300 ? "…" : ""] })] }, i))) }))] }));
}
function MessageBubble({ turn }) {
    if (turn.role === "user") {
        return (_jsx("div", { className: "flex justify-end mb-3", children: _jsx("div", { className: "max-w-[75%] bg-brand text-white rounded-lg px-3 py-2 text-sm shadow-sm", children: turn.content }) }));
    }
    return (_jsx("div", { className: "flex justify-start mb-3", children: _jsxs("div", { className: "max-w-[80%]", children: [_jsx("div", { className: "bg-card border border-border rounded-lg px-3 py-2 text-sm text-text whitespace-pre-wrap leading-relaxed shadow-sm", children: turn.content }), turn.tool_calls && turn.tool_calls.length > 0 && (_jsx(ToolCallTrace, { calls: turn.tool_calls }))] }) }));
}
/* ------------------------------------------------------------------ */
/*  Main panel                                                         */
/* ------------------------------------------------------------------ */
export default function ChatPanel() {
    const [history, setHistory] = useState([]);
    const [input, setInput] = useState("");
    const scrollerRef = useRef(null);
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
        if (qIdx === -1)
            return;
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
    const sendRef = useRef(null);
    const ask = useMutation({
        // Send only role+content to the backend (the tool_calls trace is a
        // local display detail — the planner doesn't need the prior trace).
        mutationFn: (q) => api.chatAsk(q, history.map((t) => ({ role: t.role, content: t.content }))),
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
    const send = (text) => {
        const trimmed = text.trim();
        if (!trimmed)
            return;
        if (ask.isPending)
            return; // prevent double-fire while one is in flight
        setHistory((prev) => [...prev, { role: "user", content: trimmed }]);
        setInput("");
        ask.mutate(trimmed);
    };
    // Keep the ref pointed at the latest send fn so prefill auto-submit works.
    sendRef.current = send;
    return (_jsxs("div", { children: [_jsx(StatusBanner, {}), _jsxs("div", { className: "bg-card border border-border rounded-md shadow-card flex flex-col h-[70vh]", children: [_jsx("div", { ref: scrollerRef, className: "flex-1 overflow-y-auto px-4 py-4", children: history.length === 0 ? (_jsxs("div", { className: "text-center text-text-muted text-sm py-12", children: [_jsx("div", { className: "text-3xl mb-3", children: "\uD83D\uDCAC" }), _jsx("div", { className: "font-semibold text-text mb-1", children: "Ask anything about your money" }), _jsx("div", { className: "text-xs mb-6 max-w-md mx-auto leading-snug", children: "Your data stays local. The model runs on your machine \u2014 no cloud calls." }), _jsx("div", { className: "flex flex-wrap gap-2 justify-center max-w-2xl mx-auto", children: SUGGESTED_PROMPTS.map((p) => (_jsx("button", { onClick: () => send(p), className: "px-3 py-1.5 text-xs border border-border rounded-full hover:border-brand hover:text-brand text-text-muted bg-card text-left", children: p }, p))) })] })) : (_jsxs(_Fragment, { children: [history.map((turn, i) => (_jsx(MessageBubble, { turn: turn }, i))), ask.isPending && (_jsx("div", { className: "flex justify-start mb-3", children: _jsx("div", { className: "bg-card border border-border rounded-lg px-3 py-2 text-sm text-text-muted shadow-sm", children: _jsx("span", { className: "inline-block animate-pulse", children: "Thinking\u2026" }) }) }))] })) }), _jsx("div", { className: "border-t border-border p-3 bg-hover", children: _jsxs("form", { onSubmit: (e) => {
                                e.preventDefault();
                                send(input);
                            }, className: "flex gap-2", children: [_jsx("input", { type: "text", value: input, onChange: (e) => setInput(e.target.value), placeholder: "Ask about your money\u2026", className: "flex-1 px-3 py-2 text-sm border border-border rounded-md bg-card focus:outline-none focus:border-brand", autoFocus: true, disabled: ask.isPending }), _jsx("button", { type: "submit", disabled: !input.trim() || ask.isPending, className: "px-4 py-2 text-sm font-semibold bg-brand text-white rounded-md hover:bg-brand-navy disabled:opacity-50 disabled:cursor-not-allowed", children: ask.isPending ? "…" : "Send" }), history.length > 0 && (_jsx("button", { type: "button", onClick: () => {
                                        setHistory([]);
                                        setInput("");
                                        ask.reset();
                                    }, className: "px-3 py-2 text-xs text-text-muted hover:text-outflow", title: "Clear conversation", children: "Clear" }))] }) })] })] }));
}
