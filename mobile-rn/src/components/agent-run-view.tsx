import { Ionicons } from "@expo/vector-icons";
import { useEffect, useMemo, useState, type ComponentProps } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";

import { Button } from "@/components/ui";
import { colors, radius, spacing } from "@/theme";
import type {
  AgentClarificationAnswer,
  AgentClarificationRequest,
  AgentRunTrace,
  AgentTraceEvent,
  AgentTraceEventKind,
  AgentTraceEventStatus,
} from "@/types";

type IconName = ComponentProps<typeof Ionicons>["name"];

function eventIcon(kind: AgentTraceEventKind): IconName {
  if (kind === "agent") return "people-outline";
  if (kind === "skill") return "extension-puzzle-outline";
  if (kind === "question") return "help-circle-outline";
  if (kind === "consistency") return "sync-outline";
  return "construct-outline";
}

function statusIcon(status: AgentTraceEventStatus): IconName {
  if (status === "completed") return "checkmark-circle";
  if (status === "error") return "alert-circle";
  if (status === "waiting") return "time-outline";
  return "ellipse-outline";
}

function statusColor(status: AgentTraceEventStatus): string {
  if (status === "error") return colors.danger;
  if (status === "waiting") return colors.accent;
  return colors.primary;
}

function runStatus(trace: AgentRunTrace): { label: string; color: string } {
  if (trace.status === "error") return { label: "执行失败", color: colors.danger };
  if (trace.events.some((event) => event.status === "waiting")) return { label: "等待你的操作", color: colors.accent };
  if (trace.status === "running") return { label: "正在协作", color: colors.primary };
  return { label: "已完成", color: colors.primary };
}

function EventPayload({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.payload}>
      <Text style={styles.payloadLabel}>{label}</Text>
      <Text selectable style={styles.payloadText}>{value}</Text>
    </View>
  );
}

function TraceEventRow({ event }: { event: AgentTraceEvent }) {
  const [expanded, setExpanded] = useState(false);
  const hasPayload = Boolean(event.input || event.output);
  return (
    <View style={styles.event}>
      <Pressable
        accessibilityRole={hasPayload ? "button" : undefined}
        accessibilityState={hasPayload ? { expanded } : undefined}
        disabled={!hasPayload}
        onPress={() => setExpanded((value) => !value)}
        style={styles.eventHeader}
      >
        <View style={styles.eventKindIcon}>
          <Ionicons name={eventIcon(event.kind)} size={18} color={colors.textMuted} />
        </View>
        <View style={styles.eventCopy}>
          <View style={styles.eventTitleLine}>
            <Text style={styles.eventTitle} numberOfLines={2}>{event.title}</Text>
            {event.agentName ? <Text style={styles.agentName} numberOfLines={1}>{event.agentName}</Text> : null}
          </View>
          {event.detail ? <Text style={styles.eventDetail} numberOfLines={expanded ? undefined : 2}>{event.detail}</Text> : null}
        </View>
        {event.status === "running" ? (
          <ActivityIndicator size="small" color={colors.primary} />
        ) : (
          <Ionicons name={statusIcon(event.status)} size={19} color={statusColor(event.status)} />
        )}
        {hasPayload ? (
          <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={17} color={colors.textMuted} />
        ) : null}
      </Pressable>
      {expanded ? (
        <View style={styles.payloads}>
          {event.input ? <EventPayload label="输入" value={event.input} /> : null}
          {event.output ? <EventPayload label="结果" value={event.output} /> : null}
        </View>
      ) : null}
    </View>
  );
}

export function AgentTraceView({
  trace,
  defaultExpanded = false,
  onRetry,
  retryDisabled = false,
}: {
  trace: AgentRunTrace;
  defaultExpanded?: boolean;
  onRetry?: () => void;
  retryDisabled?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded || trace.status === "running");
  const status = runStatus(trace);
  const counts = useMemo(() => {
    const agents = trace.events.filter((event) => event.kind === "agent").length;
    const tools = trace.events.filter((event) => event.kind === "tool" || event.kind === "consistency").length;
    const skills = trace.events.filter((event) => event.kind === "skill").length;
    const explored = trace.events.filter((event) => event.kind === "tool"
      && Boolean(event.toolName)
      && /^(list_|read_|search_)/.test(event.toolName ?? "")).length;
    const questions = trace.events.filter((event) => event.kind === "question").length;
    return { agents, tools, skills, explored, questions };
  }, [trace.events]);

  useEffect(() => {
    if (trace.status === "running") setExpanded(true);
  }, [trace.status]);

  const summary = [
   counts.agents ? `${counts.agents} 个智能体` : "",
   counts.tools ? `${counts.tools} 项工具` : "",
   counts.skills ? `${counts.skills} 个技能` : "",
    counts.explored ? `已探索 ${counts.explored} 项` : "",
    counts.questions ? `${counts.questions} 次提问` : "",
  ].filter(Boolean).join(" · ") || "正在分析任务";

  return (
    <View style={[styles.trace, trace.status === "error" && styles.traceError]}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        style={styles.traceHeader}
      >
        <View style={styles.traceIcon}>
          <Ionicons name="git-network-outline" size={19} color={status.color} />
        </View>
        <View style={styles.traceCopy}>
          <Text style={[styles.traceStatus, { color: status.color }]}>{status.label}</Text>
          <Text style={styles.traceSummary} numberOfLines={1}>{trace.primaryAgentName} · {summary}</Text>
        </View>
        {trace.status === "running" ? <ActivityIndicator size="small" color={colors.primary} /> : null}
        {trace.status === "error" && onRetry ? (
          <Pressable
            accessibilityLabel="重试失败任务"
            accessibilityRole="button"
            disabled={retryDisabled}
            onPress={(event) => {
              event.stopPropagation();
              onRetry();
            }}
            style={[styles.traceRetry, retryDisabled && styles.traceRetryDisabled]}
          >
            <Ionicons name="refresh-outline" size={16} color={colors.danger} />
            <Text style={styles.traceRetryText}>{retryDisabled ? "处理中" : "重试"}</Text>
          </Pressable>
        ) : null}
        <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={18} color={colors.textMuted} />
      </Pressable>
      {expanded ? (
        <View style={styles.events}>
          {trace.collaborationRequired ? (
            <View style={styles.collaborationNotice}>
              <Ionicons name="people-outline" size={16} color={colors.primary} />
              <Text style={styles.collaborationText}>此任务可按需调用专业子智能体协作</Text>
            </View>
          ) : null}
          {trace.events.map((event) => <TraceEventRow key={event.id} event={event} />)}
        </View>
      ) : null}
    </View>
  );
}

type QuestionAnswerState = Record<number, string>;
type CustomAnswerState = Record<number, boolean>;

export function AgentQuestionSheet({
  request,
  onSubmit,
  onCancel,
}: {
  request: AgentClarificationRequest | null;
  onSubmit: (answers: AgentClarificationAnswer[]) => void;
  onCancel: () => void;
}) {
  const [answers, setAnswers] = useState<QuestionAnswerState>({});
  const [customAnswers, setCustomAnswers] = useState<CustomAnswerState>({});

  useEffect(() => {
    setAnswers({});
    setCustomAnswers({});
  }, [request?.id]);

  if (!request) return null;

  const canSubmit = request.questions.every((_, index) => Boolean(answers[index]?.trim()));
  const submit = () => {
    if (!canSubmit) return;
    onSubmit(request.questions.map((question, index) => ({
      question: question.title,
      answer: answers[index].trim(),
    })));
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onCancel}>
      <View style={styles.questionBackdrop}>
        <View style={styles.questionSheet}>
          <View style={styles.questionHeader}>
            <View style={styles.questionHeaderIcon}>
              <Ionicons name="help-circle-outline" size={21} color={colors.primary} />
            </View>
            <View style={styles.questionHeaderCopy}>
              <Text style={styles.questionSheetTitle}>{request.agentName} 需要你的选择</Text>
              <Text style={styles.questionSheetSubtitle}>{request.questions.length} 个问题</Text>
            </View>
            <Pressable accessibilityLabel="稍后回答" onPress={onCancel} style={styles.closeButton}>
              <Ionicons name="close" size={24} color={colors.textMuted} />
            </Pressable>
          </View>
          <KeyboardAwareScrollView
            bottomOffset={spacing.xl}
            contentContainerStyle={styles.questions}
            keyboardShouldPersistTaps="handled"
          >
            {request.questions.map((question, questionIndex) => (
              <View key={`${request.id}-${questionIndex}`} style={styles.question}>
                <Text style={styles.questionIndex}>问题 {questionIndex + 1}</Text>
                <Text style={styles.questionTitle}>{question.title}</Text>
                {question.description ? <Text style={styles.questionDescription}>{question.description}</Text> : null}
                <View accessibilityRole="radiogroup" style={styles.options}>
                  {question.options.map((option, optionIndex) => {
                    const selected = !customAnswers[questionIndex] && answers[questionIndex] === option.label;
                    return (
                      <Pressable
                        key={`${option.label}-${optionIndex}`}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: selected }}
                        onPress={() => {
                          setCustomAnswers((current) => ({ ...current, [questionIndex]: false }));
                          setAnswers((current) => ({ ...current, [questionIndex]: option.label }));
                        }}
                        style={[styles.option, selected && styles.optionSelected]}
                      >
                        <Ionicons
                          name={selected ? "radio-button-on" : "radio-button-off"}
                          size={20}
                          color={selected ? colors.primary : colors.textMuted}
                        />
                        <View style={styles.optionCopy}>
                          <Text style={[styles.optionLabel, selected && styles.optionLabelSelected]}>{option.label}</Text>
                          {option.description ? <Text style={styles.optionDescription}>{option.description}</Text> : null}
                        </View>
                      </Pressable>
                    );
                  })}
                  <Pressable
                    accessibilityRole="radio"
                    accessibilityState={{ checked: Boolean(customAnswers[questionIndex]) }}
                    onPress={() => {
                      setCustomAnswers((current) => ({ ...current, [questionIndex]: true }));
                      setAnswers((current) => ({ ...current, [questionIndex]: "" }));
                    }}
                    style={[styles.option, customAnswers[questionIndex] && styles.optionSelected]}
                  >
                    <Ionicons
                      name={customAnswers[questionIndex] ? "radio-button-on" : "radio-button-off"}
                      size={20}
                      color={customAnswers[questionIndex] ? colors.primary : colors.textMuted}
                    />
                    <Text style={[styles.optionLabel, customAnswers[questionIndex] && styles.optionLabelSelected]}>
                      自行输入答案
                    </Text>
                  </Pressable>
                  {customAnswers[questionIndex] ? (
                    <TextInput
                      autoFocus
                      multiline
                      maxLength={1200}
                      onChangeText={(value) => setAnswers((current) => ({ ...current, [questionIndex]: value }))}
                      placeholder="输入你的决定或补充"
                      placeholderTextColor={colors.textMuted}
                      style={styles.customInput}
                      value={answers[questionIndex] ?? ""}
                    />
                  ) : null}
                </View>
              </View>
            ))}
          </KeyboardAwareScrollView>
          <View style={styles.questionActions}>
            <Button label="稍后再说" variant="secondary" onPress={onCancel} />
            <Button label="提交回答" disabled={!canSubmit} onPress={submit} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  trace: {
    overflow: "hidden",
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  traceError: { borderColor: "#E4B4AE" },
  traceHeader: {
    minHeight: 58,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  traceIcon: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceMuted,
  },
  traceCopy: { flex: 1, minWidth: 0 },
  traceStatus: { fontSize: 13, fontWeight: "700" },
  traceSummary: { marginTop: 2, color: colors.textMuted, fontSize: 12 },
  traceRetry: { minHeight: 34, flexDirection: "row", alignItems: "center", gap: spacing.xs, paddingHorizontal: spacing.sm, borderWidth: 1, borderColor: colors.danger, borderRadius: radius.sm },
  traceRetryDisabled: { opacity: 0.5 },
  traceRetryText: { color: colors.danger, fontSize: 12, fontWeight: "700" },
  events: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  collaborationNotice: {
    minHeight: 38,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    backgroundColor: "#E8F2EE",
  },
  collaborationText: { flex: 1, color: colors.primary, fontSize: 12, fontWeight: "600" },
  event: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  eventHeader: {
    minHeight: 54,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  eventKindIcon: { width: 26, alignItems: "center" },
  eventCopy: { flex: 1, minWidth: 0 },
  eventTitleLine: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  eventTitle: { flexShrink: 1, color: colors.text, fontSize: 13, fontWeight: "700" },
  agentName: { flexShrink: 1, color: colors.textMuted, fontSize: 11 },
  eventDetail: { marginTop: 3, color: colors.textMuted, fontSize: 12, lineHeight: 17 },
  payloads: { gap: spacing.sm, paddingHorizontal: spacing.md, paddingBottom: spacing.md },
  payload: { gap: spacing.xs, padding: spacing.sm, borderRadius: radius.sm, backgroundColor: colors.surfaceMuted },
  payloadLabel: { color: colors.textMuted, fontSize: 11, fontWeight: "700" },
  payloadText: { color: colors.text, fontSize: 12, lineHeight: 18 },
  questionBackdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: colors.overlay },
  questionSheet: {
    maxHeight: "92%",
    borderTopLeftRadius: radius.md,
    borderTopRightRadius: radius.md,
    backgroundColor: colors.background,
  },
  questionHeader: {
    minHeight: 66,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingLeft: spacing.lg,
    paddingRight: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  questionHeaderIcon: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
    backgroundColor: "#E8F2EE",
  },
  questionHeaderCopy: { flex: 1, minWidth: 0 },
  questionSheetTitle: { color: colors.text, fontSize: 17, fontWeight: "700" },
  questionSheetSubtitle: { marginTop: 2, color: colors.textMuted, fontSize: 12 },
  closeButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  questions: { padding: spacing.lg, paddingBottom: spacing.xl, gap: spacing.xl },
  question: { gap: spacing.sm },
  questionIndex: { color: colors.primary, fontSize: 11, fontWeight: "700" },
  questionTitle: { color: colors.text, fontSize: 17, fontWeight: "700", lineHeight: 24 },
  questionDescription: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
  options: { gap: spacing.sm, marginTop: spacing.xs },
  option: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  optionSelected: { borderColor: colors.primary, backgroundColor: "#E8F2EE" },
  optionCopy: { flex: 1, minWidth: 0 },
  optionLabel: { color: colors.text, fontSize: 14, fontWeight: "600" },
  optionLabelSelected: { color: colors.primary },
  optionDescription: { marginTop: 3, color: colors.textMuted, fontSize: 12, lineHeight: 17 },
  customInput: {
    minHeight: 88,
    maxHeight: 160,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    color: colors.text,
    fontSize: 15,
    lineHeight: 21,
    textAlignVertical: "top",
  },
  questionActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
});
