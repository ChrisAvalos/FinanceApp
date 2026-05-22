/**
 * MoMChip — Sprint H-4a.
 *
 * Compact "month vs 3-month average" delta pill, used on every
 * budget-category row + legend entry. Mirrors the Trends panel's
 * visual language so the same color = same meaning across panels.
 *
 * Color logic
 * -----------
 *   - >+15% over 3-mo avg → outflow red (you're spending more)
 *   - between -15% and +15% → muted gray ("normal")
 *   - <-15% under 3-mo avg → inflow green (you're spending less)
 *
 * Empty cases
 * -----------
 * If `avg` is 0 we can't compute a percent — render a neutral "new"
 * pill. If `current` is 0 + `avg` > 0 → "$0 vs avg $X" pill in green
 * (huge savings).
 */
import { fmtCents } from "../api/client";

export interface MoMChipProps {
  /** This month's spend in cents (positive). */
  current_cents: number;
  /** 3-month rolling avg spend in cents (positive). */
  avg_cents: number;
  /** Optional: hide when both are zero (saves visual space on no-spend rows). */
  hideWhenZero?: boolean;
}

export default function MoMChip({
  current_cents,
  avg_cents,
  hideWhenZero = true,
}: MoMChipProps) {
  if (hideWhenZero && current_cents === 0 && avg_cents === 0) return null;

  // No history → "new" pill.
  if (avg_cents === 0 && current_cents > 0) {
    return (
      <span
        className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-brand-light text-brand"
        title="No spending in this category in the prior 3 months — this is a new spending area."
      >
        new
      </span>
    );
  }

  // Spending dropped to zero vs a non-zero average — celebrate it.
  if (current_cents === 0 && avg_cents > 0) {
    return (
      <span
        className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-emerald-50 text-inflow"
        title={`No spending here this month. 3-month average was ${fmtCents(avg_cents)}/mo.`}
      >
        −100%
      </span>
    );
  }

  // Standard delta calculation.
  const delta = (current_cents - avg_cents) / avg_cents;
  const pct = Math.round(delta * 100);
  const abs = Math.abs(pct);

  let cls = "bg-gray-100 text-text-muted";
  let label = `${pct >= 0 ? "+" : ""}${pct}%`;
  if (delta > 0.15) {
    cls = "bg-red-50 text-outflow";
  } else if (delta < -0.15) {
    cls = "bg-emerald-50 text-inflow";
  }
  // Cap displayed magnitude at +999% so a $5/mo category that hit $1000
  // doesn't print "+19900%" and break the row layout.
  if (abs > 999) {
    label = pct > 0 ? "+999%" : "−999%";
  }

  // Wave 5 fix I — hover expansion. The chip itself stays compact for
  // row density, but on hover/focus we reveal a small adjacent line with
  // the raw $ → $ delta so users on devices with hover (desktop trackpads,
  // mice) don't have to read the tooltip. Mobile/touch falls back to the
  // title attribute as before.
  const dollarDelta = current_cents - avg_cents;
  const dollarDeltaStr = `${dollarDelta >= 0 ? "+" : "−"}${fmtCents(Math.abs(dollarDelta))}`;

  return (
    <span className="group inline-flex items-center gap-1 align-middle">
      <span
        className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider tabular-nums ${cls}`}
        title={`This month: ${fmtCents(current_cents)} · 3-month average: ${fmtCents(avg_cents)} · Delta: ${dollarDeltaStr}`}
        aria-label={`Spending ${pct >= 0 ? "up" : "down"} ${abs} percent versus 3-month average. This month ${fmtCents(current_cents)}, average ${fmtCents(avg_cents)}, delta ${dollarDeltaStr}.`}
      >
        {label}
      </span>
      <span
        className="hidden group-hover:inline text-[10px] text-text-muted tabular-nums whitespace-nowrap"
        aria-hidden="true"
      >
        {fmtCents(avg_cents)} → {fmtCents(current_cents)} ({dollarDeltaStr})
      </span>
    </span>
  );
}
