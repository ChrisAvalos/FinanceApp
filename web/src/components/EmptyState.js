import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
export default function EmptyState({ emoji, title, body, ctaLabel, ctaHref, ctaOnClick, variant = "default", }) {
    const padding = variant === "hint" ? "p-4" : variant === "waiting" ? "p-12" : "p-8";
    const titleSize = variant === "hint"
        ? "text-xs font-semibold"
        : "text-sm font-semibold";
    const cta = ctaLabel && (ctaHref || ctaOnClick) ? (ctaHref ? (_jsx("a", { href: ctaHref, className: "inline-block mt-4 px-3 py-1.5 text-xs font-semibold text-white bg-brand rounded hover:bg-brand-navy", children: ctaLabel })) : (_jsx("button", { onClick: ctaOnClick, className: "inline-block mt-4 px-3 py-1.5 text-xs font-semibold text-white bg-brand rounded hover:bg-brand-navy", children: ctaLabel }))) : null;
    return (_jsxs("div", { className: `bg-card border border-border rounded-md shadow-card text-center ${padding}`, children: [emoji && _jsx("div", { className: "text-3xl mb-3", children: emoji }), _jsx("div", { className: `${titleSize} text-text mb-1`, children: title }), body && (_jsx("div", { className: "text-xs text-text-muted max-w-md mx-auto leading-snug", children: body })), cta] }));
}
