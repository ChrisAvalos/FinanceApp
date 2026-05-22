/**
 * Thin API client. Types are generated from the backend's OpenAPI spec via
 * `npm run gen:types` (produces src/api/types.ts). Until then we hand-roll
 * the few shapes we need.
 */
async function json(res) {
    if (!res.ok)
        throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
}
export const api = {
    listTransactions: (params = {}) => {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(params))
            if (v !== undefined)
                qs.set(k, String(v));
        return fetch(`/api/transactions?${qs}`).then((json));
    },
    listCategories: () => fetch("/api/categories").then((json)),
    summary: () => fetch("/api/stats/summary").then((json)),
    runCategorization: () => fetch("/api/rules/run", { method: "POST" }).then((json)),
    /** Bulk-categorize triage list: top uncategorized merchant patterns
     *  with a sample row + outflow size + txn count. Backs the wizard
     *  on the Transactions panel that lets the user tag the long tail
     *  in one pass instead of row-by-row. */
    uncategorizedGroups: (params = {}) => {
        const qs = new URLSearchParams();
        if (params.min_txn_count != null)
            qs.set("min_txn_count", String(params.min_txn_count));
        if (params.limit != null)
            qs.set("limit", String(params.limit));
        const tail = qs.toString() ? `?${qs}` : "";
        return fetch(`/api/rules/uncategorized-groups${tail}`).then((json));
    },
    /** Bulk-create rules from N (pattern, category_id) pairs. Returns a
     *  summary: rules_created, rules_updated, txns_tagged after re-run. */
    bulkRulesFromPatterns: (items) => fetch("/api/rules/bulk-from-patterns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
    }).then((json)),
    /** Inline "categorize this" — applies the picked category to the
     *  originating transaction AND creates a non-seed rule that will catch
     *  the same merchant on every future row. Returns the rule + the count
     *  of rows that now match. */
    ruleFromTransaction: (body) => fetch("/api/rules/from-transaction", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    }).then((json)),
    /** Fire every detector + scraper in sequence — the "lights everything up"
     *  button. Returns per-task status so the UI can render a progress list. */
    primeRun: () => fetch("/api/prime/run", { method: "POST" }).then((json)),
    listSubscriptions: (params = {}) => {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(params))
            if (v !== undefined)
                qs.set(k, String(v));
        return fetch(`/api/subscriptions?${qs}`).then((json));
    },
    detectSubscriptions: () => fetch("/api/subscriptions/detect", { method: "POST" }).then((json)),
    subscriptionStats: (confirmed_only = false) => fetch(`/api/subscriptions/stats?confirmed_only=${confirmed_only}`).then((json)),
    listSubscriptionPriceChanges: () => fetch("/api/subscriptions/price-changes").then((json)),
    confirmSubscription: (id) => fetch(`/api/subscriptions/${id}/confirm`, { method: "POST" }).then((json)),
    dismissSubscription: (id) => fetch(`/api/subscriptions/${id}/dismiss`, { method: "POST" }).then((json)),
    setSubscriptionStatus: (id, status) => fetch(`/api/subscriptions/${id}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
    }).then((json)),
    setSubscriptionType: (id, subscription_type) => fetch(`/api/subscriptions/${id}/type`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription_type }),
    }).then((json)),
    applySubscriptionPromos: () => fetch("/api/subscriptions/apply-promos", { method: "POST" }).then((json)),
    deleteSubscription: (id) => fetch(`/api/subscriptions/${id}`, { method: "DELETE" }).then(() => undefined),
    // Plaid
    plaidStatus: () => fetch("/api/plaid/status").then((json)),
    plaidListItems: () => fetch("/api/plaid/items").then((json)),
    plaidCreateLinkToken: () => fetch("/api/plaid/link-token", { method: "POST" }).then((json)),
    plaidExchange: (public_token) => fetch("/api/plaid/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ public_token }),
    }).then((json)),
    plaidSyncItem: (item_id) => fetch(`/api/plaid/sync/${item_id}`, { method: "POST" }).then((json)),
    plaidSyncAll: () => fetch("/api/plaid/sync-all", { method: "POST" }).then((json)),
    plaidDeleteItem: (item_id) => fetch(`/api/plaid/items/${item_id}`, { method: "DELETE" }).then((res) => {
        if (!res.ok)
            throw new Error(`${res.status} ${res.statusText}`);
    }),
    plaidSchedule: () => fetch("/api/plaid/schedule").then((json)),
    plaidSandboxPublicToken: (institution_id = "ins_109508") => fetch("/api/plaid/sandbox/public-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ institution_id }),
    }).then((json)),
    // Gmail
    gmailStatus: () => fetch("/api/gmail/status").then((json)),
    gmailAuthorize: () => fetch("/api/gmail/authorize", { method: "POST" }).then((json)),
    gmailSync: (opts = {}) => fetch("/api/gmail/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(opts),
    }).then((json)),
    gmailListMessages: (params = {}) => {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(params))
            if (v !== undefined)
                qs.set(k, String(v));
        return fetch(`/api/gmail/messages?${qs}`).then((json));
    },
    gmailListParsers: () => fetch("/api/gmail/parsers").then((json)),
    // Accounts
    listAccounts: () => fetch("/api/accounts").then((json)),
    // Budgets
    listBudgets: (month_start) => {
        const qs = month_start ? `?month_start=${month_start}` : "";
        return fetch(`/api/budgets${qs}`).then((json));
    },
    upsertBudget: (payload) => fetch("/api/budgets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    }).then((json)),
    deleteBudget: (id) => fetch(`/api/budgets/${id}`, { method: "DELETE" }).then((res) => {
        if (!res.ok)
            throw new Error(`${res.status} ${res.statusText}`);
    }),
    budgetRollup: (month_start) => fetch(`/api/budgets/rollup?month_start=${month_start}`).then((json)),
    budgetCopyFromPrior: (payload) => fetch("/api/budgets/copy-from-prior", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    }).then((json)),
    budgetFillFromAverage: (payload) => fetch("/api/budgets/fill-from-average", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    }).then((json)),
    // Month-over-month
    monthOverMonth: (months = 6) => fetch(`/api/stats/month-over-month?months=${months}`).then((json)),
    // Credit
    listCreditScores: (limit = 50) => fetch(`/api/credit/scores?limit=${limit}`).then((json)),
    addCreditScore: (payload) => fetch("/api/credit/scores", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    }).then((json)),
    deleteCreditScore: (id) => fetch(`/api/credit/scores/${id}`, { method: "DELETE" }).then((res) => {
        if (!res.ok)
            throw new Error(`${res.status} ${res.statusText}`);
    }),
    creditUtilization: () => fetch("/api/credit/utilization").then((json)),
    creditOpportunities: () => fetch("/api/credit/opportunities").then((json)),
    // Legal claims
    listLegalClaims: (params = {}) => {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(params)) {
            if (v !== undefined)
                qs.set(k, String(v));
        }
        const suffix = qs.toString() ? `?${qs}` : "";
        return fetch(`/api/legal-claims${suffix}`).then((json));
    },
    createLegalClaim: (payload) => fetch("/api/legal-claims", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    }).then((json)),
    updateLegalClaim: (id, payload) => fetch(`/api/legal-claims/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    }).then((json)),
    deleteLegalClaim: (id) => fetch(`/api/legal-claims/${id}`, { method: "DELETE" }).then((res) => {
        if (!res.ok)
            throw new Error(`${res.status} ${res.statusText}`);
    }),
    legalClaimStats: () => fetch("/api/legal-claims/stats").then((json)),
    // Trigger an on-demand scrape across all configured sources.
    scrapeLegalClaims: () => fetch("/api/legal-claims/scrape", { method: "POST" }).then((json)),
    // Goals (Phase D)
    listGoals: (params = {}) => {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(params))
            if (v !== undefined)
                qs.set(k, String(v));
        const suffix = qs.toString() ? `?${qs}` : "";
        return fetch(`/api/goals${suffix}`).then((json));
    },
    getGoal: (id) => fetch(`/api/goals/${id}`).then((json)),
    createGoal: (payload) => fetch("/api/goals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    }).then((json)),
    updateGoal: (id, payload) => fetch(`/api/goals/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    }).then((json)),
    deleteGoal: (id) => fetch(`/api/goals/${id}`, { method: "DELETE" }).then((res) => {
        if (!res.ok)
            throw new Error(`${res.status} ${res.statusText}`);
    }),
    contributeToGoal: (id, payload) => fetch(`/api/goals/${id}/contribute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    }).then((json)),
    listGoalContributions: (id) => fetch(`/api/goals/${id}/contributions`).then((json)),
    deleteGoalContribution: (goalId, contribId) => fetch(`/api/goals/${goalId}/contributions/${contribId}`, { method: "DELETE" }).then((res) => {
        if (!res.ok)
            throw new Error(`${res.status} ${res.statusText}`);
    }),
    // Unclaimed property — Phase 8.1
    listUnclaimed: (params = {}) => {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(params))
            if (v !== undefined)
                qs.set(k, String(v));
        const suffix = qs.toString() ? `?${qs}` : "";
        return fetch(`/api/unclaimed${suffix}`).then((json));
    },
    createUnclaimed: (payload) => fetch("/api/unclaimed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    }).then((json)),
    unclaimedStats: () => fetch("/api/unclaimed/stats").then((json)),
    unclaimedSearchTips: () => fetch("/api/unclaimed/search-tips").then((json)),
    updateUnclaimedStatus: (id, status, actual_payout_cents, notes) => fetch(`/api/unclaimed/${id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, actual_payout_cents, notes }),
    }).then((json)),
    deleteUnclaimed: (id) => fetch(`/api/unclaimed/${id}`, { method: "DELETE" }).then((res) => {
        if (!res.ok)
            throw new Error(`${res.status} ${res.statusText}`);
    }),
    // Card benefits — Phase 8.3
    cardBenefits: () => fetch("/api/benefits/credits").then((json)),
    /** Catalog of available card-benefit profiles for the manual picker
     *  on Connections. */
    cardProfiles: () => fetch("/api/benefits/profiles").then((json)),
    /** Bind (or clear) a card-benefits catalog profile to an Account.
     *  Pass profile=null to clear the override. */
    setCardProfileOverride: (accountId, profile) => fetch(`/api/benefits/cards/${accountId}/profile-override`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ card_profile_override: profile }),
    }).then((json)),
    // Yield-arb — Phase 8.4
    yieldArbReport: () => fetch("/api/yield-opt/report").then((json)),
    // Regulatory redress — Phase 8.5
    redressKnown: () => fetch("/api/redress/known").then((json)),
    redressMatchSpend: (days = 730) => fetch(`/api/redress/match-spend?days=${days}`).then((json)),
    listRedress: () => fetch("/api/redress").then((json)),
    createRedress: (payload) => fetch("/api/redress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    }).then((json)),
    updateRedressStatus: (id, status, actual_payout_cents, notes) => fetch(`/api/redress/${id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, actual_payout_cents, notes }),
    }).then((json)),
    deleteRedress: (id) => fetch(`/api/redress/${id}`, { method: "DELETE" }).then((res) => {
        if (!res.ok)
            throw new Error(`${res.status} ${res.statusText}`);
    }),
    // Net worth — Phase 7.1
    netWorth: () => fetch("/api/networth").then((json)),
    netWorthHistory: (days = 365) => fetch(`/api/networth/history?days=${days}`).then((json)),
    netWorthSnapshot: () => fetch("/api/networth/snapshot", { method: "POST" }).then((json)),
    // Cash flow forecast — Phase 7.2
    cashFlowForecast: (days = 30) => fetch(`/api/cashflow/forecast?days=${days}`).then((json)),
    // Holdings — Phase 9.1
    listSecurities: () => fetch("/api/securities").then((json)),
    listHoldings: () => fetch("/api/holdings").then((json)),
    portfolio: () => fetch("/api/holdings/portfolio").then((json)),
    updateSecurityPrice: (id, latest_price_cents) => fetch(`/api/securities/${id}/price`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ latest_price_cents }),
    }).then((json)),
    // HSA receipts — Phase 9.2
    listHsaReceipts: (status) => {
        const qs = status ? `?status=${status}` : "";
        return fetch(`/api/hsa/receipts${qs}`).then((json));
    },
    createHsaReceipt: (payload) => fetch("/api/hsa/receipts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    }).then((json)),
    reimburseHsaReceipt: (id, notes) => fetch(`/api/hsa/receipts/${id}/reimburse`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: notes ?? null }),
    }).then((json)),
    deleteHsaReceipt: (id) => fetch(`/api/hsa/receipts/${id}`, { method: "DELETE" }).then((res) => {
        if (!res.ok)
            throw new Error(`${res.status} ${res.statusText}`);
    }),
    hsaSummary: () => fetch("/api/hsa/receipts/summary").then((json)),
    // Anomaly — Phase 9.3
    anomalyScan: (days = 90, threshold_sigma = 3.0, fire_notifications = false) => fetch(`/api/anomaly/scan?days=${days}&threshold_sigma=${threshold_sigma}&fire_notifications=${fire_notifications}`).then((json)),
    // Heatmap — Phase 9.4
    heatmapDaily: (days = 90) => fetch(`/api/heatmap/daily?days=${days}`).then((json)),
    // Offers — Phase 5.1
    listOffers: (params) => {
        const q = new URLSearchParams();
        if (params?.status)
            q.set("status", params.status);
        if (params?.source)
            q.set("source", params.source);
        if (params?.expiring_within_days != null)
            q.set("expiring_within_days", String(params.expiring_within_days));
        const qs = q.toString();
        return fetch(`/api/offers${qs ? `?${qs}` : ""}`).then((json));
    },
    offersStatus: () => fetch("/api/offers/status").then((json)),
    updateOfferStatus: (id, status) => fetch(`/api/offers/${id}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
    }).then((json)),
    scrapeOffers: () => fetch("/api/offers/scrape", { method: "POST" }).then((json)),
    // Card applications — Phase 8.2
    listCardApplications: (params = {}) => {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(params))
            if (v !== undefined)
                qs.set(k, String(v));
        const suffix = qs.toString() ? `?${qs}` : "";
        return fetch(`/api/card-applications${suffix}`).then((json));
    },
    createCardApplication: (payload) => fetch("/api/card-applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    }).then((json)),
    cardApplicationsEligibility: () => fetch("/api/card-applications/eligibility").then((json)),
    /** Curated catalog of top welcome bonuses, ranked by $-value. Each
     *  entry is enriched with ``user_eligible_5_24`` based on the user's
     *  application history so Chase consumer entries are flagged when
     *  the user is already over the threshold. */
    cardApplicationBestBonuses: (chase_5_24_only = false) => fetch(`/api/card-applications/best-bonuses${chase_5_24_only ? "?chase_5_24_only=true" : ""}`).then((json)),
    updateCardApplicationStatus: (id, status, notes) => fetch(`/api/card-applications/${id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, notes: notes ?? null }),
    }).then((json)),
    logCardApplicationSpend: (id, additional_spend_cents) => fetch(`/api/card-applications/${id}/spend`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ additional_spend_cents }),
    }).then((json)),
    deleteCardApplication: (id) => fetch(`/api/card-applications/${id}`, { method: "DELETE" }).then((res) => {
        if (!res.ok)
            throw new Error(`${res.status} ${res.statusText}`);
    }),
    // Merchant deep-dive — Phase 7.5
    merchantDetail: (key, months = 24, txn_limit = 50) => fetch(`/api/merchants/${encodeURIComponent(key)}?months=${months}&txn_limit=${txn_limit}`).then((json)),
    // Tax — Phase 7.4
    taxReport: (year) => fetch(`/api/tax/report?year=${year}`).then((json)),
    taxExportCsvUrl: (year) => `/api/tax/export.csv?year=${year}`,
    // Notifications — Phase 6
    listNotifications: (only_unread = false, limit = 50) => fetch(`/api/notifications?only_unread=${only_unread}&limit=${limit}`).then((json)),
    markNotificationRead: (id) => fetch(`/api/notifications/${id}/read`, { method: "POST" }).then((json)),
    markAllNotificationsRead: () => fetch("/api/notifications/read-all", { method: "POST" }).then((json)),
    clearReadNotifications: () => fetch("/api/notifications/clear-read", { method: "POST" }).then((json)),
    deleteNotification: (id) => fetch(`/api/notifications/${id}`, { method: "DELETE" }).then((res) => {
        if (!res.ok)
            throw new Error(`${res.status} ${res.statusText}`);
    }),
    // Receipts — Phase 10 Slice A
    ocrStatus: () => fetch("/api/receipts/ocr-status").then((json)),
    listReceipts: (limit = 100) => fetch(`/api/receipts?limit=${limit}`).then((json)),
    getReceipt: (id) => fetch(`/api/receipts/${id}`).then((json)),
    uploadReceipt: (file) => {
        const fd = new FormData();
        fd.append("file", file);
        return fetch("/api/receipts/upload", {
            method: "POST",
            body: fd,
        }).then((json));
    },
    parseReceiptText: (text) => fetch("/api/receipts/parse-text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
    }).then((json)),
    reparseReceipt: (id) => fetch(`/api/receipts/${id}/reparse`, { method: "POST" }).then((json)),
    patchReceipt: (id, payload) => fetch(`/api/receipts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    }).then((json)),
    patchReceiptItem: (id, payload) => fetch(`/api/receipts/items/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    }).then((json)),
    deleteReceiptItem: (id) => fetch(`/api/receipts/items/${id}`, { method: "DELETE" }).then((res) => {
        if (!res.ok)
            throw new Error(`${res.status} ${res.statusText}`);
    }),
    deleteReceipt: (id) => fetch(`/api/receipts/${id}`, { method: "DELETE" }).then((res) => {
        if (!res.ok)
            throw new Error(`${res.status} ${res.statusText}`);
    }),
    // Shopping patterns — Slice B (recurring purchases + merchant rollup)
    listRecurringPurchases: (params = {}) => {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(params))
            if (v !== undefined)
                qs.set(k, String(v));
        const suffix = qs.toString() ? `?${qs}` : "";
        return fetch(`/api/shopping-patterns${suffix}`).then((json));
    },
    detectRecurringPurchases: () => fetch("/api/shopping-patterns/detect", { method: "POST" }).then((json)),
    merchantRollup: (days = 365, min_transactions = 3) => fetch(`/api/shopping-patterns/merchant-rollup?days=${days}&min_transactions=${min_transactions}`).then((json)),
    patchRecurringPurchase: (id, payload) => fetch(`/api/shopping-patterns/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    }).then((json)),
    deleteRecurringPurchase: (id) => fetch(`/api/shopping-patterns/${id}`, { method: "DELETE" }).then((res) => {
        if (!res.ok)
            throw new Error(`${res.status} ${res.statusText}`);
    }),
    // Canonical products — Slice E
    listCanonicalProducts: (params = {}) => {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(params))
            if (v !== undefined)
                qs.set(k, String(v));
        const suffix = qs.toString() ? `?${qs}` : "";
        return fetch(`/api/canonical-products${suffix}`).then((json));
    },
    getCanonicalProduct: (id) => fetch(`/api/canonical-products/${id}`).then((json)),
    createCanonicalProduct: (payload) => fetch("/api/canonical-products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    }).then((json)),
    patchCanonicalProduct: (id, payload) => fetch(`/api/canonical-products/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    }).then((json)),
    deleteCanonicalProduct: (id) => fetch(`/api/canonical-products/${id}`, { method: "DELETE" }).then((res) => {
        if (!res.ok)
            throw new Error(`${res.status} ${res.statusText}`);
    }),
    runCanonicalize: () => fetch("/api/canonical-products/canonicalize", { method: "POST" }).then((json)),
    mergeCanonicalProducts: (keep_id, drop_id) => fetch("/api/canonical-products/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keep_id, drop_id }),
    }).then((json)),
    // Deals — Slice D (cross-store price observations + deal detection)
    listDeals: (threshold = 0.15, window_days = 30) => fetch(`/api/deals?threshold=${threshold}&window_days=${window_days}`).then((json)),
    scanDeals: () => fetch("/api/deals/scan", { method: "POST" }).then((json)),
    dealScraperStatus: () => fetch("/api/deals/scraper-status").then((json)),
    listDealObservations: (params = {}) => {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(params))
            if (v !== undefined)
                qs.set(k, String(v));
        const suffix = qs.toString() ? `?${qs}` : "";
        return fetch(`/api/deals/observations${suffix}`).then((json));
    },
    createDealObservation: (payload) => fetch("/api/deals/observations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    }).then((json)),
    deleteDealObservation: (id) => fetch(`/api/deals/observations/${id}`, { method: "DELETE" }).then((res) => {
        if (!res.ok)
            throw new Error(`${res.status} ${res.statusText}`);
    }),
    // Receipt coupons — Slice C
    listReceiptCoupons: (status) => {
        const qs = status ? `?status=${status}` : "";
        return fetch(`/api/receipts/coupons${qs}`).then((json));
    },
    patchReceiptCoupon: (id, payload) => fetch(`/api/receipts/coupons/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    }).then((json)),
    deleteReceiptCoupon: (id) => fetch(`/api/receipts/coupons/${id}`, { method: "DELETE" }).then((res) => {
        if (!res.ok)
            throw new Error(`${res.status} ${res.statusText}`);
    }),
    // Money on the table — Phase 8.6 unified ranked-by-ROI dashboard.
    // Pulls every claim/save/earn opportunity from every aggregator
    // (unclaimed property, class actions, regulatory redress, card
    // benefits, yield-arb, sub-cancel) into one queue.
    moneyOnTable: () => fetch("/api/money-on-table/report").then((json)),
    // Daily Moves — top-N urgency-ranked slice of the same upstream data.
    // Companion to moneyOnTable; lighter and action-oriented.
    dailyMoves: (limit = 5) => fetch(`/api/money-on-table/today?limit=${limit}`).then((json)),
    // Mark a move as done / snoozed / dismissed. Server stores in
    // daily_move_actions; the queue filters out actioned items.
    dailyMoveAction: (body) => fetch("/api/money-on-table/today/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    }).then((res) => {
        if (!res.ok)
            throw new Error(`${res.status} ${res.statusText}`);
        return res.json();
    }),
    // Recent actions (for the "recently done" section + undo). Default
    // 14d window matches the backend.
    dailyMoveActions: (days = 14) => fetch(`/api/money-on-table/today/actions?days=${days}`).then((json)),
    // Undo a prior action — re-surfaces the opportunity in the queue.
    dailyMoveUndo: (source_kind, source_id, source_key) => {
        const qp = new URLSearchParams({ source_kind });
        if (source_id != null)
            qp.set("source_id", String(source_id));
        if (source_key)
            qp.set("source_key", source_key);
        return fetch(`/api/money-on-table/today/action?${qp.toString()}`, {
            method: "DELETE",
        }).then((res) => {
            if (!res.ok)
                throw new Error(`${res.status} ${res.statusText}`);
        });
    },
    // Net-worth attribution — per-month decomposition into income / spending / other
    netWorthAttribution: (months = 12) => fetch(`/api/networth/attribution?months=${months}`).then((json)),
    // Chat — local Ollama-powered Q&A over user data
    chatStatus: () => fetch("/api/chat/status").then((json)),
    chatAsk: (question, history = []) => fetch("/api/chat/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, history }),
    }).then((json)),
    // FIRE / retirement Monte Carlo simulator.
    // /defaults: server-derived starting points seeded from the user's
    // current data so the panel renders something sensible on first load.
    fireDefaults: () => fetch("/api/fire/defaults").then((json)),
    // /projection: run the simulation. All inputs are query params so
    // TanStack Query can cache by key — the slider UI debounces and
    // the backend runs ~5K trials in well under a second.
    fireProjection: (params) => {
        const qp = new URLSearchParams();
        Object.entries(params).forEach(([k, v]) => {
            if (v !== undefined && v !== null)
                qp.set(k, String(v));
        });
        return fetch(`/api/fire/projection?${qp.toString()}`).then((json));
    },
    // Savings (Phase D)
    surplus: (mode = "both") => fetch(`/api/savings/surplus?mode=${mode}`).then((json)),
    suggestions: (mode = "historical") => {
        // Server's /suggestions endpoint quietly coerces "both" → "historical",
        // but we still default to the right thing here so the URL stays clean.
        const m = mode === "both" ? "historical" : mode;
        return fetch(`/api/savings/suggestions?mode=${m}`).then((json));
    },
};
export const fmtCents = (c) => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
/** Format a YYYY-MM-01 date string as "April 2026" (long month + year). */
export const fmtMonthLong = (ymd) => {
    // Parse the Y-M-D locally to avoid TZ skew — new Date("2026-04-01") is UTC,
    // which renders as "March 2026" in timezones west of UTC. Splitting and
    // constructing with the local constructor keeps the user's intent intact.
    const [y, m] = ymd.split("-").map(Number);
    const d = new Date(y, m - 1, 1);
    return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
};
/** Format a YYYY-MM-01 date string as "Apr '26" (short). */
export const fmtMonthShort = (ymd) => {
    const [y, m] = ymd.split("-").map(Number);
    const d = new Date(y, m - 1, 1);
    return d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
};
/** Build a YYYY-MM-01 string for the first of this month. */
export const currentMonthStart = (today = new Date()) => {
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, "0");
    return `${y}-${m}-01`;
};
/** Shift a YYYY-MM-01 string by ±n months (returning YYYY-MM-01). */
export const shiftMonthStart = (ymd, delta) => {
    const [y, m] = ymd.split("-").map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    const yy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    return `${yy}-${mm}-01`;
};
