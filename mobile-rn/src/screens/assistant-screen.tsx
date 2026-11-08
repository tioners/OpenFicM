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
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";

import { AgentRunError, runAgent } from "@/agent/runtime";
import { AgentQuestionSheet, AgentTraceView } from "@/components/agent-run-view";
import { MessageActionBar } from "@/components/message-action-bar";
import { MarkdownView } from "@/components/markdown-view";
import { Button, EmptyState, ErrorNotice, Header, Screen, SheetBackdrop } from "@/components/ui";
import { StyleProfilePickerSheet } from "@/components/style-profile-picker";
import { styleProfileLabel } from "@/lib/style-label";
import {
  addMessage,
  createChatSession,
  deleteChatSession,
  deleteMessagesFrom,
  getProject,
  getProviderApiKey,
  getSetting,
  listChatSessions,
  listMessages,
  listModels,
  listProviders,
  replaceUserMessageBranch,
  setSetting,
  updateChatSession,
} from "@/data/repositories";
import {
  getActiveStyleProfile,
  setActiveStyleProfile,
} from "@/data/style-repositories";
import type { RootTabParamList } from "@/navigation/types";
import { getAgentDefinitions } from "@/settings/config";
import { listStyleProfileOptions, type StyleProfileOption } from "@/style/profile-options";
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
  StyleProfile,
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

type RetryRequest = {
  sessionId: string;
  userMessage: ChatMessage;
  history: ChatMessage[];
  sourceMessageId: string;
  modelId: string;
  agentId: string | null;
};

function humanizeAgentError(error: unknown): { message: string; detail: string } {
  const detail = error instanceof Error ? error.message : String(error);
  const normalized = detail.toLowerCase();
  if (/sslhandshake|ssl handshake|certificate|connection closed/.test(normalized)) {
    return { message: "网络连接异常（SSL 握手失败），请检查网络环境或供应商配置后重试", detail };
  }
  if (/timeout|timed out|aborterror|请求超时/.test(normalized)) {
    return { message: "模型请求超时，请检查网络或供应商配置后重试", detail };
  }
  if (/fetch failed|network request failed|unable to connect|cannot connect/.test(normalized)) {
    return { message: "网络连接异常，请检查网络、Base URL 和证书设置后重试", detail };
  }
  if (/\bhttp\s*400\b|\b400\s*:/.test(normalized)) {
    return { message: "供应商拒绝了本次请求（400），请检查模型工具调用兼容性后重试", detail };
  }
  if (/\bhttp\s*429\b|\b429\s*:/.test(normalized)) {
    return { message: "供应商暂时限流（429），请稍后重试或更换模型", detail };
  }
  return { message: detail, detail };
}

function retryRequestForMessage(
  message: ChatMessage,
  messages: ChatMessage[],
  session: ChatSession | null,
  selection: ModelSelection | null,
  agentId: string | null,
): RetryRequest | null {
  if (!session || message.role !== "assistant") return null;
  const messageIndex = messages.findIndex((item) => item.id === message.id);
  if (messageIndex < 0) return null;
  const context = message.metadata?.retryContext;
  const userIndex = context
    ? messages.findIndex((item) => item.id === context.userMessageId && item.role === "user")
    : messages.slice(0, messageIndex).map((item) => item.role).lastIndexOf("user");
  if (userIndex < 0 || userIndex >= messageIndex) return null;
  const userMessage = messages[userIndex];
  return {
    sessionId: session.id,
    userMessage,
    history: messages.slice(0, userIndex + 1),
    sourceMessageId: message.id,
    modelId: context?.modelId ?? session.modelId ?? selection?.model.id ?? "",
    agentId: context?.agentId ?? agentId,
  };
}

function ErrorDetails({ detail }: { detail: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <View style={styles.errorDetails}>
      <Pressable accessibilityRole="button" onPress={() => setExpanded((value) => !value)} style={styles.errorDetailsToggle}>
        <Text style={styles.errorDetailsLabel}>原始错误详情</Text>
        <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={15} color={colors.textMuted} />
      </Pressable>
      {expanded ? <Text selectable style={styles.errorDetailsText}>{detail}</Text> : null}
    </View>
  );
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
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [activeAgentName, setActiveAgentName] = useState("Build");
  const [styleOptions, setStyleOptions] = useState<StyleProfileOption[]>([]);
  const [activeStyleProfile, setActiveStyleProfileState] = useState<StyleProfile | null>(null);
  const [selection, setSelection] = useState<ModelSelection | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sessionPickerVisible, setSessionPickerVisible] = useState(false);
  const [modelPickerVisible, setModelPickerVisible] = useState(false);
  const [stylePickerVisible, setStylePickerVisible] = useState(false);
  const [updatingStyle, setUpdatingStyle] = useState(false);
  const [liveTrace, setLiveTrace] = useState<AgentRunTrace | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState<AgentClarificationRequest | null>(null);
  const [retryRequest, setRetryRequest] = useState<RetryRequest | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const composerRef = useRef<TextInput>(null);
  const loadRequestRef = useRef(0);
  const sendRequestRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const questionResolverRef = useRef<((response: AgentClarificationResponse) => void) | null>(null);
  // 滚动状态：loadedProjectRef 区分“首次进入作品”和“回到页面/任务完成的静默刷新”；
  // pinToBottomRef 是“内容布局完成后定位到底部”的一次性标记，由 onContentSizeChange 消费。
  const loadedProjectRef = useRef<string | null>(null);
  const atBottomRef = useRef(true);
  const pinToBottomRef = useRef(true);
  const providerById = useMemo(() => new Map(providers.map((provider) => [provider.id, provider])), [providers]);

  const cancelPendingQuestion = useCallback(() => {
    const resolver = questionResolverRef.current;
    questionResolverRef.current = null;
    setPendingQuestion(null);
    resolver?.({ answers: [], cancelled: true });
  }, []);

  // 长对话滚动：只有主动定位（进入、切换会话、发送、点“回到最新消息”）才强制到底部；
  // 智能体运行中的自动跟随仅在用户已停留在底部时生效，翻阅历史时绝不抢滚动位置。
  const scrollToBottom = useCallback((animated: boolean) => {
    pinToBottomRef.current = true;
    atBottomRef.current = true;
    setShowJumpToBottom(false);
    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated }));
  }, []);

  const handleListScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    // 距底部 120px 以内视为“在底部”，跟随滚动只在这个范围内生效。
    const atBottom = contentSize.height - contentOffset.y - layoutMeasurement.height <= 120;
    atBottomRef.current = atBottom;
    if (!atBottom) pinToBottomRef.current = false;
    setShowJumpToBottom(!atBottom);
  }, []);

  const handleListContentSizeChange = useCallback(() => {
    if (!pinToBottomRef.current) return;
    pinToBottomRef.current = false;
    listRef.current?.scrollToEnd({ animated: false });
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
      setActiveAgentId(null);
      setActiveAgentName("Build");
      setStyleOptions([]);
      setActiveStyleProfileState(null);
      setSelection(null);
      setLiveTrace(null);
      loadedProjectRef.current = null;
      pinToBottomRef.current = true;
      atBottomRef.current = true;
      setShowJumpToBottom(false);
      cancelPendingQuestion();
      setLoading(false);
      return;
    }
    // 同一作品内的再次加载（回到页面、任务完成后刷新）不再进入整屏 loading，
    // 否则 FlatList 被卸载重建，长对话每次都会被顶回顶部。
    if (loadedProjectRef.current !== projectId) {
      setLoading(true);
      pinToBottomRef.current = true;
      atBottomRef.current = true;
      setShowJumpToBottom(false);
    }
    setError(null);
    try {
      const [
        nextProject,
        storedSessions,
        preferredSessionId,
        activeModelId,
        nextModels,
        nextProviders,
        activeAgentId,
        agents,
        nextStyleOptions,
        nextActiveStyleProfile,
      ] = await Promise.all([
        getProject(projectId),
        listChatSessions(projectId),
        getSetting(activeSessionSettingKey(projectId)),
        getSetting("activeModelId"),
        listModels(),
        listProviders(),
        getSetting("agent.activeDefinitionId"),
        getAgentDefinitions(),
        listStyleProfileOptions(projectId),
        getActiveStyleProfile(projectId),
      ]);
      if (!nextProject) throw new Error("作品不存在");
      const activeAgent = agents.find((agent) => agent.id === activeAgentId && agent.enabled && agent.kind === "primary")
        ?? agents.find((agent) => agent.id === "builtin-agent--build" && agent.enabled)
        ?? agents.find((agent) => agent.enabled && agent.kind === "primary");
      const nextDefaultModelId = nextModels.find((model) => model.id === activeAgent?.modelId)?.id
        ?? nextModels.find((model) => model.id === activeModelId)?.id
        ?? null;
      if (activeModelId && !nextModels.some((model) => model.id === activeModelId)) {
        await setSetting("activeModelId", "");
      }
      let nextSessions = storedSessions;
      let nextSession = nextSessions.find((session) => session.id === preferredSessionId) ?? nextSessions[0] ?? null;
      if (!nextSession) {
        nextSession = await createChatSession(projectId, nextDefaultModelId);
        nextSessions = [nextSession];
      }
      const selectedModelId = nextModels.some((model) => model.id === nextSession?.modelId)
        ? nextSession.modelId
        : nextDefaultModelId;
      if (nextSession.modelId !== selectedModelId) {
        nextSession = await updateChatSession({ id: nextSession.id, modelId: selectedModelId });
        nextSessions = nextSessions.map((session) => session.id === nextSession?.id ? nextSession as ChatSession : session);
      }
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
      if (loadedProjectRef.current !== projectId) {
        // 进入作品时定位到最新消息，而不是停在最早的历史。
        loadedProjectRef.current = projectId;
        scrollToBottom(false);
      }
      const lastFailed = [...nextMessages].reverse().find((message) => message.role === "assistant" && (message.metadata?.taskStatus === "failed" || message.metadata?.agentTrace?.status === "error"));
      setRetryRequest(lastFailed ? retryRequestForMessage(lastFailed, nextMessages, nextSession, nextSelection, activeAgent?.id ?? null) : null);
      setModels(nextModels);
      setProviders(nextProviders);
      setDefaultModelId(nextDefaultModelId);
      setActiveAgentId(activeAgent?.id ?? null);
      setActiveAgentName(activeAgent?.name ?? "Build");
      setStyleOptions(nextStyleOptions);
      setActiveStyleProfileState(nextActiveStyleProfile);
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
  }, [cancelPendingQuestion, projectId, scrollToBottom]);

  useEffect(() => {
    // 切换作品：中止还在运行的智能体，避免它继续弹旧作品的审批框、消耗预算或写旧作品。
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    cancelPendingQuestion();
    setSending(false);
    setLiveTrace(null);
    return () => {
      sendRequestRef.current += 1;
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      cancelPendingQuestion();
    };
  }, [cancelPendingQuestion, projectId]);

  useEffect(() => {
    setInput("");
    setEditingMessageId(null);
  }, [activeSession?.id]);
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
      const lastFailed = [...nextMessages].reverse().find((message) => message.role === "assistant" && (message.metadata?.taskStatus === "failed" || message.metadata?.agentTrace?.status === "error"));
      setRetryRequest(lastFailed ? retryRequestForMessage(lastFailed, nextMessages, session, nextSelection, activeAgentId) : null);
      setSelection(nextSelection);
      setError(selectionError);
      setSessionPickerVisible(false);
      scrollToBottom(false);
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
      setRetryRequest(null);
      setSessionPickerVisible(false);
      scrollToBottom(false);
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

  const chooseStyle = async (profile: StyleProfile | null) => {
    if (!projectId || sending || updatingStyle) return;
    setUpdatingStyle(true);
    setError(null);
    try {
      await setActiveStyleProfile(projectId, profile?.id ?? null);
      setActiveStyleProfileState(profile);
      setStylePickerVisible(false);
    } catch (styleError) {
      setError(styleError instanceof Error ? styleError.message : String(styleError));
    } finally {
      setUpdatingStyle(false);
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
      setRetryRequest(null);
      scrollToBottom(false);
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

  const beginEditMessage = (message: ChatMessage) => {
    if (sending || message.role !== "user") return;
    setError(null);
    setRetryRequest(null);
    setEditingMessageId(message.id);
    setInput(message.content);
    requestAnimationFrame(() => composerRef.current?.focus());
  };

  const cancelMessageEdit = () => {
    setEditingMessageId(null);
    setInput("");
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

  const stopSending = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    cancelPendingQuestion();
  }, [cancelPendingQuestion]);

  const send = async (retry: RetryRequest | null = null) => {
    const content = retry?.userMessage.content ?? input.trim();
    const editTarget = !retry && editingMessageId
      ? messages.find((message) => message.id === editingMessageId && message.role === "user") ?? null
      : null;
    if (!project || !activeSession || !content || sending) return;
    if (retry && (retry.sessionId !== activeSession.id || !messages.some((message) => message.id === retry.userMessage.id))) {
      setRetryRequest(null);
      setError("重试消息已不在当前对话中，请重新发送");
      return;
    }
    const sessionId = activeSession.id;
    const requestId = sendRequestRef.current + 1;
    sendRequestRef.current = requestId;
    const isCurrentRequest = () => sendRequestRef.current === requestId;
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setSending(true);
    setError(null);
    setInput("");
    setLiveTrace(null);
    let userMessage = retry?.userMessage ?? null;
    let nextHistory = retry?.history ?? [];
    let userMessageSaved = Boolean(userMessage);
    let workingSession = activeSession;
    let latestTrace: AgentRunTrace | null = null;
    let runSelection: ModelSelection | null = selection;
    try {
      // 当前选中的模型优先。失败消息里记录的 modelId 只作兜底，
      // 否则用户换了可用模型后点重试仍会打回那个出错的旧模型。
      runSelection = selection
        ?? (retry?.modelId ? await resolveSelection(retry.modelId, models, providers) : null);
      if (!runSelection) throw new Error("请先配置可用模型");
      if (retry?.sourceMessageId) {
        await deleteMessagesFrom(sessionId, retry.sourceMessageId);
        if (!isCurrentRequest()) return;
        setMessages((current) => {
          const sourceIndex = current.findIndex((message) => message.id === retry.sourceMessageId);
          return sourceIndex < 0 ? current : current.slice(0, sourceIndex);
        });
      }
      if (!retry) {
        let baseHistory = messages;
        if (editTarget) {
          const editIndex = messages.findIndex((message) => message.id === editTarget.id);
          if (editIndex < 0) throw new Error("要编辑的消息不存在");
          const replacement = await replaceUserMessageBranch(sessionId, editTarget.id, content);
          userMessage = replacement.message;
          userMessageSaved = true;
          baseHistory = messages.slice(0, editIndex);
          nextHistory = [...baseHistory, userMessage];
          workingSession = replacement.session;
          setEditingMessageId(null);
        } else {
          userMessage = await addMessage(sessionId, "user", content);
          userMessageSaved = true;
          nextHistory = [...baseHistory, userMessage];
          workingSession = {
            ...workingSession,
            title: workingSession.title === "新对话" ? generatedSessionTitle(content) : workingSession.title,
            updatedAt: userMessage.createdAt,
          };
        }
        if (!isCurrentRequest()) return;
        setMessages(nextHistory);
        scrollToBottom(false);
        setActiveSession(workingSession);
        setSessions((current) => [workingSession, ...current.filter((session) => session.id !== workingSession.id)]);
      }
      if (!userMessage) throw new Error("消息准备失败，请重试");
      const response = await runAgent({
        project,
        selection: runSelection,
        history: nextHistory,
        agentId: retry?.agentId ?? activeAgentId,
        approveTool: requestToolApproval,
        askUser,
        signal: controller.signal,
        onTrace: (trace) => {
          latestTrace = trace;
          setLiveTrace(trace);
          if (atBottomRef.current) scrollToBottom(false);
        },
      });
      const assistantMessage = await addMessage(sessionId, "assistant", response.content, {
        agentTrace: response.trace,
        taskStatus: "completed",
        retryContext: { userMessageId: userMessage.id, modelId: runSelection.model.id, agentId: retry?.agentId ?? activeAgentId },
      });
      if (!isCurrentRequest()) return;
      setMessages((current) => {
        if (!retry) return [...current, assistantMessage];
        const sourceIndex = current.findIndex((message) => message.id === retry.sourceMessageId);
        return sourceIndex < 0 ? [...current, assistantMessage] : [...current.slice(0, sourceIndex), assistantMessage];
      });
      setRetryRequest(null);
      setLiveTrace(null);
      refreshData();
      if (atBottomRef.current) scrollToBottom(false);
    } catch (sendError) {
      const friendlyError = humanizeAgentError(sendError);
      if (isCurrentRequest()) setError(friendlyError.message);
      const failedTrace = sendError instanceof AgentRunError ? sendError.trace : latestTrace;
      const retryModelId = runSelection?.model.id ?? retry?.modelId ?? activeSession.modelId ?? "";
      if (userMessageSaved && userMessage) {
        try {
          const failedMessage = await addMessage(
            sessionId,
            "assistant",
            "任务未完成：" + friendlyError.message,
            {
              agentTrace: failedTrace ?? undefined,
              taskStatus: "failed",
              errorMessage: friendlyError.message,
              errorDetail: friendlyError.detail,
              retryContext: { userMessageId: userMessage.id, modelId: retryModelId, agentId: retry?.agentId ?? activeAgentId },
            },
          );
          if (isCurrentRequest()) {
            setMessages((current) => [...current, failedMessage]);
            if (atBottomRef.current) scrollToBottom(false);
            setRetryRequest({ sessionId, userMessage, history: nextHistory, sourceMessageId: failedMessage.id, modelId: retryModelId, agentId: retry?.agentId ?? activeAgentId });
            refreshData();
          }
        } catch {
          if (isCurrentRequest()) setRetryRequest({ sessionId, userMessage, history: nextHistory, sourceMessageId: retry?.sourceMessageId ?? "", modelId: retryModelId, agentId: retry?.agentId ?? activeAgentId });
        }
      }
      if (isCurrentRequest()) {
        setLiveTrace(null);
        setInput(content);
      }
    } finally {
      if (abortControllerRef.current === controller) abortControllerRef.current = null;
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
      <Pressable
        accessibilityRole="button"
        disabled={sending || updatingStyle}
        onPress={() => setStylePickerVisible(true)}
        style={styles.styleSelector}
      >
        {updatingStyle ? (
          <ActivityIndicator size="small" color={colors.primary} />
        ) : (
          <Ionicons name="color-wand-outline" size={17} color={activeStyleProfile ? colors.primary : colors.textMuted} />
        )}
        <Text style={[styles.styleSelectorText, activeStyleProfile && styles.styleSelectorTextActive]} numberOfLines={1}>
          {activeStyleProfile ? styleProfileLabel(activeStyleProfile) : "不使用创作文风"}
        </Text>
        <Ionicons name="chevron-down" size={16} color={colors.textMuted} />
      </Pressable>
      <Pressable accessibilityRole="button" disabled={sending} onPress={() => setSessionPickerVisible(true)} style={styles.sessionSelector}>
        <Ionicons name="chatbubble-outline" size={17} color={colors.textMuted} />
        <Text style={styles.sessionTitle} numberOfLines={1}>{activeSession?.title ?? "新对话"}</Text>
        <Text style={styles.sessionTime}>{activeSession ? formatSessionTime(activeSession.updatedAt) : ""}</Text>
        <Ionicons name="chevron-down" size={16} color={colors.textMuted} />
      </Pressable>
      <KeyboardAvoidingView style={styles.flex} behavior="height" automaticOffset>
        <View style={styles.flex}>
          <FlatList
            ref={listRef}
            style={styles.flex}
            data={messages}
            keyExtractor={(item) => item.id}
            contentContainerStyle={messages.length ? styles.messages : styles.emptyMessages}
            onScroll={handleListScroll}
            scrollEventThrottle={16}
            onContentSizeChange={handleListContentSizeChange}
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
                {(() => {
                  const messageRetry = retryRequestForMessage(item, messages, activeSession, selection, activeAgentId);
                  const failed = item.role === "assistant" && (item.metadata?.taskStatus === "failed" || item.metadata?.agentTrace?.status === "error");
                  return (
                    <>
                <View style={styles.messageHeader}>
                  <Text style={styles.messageRole}>{item.role === "user" ? "你" : "OpenFicM"}</Text>
                  {item.role === "user" ? (
                    <Pressable accessibilityLabel="编辑这条消息" disabled={sending} onPress={() => beginEditMessage(item)} style={styles.messageEditButton}>
                      <Ionicons name="create-outline" size={17} color={colors.primary} />
                      <Text style={styles.messageEditText}>编辑</Text>
                    </Pressable>
                  ) : null}
                </View>
                {item.metadata?.agentTrace ? (
                  <AgentTraceView
                    trace={item.metadata.agentTrace}
                    onRetry={failed && messageRetry ? () => void send(messageRetry) : undefined}
                    retryDisabled={sending}
                  />
                ) : failed ? (
                  <View style={styles.failureCard}>
                    <Text style={styles.failureTitle}>执行失败</Text>
                    {messageRetry ? (
                      <Pressable accessibilityRole="button" disabled={sending} onPress={() => void send(messageRetry)} style={[styles.failureRetry, sending && styles.failureRetryDisabled]}>
                        <Ionicons name="refresh-outline" size={17} color={colors.danger} />
                        <Text style={styles.failureRetryText}>{sending ? "处理中" : "重试"}</Text>
                      </Pressable>
                    ) : null}
                  </View>
                ) : null}
                {item.role === "assistant" ? (
                  // 助手回复按 Markdown 渲染；用户消息保持纯文本，避免把 "1. " 这类输入擅自变成列表。
                  item.content.trim()
                    ? <MarkdownView content={item.content} />
                    : <Text selectable style={styles.messageText}>{item.content}</Text>
                ) : (
                  <Text selectable style={styles.messageText}>{item.content}</Text>
                )}
                {failed && item.metadata?.errorDetail ? <ErrorDetails detail={item.metadata.errorDetail} /> : null}
                {item.role === "assistant" && messageRetry ? (
                  <MessageActionBar content={item.content} onRetry={() => void send(messageRetry)} retryDisabled={sending} />
                ) : null}
                    </>
                  );
                })()}
              </View>
            )}
          />
          {showJumpToBottom ? (
            <Pressable accessibilityRole="button" accessibilityLabel="回到最新消息" onPress={() => scrollToBottom(true)} style={styles.jumpToBottom}>
              <Ionicons name="arrow-down" size={22} color={colors.primary} />
            </Pressable>
          ) : null}
        </View>
        {error ? <View style={styles.errorWrap}><ErrorNotice message={error} onRetry={retryRequest ? () => void send(retryRequest) : () => void load()} /></View> : null}
        <View style={styles.composer}>
          {editingMessageId ? (
            <View style={styles.editingBanner}>
              <View style={styles.editingCopy}>
                <Ionicons name="create-outline" size={17} color={colors.primary} />
                <Text style={styles.editingText}>正在编辑之前的发言</Text>
              </View>
              <Pressable accessibilityLabel="取消编辑" onPress={cancelMessageEdit} style={styles.iconButton}>
                <Ionicons name="close" size={20} color={colors.textMuted} />
              </Pressable>
            </View>
          ) : null}
          <View style={styles.composerRow}>
            <TextInput
              ref={composerRef}
              value={input}
              onChangeText={setInput}
              style={styles.composerInput}
              placeholder={editingMessageId ? "修改后重新发送" : "输入创作任务"}
              placeholderTextColor={colors.textMuted}
              editable={!sending}
              multiline
              maxLength={12000}
            />
            <Pressable
              accessibilityLabel={sending ? "停止生成" : editingMessageId ? "重发编辑后的消息" : "发送"}
              disabled={sending ? false : !selection || !input.trim()}
              onPress={() => {
                if (sending) stopSending();
                else void send(retryRequest && input.trim() === retryRequest.userMessage.content ? retryRequest : null);
              }}
              style={({ pressed }) => [
                styles.sendButton,
                sending && styles.stopButton,
                (pressed || (!sending && (!selection || !input.trim()))) && styles.sendDisabled,
              ]}
            >
              {sending ? <Ionicons name="stop" size={20} color="#FFFFFF" /> : <Ionicons name="arrow-up" size={22} color="#FFFFFF" />}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>

      <Modal visible={sessionPickerVisible} transparent animationType="slide" onRequestClose={() => setSessionPickerVisible(false)}>
        <SheetBackdrop onPress={() => setSessionPickerVisible(false)}>
          <View style={styles.sheet}>
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
              style={styles.sheetListScroll}
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
        </SheetBackdrop>
      </Modal>

      <Modal visible={modelPickerVisible} transparent animationType="slide" onRequestClose={() => setModelPickerVisible(false)}>
        <SheetBackdrop onPress={() => setModelPickerVisible(false)}>
          <View style={styles.sheet}>
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
              style={styles.sheetListScroll}
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
        </SheetBackdrop>
      </Modal>
      <StyleProfilePickerSheet
        visible={stylePickerVisible}
        subtitle={project?.title ?? "当前作品"}
        options={styleOptions}
        activeProfileId={activeStyleProfile?.id ?? null}
        onSelect={(profile) => void chooseStyle(profile)}
        onClose={() => setStylePickerVisible(false)}
      />
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
  styleSelector: {
    minHeight: 42,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  styleSelectorText: { flex: 1, minWidth: 0, color: colors.textMuted, fontSize: 13, fontWeight: "600" },
  styleSelectorTextActive: { color: colors.primary },
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
  jumpToBottom: {
    position: "absolute",
    right: spacing.lg,
    bottom: spacing.md,
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    elevation: 4,
    shadowColor: "#000000",
    shadowOpacity: 0.18,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
  message: { gap: spacing.md, paddingVertical: spacing.md },
  messageHeader: { minHeight: 28, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm },
  messageEditButton: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: spacing.xs, paddingHorizontal: spacing.sm },
  messageEditText: { color: colors.primary, fontSize: 13, fontWeight: "700" },
  userMessage: { marginLeft: 42, paddingHorizontal: spacing.md, borderRadius: radius.md, backgroundColor: colors.surfaceMuted },
  assistantMessage: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  messageRole: { color: colors.primary, fontSize: 12, fontWeight: "700" },
  messageText: { color: colors.text, fontSize: 16, lineHeight: 24 },
  failureCard: { minHeight: 50, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm, paddingHorizontal: spacing.md, borderWidth: 1, borderColor: "#E4B4AE", borderRadius: radius.md, backgroundColor: "#FFF4F2" },
  failureTitle: { color: colors.danger, fontSize: 13, fontWeight: "700" },
  failureRetry: { minHeight: 36, flexDirection: "row", alignItems: "center", gap: spacing.xs, paddingHorizontal: spacing.sm, borderWidth: 1, borderColor: colors.danger, borderRadius: radius.sm },
  failureRetryDisabled: { opacity: 0.5 },
  failureRetryText: { color: colors.danger, fontSize: 12, fontWeight: "700" },
  errorDetails: { gap: spacing.xs, padding: spacing.sm, borderRadius: radius.sm, backgroundColor: colors.surfaceMuted },
  errorDetailsToggle: { minHeight: 28, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  errorDetailsLabel: { color: colors.textMuted, fontSize: 12, fontWeight: "600" },
  errorDetailsText: { color: colors.textMuted, fontSize: 12, lineHeight: 17 },
  composer: { gap: spacing.xs, padding: spacing.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, backgroundColor: colors.surface },
  composerRow: { flexDirection: "row", alignItems: "flex-end", gap: spacing.sm },
  editingBanner: { minHeight: 36, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  editingCopy: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  editingText: { color: colors.primary, fontSize: 13, fontWeight: "600" },
  composerInput: { flex: 1, maxHeight: 130, minHeight: 46, paddingHorizontal: spacing.md, paddingVertical: 11, borderRadius: radius.md, backgroundColor: colors.surfaceMuted, color: colors.text, fontSize: 16 },
  sendButton: { width: 46, height: 46, borderRadius: 23, alignItems: "center", justifyContent: "center", backgroundColor: colors.primary },
  stopButton: { backgroundColor: colors.danger },
  sendDisabled: { opacity: 0.48 },
  // 父层只有 maxHeight，ScrollView/FlatList 默认不收缩会把超出部分顶出可视区且滚不动，必须允许它收缩。
  sheetListScroll: { flexShrink: 1 },
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
