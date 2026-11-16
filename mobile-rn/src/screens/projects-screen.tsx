import type { BottomTabNavigationProp } from "@react-navigation/bottom-tabs";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import { useCallback, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";

import { Button, EmptyState, ErrorNotice, Field, Header, Screen } from "@/components/ui";
import { createProject, deleteProject, listProjects, renameProject } from "@/data/repositories";
import { exportBackup } from "@/lib/backup";
import { importBookFile } from "@/lib/book-import";
import type { RootStackParamList, RootTabParamList } from "@/navigation/types";
import { useAppStore } from "@/store/app-store";
import { colors, radius, spacing } from "@/theme";
import { themedStyles } from "@/themed-styles";
import type { Project } from "@/types";

export function ProjectsScreen() {
  const navigation = useNavigation<BottomTabNavigationProp<RootTabParamList>>();
  const rootNavigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [renameTarget, setRenameTarget] = useState<Project | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [importing, setImporting] = useState(false);
  const setCurrentProject = useAppStore((state) => state.setCurrentProject);
  const currentProjectId = useAppStore((state) => state.currentProjectId);
  const loadProjects = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setProjects(await listProjects());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => {
    void loadProjects();
  }, [loadProjects]));

  const openProject = (project: Project) => {
    setCurrentProject(project.id);
    navigation.navigate("Writing");
  };

  const submit = async () => {
    if (!title.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const project = await createProject(title, description);
      setTitle("");
      setDescription("");
      setShowCreate(false);
      setProjects((current) => [project, ...current.filter((item) => item.id !== project.id)]);
      openProject(project);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setSaving(false);
    }
  };

  const importBook = async () => {
    if (importing) return;
    setImporting(true);
    setError(null);
    try {
      const imported = await importBookFile();
      if (!imported) return;
      setProjects(await listProjects());
      Alert.alert(
        "导入完成",
        `《${imported.project.title}》已导入：${imported.volumeCount} 卷、${imported.chapterCount} 章。`
          + (imported.splitByLength ? "\n\n没有识别到“第X章”这样的标题，正文是按长度切分的。" : ""),
        [
          { text: "留在书架", style: "cancel" },
          { text: "打开作品", onPress: () => openProject(imported.project) },
        ],
      );
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : String(importError));
    } finally {
      setImporting(false);
    }
  };

  const showProjectActions = (project: Project) => {
    Alert.alert(project.title, undefined, [
      {
        text: "重命名",
        onPress: () => {
          setRenameTitle(project.title);
          setRenameTarget(project);
        },
      },
      { text: "删除作品", style: "destructive", onPress: () => confirmDelete(project) },
      { text: "取消", style: "cancel" },
    ]);
  };

  const submitRename = async () => {
    if (!renameTarget || !renameTitle.trim()) return;
    setRenaming(true);
    setError(null);
    try {
      const updated = await renameProject(renameTarget.id, renameTitle);
      setProjects((current) => current.map((item) => item.id === updated.id ? updated : item));
      setRenameTarget(null);
    } catch (renameError) {
      setError(renameError instanceof Error ? renameError.message : String(renameError));
    } finally {
      setRenaming(false);
    }
  };

  const confirmDelete = (project: Project) => {
    Alert.alert("删除作品", `确定删除《${project.title}》及全部本地数据？此操作不可恢复。`, [
      { text: "取消", style: "cancel" },
      {
        text: "先备份再删除",
        onPress: () => {
          void exportBackup().catch((backupError) => setError(backupError instanceof Error ? backupError.message : String(backupError)));
        },
      },
      {
        text: "直接删除",
        style: "destructive",
        onPress: () => {
          void deleteProject(project.id)
            .then(() => {
              setProjects((current) => current.filter((item) => item.id !== project.id));
              if (currentProjectId === project.id) setCurrentProject(null);
            })
            .catch((deleteError) => setError(deleteError instanceof Error ? deleteError.message : String(deleteError)));
        },
      },
    ]);
  };

  return (
    <Screen>
      <Header
        title="OpenFicM"
        action={
          <View style={styles.headerActions}>
            <Pressable accessibilityLabel="导入书籍" disabled={importing} onPress={() => void importBook()} style={styles.iconButton}>
              {importing
                ? <ActivityIndicator size="small" color={colors.primary} />
                : <Ionicons name="folder-open-outline" size={23} color={colors.primary} />}
            </Pressable>
            <Pressable accessibilityLabel="新建作品" onPress={() => setShowCreate(true)} style={styles.iconButton}>
              <Ionicons name="add" size={26} color={colors.primary} />
            </Pressable>
          </View>
        }
      />
      <FlatList
        data={projects}
        keyExtractor={(item) => item.id}
        contentContainerStyle={projects.length ? styles.list : styles.emptyList}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        ListHeaderComponent={
          <View>
            <View style={styles.quickActions}>
              <Pressable
                disabled={!currentProjectId}
                onPress={() => rootNavigation.navigate("Characters")}
                style={[styles.quickAction, !currentProjectId && styles.quickActionDisabled]}
              >
                <Ionicons name="people-outline" size={22} color={currentProjectId ? colors.primary : colors.textMuted} />
                <Text style={styles.quickActionText}>角色</Text>
              </Pressable>
              <Pressable
                disabled={!currentProjectId}
                onPress={() => rootNavigation.navigate("WorldInfo")}
                style={[styles.quickAction, !currentProjectId && styles.quickActionDisabled]}
              >
                <Ionicons name="globe-outline" size={22} color={currentProjectId ? colors.primary : colors.textMuted} />
                <Text style={styles.quickActionText}>世界书</Text>
              </Pressable>
              <Pressable
                disabled={!currentProjectId}
                onPress={() => rootNavigation.navigate("Notes")}
                style={[styles.quickAction, !currentProjectId && styles.quickActionDisabled]}
              >
                <Ionicons name="reader-outline" size={22} color={currentProjectId ? colors.primary : colors.textMuted} />
                <Text style={styles.quickActionText}>笔记</Text>
              </Pressable>
              <Pressable
                onPress={() => rootNavigation.navigate("StyleLibrary")}
                style={styles.quickAction}
              >
                <Ionicons name="color-wand-outline" size={22} color={colors.primary} />
                <Text style={styles.quickActionText}>文风库</Text>
              </Pressable>
            </View>
            {error ? <View style={styles.errorWrap}><ErrorNotice message={error} onRetry={() => void loadProjects()} /></View> : null}
          </View>
        }
        ListEmptyComponent={loading ? <ActivityIndicator color={colors.primary} /> : <EmptyState title="还没有作品" action={<Button label="新建作品" onPress={() => setShowCreate(true)} />} />}
        renderItem={({ item }) => (
          <Pressable onPress={() => openProject(item)} onLongPress={() => showProjectActions(item)} style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
            <View style={styles.cover}><Text style={styles.coverText}>{item.title.slice(0, 1)}</Text></View>
            <View style={styles.rowText}>
              <Text style={styles.title} numberOfLines={1}>{item.title}</Text>
              <Text style={styles.description} numberOfLines={2}>{item.description || "暂无简介"}</Text>
            </View>
            <Pressable accessibilityLabel="作品操作" onPress={(event) => { event.stopPropagation(); showProjectActions(item); }} hitSlop={8} style={styles.rowAction}>
              <Ionicons name="ellipsis-horizontal" size={20} color={colors.textMuted} />
            </Pressable>
          </Pressable>
        )}
      />

      <Modal visible={showCreate} transparent animationType="fade" onRequestClose={() => setShowCreate(false)}>
        <KeyboardAvoidingView style={styles.modalBackdrop} behavior="height" automaticOffset>
          <View style={styles.modalBody}>
            <Text style={styles.modalTitle}>新建作品</Text>
            <Field label="书名" value={title} onChangeText={setTitle} autoFocus />
            <Field label="简介" value={description} onChangeText={setDescription} multiline />
            <View style={styles.modalActions}>
              <Button label="取消" variant="secondary" onPress={() => setShowCreate(false)} />
              <Button label="创建" onPress={() => void submit()} disabled={!title.trim()} loading={saving} />
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal visible={renameTarget !== null} transparent animationType="fade" onRequestClose={() => setRenameTarget(null)}>
        <KeyboardAvoidingView style={styles.modalBackdrop} behavior="height" automaticOffset>
          <View style={styles.modalBody}>
            <Text style={styles.modalTitle}>重命名作品</Text>
            <Field label="书名" value={renameTitle} onChangeText={setRenameTitle} autoFocus />
            <View style={styles.modalActions}>
              <Button label="取消" variant="secondary" onPress={() => setRenameTarget(null)} />
              <Button label="保存" onPress={() => void submitRename()} disabled={!renameTitle.trim()} loading={renaming} />
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </Screen>
  );
}

const styles = themedStyles((colors) => StyleSheet.create({
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  headerActions: { flexDirection: "row", alignItems: "center" },
  quickActions: { flexDirection: "row", gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  quickAction: { flex: 1, minHeight: 54, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.sm, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.surface },
  quickActionDisabled: { opacity: 0.48 },
  quickActionText: { color: colors.text, fontSize: 15, fontWeight: "700" },
  errorWrap: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
  list: { paddingVertical: spacing.sm },
  emptyList: { flexGrow: 1 },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginLeft: 88 },
  row: { minHeight: 92, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  rowPressed: { backgroundColor: colors.surfaceMuted },
  cover: { width: 56, height: 68, borderRadius: radius.sm, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" },
  coverText: { color: colors.onPrimary, fontSize: 24, fontWeight: "700" },
  rowText: { flex: 1, gap: spacing.xs },
  rowAction: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  title: { color: colors.text, fontSize: 17, fontWeight: "700" },
  description: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
  modalBackdrop: { flex: 1, justifyContent: "center", padding: spacing.lg, backgroundColor: colors.overlay },
  modalBody: { gap: spacing.lg, padding: spacing.xl, borderRadius: radius.md, backgroundColor: colors.background },
  modalTitle: { color: colors.text, fontSize: 20, fontWeight: "700" },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", gap: spacing.sm },
}));
