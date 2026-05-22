/**
 * Mobile parity for Sprint H/I/J/K/L Budgets revamp.
 *
 * Three components ported from web:
 *   1. SafeToSpendHero        — anchor "Money I can still spend" + day-pace
 *   2. BudgetStatStrip        — 5 compact cards (Income / Available / Saved /
 *                                Variable / EOM) — scrolls horizontally on
 *                                narrow screens
 *   3. MobileAssignmentLedger — "The plan" read-only zero-based ledger with
 *                                tap-to-expand groups
 *
 * Read-only on mobile for v1 — the rebalance modal and inline edit
 * (web L-3, L-4) are desktop-only for now. Mobile gets a "Manage in web app"
 * hint when the user taps a row, pointing back to the web flow.
 */
import React, { useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useQuery } from "@tanstack/react-query";

import {
  api,
  fmtCents,
  type AssignmentLedger,
  type BudgetRollup,
} from "../api/client";
import { C, cardStyle } from "../theme";

/* ============================================================== */
/*  1. SafeToSpendHero                                              */
/* ============================================================== */

interface HeroProps {
  data: BudgetRollup;
  monthStart: string;
}

export function SafeToSpendHero({ data, monthStart }: HeroProps) {
  const safe = data.safe_to_spend_cents ?? 0;
  const pace = data.pace ?? 0;
  const daysLeft = _daysRemaining(monthStart, pace);
  const dailyRate = daysLeft > 0 ? safe / daysLeft : 0;
  const isPositive = safe >= 0;
  return (
    <View style={[cardStyle.card, heroStyles.card]}>
      <Text style={heroStyles.label}>SAFE TO SPEND THIS MONTH</Text>
      <Text
        style={[
          heroStyles.amount,
          { color: isPositive ? C.inflow : C.outflow },
        ]}
      >
        {fmtCents(safe)}
      </Text>
      <View style={heroStyles.subRow}>
        <Text style={heroStyles.sub}>
          {Math.round((pace ?? 0) * 100)}% through month
        </Text>
        <Text style={heroStyles.sub}>
          {daysLeft} day{daysLeft === 1 ? "" : "s"} left
        </Text>
      </View>
      <Text style={heroStyles.dailyHint}>
        {isPositive
          ? `≈ ${fmtCents(Math.round(dailyRate))} / day to stay on track`
          : `${fmtCents(Math.abs(safe))} over already — bills coming will push deeper`}
      </Text>
      {/* Pace bar */}
      <View style={heroStyles.barTrack}>
        <View
          style={[
            heroStyles.barFill,
            {
              width: `${Math.min(100, (pace ?? 0) * 100)}%`,
              backgroundColor: isPositive ? C.inflow : C.outflow,
            },
          ]}
        />
      </View>
    </View>
  );
}

function _daysRemaining(monthStart: string, pace: number): number {
  // Reverse-engineer days-left from pace: pace = elapsed / total
  // → total - elapsed = total * (1 - pace). We don't know total exactly,
  // but for typical 30/31 day months a good approximation is:
  const today = new Date();
  const ms = new Date(monthStart + "T00:00:00");
  const nextMonth = new Date(ms.getFullYear(), ms.getMonth() + 1, 1);
  const lastDayMs = nextMonth.getTime() - 86_400_000;
  const todayMs = today.getTime();
  if (todayMs > lastDayMs) return 0;
  return Math.max(0, Math.round((lastDayMs - todayMs) / 86_400_000));
}

const heroStyles = StyleSheet.create({
  card: { padding: 16, marginTop: 8 },
  label: {
    color: C.textMuted,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1.2,
    marginBottom: 4,
  },
  amount: { fontSize: 36, fontWeight: "700", letterSpacing: -0.5 },
  subRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 6,
  },
  sub: { fontSize: 12, color: C.textSoft },
  dailyHint: { fontSize: 11, color: C.textMuted, marginTop: 2 },
  barTrack: {
    height: 6,
    backgroundColor: "#e5e7eb",
    borderRadius: 3,
    marginTop: 10,
    overflow: "hidden",
  },
  barFill: { height: "100%", borderRadius: 3 },
});

/* ============================================================== */
/*  2. BudgetStatStrip — horizontal-scroll 5 cards                  */
/* ============================================================== */

interface StripProps {
  data: BudgetRollup;
}

export function BudgetStatStrip({ data }: StripProps) {
  // Latest paycheck info for the Income card sub-line.
  const paycheckCents = data.latest_paycheck_cents ?? null;
  const paycheckDaysAgo = data.latest_paycheck_days_ago ?? null;
  const paycheckText =
    paycheckCents != null && paycheckDaysAgo != null
      ? paycheckDaysAgo === 0
        ? `Last: ${fmtCents(paycheckCents)} today`
        : paycheckDaysAgo === 1
          ? `Last: ${fmtCents(paycheckCents)} yesterday`
          : `Last: ${fmtCents(paycheckCents)} · ${paycheckDaysAgo}d ago`
      : null;

  // Available cash components.
  const available = data.available_cash_cents ?? 0;
  const liquid = data.liquid_balance_cents ?? 0;
  const expectedIncome = data.expected_remaining_income_cents ?? 0;
  const committedDue = data.committed_remaining_cents ?? 0;
  const availableSub = (() => {
    const parts = [`${fmtCents(liquid)} checking`];
    if (expectedIncome > 0) parts.push(`+${fmtCents(expectedIncome)} paycheck`);
    if (committedDue > 0) parts.push(`−${fmtCents(committedDue)} bills`);
    return parts.join(" · ");
  })();

  const eTrade = data.savings_actual_etrade_cents ?? 0;
  const otherSavings = data.savings_actual_other_cents ?? 0;
  const savingsGoal = data.savings_goal_target_cents ?? 0;
  const savedPrimary = `${fmtCents(eTrade)} / ${fmtCents(savingsGoal)}`;
  const savedSub = otherSavings > 0
    ? `+${fmtCents(otherSavings)} bonus`
    : eTrade >= savingsGoal && savingsGoal > 0
      ? "Goal hit ✓"
      : "behind";

  const variableSpent = Math.max(
    0,
    (data.real_actual_cents ?? 0) +
      (data.unbudgeted_actual_cents ?? 0) -
      (data.committed_caps_total_cents ?? 0),
  );

  const eomNet = data.eom_projected_net_flow_cents ?? 0;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={stripStyles.row}
      style={{ marginTop: 10 }}
    >
      <StatCard
        label="INCOME"
        primary={fmtCents(data.recurring_income_cents ?? 0)}
        secondary={paycheckText ?? `${fmtCents(data.monthly_income_cents ?? 0)} / mo`}
        tone="neutral"
      />
      <StatCard
        label="AVAILABLE CASH"
        primary={fmtCents(available)}
        secondary={availableSub}
        tone={available > 50_00 ? "good" : available > 0 ? "neutral" : "bad"}
      />
      <StatCard
        label="SAVED"
        primary={savedPrimary}
        secondary={savedSub}
        tone={eTrade >= savingsGoal && savingsGoal > 0 ? "good" : "warn"}
      />
      <StatCard
        label="VARIABLE SPENT"
        primary={fmtCents(variableSpent)}
        secondary="vs 3-mo avg"
        tone="neutral"
      />
      <StatCard
        label="EOM PROJECTION"
        primary={`${eomNet >= 0 ? "+" : ""}${fmtCents(eomNet)}`}
        secondary={
          eomNet >= 0
            ? "End the month net positive"
            : "End the month burning savings"
        }
        tone={eomNet >= 0 ? "good" : "bad"}
      />
    </ScrollView>
  );
}

function StatCard({
  label,
  primary,
  secondary,
  tone,
}: {
  label: string;
  primary: string;
  secondary: string;
  tone: "good" | "warn" | "bad" | "neutral";
}) {
  const toneColor =
    tone === "good"
      ? C.inflow
      : tone === "bad"
        ? C.outflow
        : tone === "warn"
          ? C.warn
          : C.text;
  return (
    <View style={stripStyles.card}>
      <Text style={stripStyles.label}>{label}</Text>
      <Text style={[stripStyles.primary, { color: toneColor }]}>{primary}</Text>
      <Text style={stripStyles.secondary} numberOfLines={2}>
        {secondary}
      </Text>
    </View>
  );
}

const stripStyles = StyleSheet.create({
  row: { gap: 8, paddingHorizontal: 2 },
  card: {
    backgroundColor: C.card,
    borderColor: C.border,
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    width: 160,
  },
  label: {
    color: C.textMuted,
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 1,
  },
  primary: {
    fontSize: 18,
    fontWeight: "700",
    marginTop: 4,
    letterSpacing: -0.3,
  },
  secondary: { color: C.textSoft, fontSize: 10, marginTop: 2 },
});

/* ============================================================== */
/*  3. MobileAssignmentLedger — "The plan" read-only                */
/* ============================================================== */

const KIND_COLOR: Record<string, string> = {
  committed: "#3b82f6",
  variable: "#f59e0b",
  savings: "#10b981",
  debt: "#ef4444",
  unbudgeted_actual: "#94a3b8",
};

const KIND_ICON: Record<string, string> = {
  committed: "🏠",
  variable: "🛍️",
  savings: "💰",
  debt: "💳",
  unbudgeted_actual: "❓",
};

interface MobileLedgerProps {
  monthStart: string;
}

export function MobileAssignmentLedger({ monthStart }: MobileLedgerProps) {
  const q = useQuery({
    queryKey: ["assignmentLedger", monthStart],
    queryFn: () => api.budgetAssignmentLedger(monthStart),
  });

  if (q.isLoading) {
    return (
      <View style={[cardStyle.card, ledgerStyles.card]}>
        <Text style={ledgerStyles.title}>The plan</Text>
        <Text style={ledgerStyles.sub}>Loading…</Text>
      </View>
    );
  }
  if (q.isError || !q.data) return null;

  const d = q.data;
  const income = d.income_cents;
  const unassigned = d.unassigned_cents;

  return (
    <View style={[cardStyle.card, ledgerStyles.card]}>
      <Text style={ledgerStyles.title}>The plan</Text>
      <Text style={ledgerStyles.sub}>
        Every dollar of recurring income gets a job.
      </Text>

      <View style={ledgerStyles.incomeRow}>
        <Text style={ledgerStyles.incomeLabel}>INCOME (RECURRING)</Text>
        <Text style={ledgerStyles.incomeAmount}>{fmtCents(income)}</Text>
      </View>

      {/* Stacked allocation bar */}
      <View style={ledgerStyles.barRow}>
        {d.groups
          .filter((g) => g.kind !== "unbudgeted_actual" && g.planned_cents > 0)
          .map((g, idx) => {
            const pct = income > 0 ? (g.planned_cents / income) * 100 : 0;
            return (
              <View
                key={g.kind + idx}
                style={{
                  width: `${Math.min(100, pct)}%`,
                  height: "100%",
                  backgroundColor: KIND_COLOR[g.kind] ?? "#94a3b8",
                }}
              />
            );
          })}
      </View>

      {/* Groups list */}
      {d.groups.map((g) => (
        <LedgerGroup key={g.kind} group={g} />
      ))}

      {/* Totals */}
      <View style={ledgerStyles.totalRow}>
        <Text style={ledgerStyles.totalLabel}>Total assigned</Text>
        <Text style={ledgerStyles.totalValue}>
          {fmtCents(d.total_planned_cents)}
        </Text>
      </View>
      <View
        style={[
          ledgerStyles.totalRow,
          {
            backgroundColor:
              unassigned >= 0 ? "rgba(16,185,129,0.08)" : "rgba(239,68,68,0.08)",
            paddingHorizontal: 8,
            paddingVertical: 6,
            borderRadius: 6,
            marginTop: 4,
          },
        ]}
      >
        <Text
          style={[
            ledgerStyles.totalLabel,
            {
              fontWeight: "700",
              color: unassigned >= 0 ? C.inflow : C.outflow,
              fontSize: 13,
            },
          ]}
        >
          {unassigned >= 0 ? "Unassigned" : "Over-committed"}
        </Text>
        <Text
          style={[
            ledgerStyles.totalValue,
            {
              color: unassigned >= 0 ? C.inflow : C.outflow,
              fontSize: 15,
              fontWeight: "700",
            },
          ]}
        >
          {unassigned >= 0 ? "+" : "−"}
          {fmtCents(Math.abs(unassigned))}
        </Text>
      </View>

      {unassigned > 50_00 && (
        <Text style={ledgerStyles.hint}>
          💡 {fmtCents(unassigned)} of income has no job — open the web app to allocate it.
        </Text>
      )}
    </View>
  );
}

function LedgerGroup({ group }: { group: AssignmentLedger["groups"][0] }) {
  const [open, setOpen] = useState(false);
  const isUnbudgeted = group.kind === "unbudgeted_actual";
  return (
    <View style={ledgerStyles.groupWrap}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        style={({ pressed }) => [
          ledgerStyles.groupHeader,
          pressed && { backgroundColor: "rgba(0,0,0,0.04)" },
        ]}
      >
        <Text style={ledgerStyles.groupIcon}>{KIND_ICON[group.kind] ?? "•"}</Text>
        <View
          style={{
            width: 3,
            height: 20,
            backgroundColor: KIND_COLOR[group.kind] ?? "#94a3b8",
            borderRadius: 2,
            marginRight: 8,
          }}
        />
        <View style={{ flex: 1 }}>
          <Text style={ledgerStyles.groupLabel}>{group.label}</Text>
          <Text style={ledgerStyles.groupSub}>
            {group.items.length} line{group.items.length === 1 ? "" : "s"}
          </Text>
        </View>
        <Text style={ledgerStyles.groupAmount}>
          {fmtCents(isUnbudgeted ? group.actual_cents : group.planned_cents)}
        </Text>
        <Text style={ledgerStyles.chevron}>{open ? "▾" : "▸"}</Text>
      </Pressable>
      {open && (
        <View style={ledgerStyles.itemsBox}>
          {group.items.map((item, idx) => (
            <View
              key={`${group.kind}-${item.label}-${idx}`}
              style={ledgerStyles.itemRow}
            >
              <Text style={ledgerStyles.itemLabel} numberOfLines={1}>
                {item.label}
                {item.is_paid && (
                  <Text style={ledgerStyles.paidBadge}> · paid ✓</Text>
                )}
              </Text>
              <Text style={ledgerStyles.itemAmount}>
                {fmtCents(
                  isUnbudgeted ? item.actual_cents : item.planned_cents,
                )}
              </Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const ledgerStyles = StyleSheet.create({
  card: { padding: 14, marginTop: 12 },
  title: { color: C.text, fontSize: 14, fontWeight: "600" },
  sub: { color: C.textSoft, fontSize: 11, marginTop: 2 },
  incomeRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    marginTop: 12,
  },
  incomeLabel: {
    color: C.textMuted,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1,
  },
  incomeAmount: {
    fontSize: 20,
    fontWeight: "700",
    color: C.text,
    letterSpacing: -0.3,
  },
  barRow: {
    flexDirection: "row",
    height: 10,
    backgroundColor: "#e5e7eb",
    borderRadius: 4,
    marginTop: 6,
    overflow: "hidden",
  },
  groupWrap: {
    borderColor: C.border,
    borderWidth: 1,
    borderRadius: 6,
    overflow: "hidden",
    marginTop: 6,
  },
  groupHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: C.card,
  },
  groupIcon: { fontSize: 14, marginRight: 6 },
  groupLabel: { color: C.text, fontSize: 13, fontWeight: "600" },
  groupSub: { color: C.textMuted, fontSize: 10 },
  groupAmount: {
    color: C.text,
    fontSize: 13,
    fontWeight: "700",
    marginRight: 6,
  },
  chevron: { color: C.textMuted, fontSize: 10 },
  itemsBox: {
    borderTopWidth: 1,
    borderTopColor: C.border,
    backgroundColor: "rgba(248,250,252,0.5)",
  },
  itemRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.border,
  },
  itemLabel: { color: C.text, fontSize: 12, flex: 1, marginRight: 8 },
  paidBadge: { color: C.inflow, fontSize: 10, fontWeight: "700" },
  itemAmount: { color: C.text, fontSize: 12, fontWeight: "600" },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 8,
  },
  totalLabel: { color: C.textSoft, fontSize: 12 },
  totalValue: {
    color: C.text,
    fontSize: 13,
    fontWeight: "600",
  },
  hint: {
    color: C.textMuted,
    fontSize: 11,
    marginTop: 8,
    lineHeight: 16,
  },
});
