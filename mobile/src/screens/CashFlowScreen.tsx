/**
 * Cash Flow forecast — mobile screen.
 *
 * Phone view of the rolling 30-day forecast:
 *   • Top stat row: starting balance, crunch days, paycheck cadence
 *   • Upcoming events list — paychecks/bills/subscriptions ordered by date
 *
 * The web panel includes a running-balance chart; that requires SVG
 * which would add a dep on phone. The crunch-day count + the
 * per-day balance shown on each event row carry the same signal.
 */
import React, { useMemo } from "react";
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useQuery } from "@tanstack/react-query";

import {
  api,
  fmtCents,
  type CashFlowEvent,
  type UpcomingAnnual,
} from "../api/client";
import { C, cardStyle, fmtShortDate, headerStyles } from "../theme";

const KIND_BG: Record<string, string> = {
  paycheck: "#d1fae5",
  bill: "#fee2e2",
  subscription: "#fef3c7",
  transfer: "#e0e7ff",
};
const KIND_FG: Record<string, string> = {
  paycheck: "#065f46",
  bill: "#991b1b",
  subscription: "#92400e",
  transfer: "#3730a3",
};

function EventRow({ e }: { e: CashFlowEvent }) {
  const isOutflow = e.amount_cents < 0;
  const bg = KIND_BG[e.kind] ?? "#e2e8f0";
  const fg = KIND_FG[e.kind] ?? "#334155";
  return (
    <View style={styles.eventRow}>
      <View style={styles.eventDate}>
        <Text style={styles.eventDateText}>{fmtShortDate(e.on_date)}</Text>
      </View>
      <View style={styles.eventMain}>
        <View style={styles.eventLabelRow}>
          <View style={[styles.kindPill, { backgroundColor: bg }]}>
            <Text style={[styles.kindPillText, { color: fg }]}>
              {e.kind}
            </Text>
          </View>
          <Text style={styles.eventLabel} numberOfLines={1}>
            {e.label}
          </Text>
        </View>
        {e.notes ? (
          <Text style={styles.eventNotes} numberOfLines={1}>
            {e.notes}
          </Text>
        ) : null}
      </View>
      <Text
        style={[
          styles.eventAmount,
          { color: isOutflow ? C.outflow : C.inflow },
        ]}
      >
        {isOutflow ? "" : "+"}{fmtCents(e.amount_cents)}
      </Text>
    </View>
  );
}

/**
 * Sprint 48 — mobile parity for the web "Coming up — annual renewals"
 * card. Surfaces subscription renewals that fall 1–12 months out so
 * the user can see Truthly / ESPN+ / Settlemate before they hit the
 * 30-day window. Self-hides when the backend returns zero events
 * (most likely for users who haven't unmasked Apple/Google children).
 *
 * Groups events by calendar month for scan-ability — "everything in
 * June" is easier to absorb on a phone than a flat date-sorted list.
 */
function ComingUpAnnuals() {
  const q = useQuery({
    queryKey: ["upcomingAnnuals", 365],
    queryFn: () => api.upcomingAnnuals(365),
    staleTime: 5 * 60 * 1000,
  });
  // Rules-of-hooks: useMemo must run on every render path, so we group
  // BEFORE the empty-state short-circuit and just return an empty map
  // when there's no data yet.
  const byMonth = useMemo(() => {
    const m = new Map<string, UpcomingAnnual[]>();
    for (const e of q.data?.events ?? []) {
      const k = e.on_date.slice(0, 7); // YYYY-MM
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(e);
    }
    return m;
  }, [q.data]);
  if (!q.data || q.data.events.length === 0) return null;
  const monthLabel = (k: string) => {
    const [yyyy, mm] = k.split("-");
    const d = new Date(Number(yyyy), Number(mm) - 1, 1);
    return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  };
  return (
    <View style={annualStyles.wrap}>
      <View style={annualStyles.header}>
        <View style={{ flex: 1 }}>
          <Text style={annualStyles.title}>Coming up — annual renewals</Text>
          <Text style={annualStyles.subtitle}>
            Next 12 months · charges beyond the 30-day window
          </Text>
        </View>
        <View style={{ alignItems: "flex-end" }}>
          <Text style={annualStyles.totalLabel}>12-mo total</Text>
          <Text style={annualStyles.totalValue}>
            {fmtCents(-q.data.total_outflow_cents)}
          </Text>
        </View>
      </View>
      {Array.from(byMonth.entries()).map(([month, events]) => (
        <View key={month}>
          <Text style={annualStyles.monthLabel}>
            {monthLabel(month).toUpperCase()}
          </Text>
          {events.map((e, i) => (
            <View
              key={`${e.subscription_id ?? "?"}-${e.on_date}-${i}`}
              style={annualStyles.row}
            >
              <Text style={annualStyles.rowDate}>
                {new Date(e.on_date).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                })}
              </Text>
              <View style={annualStyles.rowMain}>
                <Text style={annualStyles.rowLabel} numberOfLines={1}>
                  {e.label}
                </Text>
                <Text style={annualStyles.rowMeta}>
                  in {e.days_out} day{e.days_out === 1 ? "" : "s"}
                  {e.confidence < 0.7
                    ? ` · ${Math.round(e.confidence * 100)}% confidence`
                    : ""}
                </Text>
              </View>
              <Text style={annualStyles.rowAmount}>
                {fmtCents(e.amount_cents)}
              </Text>
            </View>
          ))}
        </View>
      ))}
      <Text style={annualStyles.tip}>
        Tip: pair this with the Subscriptions tab's unmask flow on Apple
        / Google children to surface every annual you actually pay.
      </Text>
    </View>
  );
}

export default function CashFlowScreen() {
  const q = useQuery({
    queryKey: ["cashFlowForecast", 30],
    queryFn: () => api.cashFlowForecast(30),
  });

  const sortedEvents = useMemo(() => {
    return (q.data?.events ?? [])
      .slice()
      .sort((a, b) => a.on_date.localeCompare(b.on_date));
  }, [q.data]);

  if (q.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={C.brand} />
      </View>
    );
  }
  if (q.isError) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorTitle}>Couldn't load</Text>
        <Text style={styles.errorBody}>{(q.error as Error).message}</Text>
      </View>
    );
  }

  const f = q.data;
  const crunch = f?.crunch_days?.length ?? 0;

  return (
    <View style={styles.screen}>
      <View style={headerStyles.header}>
        <Text style={headerStyles.headerTitle}>Cash flow</Text>
        <Text style={headerStyles.headerSub}>
          {f?.window_start} → {f?.window_end}
        </Text>
      </View>

      <FlatList
        ListFooterComponent={<ComingUpAnnuals />}
        ListHeaderComponent={
          <View style={styles.headerCards}>
            <View style={[cardStyle.card, styles.statRow]}>
              <View style={styles.stat}>
                <Text style={styles.statLabel}>Starting balance</Text>
                <Text style={styles.statValue}>
                  {fmtCents(f?.starting_balance_cents ?? 0)}
                </Text>
              </View>
              <View style={styles.statDivider} />
              <View style={styles.stat}>
                <Text style={styles.statLabel}>Crunch days</Text>
                <Text
                  style={[
                    styles.statValue,
                    { color: crunch > 0 ? C.outflow : C.inflow },
                  ]}
                >
                  {crunch}
                </Text>
                <Text style={styles.statHint}>
                  {crunch > 0 ? "balance dips below threshold" : "no projected dips"}
                </Text>
              </View>
            </View>

            <View style={[cardStyle.card, styles.statRow]}>
              <View style={styles.stat}>
                <Text style={styles.statLabel}>Paycheck cadence</Text>
                <Text style={styles.statValue}>
                  {f?.paycheck_cadence_days ? `${f.paycheck_cadence_days}d` : "—"}
                </Text>
                <Text style={styles.statHint}>
                  {f?.paycheck_cadence_confidence
                    ? `${Math.round(f.paycheck_cadence_confidence * 100)}% confident`
                    : "Need more history"}
                </Text>
              </View>
              <View style={styles.statDivider} />
              <View style={styles.stat}>
                <Text style={styles.statLabel}>Events</Text>
                <Text style={styles.statValue}>{f?.events.length ?? 0}</Text>
                <Text style={styles.statHint}>in this window</Text>
              </View>
            </View>

            <Text style={styles.sectionHeader}>Upcoming events</Text>
          </View>
        }
        data={sortedEvents}
        keyExtractor={(e, i) => `${e.on_date}-${e.kind}-${i}`}
        renderItem={({ item }) => <EventRow e={item} />}
        ItemSeparatorComponent={() => <View style={styles.eventSep} />}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={q.isFetching}
            onRefresh={() => q.refetch()}
            tintColor={C.brand}
          />
        }
        ListEmptyComponent={
          <Text style={styles.hint}>No forecast events in this window.</Text>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, padding: 24, alignItems: "center", justifyContent: "center" },
  errorTitle: { color: C.outflow, fontSize: 16, fontWeight: "600" },
  errorBody: { color: C.text, marginTop: 8, fontSize: 12, textAlign: "center" },
  hint: { color: C.textMuted, fontSize: 13, textAlign: "center", padding: 24 },

  headerCards: { padding: 16 },

  statRow: { flexDirection: "row" },
  stat: { flex: 1, padding: 4 },
  statDivider: { width: StyleSheet.hairlineWidth, backgroundColor: C.border, marginHorizontal: 4 },
  statLabel: { color: C.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 },
  statValue: { color: C.text, fontSize: 22, fontWeight: "700", marginTop: 4 },
  statHint: { color: C.textSoft, fontSize: 11, marginTop: 4 },

  sectionHeader: { color: C.text, fontSize: 14, fontWeight: "600", marginTop: 4, marginBottom: 8 },

  listContent: { paddingBottom: 24 },
  eventRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: C.card,
  },
  eventDate: {
    width: 60,
    alignItems: "flex-start",
  },
  eventDateText: { color: C.textMuted, fontSize: 12, fontWeight: "500" },
  eventMain: { flex: 1, paddingHorizontal: 8 },
  eventLabelRow: { flexDirection: "row", alignItems: "center" },
  kindPill: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, marginRight: 6 },
  kindPillText: { fontSize: 10, fontWeight: "700", textTransform: "uppercase" },
  eventLabel: { color: C.text, fontSize: 13, fontWeight: "500", flex: 1 },
  eventNotes: { color: C.textSoft, fontSize: 11, marginTop: 2 },
  eventAmount: { fontSize: 14, fontWeight: "600", marginLeft: 8 },
  eventSep: { height: StyleSheet.hairlineWidth, backgroundColor: C.borderSoft },
});

// Sprint 48 — styles for the ComingUpAnnuals section. Mirrors the
// shape of the web ComingUpAnnuals card: a header bar with a 12-mo
// running total, then per-month groups, then a faint tip footer.
const annualStyles = StyleSheet.create({
  wrap: {
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 24,
    borderRadius: 8,
    backgroundColor: C.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.border,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: C.bg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.border,
  },
  title: { color: C.text, fontSize: 13, fontWeight: "600" },
  subtitle: { color: C.textSoft, fontSize: 11, marginTop: 2 },
  totalLabel: {
    color: C.textSoft,
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  totalValue: {
    color: C.outflow,
    fontSize: 16,
    fontWeight: "700",
    marginTop: 2,
  },
  monthLabel: {
    color: C.textSoft,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.6,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 4,
    backgroundColor: C.bg,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.borderSoft,
  },
  rowDate: { width: 56, color: C.textMuted, fontSize: 12, fontWeight: "500" },
  rowMain: { flex: 1, paddingHorizontal: 8 },
  rowLabel: { color: C.text, fontSize: 13 },
  rowMeta: { color: C.textSoft, fontSize: 11, marginTop: 2 },
  rowAmount: {
    color: C.outflow,
    fontSize: 14,
    fontWeight: "600",
    marginLeft: 8,
  },
  tip: {
    color: C.textSoft,
    fontSize: 11,
    fontStyle: "italic",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.border,
    backgroundColor: C.bg,
  },
});
