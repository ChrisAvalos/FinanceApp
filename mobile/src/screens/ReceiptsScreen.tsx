/**
 * Receipts — mobile screen.
 *
 * Three input modes for the morning-of-shopping use case:
 *   1. Camera — snap a photo of the receipt right at the register
 *   2. Photo library — pick a previously-taken shot
 *   3. Paste text — fall-through for OCR'd text from another tool
 *
 * Camera + library both upload via multipart to /api/receipts/upload
 * which OCRs server-side via pytesseract. Paste text is the always-
 * works zero-permission fallback.
 *
 * Sections:
 *   • Add sheet with three large CTA buttons + image preview + progress
 *   • History list — newest first
 *   • Detail view sheet — items + coupons + raw text on tap
 */
import React, { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
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
import * as ImagePicker from "expo-image-picker";

import {
  api,
  fmtCents,
  type Receipt,
  type ReceiptStatus,
} from "../api/client";
import EmptyState from "../components/EmptyState";
import { C, cardStyle, fmtShortDate, headerStyles } from "../theme";
import { tapError, tapLight, tapMedium, tapSuccess } from "../util/feedback";

const STATUS_COLOR: Record<ReceiptStatus, string> = {
  pending: C.textMuted,
  parsed: C.inflow,
  failed: C.outflow,
  manual: "#1e40af",
};

function StatusBadge({ s }: { s: ReceiptStatus }) {
  const labels: Record<ReceiptStatus, string> = {
    pending: "Pending",
    parsed: "Parsed",
    failed: "Failed",
    manual: "Manual",
  };
  return (
    <View
      style={[
        styles.statusBadge,
        { backgroundColor: STATUS_COLOR[s] + "22", borderColor: STATUS_COLOR[s] },
      ]}
    >
      <Text style={[styles.statusText, { color: STATUS_COLOR[s] }]}>
        {labels[s]}
      </Text>
    </View>
  );
}

function ReceiptRow({ r, onTap }: { r: Receipt; onTap: () => void }) {
  return (
    <Pressable
      onPress={onTap}
      style={({ pressed }) => [styles.listRow, pressed && { opacity: 0.85 }]}
    >
      <View style={styles.listRowMain}>
        <View style={styles.listRowHeader}>
          <Text style={styles.merchantText} numberOfLines={1}>
            {r.merchant ?? "Unknown merchant"}
          </Text>
          <StatusBadge s={r.status} />
        </View>
        <Text style={styles.dateText}>
          {fmtShortDate(r.purchase_date) || fmtShortDate(r.created_at)}
        </Text>
      </View>
      <Text style={styles.totalText}>
        {r.total_cents != null ? fmtCents(r.total_cents) : "—"}
      </Text>
    </Pressable>
  );
}

/* ------------------------------------------------------------------ */
/*  Add-receipt sheet                                                  */
/* ------------------------------------------------------------------ */

type AddMode = "menu" | "image" | "text";

type PickedImage = {
  uri: string;
  name?: string;
  type?: string;
};

function AddSheet({
  visible,
  onClose,
  onSaved,
}: {
  visible: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [mode, setMode] = useState<AddMode>("menu");
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<PickedImage | null>(null);

  const reset = () => {
    setMode("menu");
    setText("");
    setPicked(null);
  };

  const handleSuccess = (label: string, r: { receipt_id: number; items_added: number; coupons_added: number; warnings: string[] }) => {
    tapSuccess();
    Alert.alert(
      label,
      `Saved as receipt #${r.receipt_id}\n` +
        `${r.items_added} item${r.items_added === 1 ? "" : "s"}, ${r.coupons_added} coupon${r.coupons_added === 1 ? "" : "s"}` +
        (r.warnings.length ? `\n\n${r.warnings.join("\n")}` : ""),
    );
    reset();
    onSaved();
    onClose();
  };

  const parse = useMutation({
    mutationFn: api.parseReceiptText,
    onSuccess: (r) => handleSuccess("Receipt parsed", r),
    onError: (e: Error) => {
      tapError();
      Alert.alert("Couldn't parse", e.message);
    },
  });

  const upload = useMutation({
    mutationFn: api.uploadReceipt,
    onSuccess: (r) => handleSuccess("Receipt uploaded", r),
    onError: (e: Error) => {
      tapError();
      Alert.alert("Upload failed", e.message);
    },
  });

  const isBusy = parse.isPending || upload.isPending;

  const dismissAndReset = () => {
    tapLight();
    reset();
    onClose();
  };

  const pickFromCamera = async () => {
    tapLight();
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      tapError();
      Alert.alert(
        "Camera access needed",
        "Enable camera access in iOS Settings → Finance App to snap receipts from the screen.",
      );
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      // Receipts are tall and narrow — let the user crop in the OS UI for
      // a tighter image, which means tighter OCR.
      allowsEditing: true,
      quality: 0.85,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const a = result.assets[0];
    setPicked({ uri: a.uri, name: a.fileName ?? "receipt.jpg", type: a.mimeType ?? "image/jpeg" });
    setMode("image");
    tapMedium();
  };

  const pickFromLibrary = async () => {
    tapLight();
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      tapError();
      Alert.alert(
        "Library access needed",
        "Enable photos access in iOS Settings → Finance App to import receipts you've already taken.",
      );
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      quality: 0.85,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const a = result.assets[0];
    setPicked({ uri: a.uri, name: a.fileName ?? "receipt.jpg", type: a.mimeType ?? "image/jpeg" });
    setMode("image");
    tapMedium();
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={dismissAndReset}
      transparent={false}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.modal}
      >
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>
            {mode === "menu" ? "Add a receipt" : mode === "image" ? "Review + upload" : "Paste receipt text"}
          </Text>
          <Pressable onPress={dismissAndReset} disabled={isBusy}>
            <Text style={[styles.modalClose, isBusy && { opacity: 0.4 }]}>Cancel</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.modalContent} keyboardShouldPersistTaps="handled">
          {mode === "menu" ? (
            <View style={styles.modeMenu}>
              <Text style={styles.modeIntro}>
                The fastest path is to snap the receipt at the register. Pasted OCR text always works as a fallback.
              </Text>
              <Pressable
                onPress={pickFromCamera}
                style={({ pressed }) => [styles.modeCard, styles.modeCardPrimary, pressed && { opacity: 0.85 }]}
              >
                <Text style={styles.modeCardIcon}>📸</Text>
                <View style={styles.modeCardBody}>
                  <Text style={styles.modeCardTitle}>Take a photo</Text>
                  <Text style={styles.modeCardDesc}>Snap, crop, upload. Best at the register.</Text>
                </View>
                <Text style={styles.modeCardArrow}>›</Text>
              </Pressable>
              <Pressable
                onPress={pickFromLibrary}
                style={({ pressed }) => [styles.modeCard, pressed && { opacity: 0.85 }]}
              >
                <Text style={styles.modeCardIcon}>🖼️</Text>
                <View style={styles.modeCardBody}>
                  <Text style={styles.modeCardTitle}>Pick from library</Text>
                  <Text style={styles.modeCardDesc}>Import a receipt you've already photographed.</Text>
                </View>
                <Text style={styles.modeCardArrow}>›</Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  tapLight();
                  setMode("text");
                }}
                style={({ pressed }) => [styles.modeCard, pressed && { opacity: 0.85 }]}
              >
                <Text style={styles.modeCardIcon}>📝</Text>
                <View style={styles.modeCardBody}>
                  <Text style={styles.modeCardTitle}>Paste OCR'd text</Text>
                  <Text style={styles.modeCardDesc}>Fall-through when image upload won't work.</Text>
                </View>
                <Text style={styles.modeCardArrow}>›</Text>
              </Pressable>
            </View>
          ) : mode === "image" && picked ? (
            <View>
              <Text style={styles.modalHint}>
                Looks right? Tap upload — server-side OCR will pull the merchant, date, line items, and any coupons.
              </Text>
              <View style={styles.preview}>
                <Image source={{ uri: picked.uri }} style={styles.previewImage} resizeMode="contain" />
              </View>
              <View style={styles.previewActions}>
                <Pressable
                  onPress={() => {
                    tapLight();
                    setPicked(null);
                    setMode("menu");
                  }}
                  disabled={isBusy}
                  style={({ pressed }) => [styles.secondaryBtn, pressed && { opacity: 0.6 }, isBusy && { opacity: 0.4 }]}
                >
                  <Text style={styles.secondaryBtnText}>Choose another</Text>
                </Pressable>
                <Pressable
                  onPress={() => upload.mutate(picked)}
                  disabled={isBusy}
                  style={({ pressed }) => [styles.saveBtn, { flex: 1 }, pressed && { opacity: 0.85 }, isBusy && { opacity: 0.5 }]}
                >
                  {upload.isPending ? (
                    <View style={styles.busyRow}>
                      <ActivityIndicator color="#fff" />
                      <Text style={styles.saveBtnText}>Uploading + OCR…</Text>
                    </View>
                  ) : (
                    <Text style={styles.saveBtnText}>Upload + parse</Text>
                  )}
                </Pressable>
              </View>
            </View>
          ) : (
            <View>
              <Text style={styles.modalHint}>
                Paste OCR'd text from another tool. Parser pulls merchant, date, line items, and coupons automatically.
              </Text>
              <TextInput
                value={text}
                onChangeText={setText}
                multiline
                placeholder="Paste your receipt text…"
                placeholderTextColor={C.textSoft}
                style={styles.textArea}
                textAlignVertical="top"
                editable={!parse.isPending}
              />
              <View style={styles.previewActions}>
                <Pressable
                  onPress={() => {
                    tapLight();
                    setMode("menu");
                  }}
                  disabled={parse.isPending}
                  style={({ pressed }) => [styles.secondaryBtn, pressed && { opacity: 0.6 }]}
                >
                  <Text style={styles.secondaryBtnText}>Back</Text>
                </Pressable>
                <Pressable
                  onPress={() => parse.mutate(text)}
                  disabled={!text.trim() || parse.isPending}
                  style={({ pressed }) => [
                    styles.saveBtn,
                    { flex: 1 },
                    (!text.trim() || parse.isPending) && { opacity: 0.5 },
                    pressed && { opacity: 0.85 },
                  ]}
                >
                  {parse.isPending ? (
                    <View style={styles.busyRow}>
                      <ActivityIndicator color="#fff" />
                      <Text style={styles.saveBtnText}>Parsing…</Text>
                    </View>
                  ) : (
                    <Text style={styles.saveBtnText}>Parse + save</Text>
                  )}
                </Pressable>
              </View>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/*  Detail sheet                                                       */
/* ------------------------------------------------------------------ */

function DetailSheet({
  receiptId,
  onClose,
  onDeleted,
}: {
  receiptId: number;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const detail = useQuery({
    queryKey: ["receipt", receiptId],
    queryFn: () => api.getReceipt(receiptId),
  });
  const destroy = useMutation({
    mutationFn: () => api.deleteReceipt(receiptId),
    onSuccess: () => {
      tapSuccess();
      onDeleted();
      onClose();
    },
    onError: () => tapError(),
  });

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={styles.modal}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>
            {detail.data?.merchant ?? "Receipt"}
          </Text>
          <Pressable onPress={onClose}>
            <Text style={styles.modalClose}>Close</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.modalContent}>
          {detail.isLoading && (
            <ActivityIndicator color={C.brand} style={{ marginVertical: 32 }} />
          )}
          {detail.data && (
            <>
              <View style={[cardStyle.card, styles.summaryRow]}>
                <View style={styles.summaryStat}>
                  <Text style={styles.summaryLabel}>Subtotal</Text>
                  <Text style={styles.summaryValue}>
                    {detail.data.subtotal_cents != null
                      ? fmtCents(detail.data.subtotal_cents)
                      : "—"}
                  </Text>
                </View>
                <View style={styles.summaryStat}>
                  <Text style={styles.summaryLabel}>Tax</Text>
                  <Text style={styles.summaryValue}>
                    {detail.data.tax_cents != null
                      ? fmtCents(detail.data.tax_cents)
                      : "—"}
                  </Text>
                </View>
                <View style={styles.summaryStat}>
                  <Text style={styles.summaryLabel}>Total</Text>
                  <Text style={styles.summaryValue}>
                    {detail.data.total_cents != null
                      ? fmtCents(detail.data.total_cents)
                      : "—"}
                  </Text>
                </View>
              </View>

              {detail.data.items.length > 0 && (
                <View style={cardStyle.card}>
                  <Text style={styles.sectionTitle}>
                    Line items ({detail.data.items.length})
                  </Text>
                  {detail.data.items.map((it) => (
                    <View key={it.id} style={styles.itemRow}>
                      <View style={styles.itemMain}>
                        <Text style={styles.itemName} numberOfLines={2}>
                          {it.name ?? it.raw_line}
                        </Text>
                        {it.item_category ? (
                          <Text style={styles.itemCategory}>{it.item_category}</Text>
                        ) : null}
                      </View>
                      <Text style={styles.itemAmount}>
                        {it.line_total_cents != null
                          ? fmtCents(it.line_total_cents)
                          : "—"}
                      </Text>
                    </View>
                  ))}
                </View>
              )}

              {detail.data.coupons.length > 0 && (
                <View style={[cardStyle.card, styles.couponSection]}>
                  <Text style={styles.sectionTitle}>
                    Coupons & offers ({detail.data.coupons.length})
                  </Text>
                  {detail.data.coupons.map((c) => (
                    <View key={c.id} style={styles.couponRow}>
                      <Text style={styles.couponTitle}>{c.title}</Text>
                      {(c.code || c.estimated_value_cents != null) && (
                        <Text style={styles.couponMeta}>
                          {c.code ? `Code: ${c.code}` : ""}
                          {c.code && c.estimated_value_cents != null ? "  ·  " : ""}
                          {c.estimated_value_cents != null
                            ? fmtCents(c.estimated_value_cents)
                            : ""}
                          {c.expires_at ? `  ·  expires ${c.expires_at}` : ""}
                        </Text>
                      )}
                    </View>
                  ))}
                </View>
              )}

              <Pressable
                onPress={() => {
                  Alert.alert(
                    "Delete receipt?",
                    `This will remove "${detail.data?.merchant ?? "this receipt"}" and all its items + coupons.`,
                    [
                      { text: "Cancel", style: "cancel" },
                      {
                        text: "Delete",
                        style: "destructive",
                        onPress: () => destroy.mutate(),
                      },
                    ],
                  );
                }}
                style={styles.deleteBtn}
              >
                <Text style={styles.deleteBtnText}>Delete receipt</Text>
              </Pressable>
            </>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/*  Screen                                                             */
/* ------------------------------------------------------------------ */

export default function ReceiptsScreen() {
  const qc = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);

  const list = useQuery({ queryKey: ["receipts"], queryFn: () => api.listReceipts() });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["receipts"] });

  return (
    <View style={styles.screen}>
      <View style={headerStyles.header}>
        <View style={styles.headerInner}>
          <View style={styles.headerLeft}>
            <Text style={headerStyles.headerTitle}>Receipts</Text>
            <Text style={headerStyles.headerSub}>
              {list.data?.length ?? 0} logged · pull to refresh
            </Text>
          </View>
          <Pressable
            onPress={() => {
              tapLight();
              setAddOpen(true);
            }}
            style={({ pressed }) => [styles.addBtn, pressed && { opacity: 0.85 }]}
          >
            <Text style={styles.addBtnText}>+ Add</Text>
          </Pressable>
        </View>
      </View>

      <FlatList
        data={list.data ?? []}
        keyExtractor={(r) => String(r.id)}
        renderItem={({ item }) => (
          <ReceiptRow r={item} onTap={() => setOpenId(item.id)} />
        )}
        ItemSeparatorComponent={() => <View style={styles.listSep} />}
        refreshControl={
          <RefreshControl
            refreshing={list.isFetching}
            onRefresh={() => list.refetch()}
            tintColor={C.brand}
          />
        }
        ListEmptyComponent={
          <EmptyState
            icon="🧾"
            title="No receipts yet"
            body="Snap one at the register, pick from your library, or paste OCR text. The parser pulls items + coupons automatically."
            cta={{
              label: "Add a receipt",
              onPress: () => {
                tapLight();
                setAddOpen(true);
              },
            }}
          />
        }
        contentContainerStyle={
          (list.data ?? []).length === 0 ? styles.flexCenter : undefined
        }
      />

      <AddSheet
        visible={addOpen}
        onClose={() => setAddOpen(false)}
        onSaved={invalidate}
      />
      {openId != null && (
        <DetailSheet
          receiptId={openId}
          onClose={() => setOpenId(null)}
          onDeleted={invalidate}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, padding: 24, alignItems: "center", justifyContent: "center" },
  flexCenter: { flexGrow: 1 },
  hint: { color: C.textMuted, fontSize: 13, textAlign: "center", marginTop: 12 },

  headerInner: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  headerLeft: { flex: 1 },
  addBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: "#fff",
    borderRadius: 6,
  },
  addBtnText: { color: C.brand, fontWeight: "700", fontSize: 13 },

  listRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: C.card,
  },
  listRowMain: { flex: 1 },
  listRowHeader: { flexDirection: "row", alignItems: "center" },
  merchantText: { color: C.text, fontSize: 14, fontWeight: "600", flex: 1, paddingRight: 8 },
  dateText: { color: C.textMuted, fontSize: 11, marginTop: 2 },
  totalText: { color: C.text, fontSize: 14, fontWeight: "600", marginLeft: 12 },
  listSep: { height: StyleSheet.hairlineWidth, backgroundColor: C.borderSoft },

  statusBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
  },
  statusText: { fontSize: 9, fontWeight: "700", textTransform: "uppercase" },

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
  modalContent: { padding: 16, paddingBottom: 32 },
  modalHint: { color: C.textMuted, fontSize: 12, marginBottom: 12, lineHeight: 17 },
  textArea: {
    backgroundColor: C.card,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.border,
    padding: 12,
    minHeight: 200,
    color: C.text,
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }),
    fontSize: 12,
  },
  saveBtn: {
    backgroundColor: C.brandAccent,
    borderRadius: 6,
    padding: 12,
    alignItems: "center",
    marginTop: 16,
  },
  saveBtnText: { color: "#fff", fontWeight: "600", fontSize: 14 },

  // Add-sheet mode menu
  modeMenu: { gap: 12 },
  modeIntro: { color: C.textMuted, fontSize: 13, lineHeight: 19, marginBottom: 4 },
  modeCard: {
    backgroundColor: C.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.border,
    borderRadius: 10,
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
  },
  modeCardPrimary: {
    backgroundColor: C.brandLight,
    borderColor: C.brand,
  },
  modeCardIcon: { fontSize: 28, marginRight: 12 },
  modeCardBody: { flex: 1 },
  modeCardTitle: { color: C.text, fontSize: 15, fontWeight: "700" },
  modeCardDesc: { color: C.textMuted, fontSize: 12, marginTop: 2 },
  modeCardArrow: { color: C.textSoft, fontSize: 24, marginLeft: 8 },

  // Image preview
  preview: {
    backgroundColor: "#000",
    borderRadius: 8,
    overflow: "hidden",
    marginVertical: 12,
    aspectRatio: 0.65, // receipts tend to be tall
    maxHeight: 480,
  },
  previewImage: { width: "100%", height: "100%" },
  previewActions: { flexDirection: "row", marginTop: 16, gap: 8 },
  secondaryBtn: {
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.border,
    backgroundColor: C.card,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryBtnText: { color: C.textMuted, fontSize: 13, fontWeight: "600" },
  busyRow: { flexDirection: "row", alignItems: "center", gap: 8 },

  // Detail
  summaryRow: { flexDirection: "row" },
  summaryStat: { flex: 1, padding: 4 },
  summaryLabel: { color: C.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 },
  summaryValue: { color: C.text, fontSize: 16, fontWeight: "600", marginTop: 4 },

  sectionTitle: { color: C.text, fontSize: 14, fontWeight: "600", marginBottom: 8 },
  itemRow: {
    flexDirection: "row",
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.borderSoft,
    alignItems: "center",
  },
  itemMain: { flex: 1, paddingRight: 8 },
  itemName: { color: C.text, fontSize: 13 },
  itemCategory: { color: C.textSoft, fontSize: 11, marginTop: 2 },
  itemAmount: { color: C.text, fontSize: 13, fontWeight: "600" },

  couponSection: { backgroundColor: "#fff7ed" },
  couponRow: {
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#fed7aa",
  },
  couponTitle: { color: "#9a3412", fontSize: 13, fontWeight: "600" },
  couponMeta: { color: "#c2410c", fontSize: 11, marginTop: 4 },

  deleteBtn: { padding: 12, alignItems: "center", marginTop: 16 },
  deleteBtnText: { color: C.outflow, fontWeight: "600", fontSize: 13 },
});
