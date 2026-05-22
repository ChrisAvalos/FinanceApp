/**
 * Shared empty-state component used across panels with no data.
 *
 * Standardizes the visual + copy + CTA pattern so panels stop
 * inventing their own. Three variants:
 *
 *   - default: title + body + optional emoji + optional primary CTA.
 *   - hint: smaller, secondary-action style. Use inside a card section
 *     like "no recurring purchases yet" rather than the whole panel.
 *   - waiting: for "we're computing this — check back" cases (rare;
 *     prefer the spinner pattern when actually loading).
 *
 * The CTA props accept either an href (renders as <a>) or onClick
 * (renders as <button>) — pick whichever matches the panel's flow.
 */
import type { ReactNode } from "react";

type EmptyStateVariant = "default" | "hint" | "waiting";

interface EmptyStateProps {
  /** Big icon shown above the title. Emoji works fine. Defaults to nothing. */
  emoji?: string;
  /** Headline. Required. */
  title: string;
  /** Optional supporting copy. Plain string or rich nodes. */
  body?: ReactNode;
  /** Primary CTA button label. Pair with ctaHref OR ctaOnClick. */
  ctaLabel?: string;
  /** Pure-link target (rendered as <a>). Mutually exclusive with ctaOnClick. */
  ctaHref?: string;
  /** Click handler (rendered as <button>). Mutually exclusive with ctaHref. */
  ctaOnClick?: () => void;
  /** Layout variant. Default is "default". */
  variant?: EmptyStateVariant;
}

export default function EmptyState({
  emoji,
  title,
  body,
  ctaLabel,
  ctaHref,
  ctaOnClick,
  variant = "default",
}: EmptyStateProps) {
  const padding =
    variant === "hint" ? "p-4" : variant === "waiting" ? "p-12" : "p-8";
  const titleSize =
    variant === "hint"
      ? "text-xs font-semibold"
      : "text-sm font-semibold";

  const cta = ctaLabel && (ctaHref || ctaOnClick) ? (
    ctaHref ? (
      <a
        href={ctaHref}
        className="inline-block mt-4 px-3 py-1.5 text-xs font-semibold text-white bg-brand rounded hover:bg-brand-navy"
      >
        {ctaLabel}
      </a>
    ) : (
      <button
        onClick={ctaOnClick}
        className="inline-block mt-4 px-3 py-1.5 text-xs font-semibold text-white bg-brand rounded hover:bg-brand-navy"
      >
        {ctaLabel}
      </button>
    )
  ) : null;

  return (
    <div
      className={`bg-card border border-border rounded-md shadow-card text-center ${padding}`}
    >
      {emoji && <div className="text-3xl mb-3">{emoji}</div>}
      <div className={`${titleSize} text-text mb-1`}>{title}</div>
      {body && (
        <div className="text-xs text-text-muted max-w-md mx-auto leading-snug">
          {body}
        </div>
      )}
      {cta}
    </div>
  );
}
