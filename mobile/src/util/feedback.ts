/**
 * Shared haptic + feedback helpers — thin wrappers that fail silently on
 * platforms / hosts that don't support haptics (web, Android emulator,
 * Expo Go without the module loaded). Called liberally on confirm /
 * dismiss / status-change actions so the app feels native.
 *
 * Why centralized: lets us swap the engine later (e.g. expo-haptics →
 * react-native-haptic-feedback) without touching every callsite.
 */
import * as Haptics from "expo-haptics";

/** Light tap — for filter chip selection, primary tab change, value increments. */
export function tapLight(): void {
  try {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  } catch {
    // expo-haptics not available — fail silently.
  }
}

/** Medium tap — for confirming a positive action (mark filed, save, claim). */
export function tapMedium(): void {
  try {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  } catch {
    // ignore
  }
}

/** Success notification — for completed mutations (saved, paid, parsed). */
export function tapSuccess(): void {
  try {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  } catch {
    // ignore
  }
}

/** Warning notification — for "review this" prompts (over budget, conflict). */
export function tapWarning(): void {
  try {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
  } catch {
    // ignore
  }
}

/** Error notification — for failed mutations / validation errors. */
export function tapError(): void {
  try {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
  } catch {
    // ignore
  }
}
