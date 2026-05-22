import { jsx as _jsx } from "react/jsx-runtime";
import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import "./index.css";
/* Defaults tuned for personal-finance data:
 *   staleTime 60s — balances, scores, offers, claims don't move every
 *     few seconds. 60s prevents back-and-forth panel navigation from
 *     refetching the same payload for no reason.
 *   refetchOnWindowFocus false — switching to another browser tab and
 *     back was triggering a refetch storm across every mounted query;
 *     for finance data the value is near zero (the user's bank API
 *     hasn't pushed updates in those 5 seconds), and the cost is a
 *     visible spinner reset on every Cmd+Tab. The Sync buttons on
 *     individual panels and the auto-refresh scheduler cover the
 *     "I want truly fresh numbers" case.
 *   refetchOnReconnect true (default) — left on; when network blips
 *     it's correct to refresh.
 *   gcTime 10 min (default 5) — keeps cached payloads in memory long
 *     enough that Cmd+K palette → panel jump is instant when the user
 *     hops between four or five panels in a session.
 *
 * Per-panel queries can override any of these — see ConnectionsPanel
 * for the 5s staleTime on Plaid items (where freshness matters more
 * because the user just clicked Sync). */
const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: 60_000,
            gcTime: 10 * 60 * 1000,
            refetchOnWindowFocus: false,
        },
    },
});
ReactDOM.createRoot(document.getElementById("root")).render(_jsx(React.StrictMode, { children: _jsx(QueryClientProvider, { client: queryClient, children: _jsx(App, {}) }) }));
