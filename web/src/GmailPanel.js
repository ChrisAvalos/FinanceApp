import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, fmtCents, } from "./api/client";
/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */
const OUTCOME_BADGE = {
    parsed: "bg-emerald-50 text-inflow",
    ignored: "bg-gray-100 text-text-muted",
    failed: "bg-red-50 text-outflow",
    duplicate: "bg-amber-50 text-warn",
};
const KIND_LABEL = {
    transaction: "Transaction",
    bill: "Bill",
    offer: "Offer",
    report: "Report",
    misc: "Misc",
};
function fmtDateTime(iso) {
    if (!iso)
        return "never";
    const d = new Date(iso);
    return d.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
    });
}
function extractAmountFromExtra(extra) {
    if (!extra)
        return null;
    // Bills use bill_amount_cents; transactions already live in the txn row
    // but we peek here so the email list has something useful to show.
    if (typeof extra.bill_amount_cents === "number")
        return extra.bill_amount_cents;
    return null;
}
/* ------------------------------------------------------------------ */
/*  Panel                                                              */
/* ------------------------------------------------------------------ */
export default function GmailPanel() {
    const qc = useQueryClient();
    const [selectedOutcome, setSelectedOutcome] = useState("parsed");
    const [authError, setAuthError] = useState(null);
    const status = useQuery({ queryKey: ["gmailStatus"], queryFn: api.gmailStatus });
    const parsers = useQuery({ queryKey: ["gmailParsers"], queryFn: api.gmailListParsers });
    const messages = useQuery({
        queryKey: ["gmailMessages", selectedOutcome],
        queryFn: () => api.gmailListMessages({
            outcome: selectedOutcome === "all" ? undefined : selectedOutcome,
            limit: 50,
        }),
        enabled: !!status.data?.authorized,
    });
    const authorize = useMutation({
        mutationFn: api.gmailAuthorize,
        onSuccess: () => {
            setAuthError(null);
            qc.invalidateQueries({ queryKey: ["gmailStatus"] });
        },
        onError: (exc) => setAuthError(exc instanceof Error ? exc.message : String(exc)),
    });
    const sync = useMutation({
        mutationFn: api.gmailSync,
        onSuccess: () => qc.invalidateQueries(),
    });
    /* ---------------- Not configured (no credentials.json) ---------------- */
    if (status.data && !status.data.configured) {
        return (_jsx("div", { className: "bg-card border border-border rounded-md shadow-card p-6", children: _jsxs("div", { className: "flex items-start gap-3", children: [_jsx("div", { className: "w-9 h-9 rounded-full bg-brand-light flex items-center justify-center text-brand font-bold", children: "G" }), _jsxs("div", { className: "flex-1", children: [_jsx("div", { className: "text-sm font-semibold text-text", children: "Connect your Gmail to parse bank alerts, bills & offers" }), _jsxs("div", { className: "text-xs text-text-muted mt-1 leading-relaxed", children: ["Download an OAuth ", _jsx("b", { children: "Desktop app" }), " credentials JSON from Google Cloud Console and save it as", " ", _jsx("code", { className: "text-brand", children: status.data.credentials_path }), ". Walkthrough:"] }), _jsxs("ol", { className: "text-xs text-text-muted mt-2 list-decimal list-inside leading-relaxed space-y-0.5", children: [_jsxs("li", { children: ["Go to", " ", _jsx("a", { className: "text-brand hover:text-brand-navy underline", target: "_blank", rel: "noreferrer", href: "https://console.cloud.google.com/apis/credentials", children: "console.cloud.google.com/apis/credentials" })] }), _jsxs("li", { children: ["Enable the ", _jsx("b", { children: "Gmail API" }), " for your project"] }), _jsx("li", { children: "Configure an OAuth consent screen (External, test-user = your email)" }), _jsxs("li", { children: ["Create ", _jsx("b", { children: "OAuth client ID" }), " \u2192 type: ", _jsx("b", { children: "Desktop app" })] }), _jsx("li", { children: "Download the JSON, save it at the path above, then refresh this page" })] }), !status.data.deps_installed && (_jsxs("div", { className: "text-[11px] text-warn mt-3", children: ["Google client libraries aren\u2019t installed yet \u2014 run", " ", _jsx("code", { children: "pip install -e \".[dev]\"" }), " in", " ", _jsx("code", { children: "backend/" }), "."] }))] })] }) }));
    }
    /* ---------------- Configured but not authorized ---------------- */
    if (status.data && status.data.configured && !status.data.authorized) {
        return (_jsxs("div", { className: "bg-card border border-border rounded-md shadow-card p-6", children: [_jsxs("div", { className: "flex items-start gap-3", children: [_jsx("div", { className: "w-9 h-9 rounded-full bg-brand-light flex items-center justify-center text-brand font-bold", children: "G" }), _jsxs("div", { className: "flex-1", children: [_jsx("div", { className: "text-sm font-semibold text-text", children: "Authorize Gmail access" }), _jsxs("div", { className: "text-xs text-text-muted mt-1 leading-relaxed", children: ["Credentials are in place. Click below to run the OAuth consent flow \u2014 a browser window will open on this machine. Scopes requested: ", _jsx("span", { className: "font-mono", children: "gmail.readonly" }), "."] })] }), _jsx("button", { onClick: () => authorize.mutate(), disabled: authorize.isPending, className: "px-4 py-2 bg-brand text-white text-sm font-semibold rounded-md hover:bg-brand-navy transition-colors disabled:opacity-60", children: authorize.isPending ? "Opening browser…" : "Authorize" })] }), authError && (_jsx("div", { className: "mt-3 text-xs text-outflow", children: authError }))] }));
    }
    /* ---------------- Authorized — full panel ---------------- */
    const s = status.data;
    const outcomes = ["parsed", "ignored", "failed", "all"];
    return (_jsxs("div", { className: "space-y-5", children: [_jsxs("div", { className: "bg-card border border-border rounded-md shadow-card overflow-hidden", children: [_jsxs("div", { className: "flex items-center justify-between px-5 py-4 border-b border-border bg-hover", children: [_jsxs("div", { children: [_jsx("div", { className: "text-sm font-semibold text-text", children: "Gmail parser" }), _jsxs("div", { className: "text-xs text-text-muted mt-0.5", children: [s?.total_messages ?? 0, " fetched \u00B7 ", s?.total_parsed ?? 0, " parsed \u00B7", " ", s?.total_failed ?? 0, " failed \u00B7 last sync", " ", fmtDateTime(s?.last_sync_at ?? null)] })] }), _jsx("div", { className: "flex items-center gap-2", children: _jsx("button", { onClick: () => sync.mutate({}), disabled: sync.isPending, className: "px-4 py-2 bg-brand text-white text-sm font-semibold rounded-md hover:bg-brand-navy transition-colors disabled:opacity-60", children: sync.isPending ? "Syncing…" : "Sync Gmail" }) })] }), sync.data && (_jsxs("div", { className: "px-5 py-3 text-xs text-text-muted bg-emerald-50 border-b border-border", children: ["Fetched ", _jsx("b", { children: sync.data.fetched }), " \u00B7 ", _jsx("b", { children: sync.data.new }), " new \u00B7", " ", _jsx("b", { children: sync.data.parsed }), " parsed \u00B7 ", _jsx("b", { children: sync.data.transactions_created }), " ", "transactions \u00B7 ", _jsx("b", { children: sync.data.bills_seen }), " bills \u00B7", " ", _jsx("b", { children: sync.data.reports_seen }), " reports"] })), sync.isError && (_jsx("div", { className: "px-5 py-3 text-xs text-outflow bg-red-50 border-b border-border", children: sync.error instanceof Error ? sync.error.message : "Sync failed" })), _jsx("div", { className: "flex gap-4 px-5 py-2 text-xs border-b border-border", children: outcomes.map((o) => (_jsx("button", { onClick: () => setSelectedOutcome(o), className: `uppercase tracking-wide font-semibold ${selectedOutcome === o
                                ? "text-brand border-b-2 border-brand pb-1"
                                : "text-text-muted hover:text-text pb-1"}`, children: o }, o))) }), _jsxs("table", { className: "w-full", children: [_jsx("thead", { className: "bg-hover border-b border-border", children: _jsxs("tr", { className: "text-text-muted text-[11px] font-semibold uppercase tracking-wide", children: [_jsx("th", { className: "px-4 py-2 text-left", children: "Received" }), _jsx("th", { className: "px-4 py-2 text-left", children: "From" }), _jsx("th", { className: "px-4 py-2 text-left", children: "Subject" }), _jsx("th", { className: "px-4 py-2 text-left", children: "Parser" }), _jsx("th", { className: "px-4 py-2 text-left", children: "Outcome" }), _jsx("th", { className: "px-4 py-2 text-right", children: "Amount" })] }) }), _jsxs("tbody", { children: [messages.isLoading && (_jsx("tr", { children: _jsx("td", { colSpan: 6, className: "p-8 text-center text-text-muted text-sm", children: "Loading\u2026" }) })), messages.data?.length === 0 && (_jsx("tr", { children: _jsxs("td", { colSpan: 6, className: "p-8 text-center text-text-muted text-sm", children: ["No ", selectedOutcome === "all" ? "" : selectedOutcome, " messages yet \u2014 click", " ", _jsx("em", { children: "Sync Gmail" }), "."] }) })), messages.data?.map((m) => (_jsx(GmailRow, { msg: m }, m.id)))] })] })] }), _jsxs("details", { className: "bg-card border border-border rounded-md shadow-card", children: [_jsxs("summary", { className: "px-5 py-3 cursor-pointer text-sm font-semibold text-text hover:bg-hover", children: ["Registered parsers (", parsers.data?.length ?? 0, ")"] }), _jsxs("table", { className: "w-full", children: [_jsx("thead", { className: "bg-hover border-b border-border", children: _jsxs("tr", { className: "text-text-muted text-[11px] font-semibold uppercase tracking-wide", children: [_jsx("th", { className: "px-4 py-2 text-left", children: "Label" }), _jsx("th", { className: "px-4 py-2 text-left", children: "Kind" }), _jsx("th", { className: "px-4 py-2 text-left", children: "Senders" }), _jsx("th", { className: "px-4 py-2 text-right", children: "Matches" })] }) }), _jsx("tbody", { children: (parsers.data ?? []).map((p) => (_jsxs("tr", { className: "border-b border-border last:border-0 hover:bg-hover", children: [_jsx("td", { className: "px-4 py-2 text-sm font-medium", children: p.label }), _jsx("td", { className: "px-4 py-2 text-xs text-text-muted", children: KIND_LABEL[p.kind] ?? p.kind }), _jsx("td", { className: "px-4 py-2 text-xs text-text-soft font-mono truncate max-w-sm", children: p.from_domains.length ? p.from_domains.join(", ") : "—" }), _jsx("td", { className: "px-4 py-2 text-right tabular-nums text-sm", children: p.match_count })] }, p.name))) })] })] })] }));
}
/* ------------------------------------------------------------------ */
/*  Row                                                                */
/* ------------------------------------------------------------------ */
function GmailRow({ msg }) {
    const amount = extractAmountFromExtra(msg.extra);
    return (_jsxs("tr", { className: "border-b border-border last:border-0 hover:bg-hover", children: [_jsx("td", { className: "px-4 py-3 text-xs text-text-muted whitespace-nowrap", children: fmtDateTime(msg.received_at) }), _jsx("td", { className: "px-4 py-3 text-xs", children: _jsx("div", { className: "font-mono text-text-soft", children: msg.from_domain }) }), _jsx("td", { className: "px-4 py-3 text-sm truncate max-w-md", children: msg.subject || _jsx("span", { className: "text-text-soft", children: "(no subject)" }) }), _jsx("td", { className: "px-4 py-3 text-xs text-text-muted", children: msg.parser_name || "—" }), _jsxs("td", { className: "px-4 py-3", children: [_jsx("span", { className: `inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold uppercase tracking-wide ${OUTCOME_BADGE[msg.parser_outcome]}`, children: msg.parser_outcome }), msg.parser_error && (_jsx("div", { className: "text-[11px] text-outflow mt-1 max-w-xs truncate", children: msg.parser_error.split("\n")[0] }))] }), _jsx("td", { className: "px-4 py-3 text-right tabular-nums text-sm text-outflow", children: amount != null ? fmtCents(-Math.abs(amount)) : "—" })] }));
}
