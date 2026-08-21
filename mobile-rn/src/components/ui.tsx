import { Ionicons } from "@expo/vector-icons";
import type { PropsWithChildren, ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { SafeAreaView } from "react-native-safe-area-context";

import { colors, radius, spacing } from "@/theme";

export function Screen({ children, scroll = false }: PropsWithChildren<{ scroll?: boolean }>) {
  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      {scroll ? (
        <KeyboardAwareScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          bottomOffset={spacing.lg}
        >
          {children}
        </KeyboardAwareScrollView>
      ) : children}
    </SafeAreaView>
  );
}

export function Header({ title, action, onBack }: { title: string; action?: ReactNode; onBack?: () => void }) {
  return (
    <View style={styles.header}>
      <View style={styles.headerLeading}>
        {onBack ? (
          <Pressable accessibilityLabel="返回" onPress={onBack} style={styles.headerBack}>
            <Ionicons name="chevron-back" size={24} color={colors.text} />
          </Pressable>
        ) : null}
        <Text style={styles.headerTitle} numberOfLines={1}>{title}</Text>
      </View>
      {action}
    </View>
  );
}

export function Field({ label, ...props }: TextInputProps & { label: string }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput placeholderTextColor={colors.textMuted} style={styles.input} {...props} />
    </View>
  );
}

export function Button({
  label,
  onPress,
  variant = "primary",
  disabled = false,
  loading = false,
}: {
  label: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  loading?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        variant === "primary" && styles.buttonPrimary,
        variant === "secondary" && styles.buttonSecondary,
        variant === "danger" && styles.buttonDanger,
        (pressed || disabled) && styles.buttonPressed,
      ]}
    >
      {loading ? <ActivityIndicator color={variant === "secondary" ? colors.text : "#FFFFFF"} /> : (
        <Text style={[styles.buttonText, variant === "secondary" && styles.buttonTextSecondary]}>{label}</Text>
      )}
    </Pressable>
  );
}

export function EmptyState({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      {action}
    </View>
  );
}

export function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <View accessibilityLiveRegion="polite" style={styles.errorNotice}>
      <Text style={styles.errorText}>{message}</Text>
      {onRetry ? (
        <Pressable accessibilityRole="button" onPress={onRetry} style={styles.retryButton}>
          <Text style={styles.retryText}>重试</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * 底部弹层的遮罩。遮罩是铺满全屏的兄弟节点并排在内容之前，内容自然盖在它上面，
 * 因此点击内容不会命中遮罩，点击内容之外才会关闭。
 *
 * 不要退回"用 Pressable 包住整个弹层、再给内容加 onStartShouldSetResponder"的写法：
 * 那样会在触摸开始时抢走 JS responder，慢速拖动就会挡住内部 ScrollView 的滚动，
 * 表现为滚动时灵时不灵。
 */
export function SheetBackdrop({ onPress, children }: PropsWithChildren<{ onPress: () => void }>) {
  return (
    <View style={styles.sheetBackdrop}>
      <Pressable accessibilityLabel="关闭弹层" style={StyleSheet.absoluteFill} onPress={onPress} />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  sheetBackdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: colors.overlay },
  screen: { flex: 1, backgroundColor: colors.background },
  scroll: { paddingBottom: 40 },
  header: {
    minHeight: 58,
    paddingHorizontal: spacing.lg,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  headerLeading: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center" },
  headerBack: { width: 44, height: 44, alignItems: "flex-start", justifyContent: "center" },
  headerTitle: { flex: 1, color: colors.text, fontSize: 22, fontWeight: "700" },
  field: { gap: spacing.sm },
  label: { color: colors.textMuted, fontSize: 13, fontWeight: "600" },
  input: {
    minHeight: 46,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    color: colors.text,
    fontSize: 16,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  button: {
    minHeight: 44,
    minWidth: 44,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonPrimary: { backgroundColor: colors.primary },
  buttonSecondary: { backgroundColor: colors.surfaceMuted, borderWidth: 1, borderColor: colors.border },
  buttonDanger: { backgroundColor: colors.danger },
  buttonPressed: { opacity: 0.64 },
  buttonText: { color: "#FFFFFF", fontWeight: "700", fontSize: 15 },
  buttonTextSecondary: { color: colors.text },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.lg, padding: spacing.xl },
  emptyTitle: { color: colors.textMuted, fontSize: 16, textAlign: "center" },
  errorNotice: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: "#FDECEA",
  },
  errorText: { flex: 1, color: colors.danger, fontSize: 13, lineHeight: 19 },
  retryButton: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
  retryText: { color: colors.danger, fontSize: 13, fontWeight: "700" },
});
