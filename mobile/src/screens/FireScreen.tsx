/**
 * FIRE projection — mobile screen.
 *
 * Phone-friendly cousin of the web FirePanel. We don't ship the full
 * 7-slider editor + fan chart on mobile (too cramped, and the chart
 * needs react-native-svg). Instead:
 *
 *   • Hero stats: FIRE number, median hit age, safe withdrawal rate,
 *     hit-target probability.
 *   • Mode toggle (Gaussian vs Historical S&P) so the user can flip
 *     between models with one tap.
 *   • Read-only display of the assumptions (auto-derived from server).
 *   • Summary text from the server.
 *
 * For deep editing the user opens the web app — we surface that as
 * a footer hint.
 */
import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useQuery } from "@tanstack/react-query";

import {
  api,
  fmtCents,
  type FireSimulationMode,
} from "../api/client";
import { C, cardStyle, headerStyles } from "../theme";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function fmtCompact(cents: number): string {
  const dollars = cents / 100;
  if (Math.abs(dollars) >= 1_000_000) {
    return `$${(dollars / 1_000_000).toFixed(dollars >= 10_000_000 ? 0 : 1)}M`;
  }
  if (Math.abs(dollars) >= 1_000) {
    return `$${(dollars / 1000).toFixed(dollars >= 10_000 ? 0 : 1)}K`;
  }
  return `$${Math.round(dollars).toLocaleString()}`;
}

/** −/+ stepper with hold-to-repeat. We don't want a slider here —
 * the column is too narrow on phones, and discrete steps map well
 * to the way users think about these inputs ("$50/mo more savings"). */
function Stepper({
  label,
  value,
  step,
  min,
  max,
  format,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  step: number;
  min: number;
  max: number;
  format: (n: number) => string;
  onChange: (v: number) => void;
  hint?: string;
}) {
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  return (
    <View style={stepperStyles.wrap}>
      <View style={stepperStyles.row}>
        <Text style={stepperStyles.label}>{label}</Text>
        <View style={stepperStyles.controls}>
          <Pressable
            onPress={() => onChange(clamp(value - step))}
            disabled={value <= min}
            style={({ pressed }) => [
              stepperStyles.btn,
              pressed && stepperStyles.btnPressed,
              value <= min && stepperStyles.btnDisabled,
            ]}
          >
            <Text style={stepperStyles.btnText}>−</Text>
          </Pressable>
          <Text style={stepperStyles.value}>{format(value)}</Text>
          <Pressable
            onPress={() => onChange(clamp(value + step))}
            disabled={value >= max}
            style={({ pressed }) => [
              stepperStyles.btn,
              pressed && stepperStyles.btnPressed,
              value >= max && stepperStyles.btnDisabled,
            ]}
          >
            <Text style={stepperStyles.btnText}>+</Text>
          </Pressable>
        </View>
      </View>
      {hint && <Text style={stepperStyles.hint}>{hint}</Text>}
    </View>
  );
}

/* ------------------------------------------------------------------ */
/*  Main screen                                                        */
/* ------------------------------------------------------------------ */

export default function FireScreen() {
  const [simulationMode, setSimulationMode] =
    useState<FireSimulationMode>("normal");
  const [currentAge, setCurrentAge] = useState(32);
  const [retirementAge, setRetirementAge] = useState(55);
  // Cents-denominated, but we expose dollar steppers; conversion in
  // the format/onChange functions for each Stepper. Default seed
  // values are reasonable; the /defaults endpoint overwrites once.
  const [startingCents, setStartingCents] = useState(50_000_00);
  const [monthlySavings, setMonthlySavings] = useState(2_000_00);
  const [annualSpending, setAnnualSpending] = useState(60_000_00);
  // True after the user touches any value, so the auto-load doesn't
  // overwrite their manual edits.
  const [touched, setTouched] = useState(false);

  const defaults = useQuery({
    queryKey: ["fireDefaults"],
    queryFn: api.fireDefaults,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  // Splice in defaults once they arrive (and only if the user hasn't
  // moved a stepper yet).
  useEffect(() => {
    if (defaults.data && !touched) {
      setStartingCents(defaults.data.starting_cents);
      setMonthlySavings(defaults.data.monthly_savings_cents);
      setAnnualSpending(defaults.data.annual_spending_cents);
    }
  }, [defaults.data, touched]);

  const wrap =
    <T,>(fn: (v: T) => void) =>
    (v: T) => {
      setTouched(true);
      fn(v);
    };

  const proj = useQuery({
    queryKey: [
      "fireProjection-mobile",
      simulationMode,
      currentAge,
      retirementAge,
      startingCents,
      monthlySavings,
      annualSpending,
    ],
    queryFn: () =>
      api.fireProjection({
        current_age: currentAge,
        target_retirement_age: retirementAge,
        starting_cents: startingCents,
        monthly_savings_cents: monthlySavings,
        annual_spending_cents: annualSpending,
        n_trials: 3000,                  // fewer trials on mobile for snappier reload
        simulation_mode: simulationMode,
      }),
    placeholderData: (prev) => prev,
  });

  const isLoading = defaults.isLoading || (defaults.isSuccess && proj.isLoading);
  const onRefresh = () => {
    defaults.refetch();
    proj.refetch();
  };

  const data = proj.data;
  const swr = data?.safe_withdrawal_rate_pct ?? null;

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={isLoading && (defaults.isFetching || proj.isFetching)}
          onRefresh={onRefresh}
          tintColor={C.brand}
        />
      }
    >
      <Text style={headerStyles.h1}>FIRE projection</Text>
      <Text style={headerStyles.sub}>
        When you hit your number — Monte Carlo over your current trajectory.
      </Text>

      {/* Mode toggle */}
      <View style={styles.modeRow}>
        <Pressable
          onPress={() => setSimulationMode("normal")}
          style={[
            styles.modeBtn,
            simulationMode === "normal" && styles.modeBtnActive,
          ]}
        >
          <Text
            style={[
              styles.modeBtnText,
              simulationMode === "normal" && styles.modeBtnTextActive,
            ]}
          >
            Gaussian
          </Text>
        </Pressable>
        <Pressable
          onPress={() => setSimulationMode("historical")}
          style={[
            styles.modeBtn,
            simulationMode === "historical" && styles.modeBtnActive,
          ]}
        >
          <Text
            style={[
              styles.modeBtnText,
              simulationMode === "historical" && styles.modeBtnTextActive,
            ]}
          >
            Historical S&P
          </Text>
        </Pressable>
      </View>

      {isLoading && !data ? (
        <View style={styles.spinner}>
          <ActivityIndicator color={C.brand} />
        </View>
      ) : !data ? (
        <Text style={styles.muted}>Couldn't run simulation.</Text>
      ) : (
        <>
          {/* Hero stat grid — 2x2 */}
          <View style={styles.heroGrid}>
            <View style={[cardStyle.card, styles.heroCard]}>
              <Text style={styles.heroLabel}>FIRE number</Text>
              <Text style={styles.heroValue}>
                {fmtCompact(data.fire_number_cents)}
              </Text>
              <Text style={styles.heroSub}>25× annual spending</Text>
            </View>
            <View style={[cardStyle.card, styles.heroCard]}>
              <Text style={styles.heroLabel}>Median hit age</Text>
              <Text
                style={[
                  styles.heroValue,
                  data.median_hit_age &&
                    data.median_hit_age <= retirementAge && { color: C.inflow },
                  data.median_hit_age &&
                    data.median_hit_age > retirementAge && { color: C.warn },
                  !data.median_hit_age && { color: C.outflow },
                ]}
              >
                {data.median_hit_age ?? "—"}
              </Text>
              <Text style={styles.heroSub}>
                {data.median_hit_age && data.median_hit_age <= retirementAge
                  ? `${retirementAge - data.median_hit_age} yrs early`
                  : data.median_hit_age
                  ? `${data.median_hit_age - retirementAge} yrs late`
                  : "doesn't hit"}
              </Text>
            </View>
            <View style={[cardStyle.card, styles.heroCard]}>
              <Text style={styles.heroLabel}>Safe withdrawal</Text>
              <Text
                style={[
                  styles.heroValue,
                  swr && swr >= 4.0 && { color: C.inflow },
                  swr && swr >= 3.0 && swr < 4.0 && { color: C.warn },
                  swr && swr < 3.0 && { color: C.outflow },
                ]}
              >
                {swr !== null ? `${swr.toFixed(2)}%` : "—"}
              </Text>
              <Text style={styles.heroSub}>95% survival to age 95</Text>
            </View>
            <View style={[cardStyle.card, styles.heroCard]}>
              <Text style={styles.heroLabel}>Hit-target prob.</Text>
              <Text
                style={[
                  styles.heroValue,
                  data.prob_hit_target_by_retirement_pct >= 75 && {
                    color: C.inflow,
                  },
                  data.prob_hit_target_by_retirement_pct >= 50 &&
                    data.prob_hit_target_by_retirement_pct < 75 && {
                      color: C.warn,
                    },
                  data.prob_hit_target_by_retirement_pct < 50 && {
                    color: C.outflow,
                  },
                ]}
              >
                {`${data.prob_hit_target_by_retirement_pct.toFixed(0)}%`}
              </Text>
              <Text style={styles.heroSub}>by age {retirementAge}</Text>
            </View>
          </View>

          {/* Summary text */}
          <View style={[cardStyle.card, { marginTop: 12 }]}>
            <Text style={styles.summaryText}>{data.summary_text}</Text>
          </View>

          {/* Editable assumptions — phone-friendly +/- steppers */}
          <View style={[cardStyle.card, { marginTop: 12 }]}>
            <Text style={styles.sectionTitle}>Assumptions</Text>
            <Stepper
              label="Current age"
              value={currentAge}
              step={1}
              min={18}
              max={80}
              format={(v) => `${v}`}
              onChange={wrap(setCurrentAge)}
            />
            <Stepper
              label="Retire at"
              value={retirementAge}
              step={1}
              min={Math.max(currentAge + 1, 19)}
              max={85}
              format={(v) => `${v}`}
              onChange={wrap(setRetirementAge)}
              hint={`${Math.max(0, retirementAge - currentAge)} yrs to accumulate`}
            />
            <Stepper
              label="Starting NW"
              value={startingCents}
              step={5_000_00}
              min={0}
              max={5_000_000_00}
              format={fmtCompact}
              onChange={wrap(setStartingCents)}
              hint={
                !touched && defaults.data
                  ? "auto from your accounts"
                  : undefined
              }
            />
            <Stepper
              label="Monthly savings"
              value={monthlySavings}
              step={100_00}
              min={0}
              max={50_000_00}
              format={fmtCents}
              onChange={wrap(setMonthlySavings)}
              hint={`${fmtCents(monthlySavings * 12)}/yr`}
            />
            <Stepper
              label="Annual spending"
              value={annualSpending}
              step={2_000_00}
              min={12_000_00}
              max={300_000_00}
              format={fmtCompact}
              onChange={wrap(setAnnualSpending)}
              hint={`FIRE target = ${fmtCompact(annualSpending * 25)}`}
            />
            {data.realized_mean_return_pct !== null && (
              <View style={styles.kvRow}>
                <Text style={styles.kvKey}>
                  {simulationMode === "historical"
                    ? "Realized mean return"
                    : "Mean return (assumed)"}
                </Text>
                <Text style={styles.kvVal}>
                  {data.realized_mean_return_pct.toFixed(2)}%/yr
                </Text>
              </View>
            )}
            {touched && defaults.data && (
              <Pressable
                onPress={() => {
                  setStartingCents(defaults.data!.starting_cents);
                  setMonthlySavings(defaults.data!.monthly_savings_cents);
                  setAnnualSpending(defaults.data!.annual_spending_cents);
                  setTouched(false);
                }}
                style={styles.resetBtn}
              >
                <Text style={styles.resetBtnText}>Reset to my actual data</Text>
              </Pressable>
            )}
          </View>
        </>
      )}
    </ScrollView>
  );
}

/* ------------------------------------------------------------------ */
/*  Styles                                                             */
/* ------------------------------------------------------------------ */

const styles = StyleSheet.create({
  scroll: { backgroundColor: C.bg, flex: 1 },
  content: { padding: 16, paddingBottom: 80 },
  spinner: { padding: 36, alignItems: "center" },
  muted: { color: C.textMuted, textAlign: "center", padding: 24 },

  modeRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 12,
    marginBottom: 12,
  },
  modeBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.card,
    alignItems: "center",
  },
  modeBtnActive: {
    backgroundColor: C.brand,
    borderColor: C.brand,
  },
  modeBtnText: { color: C.textMuted, fontSize: 12, fontWeight: "600" },
  modeBtnTextActive: { color: "#fff" },

  heroGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  heroCard: {
    flexBasis: "48%",
    flexGrow: 1,
    padding: 12,
  },
  heroLabel: {
    color: C.textMuted,
    fontSize: 10,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  heroValue: {
    color: C.text,
    fontSize: 22,
    fontWeight: "700",
    marginTop: 4,
    fontVariant: ["tabular-nums"],
  },
  heroSub: {
    color: C.textSoft,
    fontSize: 11,
    marginTop: 2,
  },

  summaryText: {
    color: C.text,
    fontSize: 13,
    lineHeight: 19,
  },

  sectionTitle: {
    color: C.text,
    fontSize: 13,
    fontWeight: "700",
    marginBottom: 8,
  },
  kvRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  kvKey: { color: C.textMuted, fontSize: 12 },
  kvVal: {
    color: C.text,
    fontSize: 13,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },

  footnote: {
    color: C.textSoft,
    fontSize: 11,
    marginTop: 16,
    textAlign: "center",
    fontStyle: "italic",
  },

  resetBtn: {
    paddingVertical: 8,
    alignItems: "center",
    marginTop: 4,
  },
  resetBtnText: { color: C.brand, fontSize: 12, fontWeight: "600" },
});

const stepperStyles = StyleSheet.create({
  wrap: {
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  label: {
    color: C.textMuted,
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    flex: 1,
  },
  controls: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  btn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.card,
    alignItems: "center",
    justifyContent: "center",
  },
  btnPressed: { backgroundColor: C.hover, borderColor: C.brand },
  btnDisabled: { opacity: 0.35 },
  btnText: { color: C.brand, fontSize: 18, fontWeight: "700", lineHeight: 22 },
  value: {
    minWidth: 78,
    textAlign: "center",
    color: C.text,
    fontSize: 13,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  hint: {
    color: C.textSoft,
    fontSize: 10,
    marginTop: 2,
    fontStyle: "italic",
  },
});
