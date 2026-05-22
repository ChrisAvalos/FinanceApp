/**
 * DeleteWithConfirm — Sprint 38, the click-twice-to-delete button.
 *
 * Why this exists
 * ---------------
 * `window.confirm()` was flagged in the button audit as a blocking
 * UX wart — it freezes the browser, breaks automated walkthroughs,
 * and looks dated. Row-level deletes already use the
 * useUndoableDelete pattern (5s window with an Undo toast). This
 * component covers the SINGLE-SHOT detail-panel case (e.g. delete
 * this receipt, delete this coupon) where staging the row and
 * filtering it out of a list doesn't apply.
 *
 * Behavior
 * --------
 * - First click: button label flips to "Click again to delete"
 *   (red) and stays in that state for ``windowMs`` (default 4s).
 * - Second click within the window: fires ``onConfirm``.
 * - Click outside or wait: reverts to the resting label silently.
 *
 * Why not toast-based: the parent often unmounts on success (e.g.
 * the detail modal closes), and a toast that outlives the parent
 * would feel orphaned. The two-click pattern is self-contained
 * inside the button and provides similar reassurance without a
 * blocking dialog.
 */
import { useEffect, useRef, useState } from "react";

interface DeleteWithConfirmProps {
  /** Accessible name / fallback aria-label. Not visible. */
  label?: string;
  /** Fires when the user confirms (second click). */
  onConfirm: () => void;
  /** Resting label. Defaults to "Delete". */
  restingText?: string;
  /** Confirming label. Defaults to "Click again to delete". */
  confirmingText?: string;
  /** How long the confirming state lasts before reverting (ms). */
  windowMs?: number;
  /** Optional className override for the resting state. */
  className?: string;
  /** Disabled flag (e.g. mutation in-flight). */
  disabled?: boolean;
}

export default function DeleteWithConfirm({
  label,
  onConfirm,
  restingText = "Delete",
  confirmingText = "Click again to delete",
  windowMs = 4000,
  className,
  disabled,
}: DeleteWithConfirmProps) {
  const [armed, setArmed] = useState(false);
  const timerRef = useRef<number | null>(null);

  // Clear any pending timer if the component unmounts mid-window.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  function handleClick() {
    if (disabled) return;
    if (!armed) {
      setArmed(true);
      timerRef.current = window.setTimeout(() => {
        setArmed(false);
        timerRef.current = null;
      }, windowMs);
      return;
    }
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setArmed(false);
    onConfirm();
  }

  const baseCls =
    className ??
    "px-3 py-1.5 text-xs text-text-muted hover:text-outflow rounded";
  const armedCls =
    "px-3 py-1.5 text-xs font-semibold text-white bg-outflow rounded animate-pulse";

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={label ?? restingText}
      disabled={disabled}
      className={armed ? armedCls : baseCls}
    >
      {armed ? confirmingText : restingText}
    </button>
  );
}
