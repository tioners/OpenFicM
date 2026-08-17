import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
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
import { getLocalModelStatus, LOCAL_MODEL_INFO, releaseLocalModels, warmUpLocalModels } from "@/search/local-models";
import {
  checkOhStoryRelease,
  compareOhStoryVersions,
  getOhStoryUpdateState,
  installOhStoryRelease,
  rollbackOhStoryPackage,
  type OhStoryRelease,
  type OhStoryUpdateState,
} from "@/settings/oh-story-updater";
import { colors, radius, spacing } from "@/theme";
import type { Model } from "@/types";

export type SettingsCategory =
  | "general"
  | "connections"
  | "models"
  | "index"
  | "context"
  | "agent-tools"
  | "rules"
  | "skills"
  | "agents"
  | "advanced";

const TITLES: Record<Exclude<SettingsCategory, "models">, string> = {
  general: "通用",
  connections: "连接",
  index: "索引",
  context: "上下文",
  "agent-tools": "工具权限",
  rules: "规则",
  skills: "技能",
  agents: "智能体",
  advanced: "高级",
};

const EMPTY_OH_STORY_STATE: OhStoryUpdateState = { installed: null, previous: null, lastCheck: null };

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

export function SettingsCategoryScreen({ category, onBack }: { category: Exclude<SettingsCategory, "models">; onBack: () => void }) {
  const projectId = useAppStore((state) => state.currentProjectId);
  const refreshData = useAppStore((state) => state.refreshData);
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
  const [historyLimit, setHistoryLimit] = useState("30");
  const [compression, setCompression] = useState(false);
  const [autoSaveDelay, setAutoSaveDelay] = useState("1000");
  const [editorFontSize, setEditorFontSize] = useState("17");
  const [requestTimeout, setRequestTimeout] = useState("120000");
  const [ohStoryState, setOhStoryState] = useState<OhStoryUpdateState>(EMPTY_OH_STORY_STATE);
  const [ohStoryProgress, setOhStoryProgress] = useState("");
  const [ohStoryBusy, setOhStoryBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextIndex, nextRules, nextSkills, nextAgents, nextPermissions, active, history, compress, autoSave, fontSize, timeout, nextModels, nextOhStoryState] = await Promise.all([
        getIndexSettings(),
        getAgentRules(),
        getAgentSkills(),
        getAgentDefinitions(),
        getToolPermissions(),
        getSetting("agent.activeDefinitionId"),
        getSetting("context.historyLimit"),
        getSetting("context.compressSystemPrompts"),
        getSetting("general.autoSaveDelay"),
        getSetting("general.editorFontSize"),
        getSetting("connections.requestTimeout"),
        listModels(),
        getOhStoryUpdateState(),
      ]);
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
      setHistoryLimit(history ?? "30");
      setCompression(compress === "true");
      setAutoSaveDelay(autoSave ?? "1000");
      setEditorFontSize(fontSize ?? "17");
      setRequestTimeout(timeout ?? "120000");
      setAvailableModels(nextModels);
      setOhStoryState(nextOhStoryState);
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
        : hasUpdate ? `发现 ${release.version}` : `已是最新版本 ${release.version}`);
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
      `将安装 ${release.version} 的 7 个 Skill 和 6 个移动端兼容子智能体。只导入 Markdown，不执行脚本或 Hook。`,
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
      || compareOhStoryVersions(ohStoryState.lastCheck.version, ohStoryState.installed.version) > 0),
  );

  if (loading) return <Screen><Header title={TITLES[category]} onBack={onBack} /><View style={styles.loading}><ActivityIndicator color={colors.primary} /></View></Screen>;

  return (
    <Screen scroll>
      <Header title={TITLES[category]} onBack={onBack} />
      {error ? <View style={styles.errorWrap}><ErrorNotice message={error} onRetry={() => void load()} /></View> : null}
      {category === "general" ? (
        <View style={styles.section}>
          <Field label="自动保存延迟（毫秒）" value={autoSaveDelay} onChangeText={setAutoSaveDelay} onBlur={() => void savePreference("general.autoSaveDelay", autoSaveDelay)} keyboardType="number-pad" />
          <Field label="编辑器字号" value={editorFontSize} onChangeText={setEditorFontSize} onBlur={() => void savePreference("general.editorFontSize", editorFontSize)} keyboardType="number-pad" />
          <SettingRow label="数据位置" value="本机 SQLite · API Key 使用 SecureStore" />
        </View>
      ) : null}
      {category === "connections" ? (
        <View style={styles.section}>
          <Field label="模型请求超时（毫秒）" value={requestTimeout} onChangeText={setRequestTimeout} onBlur={() => void savePreference("connections.requestTimeout", requestTimeout)} keyboardType="number-pad" />
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
          <Field label="保留最近消息数" value={historyLimit} onChangeText={setHistoryLimit} onBlur={() => void savePreference("context.historyLimit", historyLimit)} keyboardType="number-pad" />
          <ToggleRow label="压缩系统提示词" value={compression} onChange={(value) => {
            setCompression(value);
            void savePreference("context.compressSystemPrompts", String(value));
          }} />
        </View>
      ) : null}
      {category === "agent-tools" ? (
        <View style={styles.section}>
          <Text style={styles.sectionHint}>点击权限状态循环切换：允许、每次询问、禁止。</Text>
          {TOOL_CATALOG.map((tool) => (
            <Pressable key={tool.key} onPress={() => void cyclePermission(tool.key)} style={styles.permissionRow}>
              <View style={styles.permissionText}>
                <Text style={styles.settingLabel}>{tool.name}</Text>
                <Text style={styles.settingValue}>{tool.key}</Text>
              </View>
              <Text style={[styles.permissionMode, permissions[tool.key] === "deny" && styles.dangerText]}>
                {permissions[tool.key] === "allow" ? "允许" : permissions[tool.key] === "deny" ? "禁止" : "每次询问"}
              </Text>
            </Pressable>
          ))}
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
          {skills.map((skill) => (
            <View key={skill.id} style={styles.manageRow}>
              <View style={styles.manageText}>
                <Text style={styles.settingLabel}>{skill.name}</Text>
                <Text numberOfLines={2} style={styles.settingValue}>{skill.description || skill.instructions}</Text>
                <Text style={styles.modelHint}>
                  {skill.source === "builtin" ? "PC 内置技能" : skill.source === "remote" ? "oh-story 更新技能" : "自定义技能"} · 按需激活
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
                  {agent.source === "builtin" ? "PC 内置" : agent.source === "remote" ? "oh-story 更新" : "自定义"} · {agent.kind === "primary" ? "主智能体" : "子智能体"} · {agent.skillIds.length} 个技能
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
          {ohStoryUpdateAvailable && ohStoryState.lastCheck ? (
            <Button label={`更新到 ${ohStoryState.lastCheck.version}`} onPress={() => confirmOhStoryInstall(ohStoryState.lastCheck as OhStoryRelease)} disabled={ohStoryBusy} />
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
          <Button label="预热本地模型" onPress={() => {
            setSaving(true);
            void warmUpLocalModels().catch((warmError) => setError(warmError instanceof Error ? warmError.message : String(warmError))).finally(() => setSaving(false));
          }} loading={saving} />
          <Button label="释放本地模型内存" variant="secondary" onPress={() => void releaseLocalModels()} />
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

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: "center", justifyContent: "center" },
  errorWrap: { padding: spacing.lg, paddingBottom: 0 },
  section: { gap: spacing.md, padding: spacing.lg },
  subsectionTitle: { color: colors.text, fontSize: 17, fontWeight: "700" },
  subsectionDivider: { height: StyleSheet.hairlineWidth, marginVertical: spacing.sm, backgroundColor: colors.border },
  sectionHint: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
  settingRow: { minHeight: 52, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  settingLabel: { flex: 1, color: colors.text, fontSize: 15, fontWeight: "600" },
  settingValue: { flex: 1, color: colors.textMuted, fontSize: 13, lineHeight: 19, textAlign: "right" },
  permissionRow: { minHeight: 60, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  permissionText: { flex: 1, minWidth: 0 },
  permissionMode: { minWidth: 64, color: colors.primary, fontSize: 13, fontWeight: "700", textAlign: "right" },
  manageRow: { minHeight: 68, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: spacing.sm, paddingLeft: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm },
  activeRow: { borderColor: colors.primary, backgroundColor: "#E6F3EF" },
  manageText: { flex: 1, minWidth: 0, gap: spacing.xs },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  multiline: { minHeight: 120 },
  progressText: { color: colors.primary, fontSize: 13 },
  statusText: { color: colors.textMuted, fontSize: 13 },
  modelHint: { color: colors.primary, fontSize: 12 },
  modelChoices: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  modelChoice: { maxWidth: "100%", minHeight: 40, justifyContent: "center", paddingHorizontal: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm },
  modelChoiceActive: { borderColor: colors.primary, backgroundColor: "#E6F3EF" },
  modelChoiceText: { color: colors.text, fontSize: 13, fontWeight: "600" },
  dangerText: { color: colors.danger },
});
