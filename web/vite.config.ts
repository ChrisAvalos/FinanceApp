import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Prefer .tsx/.ts over .js when a file has both extensions. The repo
    // has stale compiled .js siblings next to every .tsx (legacy from a
    // pre-Vite tsc-watch setup); without this override Vite's default
    // resolution order (.mjs → .js → .ts → .tsx) loads the stale JS and
    // silently ignores .tsx edits. Reordering puts .tsx first so source
    // edits are picked up and the .js files become inert until manually
    // deleted.
    extensions: [".mjs", ".tsx", ".ts", ".jsx", ".js", ".json"],
  },
  server: {
    port: 5173,
    proxy: {
      // Proxy API calls to FastAPI in dev so we don't fight CORS.
      // Bumped timeouts to 90s — Plaid's exchange + item_get +
      // institution_get + accounts/get chain on a fresh Chase link
      // can take 10–20s in production, and Vite's default proxy
      // timeout was dropping the connection mid-flight, surfacing as
      // a misleading 502 Bad Gateway with no Python traceback.
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
        timeout: 90_000,
        proxyTimeout: 90_000,
      },
    },
  },
});
