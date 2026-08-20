import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { Button, EmptyState, ErrorNotice, Field, Header, Screen } from "@/components/ui";
import {
  createStyleProfileVersion,
  deleteStyleProfile,
  getActiveStyleProfile,
  listStyleProfiles,
  listStyleProfilesForSource,
  listStyleSources,
  renameStyleSource,
  setActiveStyleProfile,
} from "@/data/style-repositories";
import { resolveModelSelection } from "@/llm/selection";
import type { RootStackParamList } from "@/navigation/types";
import { distillReferenceStyle } from "@/settings/lorn-style-plugin";
import { importStyleSource, deleteStyleSource } from "@/style/source-library";
import { useAppStore } from "@/store/app-store";
import { colors, radius, spacing } from "@/theme";
import type { StyleProfile, StyleSource } from "@/types";

function formatBytes(value: number): string {
  if (value < 1024) return String(value) + " B";
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " KB";
  return (value / (1024 * 1024)).toFixed(1) + " MB";
}

function formatName(source: StyleSource): string {
  return source.format === "epub" ? "EPUB" : source.format === "markdown" ? "Markdown" : "TXT";
}

export function StyleLibraryScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const projectId = useAppStore((state) => state.currentProjectId);
  const [sources, setSources] = useState<StyleSource[]>([]);
  const [profiles, setProfiles] = useState<StyleProfile[]>([]);
  const [activeProfile, setActiveProfile] = useState<StyleProfile | null>(null);
  const [selectedSource, setSelectedSource] = useState<StyleSource | null>(null);
  const [sourceProfiles, setSourceProfiles] = useState<StyleProfile[]>([]);
  const [selectedProfile, setSelectedProfile] = useState<StyleProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sourceTitle, setSourceTitle] = useState("");
  const [editingSource, setEditingSource] = useState(false);
  const [editingAuthorGuide, setEditingAuthorGuide] = useState(false);
  const [authorGuide, setAuthorGuide] = useState("");

  const authorProfiles = useMemo(
    () => profiles.filter((profile) => profile.kind === "author"),
    [profiles],
  );
  const referenceProfiles = useMemo(
    () => profiles.filter((profile) => profile.kind === "reference"),
    [profiles],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const nextSources = await listStyleSources();
      const nextProfiles = await listStyleProfiles(projectId ?? "");
      const nextActive = projectId ? await getActiveStyleProfile(projectId) : null;
      setSources(nextSources);
      setProfiles(nextProfiles);
      setActiveProfile(nextActive);
      if (nextActive?.kind === "author") setAuthorGuide(nextActive.guide);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useFocusEffect(useCallback(() => {
    void load();
  }, [load]));

  const openSource = async (source: StyleSource) => {
    setSelectedSource(source);
    setEditingSource(false);
    setSourceTitle(source.title);
    setError(null);
    try {
      setSourceProfiles(await listStyleProfilesForSource(source.id));
    } catch (sourceError) {
      setError(sourceError instanceof Error ? sourceError.message : String(sourceError));
      setSourceProfiles([]);
    }
  };

  const closeSource = () => {
    if (busy) return;
    setSelectedSource(null);
    setSourceProfiles([]);
    setEditingSource(false);
  };

  const importBook = async () => {
    setBusy(true);
    setError(null);
    try {
      const source = await importStyleSource();
      if (source) {
        await load();
        await openSource(source);
      }
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : String(importError));
    } finally {
      setBusy(false);
    }
  };

  const openProfile = (profile: StyleProfile) => {
    setSelectedSource(null);
    setSourceProfiles([]);
    setSelectedProfile(profile);
    setEditingAuthorGuide(false);
    if (profile.kind === "author") setAuthorGuide(profile.guide);
  };

  const distill = async () => {
    if (!selectedSource) return;
    setBusy(true);
    setError(null);
    try {
      const selection = await resolveModelSelection();
      const profile = await distillReferenceStyle({ sourceId: selectedSource.id, selection });
      setSourceProfiles((current) => [profile, ...current.filter((item) => item.id !== profile.id)]);
      setProfiles((current) => [profile, ...current.filter((item) => item.id !== profile.id)]);
      openProfile(profile);
    } catch (distillError) {
      setError(distillError instanceof Error ? distillError.message : String(distillError));
    } finally {
      setBusy(false);
    }
  };

  const activate = async (profile: StyleProfile | null) => {
    if (!projectId) {
      setError("请先从书架打开一部作品，再选择创作文风");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await setActiveStyleProfile(projectId, profile?.id ?? null);
      setActiveProfile(profile);
      if (profile) setSelectedProfile(profile);
    } catch (activateError) {
      setError(activateError instanceof Error ? activateError.message : String(activateError));
    } finally {
      setBusy(false);
    }
  };

  const saveSourceTitle = async () => {
    if (!selectedSource || !sourceTitle.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await renameStyleSource(selectedSource.id, sourceTitle);
      setSources((current) => current.map((source) => source.id === updated.id ? updated : source));
      setSelectedSource(updated);
      setEditingSource(false);
    } catch (renameError) {
      setError(renameError instanceof Error ? renameError.message : String(renameError));
    } finally {
      setBusy(false);
    }
  };

  const confirmDeleteSource = () => {
    if (!selectedSource) return;
    Alert.alert(
      "删除参考书",
      "确定删除《" + selectedSource.title + "》及其全部参考文风版本？原文件只保存在本机。",
      [
        { text: "取消", style: "cancel" },
        {
          text: "删除",
          style: "destructive",
          onPress: () => {
            setBusy(true);
            void deleteStyleSource(selectedSource.id)
              .then(async () => {
                setSelectedSource(null);
                setSourceProfiles([]);
                await load();
              })
              .catch((deleteError) => setError(deleteError instanceof Error ? deleteError.message : String(deleteError)))
              .finally(() => setBusy(false));
          },
        },
      ],
    );
  };

  const saveAuthor = async () => {
    if (!projectId || !authorGuide.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const profile = await createStyleProfileVersion({
        projectId,
        kind: "author",
        name: "我的作者文风",
        guide: authorGuide,
        activateForProjectId: projectId,
      });
      setProfiles((current) => [profile, ...current.filter((item) => item.id !== profile.id)]);
      setActiveProfile(profile);
      setSelectedProfile(profile);
      setEditingAuthorGuide(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setBusy(false);
    }
  };

  const removeProfile = (profile: StyleProfile) => {
    Alert.alert("删除文风版本", "确定删除“" + profile.name + " V" + profile.version + "”？", [
      { text: "取消", style: "cancel" },
      {
        text: "删除",
        style: "destructive",
        onPress: () => {
          setBusy(true);
          void deleteStyleProfile(profile.id)
            .then(async () => {
              if (activeProfile?.id === profile.id) setActiveProfile(null);
              setSelectedProfile(null);
              await load();
            })
            .catch((deleteError) => setError(deleteError instanceof Error ? deleteError.message : String(deleteError)))
            .finally(() => setBusy(false));
        },
      },
    ]);
  };

  if (loading) {
    return <Screen><Header title="文风书库" onBack={() => navigation.goBack()} /><View style={styles.loading}><ActivityIndicator color={colors.primary} /></View></Screen>;
  }

  return (
    <Screen>
      <Header
        title="文风书库"
        onBack={() => navigation.goBack()}
        action={(
          <Pressable accessibilityLabel="导入参考小说" disabled={busy} onPress={() => void importBook()} style={styles.iconButton}>
            {busy ? <ActivityIndicator size="small" color={colors.primary} /> : <Ionicons name="add" size={26} color={colors.primary} />}
          </Pressable>
        )}
      />
      {error ? <View style={styles.errorWrap}><ErrorNotice message={error} onRetry={() => void load()} /></View> : null}
      <FlatList
        data={sources}
        keyExtractor={(item) => item.id}
        contentContainerStyle={sources.length ? styles.list : styles.emptyList}
        ListHeaderComponent={(
          <View style={styles.headerContent}>
            <View style={styles.intro}>
              <View style={styles.introIcon}><Ionicons name="color-wand-outline" size={24} color={colors.primary} /></View>
              <View style={styles.introCopy}>
                <Text style={styles.introTitle}>参考文风与作者文风</Text>
                <Text style={styles.introText}>导入本机小说后，使用当前默认模型提取独立文风 Skill。原书不会自动上传，只有蒸馏时发送抽样文本。</Text>
              </View>
            </View>
            {projectId ? (
              <View style={styles.activeStrip}>
                <Ionicons name="checkmark-circle-outline" size={19} color={colors.primary} />
                <Text style={styles.activeStripText} numberOfLines={2}>
                  当前使用：{activeProfile ? activeProfile.name + " V" + activeProfile.version : "不使用文风"}
                </Text>
                {activeProfile ? <Pressable onPress={() => void activate(null)} disabled={busy} style={styles.clearActive}><Text style={styles.clearActiveText}>清除</Text></Pressable> : null}
              </View>
            ) : null}
            {authorProfiles.length ? (
              <View style={styles.sectionHeading}>
                <Text style={styles.sectionTitle}>我的作者文风</Text>
                <Text style={styles.sectionMeta}>{authorProfiles.length} 个版本</Text>
              </View>
            ) : null}
            {authorProfiles.map((profile) => (
              <ProfileRow
                key={profile.id}
                profile={profile}
                active={activeProfile?.id === profile.id}
                onPress={() => openProfile(profile)}
                onActivate={() => void activate(profile)}
                disabled={busy || !projectId}
              />
            ))}
            <View style={styles.sectionHeading}>
              <Text style={styles.sectionTitle}>参考小说</Text>
              <Text style={styles.sectionMeta}>{sources.length} 本</Text>
            </View>
          </View>
        )}
        ListEmptyComponent={(
          <EmptyState
            title="还没有参考小说"
            action={<Button label="导入 TXT / Markdown / EPUB" onPress={() => void importBook()} disabled={busy} loading={busy} />}
          />
        )}
        renderItem={({ item }) => (
          <Pressable onPress={() => void openSource(item)} style={({ pressed }) => [styles.sourceRow, pressed && styles.sourceRowPressed]}>
            <View style={styles.bookIcon}><Ionicons name="book-outline" size={23} color={colors.primary} /></View>
            <View style={styles.sourceCopy}>
              <Text style={styles.sourceTitle} numberOfLines={1}>{item.title}</Text>
              <Text style={styles.sourceMeta} numberOfLines={1}>{formatName(item)} · {formatBytes(item.sizeBytes)} · {item.characterCount.toLocaleString()} 字</Text>
              <Text style={styles.sourceMeta} numberOfLines={1}>{referenceProfiles.some((profile) => profile.sourceId === item.id) ? "已生成参考文风" : "尚未蒸馏文风"}</Text>
            </View>
            <Ionicons name="chevron-forward" size={19} color={colors.textMuted} />
          </Pressable>
        )}
      />

      <Modal visible={Boolean(selectedSource)} transparent animationType="slide" onRequestClose={closeSource}>
        <Pressable style={styles.modalBackdrop} onPress={closeSource}>
          <View style={styles.sheet} onStartShouldSetResponder={() => true}>
            <View style={styles.sheetHeader}>
              <View style={styles.sheetTitleWrap}>
                {editingSource ? (
                  <Field label="参考书名称" value={sourceTitle} onChangeText={setSourceTitle} autoFocus />
                ) : (
                  <>
                    <Text style={styles.sheetTitle} numberOfLines={2}>{selectedSource?.title}</Text>
                    <Text style={styles.sheetMeta}>{selectedSource ? formatName(selectedSource) + " · " + formatBytes(selectedSource.sizeBytes) + " · " + selectedSource.characterCount.toLocaleString() + " 字" : ""}</Text>
                  </>
                )}
              </View>
              <Pressable accessibilityLabel="关闭参考书详情" onPress={closeSource} style={styles.iconButton}>
                <Ionicons name="close" size={24} color={colors.textMuted} />
              </Pressable>
            </View>
            <ScrollView contentContainerStyle={styles.sheetContent} keyboardShouldPersistTaps="handled">
              {editingSource ? (
                <View style={styles.inlineActions}>
                  <Button label="取消" variant="secondary" onPress={() => setEditingSource(false)} />
                  <Button label="保存名称" onPress={() => void saveSourceTitle()} disabled={!sourceTitle.trim()} loading={busy} />
                </View>
              ) : (
                <View style={styles.inlineActions}>
                  <Button label="蒸馏文风" onPress={() => void distill()} disabled={busy} loading={busy} />
                  <Pressable accessibilityLabel="重命名参考书" onPress={() => setEditingSource(true)} style={styles.secondaryIconAction}>
                    <Ionicons name="create-outline" size={21} color={colors.text} />
                  </Pressable>
                  <Pressable accessibilityLabel="删除参考书" onPress={confirmDeleteSource} style={styles.secondaryIconAction}>
                    <Ionicons name="trash-outline" size={21} color={colors.danger} />
                  </Pressable>
                </View>
              )}
              <Text style={styles.helperText}>蒸馏使用当前设置中的默认模型。模型请求失败时可更换供应商后再次蒸馏。</Text>
              <Text style={styles.sectionTitle}>参考文风版本</Text>
              {sourceProfiles.length ? sourceProfiles.map((profile) => (
                <ProfileRow
                  key={profile.id}
                  profile={profile}
                  active={activeProfile?.id === profile.id}
                  onPress={() => openProfile(profile)}
                  onActivate={() => void activate(profile)}
                  disabled={busy || !projectId}
                />
              )) : <Text style={styles.emptyHint}>还没有版本，点击“蒸馏文风”生成。</Text>}
            </ScrollView>
          </View>
        </Pressable>
      </Modal>

      <Modal visible={Boolean(selectedProfile)} transparent animationType="slide" onRequestClose={() => setSelectedProfile(null)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setSelectedProfile(null)}>
          <View style={styles.sheet} onStartShouldSetResponder={() => true}>
            <View style={styles.sheetHeader}>
              <View style={styles.sheetTitleWrap}>
                <Text style={styles.sheetTitle} numberOfLines={2}>{selectedProfile?.name} V{selectedProfile?.version}</Text>
                <Text style={styles.sheetMeta}>{selectedProfile?.kind === "author" ? "作者文风版本" : "参考小说文风版本"}</Text>
              </View>
              <Pressable accessibilityLabel="关闭文风详情" onPress={() => setSelectedProfile(null)} style={styles.iconButton}>
                <Ionicons name="close" size={24} color={colors.textMuted} />
              </Pressable>
            </View>
            <ScrollView contentContainerStyle={styles.profileContent}>
              {selectedProfile?.kind === "author" && editingAuthorGuide ? (
                <Field label="作者文风指南" value={authorGuide} onChangeText={setAuthorGuide} multiline style={styles.guideInput} maxLength={100000} />
              ) : (
                <Text selectable style={styles.guideText}>{selectedProfile?.guide}</Text>
              )}
              <View style={styles.inlineActions}>
                {selectedProfile?.kind === "author" ? (
                  <Button
                    label={editingAuthorGuide ? "保存新版本" : "编辑指南"}
                    onPress={() => {
                      if (editingAuthorGuide) void saveAuthor();
                      else setEditingAuthorGuide(true);
                    }}
                    disabled={busy || (editingAuthorGuide && !authorGuide.trim())}
                    loading={busy}
                  />
                ) : null}
                <Button
                  label={activeProfile?.id === selectedProfile?.id ? "已在使用" : "用于创作"}
                  variant={activeProfile?.id === selectedProfile?.id ? "secondary" : "primary"}
                  onPress={() => void activate(selectedProfile)}
                  disabled={busy || !projectId || activeProfile?.id === selectedProfile?.id}
                />
                <Pressable accessibilityLabel="删除文风版本" onPress={() => selectedProfile && removeProfile(selectedProfile)} style={styles.secondaryIconAction}>
                  <Ionicons name="trash-outline" size={21} color={colors.danger} />
                </Pressable>
              </View>
            </ScrollView>
          </View>
        </Pressable>
      </Modal>
    </Screen>
  );
}

function ProfileRow({
  profile,
  active,
  onPress,
  onActivate,
  disabled,
}: {
  profile: StyleProfile;
  active: boolean;
  onPress: () => void;
  onActivate: () => void;
  disabled: boolean;
}) {
  return (
    <View style={[styles.profileRow, active && styles.profileRowActive]}>
      <Pressable onPress={onPress} style={styles.profileMain}>
        <Ionicons name={active ? "checkmark-circle" : "document-text-outline"} size={20} color={active ? colors.primary : colors.textMuted} />
        <View style={styles.profileCopy}>
          <Text style={styles.profileName} numberOfLines={1}>{profile.name} V{profile.version}</Text>
          <Text style={styles.profileMeta} numberOfLines={2}>{profile.guide.slice(0, 120).replace(/\s+/g, " ")}</Text>
        </View>
      </Pressable>
      <Pressable accessibilityLabel={active ? "当前使用的文风" : "使用这个文风"} onPress={onActivate} disabled={disabled || active} style={styles.useButton}>
        <Text style={[styles.useButtonText, active && styles.useButtonTextActive]}>{active ? "使用中" : "使用"}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: "center", justifyContent: "center" },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  errorWrap: { padding: spacing.lg, paddingBottom: 0 },
  list: { paddingBottom: spacing.xl },
  emptyList: { flexGrow: 1, paddingBottom: spacing.xl },
  headerContent: { padding: spacing.lg, paddingBottom: spacing.sm },
  intro: { flexDirection: "row", gap: spacing.md, paddingBottom: spacing.lg },
  introIcon: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.sm, backgroundColor: "#E6F3EF" },
  introCopy: { flex: 1, gap: spacing.xs },
  introTitle: { color: colors.text, fontSize: 17, fontWeight: "700" },
  introText: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
  activeStrip: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.md, borderWidth: 1, borderColor: colors.primary, borderRadius: radius.sm, backgroundColor: "#E6F3EF" },
  activeStripText: { flex: 1, color: colors.primary, fontSize: 13, fontWeight: "600" },
  clearActive: { minHeight: 44, justifyContent: "center", paddingHorizontal: spacing.sm },
  clearActiveText: { color: colors.primary, fontSize: 13, fontWeight: "700" },
  sectionHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingTop: spacing.xl, paddingBottom: spacing.sm },
  sectionTitle: { color: colors.text, fontSize: 16, fontWeight: "700" },
  sectionMeta: { color: colors.textMuted, fontSize: 12 },
  sourceRow: { minHeight: 84, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  sourceRowPressed: { backgroundColor: colors.surfaceMuted },
  bookIcon: { width: 48, height: 56, alignItems: "center", justifyContent: "center", borderRadius: radius.sm, backgroundColor: "#DCECE6" },
  sourceCopy: { flex: 1, minWidth: 0, gap: 3 },
  sourceTitle: { color: colors.text, fontSize: 16, fontWeight: "700" },
  sourceMeta: { color: colors.textMuted, fontSize: 12 },
  profileRow: { minHeight: 68, flexDirection: "row", alignItems: "center", gap: spacing.sm, marginBottom: spacing.sm, paddingLeft: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, backgroundColor: colors.surface },
  profileRowActive: { borderColor: colors.primary, backgroundColor: "#E6F3EF" },
  profileMain: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: spacing.sm },
  profileCopy: { flex: 1, minWidth: 0, gap: 3 },
  profileName: { color: colors.text, fontSize: 14, fontWeight: "700" },
  profileMeta: { color: colors.textMuted, fontSize: 12, lineHeight: 17 },
  useButton: { minWidth: 54, minHeight: 44, alignItems: "center", justifyContent: "center", marginRight: spacing.xs },
  useButtonText: { color: colors.primary, fontSize: 13, fontWeight: "700" },
  useButtonTextActive: { color: colors.textMuted },
  modalBackdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: colors.overlay },
  sheet: { maxHeight: "88%", borderTopLeftRadius: radius.md, borderTopRightRadius: radius.md, backgroundColor: colors.background },
  sheetHeader: { minHeight: 70, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingLeft: spacing.lg, paddingRight: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  sheetTitleWrap: { flex: 1, minWidth: 0 },
  sheetTitle: { color: colors.text, fontSize: 19, fontWeight: "700" },
  sheetMeta: { marginTop: 3, color: colors.textMuted, fontSize: 12 },
  sheetContent: { padding: spacing.lg, paddingBottom: spacing.xxl },
  profileContent: { gap: spacing.lg, padding: spacing.lg, paddingBottom: spacing.xxl },
  inlineActions: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: spacing.sm },
  secondaryIconAction: { width: 46, height: 46, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, backgroundColor: colors.surface },
  helperText: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
  emptyHint: { color: colors.textMuted, fontSize: 14, lineHeight: 20, paddingVertical: spacing.md },
  guideText: { color: colors.text, fontSize: 14, lineHeight: 22 },
  guideInput: { minHeight: 300 },
});
