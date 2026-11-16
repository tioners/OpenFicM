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
import { KeyboardAvoidingView } from "react-native-keyboard-controller";

import { Button, EmptyState, ErrorNotice, Field, Header, Screen, SheetBackdrop } from "@/components/ui";
import { listChapters, listVolumes } from "@/data/repositories";
import {
  createNote,
  createNoteCategory,
  deleteNote,
  deleteNoteCategory,
  listNoteCategories,
  listNotes,
  moveNote,
  noteScope,
  renameNoteCategory,
  updateNote,
} from "@/data/note-repositories";
import type { RootStackParamList } from "@/navigation/types";
import { useAppStore } from "@/store/app-store";
import { colors, radius, spacing } from "@/theme";
import { themedStyles } from "@/themed-styles";
import type { Chapter, Note, NoteCategory, NoteScope, Volume } from "@/types";

type Group = {
  key: string;
  label: string;
  scope: NoteScope;
  volumeId: string | null;
  chapterId: string | null;
  notes: Note[];
};

const SCOPE_LABEL: Record<NoteScope, string> = {
  project: "整书",
  volume: "卷",
  chapter: "章",
};

export function NotesScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const projectId = useAppStore((state) => state.currentProjectId);
  const [allNotes, setNotes] = useState<Note[]>([]);
  const [volumes, setVolumes] = useState<Volume[]>([]);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Note | null>(null);
  const [creatingIn, setCreatingIn] = useState<Group | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [movingNote, setMovingNote] = useState<Note | null>(null);
  const [categories, setCategories] = useState<NoteCategory[]>([]);
  /** 列表筛选：null 全部，"" 未分类，其它为分类 ID。 */
  const [filterCategoryId, setFilterCategoryId] = useState<string | null>(null);
  const [noteCategoryId, setNoteCategoryId] = useState<string | null>(null);
  const [categoryDialog, setCategoryDialog] = useState<{ target: NoteCategory | null } | null>(null);
  const [categoryTitle, setCategoryTitle] = useState("");

  const load = useCallback(async () => {
    if (!projectId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [nextNotes, nextVolumes, nextChapters, nextCategories] = await Promise.all([
        listNotes(projectId),
        listVolumes(projectId),
        listChapters(projectId),
        listNoteCategories(projectId),
      ]);
      setCategories(nextCategories);
      setFilterCategoryId((current) => (current && !nextCategories.some((category) => category.id === current) ? null : current));
      setNotes(nextNotes);
      setVolumes(nextVolumes);
      setChapters(nextChapters);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useFocusEffect(useCallback(() => {
    void load();
  }, [load]));

  // 三层分组：整书在最前，然后按卷顺序，每卷后面跟它的章。空分组也保留，方便直接在该层级新建。
  const visibleNotes = useMemo(() => (filterCategoryId === null
    ? allNotes
    : allNotes.filter((note) => (note.categoryId ?? "") === filterCategoryId)), [allNotes, filterCategoryId]);

  const groups = useMemo<Group[]>(() => {
    const notes = visibleNotes;
    const chaptersByVolume = new Map<string, Chapter[]>();
    for (const chapter of chapters) {
      const list = chaptersByVolume.get(chapter.volumeId) ?? [];
      list.push(chapter);
      chaptersByVolume.set(chapter.volumeId, list);
    }
    const output: Group[] = [{
      key: "project",
      label: "整书",
      scope: "project",
      volumeId: null,
      chapterId: null,
      notes: notes.filter((note) => noteScope(note) === "project"),
    }];
    for (const volume of volumes) {
      output.push({
        key: `volume:${volume.id}`,
        label: volume.title,
        scope: "volume",
        volumeId: volume.id,
        chapterId: null,
        notes: notes.filter((note) => note.volumeId === volume.id && !note.chapterId),
      });
      for (const chapter of chaptersByVolume.get(volume.id) ?? []) {
        const chapterNotes = notes.filter((note) => note.chapterId === chapter.id);
        if (!chapterNotes.length) continue;
        output.push({
          key: `chapter:${chapter.id}`,
          label: `　${chapter.title}`,
          scope: "chapter",
          volumeId: volume.id,
          chapterId: chapter.id,
          notes: chapterNotes,
        });
      }
    }
    return output;
  }, [visibleNotes, volumes, chapters]);

  const totalNotes = allNotes.length;

  const submitCategory = async () => {
    if (!projectId || !categoryDialog || !categoryTitle.trim()) return;
    setBusy(true);
    setError(null);
    try {
      if (categoryDialog.target) await renameNoteCategory(categoryDialog.target.id, categoryTitle);
      else setFilterCategoryId((await createNoteCategory(projectId, categoryTitle)).id);
      setCategoryDialog(null);
      await load();
    } catch (categoryError) {
      setError(categoryError instanceof Error ? categoryError.message : String(categoryError));
    } finally {
      setBusy(false);
    }
  };

  const manageCategory = (category: NoteCategory) => {
    Alert.alert(category.title, "分类只用来归拢笔记，删除分类不会删除其中的笔记。", [
      {
        text: "重命名",
        onPress: () => {
          setCategoryTitle(category.title);
          setCategoryDialog({ target: category });
        },
      },
      {
        text: "删除分类",
        style: "destructive",
        onPress: () => {
          void deleteNoteCategory(category.id)
            .then(load)
            .catch((deleteError) => setError(deleteError instanceof Error ? deleteError.message : String(deleteError)));
        },
      },
      { text: "取消", style: "cancel" },
    ]);
  };

  const openCreate = (group: Group) => {
    setCreatingIn(group);
    setEditing(null);
    setTitle("");
    setContent("");
    setNoteCategoryId(filterCategoryId || null);
  };

  const openEdit = (note: Note) => {
    setEditing(note);
    setCreatingIn(null);
    setTitle(note.title);
    setContent(note.content);
    setNoteCategoryId(note.categoryId);
  };

  const closeEditor = () => {
    if (busy) return;
    setEditing(null);
    setCreatingIn(null);
  };

  const save = async () => {
    if (!projectId || !title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      if (editing) {
        await updateNote({ id: editing.id, title, content, categoryId: noteCategoryId });
      } else if (creatingIn) {
        await createNote({
          projectId,
          title,
          content,
          volumeId: creatingIn.volumeId,
          chapterId: creatingIn.chapterId,
          categoryId: noteCategoryId,
        });
      }
      closeEditor();
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = (note: Note) => {
    Alert.alert("删除笔记", `确定删除“${note.title}”？`, [
      { text: "取消", style: "cancel" },
      {
        text: "删除",
        style: "destructive",
        onPress: () => {
          setBusy(true);
          void deleteNote(note.id)
            .then(async () => {
              closeEditor();
              await load();
            })
            .catch((deleteError) => setError(deleteError instanceof Error ? deleteError.message : String(deleteError)))
            .finally(() => setBusy(false));
        },
      },
    ]);
  };

  const applyMove = async (target: Group) => {
    if (!movingNote) return;
    setBusy(true);
    setError(null);
    try {
      await moveNote(movingNote.id, { volumeId: target.volumeId, chapterId: target.chapterId });
      setMovingNote(null);
      await load();
    } catch (moveError) {
      setError(moveError instanceof Error ? moveError.message : String(moveError));
    } finally {
      setBusy(false);
    }
  };

  // 移动目标包含所有卷和所有章，不只是已有笔记的那些分组。
  const moveTargets = useMemo<Group[]>(() => {
    const output: Group[] = [{
      key: "project", label: "整书", scope: "project", volumeId: null, chapterId: null, notes: [],
    }];
    for (const volume of volumes) {
      output.push({
        key: `volume:${volume.id}`, label: volume.title, scope: "volume",
        volumeId: volume.id, chapterId: null, notes: [],
      });
      for (const chapter of chapters.filter((item) => item.volumeId === volume.id)) {
        output.push({
          key: `chapter:${chapter.id}`, label: `　${chapter.title}`, scope: "chapter",
          volumeId: volume.id, chapterId: chapter.id, notes: [],
        });
      }
    }
    return output;
  }, [volumes, chapters]);

  if (!projectId) {
    return (
      <Screen>
        <Header title="笔记" onBack={() => navigation.goBack()} />
        <EmptyState title="请先从书架打开一部作品" />
      </Screen>
    );
  }

  if (loading) {
    return (
      <Screen>
        <Header title="笔记" onBack={() => navigation.goBack()} />
        <View style={styles.loading}><ActivityIndicator color={colors.primary} /></View>
      </Screen>
    );
  }

  return (
    <Screen>
      <Header title="笔记" onBack={() => navigation.goBack()} />
      {error ? <View style={styles.errorWrap}><ErrorNotice message={error} onRetry={() => void load()} /></View> : null}
      <FlatList
        data={groups}
        keyExtractor={(item) => item.key}
        contentContainerStyle={styles.list}
        ListHeaderComponent={(
          <View style={styles.intro}>
            <View style={styles.introRow}>
            <View style={styles.introIcon}><Ionicons name="reader-outline" size={24} color={colors.primary} /></View>
            <View style={styles.introCopy}>
              <Text style={styles.introTitle}>大纲与剧情规划</Text>
              <Text style={styles.introText}>
                笔记按整书、卷、章三级归属，共 {totalNotes} 条。还没在正文里发生的内容放这里，
                不要写进世界书——世界书会被当成已经成立的设定。
              </Text>
            </View>
            </View>
            <View style={styles.categoryBar}>
              {[{ id: null as string | null, title: "全部" }, { id: "", title: "未分类" }].map((option) => (
                <Pressable key={option.title} onPress={() => setFilterCategoryId(option.id)} style={[styles.categoryChip, filterCategoryId === option.id && styles.categoryChipActive]}>
                  <Text style={[styles.categoryChipText, filterCategoryId === option.id && styles.categoryChipTextActive]}>{option.title}</Text>
                </Pressable>
              ))}
              {categories.map((category) => (
                <Pressable
                  key={category.id}
                  onPress={() => setFilterCategoryId(category.id)}
                  onLongPress={() => manageCategory(category)}
                  style={[styles.categoryChip, filterCategoryId === category.id && styles.categoryChipActive]}
                >
                  <Text style={[styles.categoryChipText, filterCategoryId === category.id && styles.categoryChipTextActive]} numberOfLines={1}>{category.title}</Text>
                </Pressable>
              ))}
              <Pressable
                accessibilityLabel="新建笔记分类"
                onPress={() => {
                  setCategoryTitle("");
                  setCategoryDialog({ target: null });
                }}
                style={styles.categoryChip}
              >
                <Ionicons name="add" size={16} color={colors.primary} />
              </Pressable>
            </View>
            {categories.length ? <Text style={styles.categoryHint}>长按分类可以重命名或删除。</Text> : null}
          </View>
        )}
        renderItem={({ item }) => (
          <View style={styles.group}>
            <View style={styles.groupHeader}>
              <Text style={styles.groupLabel} numberOfLines={1}>{item.label}</Text>
              <Text style={styles.groupScope}>{SCOPE_LABEL[item.scope]}</Text>
              <Pressable accessibilityLabel={`在${item.label}新建笔记`} onPress={() => openCreate(item)} style={styles.groupAdd}>
                <Ionicons name="add" size={20} color={colors.primary} />
              </Pressable>
            </View>
            {item.notes.length ? item.notes.map((note) => (
              <Pressable key={note.id} onPress={() => openEdit(note)} style={({ pressed }) => [styles.noteRow, pressed && styles.noteRowPressed]}>
                <View style={styles.noteCopy}>
                  <Text style={styles.noteTitle} numberOfLines={1}>{note.title}</Text>
                  <Text style={styles.noteMeta} numberOfLines={2}>
                    {note.content.trim().slice(0, 90).replace(/\s+/g, " ") || "（空笔记）"}
                  </Text>
                </View>
                <Pressable accessibilityLabel="移动笔记" onPress={() => setMovingNote(note)} style={styles.noteAction}>
                  <Ionicons name="swap-vertical-outline" size={18} color={colors.textMuted} />
                </Pressable>
              </Pressable>
            )) : <Text style={styles.groupEmpty}>还没有笔记</Text>}
          </View>
        )}
      />

      <Modal visible={Boolean(editing || creatingIn)} transparent animationType="slide" onRequestClose={closeEditor}>
        <SheetBackdrop onPress={closeEditor}>
          <View style={styles.sheet}>
            <View style={styles.sheetHeader}>
              <View style={styles.sheetTitleWrap}>
                <Text style={styles.sheetTitle}>{editing ? "编辑笔记" : "新建笔记"}</Text>
                <Text style={styles.sheetMeta}>
                  {editing
                    ? SCOPE_LABEL[noteScope(editing)]
                    : `${SCOPE_LABEL[creatingIn?.scope ?? "project"]} · ${creatingIn?.label.trim()}`}
                </Text>
              </View>
              <Pressable accessibilityLabel="关闭" onPress={closeEditor} style={styles.iconButton}>
                <Ionicons name="close" size={24} color={colors.textMuted} />
              </Pressable>
            </View>
            <ScrollView style={styles.sheetScroll} contentContainerStyle={styles.sheetContent} keyboardShouldPersistTaps="handled">
              <Field label="标题" value={title} onChangeText={setTitle} autoFocus={!editing} maxLength={200} />
              <Field label="内容" value={content} onChangeText={setContent} multiline style={styles.contentInput} maxLength={100000} />
              {categories.length ? (
                <View style={styles.categoryBar}>
                  <Pressable onPress={() => setNoteCategoryId(null)} style={[styles.categoryChip, !noteCategoryId && styles.categoryChipActive]}>
                    <Text style={[styles.categoryChipText, !noteCategoryId && styles.categoryChipTextActive]}>未分类</Text>
                  </Pressable>
                  {categories.map((category) => (
                    <Pressable key={category.id} onPress={() => setNoteCategoryId(category.id)} style={[styles.categoryChip, noteCategoryId === category.id && styles.categoryChipActive]}>
                      <Text style={[styles.categoryChipText, noteCategoryId === category.id && styles.categoryChipTextActive]} numberOfLines={1}>{category.title}</Text>
                    </Pressable>
                  ))}
                </View>
              ) : null}
              <View style={styles.inlineActions}>
                <Button label="保存" onPress={() => void save()} disabled={busy || !title.trim()} loading={busy} />
                {editing ? (
                  <Pressable accessibilityLabel="删除笔记" onPress={() => confirmDelete(editing)} style={styles.secondaryIconAction}>
                    <Ionicons name="trash-outline" size={21} color={colors.danger} />
                  </Pressable>
                ) : null}
              </View>
            </ScrollView>
          </View>
        </SheetBackdrop>
      </Modal>

      <Modal visible={Boolean(movingNote)} transparent animationType="slide" onRequestClose={() => setMovingNote(null)}>
        <SheetBackdrop onPress={() => setMovingNote(null)}>
          <View style={styles.sheet}>
            <View style={styles.sheetHeader}>
              <View style={styles.sheetTitleWrap}>
                <Text style={styles.sheetTitle} numberOfLines={1}>移动“{movingNote?.title}”</Text>
                <Text style={styles.sheetMeta}>选择新的归属层级</Text>
              </View>
              <Pressable accessibilityLabel="关闭" onPress={() => setMovingNote(null)} style={styles.iconButton}>
                <Ionicons name="close" size={24} color={colors.textMuted} />
              </Pressable>
            </View>
            <ScrollView style={styles.sheetScroll} contentContainerStyle={styles.sheetContent}>
              {moveTargets.map((target) => {
                const current = movingNote
                  && (movingNote.chapterId ?? movingNote.volumeId ?? null) === (target.chapterId ?? target.volumeId ?? null);
                return (
                  <Pressable
                    key={target.key}
                    disabled={busy || Boolean(current)}
                    onPress={() => void applyMove(target)}
                    style={[styles.targetRow, current && styles.targetRowCurrent]}
                  >
                    <Text style={styles.targetScope}>{SCOPE_LABEL[target.scope]}</Text>
                    <Text style={styles.targetLabel} numberOfLines={1}>{target.label.trim()}</Text>
                    {current ? <Text style={styles.targetCurrentText}>当前</Text> : null}
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        </SheetBackdrop>
      </Modal>

      <Modal visible={categoryDialog !== null} transparent animationType="fade" onRequestClose={() => setCategoryDialog(null)}>
        <KeyboardAvoidingView style={styles.dialogBackdrop} behavior="height" automaticOffset>
          <View style={styles.dialogBody}>
            <Text style={styles.sheetTitle}>{categoryDialog?.target ? "重命名分类" : "新建笔记分类"}</Text>
            <Field label="分类名称" value={categoryTitle} onChangeText={setCategoryTitle} autoFocus maxLength={60} placeholder="大纲、伏笔、设定草稿…" />
            <View style={styles.dialogActions}>
              <Button label="取消" variant="secondary" onPress={() => setCategoryDialog(null)} />
              <Button label="保存" onPress={() => void submitCategory()} disabled={busy || !categoryTitle.trim()} loading={busy} />
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </Screen>
  );
}

const styles = themedStyles((colors) => StyleSheet.create({
  loading: { flex: 1, alignItems: "center", justifyContent: "center" },
  errorWrap: { padding: spacing.lg, paddingBottom: 0 },
  list: { padding: spacing.lg, paddingBottom: spacing.xxl },
  intro: { gap: spacing.md, paddingBottom: spacing.lg },
  introRow: { flexDirection: "row", gap: spacing.md },
  categoryBar: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  categoryChip: { maxWidth: "100%", minHeight: 34, justifyContent: "center", paddingHorizontal: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md },
  categoryChipActive: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  categoryChipText: { color: colors.textMuted, fontSize: 13 },
  categoryChipTextActive: { color: colors.primary, fontWeight: "700" },
  categoryHint: { color: colors.textMuted, fontSize: 12 },
  dialogBackdrop: { flex: 1, justifyContent: "center", padding: spacing.lg, backgroundColor: colors.overlay },
  dialogBody: { gap: spacing.lg, padding: spacing.xl, borderRadius: radius.md, backgroundColor: colors.background },
  dialogActions: { flexDirection: "row", justifyContent: "flex-end", gap: spacing.sm },
  introIcon: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.sm, backgroundColor: colors.primarySoft },
  introCopy: { flex: 1, gap: spacing.xs },
  introTitle: { color: colors.text, fontSize: 17, fontWeight: "700" },
  introText: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
  group: { marginBottom: spacing.lg },
  groupHeader: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  groupLabel: { flex: 1, minWidth: 0, color: colors.text, fontSize: 15, fontWeight: "700" },
  groupScope: { color: colors.textMuted, fontSize: 12 },
  groupAdd: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  groupEmpty: { color: colors.textMuted, fontSize: 13, paddingVertical: spacing.md },
  noteRow: { minHeight: 64, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  noteRowPressed: { backgroundColor: colors.surfaceMuted },
  noteCopy: { flex: 1, minWidth: 0, gap: 3 },
  noteTitle: { color: colors.text, fontSize: 15, fontWeight: "600" },
  noteMeta: { color: colors.textMuted, fontSize: 12, lineHeight: 17 },
  noteAction: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  sheet: { maxHeight: "88%", borderTopLeftRadius: radius.md, borderTopRightRadius: radius.md, backgroundColor: colors.background },
  sheetScroll: { flexShrink: 1 },
  sheetHeader: { minHeight: 70, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingLeft: spacing.lg, paddingRight: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  sheetTitleWrap: { flex: 1, minWidth: 0 },
  sheetTitle: { color: colors.text, fontSize: 19, fontWeight: "700" },
  sheetMeta: { marginTop: 3, color: colors.textMuted, fontSize: 12 },
  sheetContent: { gap: spacing.lg, padding: spacing.lg, paddingBottom: spacing.xxl },
  contentInput: { minHeight: 260 },
  inlineActions: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  secondaryIconAction: { width: 46, height: 46, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, backgroundColor: colors.surface },
  targetRow: { minHeight: 52, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, backgroundColor: colors.surface },
  targetRowCurrent: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  targetScope: { minWidth: 32, color: colors.textMuted, fontSize: 12 },
  targetLabel: { flex: 1, minWidth: 0, color: colors.text, fontSize: 14 },
  targetCurrentText: { color: colors.primary, fontSize: 12, fontWeight: "700" },
}));
