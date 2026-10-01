import type { AgentMessage, AgentToolCall, AgentToolDefinition } from "./types";

/**
 * OpenAI Responses API（/responses）的请求与响应映射。
 * 这里只做纯数据转换，便于脱离 React Native 单测：见 docs/OPENFICM_PROJECT_CONTEXT.md 的验证记录。
 */

export interface ResponsesRequestInput {
  modelId: string;
  instructions: string;
  temperature: number;
  maxOutputTokens: number;
  tools: AgentToolDefinition[];
  messages: AgentMessage[];
}

export interface ResponsesTurn {
  content: string;
  toolCalls: AgentToolCall[];
  /** 截断等未完成原因，取自 incomplete_details.reason。 */
  incompleteReason: string;
  /** 供应商显式返回的失败信息。 */
  failureMessage: string;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** 历史消息转成 Responses 的 input 条目：消息、assistant 的 function_call、工具返回的 function_call_output。 */
export function responsesInputItems(messages: AgentMessage[]): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      // 没有 call_id 的工具结果无法与 function_call 配对，发出去只会被服务端拒绝。
      if (!message.toolCallId) continue;
      items.push({ type: "function_call_output", call_id: message.toolCallId, output: message.content });
      continue;
    }
    if (message.content.trim()) {
      items.push({ role: message.role === "assistant" ? "assistant" : "user", content: message.content });
    }
    for (const call of message.toolCalls ?? []) {
      items.push({
        type: "function_call",
        call_id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.arguments ?? {}),
      });
    }
  }
  return items;
}

export function buildResponsesRequestBody(input: ResponsesRequestInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: input.modelId,
    input: responsesInputItems(input.messages),
    temperature: input.temperature,
    max_output_tokens: input.maxOutputTokens,
  };
  if (input.instructions.trim()) body.instructions = input.instructions;
  if (input.tools.length) {
    body.tools = input.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
    body.tool_choice = "auto";
  }
  return body;
}

export function parseResponsesTurn(data: Record<string, any>): ResponsesTurn {
  const output = Array.isArray(data.output) ? data.output.filter(isRecord) : [];
  const content = output
    .filter((item) => item.type === "message")
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .filter(isRecord)
    .filter((part) => (part.type === "output_text" || part.type === "text") && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");
  const toolCalls: AgentToolCall[] = output
    .filter((item) => item.type === "function_call")
    .map((item) => ({
      id: String(item.call_id ?? item.id ?? ""),
      name: String(item.name ?? ""),
      arguments: parseArguments(item.arguments),
    }))
    .filter((call) => Boolean(call.name));
  const incompleteReason = isRecord(data.incomplete_details) && typeof data.incomplete_details.reason === "string"
    ? data.incomplete_details.reason
    : "";
  const failureMessage = isRecord(data.error) && typeof data.error.message === "string" ? data.error.message : "";
  return { content, toolCalls, incompleteReason, failureMessage };
}
