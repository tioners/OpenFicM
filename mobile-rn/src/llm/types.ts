export interface AgentToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  providerMetadata?: {
    geminiThoughtSignature?: string;
    openAiExtraContent?: Record<string, unknown>;
  };
}

export interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: AgentToolCall[];
  toolCallId?: string;
  toolName?: string;
  /**
   * 思考型模型随本条回复返回的推理内容（OpenAI 兼容协议的 reasoning_content）。
   * DeepSeek 等供应商要求带工具调用的回复在下一轮原样带回，否则直接 400。
   */
  reasoningContent?: string;
  /**
   * Responses 接口随本条回复返回的 reasoning 条目（原样保留）。
   * 思考型模型要求下一轮把它们放在对应的 function_call 之前带回，
   * 否则报 "The reasoning_text in the thinking mode must be passed back to the API"。
   */
  reasoningItems?: Record<string, unknown>[];
}

export interface AgentToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ModelTurn {
  content: string;
  toolCalls: AgentToolCall[];
  /** 见 AgentMessage.reasoningContent；供应商没返回时省略。 */
  reasoningContent?: string;
  /** 见 AgentMessage.reasoningItems；没有时省略。 */
  reasoningItems?: Record<string, unknown>[];
}
