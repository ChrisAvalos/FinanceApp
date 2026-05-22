/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Chase-inspired palette. `brand` = Chase blue / navy. Keep semantic
        // aliases (bg / card / border / etc) so the rest of the app keeps
        // working after the light-theme switch.
        brand: {
          DEFAULT: "#117ACA",   // Chase blue — links, primary buttons
          navy:    "#0F4D8C",   // hover, emphasis
          deep:    "#062a51",   // header background
          light:   "#E6F1FB",   // pale blue for selected rows, chips
        },
        bg:     "#f5f6f8",      // app background — same soft grey Chase uses
        card:   "#ffffff",      // card / table background
        border: "#e3e6eb",      // hairline borders
        hover:  "#f0f3f7",      // row hover
        text: {
          DEFAULT: "#1b2430",   // primary text — WCAG AAA on white
          muted:   "#5b6676",   // secondary text — 6.4:1 on white, passes AA
          // Sprint 50 — darkened from #8b93a0 (3.09:1) to #65707D (5.0:1)
          // so sidebar group labels + helper-hint footers pass WCAG AA
          // for small text. Still visually distinct enough from `muted`
          // to maintain the three-tier hierarchy.
          soft:    "#65707D",   // tertiary — 5.0:1 on white, passes AA
        },
        inflow:   "#00754A",    // muted Chase-style green — 5.5:1 on white
        outflow:  "#c2161e",    // Chase credit-card alert red — 5.6:1 on white
        // Sprint 50 — darkened from #c78100 (3.08:1 on bg-amber-50) to
        // #8b5a00 (5.0:1 on bg-amber-50, 6.0:1 on white). Used as the
        // "needs attention but not an error" tone on warn pills and
        // price-change flags. The old value was a darker yellow that
        // looked the part but didn't hold up at small font sizes.
        warn:     "#8b5a00",
      },
      boxShadow: {
        card: "0 1px 2px rgba(15, 34, 58, 0.06), 0 1px 1px rgba(15, 34, 58, 0.03)",
      },
      fontFamily: {
        // Inter is loaded via Google Fonts in index.html. The fallback
        // chain keeps the app legible if the CDN is offline — every
        // panel still renders, just with the OS default sans.
        sans: [
          "Inter",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "'Segoe UI'",
          "sans-serif",
        ],
        // JetBrains Mono drives the `font-mono` utility (transaction
        // descriptions, notification kind labels, code-like values).
        // Falls back to ui-monospace.
        mono: [
          "'JetBrains Mono'",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "monospace",
        ],
      },
    },
  },
  plugins: [],
};
