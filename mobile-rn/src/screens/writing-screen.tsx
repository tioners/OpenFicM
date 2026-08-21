import { Ionicons } from "@expo/vector-icons";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Modal,
  Pressable,
  ScrollView,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";

import { Button, EmptyState, ErrorNotice, Field, Header, Screen, SheetBackdrop } from "@/components/ui";
import { exportNovel, type ExportScope } from "@/lib/export";
import { countNotesUnder, deleteNotesUnder } from "@/data/note-repositories";
import {
  createChapter,
  createVolume,
  deleteChapter,
  deleteVolume,
  getProject,
  getSetting,
  listChapters,
  listVolumes,
  renameChapter,
  renameVolume,
  saveChapter,
} from "@/data/repositories";
import {
  getPendingChapterStyleEvolution,
  markChapterStyleEvolved,
  recordLatestAuthorRevision,
} from "@/data/chapter-draft-repositories";
import {
  getActiveStyleProfile,
  listStyleProfiles,
  setActiveStyleProfile,
} from "@/data/style-repositories";
import { resolveModelSelection } from "@/llm/selection";
import { evolveAuthorStyle } from "@/settings/lorn-style-plugin";
import { useAppStore } from "@/store/app-store";
import { colors, radius, spacing } from "@/theme";
import type { Chapter, ChapterDraftSnapshot, Project, StyleProfile, Volume } from "@/types";

const AUTO_SAVE_DELAY_MS = 1_000;

type DraftState = {
  chapterId: string;
  title: string;
  content: string;
  dirty: boolean;
  version: number;
};

type DirectoryTarget =
  | { kind: "volume"; volume: Volume }
  | { kind: "chapter"; chapter: Chapter };

type NameDialog =
  | { kind: "create-volume" }
  | { kind: "rename-volume"; volume: Volume }
  | { kind: "create-chapter"; volume: Volume }
  | { kind: "rename-chapter"; chapter: Chapter };

export function WritingScreen() {
  const projectId = useAppStore((state) => state.currentProjectId);
  const currentChapterId = useAppStore((state) => state.currentChapterId);
  const setCurrentChapter = useAppStore((state) => state.setCurrentChapter);
  const refreshData = useAppStore((state) => state.refreshData);
  const revision = useAppStore((state) => state.dataRevision);
  const [project, setProject] = useState<Project | null>(null);
  const [volumes, setVolumes] = useState<Volume[]>([]);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoSaveDelay, setAutoSaveDelay] = useState(AUTO_SAVE_DELAY_MS);
  const [editorFontSize, setEditorFontSize] = useState(17);
  const [chapterPickerVisible, setChapterPickerVisible] = useState(false);
  const [directoryTarget, setDirectoryTarget] = useState<DirectoryTarget | null>(null);
  const [nameDialog, setNameDialog] = useState<NameDialog | null>(null);
  const [nameValue, setNameValue] = useState("");
  const [nameSaving, setNameSaving] = useState(false);
  const [exportPickerVisible, setExportPickerVisible] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [styleProfiles, setStyleProfiles] = useState<StyleProfile[]>([]);
  const [activeStyleProfile, setActiveStyleProfileState] = useState<StyleProfile | null>(null);
  const [stylePickerVisible, setStylePickerVisible] = useState(false);
  const [pendingEvolution, setPendingEvolution] = useState<ChapterDraftSnapshot | null>(null);
  const [evolvingStyle, setEvolvingStyle] = useState(false);
  const draftRef = useRef<DraftState>({ chapterId: "", title: "", content: "", dirty: false, version: 0 });
  const savingRef = useRef(false);
  const persistDraftRef = useRef<(force: boolean) => Promise<boolean>>(async () => true);

  useEffect(() => {
    void Promise.all([
      getSetting("general.autoSaveDelay"),
      getSetting("general.editorFontSize"),
    ]).then(([delayValue, fontValue]) => {
      const delay = Number(delayValue);
      const fontSize = Number(fontValue);
      if (Number.isInteger(delay) && delay >= 250 && delay <= 10_000) setAutoSaveDelay(delay);
      if (Number.isFinite(fontSize) && fontSize >= 14 && fontSize <= 28) setEditorFontSize(fontSize);
    }).catch((settingsError) => {
      setError(settingsError instanceof Error ? settingsError.message : String(settingsError));
    });
  }, []);

  const activeChapter = useMemo(
    () => chapters.find((chapter) => chapter.id === currentChapterId) ?? chapters[0] ?? null,
    [chapters, currentChapterId],
  );

  const activeVolume = useMemo(
    () => volumes.find((volume) => volume.id === activeChapter?.volumeId) ?? null,
    [activeChapter?.volumeId, volumes],
  );

  const directorySections = useMemo(() => {
    const grouped = new Map<string, Chapter[]>();
    for (const chapter of chapters) {
      const items = grouped.get(chapter.volumeId) ?? [];
      items.push(chapter);
      grouped.set(chapter.volumeId, items);
    }
    return volumes.map((volume) => ({ volume, data: grouped.get(volume.id) ?? [] }));
  }, [chapters, volumes]);

  useEffect(() => {
    let cancelled = false;
    if (!projectId) {
      setProject(null);
      setVolumes([]);
      setChapters([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    void Promise.all([
      getProject(projectId),
      listVolumes(projectId),
      listChapters(projectId),
      listStyleProfiles(projectId),
      getActiveStyleProfile(projectId),
    ])
      .then(([nextProject, nextVolumes, nextChapters, nextStyleProfiles, nextActiveStyle]) => {
        if (cancelled) return;
        setProject(nextProject);
        setVolumes(nextVolumes);
        setChapters(nextChapters);
        setStyleProfiles(nextStyleProfiles);
        setActiveStyleProfileState(nextActiveStyle);
        const selectedId = useAppStore.getState().currentChapterId;
        if (!selectedId || !nextChapters.some((chapter) => chapter.id === selectedId)) {
          setCurrentChapter(nextChapters[0]?.id ?? null);
        }
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : String(loadError));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, revision, setCurrentChapter]);

  useEffect(() => {
    if (!activeChapter || (draftRef.current.chapterId === activeChapter.id && draftRef.current.dirty)) return;
    setTitle(activeChapter.title);
    setContent(activeChapter.content);
    setSavedAt(null);
    setDirty(false);
    draftRef.current = {
      chapterId: activeChapter.id,
      title: activeChapter.title,
      content: activeChapter.content,
      dirty: false,
      version: draftRef.current.version + 1,
    };
    void getPendingChapterStyleEvolution(activeChapter.id)
      .then(setPendingEvolution)
      .catch((snapshotError) => setError(snapshotError instanceof Error ? snapshotError.message : String(snapshotError)));
  }, [activeChapter?.id, activeChapter?.updatedAt]);

  useEffect(() => {
    setEditing(false);
  }, [activeChapter?.id]);

  const clearDraft = () => {
    setTitle("");
    setContent("");
    setSavedAt(null);
    setDirty(false);
    draftRef.current = {
      chapterId: "",
      title: "",
      content: "",
      dirty: false,
      version: draftRef.current.version + 1,
    };
  };

  const persistDraft = async (force: boolean): Promise<boolean> => {
    const draft = draftRef.current;
    if (!draft.chapterId || (!force && !draft.dirty)) return true;
    if (savingRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const nextTitle = draft.title.trim() || "未命名章节";
      await saveChapter(draft.chapterId, nextTitle, draft.content);
      const snapshot = await recordLatestAuthorRevision(draft.chapterId, draft.content);
      const updatedAt = new Date().toISOString();
      const savedTime = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      setChapters((current) => current.map((chapter) => chapter.id === draft.chapterId
        ? { ...chapter, title: nextTitle, content: draft.content, updatedAt }
        : chapter));
      if (draftRef.current.chapterId === draft.chapterId && draftRef.current.version === draft.version) {
        setTitle(nextTitle);
        draftRef.current = { ...draftRef.current, title: nextTitle, dirty: false };
        setDirty(false);
      }
      setSavedAt(savedTime);
      setPendingEvolution(snapshot?.status === "revised" && snapshot.authorRevision !== snapshot.aiDraft ? snapshot : null);
      return true;
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  useEffect(() => {
    persistDraftRef.current = persistDraft;
  });

  useEffect(() => {
    if (!dirty || saving) return;
    const timeout = setTimeout(() => {
      void persistDraft(false);
    }, autoSaveDelay);
    return () => clearTimeout(timeout);
  }, [dirty, title, content, activeChapter?.id, autoSaveDelay, saving]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState !== "active") void persistDraftRef.current(false);
    });
    return () => {
      subscription.remove();
      void persistDraftRef.current(false);
    };
  }, []);

  const updateDraft = (nextTitle: string, nextContent: string) => {
    setTitle(nextTitle);
    setContent(nextContent);
    setSavedAt(null);
    setDirty(true);
    draftRef.current = {
      chapterId: activeChapter?.id ?? draftRef.current.chapterId,
      title: nextTitle,
      content: nextContent,
      dirty: true,
      version: draftRef.current.version + 1,
    };
  };

  const selectChapter = async (chapterId: string) => {
    if (chapterId === activeChapter?.id) {
      setChapterPickerVisible(false);
      return;
    }
    if (savingRef.current) {
      setError("章节正在保存，请稍后再切换");
      return;
    }
    if (!await persistDraft(false)) return;
    setCurrentChapter(chapterId);
    setChapterPickerVisible(false);
  };

  const openNameDialog = async (dialog: NameDialog, initialValue: string) => {
    if (savingRef.current) {
      setError("章节正在保存，请稍后再操作");
      return;
    }
    if (!await persistDraft(false)) return;
    setDirectoryTarget(null);
    setChapterPickerVisible(false);
    setNameValue(initialValue);
    setNameDialog(dialog);
  };

  const submitNameDialog = async () => {
    if (!projectId || !nameDialog || !nameValue.trim()) return;
    setNameSaving(true);
    setError(null);
    try {
      if (nameDialog.kind === "create-volume") {
        const volume = await createVolume(projectId, nameValue);
        setVolumes((current) => [...current, volume].sort((left, right) => left.orderIndex - right.orderIndex));
      } else if (nameDialog.kind === "rename-volume") {
        const volume = await renameVolume(nameDialog.volume.id, nameValue);
        setVolumes((current) => current.map((item) => item.id === volume.id ? volume : item));
      } else if (nameDialog.kind === "create-chapter") {
        const chapter = await createChapter(projectId, nameDialog.volume.id, nameValue);
        setChapters((current) => [...current, chapter]);
        setCurrentChapter(chapter.id);
      } else {
        const chapter = await renameChapter(nameDialog.chapter.id, nameValue);
        setChapters((current) => current.map((item) => item.id === chapter.id ? chapter : item));
        if (activeChapter?.id === chapter.id) {
          setTitle(chapter.title);
          draftRef.current = {
            ...draftRef.current,
            title: chapter.title,
            dirty: false,
            version: draftRef.current.version + 1,
          };
          setDirty(false);
        }
      }
      setNameDialog(null);
      setNameValue("");
      refreshData();
    } catch (nameError) {
      setError(nameError instanceof Error ? nameError.message : String(nameError));
    } finally {
      setNameSaving(false);
    }
  };

  const removeChapter = async (chapter: Chapter, removeNotes: boolean) => {
    if (savingRef.current) {
      setError("章节正在保存，请稍后再删除");
      return;
    }
    if (chapter.id === activeChapter?.id && !await persistDraft(false)) return;
    setError(null);
    try {
      // 先删笔记再删章节；不删的话外键 SET NULL 会让这些笔记上浮到卷级。
      if (removeNotes) await deleteNotesUnder({ chapterId: chapter.id });
      await deleteChapter(chapter.id);
      const nextChapters = chapters.filter((item) => item.id !== chapter.id);
      setChapters(nextChapters);
      if (chapter.id === activeChapter?.id) {
        const nextChapter = nextChapters[0] ?? null;
        setCurrentChapter(nextChapter?.id ?? null);
        if (!nextChapter) clearDraft();
      }
      refreshData();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    }
  };

  const confirmDeleteChapter = async (chapter: Chapter) => {
    setDirectoryTarget(null);
    setChapterPickerVisible(false);
    const noteCount = await countNotesUnder({ chapterId: chapter.id }).catch(() => 0);
    if (!noteCount) {
      Alert.alert("删除章节", "确定删除《" + chapter.title + "》？正文和本地索引会一并删除。", [
        { text: "取消", style: "cancel" },
        { text: "删除", style: "destructive", onPress: () => { void removeChapter(chapter, false); } },
      ]);
      return;
    }
    Alert.alert(
      "删除章节",
      "《" + chapter.title + "》有 " + noteCount + " 条笔记。正文和本地索引会一并删除，笔记怎么处理？",
      [
        { text: "取消", style: "cancel" },
        { text: "保留笔记", onPress: () => { void removeChapter(chapter, false); } },
        { text: "一并删除", style: "destructive", onPress: () => { void removeChapter(chapter, true); } },
      ],
    );
  };

  const removeVolume = async (volume: Volume, removeNotes: boolean) => {
    if (savingRef.current) {
      setError("章节正在保存，请稍后再删除");
      return;
    }
    const removesActiveChapter = activeChapter?.volumeId === volume.id;
    if (removesActiveChapter && !await persistDraft(false)) return;
    setError(null);
    try {
      if (removeNotes) await deleteNotesUnder({ volumeId: volume.id });
      await deleteVolume(volume.id);
      const nextVolumes = volumes.filter((item) => item.id !== volume.id);
      const nextChapters = chapters.filter((chapter) => chapter.volumeId !== volume.id);
      setVolumes(nextVolumes);
      setChapters(nextChapters);
      if (removesActiveChapter) {
        const nextChapter = nextChapters[0] ?? null;
        setCurrentChapter(nextChapter?.id ?? null);
        if (!nextChapter) clearDraft();
      }
      refreshData();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    }
  };

  const confirmDeleteVolume = (volume: Volume) => {
    setDirectoryTarget(null);
    setChapterPickerVisible(false);
    if (volumes.length <= 1) {
      Alert.alert("无法删除", "每部作品至少需要保留一卷，可以改为重命名。");
      return;
    }
    const chapterCount = chapters.filter((chapter) => chapter.volumeId === volume.id).length;
    const detail = chapterCount
      ? "其中 " + chapterCount + " 章正文和本地索引会一并删除。"
      : "该卷目前没有章节。";
    void countNotesUnder({ volumeId: volume.id }).catch(() => 0).then((noteCount) => {
      if (!noteCount) {
        Alert.alert("删除卷", "确定删除《" + volume.title + "》？" + detail, [
          { text: "取消", style: "cancel" },
          { text: "删除", style: "destructive", onPress: () => { void removeVolume(volume, false); } },
        ]);
        return;
      }
      Alert.alert(
        "删除卷",
        "《" + volume.title + "》及其章节共有 " + noteCount + " 条笔记。" + detail + "笔记怎么处理？",
        [
          { text: "取消", style: "cancel" },
          { text: "保留笔记", onPress: () => { void removeVolume(volume, false); } },
          { text: "一并删除", style: "destructive", onPress: () => { void removeVolume(volume, true); } },
        ],
      );
    });
  };

  const openNewChapter = () => {
    const volume = activeVolume ?? volumes[0];
    if (volume) {
      void openNameDialog(
        { kind: "create-chapter", volume },
        "第" + (chapters.length + 1) + "章",
      );
    } else {
      void openNameDialog({ kind: "create-volume" }, "第一卷");
    }
  };

  const saveAndPreview = async () => {
    if (await persistDraft(true)) setEditing(false);
  };

  const chooseStyle = async (profile: StyleProfile | null) => {
    if (!projectId || evolvingStyle) return;
    setError(null);
    try {
      await setActiveStyleProfile(projectId, profile?.id ?? null);
      setActiveStyleProfileState(profile);
      setStylePickerVisible(false);
    } catch (styleError) {
      setError(styleError instanceof Error ? styleError.message : String(styleError));
    }
  };

  const evolveFromRevision = async () => {
    if (!projectId || !activeChapter || !pendingEvolution || evolvingStyle) return;
    setEvolvingStyle(true);
    setError(null);
    try {
      if (!await persistDraft(false)) return;
      const selection = await resolveModelSelection();
      const evolved = await evolveAuthorStyle({
        projectId,
        aiDraft: pendingEvolution.aiDraft,
        authorRevision: pendingEvolution.authorRevision ?? content,
        selection,
      });
      await markChapterStyleEvolved(pendingEvolution.id);
      setStyleProfiles((current) => [
        evolved.profile,
        ...current.filter((profile) => profile.id !== evolved.profile.id),
      ]);
      setActiveStyleProfileState(evolved.profile);
      setPendingEvolution(null);
      refreshData();
      Alert.alert("作者文风已进化", "已保存为“" + evolved.profile.name + " V" + evolved.profile.version + "”，后续创作将使用这个版本。");
    } catch (evolutionError) {
      setError(evolutionError instanceof Error ? evolutionError.message : String(evolutionError));
    } finally {
      setEvolvingStyle(false);
    }
  };

  const handleExport = async (scope: ExportScope) => {
    if (!project) return;
    const chapterId = activeChapter?.id;
    const volumeId = activeVolume?.id;
    setExporting(true);
    setError(null);
    try {
      if (!await persistDraft(false)) return;
      const [freshVolumes, freshChapters] = await Promise.all([
        listVolumes(project.id),
        listChapters(project.id),
      ]);
      await exportNovel({ project, volumes: freshVolumes, chapters: freshChapters, scope, chapterId, volumeId });
      setExportPickerVisible(false);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : String(exportError));
    } finally {
      setExporting(false);
    }
  };

  const nameDialogTitle = nameDialog?.kind === "create-volume"
    ? "新建卷"
    : nameDialog?.kind === "rename-volume"
      ? "重命名卷"
      : nameDialog?.kind === "create-chapter"
        ? "新建章节"
        : "重命名章节";
  const nameDialogLabel = nameDialog?.kind === "create-volume" || nameDialog?.kind === "rename-volume"
    ? "卷名"
    : "章节名";

  if (!projectId) return <Screen><EmptyState title="请先从书架选择一部作品" /></Screen>;
  if (loading) return <Screen><Header title="写作" /><View style={styles.loading}><Text style={styles.muted}>正在打开作品...</Text></View></Screen>;

  return (
    <Screen>
      <Header
        title={project?.title ?? "写作"}
        action={(
          <View style={styles.headerActions}>
            <Pressable accessibilityLabel="导出作品" onPress={() => setExportPickerVisible(true)} style={styles.iconButton}>
              <Ionicons name="share-outline" size={22} color={colors.primary} />
            </Pressable>
            <Pressable accessibilityLabel={volumes.length ? "新建章节" : "新建卷"} onPress={openNewChapter} style={styles.iconButton}>
              <Ionicons name={volumes.length ? "document-text-outline" : "folder-open-outline"} size={23} color={colors.primary} />
            </Pressable>
          </View>
        )}
      />
      <KeyboardAvoidingView style={styles.flex} behavior="height" automaticOffset>
        <Pressable accessibilityRole="button" onPress={() => setChapterPickerVisible(true)} style={styles.chapterPicker}>
          <View style={styles.chapterPickerTextGroup}>
            <Text numberOfLines={1} style={styles.chapterPickerVolume}>{activeVolume?.title ?? "作品目录"}</Text>
            <Text numberOfLines={1} style={styles.chapterPickerText}>{activeChapter?.title ?? "选择章节"}</Text>
          </View>
          <Ionicons name="chevron-down" size={18} color={colors.textMuted} />
        </Pressable>
        <Pressable accessibilityRole="button" onPress={() => setStylePickerVisible(true)} style={styles.styleSelector}>
          <Ionicons name="color-wand-outline" size={17} color={activeStyleProfile ? colors.primary : colors.textMuted} />
          <Text numberOfLines={1} style={[styles.styleSelectorText, activeStyleProfile && styles.styleSelectorTextActive]}>
            {activeStyleProfile ? activeStyleProfile.name + " V" + activeStyleProfile.version : "不使用创作文风"}
          </Text>
          <Ionicons name="chevron-down" size={16} color={colors.textMuted} />
        </Pressable>
        {error ? <View style={styles.errorWrap}><ErrorNotice message={error} /></View> : null}
        {activeChapter ? (
          <View style={styles.editor}>
            {editing ? (
              <>
                <TextInput
                  value={title}
                  onChangeText={(value) => updateDraft(value, content)}
                  style={styles.titleInput}
                  placeholder="章节标题"
                  placeholderTextColor={colors.textMuted}
                  maxLength={200}
                />
                <TextInput
                  value={content}
                  onChangeText={(value) => updateDraft(title, value)}
                  style={[styles.contentInput, { fontSize: editorFontSize, lineHeight: Math.round(editorFontSize * 1.65) }]}
                  placeholder="开始写作..."
                  placeholderTextColor={colors.textMuted}
                  multiline
                  textAlignVertical="top"
                  autoCorrect
                />
                <View style={styles.editorFooter}>
                  <Text style={styles.counter}>
                    {content.replace(/\s/g, "").length + " 字" + (dirty ? " · 未保存" : savedAt ? " · " + savedAt + " 已保存" : "")}
                  </Text>
                  <Button label={saving ? "保存中" : "保存并预览"} onPress={() => { void saveAndPreview(); }} disabled={saving} loading={saving} />
                </View>
              </>
            ) : (
              <View style={styles.preview}>
                <View style={styles.previewHeader}>
                  <View style={styles.previewHeading}>
                    <Text style={styles.previewTitle}>{title || "未命名章节"}</Text>
                    <Text style={styles.previewMeta}>{content.replace(/\s/g, "").length + " 字" + (savedAt ? " · " + savedAt + " 已保存" : "")}</Text>
                  </View>
                  <Pressable accessibilityLabel="编辑章节" onPress={() => setEditing(true)} style={styles.editButton}>
                    <Ionicons name="create-outline" size={22} color={colors.primary} />
                    <Text style={styles.editButtonText}>编辑</Text>
                  </Pressable>
                </View>
                <ScrollView style={styles.previewScroll} contentContainerStyle={styles.previewContent} showsVerticalScrollIndicator>
                  <Text selectable style={[styles.previewText, { fontSize: editorFontSize, lineHeight: Math.round(editorFontSize * 1.65) }]}>
                    {content || "本章暂无正文，点击右上角编辑开始写作。"}
                  </Text>
                </ScrollView>
                <View style={styles.editorFooter}>
                  <Text style={styles.counter}>{dirty ? "正在保存修改..." : "预览模式"}</Text>
                  <View style={styles.previewActions}>
                    {pendingEvolution ? (
                      <Button label="进化作者文风" variant="secondary" onPress={() => { void evolveFromRevision(); }} disabled={saving || evolvingStyle} loading={evolvingStyle} />
                    ) : null}
                    {dirty ? <Button label="保存" onPress={() => { void persistDraft(true); }} disabled={saving} loading={saving} /> : null}
                  </View>
                </View>
              </View>
            )}
          </View>
        ) : volumes[0] ? (
          <EmptyState
            title={"《" + volumes[0].title + "》还没有章节"}
            action={<Button label="新建章节" onPress={openNewChapter} />}
          />
        ) : (
          <EmptyState
            title="还没有卷"
            action={<Button label="新建卷" onPress={() => { void openNameDialog({ kind: "create-volume" }, "第一卷"); }} />}
          />
        )}
      </KeyboardAvoidingView>

      <Modal visible={stylePickerVisible} transparent animationType="slide" onRequestClose={() => setStylePickerVisible(false)}>
        <SheetBackdrop onPress={() => setStylePickerVisible(false)}>
          <View style={styles.actionSheet}>
            <View style={styles.exportHeader}>
              <View>
                <Text style={styles.sheetTitle}>选择创作文风</Text>
                <Text style={styles.styleSheetMeta}>会用于助手后续生成或修改正文</Text>
              </View>
              <Pressable accessibilityLabel="关闭文风列表" onPress={() => setStylePickerVisible(false)} style={styles.iconButton}>
                <Ionicons name="close" size={24} color={colors.textMuted} />
              </Pressable>
            </View>
            <ScrollView style={styles.styleList} contentContainerStyle={styles.styleListContent}>
              <Pressable onPress={() => void chooseStyle(null)} style={[styles.styleOption, !activeStyleProfile && styles.styleOptionActive]}>
                <Ionicons name={!activeStyleProfile ? "radio-button-on" : "radio-button-off"} size={20} color={!activeStyleProfile ? colors.primary : colors.textMuted} />
                <View style={styles.styleOptionCopy}>
                  <Text style={styles.styleOptionTitle}>不使用文风</Text>
                  <Text style={styles.styleOptionMeta}>只遵循本轮要求与作品设定</Text>
                </View>
              </Pressable>
              {styleProfiles.map((profile) => {
                const selected = profile.id === activeStyleProfile?.id;
                return (
                  <Pressable key={profile.id} onPress={() => void chooseStyle(profile)} style={[styles.styleOption, selected && styles.styleOptionActive]}>
                    <Ionicons name={selected ? "radio-button-on" : "radio-button-off"} size={20} color={selected ? colors.primary : colors.textMuted} />
                    <View style={styles.styleOptionCopy}>
                      <Text style={styles.styleOptionTitle} numberOfLines={1}>{profile.name} V{profile.version}</Text>
                      <Text style={styles.styleOptionMeta}>{profile.kind === "author" ? "当前作品作者文风" : "参考小说文风"}</Text>
                    </View>
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        </SheetBackdrop>
      </Modal>

      <Modal visible={chapterPickerVisible} transparent animationType="slide" onRequestClose={() => setChapterPickerVisible(false)}>
        <SheetBackdrop onPress={() => setChapterPickerVisible(false)}>
          <View style={styles.directorySheet}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>作品目录</Text>
              <View style={styles.sheetHeaderActions}>
                <Pressable
                  accessibilityLabel="新建卷"
                  onPress={() => { void openNameDialog({ kind: "create-volume" }, "第" + (volumes.length + 1) + "卷"); }}
                  style={styles.iconButton}
                >
                  <Ionicons name="folder-open-outline" size={22} color={colors.primary} />
                </Pressable>
                <Pressable accessibilityLabel="关闭目录" onPress={() => setChapterPickerVisible(false)} style={styles.iconButton}>
                  <Ionicons name="close" size={24} color={colors.textMuted} />
                </Pressable>
              </View>
            </View>
            <SectionList
              sections={directorySections}
              keyExtractor={(item) => item.id}
              stickySectionHeadersEnabled={false}
              contentContainerStyle={styles.directoryList}
              renderSectionHeader={({ section }) => (
                <View style={styles.volumeHeader}>
                  <Ionicons name="folder-open-outline" size={18} color={colors.accent} />
                  <Text numberOfLines={1} style={styles.volumeTitle}>{section.volume.title}</Text>
                  <Text style={styles.volumeCount}>{section.data.length + " 章"}</Text>
                  <Pressable
                    accessibilityLabel={"在" + section.volume.title + "中新建章节"}
                    onPress={() => {
                      void openNameDialog(
                        { kind: "create-chapter", volume: section.volume },
                        "第" + (chapters.length + 1) + "章",
                      );
                    }}
                    style={styles.rowAction}
                  >
                    <Ionicons name="add" size={21} color={colors.primary} />
                  </Pressable>
                  <Pressable
                    accessibilityLabel={"管理" + section.volume.title}
                    onPress={() => setDirectoryTarget({ kind: "volume", volume: section.volume })}
                    style={styles.rowAction}
                  >
                    <Ionicons name="ellipsis-horizontal" size={20} color={colors.textMuted} />
                  </Pressable>
                </View>
              )}
              renderItem={({ item }) => (
                <Pressable
                  onPress={() => { void selectChapter(item.id); }}
                  style={[styles.chapterRow, item.id === activeChapter?.id && styles.chapterRowActive]}
                >
                  <Ionicons
                    name="document-text-outline"
                    size={18}
                    color={item.id === activeChapter?.id ? colors.primary : colors.textMuted}
                  />
                  <Text numberOfLines={1} style={[styles.chapterRowText, item.id === activeChapter?.id && styles.chapterRowTextActive]}>
                    {item.title}
                  </Text>
                  {item.id === activeChapter?.id ? <Ionicons name="checkmark" size={20} color={colors.primary} /> : null}
                  <Pressable
                    accessibilityLabel={"管理" + item.title}
                    onPress={(event) => {
                      event.stopPropagation();
                      setDirectoryTarget({ kind: "chapter", chapter: item });
                    }}
                    style={styles.rowAction}
                  >
                    <Ionicons name="ellipsis-horizontal" size={20} color={colors.textMuted} />
                  </Pressable>
                </Pressable>
              )}
              ListEmptyComponent={(
                <EmptyState
                  title="还没有卷"
                  action={<Button label="新建卷" onPress={() => { void openNameDialog({ kind: "create-volume" }, "第一卷"); }} />}
                />
              )}
            />
          </View>
        </SheetBackdrop>
      </Modal>

      <Modal visible={exportPickerVisible} transparent animationType="fade" onRequestClose={() => setExportPickerVisible(false)}>
        <SheetBackdrop onPress={() => setExportPickerVisible(false)}>
          <View style={styles.actionSheet}>
            <View style={styles.exportHeader}>
              <Text style={styles.actionTitle}>导出作品</Text>
              <Pressable accessibilityLabel="关闭导出选项" onPress={() => setExportPickerVisible(false)} style={styles.iconButton}>
                <Ionicons name="close" size={24} color={colors.textMuted} />
              </Pressable>
            </View>
            <Pressable disabled={exporting || !activeChapter} onPress={() => { void handleExport("chapter"); }} style={[styles.exportOption, (!activeChapter || exporting) && styles.exportOptionDisabled]}>
              <Ionicons name="document-text-outline" size={23} color={activeChapter ? colors.primary : colors.textMuted} />
              <View style={styles.exportOptionText}>
                <Text style={styles.exportOptionTitle}>当前章节</Text>
                <Text style={styles.exportOptionMeta} numberOfLines={1}>{activeChapter?.title ?? "没有可导出的章节"}</Text>
              </View>
              {exporting ? <ActivityIndicator color={colors.primary} /> : <Ionicons name="chevron-forward" size={19} color={colors.textMuted} />}
            </Pressable>
            <Pressable disabled={exporting || !activeVolume} onPress={() => { void handleExport("volume"); }} style={[styles.exportOption, (!activeVolume || exporting) && styles.exportOptionDisabled]}>
              <Ionicons name="folder-open-outline" size={23} color={activeVolume ? colors.primary : colors.textMuted} />
              <View style={styles.exportOptionText}>
                <Text style={styles.exportOptionTitle}>当前卷</Text>
                <Text style={styles.exportOptionMeta} numberOfLines={1}>{activeVolume?.title ?? "没有可导出的卷"}</Text>
              </View>
              <Ionicons name="chevron-forward" size={19} color={colors.textMuted} />
            </Pressable>
            <Pressable disabled={exporting || !volumes.length} onPress={() => { void handleExport("book"); }} style={[styles.exportOption, (!volumes.length || exporting) && styles.exportOptionDisabled]}>
              <Ionicons name="library-outline" size={23} color={volumes.length ? colors.primary : colors.textMuted} />
              <View style={styles.exportOptionText}>
                <Text style={styles.exportOptionTitle}>整本小说</Text>
                <Text style={styles.exportOptionMeta}>{volumes.length + " 卷 · " + chapters.length + " 章"}</Text>
              </View>
              <Ionicons name="chevron-forward" size={19} color={colors.textMuted} />
            </Pressable>
          </View>
        </SheetBackdrop>
      </Modal>
      <Modal visible={Boolean(directoryTarget)} transparent animationType="fade" onRequestClose={() => setDirectoryTarget(null)}>
        <SheetBackdrop onPress={() => setDirectoryTarget(null)}>
          <View style={styles.actionSheet}>
            <Text numberOfLines={2} style={styles.actionTitle}>
              {directoryTarget?.kind === "volume" ? directoryTarget.volume.title : directoryTarget?.chapter.title}
            </Text>
            {directoryTarget?.kind === "volume" ? (
              <Pressable
                onPress={() => {
                  void openNameDialog(
                    { kind: "create-chapter", volume: directoryTarget.volume },
                    "第" + (chapters.length + 1) + "章",
                  );
                }}
                style={styles.actionRow}
              >
                <Ionicons name="add-circle-outline" size={22} color={colors.primary} />
                <Text style={styles.actionText}>新建章节</Text>
              </Pressable>
            ) : null}
            <Pressable
              onPress={() => {
                if (directoryTarget?.kind === "volume") {
                  void openNameDialog({ kind: "rename-volume", volume: directoryTarget.volume }, directoryTarget.volume.title);
                } else if (directoryTarget?.kind === "chapter") {
                  void openNameDialog({ kind: "rename-chapter", chapter: directoryTarget.chapter }, directoryTarget.chapter.title);
                }
              }}
              style={styles.actionRow}
            >
              <Ionicons name="create-outline" size={22} color={colors.text} />
              <Text style={styles.actionText}>重命名</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                if (directoryTarget?.kind === "volume") confirmDeleteVolume(directoryTarget.volume);
                else if (directoryTarget?.kind === "chapter") void confirmDeleteChapter(directoryTarget.chapter);
              }}
              style={styles.actionRow}
            >
              <Ionicons name="trash-outline" size={22} color={colors.danger} />
              <Text style={styles.actionTextDanger}>{directoryTarget?.kind === "volume" ? "删除卷" : "删除章节"}</Text>
            </Pressable>
          </View>
        </SheetBackdrop>
      </Modal>

      <Modal visible={Boolean(nameDialog)} transparent animationType="fade" onRequestClose={() => setNameDialog(null)}>
        <KeyboardAvoidingView style={styles.centeredBackdrop} behavior="height" automaticOffset>
          <View style={styles.nameDialog}>
            <Text style={styles.nameDialogTitle}>{nameDialogTitle}</Text>
            <Field
              label={nameDialogLabel}
              value={nameValue}
              onChangeText={setNameValue}
              maxLength={200}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={() => { void submitNameDialog(); }}
            />
            <View style={styles.nameDialogActions}>
              <Button label="取消" variant="secondary" onPress={() => setNameDialog(null)} />
              <Button label="确定" onPress={() => { void submitNameDialog(); }} disabled={!nameValue.trim()} loading={nameSaving} />
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  loading: { flex: 1, alignItems: "center", justifyContent: "center" },
  muted: { color: colors.textMuted, fontSize: 15, padding: spacing.lg, textAlign: "center" },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  headerActions: { flexDirection: "row", alignItems: "center" },
  chapterPicker: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  chapterPickerTextGroup: { flex: 1, minWidth: 0, gap: 2 },
  chapterPickerVolume: { color: colors.textMuted, fontSize: 12, fontWeight: "600" },
  chapterPickerText: { color: colors.text, fontSize: 15, fontWeight: "700" },
  styleSelector: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.lg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, backgroundColor: colors.surface },
  styleSelectorText: { flex: 1, color: colors.textMuted, fontSize: 13, fontWeight: "600" },
  styleSelectorTextActive: { color: colors.primary },
  errorWrap: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  editor: { flex: 1, padding: spacing.lg, gap: spacing.md },
  preview: { flex: 1, gap: spacing.md },
  previewHeader: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingBottom: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  previewHeading: { flex: 1, minWidth: 0, gap: spacing.xs },
  previewTitle: { color: colors.text, fontSize: 23, fontWeight: "700" },
  previewMeta: { color: colors.textMuted, fontSize: 12 },
  editButton: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: spacing.xs, paddingHorizontal: spacing.sm },
  editButtonText: { color: colors.primary, fontSize: 14, fontWeight: "700" },
  previewScroll: { flex: 1 },
  previewContent: { paddingVertical: spacing.md, paddingBottom: spacing.xl },
  previewText: { minHeight: 220, color: colors.text },
  titleInput: { color: colors.text, fontSize: 22, fontWeight: "700", paddingVertical: spacing.sm },
  contentInput: { flex: 1, minHeight: 220, color: colors.text, fontSize: 17, lineHeight: 28, padding: 0 },
  editorFooter: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: spacing.md },
  previewActions: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end", gap: spacing.sm },
  counter: { flex: 1, color: colors.textMuted, fontSize: 12 },
  centeredBackdrop: { flex: 1, justifyContent: "center", padding: spacing.lg, backgroundColor: colors.overlay },
  directorySheet: {
    maxHeight: "82%",
    minHeight: "46%",
    paddingBottom: spacing.lg,
    borderTopLeftRadius: radius.md,
    borderTopRightRadius: radius.md,
    backgroundColor: colors.background,
  },
  sheetHeader: {
    minHeight: 58,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingLeft: spacing.lg,
    paddingRight: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  sheetHeaderActions: { flexDirection: "row", alignItems: "center" },
  sheetTitle: { color: colors.text, fontSize: 18, fontWeight: "700" },
  styleSheetMeta: { marginTop: 2, color: colors.textMuted, fontSize: 12 },
  styleList: { maxHeight: 420 },
  styleListContent: { paddingBottom: spacing.sm },
  styleOption: { minHeight: 62, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  styleOptionActive: { backgroundColor: colors.surfaceMuted },
  styleOptionCopy: { flex: 1, minWidth: 0 },
  styleOptionTitle: { color: colors.text, fontSize: 15, fontWeight: "600" },
  styleOptionMeta: { marginTop: 3, color: colors.textMuted, fontSize: 12 },
  directoryList: { paddingBottom: spacing.lg },
  volumeHeader: {
    minHeight: 50,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingLeft: spacing.lg,
    paddingRight: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.surfaceMuted,
  },
  volumeTitle: { flex: 1, minWidth: 0, color: colors.text, fontSize: 15, fontWeight: "700" },
  volumeCount: { color: colors.textMuted, fontSize: 12 },
  chapterRow: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingLeft: spacing.xl,
    paddingRight: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.background,
  },
  chapterRowActive: { backgroundColor: colors.surface },
  chapterRowText: { flex: 1, minWidth: 0, color: colors.text, fontSize: 15 },
  chapterRowTextActive: { color: colors.primary, fontWeight: "700" },
  rowAction: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  actionSheet: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xl,
    borderTopLeftRadius: radius.md,
    borderTopRightRadius: radius.md,
    backgroundColor: colors.background,
  },
  exportHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingLeft: spacing.sm },
  exportOption: { minHeight: 66, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  exportOptionDisabled: { opacity: 0.48 },
  exportOptionText: { flex: 1, minWidth: 0, gap: 2 },
  exportOptionTitle: { color: colors.text, fontSize: 16, fontWeight: "700" },
  exportOptionMeta: { color: colors.textMuted, fontSize: 12 },
  actionTitle: {
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 19,
    paddingHorizontal: spacing.sm,
    paddingBottom: spacing.sm,
  },
  actionRow: {
    minHeight: 54,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  actionText: { color: colors.text, fontSize: 16, fontWeight: "600" },
  actionTextDanger: { color: colors.danger, fontSize: 16, fontWeight: "600" },
  nameDialog: { gap: spacing.lg, padding: spacing.xl, borderRadius: radius.md, backgroundColor: colors.background },
  nameDialogTitle: { color: colors.text, fontSize: 20, fontWeight: "700" },
  nameDialogActions: { flexDirection: "row", justifyContent: "flex-end", gap: spacing.sm },
});
