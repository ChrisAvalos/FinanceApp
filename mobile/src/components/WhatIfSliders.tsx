/**
 * WhatIfSliders — Wave G-13 mobile port.
 *
 * Per-category sliders + per-goal contribution sliders, mirroring the
 * web component at web/src/BudgetsPanel.tsx (WhatIfSliders + GoalSliderRow).
 * Uses @react-native-community/slider for the platform-native slider.
 *
 * Same 200ms debounce as web so the projection API isn't hammered
 * while the user drags. Local draft state for snappy thumb tracking;
 * pushed up to parent via debounced effect.
 */
import React, { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Slider from "@react-native-community/slider";
import { fmtCents, type CategoryBaseline, type GoalBaseline } from "../api/client";
import { C } from "../theme";

const DEBOUNCE_MS = 200;
const VISIBLE_CATEGORIES_DEFAULT = 8;

export interface WhatIfSlidersProps {
  categories: CategoryBaseline[];
  goals: GoalBaseline[];
  overrides: Record<number, number> | null;
  onOverridesChange: (next: Record<number, number> | null) => void;
  goalContributions: Record<number, number>;
  onGoalContributionsChange: (next: Record<number, number>) => void;
}

export default function WhatIfSliders({
  categories,
  goals,
  overrides,
  onOverridesChange,
  goalContributions,
  onGoalContributionsChange,
}: WhatIfSlidersProps) {
  const [showAll, setShowAll] = useState(false);
  const [draft, setDraft] = useState<Record<number, number>>(overrides ?? {});
  const [goalDraft, setGoalDraft] = useState<Record<number, number>>(goalContributions);

  useEffect(() => setDraft(overrides ?? {}), [overrides]);
  useEffect(() => setGoalDraft(goalContributions), [goalContributions]);

  // Debounced push for category overrides.
  useEffect(() => {
    const t = setTimeout(() => {
      const cleaned: Record<number, number> = {};
      for (const c of categories) {
        if (draft[c.id] !== undefined && draft[c.id] !== c.monthly_cents) {
          cleaned[c.id] = draft[c.id];
        }
      }
      const next = Object.keys(cleaned).length > 0 ? cleaned : null;
      onOverridesChange(next);
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [draft, categories, onOverridesChange]);

  // Debounced push for goal contributions.
  useEffect(() => {
    const t = setTimeout(() => {
      const cleaned: Record<number, number> = {};
      for (const [k, v] of Object.entries(goalDraft)) {
        if (v > 0) cleaned[Number(k)] = v;
      }
      const sameKeys =
        Object.keys(cleaned).length === Object.keys(goalContributions).length &&
        Object.keys(cleaned).every(
          (k) => goalContributions[Number(k)] === cleaned[Number(k)],
        );
      if (!sameKeys) onGoalContributionsChange(cleaned);
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [goalDraft, goalContributions, onGoalContributionsChange]);

  const visibleCategories = showAll ? categories : categories.slice(0, VISIBLE_CATEGORIES_DEFAULT);

  if (categories.length === 0 && goals.length === 0) return null;

  return (
    <View>
      {/* Per-goal contribution sliders (G-11 parity) */}
      {goals.length > 0 && (
        <View style={[styles.section, { backgroundColor: "rgba(16,185,129,0.05)" }]}>
          <View style={styles.sectionHeaderRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.sectionLabel}>Goal funding</Text>
              <Text style={styles.sectionHint}>
                Each goal funds independently. Compounds at 7%.
              </Text>
            </View>
            <View style={{ alignItems: "flex-end" }}>
              <Text style={styles.sectionSubLabel}>Total</Text>
              <Text style={styles.sectionSubValue}>
                {fmtCents(
                  Object.values(goalDraft).reduce((s, v) => s + v, 0),
                )}/mo
              </Text>
            </View>
          </View>
          {goals.map((g) => (
            <GoalSliderRow
              key={g.id}
              goal={g}
              value={goalDraft[g.id] ?? 0}
              onChange={(v) =>
                setGoalDraft((d) => ({ ...d, [g.id]: v }))
              }
              onReset={() =>
                setGoalDraft((d) => {
                  const next = { ...d };
                  delete next[g.id];
                  return next;
                })
              }
            />
          ))}
        </View>
      )}

      {/* Per-category sliders */}
      {visibleCategories.map((cat) => (
        <CategorySliderRow
          key={cat.id}
          category={cat}
          value={draft[cat.id] ?? cat.monthly_cents}
          onChange={(v) =>
            setDraft((d) => ({ ...d, [cat.id]: v }))
          }
          onReset={() =>
            setDraft((d) => {
              const next = { ...d };
              delete next[cat.id];
              return next;
            })
          }
        />
      ))}

      {categories.length > VISIBLE_CATEGORIES_DEFAULT && (
        <Pressable onPress={() => setShowAll((s) => !s)}>
          <Text style={styles.expandLink}>
            {showAll
              ? "Show top 8 only"
              : `Show all ${categories.length} categories →`}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

function CategorySliderRow({
  category,
  value,
  onChange,
  onReset,
}: {
  category: CategoryBaseline;
  value: number;
  onChange: (cents: number) => void;
  onReset: () => void;
}) {
  const maxCents = Math.max(category.monthly_cents * 2, 10000);
  const stepCents = Math.max(500, Math.floor(maxCents / 100));
  const delta = value - category.monthly_cents;
  const isCut = delta < 0;
  const isOverridden = value !== category.monthly_cents;
  const minTrackColor = isCut ? C.inflow : isOverridden ? C.warn : C.brand;

  return (
    <View style={styles.sliderRow}>
      <View style={styles.sliderHeader}>
        <Text style={styles.sliderName} numberOfLines={1}>
          {category.name}
          {isOverridden && (
            <Text style={styles.resetLink} onPress={onReset}>  reset</Text>
          )}
        </Text>
        <Text style={styles.sliderValue}>
          {fmtCents(value)}
          <Text style={styles.sliderValueUnit}>/mo</Text>
        </Text>
      </View>
      <Slider
        style={styles.slider}
        minimumValue={0}
        maximumValue={maxCents}
        step={stepCents}
        value={value}
        onValueChange={onChange}
        minimumTrackTintColor={minTrackColor}
        maximumTrackTintColor={C.border}
        thumbTintColor={minTrackColor}
      />
      <View style={styles.sliderFooter}>
        <Text style={styles.sliderFootText}>
          Status quo: {fmtCents(category.monthly_cents)}
        </Text>
        {delta !== 0 && (
          <Text
            style={[
              styles.sliderFootText,
              { color: isCut ? C.inflow : C.outflow, fontWeight: "700" },
            ]}
          >
            {isCut ? "−" : "+"}
            {fmtCents(Math.abs(delta))}/mo
          </Text>
        )}
      </View>
    </View>
  );
}

function GoalSliderRow({
  goal,
  value,
  onChange,
  onReset,
}: {
  goal: GoalBaseline;
  value: number;
  onChange: (cents: number) => void;
  onReset: () => void;
}) {
  const maxCents = Math.max(goal.needed_monthly_cents * 1.5, 50000);
  const stepCents = Math.max(500, Math.floor(maxCents / 100));
  const isOverridden = value > 0;
  const minTrackColor = value >= goal.needed_monthly_cents ? C.inflow : isOverridden ? C.warn : C.brand;
  const gap = goal.target_amount_cents - goal.current_amount_cents;
  const monthsToHit = value > 0 ? Math.ceil(gap / value) : null;
  return (
    <View style={styles.sliderRow}>
      <View style={styles.sliderHeader}>
        <Text style={styles.sliderName} numberOfLines={1}>
          {goal.name}
          {isOverridden && (
            <Text style={styles.resetLink} onPress={onReset}>  clear</Text>
          )}
        </Text>
        <Text style={styles.sliderValue}>
          {fmtCents(value)}
          <Text style={styles.sliderValueUnit}>/mo</Text>
        </Text>
      </View>
      <Slider
        style={styles.slider}
        minimumValue={0}
        maximumValue={maxCents}
        step={stepCents}
        value={value}
        onValueChange={onChange}
        minimumTrackTintColor={minTrackColor}
        maximumTrackTintColor={C.border}
        thumbTintColor={minTrackColor}
      />
      <View style={styles.sliderFooter}>
        <Text style={styles.sliderFootText}>
          Need {fmtCents(goal.needed_monthly_cents)}/mo
          {goal.months_left ? ` (${goal.months_left}mo left)` : ""}
        </Text>
        <Text
          style={[
            styles.sliderFootText,
            monthsToHit !== null && monthsToHit <= (goal.months_left ?? Infinity)
              ? { color: C.inflow, fontWeight: "700" }
              : null,
          ]}
        >
          {monthsToHit !== null && monthsToHit !== Infinity
            ? `Hits in ${monthsToHit}mo`
            : "—"}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    padding: 12,
    borderRadius: 8,
    marginBottom: 12,
  },
  sectionHeaderRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  sectionLabel: {
    color: C.inflow,
    fontSize: 10,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  sectionHint: { color: C.textMuted, fontSize: 11, marginTop: 2 },
  sectionSubLabel: {
    color: C.textSoft,
    fontSize: 9,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  sectionSubValue: { color: C.inflow, fontSize: 14, fontWeight: "700", marginTop: 2 },

  sliderRow: { marginBottom: 12 },
  sliderHeader: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    marginBottom: 2,
  },
  sliderName: { flex: 1, color: C.text, fontSize: 13, fontWeight: "500" },
  sliderValue: { color: C.text, fontSize: 14, fontWeight: "700" },
  sliderValueUnit: { color: C.textSoft, fontSize: 11, fontWeight: "400" },
  slider: { width: "100%", height: 32 },
  sliderFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: -2,
  },
  sliderFootText: { color: C.textSoft, fontSize: 10 },
  resetLink: { color: C.textMuted, fontSize: 10, textDecorationLine: "underline" },
  expandLink: { color: C.brand, fontSize: 12, fontWeight: "600", marginTop: 4 },
});
