import { Fragment as _Fragment, jsx as _jsx } from "react/jsx-runtime";
/**
 * Animated number that ticks from 0 to its final value over a short
 * duration. Used on hero stats so the page feels responsive when data
 * arrives instead of values snapping in instantly.
 *
 * Why a custom component instead of react-spring or framer-motion: this
 * is the only animation primitive we need — adding a 30 KB dep for one
 * use case isn't worth it. Easing here is a quintic ease-out which is
 * the standard "feels expensive" curve.
 *
 * Usage:
 *   <CountUp value={123456} format={fmtCents} />
 *   <CountUp value={4.55} format={(v) => `${v.toFixed(2)}%`} />
 */
import { useEffect, useRef, useState } from "react";
const _quinticEaseOut = (t) => 1 - Math.pow(1 - t, 5);
const _defaultFormat = (v) => Math.round(v).toLocaleString("en-US");
export default function CountUp({ value, format = _defaultFormat, duration = 800, }) {
    const [displayed, setDisplayed] = useState(value);
    const fromRef = useRef(value);
    const startRef = useRef(null);
    const rafRef = useRef(null);
    useEffect(() => {
        // Skip animation when the page first mounts and we already have a
        // value — the initial render uses `value` directly. We only animate
        // when the value CHANGES (e.g., a refetch returns updated numbers).
        if (fromRef.current === value)
            return;
        const from = fromRef.current;
        const to = value;
        startRef.current = null;
        const tick = (now) => {
            if (startRef.current === null)
                startRef.current = now;
            const elapsed = now - startRef.current;
            const t = Math.min(1, elapsed / duration);
            const eased = _quinticEaseOut(t);
            const v = from + (to - from) * eased;
            setDisplayed(v);
            if (t < 1) {
                rafRef.current = requestAnimationFrame(tick);
            }
            else {
                fromRef.current = to;
            }
        };
        rafRef.current = requestAnimationFrame(tick);
        return () => {
            if (rafRef.current !== null)
                cancelAnimationFrame(rafRef.current);
        };
    }, [value, duration]);
    return _jsx(_Fragment, { children: format(displayed) });
}
