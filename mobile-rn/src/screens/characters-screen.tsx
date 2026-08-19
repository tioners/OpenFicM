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
import { deleteCharacter, getProject, listCharacters, saveCharacter } from "@/data/repositories";
import { exportCharacters, type LibraryExportFormat } from "@/lib/export";
import type { RootStackParamList } from "@/navigation/types";
import { useAppStore } from "@/store/app-store";
import { colors, radius, spacing } from "@/theme";
import type { Character, Project } from "@/types";

export function CharactersScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const projectId = useAppStore((state) => state.currentProjectId);
  const [project, setProject] = useState<Project | null>(null);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editorVisible, setEditorVisible] = useState(false);
  const [editing, setEditing] = useState<Character | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isFavorited, setIsFavorited] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) {
      setProject(null);
      setCharacters([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [nextProject, nextCharacters] = await Promise.all([getProject(projectId), listCharacters(projectId, query)]);
      if (!nextProject) throw new Error("作品不存在");
      setProject(nextProject);
      setCharacters(nextCharacters);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [projectId, query]);

  useFocusEffect(useCallback(() => {
    void load();
  }, [load]));

  const openEditor = (character?: Character) => {
    setEditing(character ?? null);
    setName(character?.name ?? "");
    setDescription(character?.description ?? "");
    setIsFavorited(character?.isFavorited ?? false);
    setEditorVisible(true);
  };

  const submit = async () => {
    if (!projectId || !name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await saveCharacter({
        id: editing?.id,
        projectId,
        name,
        description,
        isFavorited,
      });
      setCharacters((current) => {
        const withoutSaved = current.filter((item) => item.id !== saved.id);
        return [saved, ...withoutSaved];
      });
      setEditorVisible(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };

  const remove = (character: Character) => {
    Alert.alert("删除角色", `确定删除“${character.name}”吗？`, [
      { text: "取消", style: "cancel" },
      {
        text: "删除",
        style: "destructive",
        onPress: () => {
          void deleteCharacter(character.id)
            .then(() => setCharacters((current) => current.filter((item) => item.id !== character.id)))
            .catch((deleteError) => setError(deleteError instanceof Error ? deleteError.message : String(deleteError)));
        },
      },
    ]);
  };

  const runExport = async (items: Character[], format: LibraryExportFormat): Promise<void> => {
    if (!project || exporting) return;
    setExporting(true);
    setError(null);
    try {
      await exportCharacters(project, items, format);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : String(exportError));
    } finally {
      setExporting(false);
    }
  };

  const chooseExport = (items: Character[], title: string) => {
    Alert.alert(title, "选择导出格式", [
      { text: "取消", style: "cancel" },
      { text: "JSON", onPress: () => void runExport(items, "json") },
      { text: "Markdown", onPress: () => void runExport(items, "markdown") },
    ]);
  };

  const exportAll = async (format: LibraryExportFormat): Promise<void> => {
    if (!projectId) return;
    setError(null);
    try {
      await runExport(await listCharacters(projectId), format);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : String(exportError));
    }
  };

  const chooseBulkExport = () => {
    if (!projectId || !project || exporting) return;
    Alert.alert("导出全部角色", "选择导出格式", [
      { text: "取消", style: "cancel" },
      { text: "JSON", onPress: () => void exportAll("json") },
      { text: "Markdown", onPress: () => void exportAll("markdown") },
    ]);
  };

  if (!projectId) return <Screen><Header title="角色" onBack={() => navigation.goBack()} /><EmptyState title="请先从书架打开一部作品" /></Screen>;

  return (
    <Screen>
      <Header
        title="角色"
        onBack={() => navigation.goBack()}
        action={(
          <View style={styles.headerActions}>
            <Pressable accessibilityLabel="批量导出角色" disabled={exporting} onPress={chooseBulkExport} style={styles.iconButton}>
              {exporting ? <ActivityIndicator size="small" color={colors.primary} /> : <Ionicons name="download-outline" size={22} color={colors.primary} />}
            </Pressable>
            <Pressable accessibilityLabel="新建角色" onPress={() => openEditor()} style={styles.iconButton}><Ionicons name="add" size={26} color={colors.primary} /></Pressable>
          </View>
        )}
      />
      <View style={styles.searchWrap}>
        <Field label="搜索角色" value={query} onChangeText={setQuery} placeholder="按名称或设定搜索" returnKeyType="search" />
      </View>
      {error ? <View style={styles.errorWrap}><ErrorNotice message={error} onRetry={() => void load()} /></View> : null}
      <FlatList
        data={characters}
        keyExtractor={(item) => item.id}
        contentContainerStyle={characters.length ? styles.list : styles.emptyList}
        ListEmptyComponent={loading ? <ActivityIndicator color={colors.primary} /> : <EmptyState title="还没有角色" action={<Button label="新建角色" onPress={() => openEditor()} />} />}
        renderItem={({ item }) => (
          <Pressable onPress={() => openEditor(item)} style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
            <View style={styles.avatar}><Text style={styles.avatarText}>{item.name.slice(0, 1)}</Text></View>
            <View style={styles.rowText}>
              <View style={styles.nameLine}>
                <Text numberOfLines={1} style={styles.name}>{item.name}</Text>
                {item.isFavorited ? <Ionicons name="star" size={16} color={colors.accent} /> : null}
              </View>
              <Text numberOfLines={3} style={styles.description}>{item.description || "暂无角色设定"}</Text>
            </View>
            <View style={styles.rowActions}>
              <Pressable accessibilityLabel={`导出角色 ${item.name}`} disabled={exporting} onPress={(event) => { event.stopPropagation(); chooseExport([item], `导出角色“${item.name}”`); }} hitSlop={8} style={styles.iconButton}>
                <Ionicons name="download-outline" size={19} color={colors.textMuted} />
              </Pressable>
              <Pressable accessibilityLabel="删除角色" onPress={(event) => { event.stopPropagation(); remove(item); }} hitSlop={8} style={styles.iconButton}>
                <Ionicons name="trash-outline" size={19} color={colors.textMuted} />
              </Pressable>
            </View>
          </Pressable>
        )}
      />

      <Modal visible={editorVisible} transparent animationType="slide" onRequestClose={() => setEditorVisible(false)}>
        <KeyboardAvoidingView style={styles.modalBackdrop} behavior="height" automaticOffset>
          <View style={styles.modalBody}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{editing ? "编辑角色" : "新建角色"}</Text>
              <Pressable accessibilityLabel="关闭角色编辑" onPress={() => setEditorVisible(false)} style={styles.iconButton}>
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
              <Field label="角色名称" value={name} onChangeText={setName} autoFocus={!editing} />
              <Field label="角色设定" value={description} onChangeText={setDescription} multiline textAlignVertical="top" style={styles.descriptionInput} placeholder="外貌、性格、经历、关系和写作注意事项" />
              <View style={styles.switchRow}>
                <Text style={styles.switchLabel}>收藏角色</Text>
                <Switch value={isFavorited} onValueChange={setIsFavorited} trackColor={{ false: colors.border, true: colors.primary }} />
              </View>
              <View style={styles.modalActions}>
                <Button label="取消" variant="secondary" onPress={() => setEditorVisible(false)} />
                <Button label="保存" onPress={() => void submit()} disabled={!name.trim()} loading={saving} />
              </View>
            </KeyboardAwareScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  headerActions: { flexDirection: "row", alignItems: "center" },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  searchWrap: { padding: spacing.lg, paddingBottom: spacing.sm },
  errorWrap: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
  list: { paddingVertical: spacing.sm },
  emptyList: { flexGrow: 1 },
  row: { minHeight: 98, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  rowPressed: { backgroundColor: colors.surfaceMuted },
  avatar: { width: 52, height: 52, borderRadius: 26, alignItems: "center", justifyContent: "center", backgroundColor: colors.primary },
  avatarText: { color: "#FFFFFF", fontSize: 22, fontWeight: "700" },
  rowText: { flex: 1, minWidth: 0, gap: spacing.xs },
  rowActions: { flexDirection: "row", alignItems: "center" },
  nameLine: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  name: { flex: 1, color: colors.text, fontSize: 16, fontWeight: "700" },
  description: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
  modalBackdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: colors.overlay },
  modalBody: { maxHeight: "88%", padding: spacing.lg, borderTopLeftRadius: radius.md, borderTopRightRadius: radius.md, backgroundColor: colors.background },
  modalHeader: { minHeight: 52, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  modalTitle: { color: colors.text, fontSize: 20, fontWeight: "700" },
  form: { gap: spacing.lg, paddingVertical: spacing.sm },
  descriptionInput: { minHeight: 180 },
  switchRow: { minHeight: 50, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  switchLabel: { color: colors.text, fontSize: 15, fontWeight: "600" },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", gap: spacing.sm },
});
