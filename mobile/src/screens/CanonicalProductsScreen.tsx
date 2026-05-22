/**
 * Canonical products — mobile screen.
 *
 * Mirrors the web CanonicalProductsPanel: shows the master catalog
 * of normalized SKUs (e.g. "Quilted Northern Ultra Soft 12pk" linked
 * across Walmart / Target / Amazon receipts).
 *
 * Phone-first treatment is read-only browse:
 *   • Total catalog size + linked-item / pattern counts
 *   • Tap a product → show linked receipt items + linked patterns
 *   • Searchable by typing into the inline search box
 */
import React, { useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useQuery } from "@tanstack/react-query";

import { api, fmtCents, type CanonicalProduct } from "../api/client";
import { C, cardStyle, fmtShortDate, headerStyles } from "../theme";

function ProductRow({
  p,
  onTap,
}: {
  p: CanonicalProduct;
  onTap: () => void;
}) {
  return (
    <Pressable onPress={onTap} style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}>
      <View style={styles.rowLeft}>
        <Text style={styles.name} numberOfLines={2}>{p.name}</Text>
        <Text style={styles.meta}>
          {p.brand ? `${p.brand} · ` : ""}
          {p.category ?? "uncategorized"}
          {p.size_value && p.size_unit ? ` · ${p.size_value}${p.size_unit}` : ""}
        </Text>
      </View>
      <View style={styles.rowRight}>
        <Text style={styles.countText}>{p.receipt_item_count} buys</Text>
        {p.merchants.length > 0 && (
          <Text style={styles.merchantsText} numberOfLines={1}>
            {p.merchants.slice(0, 3).join(" · ")}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

function ProductDetailModal({
  productId,
  onClose,
}: {
  productId: number | null;
  onClose: () => void;
}) {
  const q = useQuery({
    queryKey: ["canonicalProductDetail", productId],
    queryFn: () => api.getCanonicalProduct(productId!),
    enabled: !!productId,
  });
  return (
    <Modal
      visible={!!productId}
      animationType="slide"
      transparent={false}
      onRequestClose={onClose}
    >
      <View style={styles.modalScreen}>
        <View style={[headerStyles.header, styles.modalHeader]}>
          <View style={{ flex: 1 }}>
            <Text style={headerStyles.headerTitle} numberOfLines={1}>
              {q.data?.name ?? "—"}
            </Text>
            {q.data && (
              <Text style={headerStyles.headerSub}>
                {q.data.receipt_item_count} buys · {q.data.recurring_pattern_count} patterns
              </Text>
            )}
          </View>
          <Pressable onPress={onClose} style={({ pressed }) => [styles.closeBtn, pressed && { opacity: 0.6 }]}>
            <Text style={styles.closeBtnText}>Close</Text>
          </Pressable>
        </View>

        {q.isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={C.brand} />
          </View>
        ) : q.data ? (
          <ScrollView contentContainerStyle={styles.modalContent}>
            <View style={[cardStyle.card]}>
              <Text style={styles.detailLabel}>Brand</Text>
              <Text style={styles.detailValue}>{q.data.brand ?? "—"}</Text>
              <Text style={styles.detailLabel}>Category</Text>
              <Text style={styles.detailValue}>{q.data.category ?? "—"}</Text>
              {q.data.size_value && q.data.size_unit && (
                <>
                  <Text style={styles.detailLabel}>Size</Text>
                  <Text style={styles.detailValue}>
                    {q.data.size_value}{q.data.size_unit}
                  </Text>
                </>
              )}
              <Text style={styles.detailLabel}>Normalized key</Text>
              <Text style={[styles.detailValue, styles.monoText]}>{q.data.normalized_key}</Text>
            </View>

            {q.data.linked_patterns.length > 0 && (
              <View style={[cardStyle.card]}>
                <Text style={styles.sectionTitle}>Linked patterns</Text>
                {q.data.linked_patterns.map((pat) => (
                  <View key={pat.id} style={styles.patternRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.patternName}>{pat.canonical_name}</Text>
                      <Text style={styles.patternMeta}>
                        {pat.primary_merchant ?? "—"} · {pat.occurrence_count} buys
                      </Text>
                    </View>
                    {pat.typical_line_total_cents != null && (
                      <Text style={styles.patternPrice}>
                        {fmtCents(pat.typical_line_total_cents)}
                      </Text>
                    )}
                  </View>
                ))}
              </View>
            )}

            {q.data.linked_items.length > 0 && (
              <View style={[cardStyle.card]}>
                <Text style={styles.sectionTitle}>
                  Linked receipt items ({q.data.linked_items.length})
                </Text>
                {q.data.linked_items.slice(0, 50).map((it) => (
                  <View key={it.receipt_item_id} style={styles.itemRow}>
                    <Text style={styles.itemDate}>{fmtShortDate(it.purchase_date)}</Text>
                    <Text style={styles.itemMerchant} numberOfLines={1}>
                      {it.merchant ?? "—"}
                    </Text>
                    {it.line_total_cents != null && (
                      <Text style={styles.itemAmount}>{fmtCents(it.line_total_cents)}</Text>
                    )}
                  </View>
                ))}
              </View>
            )}
          </ScrollView>
        ) : null}
      </View>
    </Modal>
  );
}

export default function CanonicalProductsScreen() {
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);
  const q = useQuery({
    queryKey: ["canonicalProducts", search],
    queryFn: () => api.listCanonicalProducts(search ? { q: search } : {}),
  });

  if (q.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={C.brand} />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={headerStyles.header}>
        <Text style={headerStyles.headerTitle}>Canonical products</Text>
        <Text style={headerStyles.headerSub}>
          {q.data?.length ?? 0} products in catalog
        </Text>
      </View>

      <View style={styles.searchBar}>
        <TextInput
          style={styles.searchInput}
          placeholder="Search by name or brand…"
          placeholderTextColor={C.textSoft}
          value={search}
          onChangeText={setSearch}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>

      <FlatList
        data={q.data ?? []}
        keyExtractor={(p) => String(p.id)}
        renderItem={({ item }) => (
          <ProductRow p={item} onTap={() => setOpenId(item.id)} />
        )}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={q.isFetching}
            onRefresh={() => q.refetch()}
            tintColor={C.brand}
          />
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.hint}>
              {search
                ? `No products matching "${search}".`
                : "Catalog is empty. Run canonicalize on the web to populate."}
            </Text>
          </View>
        }
      />

      <ProductDetailModal productId={openId} onClose={() => setOpenId(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, padding: 24, alignItems: "center", justifyContent: "center" },
  empty: { padding: 24, alignItems: "center" },
  hint: { color: C.textMuted, fontSize: 13, textAlign: "center" },

  searchBar: {
    backgroundColor: C.card,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.borderSoft,
  },
  searchInput: {
    backgroundColor: C.bg,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    color: C.text,
  },

  listContent: { padding: 16, paddingBottom: 32 },

  row: {
    backgroundColor: C.card,
    padding: 12,
    borderRadius: 8,
    marginBottom: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.border,
    flexDirection: "row",
    alignItems: "flex-start",
  },
  rowLeft: { flex: 1, paddingRight: 8 },
  rowRight: { alignItems: "flex-end", maxWidth: 130 },
  name: { color: C.text, fontSize: 13, fontWeight: "600" },
  meta: { color: C.textSoft, fontSize: 11, marginTop: 2 },
  countText: { color: C.brand, fontSize: 12, fontWeight: "700" },
  merchantsText: { color: C.textSoft, fontSize: 10, marginTop: 2, textAlign: "right" },

  // Modal styles
  modalScreen: { flex: 1, backgroundColor: C.bg },
  modalHeader: { flexDirection: "row", alignItems: "center" },
  modalContent: { padding: 16, paddingBottom: 32 },
  closeBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: "rgba(255,255,255,0.2)",
    borderRadius: 4,
  },
  closeBtnText: { color: "#fff", fontSize: 12, fontWeight: "600" },

  detailLabel: {
    color: C.textMuted,
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 6,
    fontWeight: "700",
  },
  detailValue: { color: C.text, fontSize: 13 },
  monoText: { fontFamily: "Menlo", fontSize: 11 },
  sectionTitle: { color: C.text, fontSize: 13, fontWeight: "700", marginBottom: 8 },

  patternRow: {
    flexDirection: "row",
    paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.borderSoft,
  },
  patternName: { color: C.text, fontSize: 12, fontWeight: "600" },
  patternMeta: { color: C.textSoft, fontSize: 11, marginTop: 2 },
  patternPrice: { color: C.brand, fontSize: 12, fontWeight: "700" },

  itemRow: {
    flexDirection: "row",
    paddingVertical: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.borderSoft,
    alignItems: "center",
  },
  itemDate: { color: C.textMuted, fontSize: 11, width: 50 },
  itemMerchant: { flex: 1, color: C.text, fontSize: 12 },
  itemAmount: { color: C.outflow, fontSize: 12, fontWeight: "600" },
});
