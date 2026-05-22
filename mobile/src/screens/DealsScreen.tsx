/**
 * Deals — mobile screen.
 *
 * Sections:
 *   • Stat strip — active deals count + projected annual savings
 *   • Active deals list with savings + URL link
 *   • Manual price-observation entry sheet (modal)
 *   • Recent observations list
 *
 * The phone use-case for this is "I just saw Charmin at Target for $14"
 * — open the modal, pick the pattern, type the price, hit save. The
 * deal detector picks it up automatically on the next list refresh.
 */
import React, { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  api,
  fmtCents,
  type DealOpportunity,
  type PriceObservation,
  type RecurringPurchaseLite,
} from "../api/client";
import { C, cardStyle, fmtShortDate, headerStyles } from "../theme";

/* ------------------------------------------------------------------ */
/*  Deal card                                                          */
/* ------------------------------------------------------------------ */

function DealCard({ d }: { d: DealOpportunity }) {
  return (
    <Pressable
      onPress={() => {
        if (d.product_url) Linking.openURL(d.product_url).catch(() => {});
      }}
      style={({ pressed }) => [styles.dealCard, pressed && { opacity: 0.85 }]}
    >
      <View style={styles.dealHeader}>
        <View style={[styles.merchantPill]}>
          <Text style={styles.merchantPillText}>{d.deal_merchant}</Text>
        </View>
        <Text style={styles.savingsAmount}>-{fmtCents(d.savings_cents)}</Text>
      </View>
      <Text style={styles.patternName} numberOfLines={2}>{d.pattern_name}</Text>
      <Text style={styles.dealMeta}>
        {fmtCents(d.deal_price_cents)} at {d.deal_merchant}
        <Text style={styles.dealMetaSoft}>
          {" · "}usual {fmtCents(d.baseline_cents)}
          {d.pattern_merchant ? ` at ${d.pattern_merchant}` : ""}
        </Text>
      </Text>
      <View style={styles.dealFooter}>
        <Text style={styles.dealPctText}>{Math.round(d.savings_pct * 100)}% off</Text>
        {d.annual_savings_cents != null && (
          <Text style={styles.annualSavings}>
            ~{fmtCents(d.annual_savings_cents)}/yr if you switch
          </Text>
        )}
      </View>
    </Pressable>
  );
}

/* ------------------------------------------------------------------ */
/*  Manual entry modal                                                 */
/* ------------------------------------------------------------------ */

function AddObservationSheet({
  visible,
  patterns,
  onClose,
  onSaved,
}: {
  visible: boolean;
  patterns: RecurringPurchaseLite[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [patternId, setPatternId] = useState<number | null>(null);
  const [merchant, setMerchant] = useState("");
  const [price, setPrice] = useState("");

  const create = useMutation({
    mutationFn: api.createPriceObservation,
    onSuccess: () => {
      Alert.alert("Saved", "Price observation logged.");
      setPatternId(null);
      setMerchant("");
      setPrice("");
      onSaved();
      onClose();
    },
    onError: (e: Error) => Alert.alert("Couldn't save", e.message),
  });

  const submit = () => {
    if (!patternId) return Alert.alert("Pick a tracked item");
    if (!merchant.trim()) return Alert.alert("Enter a merchant");
    const cents = Math.round(parseFloat(price) * 100);
    if (Number.isNaN(cents) || cents <= 0) return Alert.alert("Enter a positive price");
    create.mutate({
      recurring_purchase_id: patternId,
      merchant: merchant.trim(),
      price_cents: cents,
    });
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.modal}
      >
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>Log price observation</Text>
          <Pressable onPress={onClose}>
            <Text style={styles.modalClose}>Cancel</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.modalContent}>
          <Text style={styles.modalHint}>
            Spotted a price somewhere? Log it here. The deal detector compares it to your
            typical price for that item; if it's ≥15% cheaper, it'll surface as a deal.
          </Text>

          {patterns.length === 0 ? (
            <View style={[cardStyle.card, { backgroundColor: "#fef3c7" }]}>
              <Text style={{ color: "#92400e", fontSize: 13 }}>
                No recurring purchases tracked yet. Upload a few receipts on the web app + run
                "Detect now" so the app knows what you regularly buy.
              </Text>
            </View>
          ) : (
            <>
              <Text style={styles.formLabel}>Item *</Text>
              <View style={styles.patternList}>
                {patterns.map((p) => {
                  const sel = patternId === p.id;
                  return (
                    <Pressable
                      key={p.id}
                      onPress={() => setPatternId(p.id)}
                      style={[styles.patternRow, sel && styles.patternRowSelected]}
                    >
                      <Text style={[styles.patternRowText, sel && styles.patternRowTextSelected]}>
                        {p.canonical_name}
                        {p.primary_merchant ? `  ·  usually ${p.primary_merchant}` : ""}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              <Text style={styles.formLabel}>Merchant *</Text>
              <TextInput
                value={merchant}
                onChangeText={setMerchant}
                placeholder="Walmart / Target / Costco"
                placeholderTextColor={C.textSoft}
                style={styles.formInput}
              />

              <Text style={styles.formLabel}>Price ($) *</Text>
              <TextInput
                value={price}
                onChangeText={setPrice}
                keyboardType="decimal-pad"
                placeholder="14.99"
                placeholderTextColor={C.textSoft}
                style={styles.formInput}
              />

              <Pressable
                onPress={submit}
                disabled={create.isPending}
                style={({ pressed }) => [
                  styles.saveBtn,
                  create.isPending && { opacity: 0.5 },
                  pressed && { opacity: 0.85 },
                ]}
              >
                <Text style={styles.saveBtnText}>
                  {create.isPending ? "Saving…" : "Save observation"}
                </Text>
              </Pressable>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/*  Recent observation row                                             */
/* ------------------------------------------------------------------ */

function ObservationRow({
  o,
  patterns,
}: {
  o: PriceObservation;
  patterns: RecurringPurchaseLite[];
}) {
  const pattern = patterns.find((p) => p.id === o.recurring_purchase_id);
  return (
    <View style={styles.obsRow}>
      <View style={styles.obsLeft}>
        <Text style={styles.obsItem} numberOfLines={1}>
          {pattern?.canonical_name ?? `#${o.recurring_purchase_id}`}
        </Text>
        <Text style={styles.obsMeta}>
          {o.merchant} · {fmtShortDate(o.observed_at)} · {o.source}
        </Text>
      </View>
      <Text style={styles.obsPrice}>{fmtCents(o.price_cents)}</Text>
    </View>
  );
}

/* ------------------------------------------------------------------ */
/*  Screen                                                             */
/* ------------------------------------------------------------------ */

export default function DealsScreen() {
  const qc = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);

  const deals = useQuery({ queryKey: ["deals"], queryFn: api.listDeals });
  const patterns = useQuery({
    queryKey: ["recurringPurchases"],
    queryFn: api.listRecurringPurchases,
  });
  const observations = useQuery({
    queryKey: ["dealObservations"],
    queryFn: () => api.listPriceObservations(50),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["deals"] });
    qc.invalidateQueries({ queryKey: ["dealObservations"] });
  };

  const totalAnnual = (deals.data ?? []).reduce(
    (s, d) => s + (d.annual_savings_cents ?? 0),
    0,
  );

  const refetchAll = () => {
    deals.refetch();
    patterns.refetch();
    observations.refetch();
  };

  if (deals.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={C.brand} />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={headerStyles.header}>
        <View style={styles.headerInner}>
          <View style={{ flex: 1 }}>
            <Text style={headerStyles.headerTitle}>Cross-store deals</Text>
            <Text style={headerStyles.headerSub}>
              {deals.data?.length ?? 0} active · {fmtCents(totalAnnual)}/yr if you switch
            </Text>
          </View>
          <Pressable
            onPress={() => setAddOpen(true)}
            style={({ pressed }) => [styles.addBtn, pressed && { opacity: 0.85 }]}
          >
            <Text style={styles.addBtnText}>+ Log price</Text>
          </Pressable>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={deals.isFetching}
            onRefresh={refetchAll}
            tintColor={C.brand}
          />
        }
      >
        {/* Active deals */}
        {(deals.data ?? []).length > 0 ? (
          <>
            <Text style={styles.sectionTitle}>Active deals</Text>
            {(deals.data ?? []).map((d, i) => (
              <DealCard key={`${d.pattern_id}-${d.deal_merchant}-${i}`} d={d} />
            ))}
          </>
        ) : (
          <View style={cardStyle.card}>
            <Text style={styles.hint}>
              No active deals. Log a price observation when you spot one cheaper than your usual,
              and it'll surface here automatically when savings exceed 15%.
            </Text>
          </View>
        )}

        {/* Recent observations */}
        {(observations.data ?? []).length > 0 && (
          <View style={[cardStyle.card, { marginTop: 16 }]}>
            <Text style={styles.sectionTitle}>Recent observations</Text>
            <Text style={styles.sectionHint}>Both manual entries + scraper hits land here</Text>
            {(observations.data ?? []).map((o) => (
              <ObservationRow
                key={o.id}
                o={o}
                patterns={patterns.data ?? []}
              />
            ))}
          </View>
        )}
      </ScrollView>

      <AddObservationSheet
        visible={addOpen}
        patterns={patterns.data ?? []}
        onClose={() => setAddOpen(false)}
        onSaved={invalidate}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, padding: 24, alignItems: "center", justifyContent: "center" },
  hint: { color: C.textMuted, fontSize: 13, textAlign: "center" },
  content: { padding: 16, paddingBottom: 32 },

  headerInner: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  addBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: "#fff",
    borderRadius: 6,
    marginLeft: 8,
  },
  addBtnText: { color: C.brand, fontWeight: "700", fontSize: 12 },

  sectionTitle: { color: C.text, fontSize: 14, fontWeight: "600", marginBottom: 8 },
  sectionHint: { color: C.textSoft, fontSize: 11, marginBottom: 8, marginTop: -4 },

  dealCard: {
    backgroundColor: C.card,
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.border,
  },
  dealHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  merchantPill: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: "#fce7f3",
    borderRadius: 4,
  },
  merchantPillText: { color: "#9d174d", fontSize: 10, fontWeight: "700", textTransform: "uppercase" },
  savingsAmount: { color: C.warn, fontSize: 18, fontWeight: "700" },
  patternName: { color: C.text, fontSize: 14, fontWeight: "600", marginTop: 6 },
  dealMeta: { color: C.textMuted, fontSize: 12, marginTop: 4 },
  dealMetaSoft: { color: C.textSoft },
  dealFooter: { flexDirection: "row", justifyContent: "space-between", marginTop: 6 },
  dealPctText: { color: C.warn, fontSize: 11, fontWeight: "600" },
  annualSavings: { color: C.textSoft, fontSize: 11 },

  obsRow: {
    flexDirection: "row",
    paddingVertical: 8,
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.borderSoft,
  },
  obsLeft: { flex: 1, paddingRight: 8 },
  obsItem: { color: C.text, fontSize: 13, fontWeight: "500" },
  obsMeta: { color: C.textSoft, fontSize: 11, marginTop: 2 },
  obsPrice: { color: C.text, fontSize: 13, fontWeight: "600" },

  // Modal
  modal: { flex: 1, backgroundColor: C.bg },
  modalHeader: {
    backgroundColor: C.brand,
    paddingTop: 56,
    paddingBottom: 16,
    paddingHorizontal: 16,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  modalTitle: { color: "#fff", fontSize: 16, fontWeight: "600", flex: 1 },
  modalClose: { color: "#fff", fontSize: 14 },
  modalContent: { padding: 16 },
  modalHint: { color: C.textMuted, fontSize: 12, marginBottom: 16, lineHeight: 17 },
  formLabel: {
    color: C.textMuted,
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 6,
    marginTop: 12,
  },
  formInput: {
    backgroundColor: C.card,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.border,
    padding: 10,
    color: C.text,
    fontSize: 14,
  },
  patternList: { backgroundColor: C.card, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, borderColor: C.border },
  patternRow: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.borderSoft,
  },
  patternRowSelected: { backgroundColor: C.brandLight },
  patternRowText: { color: C.text, fontSize: 13 },
  patternRowTextSelected: { color: C.brand, fontWeight: "700" },
  saveBtn: {
    backgroundColor: C.brandAccent,
    borderRadius: 6,
    padding: 12,
    alignItems: "center",
    marginTop: 24,
  },
  saveBtnText: { color: "#fff", fontWeight: "600", fontSize: 14 },
});
