/**
 * Loads Plaid's Link.js from CDN on-demand.
 *
 * Keeps `react-plaid-link` out of our dependency graph — Plaid Link is only
 * loaded when the user actually clicks Connect Bank. If Plaid isn't configured
 * we never pay the page-weight cost.
 *
 * Usage:
 *
 *   const token = await api.plaidCreateLinkToken();
 *   const Plaid = await loadPlaidLink();
 *   Plaid.create({
 *     token: token.link_token,
 *     onSuccess: (publicToken) => api.plaidExchange(publicToken),
 *   }).open();
 */
const SCRIPT_SRC = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
let loaderPromise = null;
export function loadPlaidLink() {
    if (typeof window === "undefined") {
        return Promise.reject(new Error("Plaid Link requires a browser environment"));
    }
    if (window.Plaid)
        return Promise.resolve(window.Plaid);
    if (loaderPromise)
        return loaderPromise;
    loaderPromise = new Promise((resolve, reject) => {
        const existing = document.querySelector(`script[src="${SCRIPT_SRC}"]`);
        const onLoad = () => {
            if (window.Plaid)
                resolve(window.Plaid);
            else
                reject(new Error("Plaid Link script loaded but window.Plaid is missing"));
        };
        if (existing) {
            existing.addEventListener("load", onLoad, { once: true });
            existing.addEventListener("error", () => reject(new Error("Failed to load Plaid Link script")), { once: true });
            return;
        }
        const s = document.createElement("script");
        s.src = SCRIPT_SRC;
        s.async = true;
        s.onload = onLoad;
        s.onerror = () => reject(new Error("Failed to load Plaid Link script"));
        document.head.appendChild(s);
    });
    return loaderPromise;
}
