/**
 * Credit — mobile screen.
 *
 * Three sections phone-tuned:
 *   • Score hero — latest score with trend dot, plus mini sparkline
 *   • Utilization — aggregate + per-card with FICO cliff bars
 *   • Opportunities — ranked actions with estimated score delta
 *
 * The web CreditPanel splits utilization + opportunities + score
 * history into separate columns. On phone we vertical-stack so
 * each section is fully scannable.
 */
import React from "react";
import {
  ActivityIndicator,
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
  type CreditOpportunity,
  type CreditScore,
  type UtilizationRow,
} from "../api/client";
import { C, cardStyle, fmtRelativeDate, headerStyles } from "../theme";

/* ------------------------------------------------------------------ */
/*  Score sparkline (mini bars)                                        */
/* ------------------------------------------------------------------ */

function ScoreSparkline({ scores }: { scores: CreditScore[] }) {
  if (scores.length < 2) {
    return (
      <View style={styles.sparkPlaceholder}>
        <Text style={styles.sparkPlaceholderText}>
          Need at least 2 scores logged for a trend.
        </Text>
      </View>
    );
  }
  // Sort oldest→newest so the bars read left to right.
  const sorted = scores.slice().sort((a, b) => a.as_of.localeCompare(b.as_of));
  const values = sorted.map((s) => s.score);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  return (
    <View style={styles.sparkRow}>
      {values.map((v, i) => {
        const h = ((v - min) / range) * 32 + 4;
        return (
          <View key={i} style={styles.sparkBarWrap}>
            <View
              style={[
                styles.sparkBar,
                {
                  height: h,
                  backgroundColor:
                    i === values.length - 1 ? C.brandAccent : C.brandLight,
                },
              ]}
            />
          </View>
        );
      })}
    </View>
  );
}

/* ------------------------------------------------------------------ */
/*  Utilization row                                                    */
/* ------------------------------------------------------------------ */

function utilTone(pct: number | null): string {
  if (pct == null) return C.textMuted;
  if (pct >= 75) return C.outflow;
  if (pct >= 30) return C.warn;
  if (pct >= 10) return "#1e40af";
  return C.inflow;
}

function UtilCardRow({ row }: { row: UtilizationRow }) {
  const reported = row.reported_utilization_pct;
  const live = row.live_utilization_pct;
  const tone = utilTone(reported);
  return (
    <View style={styles.utilRow}>
      <View style={styles.utilHeader}>
        <Text style={styles.utilName} numberOfLines={1}>{row.account_name}</Text>
        <Text style={[styles.utilPct, { color: tone }]}>
          {reported != null ? `${reported.toFixed(0)}%` : "—"}
        </Text>
      </View>
      <UtilBar pct={reported ?? 0} />
      <View style={styles.utilFooter}>
        <Text style={styles.utilFooterText}>
          {fmtCents(row.last_statement_balance_cents)} / {fmtCents(row.credit_limit_cents)}
          {live != null && ` · live ${live.toFixed(0)}%`}
        </Text>
        {row.statement_close_day && (
          <Text style={styles.utilFooterText}>
            close {row.statement_close_day} · {row.days_until_close}d
          </Text>
        )}
      </View>
    </View>
  );
}

function UtilBar({ pct }: { pct: number }) {
  // Cliff markers at 1/10/30/50/75 — mirrors web CreditPanel.
  const clamped = Math.min(100, Math.max(0, pct));
  return (
    <View style={styles.utilBarTrack}>
      <View
        style={[
          styles.utilBarFill,
          { width: `${clamped}%`, backgroundColor: utilTone(pct) },
        ]}
      />
      {[1, 10, 30, 50, 75].map((c) => (
        <View
          key={c}
          style={[styles.utilBarCliff, { left: `${c}%` }]}
        />
      ))}
    </View>
  );
}

/* ------------------------------------------------------------------ */
/*  Opportunity card                                                   */
/* ------------------------------------------------------------------ */

function OpportunityCard({ op }: { op: CreditOpportunity }) {
  return (
    <View style={styles.oppCard}>
      <View style={styles.oppHeader}>
        <Text style={styles.oppTitle} numberOfLines={2}>{op.title}</Text>
        {op.estimated_score_delta != null && (
          <View style={[styles.deltaPill, { backgroundColor: op.estimated_score_delta >= 0 ? "#d1fae5" : "#fee2e2" }]}>
            <Text style={[styles.deltaPillText, { color: op.estimated_score_delta >= 0 ? "#065f46" : "#991b1b" }]}>
              {op.estimated_score_delta >= 0 ? "+" : ""}{op.estimated_score_delta} pts
            </Text>
          </View>
        )}
      </View>
      <Text style={styles.oppRationale} numberOfLines={3}>{op.rationale}</Text>
      {op.account_name && (
        <Text style={styles.oppAccount}>{op.account_name}</Text>
      )}
      {op.action_steps.length > 0 && (
        <View style={styles.actionSteps}>
          {op.action_steps.slice(0, 3).map((step, i) => (
            <Text key={i} style={styles.actionStep} numberOfLines={2}>
              {i + 1}. {step}
            </Text>
          ))}
        </View>
      )}
      <View style={styles.oppFooter}>
        <Text style={styles.oppFooterText}>
          {Math.round(op.confidence * 100)}% confident
          {op.urgency_days != null && ` · ${op.urgency_days}d window`}
        </Text>
      </View>
    </View>
  );
}

/* ------------------------------------------------------------------ */
/*  Screen                                                             */
/* ------------------------------------------------------------------ */

export default function CreditScreen() {
  const scores = useQuery({ queryKey: ["creditScores"], queryFn: () => api.listCreditScores(20) });
  const util = useQuery({ queryKey: ["creditUtil"], queryFn: api.creditUtilization });
  const ops = useQuery({ queryKey: ["creditOps"], queryFn: api.creditOpportunities });

  const refetchAll = () => { scores.refetch(); util.refetch(); ops.refetch(); };

  const latest = scores.data?.slice().sort((a, b) => b.as_of.localeCompare(a.as_of))[0];
  const prior = scores.data?.slice().sort((a, b) => b.as_of.localeCompare(a.as_of))[1];
  const delta = latest && prior ? latest.score - prior.score : null;

  if (scores.isLoading || util.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={C.brand} />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={headerStyles.header}>
        <Text style={headerStyles.headerTitle}>Credit</Text>
        <Text style={headerStyles.headerSub}>
          {latest ? `${latest.bureau} · last seen ${fmtRelativeDate(latest.as_of)}` : "No score logs yet"}
        </Text>
      </View>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={scores.isFetching || util.isFetching || ops.isFetching}
            onRefresh={refetchAll}
            tintColor={C.brand}
          />
        }
      >
        {/* Hero — score */}
        <View style={[cardStyle.card, styles.hero]}>
          <Text style={styles.heroLabel}>Latest score</Text>
          <View style={styles.heroRow}>
            <Text style={styles.heroAmount}>{latest?.score ?? "—"}</Text>
            {delta != null && (
              <Text style={[styles.heroDelta, { color: delta >= 0 ? "#86efac" : "#fda4af" }]}>
                {delta > 0 ? "+" : ""}{delta} since last
              </Text>
            )}
          </View>
          <ScoreSparkline scores={scores.data ?? []} />
        </View>

        {/* Utilization */}
        <View style={cardStyle.card}>
          <Text style={styles.sectionTitle}>Utilization</Text>
          {util.data ? (
            <>
              <Text style={styles.aggregateText}>
                Aggregate: <Text style={[styles.aggregateValue, { color: utilTone(util.data.aggregate_reported_utilization_pct) }]}>
                  {util.data.aggregate_reported_utilization_pct != null
                    ? `${util.data.aggregate_reported_utilization_pct.toFixed(1)}%`
                    : "—"}
                </Text>
                {" "}— {fmtCents(util.data.total_reported_balance_cents)} of {fmtCents(util.data.total_limit_cents)}
              </Text>
              <View style={styles.utilList}>
                {util.data.rows.length === 0 ? (
                  <Text style={styles.hint}>
                    No credit cards tracked. Connect a card account on the web app.
                  </Text>
                ) : (
                  util.data.rows.map((r) => <UtilCardRow key={r.account_id} row={r} />)
                )}
              </View>
            </>
          ) : null}
        </View>

        {/* Opportunities */}
        {ops.data && ops.data.opportunities.length > 0 && (
          <View style={cardStyle.card}>
            <Text style={styles.sectionTitle}>Opportunities</Text>
            <Text style={styles.sectionHint}>
              Ranked by estimated score delta. No money moves — you execute each yourself.
            </Text>
            {ops.data.opportunities.map((op, i) => (
              <OpportunityCard key={i} op={op} />
            ))}
          </View>
        )}

        {(!ops.data || ops.data.opportunities.length === 0) && (
          <View style={cardStyle.card}>
            <Text style={styles.hint}>
              No opportunities right now. Either everything's optimized, or you haven't connected enough credit accounts yet.
            </Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, padding: 24, alignItems: "center", justifyContent: "center" },
  hint: { color: C.textMuted, fontSize: 13, textAlign: "center", padding: 12 },
  content: { padding: 16, paddingBottom: 32 },

  hero: { backgroundColor: C.brand, marginBottom: 12 },
  heroLabel: { color: C.brandLight, fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5 },
  heroRow: { flexDirection: "row", alignItems: "baseline", marginTop: 4 },
  heroAmount: { color: "#fff", fontSize: 40, fontWeight: "700" },
  heroDelta: { fontSize: 12, marginLeft: 12, fontWeight: "600" },
  sparkRow: { flexDirection: "row", alignItems: "flex-end", height: 40, marginTop: 12 },
  sparkBarWrap: { flex: 1, justifyContent: "flex-end", marginRight: 1 },
  sparkBar: { width: "100%", borderRadius: 1 },
  sparkPlaceholder: { padding: 8, marginTop: 8 },
  sparkPlaceholderText: { color: C.brandLight, fontSize: 11, fontStyle: "italic" },

  sectionTitle: { color: C.text, fontSize: 14, fontWeight: "600", marginBottom: 8 },
  sectionHint: { color: C.textSoft, fontSize: 11, marginBottom: 12, marginTop: -4 },
  aggregateText: { color: C.text, fontSize: 13, marginBottom: 12 },
  aggregateValue: { fontSize: 16, fontWeight: "700" },

  utilList: { marginTop: 4 },
  utilRow: { paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.borderSoft },
  utilHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  utilName: { color: C.text, fontSize: 13, fontWeight: "500", flex: 1, paddingRight: 8 },
  utilPct: { fontSize: 14, fontWeight: "700" },
  utilBarTrack: {
    position: "relative",
    height: 8,
    backgroundColor: C.borderSoft,
    borderRadius: 4,
    marginTop: 6,
    overflow: "hidden",
  },
  utilBarFill: { height: "100%", borderRadius: 4 },
  utilBarCliff: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 1,
    backgroundColor: "rgba(15, 23, 42, 0.25)",
  },
  utilFooter: { flexDirection: "row", justifyContent: "space-between", marginTop: 4 },
  utilFooterText: { color: C.textSoft, fontSize: 11 },

  oppCard: {
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.borderSoft,
  },
  oppHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  oppTitle: { color: C.text, fontSize: 14, fontWeight: "600", flex: 1, paddingRight: 8 },
  deltaPill: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  deltaPillText: { fontSize: 10, fontWeight: "700" },
  oppRationale: { color: C.textMuted, fontSize: 12, marginTop: 4, lineHeight: 17 },
  oppAccount: { color: C.textSoft, fontSize: 11, marginTop: 4, fontStyle: "italic" },
  actionSteps: { marginTop: 8 },
  actionStep: { color: C.text, fontSize: 11, lineHeight: 16, marginTop: 2 },
  oppFooter: { marginTop: 6 },
  oppFooterText: { color: C.textSoft, fontSize: 11 },
});
