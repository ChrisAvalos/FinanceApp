/**
 * useAnimatedProjection — Wave G, Sprint G-9.
 *
 * Interpolates between two ProjectionPoint[] arrays over a configurable
 * duration so chart updates feel smooth, not snap-cut.
 *
 * Design notes
 * ------------
 * - Cubic-ease interpolation (ease-out): the animation starts fast and
 *   settles slowly, which reads as "responsive" + "polished" rather
 *   than mechanical. Pure JS — no animation library dep.
 * - Per-field linear interpolation: each ProjectionPoint has 4
 *   balance values + net + per-month flow. We lerp each independently
 *   over the same timeline.
 * - Cancels the running RAF if a new target arrives mid-animation —
 *   the next animation picks up from the CURRENT interpolated state,
 *   not from the last-completed target. That prevents the visible
 *   "rubber band" when a slider drag fires many target changes
 *   in quick succession.
 * - `prefers-reduced-motion`: respected. When the OS flag is on we
 *   skip the animation and snap-update — accessibility before polish.
 *
 * Returns the current (in-progress or settled) projection array which
 * the chart renders. Callers don't need to know whether they're seeing
 * the final state or an interpolation frame — the value is always a
 * valid ProjectionPoint[] of the right length.
 */
import { useEffect, useRef, useState } from "react";
import type { ProjectionPoint } from "../api/client";

const DEFAULT_DURATION_MS = 280;

/** Cubic ease-out — `1 - (1 - t)^3`. Snappy start, gentle settle. */
function _easeOutCubic(t: number): number {
  const c = 1 - t;
  return 1 - c * c * c;
}

function _lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function _interpolatePoints(
  start: ProjectionPoint[],
  end: ProjectionPoint[],
  t: number,
): ProjectionPoint[] {
  // If the arrays differ in length (e.g. a different `months` request
  // mid-animation), bail to end — interpolating across length changes
  // produces nonsense.
  if (start.length !== end.length) return end;
  const out: ProjectionPoint[] = new Array(end.length);
  for (let i = 0; i < end.length; i++) {
    const s = start[i];
    const e = end[i];
    out[i] = {
      month_index: e.month_index, // x-axis stays stable; never interpolate
      checking_cents: Math.round(_lerp(s.checking_cents, e.checking_cents, t)),
      savings_cents: Math.round(_lerp(s.savings_cents, e.savings_cents, t)),
      investment_cents: Math.round(_lerp(s.investment_cents, e.investment_cents, t)),
      net_cents: Math.round(_lerp(s.net_cents, e.net_cents, t)),
      income_cents: Math.round(_lerp(s.income_cents, e.income_cents, t)),
      outflow_cents: Math.round(_lerp(s.outflow_cents, e.outflow_cents, t)),
    };
  }
  return out;
}

function _prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

export function useAnimatedProjection(
  target: ProjectionPoint[] | undefined | null,
  durationMs: number = DEFAULT_DURATION_MS,
): ProjectionPoint[] {
  // Current rendered state. Starts equal to target; updates either
  // instantly (reduced-motion) or via RAF.
  const [current, setCurrent] = useState<ProjectionPoint[]>(target ?? []);
  // Track the in-flight animation's RAF id + the snapshot we
  // interpolate FROM (the live current at the moment the target
  // changed — not the previous target).
  const rafRef = useRef<number | null>(null);
  const startRef = useRef<ProjectionPoint[] | null>(null);
  const targetRef = useRef<ProjectionPoint[] | null>(null);
  // Keep a ref to the latest `current` so animation frames can
  // read it without re-creating the RAF closure on every render.
  const currentRef = useRef<ProjectionPoint[]>(current);
  useEffect(() => {
    currentRef.current = current;
  }, [current]);

  useEffect(() => {
    if (!target) return;
    targetRef.current = target;
    // First render — snap.
    if (current.length === 0) {
      setCurrent(target);
      return;
    }
    // Different length (window change) — snap.
    if (current.length !== target.length) {
      setCurrent(target);
      return;
    }
    // Already at target — no work needed.
    let identical = true;
    for (let i = 0; i < target.length; i++) {
      if (
        target[i].net_cents !== current[i].net_cents ||
        target[i].savings_cents !== current[i].savings_cents ||
        target[i].checking_cents !== current[i].checking_cents ||
        target[i].investment_cents !== current[i].investment_cents
      ) {
        identical = false;
        break;
      }
    }
    if (identical) return;
    // Reduced motion — snap and bail.
    if (_prefersReducedMotion()) {
      setCurrent(target);
      return;
    }
    // Cancel any in-flight animation; start a fresh one FROM the
    // current (possibly mid-interpolation) state TO the new target.
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    startRef.current = currentRef.current;
    const t0 = performance.now();
    const tick = (now: number) => {
      const linearT = Math.min(1, (now - t0) / durationMs);
      const easedT = _easeOutCubic(linearT);
      const startSnap = startRef.current!;
      const targetSnap = targetRef.current!;
      const interp = _interpolatePoints(startSnap, targetSnap, easedT);
      setCurrent(interp);
      if (linearT < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        rafRef.current = null;
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, durationMs]); // intentionally omit `current` — we read it via ref

  return current;
}
