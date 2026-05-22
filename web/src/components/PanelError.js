import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
function errorString(err) {
    if (!err)
        return "Unknown error.";
    if (err instanceof Error)
        return err.message || err.name || String(err);
    if (typeof err === "string")
        return err;
    try {
        return JSON.stringify(err);
    }
    catch {
        return String(err);
    }
}
export default function PanelError({ title = "Something went wrong loading this section.", error, onRetry, compact = false, }) {
    const padY = compact ? "py-4" : "py-8";
    const detail = errorString(error);
    const truncated = detail.length > 200 ? `${detail.slice(0, 200)}…` : detail;
    return (_jsxs("div", { role: "alert", className: `bg-card border border-outflow/30 rounded-md text-center px-4 ${padY}`, children: [_jsx("div", { className: "text-2xl mb-2", children: "\u26A0\uFE0F" }), _jsx("div", { className: "text-sm font-semibold text-text mb-1", children: title }), detail && (_jsx("div", { className: "text-[11px] text-text-muted font-mono max-w-md mx-auto break-words", children: truncated })), onRetry && (_jsx("button", { type: "button", onClick: onRetry, className: "inline-block mt-3 px-3 py-1.5 text-xs font-semibold text-white bg-brand rounded hover:bg-brand-navy", children: "Retry" }))] }));
}
