import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Cmd+K / Ctrl+K command palette.
 *
 * Quick navigation to any panel without touching the sidebar. Open with
 * the keyboard shortcut, type a few letters, hit Enter.
 *
 * Behavior:
 *   - Cmd+K (Mac) or Ctrl+K (Win/Linux) opens the modal anywhere in the app
 *   - Esc closes
 *   - Up/Down arrows move selection
 *   - Enter navigates to the selected panel via window.location.hash
 *   - Click on any result also navigates
 *
 * Search is a simple subsequence-fuzzy match: typing "cre" matches
 * "Credit", "Recent", "Receipts" etc — the same logic VS Code's command
 * palette uses. We rank by match position so prefix hits ("Cre" → "Credit")
 * float to the top over mid-word hits ("cre" → "Receipts").
 *
 * Why we built this in-house instead of a dep: it's ~80 lines of focused
 * code, the deps in this space (cmdk, kbar) are 30-50KB minified and
 * carry their own state machines. We wanted Tailwind-styled, hash-routing,
 * no extra runtime — just keyboard + search.
 */
import { useEffect, useMemo, useRef, useState } from "react";
/**
 * Subsequence-fuzzy match. Returns a score (0 = no match, higher = better)
 * and the match positions for highlighting (not used here, kept for future
 * polish). The character at position 0 in the haystack scoring highest
 * means a prefix match wins over a mid-word match.
 */
function fuzzyScore(haystack, needle) {
    if (!needle)
        return 1; // empty query matches everything with low score
    const h = haystack.toLowerCase();
    const n = needle.toLowerCase();
    let hi = 0;
    let ni = 0;
    let score = 0;
    let lastMatchPos = -1;
    while (hi < h.length && ni < n.length) {
        if (h[hi] === n[ni]) {
            // Bonus for prefix match (start of haystack or after a space).
            if (hi === 0 || h[hi - 1] === " " || h[hi - 1] === "-")
                score += 10;
            // Bonus for consecutive matches.
            if (lastMatchPos === hi - 1)
                score += 5;
            score += 1;
            lastMatchPos = hi;
            ni += 1;
        }
        hi += 1;
    }
    // Only count it as a hit if every character of the needle matched.
    return ni === n.length ? score : 0;
}
export default function CommandPalette({ open, onClose, commands }) {
    const [query, setQuery] = useState("");
    const [selectedIdx, setSelectedIdx] = useState(0);
    const inputRef = useRef(null);
    const listRef = useRef(null);
    // Track the element that had focus before the modal opened so we can
    // restore it on close. Without this, screen-reader users get dumped
    // back at <body> after Esc.
    const previouslyFocusedRef = useRef(null);
    // Auto-focus the search box when the modal opens, and reset state.
    useEffect(() => {
        if (open) {
            previouslyFocusedRef.current = document.activeElement;
            setQuery("");
            setSelectedIdx(0);
            // Focus on next tick after the modal is in the DOM.
            requestAnimationFrame(() => inputRef.current?.focus());
        }
        else if (previouslyFocusedRef.current) {
            // Restore focus to the trigger (Search button or whatever else)
            // so keyboard users land somewhere familiar after closing.
            previouslyFocusedRef.current.focus();
            previouslyFocusedRef.current = null;
        }
    }, [open]);
    // Score and rank commands by the current query. Memoize so we don't
    // re-rank on every keystroke unnecessarily.
    const ranked = useMemo(() => {
        if (!query.trim()) {
            return commands;
        }
        const scored = [];
        for (const cmd of commands) {
            const haystack = `${cmd.label} ${cmd.keywords ?? ""} ${cmd.hint ?? ""}`;
            const s = fuzzyScore(haystack, query);
            if (s > 0)
                scored.push({ cmd, score: s });
        }
        scored.sort((a, b) => b.score - a.score);
        return scored.map((x) => x.cmd);
    }, [query, commands]);
    // Reset selection to the top when the query changes.
    useEffect(() => {
        setSelectedIdx(0);
    }, [query]);
    // Keep the selected row scrolled into view as the user arrows down.
    useEffect(() => {
        if (!open || !listRef.current)
            return;
        const child = listRef.current.querySelector(`[data-cmd-index="${selectedIdx}"]`);
        child?.scrollIntoView({ block: "nearest" });
    }, [open, selectedIdx]);
    function runAt(i) {
        const cmd = ranked[i];
        if (!cmd)
            return;
        if (cmd.onRun) {
            cmd.onRun();
        }
        else {
            // Default behavior: hash navigate to the command id.
            window.location.hash = `#${cmd.id}`;
        }
        onClose();
    }
    function handleKeyDown(e) {
        if (e.key === "Escape") {
            e.preventDefault();
            onClose();
        }
        else if (e.key === "ArrowDown") {
            e.preventDefault();
            setSelectedIdx((i) => Math.min(ranked.length - 1, i + 1));
        }
        else if (e.key === "ArrowUp") {
            e.preventDefault();
            setSelectedIdx((i) => Math.max(0, i - 1));
        }
        else if (e.key === "Enter") {
            e.preventDefault();
            runAt(selectedIdx);
        }
    }
    if (!open)
        return null;
    // Group ranked commands by their `group` property for visual hierarchy.
    // When the user is searching, the per-group ordering is the rank order;
    // when the query is empty, groups appear in their declared order.
    const grouped = [];
    const groupIndex = new Map();
    for (const cmd of ranked) {
        let i = groupIndex.get(cmd.group);
        if (i === undefined) {
            i = grouped.length;
            groupIndex.set(cmd.group, i);
            grouped.push({ group: cmd.group, items: [] });
        }
        grouped[i].items.push(cmd);
    }
    // Build a flat index → ranked-position map so we can highlight the
    // selected row even when grouped.
    const flatToCmd = ranked;
    return (_jsxs("div", { className: "fixed inset-0 z-50 flex items-start justify-center pt-[10vh] px-4", onClick: onClose, role: "dialog", "aria-modal": "true", "aria-label": "Command palette", children: [_jsx("div", { className: "absolute inset-0 bg-black/30 backdrop-blur-sm", "aria-hidden": "true" }), _jsxs("div", { className: "relative w-full max-w-xl bg-card rounded-lg shadow-xl border border-border overflow-hidden", onClick: (e) => e.stopPropagation(), children: [_jsx("div", { className: "border-b border-border", children: _jsx("input", { ref: inputRef, value: query, onChange: (e) => setQuery(e.target.value), onKeyDown: handleKeyDown, placeholder: "Search panels \u2014 type to filter, \u2191\u2193 to move, \u21B5 to open", className: "w-full px-4 py-3 text-sm bg-transparent border-0 outline-none placeholder:text-text-soft", "aria-label": "Search panels", 
                            // Tell assistive tech what list this input controls and which
                            // option is "active" right now so screen readers announce
                            // arrow-key changes without dumping the whole list.
                            role: "combobox", "aria-expanded": "true", "aria-controls": "cmdk-results", "aria-activedescendant": ranked[selectedIdx]
                                ? `cmdk-opt-${ranked[selectedIdx].id}`
                                : undefined }) }), _jsxs("div", { ref: listRef, id: "cmdk-results", role: "listbox", "aria-label": "Panel results", className: "max-h-[60vh] overflow-y-auto py-2", children: [flatToCmd.length === 0 && (_jsxs("div", { className: "px-4 py-8 text-center text-sm text-text-muted", role: "status", children: ["No matches for ", _jsx("span", { className: "font-mono", children: query })] })), grouped.map(({ group, items }, gi) => (_jsxs("div", { className: "mb-2 last:mb-0", children: [group && (_jsx("div", { className: "px-4 pt-2 pb-1 text-[10px] uppercase tracking-wide font-semibold text-text-soft", children: group })), items.map((cmd) => {
                                        const flatIdx = flatToCmd.indexOf(cmd);
                                        const isSelected = flatIdx === selectedIdx;
                                        return (_jsxs("button", { id: `cmdk-opt-${cmd.id}`, "data-cmd-index": flatIdx, role: "option", "aria-selected": isSelected, onClick: () => runAt(flatIdx), onMouseEnter: () => setSelectedIdx(flatIdx), className: `w-full flex items-center gap-3 px-4 py-2 text-left text-sm transition-colors ${isSelected ? "bg-brand text-white" : "hover:bg-hover text-text"}`, children: [cmd.icon && (_jsx("span", { className: "text-base shrink-0", "aria-hidden": "true", children: cmd.icon })), _jsx("span", { className: "font-medium truncate", children: cmd.label }), cmd.hint && (_jsx("span", { className: `text-xs truncate ml-auto ${isSelected ? "text-white/70" : "text-text-soft"}`, children: cmd.hint }))] }, cmd.id));
                                    })] }, `${group ?? "none"}-${gi}`)))] }), _jsxs("div", { className: "border-t border-border px-4 py-2 flex items-center gap-3 text-[11px] text-text-soft bg-slate-50/40", children: [_jsxs("span", { children: [_jsx("kbd", { className: "px-1.5 py-0.5 bg-card border border-border rounded text-[10px] font-mono", children: "\u2191\u2193" }), " ", "navigate"] }), _jsxs("span", { children: [_jsx("kbd", { className: "px-1.5 py-0.5 bg-card border border-border rounded text-[10px] font-mono", children: "\u21B5" }), " ", "open"] }), _jsxs("span", { children: [_jsx("kbd", { className: "px-1.5 py-0.5 bg-card border border-border rounded text-[10px] font-mono", children: "esc" }), " ", "close"] }), _jsxs("span", { className: "ml-auto", children: [flatToCmd.length, " ", flatToCmd.length === 1 ? "result" : "results"] })] })] })] }));
}
/** Hook that wires up the global Cmd+K / Ctrl+K opener. Owns the open
 *  state and exposes it for a CommandPalette caller. */
export function useCommandPalette() {
    const [open, setOpen] = useState(false);
    useEffect(() => {
        function onKeyDown(e) {
            // Cmd+K on Mac, Ctrl+K elsewhere. Match VS Code / Linear conventions.
            if (e.key === "k" && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
                e.preventDefault();
                setOpen((v) => !v);
            }
            if (e.key === "Escape" && open) {
                setOpen(false);
            }
        }
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [open]);
    return { open, setOpen };
}
