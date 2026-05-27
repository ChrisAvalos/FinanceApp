import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  fmtCents,
  type GmailMessage,
  type ParserOutcome,
} from "./api/client";
import SyncFreshnessChip from "./components/SyncFreshness";
import PanelError from "./components/PanelError";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const OUTCOME_BADGE: Record<ParserOutcome, string> = {
  parsed: "bg-emerald-50 text-inflow",
  ignored: "bg-gray-100 text-text-muted",
  failed: "bg-red-50 text-outflow",
  duplicate: "bg-amber-50 text-warn",
};

const KIND_LABEL: Record<string, string> = {
  transaction: "Transaction",
  bill: "Bill",
  offer: "Offer",
  report: "Report",
  misc: "Misc",
};

function fmtDateTime(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function extractAmountFromExtra(extra: Record<string, unknown> | null): number | null {
  if (!extra) return null;
  // Bills use bill_amount_cents; transactions already live in the txn row
  // but we peek here so the email list has something useful to show.
  if (typeof extra.bill_amount_cents === "number") return extra.bill_amount_cents;
  return null;
}

/* ------------------------------------------------------------------ */
/*  Panel                                                              */
/* ------------------------------------------------------------------ */

export default function GmailPanel() {
  const qc = useQueryClient();
  const [selectedOutcome, setSelectedOutcome] = useState<ParserOutcome | "all">(
    "parsed"
  );
  const [authError, setAuthError] = useState<string | null>(null);

  const status = useQuery({ queryKey: ["gmailStatus"], queryFn: api.gmailStatus });
  const parsers = useQuery({ queryKey: ["gmailParsers"], queryFn: api.gmailListParsers });
  const messages = useQuery({
    queryKey: ["gmailMessages", selectedOutcome],
    queryFn: () =>
      api.gmailListMessages({
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
    onError: (exc: unknown) =>
      setAuthError(exc instanceof Error ? exc.message : String(exc)),
  });

  const sync = useMutation({
    mutationFn: api.gmailSync,
    onSuccess: () => qc.invalidateQueries(),
  });

  /* ---------------- Not configured (no credentials.json) ---------------- */
  if (status.data && !status.data.configured) {
    return (
      <div className="bg-card border border-border rounded-md shadow-card p-6">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-full bg-brand-light flex items-center justify-center text-brand font-bold">
            G
          </div>
          <div className="flex-1">
            <div className="text-sm font-semibold text-text">
              Connect your Gmail to parse bank alerts, bills &amp; offers
            </div>
            <div className="text-xs text-text-muted mt-1 leading-relaxed">
              Download an OAuth <b>Desktop app</b> credentials JSON from
              Google Cloud Console and save it as{" "}
              <code className="text-brand">{status.data.credentials_path}</code>.
              Walkthrough:
            </div>
            <ol className="text-xs text-text-muted mt-2 list-decimal list-inside leading-relaxed space-y-0.5">
              <li>
                Go to{" "}
                <a
                  className="text-brand hover:text-brand-navy underline"
                  target="_blank"
                  rel="noreferrer"
                  href="https://console.cloud.google.com/apis/credentials"
                >
                  console.cloud.google.com/apis/credentials
                </a>
              </li>
              <li>Enable the <b>Gmail API</b> for your project</li>
              <li>Configure an OAuth consent screen (External, test-user = your email)</li>
              <li>Create <b>OAuth client ID</b> → type: <b>Desktop app</b></li>
              <li>Download the JSON, save it at the path above, then refresh this page</li>
            </ol>
            {!status.data.deps_installed && (
              <div className="text-[11px] text-warn mt-3">
                Google client libraries aren&rsquo;t installed yet — run{" "}
                <code>pip install -e &quot;.[dev]&quot;</code> in{" "}
                <code>backend/</code>.
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  /* ---------------- Configured but not authorized ---------------- */
  if (status.data && status.data.configured && !status.data.authorized) {
    return (
      <div className="bg-card border border-border rounded-md shadow-card p-6">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-full bg-brand-light flex items-center justify-center text-brand font-bold">
            G
          </div>
          <div className="flex-1">
            <div className="text-sm font-semibold text-text">
              Authorize Gmail access
            </div>
            <div className="text-xs text-text-muted mt-1 leading-relaxed">
              Credentials are in place. Click below to run the OAuth consent
              flow — a browser window will open on this machine. Scopes
              requested: <span className="font-mono">gmail.readonly</span>.
            </div>
          </div>
          <button
            onClick={() => authorize.mutate()}
            disabled={authorize.isPending}
            className="px-4 py-2 bg-brand text-white text-sm font-semibold rounded-md hover:bg-brand-navy transition-colors disabled:opacity-60"
          >
            {authorize.isPending ? "Opening browser…" : "Authorize"}
          </button>
        </div>
        {authError && (
          <div className="mt-3 text-xs text-outflow">{authError}</div>
        )}
      </div>
    );
  }

  /* ---------------- Authorized — full panel ---------------- */

  const s = status.data;
  const outcomes: (ParserOutcome | "all")[] = ["parsed", "ignored", "failed", "all"];

  // Group parsers by kind for the empty-state "what we're watching for"
  // card. Audit feedback (post-Wave-C): the parsers index was the most
  // interesting thing on the page and it was buried behind a <details>
  // fold. This pulls a curated preview above the fold whenever there's
  // no data yet, so a first-time user can see exactly what the parser
  // does for them before clicking Sync.
  const parsersByKind = (parsers.data ?? []).reduce<Record<string, typeof parsers.data>>(
    (acc, p) => {
      const k = p.kind;
      if (!acc[k]) acc[k] = [];
      acc[k]!.push(p);
      return acc;
    },
    {} as Record<string, typeof parsers.data>,
  );
  // Stable display order — most "money-relevant" first.
  const KIND_ORDER = ["transaction", "bill", "offer", "report", "misc"];
  const orderedKinds = KIND_ORDER.filter((k) => parsersByKind[k]?.length);
  // Empty inbox = no messages fetched ever. Shows the explainer card.
  const isEmpty = (s?.total_messages ?? 0) === 0;

  return (
    <div className="space-y-5">
      <div className="flex justify-end">
        {/* Use the server's last Gmail-sync timestamp (when messages were
            actually pulled from Google) rather than TanStack's
            dataUpdatedAt — the latter only reflects when we polled the
            status endpoint, which is much fresher than the meaningful
            "when was the inbox last walked" signal. */}
        <SyncFreshnessChip syncedAt={s?.last_sync_at ?? null} label="Gmail synced" />
      </div>

      {/* Greeting hero — shown once the inbox has been walked at least
          once. Reframes the lifetime parser stats as work the panel did
          *for* the user, which is the framing that makes the panel feel
          like a feature rather than infrastructure. */}
      {!isEmpty && s && (
        <div className="bg-card border border-border rounded-md shadow-card p-5">
          <h2 className="text-2xl font-semibold text-text leading-snug">
            Hi Chris{" "}
            <span aria-hidden="true">👋</span>
            <span className="block mt-1 text-text-muted text-base font-normal">
              I've parsed{" "}
              <span className="text-text font-semibold">
                {s.total_parsed.toLocaleString()}
              </span>{" "}
              {s.total_parsed === 1 ? "email" : "emails"} from your inbox so far
              {s.total_failed > 0 && (
                <>
                  {" "}
                  <span className="text-text-soft">
                    ({s.total_failed.toLocaleString()} I couldn't parse — they
                    didn't match a known sender pattern)
                  </span>
                </>
              )}
              .
            </span>
          </h2>
        </div>
      )}

      {/* Empty-state explainer — shown only before the first sync.
          Walks the user through what each parser kind extracts, with
          concrete merchant examples pulled from the parser registry so
          this stays in sync as parsers are added. */}
      {isEmpty && parsers.data && parsers.data.length > 0 && (
        <div className="bg-gradient-to-br from-brand/5 to-inflow/5 border border-brand/20 rounded-md p-5">
          <div className="flex items-start justify-between gap-4 mb-3">
            <div>
              <h3 className="text-sm font-semibold text-text">
                What gets parsed when you sync
              </h3>
              <p className="text-xs text-text-muted mt-1">
                {parsers.data.length} parsers ready — they extract structured
                data from emails we recognize. First sync pulls the last 90 days,
                then incremental sync only checks newer messages.
              </p>
            </div>
            <button
              onClick={() => sync.mutate({})}
              disabled={sync.isPending}
              className="px-4 py-2 bg-brand text-white text-sm font-semibold rounded-md hover:bg-brand-navy disabled:opacity-60 whitespace-nowrap"
            >
              {sync.isPending ? "Syncing…" : "Sync now"}
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
            {orderedKinds.map((kind) => {
              const list = parsersByKind[kind] ?? [];
              const labels = list.map((p) => p.label).slice(0, 3);
              const more = list.length - labels.length;
              return (
                <div
                  key={kind}
                  className="bg-card border border-border rounded-md p-3"
                >
                  <div className="text-xs font-semibold text-text-muted uppercase tracking-wide">
                    {KIND_LABEL[kind] ?? kind} · {list.length}
                  </div>
                  <div className="text-sm text-text mt-1">
                    {labels.join(", ")}
                    {more > 0 && (
                      <span className="text-text-soft"> + {more} more</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {/* Toolbar */}
      <div className="bg-card border border-border rounded-md shadow-card overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border bg-hover">
          <div>
            <div className="text-sm font-semibold text-text">
              Gmail parser
            </div>
            <div className="text-xs text-text-muted mt-0.5">
              {s?.total_messages ?? 0} fetched · {s?.total_parsed ?? 0} parsed ·{" "}
              {s?.total_failed ?? 0} failed · last sync{" "}
              {fmtDateTime(s?.last_sync_at ?? null)}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => sync.mutate({})}
              disabled={sync.isPending}
              className="px-4 py-2 bg-brand text-white text-sm font-semibold rounded-md hover:bg-brand-navy transition-colors disabled:opacity-60"
            >
              {sync.isPending ? "Syncing…" : "Sync Gmail"}
            </button>
          </div>
        </div>

        {sync.data && (
          <div className="px-5 py-3 text-xs text-text-muted bg-emerald-50 border-b border-border">
            Fetched <b>{sync.data.fetched}</b> · <b>{sync.data.new}</b> new ·{" "}
            <b>{sync.data.parsed}</b> parsed · <b>{sync.data.transactions_created}</b>{" "}
            transactions · <b>{sync.data.bills_seen}</b> bills ·{" "}
            <b>{sync.data.reports_seen}</b> reports
          </div>
        )}

        {sync.isError && (
          <div className="px-5 py-3 border-b border-border">
            <PanelError title="Couldn't sync Gmail." error={sync.error} onRetry={() => sync.mutate({})} compact />
          </div>
        )}

        {/* Outcome filter tabs */}
        <div className="flex gap-4 px-5 py-2 text-xs border-b border-border">
          {outcomes.map((o) => (
            <button
              key={o}
              onClick={() => setSelectedOutcome(o)}
              className={`uppercase tracking-wide font-semibold ${
                selectedOutcome === o
                  ? "text-brand border-b-2 border-brand pb-1"
                  : "text-text-muted hover:text-text pb-1"
              }`}
            >
              {o}
            </button>
          ))}
        </div>

        {/* Messages table */}
        <table className="w-full">
          <thead className="bg-hover border-b border-border">
            <tr className="text-text-muted text-[11px] font-semibold uppercase tracking-wide">
              <th className="px-4 py-2 text-left">Received</th>
              <th className="px-4 py-2 text-left">From</th>
              <th className="px-4 py-2 text-left">Subject</th>
              <th className="px-4 py-2 text-left">Parser</th>
              <th className="px-4 py-2 text-left">Outcome</th>
              <th className="px-4 py-2 text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {messages.isLoading && (
              <tr>
                <td colSpan={6} className="p-8 text-center text-text-muted text-sm">
                  Loading…
                </td>
              </tr>
            )}
            {messages.data?.length === 0 && (
              <tr>
                <td colSpan={6} className="p-8 text-center text-text-muted text-sm">
                  No {selectedOutcome === "all" ? "" : selectedOutcome} messages yet — click{" "}
                  <em>Sync Gmail</em>.
                </td>
              </tr>
            )}
            {messages.data?.map((m) => (
              <GmailRow key={m.id} msg={m} />
            ))}
          </tbody>
        </table>
      </div>

      {/* Parsers index */}
      <details className="bg-card border border-border rounded-md shadow-card">
        <summary className="px-5 py-3 cursor-pointer text-sm font-semibold text-text hover:bg-hover">
          Registered parsers ({parsers.data?.length ?? 0})
        </summary>
        <table className="w-full">
          <thead className="bg-hover border-b border-border">
            <tr className="text-text-muted text-[11px] font-semibold uppercase tracking-wide">
              <th className="px-4 py-2 text-left">Label</th>
              <th className="px-4 py-2 text-left">Kind</th>
              <th className="px-4 py-2 text-left">Senders</th>
              <th className="px-4 py-2 text-right">Matches</th>
            </tr>
          </thead>
          <tbody>
            {(parsers.data ?? []).map((p) => (
              <tr
                key={p.name}
                className="border-b border-border last:border-0 hover:bg-hover"
              >
                <td className="px-4 py-2 text-sm font-medium">{p.label}</td>
                <td className="px-4 py-2 text-xs text-text-muted">
                  {KIND_LABEL[p.kind] ?? p.kind}
                </td>
                <td className="px-4 py-2 text-xs text-text-soft font-mono truncate max-w-sm">
                  {p.from_domains.length ? p.from_domains.join(", ") : "—"}
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-sm">
                  {p.match_count}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Row                                                                */
/* ------------------------------------------------------------------ */

function GmailRow({ msg }: { msg: GmailMessage }) {
  const amount = extractAmountFromExtra(msg.extra);
  return (
    <tr className="border-b border-border last:border-0 hover:bg-hover">
      <td className="px-4 py-3 text-xs text-text-muted whitespace-nowrap">
        {fmtDateTime(msg.received_at)}
      </td>
      <td className="px-4 py-3 text-xs">
        <div className="font-mono text-text-soft">{msg.from_domain}</div>
      </td>
      <td className="px-4 py-3 text-sm truncate max-w-md">
        {msg.subject || <span className="text-text-soft">(no subject)</span>}
      </td>
      <td className="px-4 py-3 text-xs text-text-muted">
        {msg.parser_name || "—"}
      </td>
      <td className="px-4 py-3">
        <span
          className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold uppercase tracking-wide ${OUTCOME_BADGE[msg.parser_outcome]}`}
        >
          {msg.parser_outcome}
        </span>
        {msg.parser_error && (
          <div className="text-[11px] text-outflow mt-1 max-w-xs truncate">
            {msg.parser_error.split("\n")[0]}
          </div>
        )}
      </td>
      <td className="px-4 py-3 text-right tabular-nums text-sm text-outflow">
        {amount != null ? fmtCents(-Math.abs(amount)) : "—"}
      </td>
    </tr>
  );
}
