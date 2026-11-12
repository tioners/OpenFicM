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
}
