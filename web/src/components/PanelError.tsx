/**
 * Shared panel-level error state.
 *
 * Used when a panel's primary query has failed. Surfaces a short
 * human-readable description, the underlying error string (truncated),
 * and a Retry button when an `onRetry` handler is provided.
 *
 * Designed to look distinct from a normal panel — soft red border,
 * not the sky-is-falling full-page error treatment — so the user
 * understands "this section is broken, the rest of the app is fine."
 */
interface PanelErrorProps {
  /** Headline. Default: "Something went wrong loading this section." */
  title?: string;
  /** Underlying error — string or Error. Renders truncated below the title. */
  error?: unknown;
  /** Click handler that re-runs the failing query. Renders the Retry button. */
  onRetry?: () => void;
  /** Compact variant — smaller padding for inline error inside a section. */
  compact?: boolean;
}

function errorString(err: unknown): string {
  if (!err) return "Unknown error.";
  if (err instanceof Error) return err.message || err.name || String(err);
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export default function PanelError({
  title = "Something went wrong loading this section.",
  error,
  onRetry,
  compact = false,
}: PanelErrorProps) {
  const padY = compact ? "py-4" : "py-8";
  const detail = errorString(error);
  const truncated = detail.length > 200 ? `${detail.slice(0, 200)}…` : detail;
  return (
    <div
      role="alert"
      className={`bg-card border border-outflow/30 rounded-md text-center px-4 ${padY}`}
    >
      <div className="text-2xl mb-2">⚠️</div>
      <div className="text-sm font-semibold text-text mb-1">{title}</div>
      {detail && (
        <div className="text-[11px] text-text-muted font-mono max-w-md mx-auto break-words">
          {truncated}
        </div>
      )}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-block mt-3 px-3 py-1.5 text-xs font-semibold text-white bg-brand rounded hover:bg-brand-navy"
        >
          Retry
        </button>
      )}
    </div>
  );
}
