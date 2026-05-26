/**
 * Notifications panel — redesigned 2026-05.
 *
 * Replaces the original flat list with a category-grouped feed:
 *
 *   • Security (red)        — anomalies, large charges, low balances
 *   • Money    (emerald)    — price hikes, milestones, score moves
 *   • Opportunity (amber)   — claims, offers, unclaimed property
 *   • System   (slate)      — sync errors, scraper auth, scheduler
 *
 * Per-category colors + SVG icons so the eye triages by looking at the
 * left rail, not by reading every title. The category itself comes from
 * the backend (_KIND_META in api/notifications.py) — keeping the
 * mapping server-side means future producers don't need a coordinating
 * frontend change.
 *
 * Other lifts:
 *   • Relative timestamps ("2h ago"), full date in tooltip on hover.
 *   • Skeleton screen instead of "Loading…" string.
 *   • Click-to-drill: clicking a row sets window.location.hash to the
 *     row's `link` (anomaly → AnomalyPanel, etc).
 *   • Undo-on-delete: 5s toast restores the row before the API call commits.
 *   • Clear-read action — bulk-deletes everything already read. Useful
 *     for keeping the list lean over time.
 */
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type AppNotification,
  type NotificationCategory,
} from "./api/client";
import SyncFreshnessChip from "./components/SyncFreshness";
import PanelError from "./components/PanelError";

/* ------------------------------------------------------------------ */
/*  Category visual config                                             */
/* ------------------------------------------------------------------ */

type CategoryConfig = {
  label: string;
  /** Tailwind class for the small left-rail accent + chip. */
  rail: string;
  chipBg: string;
  chipText: string;
  /** Inline SVG path data — keeps the file dependency-free. */
  iconPath: string;
};

const CATEGORY_CONFIG: Record<NotificationCategory, CategoryConfig> = {
  security: {
    label: "Security",
    rail: "bg-rose-500",
    chipBg: "bg-rose-100",
    chipText: "text-rose-700",
    // Shield icon
    iconPath:
      "M12 2 4 5v6c0 5 3.5 9.4 8 11 4.5-1.6 8-6 8-11V5l-8-3Z",
  },
  money: {
    label: "Money",
    rail: "bg-emerald-500",
    chipBg: "bg-emerald-100",
    chipText: "text-emerald-700",
    // Dollar sign in circle
    iconPath:
      "M12 3v18M8 7h6a3 3 0 0 1 0 6H10a3 3 0 0 0 0 6h6",
  },
  opportunity: {
    label: "Opportunity",
    rail: "bg-amber-500",
    chipBg: "bg-amber-100",
    chipText: "text-amber-700",
    // Bell / star icon
    iconPath:
      "M12 2v3m0 14v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.5 8.5 2.1 2.1m0-12.7-2.1 2.1m-8.5 8.5-2.1 2.1",
  },
  system: {
    label: "System",
    rail: "bg-slate-400",
    chipBg: "bg-slate-100",
    chipText: "text-slate-600",
    // Gear icon (simplified)
    iconPath:
      "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm9 4-2.4-.4-.8-1.9 1.4-2-1.4-1.4-2 1.4-1.9-.8L13.5 3h-3l-.4 2.4-1.9.8-2-1.4L4.8 6.2l1.4 2-.8 1.9L3 10.5v3l2.4.4.8 1.9-1.4 2 1.4 1.4 2-1.4 1.9.8.4 2.4h3l.4-2.4 1.9-.8 2 1.4 1.4-1.4-1.4-2 .8-1.9L21 13.5v-3Z",
  },
};

const CATEGORY_ORDER: NotificationCategory[] = [
  "security",
  "money",
  "opportunity",
  "system",
];

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** "2h ago", "5m ago", "just now" — keeps rows scanable. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const sec = Math.max(0, Math.round((now - then) / 1000));
  if (sec < 30) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  const wk = Math.round(day / 7);
  if (wk < 4) return `${wk}w ago`;
  const mo = Math.round(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  const yr = Math.round(day / 365);
  return `${yr}y ago`;
}

function CategoryIcon({ category, size = 14 }: { category: NotificationCategory; size?: number }) {
  const cfg = CATEGORY_CONFIG[category];
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={cfg.iconPath} />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  Skeleton loader                                                    */
/* ------------------------------------------------------------------ */

function SkeletonRows({ count = 5 }: { count?: number }) {
  return (
    <div className="bg-card border border-border rounded-md shadow-card overflow-hidden">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="p-3 border-b border-border last:border-0 flex gap-3">
          <div className="w-1 self-stretch bg-slate-200 rounded animate-pulse" />
          <div className="flex-1 space-y-2">
            <div className="h-3 w-24 bg-slate-200 rounded animate-pulse" />
            <div className="h-3 w-3/4 bg-slate-200 rounded animate-pulse" />
            <div className="h-2 w-1/3 bg-slate-200 rounded animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Notification row                                                    */
/* ------------------------------------------------------------------ */

function NotificationRow({
  n,
  onRead,
  onDelete,
  onDrill,
}: {
  n: AppNotification;
  onRead: () => void;
  onDelete: () => void;
  onDrill: () => void;
}) {
  const cfg = CATEGORY_CONFIG[n.category];
  const fullDate = new Date(n.created_at).toLocaleString();
  const isClickable = !!n.link;

  return (
    <div
      className={`group flex gap-3 p-3 border-b border-border last:border-0 transition-colors ${
        n.is_read ? "" : "bg-amber-50/40"
      } ${isClickable ? "cursor-pointer hover:bg-slate-50" : ""}`}
      onClick={() => {
        if (!isClickable) return;
        // Mark as read on drill — feels natural for a feed.
        if (!n.is_read) onRead();
        onDrill();
      }}
      role={isClickable ? "button" : undefined}
      tabIndex={isClickable ? 0 : undefined}
      onKeyDown={(e) => {
        if (!isClickable) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (!n.is_read) onRead();
          onDrill();
        }
      }}
    >
      {/* Left rail — color coded by category */}
      <div className={`w-1 self-stretch rounded ${cfg.rail}`} aria-hidden="true" />

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-[10px] font-semibold uppercase tracking-wide ${cfg.chipBg} ${cfg.chipText}`}
          >
            <CategoryIcon category={n.category} />
            {cfg.label}
          </span>
          <span className="text-[10px] uppercase tracking-wide text-text-soft font-mono">
            {n.kind}
          </span>
          {!n.is_read && (
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-brand" title="Unread" />
          )}
        </div>
        <h4
          className={`text-sm mt-1 ${
            n.is_read ? "text-text-muted" : "text-text font-semibold"
          }`}
        >
          {n.title}
        </h4>
        {n.body && <p className="text-xs text-text-muted mt-0.5">{n.body}</p>}
        <div className="text-[11px] text-text-soft mt-1" title={fullDate}>
          {relativeTime(n.created_at)}
        </div>
      </div>

      {/* Right-side actions. Hidden until row hover so the feed is calm
          at rest, full-fat on focus. stopPropagation so clicking these
          doesn't also trigger the row's drill-in. */}
      <div
        className="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity"
        onClick={(e) => e.stopPropagation()}
      >
        {!n.is_read && (
          <button
            onClick={onRead}
            className="px-2 py-1 text-[11px] font-semibold rounded border border-border hover:border-brand hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1"
            aria-label={`Mark "${n.title}" as read`}
          >
            Read
          </button>
        )}
        <button
          onClick={onDelete}
          className="px-2 py-1 text-[11px] text-text-muted hover:text-outflow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-outflow focus-visible:ring-offset-1 rounded"
          aria-label={`Delete notification "${n.title}"`}
        >
          Del
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Undo toast                                                          */
/* ------------------------------------------------------------------ */

function UndoToast({ message, onUndo }: { message: string; onUndo: () => void }) {
  return (
    <div
      className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-text text-white text-xs rounded-md shadow-lg px-4 py-2 flex items-center gap-3"
      role="status"
      // aria-live="polite" so screen readers announce the deletion
      // without interrupting whatever the user is doing. "assertive"
      // would be obnoxious — undo isn't an emergency.
      aria-live="polite"
      // Keep the toast in the focus order so keyboard users can Tab to
      // the Undo button quickly.
    >
      <span>{message}</span>
      <button
        onClick={onUndo}
        className="font-semibold underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-text rounded"
        aria-label="Undo deletion"
      >
        Undo
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Panel                                                               */
/* ------------------------------------------------------------------ */

const UNDO_WINDOW_MS = 5000;

export default function NotificationsPanel() {
  const qc = useQueryClient();
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [activeCategory, setActiveCategory] = useState<NotificationCategory | "all">(
    "all",
  );
  const [pendingDelete, setPendingDelete] = useState<AppNotification | null>(null);
  const undoTimerRef = useRef<number | null>(null);

  const list = useQuery({
    queryKey: ["notifications", onlyUnread],
    queryFn: () => api.listNotifications(onlyUnread, 100),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["notifications"] });

  const read = useMutation({
    mutationFn: api.markNotificationRead,
    onSuccess: invalidate,
  });
  const readAll = useMutation({
    mutationFn: api.markAllNotificationsRead,
    onSuccess: invalidate,
  });
  const clearRead = useMutation({
    mutationFn: api.clearReadNotifications,
    onSuccess: invalidate,
  });
  const destroy = useMutation({
    mutationFn: api.deleteNotification,
    onSuccess: invalidate,
  });

  /** Clean up the pending-delete timer if the user closes the panel
   *  before the toast fades. Otherwise the queued mutation would fire
   *  after unmount and trigger a stale-cache warning. */
  useEffect(() => {
    return () => {
      if (undoTimerRef.current !== null) window.clearTimeout(undoTimerRef.current);
    };
  }, []);

  /** Two-stage delete: stash in pendingDelete, show toast for 5s,
   *  commit on timeout OR cancel on undo. We invalidate the list as
   *  soon as we stage so the row visually disappears, then a toast
   *  gives the user a 5-second take-back. */
  function stageDelete(n: AppNotification) {
    if (undoTimerRef.current !== null) {
      // A previous delete is already in flight — fire it immediately
      // before staging the new one. Two simultaneous undo-toasts would
      // be ambiguous and the user can only see one anyway.
      window.clearTimeout(undoTimerRef.current);
      if (pendingDelete) destroy.mutate(pendingDelete.id);
    }
    setPendingDelete(n);
    undoTimerRef.current = window.setTimeout(() => {
      destroy.mutate(n.id);
      setPendingDelete(null);
      undoTimerRef.current = null;
    }, UNDO_WINDOW_MS);
  }

  function undoStagedDelete() {
    if (undoTimerRef.current !== null) {
      window.clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    setPendingDelete(null);
  }

  function navigateTo(hash: string) {
    window.location.hash = `#${hash}`;
  }

  /** Filter rows by the optimistically-staged delete + active category
   *  so the user sees a snappy local update without waiting for the
   *  server round-trip. */
  const allRows = (list.data ?? []).filter(
    (n) => pendingDelete === null || n.id !== pendingDelete.id,
  );

  const counts: Record<NotificationCategory, number> = {
    security: 0,
    money: 0,
    opportunity: 0,
    system: 0,
  };
  for (const n of allRows) counts[n.category] += 1;

  const filteredRows =
    activeCategory === "all"
      ? allRows
      : allRows.filter((n) => n.category === activeCategory);

  const unreadCount = filteredRows.filter((n) => !n.is_read).length;

  /* ---- Empty state copy varies by filter ---- */
  let emptyCopy: string | null = null;
  if (filteredRows.length === 0 && !list.isLoading) {
    if (activeCategory !== "all") {
      emptyCopy = `No ${CATEGORY_CONFIG[activeCategory].label.toLowerCase()} alerts right now.`;
    } else if (onlyUnread) {
      emptyCopy = "All caught up — no unread alerts. ";
    } else {
      emptyCopy =
        "No notifications. Anomaly scans, goal milestones, and unusual-transaction alerts all land here.";
    }
  }

  if (list.isError) {
    return <PanelError title="Couldn't load notifications." error={list.error} onRetry={() => list.refetch()} />;
  }

  return (
    <div>
      <div className="flex justify-end mb-2">
        <SyncFreshnessChip
          syncedAt={list.dataUpdatedAt > 0 ? new Date(list.dataUpdatedAt).toISOString() : null}
          label="Last fetched"
        />
      </div>
      {/* Header bar — counts, filter chips, bulk actions */}
      <div className="bg-card border border-border rounded-md shadow-card mb-4 p-3 space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <h3 className="text-sm font-semibold text-text">
            {unreadCount} unread
            {filteredRows.length > 0 && ` of ${filteredRows.length}`}
          </h3>
          <label className="text-xs flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={onlyUnread}
              onChange={(e) => setOnlyUnread(e.target.checked)}
            />
            <span className="text-text-muted">Only unread</span>
          </label>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => readAll.mutate()}
              disabled={readAll.isPending || unreadCount === 0}
              className="px-3 py-1.5 text-xs font-semibold rounded border border-border hover:border-brand hover:text-brand disabled:opacity-50"
            >
              Mark all read
            </button>
            <button
              onClick={() => {
                if (
                  confirm("Delete every notification you've already read?")
                ) {
                  clearRead.mutate();
                }
              }}
              disabled={
                clearRead.isPending ||
                allRows.every((n) => !n.is_read) ||
                allRows.length === 0
              }
              className="px-3 py-1.5 text-xs font-semibold rounded border border-border hover:border-outflow hover:text-outflow disabled:opacity-50"
              title="Delete every notification you've already read"
            >
              Clear read
            </button>
          </div>
        </div>
        {/* Category filter chips. "All" shows everything; each category
            chip shows its bucket count so you can see at a glance which
            bucket has the most alerts. */}
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setActiveCategory("all")}
            className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
              activeCategory === "all"
                ? "border-brand text-brand-navy bg-brand/5"
                : "border-border text-text-muted hover:border-text-muted"
            }`}
          >
            All ({allRows.length})
          </button>
          {CATEGORY_ORDER.map((cat) => {
            const cfg = CATEGORY_CONFIG[cat];
            const n = counts[cat];
            const active = activeCategory === cat;
            return (
              <button
                key={cat}
                onClick={() => setActiveCategory(cat)}
                disabled={n === 0 && activeCategory !== cat}
                className={`px-2.5 py-1 text-xs rounded-full border inline-flex items-center gap-1 transition-colors ${
                  active
                    ? `${cfg.chipBg} ${cfg.chipText} border-transparent font-semibold`
                    : "border-border text-text-muted hover:border-text-muted disabled:opacity-40 disabled:hover:border-border"
                }`}
              >
                <CategoryIcon category={cat} />
                {cfg.label} ({n})
              </button>
            );
          })}
        </div>
      </div>

      {/* List */}
      {list.isLoading && <SkeletonRows count={6} />}
      {!list.isLoading && emptyCopy && (
        <div className="bg-card border border-border rounded-md shadow-card p-6 text-center text-sm text-text-muted">
          {emptyCopy}
        </div>
      )}
      {!list.isLoading && filteredRows.length > 0 && (
        <div className="bg-card border border-border rounded-md shadow-card overflow-hidden">
          {filteredRows.map((n) => (
            <NotificationRow
              key={n.id}
              n={n}
              onRead={() => read.mutate(n.id)}
              onDelete={() => stageDelete(n)}
              onDrill={() => {
                if (n.link) navigateTo(n.link);
              }}
            />
          ))}
        </div>
      )}

      {/* Undo toast — only mounted while a delete is staged */}
      {pendingDelete && (
        <UndoToast
          message={`Deleted "${pendingDelete.title.slice(0, 50)}${
            pendingDelete.title.length > 50 ? "…" : ""
          }"`}
          onUndo={undoStagedDelete}
        />
      )}
    </div>
  );
}
