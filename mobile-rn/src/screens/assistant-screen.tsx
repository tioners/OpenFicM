import type { BottomTabNavigationProp } from "@react-navigation/bottom-tabs";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";

import { AgentRunError, runAgent } from "@/agent/runtime";
import { AgentQuestionSheet, AgentTraceView } from "@/components/agent-run-view";
import { Button, EmptyState, ErrorNotice, Header, Screen } from "@/components/ui";
import {
  addMessage,
  createChatSession,
  deleteChatSession,
  getProject,
  getProviderApiKey,
  getSetting,
  listChatSessions,
  listMessages,
  listModels,
  listProviders,
  setSetting,
  updateChatSession,
} from "@/data/repositories";
import type { RootTabParamList } from "@/navigation/types";
import { getAgentDefinitions } from "@/settings/config";
import { useAppStore } from "@/store/app-store";
import { colors, radius, spacing } from "@/theme";
import type {
  AgentClarificationRequest,
  AgentClarificationResponse,
  AgentRunTrace,
  ChatMessage,
  ChatSession,
  Model,
  ModelSelection,
  Project,
  Provider,
} from "@/types";

function requestToolApproval(name: string, args: Record<string, unknown>): Promise<boolean> {
  const details = JSON.stringify(args, null, 2).slice(0, 1_200);
  return new Promise((resolve) => {
    Alert.alert("确认工具调用", `${name}\n\n${details}`, [
      { text: "拒绝", style: "cancel", onPress: () => resolve(false) },
      { text: "允许一次", onPress: () => resolve(true) },
    ], { cancelable: false });
  });
}

function activeSessionSettingKey(projectId: string): string {
  return `assistant.activeSession.${projectId}`;
}

function generatedSessionTitle(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 24) || "新对话";
}

function formatSessionTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

async function resolveSelection(
  modelId: string | null,
  models: Model[],
  providers: Provider[],
): Promise<ModelSelection | null> {
  if (!modelId) return null;
  const model = models.find((item) => item.id === modelId);
  if (!model) return null;
  const provider = providers.find((item) => item.id === model.providerId);
  if (!provider) return null;
  const apiKey = await getProviderApiKey(provider);
  if (!apiKey) throw new Error(`${provider.name} 没有可用的 API Key，请到设置页重新保存`);
  return { provider, model, apiKey };
}

export function AssistantScreen() {
  const navigation = useNavigation<BottomTabNavigationProp<RootTabParamList>>();
  const projectId = useAppStore((state) => state.currentProjectId);
  const refreshData = useAppStore((state) => state.refreshData);
  const revision = useAppStore((state) => state.dataRevision);
  const [project, setProject] = useState<Project | null>(null);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSession, setActiveSession] = useState<ChatSession | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [defaultModelId, setDefaultModelId] = useState<string | null>(null);
  const [activeAgentName, setActiveAgentName] = useState("Build");
  const [selection, setSelection] = useState<ModelSelection | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sessionPickerVisible, setSessionPickerVisible] = useState(false);
  const [modelPickerVisible, setModelPickerVisible] = useState(false);
  const [liveTrace, setLiveTrace] = useState<AgentRunTrace | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState<AgentClarificationRequest | null>(null);
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const loadRequestRef = useRef(0);
  const sendRequestRef = useRef(0);
  const questionResolverRef = useRef<((response: AgentClarificationResponse) => void) | null>(null);
  const providerById = useMemo(() => new Map(providers.map((provider) => [provider.id, provider])), [providers]);

  const cancelPendingQuestion = useCallback(() => {
    const resolver = questionResolverRef.current;
    questionResolverRef.current = null;
    setPendingQuestion(null);
    resolver?.({ answers: [], cancelled: true });
  }, []);

  const load = useCallback(async () => {
    const requestId = loadRequestRef.current + 1;
    loadRequestRef.current = requestId;
    if (!projectId) {
      setProject(null);
      setSessions([]);
      setActiveSession(null);
      setMessages([]);
      setModels([]);
      setProviders([]);
      setDefaultModelId(null);
      setActiveAgentName("Build");
      setSelection(null);
      setLiveTrace(null);
      cancelPendingQuestion();
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [nextProject, storedSessions, preferredSessionId, activeModelId, nextModels, nextProviders, activeAgentId, agents] = await Promise.all([
        getProject(projectId),
        listChatSessions(projectId),
        getSetting(activeSessionSettingKey(projectId)),
        getSetting("activeModelId"),
        listModels(),
        listProviders(),
        getSetting("agent.activeDefinitionId"),
        getAgentDefinitions(),
      ]);
      if (!nextProject) throw new Error("作品不存在");
      const activeAgent = agents.find((agent) => agent.id === activeAgentId && agent.enabled && agent.kind === "primary")
        ?? agents.find((agent) => agent.id === "builtin-agent--build" && agent.enabled)
        ?? agents.find((agent) => agent.enabled && agent.kind === "primary");
      const nextDefaultModelId = nextModels.find((model) => model.id === activeAgent?.modelId)?.id
        ?? nextModels.find((model) => model.id === activeModelId)?.id
        ?? null;
      let nextSessions = storedSessions;
      let nextSession = nextSessions.find((session) => session.id === preferredSessionId) ?? nextSessions[0] ?? null;
      if (!nextSession) {
        nextSession = await createChatSession(projectId, nextDefaultModelId);
        nextSessions = [nextSession];
      }
      const selectedModelId = nextModels.some((model) => model.id === nextSession?.modelId)
        ? nextSession.modelId
        : nextDefaultModelId;
      const nextMessages = await listMessages(nextSession.id);
      let nextSelection: ModelSelection | null = null;
      let selectionError: string | null = null;
      try {
        nextSelection = await resolveSelection(selectedModelId, nextModels, nextProviders);
      } catch (resolveError) {
        selectionError = resolveError instanceof Error ? resolveError.message : String(resolveError);
      }
      await setSetting(activeSessionSettingKey(projectId), nextSession.id);
      if (loadRequestRef.current !== requestId) return;
      setProject(nextProject);
      setSessions(nextSessions);
      setActiveSession(nextSession);
      setMessages(nextMessages);
      setModels(nextModels);
      setProviders(nextProviders);
      setDefaultModelId(nextDefaultModelId);
      setActiveAgentName(activeAgent?.name ?? "Build");
      setSelection(nextSelection);
      setError(selectionError);
    } catch (loadError) {
      if (loadRequestRef.current !== requestId) return;
      setActiveSession(null);
      setSelection(null);
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      if (loadRequestRef.current === requestId) setLoading(false);
    }
  }, [cancelPendingQuestion, projectId]);

  useEffect(() => {
    cancelPendingQuestion();
    setSending(false);
    setLiveTrace(null);
    return () => {
      sendRequestRef.current += 1;
      cancelPendingQuestion();
    };
  }, [cancelPendingQuestion, projectId]);

  useFocusEffect(useCallback(() => {
    void load();
    return () => {
      loadRequestRef.current += 1;
      cancelPendingQuestion();
    };
  }, [cancelPendingQuestion, load, revision]));

  const switchSession = async (session: ChatSession) => {
    if (!projectId || sending) return;
    setError(null);
    try {
      if (session.projectId !== projectId || !sessions.some((item) => item.id === session.id)) {
        throw new Error("对话不属于当前作品");
      }
      const effectiveModelId = models.some((model) => model.id === session.modelId) ? session.modelId : defaultModelId;
      const nextMessages = await listMessages(session.id);
      let nextSelection: ModelSelection | null = null;
      let selectionError: string | null = null;
      try {
        nextSelection = await resolveSelection(effectiveModelId, models, providers);
      } catch (resolveError) {
        selectionError = resolveError instanceof Error ? resolveError.message : String(resolveError);
      }
      await setSetting(activeSessionSettingKey(projectId), session.id);
      setActiveSession(session);
      setMessages(nextMessages);
      setSelection(nextSelection);
      setError(selectionError);
      setSessionPickerVisible(false);
      requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: false }));
    } catch (switchError) {
      setError(switchError instanceof Error ? switchError.message : String(switchError));
    }
  };

  const newSession = async () => {
    if (!projectId || sending) return;
    setError(null);
    try {
      const session = await createChatSession(projectId, selection?.model.id ?? defaultModelId);
      await setSetting(activeSessionSettingKey(projectId), session.id);
      setSessions((current) => [session, ...current]);
      setActiveSession(session);
      setMessages([]);
      setSessionPickerVisible(false);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    }
  };

  const chooseModel = async (modelId: string | null) => {
    if (!activeSession || sending) return;
    setError(null);
    try {
      const nextSelection = await resolveSelection(modelId ?? defaultModelId, models, providers);
      const updated = await updateChatSession({ id: activeSession.id, modelId });
      setActiveSession(updated);
      setSessions((current) => current.map((session) => session.id === updated.id ? updated : session));
      setSelection(nextSelection);
      setModelPickerVisible(false);
    } catch (modelError) {
      setError(modelError instanceof Error ? modelError.message : String(modelError));
    }
  };

  const removeSession = async (session: ChatSession) => {
    if (!projectId || sending) return;
    try {
      if (session.projectId !== projectId || !sessions.some((item) => item.id === session.id)) {
        throw new Error("对话不属于当前作品");
      }
      await deleteChatSession(session.id);
      const remaining = sessions.filter((item) => item.id !== session.id);
      setSessions(remaining);
      if (activeSession?.id !== session.id) return;
      const replacement = remaining[0] ?? await createChatSession(projectId, selection?.model.id ?? defaultModelId);
      if (!remaining.length) setSessions([replacement]);
      await setSetting(activeSessionSettingKey(projectId), replacement.id);
      const effectiveModelId = models.some((model) => model.id === replacement.modelId) ? replacement.modelId : defaultModelId;
      const nextMessages = await listMessages(replacement.id);
      setActiveSession(replacement);
      setMessages(nextMessages);
      try {
        setSelection(await resolveSelection(effectiveModelId, models, providers));
        setError(null);
      } catch (resolveError) {
        setSelection(null);
        setError(resolveError instanceof Error ? resolveError.message : String(resolveError));
      }
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    }
  };

  const confirmDeleteSession = (session: ChatSession) => {
    Alert.alert("删除对话", `确定删除“${session.title}”及其中的全部消息？`, [
      { text: "取消", style: "cancel" },
      { text: "删除", style: "destructive", onPress: () => void removeSession(session) },
    ]);
  };

  const askUser = useCallback((request: AgentClarificationRequest) => new Promise<AgentClarificationResponse>((resolve) => {
    questionResolverRef.current?.({ answers: [], cancelled: true });
    questionResolverRef.current = resolve;
    setPendingQuestion(request);
  }), []);

  const finishQuestion = (response: AgentClarificationResponse) => {
    const resolver = questionResolverRef.current;
    questionResolverRef.current = null;
    setPendingQuestion(null);
    resolver?.(response);
  };

  const send = async () => {
    const content = input.trim();
    if (!project || !activeSession || !selection || !content || sending) return;
    const sessionId = activeSession.id;
    const requestId = sendRequestRef.current + 1;
    sendRequestRef.current = requestId;
    const isCurrentRequest = () => sendRequestRef.current === requestId;
    setSending(true);
    setError(null);
    setInput("");
    setLiveTrace(null);
    let userMessageSaved = false;
    let latestTrace: AgentRunTrace | null = null;
    try {
      const userMessage = await addMessage(sessionId, "user", content);
      userMessageSaved = true;
      const nextHistory = [...messages, userMessage];
      if (!isCurrentRequest()) return;
      setMessages(nextHistory);
      const updatedSession = {
        ...activeSession,
        title: activeSession.title === "新对话" ? generatedSessionTitle(content) : activeSession.title,
        updatedAt: userMessage.createdAt,
      };
      setActiveSession(updatedSession);
      setSessions((current) => [updatedSession, ...current.filter((session) => session.id !== updatedSession.id)]);
      const response = await runAgent({
        project,
        selection,
        history: nextHistory,
        approveTool: requestToolApproval,
        askUser,
        onTrace: (trace) => {
          latestTrace = trace;
          setLiveTrace(trace);
          requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
        },
      });
      const assistantMessage = await addMessage(sessionId, "assistant", response.content, { agentTrace: response.trace });
      if (!isCurrentRequest()) return;
      setMessages((current) => [...current, assistantMessage]);
      setLiveTrace(null);
      refreshData();
      requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
    } catch (sendError) {
      const errorMessage = sendError instanceof Error ? sendError.message : String(sendError);
      if (isCurrentRequest()) setError(errorMessage);
      const failedTrace = sendError instanceof AgentRunError ? sendError.trace : latestTrace;
      if (userMessageSaved && failedTrace) {
        try {
          const failedMessage = await addMessage(
            sessionId,
            "assistant",
            "任务未完成：" + errorMessage,
            { agentTrace: failedTrace },
          );
          if (isCurrentRequest()) {
            setMessages((current) => [...current, failedMessage]);
            refreshData();
          }
        } catch {
        }
      }
      if (isCurrentRequest()) {
        setLiveTrace(null);
        if (!userMessageSaved) setInput(content);
      }
    } finally {
      if (isCurrentRequest()) setSending(false);
    }
  };

  if (!projectId) return <Screen><EmptyState title="请先从书架选择一部作品" /></Screen>;
  if (loading) return <Screen><Header title="创作助手" /><View style={styles.loading}><ActivityIndicator color={colors.primary} /></View></Screen>;

  return (
    <Screen>
      <Header
        title="创作助手"
        action={
          <View style={styles.headerActions}>
            <Pressable accessibilityLabel="新建对话" disabled={sending} onPress={() => void newSession()} style={styles.iconButton}>
              <Ionicons name="create-outline" size={22} color={colors.primary} />
            </Pressable>
            <Pressable accessibilityLabel="管理对话" disabled={sending} onPress={() => setSessionPickerVisible(true)} style={styles.iconButton}>
              <Ionicons name="chatbubbles-outline" size={22} color={colors.primary} />
            </Pressable>
          </View>
        }
      />
      <View style={styles.contextBar}>
        <View style={styles.projectContext}>
          <Ionicons name="book-outline" size={19} color={colors.primary} />
          <View style={styles.projectCopy}>
            <Text style={styles.projectTitle} numberOfLines={1}>{project?.title ?? "当前作品"}</Text>
            <Text style={styles.agentLabel} numberOfLines={1}>{activeAgentName} 主智能体</Text>
          </View>
        </View>
        <Pressable
          accessibilityLabel="切换助手模型"
          disabled={!models.length || sending}
          onPress={() => setModelPickerVisible(true)}
          style={styles.modelSelector}
        >
          <Ionicons name="hardware-chip-outline" size={17} color={selection ? colors.primary : colors.textMuted} />
          <Text style={[styles.modelSelectorText, !selection && styles.mutedText]} numberOfLines={1}>
            {selection?.model.name ?? "选择模型"}
          </Text>
          <Ionicons name="chevron-down" size={16} color={colors.textMuted} />
        </Pressable>
      </View>
      <Pressable accessibilityRole="button" disabled={sending} onPress={() => setSessionPickerVisible(true)} style={styles.sessionSelector}>
        <Ionicons name="chatbubble-outline" size={17} color={colors.textMuted} />
        <Text style={styles.sessionTitle} numberOfLines={1}>{activeSession?.title ?? "新对话"}</Text>
        <Text style={styles.sessionTime}>{activeSession ? formatSessionTime(activeSession.updatedAt) : ""}</Text>
        <Ionicons name="chevron-down" size={16} color={colors.textMuted} />
      </Pressable>
      <KeyboardAvoidingView style={styles.flex} behavior="height" automaticOffset>
        <FlatList
          ref={listRef}
          style={styles.flex}
          data={messages}
          keyExtractor={(item) => item.id}
          contentContainerStyle={messages.length ? styles.messages : styles.emptyMessages}
          ListFooterComponent={liveTrace ? (
            <View style={styles.liveTrace}>
              <AgentTraceView trace={liveTrace} defaultExpanded />
            </View>
          ) : null}
          ListEmptyComponent={models.length ? (
            <EmptyState title="告诉助手你想续写、修改或检索什么" />
          ) : (
            <EmptyState title="请先配置供应商并添加模型" action={<Button label="打开模型设置" onPress={() => navigation.navigate("Settings")} />} />
          )}
          renderItem={({ item }) => (
            <View style={[styles.message, item.role === "user" ? styles.userMessage : styles.assistantMessage]}>
              <Text style={styles.messageRole}>{item.role === "user" ? "你" : "OpenFicM"}</Text>
              {item.metadata?.agentTrace ? <AgentTraceView trace={item.metadata.agentTrace} /> : null}
              <Text selectable style={styles.messageText}>{item.content}</Text>
            </View>
          )}
        />
        {error ? <View style={styles.errorWrap}><ErrorNotice message={error} onRetry={() => void load()} /></View> : null}
        <View style={styles.composer}>
          <TextInput
            value={input}
            onChangeText={setInput}
            style={styles.composerInput}
            placeholder="输入创作任务"
            placeholderTextColor={colors.textMuted}
            editable={!sending}
            multiline
            maxLength={12000}
          />
          <Pressable
            accessibilityLabel="发送"
            disabled={!selection || !input.trim() || sending}
            onPress={() => void send()}
            style={({ pressed }) => [styles.sendButton, (pressed || !selection || !input.trim()) && styles.sendDisabled]}
          >
            {sending ? <ActivityIndicator color="#FFFFFF" /> : <Ionicons name="arrow-up" size={22} color="#FFFFFF" />}
          </Pressable>
        </View>
      </KeyboardAvoidingView>

      <Modal visible={sessionPickerVisible} transparent animationType="slide" onRequestClose={() => setSessionPickerVisible(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setSessionPickerVisible(false)}>
          <View style={styles.sheet} onStartShouldSetResponder={() => true}>
            <View style={styles.sheetHeader}>
              <View style={styles.sheetTitleWrap}>
                <Text style={styles.sheetTitle} numberOfLines={1}>{project?.title ?? "当前作品"}</Text>
                <Text style={styles.sheetSubtitle}>{sessions.length} 个对话</Text>
              </View>
              <Pressable accessibilityLabel="新建对话" onPress={() => void newSession()} style={styles.iconButton}>
                <Ionicons name="add" size={25} color={colors.primary} />
              </Pressable>
              <Pressable accessibilityLabel="关闭对话列表" onPress={() => setSessionPickerVisible(false)} style={styles.iconButton}>
                <Ionicons name="close" size={24} color={colors.textMuted} />
              </Pressable>
            </View>
            <FlatList
              data={sessions}
              keyExtractor={(item) => item.id}
              contentContainerStyle={styles.sheetList}
              renderItem={({ item }) => {
                const sessionModelId = item.modelId ?? defaultModelId;
                const sessionModel = models.find((model) => model.id === sessionModelId);
                const selected = item.id === activeSession?.id;
                return (
                  <Pressable onPress={() => void switchSession(item)} style={[styles.sheetRow, selected && styles.sheetRowActive]}>
                    <Ionicons name={selected ? "radio-button-on" : "radio-button-off"} size={20} color={selected ? colors.primary : colors.textMuted} />
                    <View style={styles.sheetRowText}>
                      <Text style={styles.sheetRowTitle} numberOfLines={1}>{item.title}</Text>
                      <Text style={styles.sheetRowMeta} numberOfLines={1}>{sessionModel?.name ?? "未选择模型"} · {formatSessionTime(item.updatedAt)}</Text>
                    </View>
                    <Pressable accessibilityLabel={`删除对话 ${item.title}`} onPress={(event) => { event.stopPropagation(); confirmDeleteSession(item); }} style={styles.iconButton}>
                      <Ionicons name="trash-outline" size={19} color={colors.danger} />
                    </Pressable>
                  </Pressable>
                );
              }}
            />
          </View>
        </Pressable>
      </Modal>

      <Modal visible={modelPickerVisible} transparent animationType="slide" onRequestClose={() => setModelPickerVisible(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setModelPickerVisible(false)}>
          <View style={styles.sheet} onStartShouldSetResponder={() => true}>
            <View style={styles.sheetHeader}>
              <View style={styles.sheetTitleWrap}>
                <Text style={styles.sheetTitle}>选择模型</Text>
                <Text style={styles.sheetSubtitle}>仅用于当前对话</Text>
              </View>
              <Pressable accessibilityLabel="关闭模型列表" onPress={() => setModelPickerVisible(false)} style={styles.iconButton}>
                <Ionicons name="close" size={24} color={colors.textMuted} />
              </Pressable>
            </View>
            <FlatList
              data={models}
              keyExtractor={(item) => item.id}
              contentContainerStyle={styles.sheetList}
              ListHeaderComponent={
                <Pressable onPress={() => void chooseModel(null)} style={[styles.sheetRow, activeSession?.modelId === null && styles.sheetRowActive]}>
                  <Ionicons name={activeSession?.modelId === null ? "radio-button-on" : "radio-button-off"} size={20} color={activeSession?.modelId === null ? colors.primary : colors.textMuted} />
                  <View style={styles.sheetRowText}>
                    <Text style={styles.sheetRowTitle}>跟随主智能体或全局模型</Text>
                    <Text style={styles.sheetRowMeta}>{models.find((model) => model.id === defaultModelId)?.name ?? "尚未设置默认模型"}</Text>
                  </View>
                </Pressable>
              }
              renderItem={({ item }) => {
                const selected = activeSession?.modelId === item.id;
                const provider = providerById.get(item.providerId);
                return (
                  <Pressable onPress={() => void chooseModel(item.id)} style={[styles.sheetRow, selected && styles.sheetRowActive]}>
                    <Ionicons name={selected ? "radio-button-on" : "radio-button-off"} size={20} color={selected ? colors.primary : colors.textMuted} />
                    <View style={styles.sheetRowText}>
                      <Text style={styles.sheetRowTitle} numberOfLines={1}>{item.name}</Text>
                      <Text style={styles.sheetRowMeta} numberOfLines={1}>{provider?.name ?? "未知供应商"} · {item.modelId}</Text>
                    </View>
                  </Pressable>
                );
              }}
            />
          </View>
        </Pressable>
      </Modal>
      <AgentQuestionSheet
        request={pendingQuestion}
        onSubmit={(answers) => finishQuestion({ answers, cancelled: false })}
        onCancel={() => finishQuestion({ answers: [], cancelled: true })}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  loading: { flex: 1, alignItems: "center", justifyContent: "center" },
  headerActions: { flexDirection: "row", alignItems: "center" },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  contextBar: {
    minHeight: 50,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  projectContext: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: spacing.sm },
  projectCopy: { flex: 1, minWidth: 0, gap: 2 },
  projectTitle: { flex: 1, color: colors.text, fontSize: 15, fontWeight: "700" },
  agentLabel: { color: colors.textMuted, fontSize: 11 },
  modelSelector: {
    maxWidth: "48%",
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: spacing.xs,
  },
  modelSelectorText: { flexShrink: 1, color: colors.primary, fontSize: 13, fontWeight: "700" },
  mutedText: { color: colors.textMuted },
  sessionSelector: {
    minHeight: 42,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  sessionTitle: { flex: 1, color: colors.text, fontSize: 13, fontWeight: "600" },
  sessionTime: { color: colors.textMuted, fontSize: 11 },
  errorWrap: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  messages: { padding: spacing.lg, gap: spacing.md },
  liveTrace: { marginTop: spacing.md },
  emptyMessages: { flexGrow: 1 },
  message: { gap: spacing.md, paddingVertical: spacing.md },
  userMessage: { marginLeft: 42, paddingHorizontal: spacing.md, borderRadius: radius.md, backgroundColor: colors.surfaceMuted },
  assistantMessage: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  messageRole: { color: colors.primary, fontSize: 12, fontWeight: "700" },
  messageText: { color: colors.text, fontSize: 16, lineHeight: 24 },
  composer: { flexDirection: "row", alignItems: "flex-end", gap: spacing.sm, padding: spacing.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, backgroundColor: colors.surface },
  composerInput: { flex: 1, maxHeight: 130, minHeight: 46, paddingHorizontal: spacing.md, paddingVertical: 11, borderRadius: radius.md, backgroundColor: colors.surfaceMuted, color: colors.text, fontSize: 16 },
  sendButton: { width: 46, height: 46, borderRadius: 23, alignItems: "center", justifyContent: "center", backgroundColor: colors.primary },
  sendDisabled: { opacity: 0.48 },
  modalBackdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: colors.overlay },
  sheet: {
    maxHeight: "80%",
    paddingBottom: spacing.xl,
    borderTopLeftRadius: radius.md,
    borderTopRightRadius: radius.md,
    backgroundColor: colors.background,
  },
  sheetHeader: {
    minHeight: 64,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  sheetTitleWrap: { flex: 1, minWidth: 0 },
  sheetTitle: { color: colors.text, fontSize: 18, fontWeight: "700" },
  sheetSubtitle: { marginTop: 2, color: colors.textMuted, fontSize: 12 },
  sheetList: { paddingBottom: spacing.xl },
  sheetRow: {
    minHeight: 62,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingLeft: spacing.lg,
    paddingRight: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  sheetRowActive: { backgroundColor: colors.surfaceMuted },
  sheetRowText: { flex: 1, minWidth: 0 },
  sheetRowTitle: { color: colors.text, fontSize: 15, fontWeight: "600" },
  sheetRowMeta: { marginTop: 3, color: colors.textMuted, fontSize: 12 },
});
