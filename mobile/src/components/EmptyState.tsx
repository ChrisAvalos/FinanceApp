/**
 * Shared empty-state component.
 *
 * Replaces ad-hoc "no data yet" text strings with a consistent visual
 * treatment: large emoji icon, clear heading, body copy, and an
 * optional primary CTA. Keeps the app feeling intentional even when
 * data hasn't loaded yet.
 *
 * Style is deliberately understated — soft greys, no heavy strokes.
 * The hero card on each screen carries the visual weight; the empty
 * state should feel calm and informative rather than alarming.
 */
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { C } from "../theme";

export type EmptyStateProps = {
  /** A single emoji or short string used as the hero glyph. */
  icon?: string;
  /** Required headline — concise, sentence-case. */
  title: string;
  /** Body copy explaining the state and how to populate it. */
  body?: string;
  /** Optional CTA — when provided, renders as a brand-colored button. */
  cta?: { label: string; onPress: () => void };
};

export default function EmptyState({ icon = "✨", title, body, cta }: EmptyStateProps) {
  return (
    <View style={styles.wrap}>
      <Text style={styles.icon}>{icon}</Text>
      <Text style={styles.title}>{title}</Text>
      {body ? <Text style={styles.body}>{body}</Text> : null}
      {cta ? (
        <Pressable
          onPress={cta.onPress}
          style={({ pressed }) => [styles.cta, pressed && { opacity: 0.7 }]}
        >
          <Text style={styles.ctaText}>{cta.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 48,
    paddingHorizontal: 32,
  },
  icon: { fontSize: 44, marginBottom: 12, opacity: 0.85 },
  title: {
    color: C.text,
    fontSize: 16,
    fontWeight: "700",
    textAlign: "center",
    marginBottom: 6,
  },
  body: {
    color: C.textMuted,
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
    maxWidth: 320,
  },
  cta: {
    marginTop: 16,
    paddingVertical: 10,
    paddingHorizontal: 18,
    backgroundColor: C.brand,
    borderRadius: 999,
  },
  ctaText: { color: "#fff", fontSize: 13, fontWeight: "700" },
});
