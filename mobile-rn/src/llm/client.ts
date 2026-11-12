import { fetch as streamingFetch } from "expo/fetch";

import type { ModelSelection } from "@/types";
import { getSetting } from "@/data/repositories";

import type { AgentMessage, AgentToolCall, AgentToolDefinition, ModelTurn } from "./types";
import { MAX_CONFIGURED_OUTPUT_TOKENS, normalizeMaxOutputTokens } from "./limits";
import { buildResponsesRequestBody, parseResponsesTurn } from "./responses-api";
import { readSseStream, StreamFormatError, type StreamProtocol, type StreamReadResult } from "./sse";

const CANCELLED_MESSAGE = "已取消本次请求";

const REQUEST_TIMEOUT_MS = 120_000;
// 以下重试默认值会被"连接"设置里的可选项覆盖（issue #4）。
const DEFAULT_MAX_REQUEST_ATTEMPTS = 3;
// 服务端过载类错误只重试一次，避免中转站限流时把请求量再翻倍。
const DEFAULT_MAX_SERVER_ERROR_ATTEMPTS = 2;
// 限流默认等待后重试：上游 OpenFic 同样是"退避重试"而不是立刻失败，
// 直接抛错会让一次限流废掉整轮任务，重试反而更容易打满中转站。
const DEFAULT_MAX_RATE_LIMIT_ATTEMPTS = 3;
// 限流等待更久：RPM/TPM 限流通常按分钟窗口恢复，1.5 秒级的退避等不到窗口重置。
const RATE_LIMIT_BASE_DELAY_MS = 5_000;
const RATE_LIMIT_MAX_DELAY_MS = 30_000;
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
// 额度/余额类 429 与限流不同：等多久都不会恢复，重试只是浪费时间和请求数。
const QUOTA_EXHAUSTED_PATTERN = /(quota|insufficient|billing|balance|credit|额度|余额|欠费|配额)/i;

export interface ConnectionRetrySettings {
  requestTimeoutMs: number;
  /** 网络错误与超时最多尝试几次（含第一次）。0/1 表示不重试。 */
  maxRequestAttempts: number;
  /** 5xx 等服务器错误最多尝试几次（含第一次）。 */
  maxServerErrorAttempts: number;
  /** 429 限流最多尝试几次（含第一次）。默认 3，每次按 Retry-After 或退避等待后再发。 */
  maxRateLimitAttempts: number;
  /** 超时时是否自动重发。默认 false：超时后服务端多半仍在生成，自动重发会重复计费。 */
  retryOnTimeout: boolean;
  /** 是否用流式（SSE）接收回复。默认 true；个别不支持流式的中转站可以关闭。 */
  streamResponses: boolean;
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
  const [timeoutValue, attemptsValue, serverAttemptsValue, rateLimitAttemptsValue, retryOnTimeoutValue, streamValue] = await Promise.all([
    getSetting("connections.requestTimeout"),
    getSetting("connections.maxAttempts"),
    getSetting("connections.maxServerErrorAttempts"),
    getSetting("connections.maxRateLimitAttempts"),
    getSetting("connections.retryOnTimeout"),
    getSetting("connections.streamResponses"),
  ]);
  retrySettingsCache = {
    requestTimeoutMs: boundedSetting(timeoutValue, REQUEST_TIMEOUT_MS, 10_000, 300_000),
    maxRequestAttempts: boundedSetting(attemptsValue, DEFAULT_MAX_REQUEST_ATTEMPTS, 1, 5),
    maxServerErrorAttempts: boundedSetting(serverAttemptsValue, DEFAULT_MAX_SERVER_ERROR_ATTEMPTS, 1, 3),
    maxRateLimitAttempts: boundedSetting(rateLimitAttemptsValue, DEFAULT_MAX_RATE_LIMIT_ATTEMPTS, 1, 5),
    retryOnTimeout: retryOnTimeoutValue === "true",
    // 默认开启：未设置过（null）时也按开启处理。
    streamResponses: streamValue !== "false",
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

/**
 * 解析模型返回的工具参数字符串。
 *
 * 解析失败时不能悄悄当成 `{}`：工具会以"缺少参数"失败，模型接着把同一个
 * 调用再发一遍，一次截断就能空转掉好几次请求。这里把"不合法"显式标出来，
 * 由调用方决定报错；同时兼容部分模型把参数对象再包一层 JSON 字符串的写法。
 */
function parseToolArguments(raw: string): { arguments: Record<string, unknown>; invalid: boolean } {
  const trimmed = raw.trim();
  // 无参数工具允许空串。
  if (!trimmed) return { arguments: {}, invalid: false };
  try {
    let parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "string") parsed = JSON.parse(parsed);
    return isRecord(parsed) ? { arguments: parsed, invalid: false } : { arguments: {}, invalid: true };
  } catch {
    return { arguments: {}, invalid: true };
  }
}

const INVALID_TOOL_ARGUMENTS_MESSAGE = "模型返回的工具参数不是合法 JSON，已放弃执行本次工具调用。通常是输出被截断或中转站改写了响应，请调高最大输出 Token 数或更换模型后重试。";

/** 输出被上限截断时仍带着工具调用：参数多半不完整，执行它只会写入残缺内容或空转重试。 */
function truncatedToolCallError(maxOutputTokens: number, reason: string): Error {
  return new Error(`模型在生成工具调用时用完了 ${maxOutputTokens} 个输出 Token（${reason}），本次工具参数不完整，已放弃执行以免写入残缺内容。思考型模型的推理过程也计入这个上限，请在“设置 → 模型与供应商”调高最大输出 Token 数后重试；改动较小时也可以让助手只做局部修改。`);
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
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(RATE_LIMIT_MAX_DELAY_MS, seconds * 1_000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(RATE_LIMIT_MAX_DELAY_MS, Math.max(0, date - Date.now()));
  }
  if (response.status === 429) return rateLimitDelay(attempt);
  return Math.min(8_000, 1_500 * 2 ** attempt);
}

function rateLimitDelay(attempt: number): number {
  return Math.min(RATE_LIMIT_MAX_DELAY_MS, RATE_LIMIT_BASE_DELAY_MS * 2 ** attempt);
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

/** 传输层故障（流中途断开等）：与 HTTP 错误、响应格式错误区分开，按网络错误的规则重试。 */
class TransportError extends Error {}

function parseResponseText(text: string, ok: boolean): Record<string, any> {
  if (!text) {
    if (ok) throw new Error("模型服务返回了空响应体");
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 丢掉响应体会让这类故障完全无法诊断，带一段原文出来。
    if (ok) throw new Error(`模型服务返回了无法解析的非 JSON 响应：${text.trim().slice(0, 300)}`);
    return {};
  }
  if (isRecord(parsed)) return parsed;
  if (ok) throw new Error(`模型服务返回的 JSON 不是对象：${text.trim().slice(0, 300)}`);
  return {};
}

/**
 * 发出一次模型请求并返回"非流式形状"的响应。
 * 传入 streamProtocol 时按 SSE 读取并拼回同样的形状，后面的解析逻辑不用区分两种方式。
 */
async function requestJson(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
  streamProtocol?: StreamProtocol,
): Promise<Record<string, any>> {
  const settings = await getConnectionRetrySettings();
  const requestTimeout = settings.requestTimeoutMs;
  // 三类错误各有上限，循环次数取最大的那个，否则调高限流重试次数也会被网络重试上限截住。
  const maxLoopAttempts = Math.max(
    settings.maxRequestAttempts,
    settings.maxServerErrorAttempts,
    settings.maxRateLimitAttempts,
  );
  let lastError: unknown;
  for (let attempt = 0; attempt < maxLoopAttempts; attempt += 1) {
    if (signal?.aborted) throw new Error(CANCELLED_MESSAGE);
    const controller = new AbortController();
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    // 流式时每收到一块数据就重新计时，相当于"空闲超时"：长章节只要还在出字就不会被掐断。
    const armTimeout = () => {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, requestTimeout);
    };
    armTimeout();
    // 外部取消（例如后台蒸馏被用户中止）要立刻打断在途请求；AbortSignal.any 在 Hermes 上不保证可用，手动桥接。
    const abortFromCaller = () => controller.abort();
    signal?.addEventListener("abort", abortFromCaller, { once: true });
    try {
      // React Native 自带的 fetch 拿不到响应流，流式必须走 expo/fetch。
      const response = streamProtocol
        ? await streamingFetch(url, { ...init, signal: controller.signal })
        : await fetch(url, { ...init, signal: controller.signal });
      if (streamProtocol && response.ok && response.body) {
        let streamed: StreamReadResult;
        try {
          streamed = await readSseStream(response.body, streamProtocol, armTimeout);
        } catch (streamError) {
          if (streamError instanceof StreamFormatError) throw streamError;
          const reason = streamError instanceof Error ? streamError.message : String(streamError);
          throw new TransportError(`fetch failed: 响应流中断（${reason}）`);
        }
        if (!streamed.error) return streamed.data;
        const streamFailure = new Error(`模型服务返回失败：${streamed.error.message}`);
        lastError = streamFailure;
        // 流里的限流/过载错误：还没产生任何输出时才重发，否则会重复计费并丢掉已生成的内容。
        if (!streamed.error.retryable
          || QUOTA_EXHAUSTED_PATTERN.test(streamed.error.message)
          || attempt + 1 >= settings.maxRateLimitAttempts) {
          throw streamFailure;
        }
        await sleep(rateLimitDelay(attempt), signal);
        continue;
      }
      const text = await response.text();
      const data = parseResponseText(text, response.ok);
      if (response.ok) return data;
      const detail = errorDetail(data, text, response.statusText);
      const requestError = new Error(`HTTP ${response.status}: ${detail}`);
      lastError = requestError;
      // 额度或余额用完也会以 429 返回，但等待不会恢复：直接报错，不占用重试次数。
      if (response.status === 429 && QUOTA_EXHAUSTED_PATTERN.test(detail)) throw requestError;
      // 限流按 Retry-After 或退避等待后重发；尝试次数可在"连接"设置里调整。
      const maxAttempts = response.status === 429 ? settings.maxRateLimitAttempts : settings.maxServerErrorAttempts;
      if (!RETRYABLE_STATUS_CODES.has(response.status) || attempt + 1 >= maxAttempts) throw requestError;
      await sleep(retryDelay(response, attempt), signal);
    } catch (error) {
      // 用户主动取消不是故障：不要重试，也不要报成超时或网络错误。
      if (signal?.aborted) throw new Error(CANCELLED_MESSAGE);
      // expo/fetch 的中止与连接失败不是 AbortError/TypeError，所以超时用自己的标记判断，
      // 连接失败按它固定的 "fetch failed" 前缀识别。
      const isTimeout = timedOut || (isRecord(error) && error.name === "AbortError");
      const isNetwork = !isTimeout && (
        error instanceof TypeError
        || error instanceof TransportError
        || (error instanceof Error && /^fetch failed/i.test(error.message))
      );
      if (isTimeout) {
        lastError = new Error(streamProtocol
          ? `模型请求超时：${Math.round(requestTimeout / 1_000)} 秒内没有收到任何数据，请检查网络或 Base URL`
          : "模型请求超时，请检查网络或 Base URL");
      } else if (error instanceof TypeError) {
        const detail = error.message.trim();
        lastError = new Error(`fetch failed${detail ? `: ${detail}` : ""}`);
      } else {
        lastError = error;
      }
      if (attempt + 1 >= settings.maxRequestAttempts || !(isTimeout || isNetwork)) {
        throw lastError;
      }
      // 超时时默认不重发：服务端多半还在生成，重发会重复计费；可在"连接"设置里开启。
      if (isTimeout && !settings.retryOnTimeout) {
        throw lastError;
      }
      await sleep(Math.min(4_000, 1_000 * 2 ** attempt), signal);
    } finally {
      if (timeout) clearTimeout(timeout);
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
      ...(options?.stream ? { stream: true } : {}),
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
        // 只在供应商自己返回过推理内容时带回（空串也算），不给其它供应商发它们不认识的字段。
        ...(message.role === "assistant" && message.reasoningContent !== undefined
          ? { reasoning_content: message.reasoningContent }
          : {}),
      })),
      ...(tools.length ? {
        tools: tools.map((tool) => ({ type: "function", function: tool })),
        tool_choice: "auto",
      } : {}),
    }),
  }, options?.signal, options?.stream ? "openai-chat" : undefined);
  const choice = isRecord(data.choices?.[0]) ? data.choices[0] : {};
  const message = choice.message ?? {};
  const finishReason = typeof choice.finish_reason === "string" ? choice.finish_reason : "";
  let hasInvalidArguments = false;
  const toolCalls: AgentToolCall[] = (message.tool_calls ?? [])
    .filter((call: unknown): call is Record<string, any> => isRecord(call))
    .map((call: Record<string, any>) => {
      const metadata = openAiExtraContent(call);
      const rawArguments = call.function?.arguments;
      const parsed = isRecord(rawArguments)
        ? { arguments: rawArguments, invalid: false }
        : parseToolArguments(String(rawArguments ?? ""));
      if (parsed.invalid) hasInvalidArguments = true;
      return {
        id: String(call.id ?? ""),
        name: String(call.function?.name ?? ""),
        arguments: parsed.arguments,
        ...(metadata ? { providerMetadata: { openAiExtraContent: metadata } } : {}),
      };
    });
  const content = typeof message.content === "string" ? message.content : "";
  if (toolCalls.length && finishReason === "length") {
    throw truncatedToolCallError(maxOutputTokens, "finish_reason=length");
  }
  if (hasInvalidArguments) {
    throw new Error(INVALID_TOOL_ARGUMENTS_MESSAGE);
  }
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
  // DeepSeek 等思考模型要求把带工具调用的回复里的 reasoning_content 原样带回下一轮，
  // 缺了会报 "The reasoning_content in the thinking mode must be passed back to the API"。
  return {
    content,
    toolCalls,
    ...(typeof message.reasoning_content === "string" ? { reasoningContent: message.reasoning_content } : {}),
  };
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
    body: JSON.stringify({
      ...buildResponsesRequestBody({
        modelId: selection.model.modelId,
        instructions,
        temperature: selection.model.temperature,
        maxOutputTokens,
        tools,
        messages,
      }),
      ...(options?.stream ? { stream: true } : {}),
    }),
  }, options?.signal, options?.stream ? "openai-responses" : undefined);
  const turn = parseResponsesTurn(data);
  if (turn.failureMessage) throw new Error(`模型服务返回失败：${turn.failureMessage}`);
  if (turn.toolCalls.length && turn.incompleteReason === "max_output_tokens") {
    throw truncatedToolCallError(maxOutputTokens, "incomplete_details.reason=max_output_tokens");
  }
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

/**
 * 请求前的最后一道保险：Gemini 只接受"properties 的每个值都是对象"。
 * 不论 schema 来自内置工具、插件还是以后接入的远程工具，只要出现字符串等
 * 非对象值，就地改写成 { type }，避免整次请求 400。
 */
function sanitizeGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeGeminiSchema);
  if (!isRecord(schema)) return schema;
  const output: Record<string, unknown> = { ...schema };
  if (isRecord(schema.properties)) {
    const properties: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(schema.properties)) {
      if (typeof value === "string") properties[name] = { type: value.toUpperCase() };
      else if (isRecord(value)) properties[name] = sanitizeGeminiSchema(value);
      else properties[name] = { type: "STRING" };
    }
    output.properties = properties;
  }
  if (isRecord(schema.items)) output.items = sanitizeGeminiSchema(schema.items);
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
  // Gemini 的流式是另一个方法名，alt=sse 让它按 SSE 而不是 JSON 数组返回。
  const url = `${baseUrl}/models/${encodeURIComponent(selection.model.modelId)}:${options?.stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
  const data = await requestJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": selection.apiKey },
    body: JSON.stringify({
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      contents: geminiContents(messages),
      ...(tools.length ? {
        tools: [{ functionDeclarations: tools.map((tool) => {
          const parameters = sanitizeGeminiSchema(toGeminiSchema(tool.parameters));
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
  }, options?.signal, options?.stream ? "gemini" : undefined);
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
  if (toolCalls.length && finishReason === "MAX_TOKENS") {
    throw truncatedToolCallError(maxOutputTokens, "finishReason=MAX_TOKENS");
  }
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
      ...(options?.stream ? { stream: true } : {}),
      messages: anthropicMessages(messages),
      ...(tools.length ? {
        tools: tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })),
      } : {}),
    }),
  }, options?.signal, options?.stream ? "anthropic" : undefined);
  const blocks: any[] = data.content ?? [];
  const content = blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
  const toolCalls = blocks.filter((block) => block.type === "tool_use").map((block) => ({
    id: String(block.id), name: String(block.name), arguments: block.input ?? {},
  }));
  if (toolCalls.length && data.stop_reason === "max_tokens") {
    throw truncatedToolCallError(maxOutputTokens, "stop_reason=max_tokens");
  }
  // 流式拼装时发现工具参数不是完整 JSON（sse.ts 里标记），不执行残缺调用。
  if (data.invalid_tool_input === true) {
    throw new Error(INVALID_TOOL_ARGUMENTS_MESSAGE);
  }
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
  /** 是否流式接收；省略时按"连接"设置（默认开启）。 */
  stream?: boolean;
}

function resolveOutputTokens(selection: ModelSelection, options?: ModelCallOptions): number {
  const configured = normalizeMaxOutputTokens(selection.model.maxTokens);
  if (!options?.minOutputTokens) return configured;
  return Math.min(MAX_CONFIGURED_OUTPUT_TOKENS, Math.max(configured, options.minOutputTokens));
}

export async function callModel(
  selection: ModelSelection,
  messages: AgentMessage[],
  tools: AgentToolDefinition[],
  options?: ModelCallOptions,
): Promise<ModelTurn> {
  const settings = await getConnectionRetrySettings();
  const resolved: ModelCallOptions = { ...options, stream: options?.stream ?? settings.streamResponses };
  if (selection.provider.type === "google-genai") return callGemini(selection, messages, tools, resolved);
  if (selection.provider.type === "anthropic") return callAnthropic(selection, messages, tools, resolved);
  if (selection.provider.apiMode === "responses") return callOpenAiResponses(selection, messages, tools, resolved);
  return callOpenAi(selection, messages, tools, resolved);
}
