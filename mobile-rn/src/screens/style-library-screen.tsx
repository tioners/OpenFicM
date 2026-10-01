import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

import { Button, EmptyState, ErrorNotice, Field, Header, Screen, SheetBackdrop } from "@/components/ui";
import {
  createAuthorStyleProfileVersion,
  deleteStyleProfile,
  getActiveStyleProfile,
  listStyleProfiles,
  listStyleProfilesForSource,
  listStyleSources,
  renameStyleSource,
  setActiveStyleProfile,
} from "@/data/style-repositories";
import { styleProfileLabel } from "@/lib/style-label";
import { resolveModelSelection } from "@/llm/selection";
import type { RootStackParamList } from "@/navigation/types";
import {
  getStyleDistillationCheckpoint,
  getStyleDistillationCoverage,
  type StyleDistillationCheckpoint,
  type StyleDistillationCoverage,
} from "@/settings/lorn-style-plugin";
import { importStyleSource, deleteStyleSource } from "@/style/source-library";
import { useStyleDistillationStore } from "@/style/distillation-store";
import { cancelStyleDistillation, startStyleDistillation } from "@/style/distillation-runner";
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
  const [distillationError, setDistillationError] = useState<string | null>(null);
  const [distillationCheckpoint, setDistillationCheckpoint] = useState<StyleDistillationCheckpoint | null>(null);
  const [distillationCoverage, setDistillationCoverage] = useState<StyleDistillationCoverage | null>(null);
  const [distillationModelName, setDistillationModelName] = useState<string | null>(null);
  const [sourceTitle, setSourceTitle] = useState("");
  const [editingSource, setEditingSource] = useState(false);
  const [editingAuthorGuide, setEditingAuthorGuide] = useState(false);
  const [authorGuide, setAuthorGuide] = useState("");
  // 蒸馏任务活在 store 里：离开本页也继续跑，回来后横幅和弹层仍能看到实时进度。
  const runningTask = useStyleDistillationStore((state) => state.task);
  const distillationOutcome = useStyleDistillationStore((state) => state.outcome);
  const distillationRevision = useStyleDistillationStore((state) => state.revision);
  const dismissOutcome = useStyleDistillationStore((state) => state.dismissOutcome);
  const selectedSourceRef = useRef<StyleSource | null>(null);

  const authorProfiles = useMemo(
    () => profiles.filter((profile) => profile.kind === "author"),
    [profiles],
  );
  const referenceProfiles = useMemo(
    () => profiles.filter((profile) => profile.kind === "reference"),
    [profiles],
  );
  const coverageStarted = Boolean(distillationCoverage && distillationCoverage.coveredUntil > 0);
  const coverageFinished = Boolean(distillationCoverage
    && distillationCoverage.coveredUntil >= distillationCoverage.totalUnits);
  const coverageUnitName = distillationCoverage?.unitKind === "segment" ? "段" : "章";
  const taskForSelectedSource = runningTask && selectedSource && runningTask.sourceId === selectedSource.id
    ? runningTask
    : null;
  const outcomeUnitName = distillationOutcome?.unitKind === "segment" ? "段" : "章";

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
      // 蒸馏跟随全局默认模型，界面上要说清楚是哪一个。
      setDistillationModelName(await resolveModelSelection()
        .then((selection) => selection.model.name)
        .catch(() => null));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useFocusEffect(useCallback(() => {
    void load();
  }, [load]));

  const loadSourceDetail = useCallback(async (source: StyleSource) => {
    try {
      const [nextProfiles, checkpoint, coverage] = await Promise.all([
        listStyleProfilesForSource(source.id),
        getStyleDistillationCheckpoint(source.id),
        getStyleDistillationCoverage(source.id),
      ]);
      setSourceProfiles(nextProfiles);
      setDistillationCheckpoint(checkpoint);
      setDistillationCoverage(coverage?.contentHash === source.contentHash ? coverage : null);
    } catch (sourceError) {
      setError(sourceError instanceof Error ? sourceError.message : String(sourceError));
      setSourceProfiles([]);
    }
  }, []);

  useEffect(() => {
    selectedSourceRef.current = selectedSource;
  }, [selectedSource]);

  // 后台蒸馏结束时自增 revision：刷新书库列表，弹层开着就同时刷新这份参考书的详情。
  useEffect(() => {
    if (!distillationRevision) return;
    void load();
    const source = selectedSourceRef.current;
    if (source) void loadSourceDetail(source);
  }, [distillationRevision, load, loadSourceDetail]);

  const openSource = async (source: StyleSource) => {
    setSelectedSource(source);
    selectedSourceRef.current = source;
    setEditingSource(false);
    setSourceTitle(source.title);
    setError(null);
    setDistillationError(null);
    await loadSourceDetail(source);
  };

  const closeSource = () => {
    setSelectedSource(null);
    selectedSourceRef.current = null;
    setSourceProfiles([]);
    setEditingSource(false);
    setDistillationError(null);
    setDistillationCheckpoint(null);
    setDistillationCoverage(null);
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

  const distill = async (restart = false) => {
    if (!selectedSource) return;
    setError(null);
    setDistillationError(null);
    const started = await startStyleDistillation({
      sourceId: selectedSource.id,
      sourceTitle: selectedSource.title,
      restart,
    });
    if (!started.started && started.message) {
      setError(started.message);
      setDistillationError(started.message);
    }
  };

  const confirmRestart = () => {
    if (!selectedSource) return;
    Alert.alert(
      "重新开始蒸馏",
      "会清空已覆盖的进度，从全书开头重新扫描；新结果直接替换《" + selectedSource.title + "》现有的参考文风，旧内容不会保留。",
      [
        { text: "取消", style: "cancel" },
        { text: "重新开始", style: "destructive", onPress: () => void distill(true) },
      ],
    );
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
      "确定删除《" + selectedSource.title + "》及其参考文风？原文件只保存在本机。",
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
      const profile = await createAuthorStyleProfileVersion({
        projectId,
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
    Alert.alert("删除文风", "确定删除“" + styleProfileLabel(profile) + "”？", [
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
            {runningTask ? (
              <View style={styles.taskBanner}>
                <ActivityIndicator size="small" color={colors.primary} />
                <View style={styles.taskBannerCopy}>
                  <Text style={styles.taskBannerTitle}>正在蒸馏《{runningTask.sourceTitle}》</Text>
                  <Text style={styles.taskBannerText} numberOfLines={2}>
                    {runningTask.label}；可以离开这一页做别的事，任务会继续跑。
                  </Text>
                </View>
                <Pressable accessibilityLabel="取消蒸馏" onPress={() => cancelStyleDistillation()} style={styles.taskBannerAction}>
                  <Text style={styles.taskBannerActionText}>取消</Text>
                </Pressable>
              </View>
            ) : distillationOutcome ? (
              <View style={styles.taskBanner}>
                <Ionicons
                  name={distillationOutcome.error ? "alert-circle-outline" : distillationOutcome.cancelled ? "pause-circle-outline" : "checkmark-circle-outline"}
                  size={19}
                  color={distillationOutcome.error ? colors.danger : colors.primary}
                />
                <View style={styles.taskBannerCopy}>
                  <Text style={styles.taskBannerTitle} numberOfLines={1}>
                    {distillationOutcome.error ? "蒸馏失败" : distillationOutcome.cancelled ? "已取消蒸馏" : "蒸馏完成"}《{distillationOutcome.sourceTitle}》
                  </Text>
                  <Text style={styles.taskBannerText} numberOfLines={3}>
                    {distillationOutcome.error
                      ?? (distillationOutcome.cancelled
                        ? `已完成的部分保留在断点里，已覆盖到第 ${distillationOutcome.coveredUntil}/${distillationOutcome.totalUnits} ${outcomeUnitName}；再次点击“继续蒸馏”会从断点接着跑。`
                        : `第 ${distillationOutcome.round} 轮，覆盖到第 ${distillationOutcome.coveredUntil}/${distillationOutcome.totalUnits} ${outcomeUnitName}${distillationOutcome.reachedEnd ? "（全书已覆盖）" : ""}。`)}
                  </Text>
                </View>
                <Pressable accessibilityLabel="关闭蒸馏结果提示" onPress={dismissOutcome} style={styles.taskBannerAction}>
                  <Text style={styles.taskBannerActionText}>关闭</Text>
                </Pressable>
              </View>
            ) : null}
            {projectId ? (
              <View style={styles.activeStrip}>
                <Ionicons name="checkmark-circle-outline" size={19} color={colors.primary} />
                <Text style={styles.activeStripText} numberOfLines={2}>
                  当前使用：{activeProfile ? styleProfileLabel(activeProfile) : "不使用文风"}
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
        <SheetBackdrop onPress={closeSource}>
          <View style={styles.sheet}>
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
            <ScrollView style={styles.sheetScroll} contentContainerStyle={styles.sheetContent} keyboardShouldPersistTaps="handled">
              {editingSource ? (
                <View style={styles.inlineActions}>
                  <Button label="取消" variant="secondary" onPress={() => setEditingSource(false)} />
                  <Button label="保存名称" onPress={() => void saveSourceTitle()} disabled={!sourceTitle.trim()} loading={busy} />
                </View>
              ) : (
                <View style={styles.inlineActions}>
                  <Button
                    label={taskForSelectedSource ? "后台蒸馏中" : coverageStarted ? "继续蒸馏" : "蒸馏文风"}
                    onPress={() => void distill()}
                    disabled={busy || coverageFinished || Boolean(runningTask)}
                    loading={Boolean(taskForSelectedSource)}
                  />
                  {taskForSelectedSource ? (
                    <Button label="取消蒸馏" variant="secondary" onPress={() => cancelStyleDistillation()} />
                  ) : null}
                  {coverageStarted || distillationCheckpoint ? (
                    <Button label="重新开始" variant="secondary" onPress={confirmRestart} disabled={busy || Boolean(runningTask)} />
                  ) : null}
                  <Pressable accessibilityLabel="重命名参考书" onPress={() => setEditingSource(true)} style={styles.secondaryIconAction}>
                    <Ionicons name="create-outline" size={21} color={colors.text} />
                  </Pressable>
                  <Pressable accessibilityLabel="删除参考书" onPress={confirmDeleteSource} style={styles.secondaryIconAction}>
                    <Ionicons name="trash-outline" size={21} color={colors.danger} />
                  </Pressable>
                </View>
              )}
              {distillationError ? <ErrorNotice message={distillationError} onRetry={() => void distill()} /> : null}
              {runningTask && !taskForSelectedSource ? (
                <View style={styles.checkpointBox}>
                  <Text style={styles.checkpointTitle}>正在蒸馏《{runningTask.sourceTitle}》</Text>
                  <Text style={styles.checkpointText}>
                    同一时间只跑一个蒸馏任务；等它完成或到横幅上取消后，再开始这本书。
                  </Text>
                </View>
              ) : null}
              {distillationCoverage ? (
                <View style={styles.checkpointBox}>
                  <Text style={styles.checkpointTitle}>
                    {coverageFinished ? "已覆盖全书" : `已完成 ${distillationCoverage.rounds} 轮蒸馏`}
                  </Text>
                  <Text style={styles.checkpointText}>
                    覆盖到第 {distillationCoverage.coveredUntil}/{distillationCoverage.totalUnits} {coverageUnitName}。
                    {coverageFinished
                      ? "继续积累样本请点击“重新开始”重新扫描全书，这会用新结果替换当前参考文风。"
                      : "点击“继续蒸馏”会向后随机跳到未读区域，再取一段连续样本并入同一份参考文风。"}
                  </Text>
                </View>
              ) : null}
              {distillationCheckpoint ? (
                <View style={styles.checkpointBox}>
                  <Text style={styles.checkpointTitle}>检测到未完成的蒸馏任务</Text>
                  <Text style={styles.checkpointText}>
                    第 {distillationCheckpoint.windowStart + 1}-{distillationCheckpoint.windowStart + distillationCheckpoint.windowCount} {coverageUnitName}已完成 {Math.min(distillationCheckpoint.completedMemos.length, distillationCheckpoint.batchCount)}/{distillationCheckpoint.batchCount} 批。继续蒸馏会从断点接着跑，不会重复已完成批次。
                  </Text>
                </View>
              ) : null}
              {taskForSelectedSource ? (
                <View style={styles.checkpointBox}>
                  <Text style={styles.checkpointTitle}>蒸馏进行中：{taskForSelectedSource.label}</Text>
                  <Text style={styles.checkpointText}>
                    可以关掉这个窗口或离开文风书库，任务会在后台继续，跑完在这里提示结果。
                  </Text>
                </View>
              ) : (
                <Text style={styles.helperText}>每轮抽取连续 24 {coverageUnitName}、分 4 批分析后并入参考文风，不会上传整本小说。反复点击“继续蒸馏”会向后随机推进，逐步覆盖全书；每本书始终只有一份参考文风。</Text>
              )}
              <Text style={styles.helperText}>
                蒸馏使用“设置 → 模型与供应商”里的默认模型：{distillationModelName ?? "尚未选择默认模型"}
              </Text>
              <Text style={styles.sectionTitle}>参考文风</Text>
              {sourceProfiles.length ? sourceProfiles.map((profile) => (
                <ProfileRow
                  key={profile.id}
                  profile={profile}
                  active={activeProfile?.id === profile.id}
                  onPress={() => openProfile(profile)}
                  onActivate={() => void activate(profile)}
                  disabled={busy || !projectId}
                />
              )) : <Text style={styles.emptyHint}>还没有参考文风，点击“蒸馏文风”生成。</Text>}
            </ScrollView>
          </View>
        </SheetBackdrop>
      </Modal>

      <Modal visible={Boolean(selectedProfile)} transparent animationType="slide" onRequestClose={() => setSelectedProfile(null)}>
        <SheetBackdrop onPress={() => setSelectedProfile(null)}>
          <View style={styles.sheet}>
            <View style={styles.sheetHeader}>
              <View style={styles.sheetTitleWrap}>
                <Text style={styles.sheetTitle} numberOfLines={2}>{selectedProfile ? styleProfileLabel(selectedProfile) : ""}</Text>
                <Text style={styles.sheetMeta}>{selectedProfile?.kind === "author" ? "作者文风版本" : "参考小说文风"}</Text>
              </View>
              <Pressable accessibilityLabel="关闭文风详情" onPress={() => setSelectedProfile(null)} style={styles.iconButton}>
                <Ionicons name="close" size={24} color={colors.textMuted} />
              </Pressable>
            </View>
            <ScrollView style={styles.sheetScroll} contentContainerStyle={styles.profileContent}>
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
        </SheetBackdrop>
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
          <Text style={styles.profileName} numberOfLines={1}>{styleProfileLabel(profile)}</Text>
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
  taskBanner: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginBottom: spacing.md, padding: spacing.md, borderWidth: 1, borderColor: colors.primary, borderRadius: radius.sm, backgroundColor: "#E6F3EF" },
  taskBannerCopy: { flex: 1, minWidth: 0, gap: 3 },
  taskBannerTitle: { color: colors.primary, fontSize: 13, fontWeight: "700" },
  taskBannerText: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
  taskBannerAction: { minWidth: 52, minHeight: 44, alignItems: "center", justifyContent: "center" },
  taskBannerActionText: { color: colors.primary, fontSize: 13, fontWeight: "700" },
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
  sheet: { maxHeight: "88%", borderTopLeftRadius: radius.md, borderTopRightRadius: radius.md, backgroundColor: colors.background },
  // 父层只有 maxHeight，ScrollView 默认不收缩会把超出部分顶出可视区且滚不动，必须允许它收缩。
  sheetScroll: { flexShrink: 1 },
  sheetHeader: { minHeight: 70, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingLeft: spacing.lg, paddingRight: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  sheetTitleWrap: { flex: 1, minWidth: 0 },
  sheetTitle: { color: colors.text, fontSize: 19, fontWeight: "700" },
  sheetMeta: { marginTop: 3, color: colors.textMuted, fontSize: 12 },
  sheetContent: { padding: spacing.lg, paddingBottom: spacing.xxl },
  profileContent: { gap: spacing.lg, padding: spacing.lg, paddingBottom: spacing.xxl },
  inlineActions: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: spacing.sm },
  secondaryIconAction: { width: 46, height: 46, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, backgroundColor: colors.surface },
  helperText: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
  checkpointBox: { gap: spacing.xs, padding: spacing.md, borderWidth: 1, borderColor: colors.primary, borderRadius: radius.sm, backgroundColor: "#E6F3EF" },
  checkpointTitle: { color: colors.primary, fontSize: 13, fontWeight: "700" },
  checkpointText: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
  emptyHint: { color: colors.textMuted, fontSize: 14, lineHeight: 20, paddingVertical: spacing.md },
  guideText: { color: colors.text, fontSize: 14, lineHeight: 22 },
  guideInput: { minHeight: 300 },
});
