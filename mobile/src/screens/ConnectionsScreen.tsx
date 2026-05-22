/**
 * Connections (Plaid) — mobile screen.
 *
 * Read-and-sync only on phone. Adding new banks requires Plaid Link
 * (native SDK), which we deliberately don't include because it would
 * eject from Expo Go. So the phone shows: existing items, last-sync
 * status, manual sync buttons, schedule snapshot, and a CTA pointing
 * users to the web app for adding new banks.
 *
 * Phone-first treatment:
 *   • Status banner (configured / sandbox / production)
 *   • Per-item cards with status pill + last-sync timestamp + Sync button
 *   • "Sync all" button at the top
 *   • "Add new bank: use the web app" footer
 */
import React from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  api,
  type PlaidItem,
  type PlaidItemStatus,
} from "../api/client";
import { C, cardStyle, fmtRelativeDate, headerStyles } from "../theme";

function StatusPill({ status }: { status: PlaidItemStatus }) {
  const cfg: Record<PlaidItemStatus, { label: string; bg: string; fg: string }> = {
    good: { label: "Healthy", bg: "#d1fae5", fg: "#065f46" },
    login_required: { label: "Re-auth", bg: "#fef3c7", fg: "#92400e" },
    error: { label: "Error", bg: "#fee2e2", fg: "#991b1b" },
  };
  const c = cfg[status] ?? cfg.error;
  return (
    <View style={[styles.pill, { backgroundColor: c.bg }]}>
      <Text style={[styles.pillText, { color: c.fg }]}>{c.label}</Text>
    </View>
  );
}

function ItemCard({
  item,
  onSync,
  syncing,
}: {
  item: PlaidItem;
  onSync: () => void;
  syncing: boolean;
}) {
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={styles.cardLeft}>
          <View style={styles.headerRow}>
            <StatusPill status={item.status} />
            <Text style={styles.institutionText}>
              {item.institution_name ?? item.plaid_institution_id ?? `Item ${item.plaid_item_id.slice(-6)}`}
            </Text>
          </View>
          <Text style={styles.metaText}>
            Last sync: {fmtRelativeDate(item.last_synced_at)}
            {item.granted_products ? ` · ${item.granted_products}` : ""}
          </Text>
          {item.last_error && (
            <Text style={styles.errorText} numberOfLines={2}>{item.last_error}</Text>
          )}
        </View>
        <Pressable
          onPress={onSync}
          disabled={syncing}
          style={({ pressed }) => [
            styles.syncBtn,
            pressed && { opacity: 0.6 },
            syncing && { opacity: 0.4 },
          ]}
        >
          <Text style={styles.syncBtnText}>{syncing ? "…" : "Sync"}</Text>
        </Pressable>
      </View>
    </View>
  );
}

export default function ConnectionsScreen() {
  const qc = useQueryClient();

  const statusQ = useQuery({ queryKey: ["plaidStatus"], queryFn: () => api.plaidStatus() });
  const itemsQ = useQuery({ queryKey: ["plaidItems"], queryFn: () => api.plaidListItems() });
  const scheduleQ = useQuery({ queryKey: ["plaidSchedule"], queryFn: () => api.plaidSchedule() });

  const syncOneMut = useMutation({
    mutationFn: (id: number) => api.plaidSyncItem(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["plaidItems"] }),
  });
  const syncAllMut = useMutation({
    mutationFn: () => api.plaidSyncAll(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["plaidItems"] }),
  });

  if (itemsQ.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={C.brand} />
      </View>
    );
  }

  const status = statusQ.data;
  const sched = scheduleQ.data;

  return (
    <View style={styles.screen}>
      <View style={headerStyles.header}>
        <Text style={headerStyles.headerTitle}>Connections</Text>
        <Text style={headerStyles.headerSub}>
          {itemsQ.data?.length ?? 0} bank{(itemsQ.data?.length ?? 0) === 1 ? "" : "s"} via Plaid
        </Text>
      </View>

      <FlatList
        data={itemsQ.data ?? []}
        keyExtractor={(it) => String(it.id)}
        renderItem={({ item }) => (
          <ItemCard
            item={item}
            onSync={() => syncOneMut.mutate(item.id)}
            syncing={syncOneMut.isPending && syncOneMut.variables === item.id}
          />
        )}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={itemsQ.isFetching || statusQ.isFetching}
            onRefresh={() => {
              itemsQ.refetch();
              statusQ.refetch();
              scheduleQ.refetch();
            }}
            tintColor={C.brand}
          />
        }
        ListHeaderComponent={
          <View>
            <View style={[cardStyle.card, styles.statusCard]}>
              <View style={styles.statusRow}>
                <Text style={styles.statusLabel}>Plaid environment</Text>
                <Text style={styles.statusValue}>
                  {status?.configured ? (status.env || "configured") : "not configured"}
                </Text>
              </View>
              {sched && (
                <View style={styles.statusRow}>
                  <Text style={styles.statusLabel}>Auto-sync</Text>
                  <Text style={styles.statusValue}>
                    {sched.enabled
                      ? `every ${sched.interval_hours}h${
                          sched.next_run_time ? ` · next ${fmtRelativeDate(sched.next_run_time)}` : ""
                        }`
                      : "disabled"}
                  </Text>
                </View>
              )}
              <Pressable
                onPress={() => syncAllMut.mutate()}
                disabled={syncAllMut.isPending || (itemsQ.data?.length ?? 0) === 0}
                style={({ pressed }) => [
                  styles.syncAllBtn,
                  pressed && { opacity: 0.6 },
                  (syncAllMut.isPending || (itemsQ.data?.length ?? 0) === 0) && { opacity: 0.4 },
                ]}
              >
                <Text style={styles.syncAllBtnText}>
                  {syncAllMut.isPending ? "Syncing…" : "Sync all items"}
                </Text>
              </Pressable>
              {syncAllMut.data && (() => {
                // SyncAllResult is { synced_at, item_count, items: { item_id: SyncResult } }.
                // Roll up the per-item results to a single tally.
                const totals = Object.values(syncAllMut.data.items).reduce(
                  (acc, r) => ({
                    added: acc.added + (r.added ?? 0),
                    modified: acc.modified + (r.modified ?? 0),
                    removed: acc.removed + (r.removed ?? 0),
                  }),
                  { added: 0, modified: 0, removed: 0 },
                );
                return (
                  <Text style={styles.syncResult}>
                    Last full sync ({syncAllMut.data.item_count} item
                    {syncAllMut.data.item_count === 1 ? "" : "s"}): +{totals.added} new ·
                    {" "}{totals.modified} modified · {totals.removed} removed
                  </Text>
                );
              })()}
            </View>

            <Text style={styles.listLabel}>Linked items</Text>
          </View>
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.hint}>
              No banks linked yet. Plaid Link runs in the web app — open the dashboard from a desktop browser to add a bank.
            </Text>
          </View>
        }
        ListFooterComponent={
          <View style={[cardStyle.card, styles.footerCard]}>
            <Text style={styles.footerTitle}>Add a new bank</Text>
            <Text style={styles.footerBody}>
              Plaid's bank-linking flow ("Plaid Link") is a web/native SDK that
              we don't bundle in the phone app — it requires ejecting from
              Expo Go. To link a new bank, open the Finance App on your laptop
              and use the Connect Bank flow there. Once linked, items
              auto-appear here for syncing.
            </Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, padding: 24, alignItems: "center", justifyContent: "center" },
  empty: { padding: 24, alignItems: "center" },
  hint: { color: C.textMuted, fontSize: 13, textAlign: "center" },

  listContent: { padding: 16, paddingBottom: 32 },

  statusCard: { marginBottom: 12 },
  statusRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 4,
  },
  statusLabel: { color: C.textMuted, fontSize: 11 },
  statusValue: { color: C.text, fontSize: 12, fontWeight: "600" },
  syncAllBtn: {
    marginTop: 12,
    backgroundColor: C.brand,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 4,
    alignSelf: "flex-start",
  },
  syncAllBtnText: { color: "#fff", fontSize: 12, fontWeight: "700" },
  syncResult: { color: C.inflow, fontSize: 11, marginTop: 8, fontWeight: "600" },

  listLabel: {
    color: C.textMuted,
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 8,
  },

  card: {
    backgroundColor: C.card,
    padding: 12,
    borderRadius: 8,
    marginBottom: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.border,
  },
  cardHeader: { flexDirection: "row", alignItems: "flex-start" },
  cardLeft: { flex: 1, paddingRight: 8 },
  headerRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", marginBottom: 4 },
  pill: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, marginRight: 6 },
  pillText: { fontSize: 10, fontWeight: "700" },
  institutionText: { color: C.text, fontSize: 13, fontWeight: "700" },
  metaText: { color: C.textSoft, fontSize: 11, marginTop: 4 },
  errorText: { color: C.outflow, fontSize: 11, marginTop: 4 },

  syncBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 4,
    backgroundColor: C.brandLight,
    borderWidth: 1,
    borderColor: C.brand,
  },
  syncBtnText: { color: C.brand, fontSize: 11, fontWeight: "700" },

  footerCard: { backgroundColor: C.brandLight, marginTop: 12 },
  footerTitle: { color: C.brand, fontSize: 13, fontWeight: "700" },
  footerBody: { color: C.textMuted, fontSize: 12, marginTop: 6, lineHeight: 18 },
});
