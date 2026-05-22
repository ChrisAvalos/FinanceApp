/**
 * Bottom-tab navigator — minimal, in-house.
 *
 * Why not `@react-navigation`: that pulls in 5 packages + native deps
 * (gesture-handler, reanimated, screens, safe-area-context). For a
 * fixed-bar phone app that's overkill. A useState-driven switch + a
 * fixed Pressable bar gives us tabs in ~150 lines with zero new deps.
 *
 * Two-tier model. The bar shows a small set of `tabs` (the morning-check
 * surfaces, ~5 of them). Everything else lives in `moreSections` and is
 * reachable via a "More" pseudo-tab whose body is a sectioned grid. The
 * bar highlights "More" when the active screen is one of the secondary
 * ones, so the user always sees where they are.
 */
import React, { useMemo, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { tapLight } from "../util/feedback";

export type TabDef = {
  key: string;
  label: string;
  // Single-glyph emoji is fine for v1 — keeps us icon-library-free.
  icon: string;
  render: () => React.ReactElement;
};

export type TabSection = {
  title: string;
  items: TabDef[];
};

const MORE_KEY = "__more__";

const C = {
  bg: "#f4f6f9",
  bar: "#0b2a4a",
  barInactive: "#7a90ad",
  barActive: "#ffffff",
  border: "rgba(255,255,255,0.10)",
  // For the "More" grid screen
  text: "#0f172a",
  textMuted: "#475569",
  sectionLabel: "#64748b",
};

export default function TabNavigator({
  tabs,
  moreSections = [],
}: {
  tabs: TabDef[];
  moreSections?: TabSection[];
}) {
  const [active, setActive] = useState(tabs[0]?.key ?? "");

  // Flatten everything we know how to render, keyed by tab key.
  const allByKey = useMemo(() => {
    const out: Record<string, TabDef> = {};
    for (const t of tabs) out[t.key] = t;
    for (const s of moreSections) for (const t of s.items) out[t.key] = t;
    return out;
  }, [tabs, moreSections]);

  // Active key categorization:
  //   primary   — matches one of the bar tabs
  //   more      — active === MORE_KEY (the grid is showing)
  //   secondary — a key that lives inside moreSections
  const isPrimary = tabs.some((t) => t.key === active);
  const isMoreScreen = active === MORE_KEY;
  const isSecondary = !isPrimary && !isMoreScreen && allByKey[active] != null;
  const showsMoreInBar = moreSections.length > 0;

  // Render the body. If the more screen is active, render the grid;
  // otherwise look up the active key in the flat map. We deliberately
  // do NOT render a breadcrumb above secondary screens — every screen
  // already has its own navy header with status-bar padding, and an
  // extra header would double up. The "More" highlight in the bar is
  // the back-affordance: tap it to return to the grid.
  const body = isMoreScreen ? (
    <MoreScreen sections={moreSections} onPick={setActive} />
  ) : allByKey[active] ? (
    allByKey[active].render()
  ) : null;

  // Build the bar buttons: primary tabs + (optionally) a "More" pseudo-tab.
  const barTabs: { key: string; label: string; icon: string; isActive: boolean }[] = tabs.map((t) => ({
    key: t.key,
    label: t.label,
    icon: t.icon,
    isActive: t.key === active,
  }));
  if (showsMoreInBar) {
    barTabs.push({
      key: MORE_KEY,
      label: "More",
      icon: "⋯",
      isActive: isMoreScreen || isSecondary,
    });
  }

  return (
    <View style={styles.root}>
      <View style={styles.body}>{body}</View>
      <View style={styles.bar}>
        {barTabs.map((t) => (
          <Pressable
            key={t.key}
            onPress={() => {
              if (t.key !== active) tapLight();
              setActive(t.key);
            }}
            style={({ pressed }) => [styles.tab, pressed && { opacity: 0.7 }]}
          >
            <Text
              style={[
                styles.tabIcon,
                { color: t.isActive ? C.barActive : C.barInactive },
              ]}
            >
              {t.icon}
            </Text>
            <Text
              style={[
                styles.tabLabel,
                { color: t.isActive ? C.barActive : C.barInactive },
              ]}
              numberOfLines={1}
            >
              {t.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/** "More" tab body — a sectioned grid of secondary tabs.
 *
 * Mobile equivalent of the web app's Cmd+K command palette: a
 * search field at the top filters the grid in real time across every
 * section. Empty query renders the full sectioned layout; non-empty
 * collapses to a single flat "Matches" list ranked by best-match
 * (label includes query, then label starts with query, then any). 23
 * tiles is too many to scan visually under time pressure — typing 2
 * letters narrows it to ~3 instantly.
 */
function MoreScreen({
  sections,
  onPick,
}: {
  sections: TabSection[];
  onPick: (key: string) => void;
}) {
  const [query, setQuery] = useState("");
  const trimmed = query.trim().toLowerCase();

  const matches = useMemo(() => {
    if (!trimmed) return [];
    const all: { item: TabDef; rank: number }[] = [];
    for (const s of sections) {
      for (const t of s.items) {
        const label = t.label.toLowerCase();
        const key = t.key.toLowerCase();
        let rank: number;
        // Lower rank = better match. Cheap heuristic — matches the
        // "fuzzy enough for 4-word labels" feel that Cmd+K offers on web
        // without needing fuzzy-search libs.
        if (label === trimmed) rank = 0;
        else if (label.startsWith(trimmed)) rank = 1;
        else if (key.startsWith(trimmed)) rank = 2;
        else if (label.includes(trimmed)) rank = 3;
        else if (key.includes(trimmed)) rank = 4;
        else continue;
        all.push({ item: t, rank });
      }
    }
    all.sort((a, b) => a.rank - b.rank);
    return all;
  }, [trimmed, sections]);

  return (
    <ScrollView
      style={styles.moreScroll}
      contentContainerStyle={styles.moreContent}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.moreHeader}>
        <Text style={styles.moreTitle}>More</Text>
        <Text style={styles.moreSubtitle}>
          Opportunities, tracking, analytics, system
        </Text>
      </View>

      {/* Search row — autoFocus is intentionally OFF so opening "More"
          doesn't yank the keyboard up; the user opts in by tapping. */}
      <View style={styles.searchWrap}>
        <Text style={styles.searchIcon} aria-hidden>🔍</Text>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Jump to a screen…"
          placeholderTextColor={C.textMuted}
          style={styles.searchInput}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          onSubmitEditing={() => {
            if (matches.length > 0) {
              tapLight();
              onPick(matches[0].item.key);
            }
          }}
        />
        {trimmed.length > 0 && (
          <Pressable
            onPress={() => setQuery("")}
            style={({ pressed }) => [styles.searchClear, pressed && { opacity: 0.5 }]}
            hitSlop={8}
          >
            <Text style={styles.searchClearText}>×</Text>
          </Pressable>
        )}
      </View>

      {trimmed ? (
        // Filtered results — flat list, ranked.
        <View style={styles.moreSection}>
          <Text style={styles.moreSectionLabel}>
            {matches.length} match{matches.length === 1 ? "" : "es"}
          </Text>
          {matches.length === 0 ? (
            <Text style={styles.noMatch}>
              No screens match "{query}". Try a shorter query.
            </Text>
          ) : (
            <View style={styles.moreGrid}>
              {matches.map(({ item }) => (
                <Pressable
                  key={item.key}
                  onPress={() => {
                    tapLight();
                    onPick(item.key);
                  }}
                  style={({ pressed }) => [
                    styles.moreTile,
                    pressed && { opacity: 0.6 },
                  ]}
                >
                  <Text style={styles.moreTileIcon}>{item.icon}</Text>
                  <Text style={styles.moreTileLabel} numberOfLines={2}>
                    {item.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}
        </View>
      ) : (
        // Default — full sectioned grid.
        sections.map((section) => (
          <View key={section.title} style={styles.moreSection}>
            <Text style={styles.moreSectionLabel}>{section.title}</Text>
            <View style={styles.moreGrid}>
              {section.items.map((t) => (
                <Pressable
                  key={t.key}
                  onPress={() => {
                    tapLight();
                    onPick(t.key);
                  }}
                  style={({ pressed }) => [
                    styles.moreTile,
                    pressed && { opacity: 0.6 },
                  ]}
                >
                  <Text style={styles.moreTileIcon}>{t.icon}</Text>
                  <Text style={styles.moreTileLabel} numberOfLines={2}>
                    {t.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        ))
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  body: { flex: 1 },

  // Bottom bar
  bar: {
    height: 66,
    flexDirection: "row",
    backgroundColor: C.bar,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.border,
    paddingBottom: 18, // safe-area
    paddingTop: 8,
  },
  tab: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 4,
  },
  tabIcon: { fontSize: 18, marginBottom: 2 },
  tabLabel: { fontSize: 10, fontWeight: "500" },

  // "More" grid
  moreScroll: { flex: 1, backgroundColor: C.bg },
  moreContent: { padding: 16, paddingBottom: 40 },
  moreHeader: {
    paddingTop: 32,
    paddingBottom: 16,
  },
  moreTitle: { color: C.text, fontSize: 28, fontWeight: "700" },
  moreSubtitle: { color: C.textMuted, fontSize: 13, marginTop: 4 },

  // Search row — Cmd+K equivalent on phone.
  searchWrap: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginTop: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#e3e8ef",
  },
  searchIcon: { fontSize: 14, marginRight: 8, opacity: 0.6 },
  searchInput: {
    flex: 1,
    fontSize: 15,
    color: C.text,
    padding: 0,
  },
  searchClear: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: "#e3e8ef",
    alignItems: "center",
    justifyContent: "center",
    marginLeft: 6,
  },
  searchClearText: { color: C.textMuted, fontSize: 16, lineHeight: 18 },
  noMatch: { color: C.textMuted, fontSize: 13, marginTop: 8 },

  moreSection: { marginTop: 16 },
  moreSectionLabel: {
    color: C.sectionLabel,
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  moreGrid: { flexDirection: "row", flexWrap: "wrap" },
  moreTile: {
    width: "25%",
    aspectRatio: 1,
    padding: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  moreTileIcon: { fontSize: 28 },
  moreTileLabel: {
    color: C.text,
    fontSize: 11,
    fontWeight: "600",
    marginTop: 4,
    textAlign: "center",
  },
});
