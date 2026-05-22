/**
 * GmailHealthCard — central source of truth for Gmail OAuth health.
 *
 * Surfaces on Overview so when Gmail OAuth silently expires (the
 * common failure mode after ~7 days for unverified apps in test mode),
 * the user sees a red banner instead of "silent staleness" — empty
 * subscription discovery, missing parser hits, stale receipt OCR.
 *
 * Pulls from the existing GET /api/gmail/status endpoint (no backend
 * changes). The card adapts its visual state:
 *   - Configured + authorized + recent sync → quiet green chip
 *   - Configured + authorized + stale sync → amber "Sync running?"
 *   - Configured + NOT authorized → red "Re-authorize Gmail"
 *   - NOT configured → muted "Connect Gmail" CTA
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";

interface GmailStatus {
  configured: boolean;
  authorized: boolean;
  deps_installed: boolean;
  last_sync_at: string | null;
  total_messages: number;
  total_parsed: number;
  total_failed: number;
}

const STALE_AFTER_HOURS = 24;

export default function GmailHealthCard() {
  const q = useQuery<GmailStatus>({
    queryKey: ["gmailStatus"],
    // The api client may not have a typed helper; fall back to fetch.
    queryFn: () =>
      fetch("/api/gmail/status").then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      }),
    staleTime: 60_000,
  });

  if (q.isLoading || q.isError || !q.data) return null;
  const s = q.data;

  // Compute staleness
  let hoursSinceSync: number | null = null;
  if (s.last_sync_at) {
    hoursSinceSync = Math.round(
      (Date.now() - new Date(s.last_sync_at).getTime()) / 3_600_000,
    );
  }

  // Determine visual state
  const fullyOk =
    s.configured &&
    s.authorized &&
    s.deps_installed &&
    s.total_messages > 0 &&
    (hoursSinceSync == null || hoursSinceSync <= STALE_AFTER_HOURS);

  if (fullyOk) {
    // Quiet success chip — single line, doesn't take up vertical space.
    return (
      <div className="bg-emerald-50 border border-inflow/20 rounded-md px-3 py-1.5 mb-3 flex items-center justify-between text-[11px]">
        <span className="text-inflow">
          ✓ <span className="font-semibold">Gmail connected</span> —{" "}
          {s.total_parsed} parsed,{" "}
          {hoursSinceSync != null && hoursSinceSync < 1
            ? "synced just now"
            : `synced ${hoursSinceSync}h ago`}
        </span>
        {s.total_failed > 0 && (
          <span className="text-warn">
            {s.total_failed} parse error{s.total_failed === 1 ? "" : "s"}
          </span>
        )}
      </div>
    );
  }

  // Not OK — render the actionable card.
  let tone: "warn" | "bad" | "muted" = "muted";
  let title = "Connect Gmail";
  let body = "Add Gmail OAuth to unlock receipt parsing, bill detection, and subscription discovery from your inbox.";
  let action = "Open Connections";

  if (!s.configured) {
    tone = "muted";
    title = "Gmail not configured";
    body =
      "Drop a credentials.json file into the backend config dir. See setup docs.";
    action = "View setup steps";
  } else if (!s.deps_installed) {
    tone = "bad";
    title = "Gmail deps missing";
    body =
      "Install the Google API client: `pip install -r backend/requirements.txt`.";
    action = "Re-run install";
  } else if (!s.authorized) {
    tone = "bad";
    title = "Gmail OAuth expired";
    body =
      "Your Gmail token is no longer valid (this happens periodically for unverified apps in test mode). Re-authorize to resume parsing.";
    action = "Re-authorize Gmail";
  } else if (hoursSinceSync != null && hoursSinceSync > STALE_AFTER_HOURS) {
    tone = "warn";
    title = "Gmail sync hasn't run";
    body = `Last successful sync was ${hoursSinceSync}h ago. Trigger a manual sync or check the scheduler.`;
    action = "Sync now";
  } else if (s.total_messages === 0) {
    tone = "warn";
    title = "No emails ingested yet";
    body =
      "Gmail is connected, but no emails have been ingested. Try a manual sync to pull recent messages.";
    action = "Sync now";
  }

  const cls =
    tone === "bad"
      ? "bg-red-50 border-outflow/30 text-outflow"
      : tone === "warn"
        ? "bg-amber-50 border-warn/30 text-warn"
        : "bg-slate-50 border-border text-text-muted";

  return (
    <div className={`border rounded-md px-3 py-2.5 mb-4 ${cls}`}>
      <div className="flex items-start gap-3">
        <span aria-hidden className="text-base">
          {tone === "bad" ? "⚠️" : tone === "warn" ? "⏳" : "✉️"}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold">{title}</div>
          <div className="text-[11px] mt-0.5 text-text-soft">{body}</div>
        </div>
        <button
          type="button"
          onClick={() => {
            window.location.hash = "#connections";
          }}
          className="text-xs font-semibold underline whitespace-nowrap flex-shrink-0"
        >
          {action} →
        </button>
      </div>
    </div>
  );
}
