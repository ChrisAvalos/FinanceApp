/**
 * Shared design tokens — mirrors the web app's color tokens so screens
 * feel like the same app on a different surface.
 */
import { Platform, StyleSheet } from "react-native";

export const C = {
  // Background
  bg: "#f4f6f9",
  card: "#ffffff",
  cardElev: "#ffffff",
  hover: "#f1f5f9",
  // Brand (Chase navy)
  brand: "#0b2a4a",
  brandLight: "#dbe5f1",
  brandAccent: "#1e40af",
  // Text
  text: "#0f172a",
  textMuted: "#475569",
  textSoft: "#94a3b8",
  // Semantic
  inflow: "#15803d", // green
  outflow: "#b91c1c", // red
  warn: "#b45309", // amber
  // Border / hairlines
  border: "#e3e8ef",
  borderSoft: "#eef2f7",
};

/**
 * Font stack — mirror of the web's Inter typography pass.
 *
 * Inter requires `expo-font` + `@expo-google-fonts/inter` to actually
 * render Inter on the device. Until those are installed (TODO in Wave
 * D-4 follow-up), `font.body === undefined` falls through to the system
 * default — SF Pro on iOS, Roboto on Android, both of which match
 * Inter's metrics closely enough that the type scale below is the
 * dominant signal anyway. Setting fontFamily to a missing font does
 * NOT crash on RN — it silently falls back, so this is safe to leave
 * as-is.
 *
 * When you do install Inter:
 *   npm i expo-font @expo-google-fonts/inter
 *   // in App.tsx:
 *   import { useFonts, Inter_400Regular, Inter_600SemiBold } from "@expo-google-fonts/inter";
 *   const [loaded] = useFonts({ Inter_400Regular, Inter_600SemiBold });
 *   if (!loaded) return null;
 * …then change `body` / `semibold` below to "Inter_400Regular" / "Inter_600SemiBold".
 */
export const FONT = {
  body: undefined as string | undefined,        // → "Inter_400Regular" once loaded
  semibold: undefined as string | undefined,    // → "Inter_600SemiBold"
  mono: Platform.select({ ios: "Menlo", android: "monospace", default: undefined }),
};

/**
 * Type scale — mirrors the web's font-size + line-height + weight ladder.
 *
 * Use these instead of inlining `fontSize: 14` etc. so the whole app
 * shifts uniformly when we tune the scale. Naming matches the web's
 * Tailwind classes (text-xs / text-sm / text-base) plus a couple
 * native conveniences (heroNum for hero stat values, heading for
 * section titles).
 */
export const T = StyleSheet.create({
  // Body (16px base — RN default is 14, this nudges up for readability)
  body: {
    fontSize: 15,
    lineHeight: 22,
    color: C.text,
    fontFamily: FONT.body,
  },
  bodyMuted: {
    fontSize: 13,
    lineHeight: 18,
    color: C.textMuted,
    fontFamily: FONT.body,
  },
  caption: {
    fontSize: 11,
    lineHeight: 14,
    color: C.textSoft,
    fontFamily: FONT.body,
  },
  // Stat-card label (the small uppercased "TOTAL VALUE")
  statLabel: {
    fontSize: 11,
    lineHeight: 14,
    color: C.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    fontFamily: FONT.semibold,
    fontWeight: "600",
  },
  // Stat-card hero value
  heroNum: {
    fontSize: 26,
    lineHeight: 32,
    color: C.text,
    fontFamily: FONT.semibold,
    fontWeight: "600",
  },
  // Section heading
  heading: {
    fontSize: 18,
    lineHeight: 24,
    color: C.text,
    fontFamily: FONT.semibold,
    fontWeight: "600",
  },
  // Greeting hero ("Hi Chris 👋")
  greeting: {
    fontSize: 22,
    lineHeight: 28,
    color: C.text,
    fontFamily: FONT.semibold,
    fontWeight: "600",
  },
});

/** Header style mirrored across every screen. */
export const headerStyles = StyleSheet.create({
  header: {
    backgroundColor: C.brand,
    paddingTop: 56,
    paddingBottom: 16,
    paddingHorizontal: 16,
  },
  headerTitle: {
    color: "#fff",
    fontSize: 20,
    lineHeight: 26,
    fontWeight: "600",
    fontFamily: FONT.semibold,
  },
  headerSub: {
    color: C.brandLight,
    marginTop: 4,
    fontSize: 12,
    lineHeight: 16,
    fontFamily: FONT.body,
  },
});

/** Standard card with subtle shadow on iOS; flat border on Android. */
export const cardStyle = StyleSheet.create({
  card: {
    backgroundColor: C.card,
    borderRadius: 8,
    padding: 16,
    marginBottom: 12,
    borderWidth: Platform.OS === "android" ? StyleSheet.hairlineWidth : 0,
    borderColor: C.border,
    ...Platform.select({
      ios: {
        shadowColor: "#0f172a",
        shadowOpacity: 0.06,
        shadowOffset: { width: 0, height: 1 },
        shadowRadius: 4,
      },
      android: { elevation: 1 },
    }),
  },
});

/** Tabular-numbers feel for amount columns — fixed-width digits */
export const tabular = {
  fontVariant: ["tabular-nums" as const],
};

/** Format a YYYY-MM-DD as "Apr 15" */
export const fmtShortDate = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

/** "5 days ago", "in 12 days", "today" */
export const fmtRelativeDate = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const days = Math.round((Date.now() - d.getTime()) / (24 * 3600 * 1000));
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days === -1) return "tomorrow";
  if (days > 0 && days < 30) return `${days}d ago`;
  if (days < 0 && days > -30) return `in ${-days}d`;
  if (days > 0 && days < 365) return `${Math.round(days / 30)}mo ago`;
  if (days < 0) return `in ${Math.round(-days / 30)}mo`;
  return `${(days / 365).toFixed(1)}y ago`;
};

/** Build a YYYY-MM-01 string for the first of the current month. */
export const currentMonthStart = (): string => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}-01`;
};
