import { Ionicons } from "@expo/vector-icons";
import { useEffect, useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { SheetBackdrop } from "@/components/ui";
import { describeStyleProfileOption, type StyleProfileOption } from "@/style/profile-options";
import { colors, radius, spacing } from "@/theme";
import type { StyleProfile } from "@/types";

/**
 * 写作页与助手页共用的文风选择器。
 * 同名参考文风可能来自多次导入的不同文件，所以每行都带来源（格式/字数）、蒸馏轮次与覆盖进度，
 * 以及指南开头预览，并提供「查看全文」——只显示名字时根本分不出哪份是哪份。
 */
export function StyleProfilePickerSheet(input: {
  visible: boolean;
  title?: string;
  subtitle?: string;
  options: StyleProfileOption[];
  activeProfileId: string | null;
  onSelect: (profile: StyleProfile | null) => void;
  onClose: () => void;
}) {
  const [previewId, setPreviewId] = useState<string | null>(null);
  const previewOption = input.options.find((option) => option.profile.id === previewId) ?? null;

  useEffect(() => {
    if (!input.visible) setPreviewId(null);
  }, [input.visible]);

  const duplicateTitle = useMemo(() => {
    const counts = new Map<string, number>();
    for (const option of input.options) {
      const title = describeStyleProfileOption(option).title;
      counts.set(title, (counts.get(title) ?? 0) + 1);
    }
    return [...counts.entries()].find(([, count]) => count > 1) ?? null;
  }, [input.options]);

  return (
    <Modal visible={input.visible} transparent animationType="slide" onRequestClose={input.onClose}>
      <SheetBackdrop onPress={input.onClose}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            {previewOption ? (
              <Pressable accessibilityLabel="返回文风列表" onPress={() => setPreviewId(null)} style={styles.iconButton}>
                <Ionicons name="chevron-back" size={24} color={colors.text} />
              </Pressable>
            ) : null}
            <View style={styles.headerCopy}>
              <Text style={styles.title} numberOfLines={2}>
                {previewOption ? describeStyleProfileOption(previewOption).title : input.title ?? "选择创作文风"}
              </Text>
              <Text style={styles.subtitle} numberOfLines={previewOption ? 3 : 2}>
                {previewOption
                  ? "以下是这份文风的完整内容，只读预览"
                  : input.subtitle ?? "会用于助手生成或修改正文"}
              </Text>
            </View>
            <Pressable accessibilityLabel="关闭文风列表" onPress={input.onClose} style={styles.iconButton}>
              <Ionicons name="close" size={24} color={colors.textMuted} />
            </Pressable>
          </View>

          {previewOption ? (
            <ScrollView style={styles.list} contentContainerStyle={styles.previewContent}>
              <Text style={styles.previewMeta}>{describeStyleProfileOption(previewOption).meta}</Text>
              <Text selectable style={styles.previewText}>{previewOption.profile.guide}</Text>
            </ScrollView>
          ) : (
            <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
              {duplicateTitle ? (
                <View style={styles.notice}>
                  <Ionicons name="information-circle-outline" size={17} color={colors.primary} />
                  <Text style={styles.noticeText}>
                    有 {duplicateTitle[1]} 份同名参考文风，来自多次导入的不同文件（看字数与轮次区分）。不用的那几份到“文风书库 → 参考小说”删掉对应参考书即可。
                  </Text>
                </View>
              ) : null}
              <Pressable
                onPress={() => input.onSelect(null)}
                style={[styles.row, input.activeProfileId === null && styles.rowActive]}
              >
                <Ionicons
                  name={input.activeProfileId === null ? "radio-button-on" : "radio-button-off"}
                  size={20}
                  color={input.activeProfileId === null ? colors.primary : colors.textMuted}
                />
                <View style={styles.rowCopy}>
                  <Text style={styles.rowTitle}>不使用文风</Text>
                  <Text style={styles.rowMeta}>只遵循本轮要求与作品设定</Text>
                </View>
              </Pressable>
              {input.options.length ? input.options.map((option) => {
                const description = describeStyleProfileOption(option);
                const selected = option.profile.id === input.activeProfileId;
                return (
                  <View key={option.profile.id} style={[styles.row, selected && styles.rowActive]}>
                    <Pressable
                      accessibilityLabel={`使用 ${description.title}`}
                      onPress={() => input.onSelect(option.profile)}
                      style={styles.rowMain}
                    >
                      <Ionicons
                        name={selected ? "radio-button-on" : "radio-button-off"}
                        size={20}
                        color={selected ? colors.primary : colors.textMuted}
                      />
                      <View style={styles.rowCopy}>
                        <Text style={styles.rowTitle} numberOfLines={2}>{description.title}</Text>
                        <Text style={styles.rowMeta} numberOfLines={2}>{description.meta}</Text>
                        <Text style={styles.rowPreview} numberOfLines={2}>{description.preview}</Text>
                      </View>
                    </Pressable>
                    <Pressable
                      accessibilityLabel={`查看 ${description.title} 的完整内容`}
                      onPress={() => setPreviewId(option.profile.id)}
                      style={styles.previewButton}
                    >
                      <Ionicons name="document-text-outline" size={18} color={colors.primary} />
                      <Text style={styles.previewButtonText}>全文</Text>
                    </Pressable>
                  </View>
                );
              }) : (
                <Text style={styles.emptyHint}>还没有可选文风；到“设置 → 作者文风”（文风书库）蒸馏参考文风，或进化一份作者文风。</Text>
              )}
            </ScrollView>
          )}
        </View>
      </SheetBackdrop>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: { maxHeight: "86%", borderTopLeftRadius: radius.md, borderTopRightRadius: radius.md, backgroundColor: colors.background },
  header: { minHeight: 70, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingLeft: spacing.sm, paddingRight: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  headerCopy: { flex: 1, minWidth: 0, paddingVertical: spacing.sm },
  title: { color: colors.text, fontSize: 19, fontWeight: "700" },
  subtitle: { marginTop: 3, color: colors.textMuted, fontSize: 12, lineHeight: 17 },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  list: { flexShrink: 1 },
  listContent: { padding: spacing.md, gap: spacing.sm },
  previewContent: { padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xxl },
  previewMeta: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
  previewText: { color: colors.text, fontSize: 14, lineHeight: 22 },
  notice: { flexDirection: "row", alignItems: "flex-start", gap: spacing.xs, padding: spacing.sm, borderWidth: 1, borderColor: colors.primary, borderRadius: radius.sm, backgroundColor: "#E6F3EF" },
  noticeText: { flex: 1, color: colors.textMuted, fontSize: 12, lineHeight: 18 },
  row: { flexDirection: "row", alignItems: "center", borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, backgroundColor: colors.surface },
  rowActive: { borderColor: colors.primary, backgroundColor: "#E6F3EF" },
  rowMain: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "flex-start", gap: spacing.sm, padding: spacing.md },
  rowCopy: { flex: 1, minWidth: 0, gap: 3 },
  rowTitle: { color: colors.text, fontSize: 15, fontWeight: "700" },
  rowMeta: { color: colors.textMuted, fontSize: 12, lineHeight: 17 },
  rowPreview: { color: colors.textMuted, fontSize: 12, lineHeight: 17, opacity: 0.85 },
  previewButton: { width: 52, minHeight: 44, alignItems: "center", justifyContent: "center", gap: 2, marginRight: spacing.xs },
  previewButtonText: { color: colors.primary, fontSize: 11, fontWeight: "700" },
  emptyHint: { color: colors.textMuted, fontSize: 13, lineHeight: 20, padding: spacing.md },
});
