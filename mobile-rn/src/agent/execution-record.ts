import type { AgentRunTrace, AgentTraceEvent } from "@/types";

/**
 * 断连恢复用的"执行记录"。
 *
 * 网络超时时 agentLoop 里的 messages 是局部数组，工具调用与结果只存在内存里；
 * 重试只回放用户消息，模型会以为"什么都没干"，于是重复写章节、重复改设定。
 * 这里把 trace 里已落地的步骤压成模型可读的摘要，随重试一起回放进对话历史。
 */

/** 只读工具不需要回放：重跑一次没有副作用。 */
const READ_ONLY_TOOL = /^(list_|read_|search_)/;

/** 视为"动作"的事件种类：这些才是重试时真正需要避免重复的。 */
function isActionEvent(event: AgentTraceEvent): boolean {
  // 一致性核对本身没有副作用，不计入需要避免重复的动作。
  if (event.kind === "consistency") return false;
  if (event.kind !== "tool") return false;
  if (!event.toolName) return false;
  return !READ_ONLY_TOOL.test(event.toolName);
}

function isFinished(event: AgentTraceEvent): boolean {
  return event.status === "completed";
}

function isUnfinished(event: AgentTraceEvent): boolean {
  return event.status === "error" || event.status === "running" || event.status === "waiting";
}

export interface ExecutionRecord {
  /** 已完成且需要避免重复的动作步骤。 */
  completed: AgentTraceEvent[];
  /** 已尝试但未成功、或断连时仍在执行的步骤。 */
  unfinished: AgentTraceEvent[];
  /** 中断时是否仍有步骤处于 running/waiting，说明结果未知。 */
  hasUnknownOutcome: boolean;
}

export function summarizeExecutionRecord(trace: AgentRunTrace | null | undefined): ExecutionRecord {
  if (!trace) return { completed: [], unfinished: [], hasUnknownOutcome: false };
  const actions = trace.events.filter(isActionEvent);
  return {
    completed: actions.filter(isFinished),
    unfinished: actions.filter(isUnfinished),
    // 断连时仍在跑的步骤：写没写进去不确定，必须提醒用户核对。
    hasUnknownOutcome: actions.some((event) => event.status === "running"),
  };
}

function stepLabel(event: AgentTraceEvent): string {
  const title = event.title?.trim() || event.toolName || "未知步骤";
  return event.detail?.trim() ? `${title}（${event.detail.trim()}）` : title;
}

/**
 * 生成注入对话历史的中文摘要。只列动作类步骤，读操作省略，
 * 避免把上下文撑大；同时也明确告诉模型"这些别再做一遍"。
 */
export function buildExecutionRecordMessage(trace: AgentRunTrace | null | undefined): string | null {
  const record = summarizeExecutionRecord(trace);
  if (!record.completed.length && !record.unfinished.length) return null;
  const lines: string[] = ["上一轮任务没有正常结束，以下是已经发生的操作，请据此继续，不要重复执行："];
  if (record.completed.length) {
    lines.push("已完成：");
    for (const event of record.completed) lines.push(`- ${stepLabel(event)}`);
  }
  if (record.unfinished.length) {
    lines.push("未完成或结果未知：");
    for (const event of record.unfinished) lines.push(`- ${stepLabel(event)}`);
    if (record.hasUnknownOutcome) {
      lines.push("其中标注为执行中的步骤可能已经写入作品，继续之前请先用读取工具核对当前状态，避免重复创建。");
    }
  }
  return lines.join("\n");
}
