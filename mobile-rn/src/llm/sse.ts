/**
 * 流式响应（Server-Sent Events）的解析与拼装。
 *
 * 做法是把各协议的增量事件拼回"非流式响应"的形状，再交给 client.ts 里现成的
 * 解析逻辑，这样截断检测、工具参数校验、thought signature 等规则只维护一份。
 *
 * 纯函数，不依赖 expo 或数据库，可转译后在 Node 里用真实事件序列断言。
 */

export type StreamProtocol = "openai-chat" | "openai-responses" | "anthropic" | "gemini";

export interface SseEvent {
  event: string;
  data: string;
}

export interface StreamAccumulator {
  push(event: SseEvent): void;
  /** 拼好的非流式形状响应。 */
  result(): Record<string, any>;
  /** 供应商在流里返回的错误；没有则为 null。 */
  error(): string | null;
  /** 是否已经收到过正文或工具调用（用于判断出错时能否安全重试）。 */
  hasOutput(): boolean;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseData(data: string): Record<string, any> | null {
  const trimmed = data.trim();
  if (!trimmed || trimmed === "[DONE]") return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function errorText(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!isRecord(value)) return null;
  const message = typeof value.message === "string" && value.message.trim() ? value.message.trim() : "";
  const type = typeof value.type === "string" ? value.type : typeof value.code === "string" ? value.code : "";
  if (message) return type && !message.includes(type) ? `${type}: ${message}` : message;
  return type || JSON.stringify(value).slice(0, 500);
}

/**
 * 增量 SSE 解析器：feed 任意切分的文本块，按空行分隔派发事件。
 * 兼容 \r\n、多行 data、注释行（以冒号开头，常被中转站用作心跳）。
 */
export function createSseParser(onEvent: (event: SseEvent) => void): { feed(text: string): void; flush(): void } {
  let buffer = "";
  let eventName = "";
  let dataLines: string[] = [];

  const dispatch = () => {
    if (dataLines.length) onEvent({ event: eventName || "message", data: dataLines.join("\n") });
    eventName = "";
    dataLines = [];
  };
  const handleLine = (line: string) => {
    if (!line) {
      dispatch();
      return;
    }
    if (line.startsWith(":")) return;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value;
    else if (field === "data") dataLines.push(value);
  };

  return {
    feed(text: string) {
      buffer += text;
      let newline = buffer.search(/\r\n|\n|\r/);
      while (newline >= 0) {
        // 末尾的单个 \r 可能是被切开的 \r\n，等下一块再判断。
        if (buffer[newline] === "\r" && newline === buffer.length - 1) break;
        const width = buffer[newline] === "\r" && buffer[newline + 1] === "\n" ? 2 : 1;
        handleLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + width);
        newline = buffer.search(/\r\n|\n|\r/);
      }
    },
    flush() {
      if (buffer) handleLine(buffer.replace(/\r$/, ""));
      buffer = "";
      dispatch();
    },
  };
}

function openAiChatAccumulator(): StreamAccumulator {
  let content = "";
  let reasoning = "";
  let sawReasoning = false;
  let finishReason = "";
  let failure: string | null = null;
  const calls: { id: string; name: string; arguments: string; extra?: Record<string, unknown> }[] = [];

  return {
    push(event) {
      const data = parseData(event.data);
      if (!data) return;
      if (data.error) {
        failure = errorText(data.error) ?? "未知错误";
        return;
      }
      const choice = isRecord(data.choices?.[0]) ? data.choices[0] : null;
      if (!choice) return;
      if (typeof choice.finish_reason === "string" && choice.finish_reason) finishReason = choice.finish_reason;
      // 少数中转站在流里直接给完整 message 而不是 delta。
      const delta = isRecord(choice.delta) ? choice.delta : isRecord(choice.message) ? choice.message : null;
      if (!delta) return;
      if (typeof delta.content === "string") content += delta.content;
      if (typeof delta.reasoning_content === "string") {
        sawReasoning = true;
        reasoning += delta.reasoning_content;
      }
      for (const part of Array.isArray(delta.tool_calls) ? delta.tool_calls.filter(isRecord) : []) {
        const index = Number.isInteger(part.index) ? part.index as number : calls.length ? calls.length - 1 : 0;
        const call = calls[index] ?? (calls[index] = { id: "", name: "", arguments: "" });
        if (typeof part.id === "string" && part.id) call.id = part.id;
        if (typeof part.function?.name === "string" && part.function.name) call.name = part.function.name;
        if (typeof part.function?.arguments === "string") call.arguments += part.function.arguments;
        else if (isRecord(part.function?.arguments)) call.arguments = JSON.stringify(part.function.arguments);
        for (const key of ["extra_content", "extraContent", "provider_metadata", "providerMetadata"]) {
          if (isRecord(part[key])) call.extra = { ...(call.extra ?? {}), [key]: part[key] };
        }
        for (const key of ["thought_signature", "thoughtSignature"]) {
          if (typeof part[key] === "string") call.extra = { ...(call.extra ?? {}), [key]: part[key] };
        }
      }
    },
    result() {
      const toolCalls = calls.filter(Boolean).map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
        ...(call.extra ?? {}),
      }));
      return {
        choices: [{
          message: {
            role: "assistant",
            content,
            ...(sawReasoning ? { reasoning_content: reasoning } : {}),
            ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: finishReason,
        }],
      };
    },
    error: () => failure,
    hasOutput: () => Boolean(content || calls.length),
  };
}

function anthropicAccumulator(): StreamAccumulator {
  const blocks: Record<string, any>[] = [];
  const partialJson = new Map<number, string>();
  let stopReason = "";
  let failure: string | null = null;
  let invalidToolInput = false;

  return {
    push(event) {
      const data = parseData(event.data);
      if (!data) return;
      const type = typeof data.type === "string" ? data.type : event.event;
      if (type === "error") {
        failure = errorText(data.error) ?? "未知错误";
      } else if (type === "content_block_start" && Number.isInteger(data.index) && isRecord(data.content_block)) {
        blocks[data.index] = { ...data.content_block };
        if (data.content_block.type === "tool_use") partialJson.set(data.index, "");
      } else if (type === "content_block_delta" && Number.isInteger(data.index) && isRecord(data.delta)) {
        const block = blocks[data.index];
        if (!block) return;
        if (data.delta.type === "text_delta" && typeof data.delta.text === "string") {
          block.text = `${typeof block.text === "string" ? block.text : ""}${data.delta.text}`;
        } else if (data.delta.type === "input_json_delta" && typeof data.delta.partial_json === "string") {
          partialJson.set(data.index, `${partialJson.get(data.index) ?? ""}${data.delta.partial_json}`);
        }
      } else if (type === "message_delta" && isRecord(data.delta)) {
        if (typeof data.delta.stop_reason === "string") stopReason = data.delta.stop_reason;
      }
    },
    result() {
      const content: Record<string, any>[] = [];
      blocks.forEach((block, index) => {
        if (!block) return;
        if (block.type !== "tool_use") {
          content.push(block);
          return;
        }
        const raw = (partialJson.get(index) ?? "").trim();
        if (!raw) {
          content.push({ ...block, input: isRecord(block.input) ? block.input : {} });
          return;
        }
        try {
          const parsed: unknown = JSON.parse(raw);
          if (isRecord(parsed)) {
            content.push({ ...block, input: parsed });
            return;
          }
        } catch {
          // 落到下面统一标记
        }
        invalidToolInput = true;
        content.push({ ...block, input: {} });
      });
      return { content, stop_reason: stopReason, ...(invalidToolInput ? { invalid_tool_input: true } : {}) };
    },
    error: () => failure,
    hasOutput: () => blocks.some((block) => block && (block.type === "tool_use" || Boolean(block.text))),
  };
}

function geminiAccumulator(): StreamAccumulator {
  const parts: Record<string, any>[] = [];
  let finishReason = "";
  let promptFeedback: unknown;
  let failure: string | null = null;

  return {
    push(event) {
      const data = parseData(event.data);
      if (!data) return;
      if (data.error) {
        failure = errorText(data.error) ?? "未知错误";
        return;
      }
      if (data.promptFeedback !== undefined) promptFeedback = data.promptFeedback;
      const candidate = isRecord(data.candidates?.[0]) ? data.candidates[0] : null;
      if (!candidate) return;
      if (typeof candidate.finishReason === "string" && candidate.finishReason) finishReason = candidate.finishReason;
      for (const part of Array.isArray(candidate.content?.parts) ? candidate.content.parts.filter(isRecord) : []) {
        parts.push(part);
      }
    },
    result() {
      return {
        candidates: [{ content: { parts }, ...(finishReason ? { finishReason } : {}) }],
        ...(promptFeedback === undefined ? {} : { promptFeedback }),
      };
    },
    error: () => failure,
    hasOutput: () => parts.some((part) => part.functionCall || (typeof part.text === "string" && part.text)),
  };
}

function openAiResponsesAccumulator(): StreamAccumulator {
  let finalResponse: Record<string, any> | null = null;
  const items: Record<string, any>[] = [];
  let failure: string | null = null;
  let sawText = false;

  return {
    push(event) {
      const data = parseData(event.data);
      if (!data) return;
      const type = typeof data.type === "string" ? data.type : event.event;
      if (type === "error") {
        failure = errorText(data.error ?? data) ?? "未知错误";
      } else if (type === "response.output_text.delta") {
        sawText = true;
      } else if (type === "response.output_item.done" && isRecord(data.item)) {
        items.push(data.item);
      } else if ((type === "response.completed" || type === "response.incomplete" || type === "response.failed") && isRecord(data.response)) {
        finalResponse = data.response;
      }
    },
    result() {
      const response: Record<string, any> = finalResponse ?? {};
      // 有的中转站在 completed 事件里不带 output，用逐项完成事件兜底。
      const output = Array.isArray(response.output) && response.output.length ? response.output : items;
      return { ...response, output };
    },
    error: () => failure,
    hasOutput: () => sawText || items.length > 0,
  };
}

export function createStreamAccumulator(protocol: StreamProtocol): StreamAccumulator {
  if (protocol === "anthropic") return anthropicAccumulator();
  if (protocol === "gemini") return geminiAccumulator();
  if (protocol === "openai-responses") return openAiResponsesAccumulator();
  return openAiChatAccumulator();
}

export interface StreamReadResult {
  data: Record<string, any>;
  /** 流内错误事件；retryable 表示尚未产生任何输出且属于限流/过载，可以等待后重发。 */
  error: { message: string; retryable: boolean } | null;
}

const RETRYABLE_STREAM_ERROR_PATTERN = /(rate.?limit|too many requests|overloaded|unavailable|429|限流|繁忙|过载)/i;
const MAX_RAW_FALLBACK_CHARACTERS = 2_000_000;

/** 响应体内容本身不合法（空、非 JSON）；与传输中断区分开，后者由调用方按网络错误处理。 */
export class StreamFormatError extends Error {}

/**
 * 读完整个流式响应体。onChunk 在每次收到数据时调用，调用方用它重置空闲超时。
 * 如果对方无视 stream 参数直接返回了普通 JSON，这里原样解析返回，不需要再发一次请求。
 */
export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  protocol: StreamProtocol,
  onChunk?: () => void,
): Promise<StreamReadResult> {
  const accumulator = createStreamAccumulator(protocol);
  let events = 0;
  let raw = "";
  const parser = createSseParser((event) => {
    events += 1;
    accumulator.push(event);
  });
  const decoder = new TextDecoder();
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onChunk?.();
      const text = decoder.decode(value, { stream: true });
      if (!events && raw.length < MAX_RAW_FALLBACK_CHARACTERS) raw += text;
      parser.feed(text);
    }
    const tail = decoder.decode();
    if (tail) {
      if (!events) raw += tail;
      parser.feed(tail);
    }
    parser.flush();
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // 流已出错或已关闭时 releaseLock 可能抛错，忽略即可。
    }
  }

  if (!events) {
    const trimmed = raw.trim();
    if (!trimmed) throw new StreamFormatError("模型服务返回了空响应体");
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new StreamFormatError(`模型服务返回了无法解析的非 JSON 响应：${trimmed.slice(0, 300)}`);
    }
    if (!isRecord(parsed)) throw new StreamFormatError(`模型服务返回的 JSON 不是对象：${trimmed.slice(0, 300)}`);
    return { data: parsed, error: null };
  }

  const message = accumulator.error();
  return {
    data: accumulator.result(),
    error: message
      ? { message, retryable: !accumulator.hasOutput() && RETRYABLE_STREAM_ERROR_PATTERN.test(message) }
      : null,
  };
}
