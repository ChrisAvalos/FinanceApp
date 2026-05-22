/**
 * Class-action claims — mobile screen (Settlemate-inspired).
 *
 * Phone-first cohort UX from web LegalClaimsPanel:
 *   • Hero card with "$X pending" headline scoped to selected state
 *   • State filter chips (All / Nationwide / CA / FL / TX / etc.) ranked by count
 *   • Status filter chips (No proof / Needs proof / Triage / Filed / Paid)
 *   • Card list with per-claim "Mark filed" / "Skip" inline actions
 */
import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  api,
  fmtCents,
  type LegalClaim,
  type ProofRequirement,
} from "../api/client";
import { C, cardStyle, headerStyles } from "../theme";
import { tapError, tapSuccess } from "../util/feedback";

const STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "DC", FL: "Florida",
  GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana",
  IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine",
  MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada",
  NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma",
  OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin",
  WY: "Wyoming",
};

type TabKey = "no_proof" | "needs_proof" | "triage" | "filed" | "paid";

const TAB_DEFS: { key: TabKey; label: string }[] = [
  { key: "no_proof", label: "No proof" },
  { key: "needs_proof", label: "Needs proof" },
  { key: "triage", label: "Triage" },
  { key: "filed", label: "Filed" },
  { key: "paid", label: "Paid" },
];

function classifyTab(c: LegalClaim): TabKey | null {
  if (c.status === "paid") return "paid";
  if (c.status === "claimed") return "filed";
  if (c.status === "dismissed" || c.is_expired) return null;
  if (c.proof_status === "required") return "needs_proof";
  if (c.proof_status === "unknown") return "triage";
  return "no_proof";
}

function ProofBadge({ status }: { status: ProofRequirement }) {
  const cfg: Record<ProofRequirement, { label: string; bg: string; fg: string }> = {
    not_required: { label: "✓ No Proof", bg: "#d1fae5", fg: "#065f46" },
    required: { label: "Proof Req'd", bg: "#dbeafe", fg: "#1e40af" },
    unknown: { label: "?", bg: "#e2e8f0", fg: "#475569" },
  };
  const c = cfg[status];
  return (
    <View style={[styles.pill, { backgroundColor: c.bg }]}>
      <Text style={[styles.pillText, { color: c.fg }]}>{c.label}</Text>
    </View>
  );
}

function ClaimCard({
  claim,
  onUpdate,
}: {
  claim: LegalClaim;
  onUpdate: (patch: Partial<LegalClaim>) => void;
}) {
  const isAvailable = claim.status === "available" && !claim.is_expired;
  const isUnknownProof = claim.proof_status === "unknown";

  return (
    <View style={styles.claimCard}>
      <View style={styles.claimHeader}>
        <View style={styles.claimLeft}>
          <Text style={styles.claimName} numberOfLines={2}>{claim.name}</Text>
          <View style={styles.metaRow}>
            <ProofBadge status={claim.proof_status} />
            {claim.state_eligibility !== "nationwide" && (
              <Text style={styles.stateText}>{claim.state_eligibility}</Text>
            )}
          </View>
        </View>
        <View style={styles.claimRight}>
          <Text style={styles.claimAmount}>
            {claim.estimated_payout_cents != null
              ? `Up to ${fmtCents(claim.estimated_payout_cents)}`
              : "TBD"}
          </Text>
          <Text style={styles.claimDeadline}>
            {claim.is_expired
              ? `Expired ${Math.abs(claim.days_until_deadline ?? 0)}d ago`
              : claim.claim_deadline
                ? `${claim.days_until_deadline}d left`
                : "No deadline"}
          </Text>
        </View>
      </View>

      {/* Triage actions for unknown proof */}
      {isUnknownProof && isAvailable && (
        <View style={styles.triageRow}>
          <Text style={styles.triageLabel}>Proof needed?</Text>
          <Pressable
            onPress={() => onUpdate({ proof_status: "not_required" })}
            style={[styles.miniBtn, { backgroundColor: "#d1fae5" }]}
          >
            <Text style={[styles.miniBtnText, { color: "#065f46" }]}>No</Text>
          </Pressable>
          <Pressable
            onPress={() => onUpdate({ proof_status: "required" })}
            style={[styles.miniBtn, { backgroundColor: "#dbeafe" }]}
          >
            <Text style={[styles.miniBtnText, { color: "#1e40af" }]}>Yes</Text>
          </Pressable>
        </View>
      )}

      <View style={styles.actionRow}>
        <Pressable
          onPress={() => Linking.openURL(claim.source_url).catch(() => {})}
          style={({ pressed }) => [styles.fileBtn, pressed && { opacity: 0.85 }]}
        >
          <Text style={styles.fileBtnText}>File claim →</Text>
        </Pressable>
        {isAvailable && (
          <>
            <Pressable
              onPress={() => onUpdate({ status: "claimed" })}
              style={({ pressed }) => [styles.markBtn, pressed && { opacity: 0.85 }]}
            >
              <Text style={styles.markBtnText}>Mark filed</Text>
            </Pressable>
            <Pressable
              onPress={() => onUpdate({ status: "dismissed" })}
              style={styles.skipBtn}
            >
              <Text style={styles.skipBtnText}>Skip</Text>
            </Pressable>
          </>
        )}
        {claim.status === "paid" && claim.actual_payout_cents != null && (
          <Text style={styles.paidText}>
            ✓ Received {fmtCents(claim.actual_payout_cents)}
          </Text>
        )}
      </View>
    </View>
  );
}

/* ------------------------------------------------------------------ */
/*  Hero card                                                         */
/* ------------------------------------------------------------------ */

function Hero({
  claims,
  state,
}: {
  claims: LegalClaim[];
  state: string;
}) {
  const live = claims.filter((c) => c.status === "available" && !c.is_expired);
  const total = live.reduce((s, c) => s + (c.estimated_payout_cents ?? 0), 0);
  const stateLabel =
    state === "" ? "" :
    state === "nationwide" ? " in nationwide settlements" :
    ` in ${STATE_NAMES[state] || state} + nationwide`;
  return (
    <View style={[cardStyle.card, styles.hero]}>
      <Text style={styles.heroLabel}>You've got up to</Text>
      <Text style={styles.heroAmount}>{fmtCents(total)}</Text>
      <Text style={styles.heroSub}>
        in pending payouts{stateLabel} — across {live.length} live claim{live.length === 1 ? "" : "s"}
      </Text>
    </View>
  );
}

/* ------------------------------------------------------------------ */
/*  State chips                                                       */
/* ------------------------------------------------------------------ */

function StateChips({
  active,
  onPick,
  counts,
}: {
  active: string;
  onPick: (s: string) => void;
  counts: Record<string, number>;
}) {
  const stateEntries = Object.entries(counts)
    .filter(([k]) => k !== "nationwide")
    .sort((a, b) => b[1] - a[1]);
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.chipRow}
    >
      <ChipBtn active={active === ""} onClick={() => onPick("")} label="All" />
      <ChipBtn
        active={active === "nationwide"}
        onClick={() => onPick("nationwide")}
        label="Nationwide"
        count={counts["nationwide"] ?? 0}
      />
      {stateEntries.map(([code, n]) => (
        <ChipBtn
          key={code}
          active={active === code}
          onClick={() => onPick(code)}
          label={STATE_NAMES[code] || code}
          count={n}
        />
      ))}
    </ScrollView>
  );
}

function ChipBtn({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
}) {
  return (
    <Pressable
      onPress={onClick}
      style={[styles.chip, active && styles.chipActive]}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>
        {label}{count != null ? ` (${count})` : ""}
      </Text>
    </Pressable>
  );
}

/* ------------------------------------------------------------------ */
/*  Screen                                                            */
/* ------------------------------------------------------------------ */

export default function ClaimsScreen() {
  const qc = useQueryClient();
  const [stateFilter, setStateFilter] = useState<string>("");
  const [tab, setTab] = useState<TabKey>("no_proof");

  const claims = useQuery({
    queryKey: ["legalClaims", stateFilter],
    queryFn: () => api.listLegalClaims(stateFilter ? { state: stateFilter } : {}),
  });
  const stats = useQuery({ queryKey: ["legalClaimStats"], queryFn: api.legalClaimStats });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["legalClaims"] });
    qc.invalidateQueries({ queryKey: ["legalClaimStats"] });
  };
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: Partial<LegalClaim> }) =>
      api.updateLegalClaim(id, patch),
    onSuccess: () => {
      tapSuccess();
      invalidate();
    },
    onError: () => tapError(),
  });

  const visible = useMemo(() => {
    return (claims.data ?? []).filter((c) => classifyTab(c) === tab);
  }, [claims.data, tab]);

  const counts = useMemo(() => {
    const by: Record<TabKey, number> = {
      no_proof: 0, needs_proof: 0, triage: 0, filed: 0, paid: 0,
    };
    for (const c of claims.data ?? []) {
      const k = classifyTab(c);
      if (k) by[k]++;
    }
    return by;
  }, [claims.data]);

  if (claims.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={C.brand} />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={headerStyles.header}>
        <Text style={headerStyles.headerTitle}>Class-action claims</Text>
        <Text style={headerStyles.headerSub}>
          {fmtCents(stats.data?.pending_potential_cents ?? 0)} pending · {fmtCents(stats.data?.collected_cents ?? 0)} collected
        </Text>
      </View>

      <FlatList
        ListHeaderComponent={
          <View>
            <View style={{ paddingHorizontal: 16, paddingTop: 16 }}>
              <Hero claims={claims.data ?? []} state={stateFilter} />
            </View>
            <StateChips
              active={stateFilter}
              onPick={setStateFilter}
              counts={stats.data?.counts_by_state ?? {}}
            />
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={[styles.chipRow, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.borderSoft, paddingTop: 8 }]}
            >
              {TAB_DEFS.map((t) => {
                const isActive = t.key === tab;
                return (
                  <Pressable
                    key={t.key}
                    onPress={() => setTab(t.key)}
                    style={[styles.tabChip, isActive && styles.tabChipActive]}
                  >
                    <Text style={[styles.tabChipText, isActive && styles.tabChipTextActive]}>
                      {t.label} ({counts[t.key]})
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        }
        data={visible}
        keyExtractor={(c) => String(c.id)}
        renderItem={({ item }) => (
          <ClaimCard
            claim={item}
            onUpdate={(patch) => update.mutate({ id: item.id, patch })}
          />
        )}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={claims.isFetching}
            onRefresh={() => { claims.refetch(); stats.refetch(); }}
            tintColor={C.brand}
          />
        }
        ListEmptyComponent={
          <View style={styles.center}>
            <Text style={styles.hint}>
              {emptyMessage(tab, stateFilter)}
            </Text>
          </View>
        }
      />
    </View>
  );
}

function emptyMessage(tab: TabKey, state: string): string {
  const stateLabel = !state ? "" : state === "nationwide" ? " (nationwide-only)" : ` in ${STATE_NAMES[state] || state}`;
  switch (tab) {
    case "no_proof":   return `No quick (no-proof) claims${stateLabel}.`;
    case "needs_proof": return `No proof-required claims${stateLabel}.`;
    case "triage":     return "No claims awaiting triage.";
    case "filed":      return "Nothing waiting for payout.";
    case "paid":       return "No paid settlements yet.";
  }
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, padding: 24, alignItems: "center", justifyContent: "center" },
  hint: { color: C.textMuted, fontSize: 13, textAlign: "center" },

  hero: { backgroundColor: C.brand, marginBottom: 4 },
  heroLabel: { color: C.brandLight, fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5 },
  heroAmount: { color: "#fff", fontSize: 28, fontWeight: "700", marginTop: 4 },
  heroSub: { color: C.brandLight, fontSize: 12, marginTop: 4, lineHeight: 17 },

  chipRow: { paddingHorizontal: 16, paddingVertical: 8 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.card,
    marginRight: 8,
  },
  chipActive: { backgroundColor: C.text, borderColor: C.text },
  chipText: { fontSize: 11, color: C.text, fontWeight: "600" },
  chipTextActive: { color: "#fff" },

  tabChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.card,
    marginRight: 8,
  },
  tabChipActive: { backgroundColor: C.brand, borderColor: C.brand },
  tabChipText: { fontSize: 11, color: C.text, fontWeight: "600" },
  tabChipTextActive: { color: "#fff" },

  listContent: { paddingBottom: 24, paddingTop: 8 },

  claimCard: {
    backgroundColor: C.card,
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 12,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.border,
  },
  claimHeader: { flexDirection: "row" },
  claimLeft: { flex: 1, paddingRight: 8 },
  claimName: { color: C.text, fontSize: 14, fontWeight: "600", lineHeight: 18 },
  metaRow: { flexDirection: "row", alignItems: "center", marginTop: 6, gap: 8 },
  stateText: { color: C.textMuted, fontSize: 11, fontWeight: "600" },
  pill: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  pillText: { fontSize: 10, fontWeight: "700" },
  claimRight: { alignItems: "flex-end" },
  claimAmount: { color: C.text, fontSize: 13, fontWeight: "600" },
  claimDeadline: { color: C.textMuted, fontSize: 11, marginTop: 4 },

  triageRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#f8fafc",
    borderRadius: 6,
    padding: 8,
    marginTop: 8,
    gap: 8,
  },
  triageLabel: { color: C.textMuted, fontSize: 11 },
  miniBtn: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 4 },
  miniBtnText: { fontSize: 11, fontWeight: "700" },

  actionRow: { flexDirection: "row", marginTop: 10, alignItems: "center", flexWrap: "wrap", gap: 6 },
  fileBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: C.brandAccent,
  },
  fileBtnText: { color: C.brandAccent, fontSize: 11, fontWeight: "700" },
  markBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 4,
    backgroundColor: C.brand,
  },
  markBtnText: { color: "#fff", fontSize: 11, fontWeight: "700" },
  skipBtn: { paddingHorizontal: 6, paddingVertical: 6 },
  skipBtnText: { color: C.textMuted, fontSize: 11 },
  paidText: { color: C.inflow, fontSize: 12, fontWeight: "600" },
});
