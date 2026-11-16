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
import { deleteRelationship, listRelationships, saveRelationship } from "@/data/workspace-repositories";
import { exportCharacters, type LibraryExportFormat } from "@/lib/export";
import type { RootStackParamList } from "@/navigation/types";
import { useAppStore } from "@/store/app-store";
import { colors, radius, spacing } from "@/theme";
import { themedStyles } from "@/themed-styles";
import type { Character, CharacterRelationship, Project } from "@/types";

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
  const [relationships, setRelationships] = useState<CharacterRelationship[]>([]);
  const [allCharacters, setAllCharacters] = useState<Character[]>([]);
  const [relationTargetId, setRelationTargetId] = useState("");
  const [relationName, setRelationName] = useState("");
  const [relationDescription, setRelationDescription] = useState("");
  const [savingRelation, setSavingRelation] = useState(false);

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
      const [nextProject, nextCharacters, everyCharacter, nextRelationships] = await Promise.all([
        getProject(projectId),
        listCharacters(projectId, query),
        listCharacters(projectId),
        listRelationships(projectId),
      ]);
      if (!nextProject) throw new Error("作品不存在");
      setProject(nextProject);
      setCharacters(nextCharacters);
      setAllCharacters(everyCharacter);
      setRelationships(nextRelationships);
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
    setRelationTargetId("");
    setRelationName("");
    setRelationDescription("");
    setEditorVisible(true);
  };

  const editingRelationships = editing
    ? relationships
      .filter((relation) => relation.sourceCharacterId === editing.id || relation.targetCharacterId === editing.id)
      .map((relation) => ({
        relation,
        other: allCharacters.find((character) => character.id
          === (relation.sourceCharacterId === editing.id ? relation.targetCharacterId : relation.sourceCharacterId)),
      }))
      .filter((item) => item.other)
    : [];

  const submitRelationship = async () => {
    if (!projectId || !editing || !relationTargetId || !relationName.trim()) return;
    setSavingRelation(true);
    setError(null);
    try {
      await saveRelationship({
        projectId,
        firstCharacterId: editing.id,
        secondCharacterId: relationTargetId,
        name: relationName,
        description: relationDescription,
      });
      setRelationships(await listRelationships(projectId));
      setRelationTargetId("");
      setRelationName("");
      setRelationDescription("");
    } catch (relationError) {
      setError(relationError instanceof Error ? relationError.message : String(relationError));
    } finally {
      setSavingRelation(false);
    }
  };

  const removeRelationship = (relation: CharacterRelationship, otherName: string) => {
    Alert.alert("删除关系", `删除与“${otherName}”的关系“${relation.name}”？`, [
      { text: "取消", style: "cancel" },
      {
        text: "删除",
        style: "destructive",
        onPress: () => {
          void deleteRelationship(relation.id)
            .then(() => setRelationships((current) => current.filter((item) => item.id !== relation.id)))
            .catch((deleteError) => setError(deleteError instanceof Error ? deleteError.message : String(deleteError)));
        },
      },
    ]);
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
      setAllCharacters(await listCharacters(projectId));
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
            .then(() => {
              setCharacters((current) => current.filter((item) => item.id !== character.id));
              setAllCharacters((current) => current.filter((item) => item.id !== character.id));
              setRelationships((current) => current.filter((item) => item.sourceCharacterId !== character.id && item.targetCharacterId !== character.id));
            })
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
              {relationships.some((relation) => relation.sourceCharacterId === item.id || relation.targetCharacterId === item.id) ? (
                <Text numberOfLines={1} style={styles.relationSummary}>
                  关系：{relationships
                    .filter((relation) => relation.sourceCharacterId === item.id || relation.targetCharacterId === item.id)
                    .map((relation) => {
                      const otherId = relation.sourceCharacterId === item.id ? relation.targetCharacterId : relation.sourceCharacterId;
                      return `${allCharacters.find((character) => character.id === otherId)?.name ?? "?"}（${relation.name}）`;
                    })
                    .join("、")}
                </Text>
              ) : null}
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
              style={styles.formScroll}
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
              {editing ? (
                <View style={styles.relationSection}>
                  <Text style={styles.relationTitle}>角色关系</Text>
                  {editingRelationships.length ? editingRelationships.map(({ relation, other }) => (
                    <View key={relation.id} style={styles.relationRow}>
                      <Pressable
                        style={styles.relationCopy}
                        onPress={() => {
                          setRelationTargetId(other?.id ?? "");
                          setRelationName(relation.name);
                          setRelationDescription(relation.description);
                        }}
                      >
                        <Text style={styles.relationName} numberOfLines={1}>{other?.name} · {relation.name}</Text>
                        {relation.description ? <Text style={styles.relationDescription} numberOfLines={2}>{relation.description}</Text> : null}
                      </Pressable>
                      <Pressable accessibilityLabel="删除关系" onPress={() => removeRelationship(relation, other?.name ?? "")} style={styles.iconButton}>
                        <Ionicons name="trash-outline" size={18} color={colors.textMuted} />
                      </Pressable>
                    </View>
                  )) : <Text style={styles.relationHint}>还没有关系。两个角色之间只保留一条关系，点已有关系可以修改。</Text>}
                  {allCharacters.length > 1 ? (
                    <>
                      <View style={styles.relationChoices}>
                        {allCharacters.filter((character) => character.id !== editing.id).map((character) => (
                          <Pressable
                            key={character.id}
                            onPress={() => setRelationTargetId(character.id)}
                            style={[styles.relationChoice, relationTargetId === character.id && styles.relationChoiceActive]}
                          >
                            <Text style={[styles.relationChoiceText, relationTargetId === character.id && styles.relationChoiceTextActive]} numberOfLines={1}>{character.name}</Text>
                          </Pressable>
                        ))}
                      </View>
                      <Field label="关系名称" value={relationName} onChangeText={setRelationName} placeholder="师徒、宿敌、青梅竹马…" maxLength={200} />
                      <Field label="关系说明（可不填）" value={relationDescription} onChangeText={setRelationDescription} multiline />
                      <Button
                        label="保存关系"
                        variant="secondary"
                        onPress={() => void submitRelationship()}
                        disabled={!relationTargetId || !relationName.trim()}
                        loading={savingRelation}
                      />
                    </>
                  ) : <Text style={styles.relationHint}>再添加一个角色后就能建立关系。</Text>}
                </View>
              ) : null}
            </KeyboardAwareScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </Screen>
  );
}

const styles = themedStyles((colors) => StyleSheet.create({
  headerActions: { flexDirection: "row", alignItems: "center" },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  searchWrap: { padding: spacing.lg, paddingBottom: spacing.sm },
  errorWrap: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
  list: { paddingVertical: spacing.sm },
  emptyList: { flexGrow: 1 },
  row: { minHeight: 98, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  rowPressed: { backgroundColor: colors.surfaceMuted },
  avatar: { width: 52, height: 52, borderRadius: 26, alignItems: "center", justifyContent: "center", backgroundColor: colors.primary },
  avatarText: { color: colors.onPrimary, fontSize: 22, fontWeight: "700" },
  rowText: { flex: 1, minWidth: 0, gap: spacing.xs },
  rowActions: { flexDirection: "row", alignItems: "center" },
  nameLine: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  name: { flex: 1, color: colors.text, fontSize: 16, fontWeight: "700" },
  description: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
  modalBackdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: colors.overlay },
  modalBody: { maxHeight: "88%", padding: spacing.lg, borderTopLeftRadius: radius.md, borderTopRightRadius: radius.md, backgroundColor: colors.background },
  modalHeader: { minHeight: 52, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  modalTitle: { color: colors.text, fontSize: 20, fontWeight: "700" },
  // 父层只有 maxHeight，ScrollView 默认不收缩会把超出部分顶出可视区且滚不动，必须允许它收缩。
  formScroll: { flexShrink: 1 },
  form: { gap: spacing.lg, paddingVertical: spacing.sm },
  descriptionInput: { minHeight: 180 },
  switchRow: { minHeight: 50, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  switchLabel: { color: colors.text, fontSize: 15, fontWeight: "600" },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", gap: spacing.sm },
  relationSummary: { color: colors.primary, fontSize: 12 },
  relationSection: { gap: spacing.md, paddingTop: spacing.lg, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  relationTitle: { color: colors.text, fontSize: 16, fontWeight: "700" },
  relationHint: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
  relationRow: { minHeight: 50, flexDirection: "row", alignItems: "center", paddingLeft: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm },
  relationCopy: { flex: 1, minWidth: 0, paddingVertical: spacing.sm },
  relationName: { color: colors.text, fontSize: 14, fontWeight: "600" },
  relationDescription: { marginTop: 2, color: colors.textMuted, fontSize: 12, lineHeight: 17 },
  relationChoices: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  relationChoice: { maxWidth: "100%", paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md },
  relationChoiceActive: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  relationChoiceText: { color: colors.textMuted, fontSize: 13 },
  relationChoiceTextActive: { color: colors.primary, fontWeight: "700" },
}));
