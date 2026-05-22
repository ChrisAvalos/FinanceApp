/**
 * Animated number that ticks from a previous value to a new one over a
 * short duration. Used on hero stats so the page feels responsive when
 * data arrives instead of values snapping in instantly.
 *
 * Why a custom component instead of react-spring or framer-motion: this
 * is the only animation primitive we need — adding a 30 KB dep for one
 * use case isn't worth it. Easing here is a quintic ease-out which is
 * the standard "feels expensive" curve.
 *
 * Loading-state handling (Sprint 29 — Net Worth audit regression)
 * --------------------------------------------------------------
 * Callers often do ``value={data?.foo ?? 0}`` so the component never
 * sees ``undefined`` while React Query is fetching. That pattern caused
 * a real bug on the Net Worth panel: ASSETS would mount with value=0,
 * then once the API responded value would jump to its real number,
 * and CountUp would animate 0 → real. Mid-animation the displayed
 * value (e.g. $168.94) was nonsense — the accounts list directly
 * below was already showing the real numbers, creating a visible
 * mismatch the audit flagged as a math bug.
 *
 * Fix: accept ``value: number | null | undefined``. When the FIRST
 * concrete value arrives, snap to it without animation. Only animate
 * on subsequent transitions between two real values. Renders an
 * em-dash placeholder while value is null/undefined.
 *
 * Usage:
 *   <CountUp value={123456} format={fmtCents} />
 *   <CountUp value={summary.data?.assets_cents} format={fmtCents} />
 */
import { useEffect, useRef, useState } from "react";

interface CountUpProps {
  /** The target value. ``null`` / ``undefined`` while data is loading;
   *  the component renders an em-dash placeholder until the first
   *  concrete value arrives, then snaps to it without animation. */
  value: number | null | undefined;
  /** Formatter — gets the in-flight numeric value, returns the display
   *  string. Defaults to integer with thousands separators. */
  format?: (v: number) => string;
  /** Animation duration in ms. Default 800ms. */
  duration?: number;
  /** Placeholder shown while value is null/undefined. Default "—". */
  loadingPlaceholder?: string;
}

const _quinticEaseOut = (t: number): number => 1 - Math.pow(1 - t, 5);

const _defaultFormat = (v: number) =>
  Math.round(v).toLocaleString("en-US");

export default function CountUp({
  value,
  format = _defaultFormat,
  duration = 800,
  loadingPlaceholder = "—",
}: CountUpProps) {
  // ``displayed`` is what we actually render (formatted numerically).
  // ``fromRef`` tracks the most recent FULLY-LANDED value so we can
  // animate the next transition from it. It stays null until the
  // first real value arrives.
  const [displayed, setDisplayed] = useState<number | null>(
    value ?? null,
  );
  const fromRef = useRef<number | null>(value ?? null);
  const startRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    // No value yet → keep the placeholder; don't animate.
    if (value === null || value === undefined) {
      return;
    }
    // First real value after a null/undefined → snap to it.
    if (fromRef.current === null) {
      fromRef.current = value;
      setDisplayed(value);
      return;
    }
    // Same value as last animation landed on → nothing to do.
    if (fromRef.current === value) return;

    // Sprint 35 — respect prefers-reduced-motion. Users who've set
    // the OS-level motion preference get an instant value swap
    // instead of an animated tick. Important for vestibular-disorder
    // accessibility AND a small perf win for everyone else.
    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) {
      fromRef.current = value;
      setDisplayed(value);
      return;
    }

    const from = fromRef.current;
    const to = value;
    startRef.current = null;

    const tick = (now: number) => {
      if (startRef.current === null) startRef.current = now;
      const elapsed = now - startRef.current;
      const t = Math.min(1, elapsed / duration);
      const eased = _quinticEaseOut(t);
      const v = from + (to - from) * eased;
      setDisplayed(v);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = to;
      }
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [value, duration]);

  if (displayed === null) return <>{loadingPlaceholder}</>;
  return <>{format(displayed)}</>;
}
