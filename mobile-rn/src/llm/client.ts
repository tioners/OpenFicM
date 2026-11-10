import type { ModelSelection } from "@/types";
import { getSetting } from "@/data/repositories";

import type { AgentMessage, AgentToolCall, AgentToolDefinition, ModelTurn } from "./types";
import { MAX_CONFIGURED_OUTPUT_TOKENS, normalizeMaxOutputTokens } from "./limits";
import { buildResponsesRequestBody, parseResponsesTurn } from "./responses-api";

const CANCELLED_MESSAGE = "已取消本次请求";

const REQUEST_TIMEOUT_MS = 120_000;
// 以下重试默认值会被"连接"设置里的可选项覆盖（issue #4）。
const DEFAULT_MAX_REQUEST_ATTEMPTS = 3;
// 服务端过载类错误只重试一次，避免中转站限流时把请求量再翻倍。
const DEFAULT_MAX_SERVER_ERROR_ATTEMPTS = 2;
const DEFAULT_MAX_RATE_LIMIT_ATTEMPTS = 1;
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

export interface ConnectionRetrySettings {
  requestTimeoutMs: number;
  /** 网络错误与超时最多尝试几次（含第一次）。0/1 表示不重试。 */
  maxRequestAttempts: number;
  /** 5xx 等服务器错误最多尝试几次（含第一次）。 */
  maxServerErrorAttempts: number;
  /** 429 限流最多尝试几次（含第一次）。默认 1，即限流直接抛错，避免放大限流。 */
  maxRateLimitAttempts: number;
  /** 超时时是否自动重发。默认 false：超时后服务端多半仍在生成，自动重发会重复计费。 */
  retryOnTimeout: boolean;
}

function boundedSetting(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

let retrySettingsCache: ConnectionRetrySettings | null = null;
let retrySettingsLoadedAt = 0;
const RETRY_SETTINGS_CACHE_MS = 30_000;

export async function getConnectionRetrySettings(): Promise<ConnectionRetrySettings> {
  if (retrySettingsCache && Date.now() - retrySettingsLoadedAt < RETRY_SETTINGS_CACHE_MS) {
    return retrySettingsCache;
  }
  const [timeoutValue, attemptsValue, serverAttemptsValue, rateLimitAttemptsValue, retryOnTimeoutValue] = await Promise.all([
    getSetting("connections.requestTimeout"),
    getSetting("connections.maxAttempts"),
    getSetting("connections.maxServerErrorAttempts"),
    getSetting("connections.maxRateLimitAttempts"),
    getSetting("connections.retryOnTimeout"),
  ]);
  retrySettingsCache = {
    requestTimeoutMs: boundedSetting(timeoutValue, REQUEST_TIMEOUT_MS, 10_000, 300_000),
    maxRequestAttempts: boundedSetting(attemptsValue, DEFAULT_MAX_REQUEST_ATTEMPTS, 1, 5),
    maxServerErrorAttempts: boundedSetting(serverAttemptsValue, DEFAULT_MAX_SERVER_ERROR_ATTEMPTS, 1, 3),
    maxRateLimitAttempts: boundedSetting(rateLimitAttemptsValue, DEFAULT_MAX_RATE_LIMIT_ATTEMPTS, 1, 3),
    retryOnTimeout: retryOnTimeoutValue === "true",
  };
  retrySettingsLoadedAt = Date.now();
  return retrySettingsCache;
}

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

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(CANCELLED_MESSAGE));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error(CANCELLED_MESSAGE));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function requestJson(url: string, init: RequestInit, signal?: AbortSignal): Promise<Record<string, any>> {
  const settings = await getConnectionRetrySettings();
  const requestTimeout = settings.requestTimeoutMs;
  let lastError: unknown;
  for (let attempt = 0; attempt < settings.maxRequestAttempts; attempt += 1) {
    if (signal?.aborted) throw new Error(CANCELLED_MESSAGE);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeout);
    // 外部取消（例如后台蒸馏被用户中止）要立刻打断在途请求；AbortSignal.any 在 Hermes 上不保证可用，手动桥接。
    const abortFromCaller = () => controller.abort();
    signal?.addEventListener("abort", abortFromCaller, { once: true });
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      const text = await response.text();
      let data: Record<string, any> = {};
      if (text) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          // 丢掉响应体会让这类故障完全无法诊断，带一段原文出来。
          if (response.ok) throw new Error(`模型服务返回了无法解析的非 JSON 响应：${text.trim().slice(0, 300)}`);
        }
        if (isRecord(parsed)) data = parsed;
        else if (parsed !== undefined && response.ok) {
          throw new Error(`模型服务返回的 JSON 不是对象：${text.trim().slice(0, 300)}`);
        }
      } else if (response.ok) {
        throw new Error("模型服务返回了空响应体");
      }
      if (response.ok) return data;
      const detail = errorDetail(data, text, response.statusText);
      const requestError = new Error(`HTTP ${response.status}: ${detail}`);
      lastError = requestError;
      // 默认限流直接抛错，避免一个失败的智能体轮次放大限流；可在设置里放宽。
      const maxAttempts = response.status === 429 ? settings.maxRateLimitAttempts : settings.maxServerErrorAttempts;
      if (!RETRYABLE_STATUS_CODES.has(response.status) || attempt + 1 >= maxAttempts) throw requestError;
      await sleep(retryDelay(response, attempt), signal);
    } catch (error) {
      // 用户主动取消不是故障：不要重试，也不要报成超时或网络错误。
      if (signal?.aborted) throw new Error(CANCELLED_MESSAGE);
      if (isRecord(error) && error.name === "AbortError") {
        lastError = new Error("模型请求超时，请检查网络或 Base URL");
      } else if (error instanceof TypeError) {
        const detail = error.message.trim();
        lastError = new Error(`fetch failed${detail ? `: ${detail}` : ""}`);
      } else {
        lastError = error;
      }
      if (attempt + 1 >= settings.maxRequestAttempts || !(error instanceof TypeError || (isRecord(error) && error.name === "AbortError"))) {
        throw lastError;
      }
      // 超时时默认不重发：服务端多半还在生成，重发会重复计费；可在"连接"设置里开启。
      if (isRecord(error) && error.name === "AbortError" && !settings.retryOnTimeout) {
        throw lastError;
      }
      await sleep(Math.min(4_000, 1_000 * 2 ** attempt), signal);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromCaller);
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
  options?: ModelCallOptions,
): Promise<ModelTurn> {
  const maxOutputTokens = resolveOutputTokens(selection, options);
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
  }, options?.signal);
  const choice = isRecord(data.choices?.[0]) ? data.choices[0] : {};
  const message = choice.message ?? {};
  const finishReason = typeof choice.finish_reason === "string" ? choice.finish_reason : "";
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
  const content = typeof message.content === "string" ? message.content : "";
  // 思考模型的推理 Token 也计入 max_tokens，正文可能一个字都没吐出来就被截断。
  // 不做静默降级，否则调用方只会看到"内容为空"，无法判断该调高上限。
  if (!content.trim() && !toolCalls.length) {
    if (finishReason === "length") {
      throw new Error(`模型在返回正文前就用完了 ${maxOutputTokens} 个输出 Token（finish_reason=length）。思考型模型的推理过程也计入这个上限，请在“设置 → 模型与供应商”调高最大输出 Token 数，或换用非思考模型。`);
    }
    if (finishReason && finishReason !== "stop") {
      throw new Error(`模型没有返回内容，finish_reason=${finishReason}`);
    }
  }
  return { content, toolCalls };
}

/**
 * 新版 OpenAI Responses API（POST /responses）。
 * 与 chat/completions 的差异：系统提示走 instructions，历史消息是扁平 input 条目，
 * 工具结果用 function_call_output 按 call_id 配对，输出上限字段是 max_output_tokens。
 */
async function callOpenAiResponses(
  selection: ModelSelection,
  messages: AgentMessage[],
  tools: AgentToolDefinition[],
  options?: ModelCallOptions,
): Promise<ModelTurn> {
  const maxOutputTokens = resolveOutputTokens(selection, options);
  const instructions = messages.filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const data = await requestJson(`${normalizeBaseUrl(selection.provider.baseUrl)}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${selection.apiKey}`,
    },
    body: JSON.stringify(buildResponsesRequestBody({
      modelId: selection.model.modelId,
      instructions,
      temperature: selection.model.temperature,
      maxOutputTokens,
      tools,
      messages,
    })),
  }, options?.signal);
  const turn = parseResponsesTurn(data);
  if (turn.failureMessage) throw new Error(`模型服务返回失败：${turn.failureMessage}`);
  if (!turn.content.trim() && !turn.toolCalls.length) {
    if (turn.incompleteReason === "max_output_tokens") {
      throw new Error(`模型在返回正文前就用完了 ${maxOutputTokens} 个输出 Token（incomplete_details.reason=max_output_tokens）。思考型模型的推理过程也计入这个上限，请在“设置 → 模型与供应商”调高最大输出 Token 数，或换用非思考模型。`);
    }
    if (turn.incompleteReason) throw new Error(`模型没有返回内容（incomplete_details.reason=${turn.incompleteReason}）`);
  }
  return { content: turn.content, toolCalls: turn.toolCalls };
}

/** Gemini 只接受 OpenAPI 子集，这些 JSON Schema 关键字会被 400 拒绝。 */
const GEMINI_UNSUPPORTED_SCHEMA_KEYS = new Set([
  "$schema", "$id", "$defs", "$ref", "definitions", "additionalProperties",
  "default", "title", "examples", "const", "oneOf", "anyOf", "allOf", "not",
  "if", "then", "else", "format", "deprecated", "readOnly", "writeOnly",
  "patternProperties", "propertyNames", "unevaluatedProperties", "contentMediaType", "contentEncoding",
]);

/**
 * 把 properties 映射转换成 Gemini 的 schema 字典。
 *
 * 关键：properties 的值是"名字 → schema"的映射，**映射本身不是 schema**，
 * 不能给它补 type。此前把映射递归进了 toGeminiSchema，导致末尾的
 * `if (!output.type) output.type = "STRING"` 把整个映射变成
 * `properties: { paramA: {...}, type: "STRING" }`——Gemini 于是把 "type"
 * 当成一个名叫 type 的伪参数，而它的值是字符串，直接 400。
 */
function toGeminiProperties(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const output: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(value)) {
    // 属性名必须是合法标识符；schema 为字符串时按类型简写包装。
    if (typeof schema === "string") output[name] = { type: schema.toUpperCase() };
    else if (isRecord(schema)) output[name] = toGeminiSchema(schema);
    else output[name] = { type: "STRING" };
  }
  return output;
}

function toGeminiSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toGeminiSchema);
  // 注意：这里**不能**把任意字符串都包装成 { type }，否则 description 这类
  // 普通字符串值会被误写成 schema。类型简写只在 properties / items 处处理。
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    if (GEMINI_UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
    if (key === "type" && typeof item === "string") output[key] = item.toUpperCase();
    else if (key === "required" && Array.isArray(item)) {
      // Gemini 不接受空 required 数组
      const names = item.filter((entry): entry is string => typeof entry === "string");
      if (names.length) output.required = names;
    } else if (key === "properties") {
      const properties = toGeminiProperties(item);
      if (properties && Object.keys(properties).length) output.properties = properties;
    } else if (key === "items") {
      output.items = typeof item === "string" ? { type: item.toUpperCase() } : toGeminiSchema(item);
    } else if (key === "enum" && Array.isArray(item)) {
      // Gemini 的 enum 必须是字符串数组
      output.enum = item.map((entry) => String(entry));
    } else {
      output[key] = toGeminiSchema(item);
    }
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
  options?: ModelCallOptions,
): Promise<ModelTurn> {
  const maxOutputTokens = resolveOutputTokens(selection, options);
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
        tools: [{ functionDeclarations: tools.map((tool) => {
          const parameters = toGeminiSchema(tool.parameters);
          // 无参数工具不要发空 parameters：Gemini 对没有 properties 的 OBJECT 兼容性不一致。
          const hasParameters = isRecord(parameters)
            && isRecord((parameters as Record<string, unknown>).properties)
            && Object.keys((parameters as Record<string, unknown>).properties as object).length > 0;
          return {
            name: tool.name,
            description: tool.description,
            ...(hasParameters ? { parameters } : {}),
          };
        }) }],
      } : {}),
      generationConfig: {
        temperature: selection.model.temperature,
        maxOutputTokens,
      },
    }),
  }, options?.signal);
  const parts: any[] = data.candidates?.[0]?.content?.parts ?? [];
  const finishReason = String(data.candidates?.[0]?.finishReason ?? "");
  if (!parts.length) {
    if (finishReason === "MAX_TOKENS") {
      throw new Error(`模型在返回正文前就用完了 ${maxOutputTokens} 个输出 Token（finishReason=MAX_TOKENS）。思考型模型的推理过程也计入这个上限，请在“设置 → 模型与供应商”调高最大输出 Token 数。`);
    }
    const reason = data.promptFeedback?.blockReason ?? finishReason ?? "模型没有返回内容";
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
  options?: ModelCallOptions,
): Promise<ModelTurn> {
  const maxOutputTokens = resolveOutputTokens(selection, options);
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
  }, options?.signal);
  const blocks: any[] = data.content ?? [];
  const content = blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
  const toolCalls = blocks.filter((block) => block.type === "tool_use").map((block) => ({
    id: String(block.id), name: String(block.name), arguments: block.input ?? {},
  }));
  if (!content.trim() && !toolCalls.length && data.stop_reason === "max_tokens") {
    throw new Error(`模型在返回正文前就用完了 ${maxOutputTokens} 个输出 Token（stop_reason=max_tokens）。请在“设置 → 模型与供应商”调高最大输出 Token 数。`);
  }
  return { content, toolCalls };
}

export interface ModelCallOptions {
  /** 保证本次请求至少有这么多输出 Token。用于结构上必须长输出的步骤（例如文风汇总），不会低于用户自己配置的上限。 */
  minOutputTokens?: number;
  /** 外部取消信号：中止时立刻打断在途请求，并以"已取消"结束，不重试。 */
  signal?: AbortSignal;
}

function resolveOutputTokens(selection: ModelSelection, options?: ModelCallOptions): number {
  const configured = normalizeMaxOutputTokens(selection.model.maxTokens);
  if (!options?.minOutputTokens) return configured;
  return Math.min(MAX_CONFIGURED_OUTPUT_TOKENS, Math.max(configured, options.minOutputTokens));
}

export function callModel(
  selection: ModelSelection,
  messages: AgentMessage[],
  tools: AgentToolDefinition[],
  options?: ModelCallOptions,
): Promise<ModelTurn> {
  if (selection.provider.type === "google-genai") return callGemini(selection, messages, tools, options);
  if (selection.provider.type === "anthropic") return callAnthropic(selection, messages, tools, options);
  if (selection.provider.apiMode === "responses") return callOpenAiResponses(selection, messages, tools, options);
  return callOpenAi(selection, messages, tools, options);
}
