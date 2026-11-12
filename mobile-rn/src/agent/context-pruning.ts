import type { AgentMessage } from "@/llm/types";

/**
 * 上下文裁剪：把较早的只读工具结果换成占位符。
 *
 * 主循环每一轮都会把此前的工具结果原样重发一遍，读一章最多两万字符，
 * 十几轮下来单次请求能滚到几十万字符——中转站的 TPM 限流多半是这样撞上的。
 * 这里只清理"只读工具"的结果（重新调用就能再拿到），写入类结果、技能指令、
 * 子智能体结论都保留，避免模型以为事情没做过而重复执行。
 *
 * 纯函数，不依赖 expo 或数据库，可转译后在 Node 里断言。
 */

/** 累计工具结果低于这个字符数就整体不动：小会话没必要改写上下文。 */
export const PRUNE_MINIMUM_CHARACTERS = 40_000;
/** 最近这么多条工具结果完整保留，模型刚读过可能马上还要用。 */
export const PRUNE_KEEP_RECENT = 4;

/** 只读工具：结果可以安全丢弃，需要时重新调用即可。 */
const READ_ONLY_TOOL_PATTERN = /^(list_|read_|search_)/;

function prunedContent(message: AgentMessage): string {
  const characters = message.content.length;
  const name = message.toolName ?? "该工具";
  // 保持合法 JSON：Gemini 的 functionResponse 与 OpenAI 的 tool 消息都按 JSON 解析。
  return JSON.stringify({
    pruned: true,
    tool: name,
    original_characters: characters,
    note: `较早的工具结果已清理以节省额度（原 ${characters} 字符）；需要其中内容时重新调用 ${name}。`,
  });
}

function isPrunable(message: AgentMessage): boolean {
  return message.role === "tool" && READ_ONLY_TOOL_PATTERN.test(message.toolName ?? "");
}

export function pruneToolOutputs(
  messages: AgentMessage[],
  options?: { minimumCharacters?: number; keepRecent?: number },
): AgentMessage[] {
  const minimum = options?.minimumCharacters ?? PRUNE_MINIMUM_CHARACTERS;
  const keepRecent = options?.keepRecent ?? PRUNE_KEEP_RECENT;

  const toolIndexes: number[] = [];
  let totalCharacters = 0;
  messages.forEach((message, index) => {
    if (message.role !== "tool") return;
    toolIndexes.push(index);
    totalCharacters += message.content.length;
  });
  if (totalCharacters <= minimum) return messages;

  const prunable = new Set(
    toolIndexes
      .slice(0, Math.max(0, toolIndexes.length - keepRecent))
      .filter((index) => isPrunable(messages[index])),
  );
  if (!prunable.size) return messages;
  return messages.map((message, index) => (
    prunable.has(index) ? { ...message, content: prunedContent(message) } : message
  ));
}
