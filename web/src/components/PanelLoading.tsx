/**
 * Shared panel-level loading state.
 *
 * Standardizes the "we're fetching, hang tight" treatment so panels
 * stop inventing their own ad-hoc spinners and "Loading…" labels.
 * Use the `compact` variant inside dense layouts; the default fills
 * a panel-sized space so the layout doesn't pop when data arrives.
 */
interface PanelLoadingProps {
  /** Optional override for the message shown under the spinner. */
  label?: string;
  /** Compact variant (~py-3 instead of py-12) for inline use. */
  compact?: boolean;
}

export default function PanelLoading({
  label = "Loading…",
  compact = false,
}: PanelLoadingProps) {
  const padY = compact ? "py-3" : "py-12";
  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex flex-col items-center justify-center text-text-muted ${padY}`}
    >
      <div className="h-5 w-5 border-2 border-border border-t-brand rounded-full animate-spin mb-2" />
      <div className="text-xs">{label}</div>
    </div>
  );
}
