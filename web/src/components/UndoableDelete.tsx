/**
 * Reusable two-stage delete + undo-toast pattern.
 *
 * Why this exists:
 *   The button audit flagged native `window.confirm()` dialogs as a UX
 *   wart — they're jarring on a polished web app, they block the
 *   browser, and they break automated browser walking. NotificationsPanel
 *   already had a nicer pattern (stage delete → 5s toast → commit on
 *   timeout, or undo on click). This module extracts that pattern so
 *   any panel can use it with one hook + one component.
 *
 * Usage:
 *   const undo = useUndoableDelete<Receipt>({
 *     commit: (id) => destroy.mutate(id),
 *     describe: (r) => `Deleted "${r.description}"`,
 *   });
 *
 *   // In the row's delete button:
 *   <button onClick={() => undo.stage(receipt)}>Del</button>
 *
 *   // In the list, hide the staged item:
 *   const visible = receipts.filter(r => undo.pending?.id !== r.id);
 *
 *   // At the bottom of the panel:
 *   {undo.pending && <UndoToast message={undo.message} onUndo={undo.cancel} />}
 */
import { useEffect, useRef, useState } from "react";

export const UNDO_WINDOW_MS = 5000;

interface UseUndoableDeleteOptions<T> {
  /** Called once the undo window expires. Receives the staged item's id. */
  commit: (id: T extends { id: infer K } ? K : never) => void;
  /** Human-readable label for the toast. Receives the staged item. */
  describe: (item: T) => string;
  /** Override the 5s default if needed. */
  windowMs?: number;
}

export interface UndoableDeleteState<T> {
  /** The currently-staged item, if any. Filter your list by this. */
  pending: T | null;
  /** The toast label for `pending` — pre-computed via `describe`. */
  message: string;
  /** Stage `item` for delete; show toast; commit after windowMs. */
  stage: (item: T) => void;
  /** Cancel the staged delete (the Undo button's onClick). */
  cancel: () => void;
  /** True while a delete is staged but not yet committed. */
  isPending: boolean;
}

export function useUndoableDelete<T extends { id: number | string }>(
  opts: UseUndoableDeleteOptions<T>,
): UndoableDeleteState<T> {
  const [pending, setPending] = useState<T | null>(null);
  const timerRef = useRef<number | null>(null);
  const windowMs = opts.windowMs ?? UNDO_WINDOW_MS;

  // Clear the timer if the panel unmounts mid-stage. Without this the
  // queued mutation would fire on a dead component and trigger stale-
  // cache warnings (or worse, hit an unmounted-onSuccess handler).
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  function stage(item: T) {
    if (timerRef.current !== null) {
      // A previous delete is mid-window. Commit it now (the user has
      // started a new action; their previous decision is implicitly
      // confirmed) before staging the new one. Two simultaneous toasts
      // would race and only one is visible anyway.
      window.clearTimeout(timerRef.current);
      if (pending) opts.commit(pending.id as never);
    }
    setPending(item);
    timerRef.current = window.setTimeout(() => {
      opts.commit(item.id as never);
      setPending(null);
      timerRef.current = null;
    }, windowMs);
  }

  function cancel() {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setPending(null);
  }

  return {
    pending,
    message: pending ? opts.describe(pending) : "",
    stage,
    cancel,
    isPending: pending !== null,
  };
}

/* ------------------------------------------------------------------ */
/*  UndoToast — fixed-bottom-center toast with an Undo button         */
/* ------------------------------------------------------------------ */

interface UndoToastProps {
  message: string;
  onUndo: () => void;
}

export function UndoToast({ message, onUndo }: UndoToastProps) {
  return (
    <div
      className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-text text-white text-xs rounded-md shadow-lg px-4 py-2 flex items-center gap-3"
      role="status"
      aria-live="polite"
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
