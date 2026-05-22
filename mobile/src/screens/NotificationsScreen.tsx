/**
 * Notifications — mobile screen.
 *
 * Lightweight inbox view of all in-app alerts: anomaly scans, goal
 * milestones, daily-digest summaries, free-trial conversion alerts, etc.
 *
 * Phone-first treatment:
 *   • Filter toggle: All / Unread
 *   • "Mark all read" header button when there are unread items
 *   • Tap a row to mark-read; long-press (or swipe) for delete
 */
import React, { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, type AppNotification } from "../api/client";
import { C, fmtRelativeDate, headerStyles } from "../theme";

function NotificationRow({
  n,
  onTap,
  onDelete,
}: {
  n: AppNotification;
  onTap: () => void;
  onDelete: () => void;
}) {
  return (
    <Pressable
      onPress={onTap}
      onLongPress={() =>
        Alert.alert("Delete notification?", n.title, [
          { text: "Cancel", style: "cancel" },
          { text: "Delete", style: "destructive", onPress: onDelete },
        ])
      }
      style={({ pressed }) => [
        styles.row,
        !n.is_read && styles.rowUnread,
        pressed && { opacity: 0.85 },
      ]}
    >
      <View style={styles.kindIcon}>
        <Text style={styles.kindText}>{n.kind.charAt(0).toUpperCase()}</Text>
      </View>
      <View style={styles.rowMain}>
        <View style={styles.rowHeader}>
          <Text style={styles.kind} numberOfLines={1}>{n.kind.replace(/_/g, " ")}</Text>
          {!n.is_read && <View style={styles.dot} />}
        </View>
        <Text style={[styles.title, !n.is_read && styles.titleUnread]} numberOfLines={2}>
          {n.title}
        </Text>
        {n.body ? (
          <Text style={styles.body} numberOfLines={2}>{n.body}</Text>
        ) : null}
        <Text style={styles.time}>{fmtRelativeDate(n.created_at)}</Text>
      </View>
    </Pressable>
  );
}

export default function NotificationsScreen() {
  const qc = useQueryClient();
  const [onlyUnread, setOnlyUnread] = useState(false);

  const list = useQuery({
    queryKey: ["notifications", onlyUnread],
    queryFn: () => api.listNotifications(onlyUnread, 100),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["notifications"] });
  const markRead = useMutation({ mutationFn: api.markNotificationRead, onSuccess: invalidate });
  const markAllRead = useMutation({ mutationFn: api.markAllNotificationsRead, onSuccess: invalidate });
  const destroy = useMutation({ mutationFn: api.deleteNotification, onSuccess: invalidate });

  const unreadCount = (list.data ?? []).filter((n) => !n.is_read).length;

  if (list.isLoading) {
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
            <Text style={headerStyles.headerTitle}>Notifications</Text>
            <Text style={headerStyles.headerSub}>
              {unreadCount} unread
              {list.data && ` of ${list.data.length}`}
            </Text>
          </View>
          {unreadCount > 0 && (
            <Pressable
              onPress={() =>
                Alert.alert("Mark all read?", undefined, [
                  { text: "Cancel", style: "cancel" },
                  { text: "Mark all", onPress: () => markAllRead.mutate() },
                ])
              }
              style={({ pressed }) => [styles.markAllBtn, pressed && { opacity: 0.85 }]}
            >
              <Text style={styles.markAllBtnText}>Mark all</Text>
            </Pressable>
          )}
        </View>
      </View>

      <View style={styles.toolbar}>
        <Pressable
          onPress={() => setOnlyUnread(false)}
          style={[styles.toolbarChip, !onlyUnread && styles.toolbarChipActive]}
        >
          <Text style={[styles.toolbarChipText, !onlyUnread && styles.toolbarChipTextActive]}>
            All
          </Text>
        </Pressable>
        <Pressable
          onPress={() => setOnlyUnread(true)}
          style={[styles.toolbarChip, onlyUnread && styles.toolbarChipActive]}
        >
          <Text style={[styles.toolbarChipText, onlyUnread && styles.toolbarChipTextActive]}>
            Unread ({unreadCount})
          </Text>
        </Pressable>
      </View>

      <FlatList
        data={list.data ?? []}
        keyExtractor={(n) => String(n.id)}
        renderItem={({ item }) => (
          <NotificationRow
            n={item}
            onTap={() => {
              if (!item.is_read) markRead.mutate(item.id);
            }}
            onDelete={() => destroy.mutate(item.id)}
          />
        )}
        ItemSeparatorComponent={() => <View style={styles.sep} />}
        refreshControl={
          <RefreshControl
            refreshing={list.isFetching}
            onRefresh={() => list.refetch()}
            tintColor={C.brand}
          />
        }
        ListEmptyComponent={
          <View style={styles.center}>
            <Text style={styles.hint}>
              {onlyUnread
                ? "No unread notifications. ✨"
                : "No notifications yet. Anomaly scans, goal milestones, daily-digest summaries, and unusual-transaction alerts all land here."}
            </Text>
          </View>
        }
        contentContainerStyle={(list.data ?? []).length === 0 ? styles.flexCenter : undefined}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, padding: 24, alignItems: "center", justifyContent: "center" },
  flexCenter: { flexGrow: 1 },
  hint: { color: C.textMuted, fontSize: 13, textAlign: "center" },

  headerInner: { flexDirection: "row", alignItems: "center" },
  markAllBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: "#fff",
    borderRadius: 6,
  },
  markAllBtnText: { color: C.brand, fontSize: 12, fontWeight: "700" },

  toolbar: {
    flexDirection: "row",
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: C.bg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.borderSoft,
  },
  toolbarChip: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
    marginRight: 8,
  },
  toolbarChipActive: { backgroundColor: C.brand, borderColor: C.brand },
  toolbarChipText: { color: C.text, fontSize: 12, fontWeight: "600" },
  toolbarChipTextActive: { color: "#fff" },

  row: {
    flexDirection: "row",
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: C.card,
    alignItems: "flex-start",
  },
  rowUnread: { backgroundColor: "#fffbeb" },
  kindIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: C.brandLight,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 10,
  },
  kindText: { color: C.brand, fontWeight: "700", fontSize: 14 },
  rowMain: { flex: 1 },
  rowHeader: { flexDirection: "row", alignItems: "center", marginBottom: 2 },
  kind: { color: C.textSoft, fontSize: 10, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5, flex: 1 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: C.warn, marginLeft: 4 },
  title: { color: C.textMuted, fontSize: 14, marginTop: 2 },
  titleUnread: { color: C.text, fontWeight: "600" },
  body: { color: C.textMuted, fontSize: 12, marginTop: 4, lineHeight: 17 },
  time: { color: C.textSoft, fontSize: 11, marginTop: 4 },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: C.borderSoft },
});
