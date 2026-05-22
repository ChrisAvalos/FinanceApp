/**
 * Shared skeleton primitives for layout-shaped loading states.
 *
 * Why these exist
 * ---------------
 * A "Loading…" string is the worst possible loading UX — it forces a
 * layout shift the moment data arrives and gives the user nothing to
 * read. Real apps render gray-shimmer blocks roughly the shape of the
 * eventual content, so the page feels stable and the user has
 * something to look at.
 *
 * Three primitives:
 *
 *   <SkelBlock w h />         — solid rounded shimmer block
 *   <SkelLine width />        — single text-line shimmer
 *   <SkelStat />              — pre-built hero-stat card skeleton
 *   <SkelHeroRow count />     — a row of N hero stats (covers Overview /
 *                               NetWorth / FIRE / MoT layouts)
 *   <SkelTableRow cols />     — N-column table row
 *
 * The shimmer animation is CSS-only (Tailwind's animate-pulse) so
 * there's no runtime cost. Cards use bg-slate-200 / bg-card-foreground
 * (depending on theme) so they read as "this will be filled" rather
 * than "this is empty."
 */
import type { CSSProperties } from "react";

interface SkelBlockProps {
  /** Tailwind class string for explicit width — e.g. "w-32". */
  w?: string;
  /** Tailwind class string for explicit height — e.g. "h-6". */
  h?: string;
  /** Tailwind class string for additional styling (rounding, etc.). */
  className?: string;
  /** Inline style for things Tailwind can't express (rare). */
  style?: CSSProperties;
}

export function SkelBlock({ w = "w-full", h = "h-4", className = "", style }: SkelBlockProps) {
  return (
    <div
      className={`bg-slate-200 rounded animate-pulse ${w} ${h} ${className}`}
      style={style}
    />
  );
}

/** Text-line shimmer; default width 80% of parent. */
export function SkelLine({
  width = "80%",
  height = "h-3",
  className = "",
}: {
  width?: string;
  height?: string;
  className?: string;
}) {
  return (
    <div
      className={`bg-slate-200 rounded animate-pulse ${height} ${className}`}
      style={{ width }}
    />
  );
}

/** A pre-shaped hero-stat card matching the panels' standard layout. */
export function SkelStat() {
  return (
    <div className="bg-card border border-border rounded-md p-4 shadow-card">
      <SkelLine width="40%" height="h-2" className="mb-3" />
      <SkelLine width="60%" height="h-7" className="mb-2" />
      <SkelLine width="50%" height="h-2" />
    </div>
  );
}

/** Row of N hero stat cards (default 4) — drop-in for the standard
 *  4-card hero layout used on Overview / NetWorth / FIRE / MoT / etc. */
export function SkelHeroRow({ count = 4 }: { count?: number }) {
  return (
    <div className={`grid grid-cols-2 md:grid-cols-${Math.min(count, 4)} gap-4 mb-5`}>
      {Array.from({ length: count }).map((_, i) => (
        <SkelStat key={i} />
      ))}
    </div>
  );
}

/** A single row in a transaction-style table — defaults to 5 cols
 *  matching the main txns table (date / description / category /
 *  amount / source). */
export function SkelTableRow({
  cols = 5,
}: {
  cols?: number;
}) {
  // Variation in widths so the placeholder doesn't look mechanical.
  const widths = ["20%", "60%", "30%", "20%", "15%"];
  return (
    <tr className="border-b border-border last:border-0">
      {Array.from({ length: cols }).map((_, i) => (
        <td key={i} className="px-4 py-3">
          <SkelLine width={widths[i % widths.length]} height="h-3" />
        </td>
      ))}
    </tr>
  );
}

/** Shaped-like-a-list skeleton (e.g., for Money found cohort rows or
 *  Today's moves queue). Defaults to 5 rows. */
export function SkelListRows({ count = 5 }: { count?: number }) {
  return (
    <div className="bg-card border border-border rounded-md shadow-card divide-y divide-border">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3">
          <SkelBlock w="w-8" h="h-8" className="rounded-full" />
          <div className="flex-1 space-y-1.5">
            <SkelLine width="60%" height="h-3" />
            <SkelLine width="40%" height="h-2" />
          </div>
          <SkelLine width="80px" height="h-3" />
        </div>
      ))}
    </div>
  );
}
