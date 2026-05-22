import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
export default function PanelLoading({ label = "Loading…", compact = false, }) {
    const padY = compact ? "py-3" : "py-12";
    return (_jsxs("div", { role: "status", "aria-live": "polite", className: `flex flex-col items-center justify-center text-text-muted ${padY}`, children: [_jsx("div", { className: "h-5 w-5 border-2 border-border border-t-brand rounded-full animate-spin mb-2" }), _jsx("div", { className: "text-xs", children: label })] }));
}
