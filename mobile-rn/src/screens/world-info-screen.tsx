import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { KeyboardAwareScrollView, KeyboardAvoidingView } from "react-native-keyboard-controller";

import { Button, EmptyState, ErrorNotice, Field, Header, Screen } from "@/components/ui";
import {
  deleteWorldInfoEntry,
  getOrCreateWorldInfo,
  listWorldInfoEntries,
  saveWorldInfo,
  saveWorldInfoEntry,
} from "@/data/repositories";
import type { RootStackParamList } from "@/navigation/types";
import { useAppStore } from "@/store/app-store";
import { colors, radius, spacing } from "@/theme";
import type { WorldInfo, WorldInfoEntry } from "@/types";

export function WorldInfoScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const projectId = useAppStore((state) => state.currentProjectId);
  const [worldInfo, setWorldInfo] = useState<WorldInfo | null>(null);
  const [entries, setEntries] = useState<WorldInfoEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bookName, setBookName] = useState("");
  const [bookDescription, setBookDescription] = useState("");
  const [entryEditorVisible, setEntryEditorVisible] = useState(false);
  const [editingEntry, setEditingEntry] = useState<WorldInfoEntry | null>(null);
  const [entryName, setEntryName] = useState("");
  const [entryContent, setEntryContent] = useState("");
  const [entryEnabled, setEntryEnabled] = useState(true);

  const load = useCallback(async () => {
    if (!projectId) {
      setWorldInfo(null);
      setEntries([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const nextWorldInfo = await getOrCreateWorldInfo(projectId);
      setWorldInfo(nextWorldInfo);
      setBookName(nextWorldInfo.name);
      setBookDescription(nextWorldInfo.description);
      setEntries(await listWorldInfoEntries(nextWorldInfo.id));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useFocusEffect(useCallback(() => {
    void load();
  }, [load]));

  const saveBook = async () => {
    if (!worldInfo || !bookName.trim()) return;
    setSaving(true);
    setError(null);
    try {
      setWorldInfo(await saveWorldInfo({ id: worldInfo.id, projectId: worldInfo.projectId, name: bookName, description: bookDescription }));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };

  const openEntryEditor = (entry?: WorldInfoEntry) => {
    setEditingEntry(entry ?? null);
    setEntryName(entry?.name ?? "");
    setEntryContent(entry?.content ?? "");
    setEntryEnabled(entry?.isEnabled ?? true);
    setEntryEditorVisible(true);
  };

  const saveEntry = async () => {
    if (!worldInfo || !entryName.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await saveWorldInfoEntry({
        id: editingEntry?.id,
        worldInfoId: worldInfo.id,
        name: entryName,
        content: entryContent,
        isEnabled: entryEnabled,
      });
      setEntries((current) => [saved, ...current.filter((item) => item.id !== saved.id)].sort((left, right) => left.order - right.order));
      setEntryEditorVisible(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };

  const removeEntry = (entry: WorldInfoEntry) => {
    Alert.alert("删除世界书条目", `确定删除“${entry.name}”吗？`, [
      { text: "取消", style: "cancel" },
      {
        text: "删除",
        style: "destructive",
        onPress: () => {
          void deleteWorldInfoEntry(entry.id)
            .then(() => setEntries((current) => current.filter((item) => item.id !== entry.id)))
            .catch((deleteError) => setError(deleteError instanceof Error ? deleteError.message : String(deleteError)));
        },
      },
    ]);
  };

  if (!projectId) return <Screen><Header title="世界书" onBack={() => navigation.goBack()} /><EmptyState title="请先从书架打开一部作品" /></Screen>;

  return (
    <Screen>
      <Header
        title="世界书"
        onBack={() => navigation.goBack()}
        action={<Pressable accessibilityLabel="新建世界书条目" onPress={() => openEntryEditor()} style={styles.iconButton}><Ionicons name="add" size={26} color={colors.primary} /></Pressable>}
      />
      {error ? <View style={styles.errorWrap}><ErrorNotice message={error} onRetry={() => void load()} /></View> : null}
      {loading || !worldInfo ? <View style={styles.loading}><ActivityIndicator color={colors.primary} /></View> : (
        <KeyboardAvoidingView style={styles.flex} behavior="height" automaticOffset>
          <FlatList
            data={entries}
            keyExtractor={(item) => item.id}
            style={styles.flex}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            contentContainerStyle={entries.length ? styles.list : styles.emptyList}
            ListHeaderComponent={
              <View style={styles.bookForm}>
                <Field label="世界书名称" value={bookName} onChangeText={setBookName} />
                <Field label="说明" value={bookDescription} onChangeText={setBookDescription} multiline textAlignVertical="top" style={styles.bookDescription} />
                <Button label="保存世界书信息" onPress={() => void saveBook()} disabled={!bookName.trim()} loading={saving} />
                <Text style={styles.sectionTitle}>条目 · {entries.length}</Text>
              </View>
            }
            ListEmptyComponent={<EmptyState title="还没有世界书条目" action={<Button label="新建条目" onPress={() => openEntryEditor()} />} />}
            renderItem={({ item }) => (
              <Pressable onPress={() => openEntryEditor(item)} style={({ pressed }) => [styles.entryRow, pressed && styles.rowPressed]}>
                <View style={styles.entryNumber}><Text style={styles.entryNumberText}>{item.uid}</Text></View>
                <View style={styles.entryText}>
                  <View style={styles.entryTitleLine}>
                    <Text numberOfLines={1} style={styles.entryName}>{item.name}</Text>
                    <Switch value={item.isEnabled} onValueChange={(value) => {
                      void saveWorldInfoEntry({ ...item, worldInfoId: item.worldInfoId, isEnabled: value })
                        .then((saved) => setEntries((current) => current.map((entry) => entry.id === saved.id ? saved : entry)))
                        .catch((toggleError) => setError(toggleError instanceof Error ? toggleError.message : String(toggleError)));
                    }} trackColor={{ false: colors.border, true: colors.primary }} />
                  </View>
                  <Text numberOfLines={2} style={styles.entryContent}>{item.content || "暂无内容"}</Text>
                </View>
                <Pressable accessibilityLabel="删除世界书条目" onPress={() => removeEntry(item)} hitSlop={8} style={styles.iconButton}>
                  <Ionicons name="trash-outline" size={19} color={colors.textMuted} />
                </Pressable>
              </Pressable>
            )}
          />
        </KeyboardAvoidingView>
      )}

      <Modal visible={entryEditorVisible} transparent animationType="slide" onRequestClose={() => setEntryEditorVisible(false)}>
        <KeyboardAvoidingView style={styles.modalBackdrop} behavior="height" automaticOffset>
          <View style={styles.modalBody}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{editingEntry ? "编辑条目" : "新建条目"}</Text>
              <Pressable accessibilityLabel="关闭世界书编辑" onPress={() => setEntryEditorVisible(false)} style={styles.iconButton}>
                <Ionicons name="close" size={24} color={colors.textMuted} />
              </Pressable>
            </View>
            <KeyboardAwareScrollView
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              bottomOffset={spacing.lg}
              extraKeyboardSpace={spacing.md}
              contentContainerStyle={styles.form}
            >
              <Field label="条目名称" value={entryName} onChangeText={setEntryName} autoFocus={!editingEntry} />
              <Field label="条目内容" value={entryContent} onChangeText={setEntryContent} multiline textAlignVertical="top" style={styles.entryInput} placeholder="人物关系、地点规则、时代背景等" />
              <View style={styles.switchRow}>
                <Text style={styles.switchLabel}>启用条目</Text>
                <Switch value={entryEnabled} onValueChange={setEntryEnabled} trackColor={{ false: colors.border, true: colors.primary }} />
              </View>
              <View style={styles.modalActions}>
                <Button label="取消" variant="secondary" onPress={() => setEntryEditorVisible(false)} />
                <Button label="保存" onPress={() => void saveEntry()} disabled={!entryName.trim()} loading={saving} />
              </View>
            </KeyboardAwareScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  errorWrap: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  loading: { flex: 1, alignItems: "center", justifyContent: "center" },
  list: { paddingBottom: spacing.lg },
  emptyList: { flexGrow: 1 },
  bookForm: { gap: spacing.md, padding: spacing.lg, paddingBottom: spacing.xl, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  bookDescription: { minHeight: 90 },
  sectionTitle: { color: colors.text, fontSize: 17, fontWeight: "700", marginTop: spacing.sm },
  entryRow: { minHeight: 90, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  rowPressed: { backgroundColor: colors.surfaceMuted },
  entryNumber: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: colors.surfaceMuted },
  entryNumberText: { color: colors.primary, fontSize: 13, fontWeight: "700" },
  entryText: { flex: 1, minWidth: 0, gap: spacing.xs },
  entryTitleLine: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  entryName: { flex: 1, color: colors.text, fontSize: 15, fontWeight: "700" },
  entryContent: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
  modalBackdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: colors.overlay },
  modalBody: { maxHeight: "88%", padding: spacing.lg, borderTopLeftRadius: radius.md, borderTopRightRadius: radius.md, backgroundColor: colors.background },
  modalHeader: { minHeight: 52, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  modalTitle: { color: colors.text, fontSize: 20, fontWeight: "700" },
  form: { gap: spacing.lg, paddingVertical: spacing.sm },
  entryInput: { minHeight: 190 },
  switchRow: { minHeight: 50, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  switchLabel: { color: colors.text, fontSize: 15, fontWeight: "600" },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", gap: spacing.sm },
});
