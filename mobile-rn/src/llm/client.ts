import type { ModelSelection } from "@/types";
import { getSetting } from "@/data/repositories";

import type { AgentMessage, AgentToolCall, AgentToolDefinition, ModelTurn } from "./types";
import { normalizeMaxOutputTokens } from "./limits";

const REQUEST_TIMEOUT_MS = 120_000;
const MAX_REQUEST_ATTEMPTS = 3;
// 服务端过载类错误只重试一次，避免中转站限流时把请求量再翻倍。
const MAX_SERVER_ERROR_ATTEMPTS = 2;
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function openAiExtraContent(call: Record<string, any>): Record<string, unknown> | undefined {
  const candidates = [call.extra_content, call.extraContent, call.provider_metadata, call.providerMetadata];
  for (const candidate of candidates) {
    if (!isRecord(candidate) || !Object.keys(candidate).length) continue;
    if (isRecord(candidate.openAiExtraContent)) return candidate.openAiExtraContent;
    if (typeof candidate.geminiThoughtSignature === "string" && candidate.geminiThoughtSignature.trim()) {
      return { google: { thought_signature: candidate.geminiThoughtSignature } };
    }
    return candidate;
  }
  const signature = call.thought_signature ?? call.thoughtSignature;
  if (typeof signature === "string" && signature.trim()) {
    return { google: { thought_signature: signature } };
  }
  return undefined;
}

function errorDetail(data: Record<string, any>, text: string, statusText: string): string {
  const candidates = [
    isRecord(data.error) ? data.error.message : data.error,
    isRecord(data.error) ? data.error.detail : undefined,
    data.message,
    data.detail,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  const primary = candidates[0]?.trim();
  if (primary && !/^\d{3}$/.test(primary)) return primary;
  const raw = text.trim();
  if (raw && !/^\{?\s*"?error"?\s*:\s*"?\d{3}"?\s*\}?$/i.test(raw)) return raw.slice(0, 4_000);
  return primary || statusText || "供应商未返回错误详情";
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30_000, seconds * 1_000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(30_000, Math.max(0, date - Date.now()));
  }
  return Math.min(8_000, 1_500 * 2 ** attempt);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function requestJson(url: string, init: RequestInit): Promise<Record<string, any>> {
  const configuredTimeout = Number(await getSetting("connections.requestTimeout"));
  const requestTimeout = Number.isInteger(configuredTimeout) && configuredTimeout >= 10_000 && configuredTimeout <= 300_000
    ? configuredTimeout
    : REQUEST_TIMEOUT_MS;
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_REQUEST_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeout);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      const text = await response.text();
      let data: Record<string, any> = {};
      if (text) {
        try {
          const parsed: unknown = JSON.parse(text);
          if (isRecord(parsed)) data = parsed;
        } catch {
          if (response.ok) throw new Error("模型服务返回了无法解析的非 JSON 响应");
        }
      }
      if (response.ok) return data;
      const detail = errorDetail(data, text, response.statusText);
      const requestError = new Error(`HTTP ${response.status}: ${detail}`);
      lastError = requestError;
      // Surface rate limiting immediately so one failed agent turn cannot amplify it.
      const maxAttempts = response.status === 429 ? 1 : MAX_SERVER_ERROR_ATTEMPTS;
      if (!RETRYABLE_STATUS_CODES.has(response.status) || attempt + 1 >= maxAttempts) throw requestError;
      await sleep(retryDelay(response, attempt));
    } catch (error) {
      if (isRecord(error) && error.name === "AbortError") {
        lastError = new Error("模型请求超时，请检查网络或 Base URL");
      } else if (error instanceof TypeError) {
        const detail = error.message.trim();
        lastError = new Error(`fetch failed${detail ? `: ${detail}` : ""}`);
      } else {
        lastError = error;
      }
      if (attempt + 1 >= MAX_REQUEST_ATTEMPTS || !(error instanceof TypeError || (isRecord(error) && error.name === "AbortError"))) {
        throw lastError;
      }
      await sleep(Math.min(4_000, 1_000 * 2 ** attempt));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("模型请求失败");
}

function normalizeBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s]+$/i.test(normalized)) throw new Error("模型 Base URL 无效");
  return normalized;
}

async function callOpenAi(
  selection: ModelSelection,
  messages: AgentMessage[],
  tools: AgentToolDefinition[],
): Promise<ModelTurn> {
  const maxOutputTokens = normalizeMaxOutputTokens(selection.model.maxTokens);
  const data = await requestJson(`${normalizeBaseUrl(selection.provider.baseUrl)}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${selection.apiKey}`,
    },
    body: JSON.stringify({
      model: selection.model.modelId,
      temperature: selection.model.temperature,
      max_tokens: maxOutputTokens,
      messages: messages.map((message) => ({
        role: message.role,
        content: message.toolCalls?.length ? (message.content || null) : message.content,
        ...(message.toolCalls?.length ? {
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            ...(call.providerMetadata?.openAiExtraContent
              ? { extra_content: call.providerMetadata.openAiExtraContent }
              : {}),
          })),
        } : {}),
        ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
      })),
      ...(tools.length ? {
        tools: tools.map((tool) => ({ type: "function", function: tool })),
        tool_choice: "auto",
      } : {}),
    }),
  });
  const message = data.choices?.[0]?.message ?? {};
  const toolCalls: AgentToolCall[] = (message.tool_calls ?? [])
    .filter((call: unknown): call is Record<string, any> => isRecord(call))
    .map((call: Record<string, any>) => {
      const metadata = openAiExtraContent(call);
      return {
        id: String(call.id ?? ""),
        name: String(call.function?.name ?? ""),
        arguments: parseJsonObject(String(call.function?.arguments ?? "{}")),
        ...(metadata ? { providerMetadata: { openAiExtraContent: metadata } } : {}),
      };
    });
  return { content: typeof message.content === "string" ? message.content : "", toolCalls };
}

function toGeminiSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toGeminiSchema);
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    if (key === "type" && typeof item === "string") output[key] = item.toUpperCase();
    else if (key === "required" && Array.isArray(item) && item.length === 0) continue;
    else if (key !== "additionalProperties") output[key] = toGeminiSchema(item);
  }
  if (!output.type && isRecord(source.properties)) output.type = "OBJECT";
  if (!output.type && source.items) output.type = "ARRAY";
  if (!output.type && Array.isArray(source.enum) && source.enum.length) {
    const sample = source.enum[0];
    output.type = typeof sample === "number" ? "NUMBER" : typeof sample === "boolean" ? "BOOLEAN" : "STRING";
  }
  if (!output.type) output.type = "STRING";
  return output;
}

function geminiContents(messages: AgentMessage[]): Record<string, unknown>[] {
  const contents: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      const part = { functionResponse: { name: message.toolName, response: parseJsonObject(message.content) } };
      const previous = contents.at(-1);
      if (previous?.role === "user" && Array.isArray(previous.parts)
        && previous.parts.every((item) => isRecord(item) && "functionResponse" in item)) {
        previous.parts.push(part);
      } else {
        contents.push({ role: "user", parts: [part] });
      }
      continue;
    }
    const parts: Record<string, unknown>[] = [];
    if (message.content) parts.push({ text: message.content });
    for (const call of message.toolCalls ?? []) {
      parts.push({
        functionCall: { name: call.name, args: call.arguments },
        ...(call.providerMetadata?.geminiThoughtSignature
          ? { thoughtSignature: call.providerMetadata.geminiThoughtSignature }
          : {}),
      });
    }
    if (parts.length) contents.push({ role: message.role === "assistant" ? "model" : "user", parts });
  }
  return contents;
}

async function callGemini(
  selection: ModelSelection,
  messages: AgentMessage[],
  tools: AgentToolDefinition[],
): Promise<ModelTurn> {
  const maxOutputTokens = normalizeMaxOutputTokens(selection.model.maxTokens);
  const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
  const baseUrl = normalizeBaseUrl(selection.provider.baseUrl);
  const url = `${baseUrl}/models/${encodeURIComponent(selection.model.modelId)}:generateContent`;
  const data = await requestJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": selection.apiKey },
    body: JSON.stringify({
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      contents: geminiContents(messages),
      ...(tools.length ? {
        tools: [{ functionDeclarations: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: toGeminiSchema(tool.parameters),
        })) }],
      } : {}),
      generationConfig: {
        temperature: selection.model.temperature,
        maxOutputTokens,
      },
    }),
  });
  const parts: any[] = data.candidates?.[0]?.content?.parts ?? [];
  if (!parts.length) {
    const reason = data.promptFeedback?.blockReason ?? data.candidates?.[0]?.finishReason ?? "模型没有返回内容";
    throw new Error(`Gemini 请求未完成: ${reason}`);
  }
  const toolCalls = parts.filter((part) => part.functionCall).map((part, index) => ({
    id: `gemini-${Date.now()}-${index}`,
    name: String(part.functionCall.name),
    arguments: isRecord(part.functionCall.args) ? part.functionCall.args : {},
    ...(typeof (part.thoughtSignature ?? part.thought_signature) === "string" ? {
      providerMetadata: { geminiThoughtSignature: part.thoughtSignature ?? part.thought_signature },
    } : {}),
  }));
  return {
    content: parts.filter((part) => typeof part.text === "string").map((part) => part.text).join(""),
    toolCalls,
  };
}

function anthropicMessages(messages: AgentMessage[]): Record<string, unknown>[] {
  const output: Record<string, any>[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    const role = message.role === "assistant" ? "assistant" : "user";
    const blocks: Record<string, unknown>[] = [];
    if (message.role === "tool") {
      const result = parseJsonObject(message.content);
      blocks.push({
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: message.content,
        ...(typeof result.error === "string" ? { is_error: true } : {}),
      });
    } else {
      if (message.content) blocks.push({ type: "text", text: message.content });
      for (const call of message.toolCalls ?? []) blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments });
    }
    if (!blocks.length) continue;
    const previous = output.at(-1);
    if (previous?.role === role && Array.isArray(previous.content)) previous.content.push(...blocks);
    else output.push({ role, content: blocks });
  }
  return output;
}

async function callAnthropic(
  selection: ModelSelection,
  messages: AgentMessage[],
  tools: AgentToolDefinition[],
): Promise<ModelTurn> {
  const maxOutputTokens = normalizeMaxOutputTokens(selection.model.maxTokens);
  const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
  const data = await requestJson(`${normalizeBaseUrl(selection.provider.baseUrl)}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": selection.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: selection.model.modelId,
      system,
      temperature: selection.model.temperature,
      max_tokens: maxOutputTokens,
      messages: anthropicMessages(messages),
      ...(tools.length ? {
        tools: tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })),
      } : {}),
    }),
  });
  const blocks: any[] = data.content ?? [];
  return {
    content: blocks.filter((block) => block.type === "text").map((block) => block.text).join(""),
    toolCalls: blocks.filter((block) => block.type === "tool_use").map((block) => ({
      id: String(block.id), name: String(block.name), arguments: block.input ?? {},
    })),
  };
}

export function callModel(
  selection: ModelSelection,
  messages: AgentMessage[],
  tools: AgentToolDefinition[],
): Promise<ModelTurn> {
  if (selection.provider.type === "google-genai") return callGemini(selection, messages, tools);
  if (selection.provider.type === "anthropic") return callAnthropic(selection, messages, tools);
  return callOpenAi(selection, messages, tools);
}
