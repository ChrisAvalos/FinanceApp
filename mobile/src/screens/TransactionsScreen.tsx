/**
 * Recent Transactions screen — first mobile port of the web panel of the
 * same name. Renders one row per transaction with date, description,
 * category badge, and amount (red for debits, green for credits).
 *
 * Pull-to-refresh wired to the TanStack Query refetch. Loading + error
 * states handled inline so a backend hiccup is visible, not silent.
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

import { api, Category, Transaction, fmtCents, BASE_URL } from "../api/client";
import SyncFreshnessChip from "../components/SyncFreshness";

// Color palette — mirrors web's brand/inflow/outflow tokens.
const C = {
  bg: "#f4f6f9",
  card: "#ffffff",
  border: "#e3e8ef",
  text: "#0f172a",
  textSoft: "#475569",
  brand: "#0b2a4a", // header navy
  inflow: "#15803d", // green
  outflow: "#b91c1c", // red
  badge: "#e8eef7",
  badgeText: "#1e3a5f",
};

function CategoryBadge({ name }: { name: string | null }) {
  return (
    <View style={styles.badge}>
      <Text style={styles.badgeText}>{name ?? "Uncategorized"}</Text>
    </View>
  );
}

function TransactionRow({
  txn,
  catName,
}: {
  txn: Transaction;
  catName: string | null;
}) {
  const isOutflow = txn.amount_cents < 0;
  return (
    <View style={styles.row}>
      <View style={styles.rowMain}>
        <Text style={styles.date}>{txn.posted_date}</Text>
        <Text style={styles.desc} numberOfLines={1}>
          {txn.description_raw}
        </Text>
        <CategoryBadge name={catName} />
      </View>
      <Text
        style={[
          styles.amount,
          { color: isOutflow ? C.outflow : C.inflow },
        ]}
      >
        {fmtCents(txn.amount_cents)}
      </Text>
    </View>
  );
}

export default function TransactionsScreen() {
  const txnsQ = useQuery({
    queryKey: ["transactions", 50],
    queryFn: () => api.listTransactions(50),
  });
  const catsQ = useQuery({
    queryKey: ["categories"],
    queryFn: api.listCategories,
  });

  const catNameById = useMemo(() => {
    const map = new Map<number, string>();
    for (const c of catsQ.data ?? []) map.set(c.id, c.name);
    return map;
  }, [catsQ.data]);

  if (txnsQ.isLoading || catsQ.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={C.brand} />
        <Text style={styles.hint}>Loading from {BASE_URL}…</Text>
      </View>
    );
  }
  if (txnsQ.isError) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorTitle}>Couldn't reach the backend</Text>
        <Text style={styles.errorBody}>
          Tried: {BASE_URL}{"\n\n"}
          {(txnsQ.error as Error).message}
        </Text>
        <Text style={styles.hint}>
          Check that uvicorn is running on the PC and that
          EXPO_PUBLIC_API_URL points to the right host.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Recent transactions</Text>
        <Text style={styles.headerSub}>
          {(txnsQ.data ?? []).length} loaded · pull down to refresh
        </Text>
      </View>
      <FlatList
        data={txnsQ.data ?? []}
        keyExtractor={(t) => String(t.id)}
        ListHeaderComponent={
          <View style={styles.chipRow}>
            <SyncFreshnessChip
              syncedAt={txnsQ.dataUpdatedAt > 0 ? new Date(txnsQ.dataUpdatedAt).toISOString() : null}
              label="Last fetched"
            />
          </View>
        }
        renderItem={({ item }) => (
          <TransactionRow
            txn={item}
            catName={item.category_id ? catNameById.get(item.category_id) ?? null : null}
          />
        )}
        ItemSeparatorComponent={() => <View style={styles.sep} />}
        refreshControl={
          <RefreshControl
            refreshing={txnsQ.isFetching}
            onRefresh={() => txnsQ.refetch()}
            tintColor={C.brand}
          />
        }
        ListEmptyComponent={
          <View style={styles.center}>
            <Text style={styles.hint}>
              No transactions yet. Connect a bank from the web app or ingest
              a CSV.
            </Text>
          </View>
        }
        contentContainerStyle={(txnsQ.data ?? []).length === 0 ? styles.flexCenter : undefined}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  header: {
    backgroundColor: C.brand,
    paddingTop: 56,
    paddingBottom: 16,
    paddingHorizontal: 16,
  },
  headerTitle: { color: "#fff", fontSize: 20, fontWeight: "600" },
  headerSub: { color: "#dbe5f1", marginTop: 4, fontSize: 12 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: C.card,
  },
  rowMain: { flex: 1 },
  date: { color: C.textSoft, fontSize: 12, marginBottom: 2 },
  desc: { color: C.text, fontSize: 14, fontWeight: "500", marginBottom: 4 },
  badge: {
    alignSelf: "flex-start",
    backgroundColor: C.badge,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
  },
  badgeText: { color: C.badgeText, fontSize: 11, fontWeight: "500" },
  amount: { fontSize: 14, fontWeight: "600", marginLeft: 12 },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: C.border },
  chipRow: { flexDirection: "row", justifyContent: "flex-end", padding: 8 },
  center: { flex: 1, padding: 24, alignItems: "center", justifyContent: "center" },
  flexCenter: { flexGrow: 1 },
  hint: { color: C.textSoft, fontSize: 13, textAlign: "center", marginTop: 12 },
  errorTitle: { color: C.outflow, fontSize: 16, fontWeight: "600" },
  errorBody: { color: C.text, marginTop: 8, fontSize: 12, textAlign: "center" },
});
