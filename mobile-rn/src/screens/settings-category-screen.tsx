import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";

import { Button, ErrorNotice, Field, Header, Screen } from "@/components/ui";
import {
  getSetting,
  listModels,
  setSetting,
} from "@/data/repositories";
import { createId } from "@/lib/id";
import { exportBackup, importBackup } from "@/lib/backup";
import { isDistilling } from "@/style/distillation-store";
import { useAppStore } from "@/store/app-store";
import {
  DEFAULT_INDEX_SETTINGS,
  getAgentDefinitions,
  getAgentRules,
  getAgentSkills,
  getIndexSettings,
  getToolPermissions,
  saveAgentDefinitions,
  saveAgentRules,
  saveAgentSkills,
  saveIndexSettings,
  saveToolPermissions,
  TOOL_CATALOG,
  type AgentDefinition,
  type AgentRule,
  type AgentSkill,
  type IndexSettings,
  type ToolPermissionMode,
} from "@/settings/config";
import { clearProjectIndex, getProjectIndexStats, indexProject } from "@/search/indexer";
import { getLocalModelStatus, warmUpLocalModels } from "@/search/local-models";
import {
  getRuntimeResourceState,
  installMissingRuntimeResources,
  LOCAL_MODEL_INFO,
  type RuntimeResourceState,
} from "@/settings/remote-resources";
import {
  checkOhStoryRelease,
  compareOhStoryVersions,
  getOhStoryUpdateState,
  installOhStoryRelease,
  isOhStoryPackageComplete,
  OH_STORY_AGENT_COUNT,
  OH_STORY_SKILL_COUNT,
  rollbackOhStoryPackage,
  type OhStoryRelease,
  type OhStoryUpdateState,
} from "@/settings/oh-story-updater";
import {
  checkAppUpdate,
  getLastAppUpdateCheck,
  CURRENT_APP_VERSION,
  type AppUpdateInfo,
} from "@/settings/app-update";
import { colors, getThemeMode, radius, setThemeMode, spacing, type ThemeMode } from "@/theme";
import {
  DEFAULT_CONTEXT_TOKEN_LIMIT,
  DEFAULT_HISTORY_LIMIT,
  MAX_CONTEXT_TOKEN_LIMIT,
  MAX_HISTORY_LIMIT,
  MIN_CONTEXT_TOKEN_LIMIT,
  MIN_HISTORY_LIMIT,
  parseContextTokenLimit,
  resolveContextPolicy,
  type ContextLimitMode,
  type ContextOverflowMode,
} from "@/agent/context-budget";
import { themedStyles } from "@/themed-styles";
import type { Model } from "@/types";

export type SettingsCategory =
  | "general"
  | "connections"
  | "models"
  | "web"
  | "index"
  | "context"
  | "style"
  | "agent-tools"
  | "rules"
  | "skills"
  | "agents"
  | "advanced";

type CategoryScreenKey = Exclude<SettingsCategory, "models" | "web">;

const TITLES: Record<CategoryScreenKey, string> = {
  general: "通用",
  connections: "连接",
  index: "索引",
  context: "上下文",
  style: "作者文风",
  "agent-tools": "工具权限",
  rules: "规则",
  skills: "技能",
  agents: "智能体",
  advanced: "高级",
};

const EMPTY_OH_STORY_STATE: OhStoryUpdateState = { installed: null, previous: null, lastCheck: null };

const TOOL_GROUP_ORDER = ["章节与卷", "角色", "角色关系", "世界书", "笔记", "文风", "联网", "附件", "技能", "对话与协作"];

/** 工具权限页的分组标题。 */
function toolGroup(key: string): string {
  if (/^web_/.test(key)) return "联网";
  if (/_file$/.test(key)) return "附件";
  if (/skill/.test(key)) return "技能";
  if (/style|author/.test(key)) return "文风";
  if (/relationship/.test(key)) return "角色关系";
  if (/character/.test(key)) return "角色";
  if (/world/.test(key)) return "世界书";
  if (/note/.test(key)) return "笔记";
  if (/chapter|volume|knowledge/.test(key)) return "章节与卷";
  return "对话与协作";
}

const SORTED_TOOLS = [...TOOL_CATALOG].sort(
  (left, right) => TOOL_GROUP_ORDER.indexOf(toolGroup(left.key)) - TOOL_GROUP_ORDER.indexOf(toolGroup(right.key)),
);

function SettingRow({ label, value, onPress, destructive = false }: {
  label: string;
  value?: string;
  onPress?: () => void;
  destructive?: boolean;
}) {
  return (
    <Pressable disabled={!onPress} onPress={onPress} style={styles.settingRow}>
      <Text style={[styles.settingLabel, destructive && styles.dangerText]}>{label}</Text>
      {value ? <Text numberOfLines={2} style={styles.settingValue}>{value}</Text> : null}
      {onPress ? <Ionicons name="chevron-forward" size={18} color={colors.textMuted} /> : null}
    </Pressable>
  );
}

function ToggleRow({ label, value, onChange }: { label: string; value: boolean; onChange: (value: boolean) => void }) {
  return (
    <View style={styles.settingRow}>
      <Text style={styles.settingLabel}>{label}</Text>
      <Switch value={value} onValueChange={onChange} trackColor={{ false: colors.border, true: colors.primary }} />
    </View>
  );
}

function OptionRow<T extends string>({ options, value, onChange }: {
  options: Array<[T, string]>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <View style={styles.optionRow}>
      {options.map(([option, label]) => (
        <Pressable
          key={option}
          accessibilityRole="button"
          accessibilityState={{ selected: value === option }}
          onPress={() => onChange(option)}
          style={[styles.option, value === option && styles.optionActive]}
        >
          <Text style={[styles.optionText, value === option && styles.optionTextActive]}>{label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export function SettingsCategoryScreen({ category, onBack }: { category: CategoryScreenKey; onBack: () => void }) {
  const projectId = useAppStore((state) => state.currentProjectId);
  const refreshData = useAppStore((state) => state.refreshData);
  const setCurrentProject = useAppStore((state) => state.setCurrentProject);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [skillManagement, setSkillManagement] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [indexSettings, setIndexSettings] = useState<IndexSettings>(DEFAULT_INDEX_SETTINGS);
  const [indexStats, setIndexStats] = useState({ sources: 0, chunks: 0 });
  const [indexProgress, setIndexProgress] = useState("");
  const [rules, setRules] = useState<AgentRule[]>([]);
  const [skills, setSkills] = useState<AgentSkill[]>([]);
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [availableModels, setAvailableModels] = useState<Model[]>([]);
  const [permissions, setPermissions] = useState<Record<string, ToolPermissionMode>>({});
  const [activeAgentId, setActiveAgentId] = useState("");
  const [ruleName, setRuleName] = useState("");
  const [ruleContent, setRuleContent] = useState("");
  const [skillName, setSkillName] = useState("");
  const [skillDescription, setSkillDescription] = useState("");
  const [skillInstructions, setSkillInstructions] = useState("");
  const [agentName, setAgentName] = useState("");
  const [agentDescription, setAgentDescription] = useState("");
  const [agentPrompt, setAgentPrompt] = useState("");
  const [agentModelId, setAgentModelId] = useState("");
  const [historyLimit, setHistoryLimit] = useState(String(DEFAULT_HISTORY_LIMIT));
  const [contextLimitMode, setContextLimitMode] = useState<ContextLimitMode>("count");
  const [contextTokenLimit, setContextTokenLimit] = useState(String(DEFAULT_CONTEXT_TOKEN_LIMIT));
  const [contextOverflow, setContextOverflow] = useState<ContextOverflowMode>("drop");
  const [compression, setCompression] = useState(false);
  const [pruneToolOutputs, setPruneToolOutputs] = useState(true);
  const [autoSaveDelay, setAutoSaveDelay] = useState("1000");
  const [editorFontSize, setEditorFontSize] = useState("17");
  const [themeMode, setThemeModeState] = useState<ThemeMode>(() => getThemeMode());
  const [requestTimeout, setRequestTimeout] = useState("120000");
  const [maxAttempts, setMaxAttempts] = useState("3");
  const [maxServerErrorAttempts, setMaxServerErrorAttempts] = useState("2");
  const [maxRateLimitAttempts, setMaxRateLimitAttempts] = useState("3");
  const [retryOnTimeout, setRetryOnTimeout] = useState(false);
  const [streamResponses, setStreamResponses] = useState(true);
  const [ohStoryState, setOhStoryState] = useState<OhStoryUpdateState>(EMPTY_OH_STORY_STATE);
  const [ohStoryProgress, setOhStoryProgress] = useState("");
  const [ohStoryBusy, setOhStoryBusy] = useState(false);
  const [resourceState, setResourceState] = useState<RuntimeResourceState | null>(null);
  const [resourceProgress, setResourceProgress] = useState("");
  const [resourceBusy, setResourceBusy] = useState(false);
  const [appUpdate, setAppUpdate] = useState<AppUpdateInfo | null>(null);
  const [appUpdateBusy, setAppUpdateBusy] = useState(false);
  const [appUpdateError, setAppUpdateError] = useState<string | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);

  const runBackup = async () => {
    setBackupBusy(true);
    setError(null);
    try {
      await exportBackup();
    } catch (backupError) {
      setError(backupError instanceof Error ? backupError.message : String(backupError));
    } finally {
      setBackupBusy(false);
    }
  };

  const runRestore = () => {
    if (isDistilling()) {
      setError("文风蒸馏正在进行，请等它结束或取消后再恢复备份");
      return;
    }
    Alert.alert(
      "从备份恢复",
      "会用备份包覆盖当前全部作品、角色、世界书、笔记、文风和设置，无法撤销。建议先导出一份当前数据的备份。\n\nAPI Key 不在备份里，恢复后需要到“模型与供应商”和“联网搜索”里重新填写。",
      [
        { text: "取消", style: "cancel" },
        {
          text: "选择备份并恢复",
          style: "destructive",
          onPress: () => {
            setRestoreBusy(true);
            setError(null);
            void importBackup({ beforeReplace: () => setCurrentProject(null) })
              .then((restored) => {
                if (!restored) return;
                refreshData();
                Alert.alert(
                  "恢复完成",
                  `已恢复 ${restored.projectCount} 部作品${restored.exportedAt ? `（备份时间 ${new Date(restored.exportedAt).toLocaleString()}）` : ""}。请回到书架重新打开作品，并重新填写 API Key。`,
                );
                void load();
              })
              .catch((restoreError) => setError(restoreError instanceof Error ? restoreError.message : String(restoreError)))
              .finally(() => setRestoreBusy(false));
          },
        },
      ],
    );
  };

  const checkForAppUpdate = async () => {
    setAppUpdateBusy(true);
    setAppUpdateError(null);
    try {
      setAppUpdate(await checkAppUpdate());
    } catch (updateError) {
      setAppUpdateError(updateError instanceof Error ? updateError.message : String(updateError));
    } finally {
      setAppUpdateBusy(false);
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextIndex, nextRules, nextSkills, nextAgents, nextPermissions, active, history, limitMode, tokenLimit, overflow, compress, prune, autoSave, fontSize, timeout, attempts, serverAttempts, rateLimitAttempts, retryOnTimeoutValue, streamValue, nextModels, nextOhStoryState, nextResourceState] = await Promise.all([
        getIndexSettings(),
        getAgentRules(),
        getAgentSkills(),
        getAgentDefinitions(),
        getToolPermissions(),
        getSetting("agent.activeDefinitionId"),
        getSetting("context.historyLimit"),
        getSetting("context.limitMode"),
        getSetting("context.tokenLimit"),
        getSetting("context.overflow"),
        getSetting("context.compressSystemPrompts"),
        getSetting("context.pruneToolOutputs"),
        getSetting("general.autoSaveDelay"),
        getSetting("general.editorFontSize"),
        getSetting("connections.requestTimeout"),
        getSetting("connections.maxAttempts"),
        getSetting("connections.maxServerErrorAttempts"),
        getSetting("connections.maxRateLimitAttempts"),
        getSetting("connections.retryOnTimeout"),
        getSetting("connections.streamResponses"),
        listModels(),
        getOhStoryUpdateState(),
        getRuntimeResourceState(),
      ]);
      setAppUpdate(await getLastAppUpdateCheck());
      setIndexSettings(nextIndex);
      setRules(nextRules);
      setSkills(nextSkills);
      setAgents(nextAgents);
      setPermissions(nextPermissions);
      const activeAgent = nextAgents.find((agent) => agent.id === active && agent.enabled && agent.kind === "primary")
        ?? nextAgents.find((agent) => agent.id === "builtin-agent--build" && agent.enabled)
        ?? nextAgents.find((agent) => agent.enabled && agent.kind === "primary");
      const nextActiveAgentId = activeAgent?.id ?? "";
      setActiveAgentId(nextActiveAgentId);
      if (nextActiveAgentId !== (active ?? "")) await setSetting("agent.activeDefinitionId", nextActiveAgentId);
      const contextPolicy = resolveContextPolicy({ limitMode, historyLimit: history, tokenLimit, overflow });
      setHistoryLimit(history ?? String(DEFAULT_HISTORY_LIMIT));
      setContextLimitMode(contextPolicy.limitMode);
      setContextTokenLimit(String(contextPolicy.tokenLimit));
      setContextOverflow(contextPolicy.overflow);
      setCompression(compress === "true");
      setPruneToolOutputs(prune !== "false");
      setAutoSaveDelay(autoSave ?? "1000");
      setEditorFontSize(fontSize ?? "17");
      setRequestTimeout(timeout ?? "120000");
      setMaxAttempts(attempts ?? "3");
      setMaxServerErrorAttempts(serverAttempts ?? "2");
      setMaxRateLimitAttempts(rateLimitAttempts ?? "3");
      setRetryOnTimeout(retryOnTimeoutValue === "true");
      setSkillManagement((await getSetting("agent.skillManagement")) === "true");
      setStreamResponses(streamValue !== "false");
      setAvailableModels(nextModels);
      setOhStoryState(nextOhStoryState);
      setResourceState(nextResourceState);
      if (projectId) setIndexStats(await getProjectIndexStats(projectId));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useFocusEffect(useCallback(() => {
    void load();
  }, [load]));

  const savePreference = async (key: string, value: string) => {
    setSaving(true);
    setError(null);
    try {
      await setSetting(key, value);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };

  // 非法值不落库：否则界面上显示的是用户填的数，实际却悄悄按默认值生效。
  const saveContextTokenLimit = () => {
    if (parseContextTokenLimit(contextTokenLimit) === null) {
      setError(`上下文 Token 上限必须是 ${MIN_CONTEXT_TOKEN_LIMIT} 到 ${MAX_CONTEXT_TOKEN_LIMIT} 之间的整数`);
      return;
    }
    void savePreference("context.tokenLimit", contextTokenLimit.trim());
  };

  const downloadResources = async () => {
    setResourceBusy(true);
    setError(null);
    setResourceProgress("准备一键拉取运行资源…");
    try {
      const next = await installMissingRuntimeResources((item) => {
        if (item.totalBytes && item.totalBytes > 0 && item.bytesWritten !== undefined) {
          setResourceProgress(`${item.label} · ${Math.min(100, Math.round(item.bytesWritten / item.totalBytes * 100))}%`);
        } else {
          setResourceProgress(item.total > 1 ? `${item.label} · ${item.completed}/${item.total}` : item.label);
        }
      });
      setResourceState(next);
      setResourceProgress("正在预热本地检索模型…");
      await warmUpLocalModels();
      setResourceProgress("全部运行资源已就绪");
    } catch (resourceError) {
      setError(resourceError instanceof Error ? resourceError.message : String(resourceError));
      setResourceState(await getRuntimeResourceState().catch(() => null));
    } finally {
      setResourceBusy(false);
    }
  };

  const saveIndex = async (next: IndexSettings) => {
    setSaving(true);
    setError(null);
    try {
      await saveIndexSettings(next);
      setIndexSettings(await getIndexSettings());
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };

  const rebuildIndex = async () => {
    if (!projectId) {
      setError("请先从书架打开一部作品");
      return;
    }
    setSaving(true);
    setIndexProgress("准备索引…");
    setError(null);
    try {
      await indexProject(projectId, {
        force: true,
        onProgress: ({ completed, total, title }) => setIndexProgress(total ? `${completed}/${total} · ${title}` : title),
      });
      setIndexStats(await getProjectIndexStats(projectId));
      setIndexProgress("索引完成");
    } catch (indexError) {
      setError(indexError instanceof Error ? indexError.message : String(indexError));
    } finally {
      setSaving(false);
    }
  };

  const persistManagedState = async <T,>(
    next: T,
    persist: (value: T) => Promise<void>,
    apply: (value: T) => void,
  ): Promise<boolean> => {
    setError(null);
    try {
      await persist(next);
      apply(next);
      return true;
    } catch (persistError) {
      setError(persistError instanceof Error ? persistError.message : String(persistError));
      return false;
    }
  };

  const addRule = async () => {
    if (!ruleName.trim() || !ruleContent.trim()) return;
    const next = [...rules, { id: createId(), name: ruleName.trim(), content: ruleContent.trim(), enabled: true }];
    if (!await persistManagedState(next, saveAgentRules, setRules)) return;
    setRuleName("");
    setRuleContent("");
  };

  const addSkill = async () => {
    if (!skillName.trim() || !skillInstructions.trim()) return;
    const skill: AgentSkill = {
      id: createId(),
      name: skillName.trim(),
      description: skillDescription.trim(),
      instructions: skillInstructions.trim(),
      enabled: true,
      source: "custom",
    };
    const next = [...skills, skill];
    if (!await persistManagedState(next, saveAgentSkills, setSkills)) return;
    setSkillName("");
    setSkillDescription("");
    setSkillInstructions("");
  };

  const addAgent = async () => {
    if (!agentName.trim() || !agentPrompt.trim()) return;
    const agent: AgentDefinition = {
      id: createId(),
      name: agentName.trim(),
      description: agentDescription.trim(),
      systemPrompt: agentPrompt.trim(),
      modelId: agentModelId,
      enabled: true,
      kind: "primary",
      skillIds: skills.filter((skill) => skill.enabled).map((skill) => skill.id),
      toolNames: TOOL_CATALOG.map((tool) => tool.key),
      delegatableAgentIds: agents.filter((agent) => agent.enabled && agent.kind === "subagent").map((agent) => agent.id),
      source: "custom",
    };
    const next = [...agents, agent];
    if (!await persistManagedState(next, saveAgentDefinitions, setAgents)) return;
    setAgentName("");
    setAgentDescription("");
    setAgentPrompt("");
    setAgentModelId("");
  };

  const cyclePermission = async (key: string) => {
    const current = permissions[key] ?? "ask";
    const nextMode: ToolPermissionMode = current === "allow" ? "ask" : current === "ask" ? "deny" : "allow";
    const next = { ...permissions, [key]: nextMode };
    await persistManagedState(next, saveToolPermissions, setPermissions);
  };

  const selectAgent = async (agent: AgentDefinition) => {
    if (!agent.enabled || agent.kind !== "primary") return;
    try {
      await setSetting("agent.activeDefinitionId", agent.id);
      setActiveAgentId(agent.id);
    } catch (selectError) {
      setError(selectError instanceof Error ? selectError.message : String(selectError));
    }
  };

  const toggleAgent = async (agentId: string, enabled: boolean) => {
    const next = agents.map((agent) => agent.id === agentId ? { ...agent, enabled } : agent);
    try {
      await saveAgentDefinitions(next);
      setAgents(next);
      if (!enabled && activeAgentId === agentId) {
        const fallback = next.find((agent) => agent.enabled && agent.kind === "primary");
        const fallbackId = fallback?.id ?? "";
        await setSetting("agent.activeDefinitionId", fallbackId);
        setActiveAgentId(fallbackId);
      }
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : String(toggleError));
    }
  };

  const removeAgent = async (agentId: string) => {
    const next = agents.filter((agent) => agent.id !== agentId || agent.source === "builtin");
    try {
      await saveAgentDefinitions(next);
      setAgents(next);
      if (activeAgentId === agentId) {
        const fallback = next.find((agent) => agent.enabled && agent.kind === "primary");
        const fallbackId = fallback?.id ?? "";
        await setSetting("agent.activeDefinitionId", fallbackId);
        setActiveAgentId(fallbackId);
      }
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : String(removeError));
    }
  };

  const reloadOhStoryCatalog = async () => {
    const [nextState, nextSkills, nextAgents] = await Promise.all([
      getOhStoryUpdateState(),
      getAgentSkills(),
      getAgentDefinitions(),
    ]);
    setOhStoryState(nextState);
    setSkills(nextSkills);
    setAgents(nextAgents);
    refreshData();
  };

  const checkOhStory = async () => {
    setOhStoryBusy(true);
    setError(null);
    setOhStoryProgress("正在检查 GitHub Release…");
    try {
      const release = await checkOhStoryRelease();
      setOhStoryState((current) => ({ ...current, lastCheck: release }));
      const hasUpdate = !ohStoryState.installed
        || compareOhStoryVersions(release.version, ohStoryState.installed.version) > 0;
      const sourceChanged = Boolean(
        (ohStoryState.installed?.commitSha ?? ohStoryState.installed?.treeSha)
        && compareOhStoryVersions(release.version, ohStoryState.installed.version) === 0
        && release.commitSha !== (ohStoryState.installed.commitSha ?? ohStoryState.installed.treeSha),
      );
      setOhStoryProgress(sourceChanged
        ? `${release.version} 的源码修订已变化，已阻止同版本静默覆盖`
        : hasUpdate
          ? `发现 ${release.version}`
          : isOhStoryPackageComplete(ohStoryState.installed) ? `已是最新版本 ${release.version}` : `${release.version} 可补装新增技能`);
    } catch (checkError) {
      setError(checkError instanceof Error ? checkError.message : String(checkError));
      setOhStoryProgress("");
    } finally {
      setOhStoryBusy(false);
    }
  };

  const installOhStory = async (release: OhStoryRelease) => {
    setOhStoryBusy(true);
    setError(null);
    setOhStoryProgress(`准备更新到 ${release.version}`);
    try {
      const installed = await installOhStoryRelease(release, ({ completed, total }) => {
        setOhStoryProgress(`下载并校验 ${completed}/${total}`);
      });
      await reloadOhStoryCatalog();
      setOhStoryProgress(`已安装 ${installed.version}`);
    } catch (installError) {
      setError(installError instanceof Error ? installError.message : String(installError));
    } finally {
      setOhStoryBusy(false);
    }
  };

  const confirmOhStoryInstall = (release: OhStoryRelease) => {
    Alert.alert(
      "更新 oh-story 内容包",
      `将安装 ${release.version} 的 ${OH_STORY_SKILL_COUNT} 个 Skill 和 ${OH_STORY_AGENT_COUNT} 个移动端兼容子智能体。只导入 Markdown，不执行脚本或 Hook。`,
      [
        { text: "取消", style: "cancel" },
        { text: "更新", onPress: () => void installOhStory(release) },
      ],
    );
  };

  const confirmOhStoryRollback = () => {
    const previous = ohStoryState.previous;
    if (!previous) return;
    Alert.alert("回滚 oh-story 内容包", `恢复到 ${previous.version}？当前版本会保留为可回滚版本。`, [
      { text: "取消", style: "cancel" },
      {
        text: "回滚",
        onPress: () => {
          setOhStoryBusy(true);
          setError(null);
          void rollbackOhStoryPackage()
            .then(async (restored) => {
              await reloadOhStoryCatalog();
              setOhStoryProgress(`已恢复 ${restored.version}`);
            })
            .catch((rollbackError) => setError(rollbackError instanceof Error ? rollbackError.message : String(rollbackError)))
            .finally(() => setOhStoryBusy(false));
        },
      },
    ]);
  };

  const ohStoryUpdateAvailable = Boolean(
    ohStoryState.lastCheck
    && (!ohStoryState.installed
      || compareOhStoryVersions(ohStoryState.lastCheck.version, ohStoryState.installed.version) > 0
      // 版本没变但应用新支持了更多技能：允许用同一个 Release 补装。
      || (compareOhStoryVersions(ohStoryState.lastCheck.version, ohStoryState.installed.version) === 0
        && !isOhStoryPackageComplete(ohStoryState.installed))),
  );
  const ohStoryIncomplete = Boolean(ohStoryState.installed) && !isOhStoryPackageComplete(ohStoryState.installed);

  if (loading) return <Screen><Header title={TITLES[category]} onBack={onBack} /><View style={styles.loading}><ActivityIndicator color={colors.primary} /></View></Screen>;

  return (
    <Screen scroll>
      <Header title={TITLES[category]} onBack={onBack} />
      {error ? <View style={styles.errorWrap}><ErrorNotice message={error} onRetry={() => void load()} /></View> : null}
      {category === "general" ? (
        <View style={styles.section}>
          <Text style={styles.fieldLabel}>夜间模式</Text>
          <OptionRow
            options={[["system", "跟随系统"], ["light", "浅色"], ["dark", "深色"]]}
            value={themeMode}
            onChange={(value) => {
              setThemeModeState(value);
              setThemeMode(value);
              void savePreference("general.themeMode", value);
            }}
          />
          <Text style={styles.fieldHint}>跟随系统时会随手机的深色模式自动切换；改动立即生效，不需要重启。</Text>
          <Field label="自动保存延迟（毫秒）" value={autoSaveDelay} onChangeText={setAutoSaveDelay} onBlur={() => void savePreference("general.autoSaveDelay", autoSaveDelay)} keyboardType="number-pad" />
          <Field label="编辑器字号" value={editorFontSize} onChangeText={setEditorFontSize} onBlur={() => void savePreference("general.editorFontSize", editorFontSize)} keyboardType="number-pad" />
          <SettingRow label="数据位置" value="本机 SQLite · API Key 使用 SecureStore" />
          <Button label={backupBusy ? "正在导出" : "导出全部数据备份"} variant="secondary" onPress={() => void runBackup()} disabled={backupBusy || restoreBusy} loading={backupBusy} />
          <Button label={restoreBusy ? "正在恢复" : "从备份恢复"} variant="secondary" onPress={runRestore} disabled={backupBusy || restoreBusy} loading={restoreBusy} />
          <Text style={styles.fieldHint}>备份包含全部作品、角色、世界书、笔记、文风、设置和参考书，打包成 zip 通过系统分享保存，不含 API Key。“从备份恢复”会先校验备份，通过后才覆盖当前数据；中途失败会自动还原。</Text>
        </View>
      ) : null}
      {category === "connections" ? (
        <View style={styles.section}>
          <Field label="模型请求超时（毫秒）" value={requestTimeout} onChangeText={setRequestTimeout} onBlur={() => void savePreference("connections.requestTimeout", requestTimeout)} keyboardType="number-pad" />
          <Field label="网络错误最多尝试次数（1-5）" value={maxAttempts} onChangeText={setMaxAttempts} onBlur={() => void savePreference("connections.maxAttempts", maxAttempts)} keyboardType="number-pad" />
          <Field label="服务器错误最多尝试次数（1-3）" value={maxServerErrorAttempts} onChangeText={setMaxServerErrorAttempts} onBlur={() => void savePreference("connections.maxServerErrorAttempts", maxServerErrorAttempts)} keyboardType="number-pad" />
          <Field label="限流（429）最多尝试次数（1-5）" value={maxRateLimitAttempts} onChangeText={setMaxRateLimitAttempts} onBlur={() => void savePreference("connections.maxRateLimitAttempts", maxRateLimitAttempts)} keyboardType="number-pad" />
          <Text style={styles.fieldHint}>尝试次数包含第一次请求。限流时会按供应商给出的等待时间（没有则 5 到 30 秒）暂停后再发，额度或余额不足不会重试；填 1 表示一遇到限流就停止。</Text>
          <ToggleRow label="超时后自动重发（可能重复计费）" value={retryOnTimeout} onChange={(value) => {
            setRetryOnTimeout(value);
            void savePreference("connections.retryOnTimeout", String(value));
          }} />
          <ToggleRow label="流式接收回复" value={streamResponses} onChange={(value) => {
            setStreamResponses(value);
            void savePreference("connections.streamResponses", String(value));
          }} />
          <Text style={styles.fieldHint}>开启后上面的超时按“多久没收到新数据”计算，长章节只要还在生成就不会被中断。个别中转站不支持流式或流式下工具调用异常时关闭；改动约半分钟内生效。</Text>
          <SettingRow label="供应商和模型" value="在“模型”分类中管理" />
          <SettingRow label="网络边界" value="只有调用用户配置的模型 API 时联网；作品数据保存在本机" />
        </View>
      ) : null}
      {category === "index" ? (
        <View style={styles.section}>
          <ToggleRow label="启用本地语义索引" value={indexSettings.enabled} onChange={(value) => void saveIndex({ ...indexSettings, enabled: value })} />
          <ToggleRow label="启用本地重排模型" value={indexSettings.rerankEnabled} onChange={(value) => void saveIndex({ ...indexSettings, rerankEnabled: value })} />
          <Field label="分块大小（字符）" value={String(indexSettings.chunkSize)} onChangeText={(value) => setIndexSettings({ ...indexSettings, chunkSize: Number(value) || 120 })} onBlur={() => void saveIndex(indexSettings)} keyboardType="number-pad" />
          <Field label="分块重叠（字符）" value={String(indexSettings.chunkOverlap)} onChangeText={(value) => setIndexSettings({ ...indexSettings, chunkOverlap: Number(value) || 0 })} onBlur={() => void saveIndex(indexSettings)} keyboardType="number-pad" />
          <Field label="召回数量" value={String(indexSettings.retrievalTopK)} onChangeText={(value) => setIndexSettings({ ...indexSettings, retrievalTopK: Number(value) || 1 })} onBlur={() => void saveIndex(indexSettings)} keyboardType="number-pad" />
          <Field label="重排数量" value={String(indexSettings.rerankTopK)} onChangeText={(value) => setIndexSettings({ ...indexSettings, rerankTopK: Number(value) || 1 })} onBlur={() => void saveIndex(indexSettings)} keyboardType="number-pad" />
          <Text style={styles.statusText}>当前索引：{indexStats.sources} 个资料源 · {indexStats.chunks} 个分块</Text>
          <Button label={saving ? "索引中" : "重建当前作品索引"} onPress={() => void rebuildIndex()} disabled={!projectId || saving} loading={saving} />
          {indexProgress ? <Text style={styles.progressText}>{indexProgress}</Text> : null}
        </View>
      ) : null}
      {category === "context" ? (
        <View style={styles.section}>
          <Text style={styles.fieldLabel}>上下文限制方式</Text>
          <OptionRow
            options={[["count", "按消息条数"], ["tokens", "按 Token 数"]]}
            value={contextLimitMode}
            onChange={(value) => {
              setContextLimitMode(value);
              void savePreference("context.limitMode", value);
            }}
          />
          {contextLimitMode === "count" ? (
            <Field label={`保留最近消息数（${MIN_HISTORY_LIMIT}-${MAX_HISTORY_LIMIT}）`} value={historyLimit} onChangeText={setHistoryLimit} onBlur={() => void savePreference("context.historyLimit", historyLimit)} keyboardType="number-pad" />
          ) : (
            <>
              <Field label="上下文 Token 上限" value={contextTokenLimit} onChangeText={setContextTokenLimit} onBlur={saveContextTokenLimit} keyboardType="number-pad" />
              <Text style={styles.fieldHint}>按所用模型的上下文窗口填写，例如 128000；换用窗口更小的模型时记得调低。应用会先扣掉该模型的“最大输出 Token 数”，剩下的额度用来放系统提示词、工具定义和对话，对话从最新一条往前装，装不下的算作超出。Token 数按字符估算（一个汉字约 1 个，三四个英文字符约 1 个），并留 10% 余量。一次任务里工具结果把请求撑到上限时，较早的读取结果会被强制清理，不受下面开关影响。</Text>
            </>
          )}
          <Text style={styles.fieldLabel}>超出上限时</Text>
          <OptionRow
            options={[["drop", "丢弃较早消息"], ["summarize", "生成摘要"]]}
            value={contextOverflow}
            onChange={(value) => {
              setContextOverflow(value);
              void savePreference("context.overflow", value);
            }}
          />
          <Text style={styles.fieldHint}>丢弃：超出的较早消息不再发给模型，聊天记录本身不会删除。生成摘要：超出时用当前模型把较早的一半对话压缩成摘要，保存在这个对话里，之后每次请求都带上；只有压缩那一次会多发一个模型请求，摘要失败时自动按丢弃处理。</Text>
          <ToggleRow label="压缩系统提示词" value={compression} onChange={(value) => {
            setCompression(value);
            void savePreference("context.compressSystemPrompts", String(value));
          }} />
          <ToggleRow label="自动清理较早的工具结果" value={pruneToolOutputs} onChange={(value) => {
            setPruneToolOutputs(value);
            void savePreference("context.pruneToolOutputs", String(value));
          }} />
          <Text style={styles.fieldHint}>一次任务里读过的章节、角色等内容每轮都会重发。开启后，累计超过约 4 万字符时，较早的读取结果会换成占位说明（最近 4 条保留），写入结果、技能指令和子智能体结论不受影响；助手需要时会重新读取。能明显降低单次请求体量，减少被中转站限流。</Text>
        </View>
      ) : null}
      {category === "style" ? (
        <View style={styles.section}>
          <SettingRow label="文风书库" value="请从设置菜单重新进入" />
        </View>
      ) : null}
      {category === "agent-tools" ? (
        <View style={styles.section}>
          <Text style={styles.sectionHint}>点击权限状态循环切换：允许、每次询问、禁止。</Text>
          {SORTED_TOOLS.map((tool, index) => {
            const group = toolGroup(tool.key);
            const previous = index > 0 ? toolGroup(SORTED_TOOLS[index - 1].key) : "";
            return (
              <View key={tool.key}>
                {group !== previous ? <Text style={styles.permissionGroup}>{group}</Text> : null}
                <Pressable onPress={() => void cyclePermission(tool.key)} style={styles.permissionRow}>
                  <View style={styles.permissionText}>
                    <Text style={styles.settingLabel}>{tool.name}</Text>
                    <Text style={styles.settingValue}>{tool.key}</Text>
                  </View>
                  <Text style={[styles.permissionMode, permissions[tool.key] === "deny" && styles.dangerText]}>
                    {permissions[tool.key] === "allow" ? "允许" : permissions[tool.key] === "deny" ? "禁止" : "每次询问"}
                  </Text>
                </Pressable>
              </View>
            );
          })}
        </View>
      ) : null}
      {category === "rules" ? (
        <View style={styles.section}>
          {rules.map((rule) => (
            <View key={rule.id} style={styles.manageRow}>
              <View style={styles.manageText}>
                <Text style={styles.settingLabel}>{rule.name}</Text>
                <Text numberOfLines={3} style={styles.settingValue}>{rule.content}</Text>
              </View>
              <Switch value={rule.enabled} onValueChange={(enabled) => {
                const next = rules.map((item) => item.id === rule.id ? { ...item, enabled } : item);
                void persistManagedState(next, saveAgentRules, setRules);
              }} trackColor={{ false: colors.border, true: colors.primary }} />
              <Pressable accessibilityLabel="删除规则" onPress={() => {
                const next = rules.filter((item) => item.id !== rule.id);
                void persistManagedState(next, saveAgentRules, setRules);
              }} style={styles.iconButton}><Ionicons name="trash-outline" size={19} color={colors.textMuted} /></Pressable>
            </View>
          ))}
          <Field label="规则名称" value={ruleName} onChangeText={setRuleName} />
          <Field label="规则内容" value={ruleContent} onChangeText={setRuleContent} multiline style={styles.multiline} />
          <Button label="添加规则" onPress={() => void addRule()} disabled={!ruleName.trim() || !ruleContent.trim()} />
        </View>
      ) : null}
      {category === "skills" ? (
        <View style={styles.section}>
          <ToggleRow label="允许助手管理技能" value={skillManagement} onChange={(value) => {
            setSkillManagement(value);
            void savePreference("agent.skillManagement", String(value));
          }} />
          <Text style={styles.sectionHint}>开启后主智能体可以列出、查看、新建、修改和删除自定义技能（多带 5 个工具，每次请求会略大）。助手新建的技能默认关闭，要你在这里启用才生效；内置技能和已启用的技能它改不了。</Text>
          {skills.map((skill) => (
            <View key={skill.id} style={styles.manageRow}>
              <View style={styles.manageText}>
                <Text style={styles.settingLabel}>{skill.name}</Text>
                <Text numberOfLines={2} style={styles.settingValue}>{skill.description || skill.instructions}</Text>
                <Text style={styles.modelHint}>
                  {skill.source === "builtin" ? "OpenFicM 基础包" : skill.source === "plugin" ? "Lorn 文风插件" : skill.source === "remote" ? "oh-story 更新技能" : "自定义技能"} · 按需激活
                </Text>
              </View>
              <Switch value={skill.enabled} onValueChange={(enabled) => {
                const next = skills.map((item) => item.id === skill.id ? { ...item, enabled } : item);
                void persistManagedState(next, saveAgentSkills, setSkills);
              }} trackColor={{ false: colors.border, true: colors.primary }} />
              {skill.source === "custom" ? (
                <Pressable accessibilityLabel="删除技能" onPress={() => {
                  const next = skills.filter((item) => item.id !== skill.id);
                  void persistManagedState(next, saveAgentSkills, setSkills);
                }} style={styles.iconButton}><Ionicons name="trash-outline" size={19} color={colors.textMuted} /></Pressable>
              ) : <View style={styles.iconButton}><Ionicons name="lock-closed-outline" size={18} color={colors.textMuted} /></View>}
            </View>
          ))}
          <Field label="技能名称" value={skillName} onChangeText={setSkillName} />
          <Field label="技能说明" value={skillDescription} onChangeText={setSkillDescription} />
          <Field label="技能指令" value={skillInstructions} onChangeText={setSkillInstructions} multiline style={styles.multiline} />
          <Button label="添加技能" onPress={() => void addSkill()} disabled={!skillName.trim() || !skillInstructions.trim()} />
        </View>
      ) : null}
      {category === "agents" ? (
        <View style={styles.section}>
          {agents.map((agent) => (
            <View key={agent.id} style={[styles.manageRow, activeAgentId === agent.id && styles.activeRow]}>
              <View style={styles.manageText}>
                <Text style={styles.settingLabel}>{agent.name}</Text>
                <Text numberOfLines={2} style={styles.settingValue}>{agent.description || agent.systemPrompt}</Text>
                <Text style={styles.modelHint}>
                  {agent.source === "builtin" ? "OpenFicM 基础包" : agent.source === "remote" ? "oh-story 更新" : "自定义"} · {agent.kind === "primary" ? "主智能体" : "子智能体"} · {agent.skillIds.length} 个技能
                </Text>
                {agent.modelId ? <Text style={styles.modelHint}>{availableModels.find((model) => model.id === agent.modelId)?.name ?? "模型已删除"}</Text> : null}
              </View>
              <Switch value={agent.enabled} onValueChange={(enabled) => void toggleAgent(agent.id, enabled)} trackColor={{ false: colors.border, true: colors.primary }} />
              {agent.kind === "primary" ? (
                <Pressable accessibilityLabel={`选择 ${agent.name} 主智能体`} disabled={!agent.enabled} onPress={() => void selectAgent(agent)} style={styles.iconButton}>
                  <Ionicons name={activeAgentId === agent.id ? "radio-button-on" : "radio-button-off"} size={21} color={activeAgentId === agent.id ? colors.primary : colors.textMuted} />
                </Pressable>
              ) : <View style={styles.iconButton}><Ionicons name="git-branch-outline" size={20} color={colors.textMuted} /></View>}
              {agent.source === "custom" ? (
                <Pressable accessibilityLabel="删除智能体" onPress={() => void removeAgent(agent.id)} style={styles.iconButton}>
                  <Ionicons name="trash-outline" size={19} color={colors.textMuted} />
                </Pressable>
              ) : <View style={styles.iconButton}><Ionicons name="lock-closed-outline" size={18} color={colors.textMuted} /></View>}
            </View>
          ))}
          <Field label="智能体名称" value={agentName} onChangeText={setAgentName} />
          <Field label="智能体说明" value={agentDescription} onChangeText={setAgentDescription} />
          <Field label="系统提示词" value={agentPrompt} onChangeText={setAgentPrompt} multiline style={styles.multiline} />
          <Text style={styles.sectionHint}>智能体模型</Text>
          <View style={styles.modelChoices}>
            <Pressable onPress={() => setAgentModelId("")} style={[styles.modelChoice, !agentModelId && styles.modelChoiceActive]}>
              <Text style={styles.modelChoiceText}>跟随全局</Text>
            </Pressable>
            {availableModels.map((model) => (
              <Pressable key={model.id} onPress={() => setAgentModelId(model.id)} style={[styles.modelChoice, agentModelId === model.id && styles.modelChoiceActive]}>
                <Text numberOfLines={1} style={styles.modelChoiceText}>{model.name}</Text>
              </Pressable>
            ))}
          </View>
          <Button label="添加智能体" onPress={() => void addAgent()} disabled={!agentName.trim() || !agentPrompt.trim()} />
        </View>
      ) : null}
      {category === "advanced" ? (
        <View style={styles.section}>
          <Text style={styles.subsectionTitle}>应用版本</Text>
          <SettingRow label="当前版本" value={CURRENT_APP_VERSION} />
          <SettingRow
            label="最新版本"
            value={appUpdate ? `${appUpdate.latestVersion}${appUpdate.hasUpdate ? "（可更新）" : "（已是最新）"}` : "尚未检查"}
          />
          {appUpdate?.checkedAt ? (
            <SettingRow label="上次检查" value={new Date(appUpdate.checkedAt).toLocaleString()} />
          ) : null}
          <Button
            label={appUpdateBusy ? "检查中" : "检查应用更新"}
            onPress={() => void checkForAppUpdate()}
            disabled={appUpdateBusy}
            loading={appUpdateBusy}
          />
          {appUpdate?.hasUpdate ? (
            <Button
              label={`前往下载 ${appUpdate.latestVersion}`}
              onPress={() => void Linking.openURL(appUpdate.releaseUrl)}
            />
          ) : null}
          {appUpdateError ? <Text style={styles.progressText}>{appUpdateError}</Text> : null}
          {appUpdate?.hasUpdate && appUpdate.notes ? (
            <Text style={styles.updateNotes} numberOfLines={12}>{appUpdate.notes}</Text>
          ) : null}
          <View style={styles.subsectionDivider} />
          <Text style={styles.subsectionTitle}>oh-story 内容包</Text>
          <SettingRow label="本地版本" value={ohStoryState.installed?.version ?? "未安装"} />
          <SettingRow label="最近发现" value={ohStoryState.lastCheck ? `${ohStoryState.lastCheck.version} · ${ohStoryState.lastCheck.commitSha.slice(0, 8)}` : "尚未检查"} />
          {ohStoryState.installed ? (
            <>
              <SettingRow
                label="已安装内容"
                value={`${ohStoryState.installed.skills.length} 个技能 · ${ohStoryState.installed.agents.length} 个子智能体 · ${ohStoryState.installed.sha256.slice(0, 12)}`}
              />
              {ohStoryState.installed.commitSha || ohStoryState.installed.treeSha ? (
                <SettingRow label="源码修订" value={(ohStoryState.installed.commitSha ?? ohStoryState.installed.treeSha ?? "").slice(0, 12)} />
              ) : null}
            </>
          ) : null}
          <Button label={ohStoryBusy ? "处理中" : "检查 GitHub Release"} onPress={() => void checkOhStory()} disabled={ohStoryBusy} loading={ohStoryBusy && ohStoryProgress.includes("检查")} />
          {ohStoryIncomplete ? (
            <Text style={styles.progressText}>这个版本新增支持 5 个 oh-story 技能和 1 个子智能体。点“检查 GitHub Release”后再点更新即可补装。</Text>
          ) : null}
          {ohStoryUpdateAvailable && ohStoryState.lastCheck ? (
            <Button label={ohStoryIncomplete && ohStoryState.installed?.version === ohStoryState.lastCheck.version ? `补装 ${ohStoryState.lastCheck.version} 的新增技能` : `更新到 ${ohStoryState.lastCheck.version}`} onPress={() => confirmOhStoryInstall(ohStoryState.lastCheck as OhStoryRelease)} disabled={ohStoryBusy} />
          ) : null}
          {ohStoryState.previous ? (
            <Button label={`回滚到 ${ohStoryState.previous.version}`} variant="secondary" onPress={confirmOhStoryRollback} disabled={ohStoryBusy} />
          ) : null}
          {ohStoryProgress ? <Text style={styles.progressText}>{ohStoryProgress}</Text> : null}
          <View style={styles.subsectionDivider} />
          <Text style={styles.subsectionTitle}>本地检索模型</Text>
          <SettingRow label="嵌入模型" value={`${LOCAL_MODEL_INFO.embedding.name} · 约 15 MB`} />
          <SettingRow label="重排模型" value={`${LOCAL_MODEL_INFO.rerank.name} · 约 209 MB`} />
          <SettingRow label="当前加载状态" value={`嵌入：${getLocalModelStatus().embeddingLoaded ? "已加载" : "未加载"} · 重排：${getLocalModelStatus().rerankLoaded ? "已加载" : "未加载"}`} />
          <SettingRow label="运行资源状态" value={resourceState?.ready ? "完整" : `缺少 ${resourceState?.missing.length ?? "未知"} 项`} />
          <Button label={resourceBusy ? "拉取中" : "一键拉取缺失资源"} onPress={() => void downloadResources()} disabled={resourceBusy} loading={resourceBusy} />
          {resourceProgress ? <Text style={styles.progressText}>{resourceProgress}</Text> : null}
          <Button label="清除当前作品索引" variant="secondary" onPress={() => {
            if (!projectId) return;
            Alert.alert("清除索引", "只删除索引，不删除章节、角色和世界书数据。", [
              { text: "取消", style: "cancel" },
              { text: "清除", style: "destructive", onPress: () => void clearProjectIndex(projectId).then(() => setIndexStats({ sources: 0, chunks: 0 })) },
            ]);
          }} disabled={!projectId} />
        </View>
      ) : null}
    </Screen>
  );
}

const styles = themedStyles((colors) => StyleSheet.create({
  loading: { flex: 1, alignItems: "center", justifyContent: "center" },
  errorWrap: { padding: spacing.lg, paddingBottom: 0 },
  section: { gap: spacing.md, padding: spacing.lg },
  subsectionTitle: { color: colors.text, fontSize: 17, fontWeight: "700" },
  subsectionDivider: { height: StyleSheet.hairlineWidth, marginVertical: spacing.sm, backgroundColor: colors.border },
  sectionHint: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
  fieldHint: { color: colors.textMuted, fontSize: 12, lineHeight: 18, marginTop: -spacing.sm },
  fieldLabel: { color: colors.text, fontSize: 13, fontWeight: "600", marginBottom: -spacing.sm },
  optionRow: { flexDirection: "row", gap: spacing.sm },
  option: { flex: 1, minHeight: 42, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, backgroundColor: colors.surface },
  optionActive: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  optionText: { color: colors.textMuted, fontSize: 13, fontWeight: "600" },
  optionTextActive: { color: colors.primary, fontWeight: "700" },
  settingRow: { minHeight: 52, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  settingLabel: { flex: 1, color: colors.text, fontSize: 15, fontWeight: "600" },
  settingValue: { flex: 1, color: colors.textMuted, fontSize: 13, lineHeight: 19, textAlign: "right" },
  permissionGroup: { marginTop: spacing.md, color: colors.primary, fontSize: 13, fontWeight: "700" },
  permissionRow: { minHeight: 60, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  permissionText: { flex: 1, minWidth: 0 },
  permissionMode: { minWidth: 64, color: colors.primary, fontSize: 13, fontWeight: "700", textAlign: "right" },
  manageRow: { minHeight: 68, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: spacing.sm, paddingLeft: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm },
  activeRow: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  manageText: { flex: 1, minWidth: 0, gap: spacing.xs },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  multiline: { minHeight: 120 },
  progressText: { color: colors.primary, fontSize: 13 },
  updateNotes: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
  statusText: { color: colors.textMuted, fontSize: 13 },
  modelHint: { color: colors.primary, fontSize: 12 },
  modelChoices: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  modelChoice: { maxWidth: "100%", minHeight: 40, justifyContent: "center", paddingHorizontal: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm },
  modelChoiceActive: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  modelChoiceText: { color: colors.text, fontSize: 13, fontWeight: "600" },
  dangerText: { color: colors.danger },
}));
