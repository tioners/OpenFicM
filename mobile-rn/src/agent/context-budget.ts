import type { AgentMessage } from "@/llm/types";

import { PRUNE_KEEP_RECENT, pruneToolOutputs } from "./context-pruning";

/**
 * 对话历史的保留策略：按消息条数或按 Token 上限截取，超出部分丢弃或压缩成摘要。
 *
 * 这里只做"算"的部分——估算 Token、决定保留哪一段、哪一段需要摘要、摘要请求长什么样；
 * 读设置、调模型、写数据库都在 runtime.ts。纯函数，不依赖 expo 或数据库，可转译后在 Node 里断言。
 */

export type ContextLimitMode = "count" | "tokens";
export type ContextOverflowMode = "drop" | "summarize";

export const DEFAULT_HISTORY_LIMIT = 30;
export const MIN_HISTORY_LIMIT = 4;
export const MAX_HISTORY_LIMIT = 100;
export const DEFAULT_CONTEXT_TOKEN_LIMIT = 128_000;
export const MIN_CONTEXT_TOKEN_LIMIT = 4_000;
export const MAX_CONTEXT_TOKEN_LIMIT = 2_000_000;

/** 估算与真实分词有出入，按上限的这个比例使用，剩下的当余量。 */
const TOKEN_SAFETY_RATIO = 0.9;
/** 上限填得比输出上限还小时的兜底，保证至少放得下最新一条消息。 */
const MIN_INPUT_TOKEN_BUDGET = 2_000;
/** 摘要模式下从历史额度里预留给摘要正文的 Token。 */
export const SUMMARY_TOKEN_RESERVE = 1_500;
/** 摘要正文的字符上限：模型写超了就截断，避免摘要自己把上下文撑大。 */
const SUMMARY_MAX_CHARACTERS = 3_000;
/** 一次摘要请求最多带这么多字符的旧对话；首次对长对话开启摘要时只取离现在最近的部分。 */
const SUMMARY_SOURCE_MAX_CHARACTERS = 24_000;
/** 单条消息进入摘要请求前的字符上限。 */
const SUMMARY_MESSAGE_MAX_CHARACTERS = 3_000;

export interface ContextPolicy {
  limitMode: ContextLimitMode;
  /** 按条数时保留的最近消息数。 */
  historyLimit: number;
  /** 按 Token 时的上限，对应所用模型的上下文窗口。 */
  tokenLimit: number;
  overflow: ContextOverflowMode;
}

function integerInRange(value: string | null, minimum: number, maximum: number): number | null {
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

export function parseContextTokenLimit(value: string | null): number | null {
  return integerInRange(value, MIN_CONTEXT_TOKEN_LIMIT, MAX_CONTEXT_TOKEN_LIMIT);
}

/** 把设置表里的原始字符串解析成策略；缺失或非法的项回到默认值（按条数、丢弃）。 */
export function resolveContextPolicy(raw: {
  limitMode: string | null;
  historyLimit: string | null;
  tokenLimit: string | null;
  overflow: string | null;
}): ContextPolicy {
  return {
    limitMode: raw.limitMode === "tokens" ? "tokens" : "count",
    historyLimit: integerInRange(raw.historyLimit, MIN_HISTORY_LIMIT, MAX_HISTORY_LIMIT) ?? DEFAULT_HISTORY_LIMIT,
    tokenLimit: parseContextTokenLimit(raw.tokenLimit) ?? DEFAULT_CONTEXT_TOKEN_LIMIT,
    overflow: raw.overflow === "summarize" ? "summarize" : "drop",
  };
}

/**
 * 粗略估算 Token：非 ASCII 字符（汉字、全角标点）按 1 个，ASCII 按 0.3 个。
 * 手机上没有各家模型的分词器，这个比例对中文正文略偏保守，配合余量使用。
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) < 128) ascii += 1;
  }
  return Math.ceil(ascii * 0.3 + (text.length - ascii));
}

/** 每条消息的角色、分隔等固定开销。 */
const MESSAGE_OVERHEAD_TOKENS = 4;

export function estimateMessageTokens(message: Pick<AgentMessage, "content" | "toolCalls" | "reasoningContent">): number {
  let tokens = MESSAGE_OVERHEAD_TOKENS + estimateTokens(message.content);
  if (message.toolCalls?.length) tokens += estimateTokens(JSON.stringify(message.toolCalls));
  if (message.reasoningContent) tokens += estimateTokens(message.reasoningContent);
  return tokens;
}

export function estimateMessagesTokens(messages: readonly AgentMessage[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

/** 一次请求的输入最多能用多少 Token：上下文上限扣掉留给回复的输出上限，再留余量。 */
export function inputTokenBudget(tokenLimit: number, maxOutputTokens: number): number {
  return Math.max(MIN_INPUT_TOKEN_BUDGET, Math.floor((tokenLimit - maxOutputTokens) * TOKEN_SAFETY_RATIO));
}

export interface HistoryEntry {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
}

export type HistoryLimit =
  | { mode: "count"; maxMessages: number }
  | { mode: "tokens"; maxTokens: number };

/**
 * 从末尾往前保留，返回保留段的起点下标（等于长度表示一条都留不下）。
 * 保留段总以 user 开头：Anthropic 等协议要求首条非系统消息必须是 user。
 * 按 Token 时最新一条用户消息无论多长都保留，否则本轮请求就没有问题可答。
 */
export function keepFromIndex(history: readonly HistoryEntry[], limit: HistoryLimit): number {
  let start: number;
  if (limit.mode === "count") {
    start = Math.max(0, history.length - limit.maxMessages);
  } else {
    let latestUser = history.length - 1;
    while (latestUser > 0 && history[latestUser].role !== "user") latestUser -= 1;
    start = history.length;
    let total = 0;
    for (let index = history.length - 1; index >= 0; index -= 1) {
      total += estimateMessageTokens(history[index]);
      if (total > limit.maxTokens && index < latestUser) break;
      start = index;
    }
  }
  while (start < history.length && history[start].role !== "user") start += 1;
  return start;
}

function halved(limit: HistoryLimit): HistoryLimit {
  return limit.mode === "count"
    ? { mode: "count", maxMessages: Math.max(2, Math.ceil(limit.maxMessages / 2)) }
    : { mode: "tokens", maxTokens: Math.floor(limit.maxTokens / 2) };
}

/** 保存在对话上的摘要：content 概括了 throughMessageId 及其之前的全部消息。 */
export interface ContextSummary {
  throughMessageId: string;
  content: string;
}

export function parseContextSummary(value: unknown): ContextSummary | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return typeof record.throughMessageId === "string" && record.throughMessageId
    && typeof record.content === "string" && record.content.trim()
    ? { throughMessageId: record.throughMessageId, content: record.content }
    : null;
}

export interface HistoryPlan {
  /** 原样发送的消息从这个下标开始。 */
  keepFrom: number;
  /** 可以直接沿用的已有摘要。 */
  summary: ContextSummary | null;
  /** 需要并入摘要的区间 [from, to)；null 表示本次不用调用模型。 */
  summarize: { from: number; to: number } | null;
  /** 摘要生成失败时退回"丢弃"用的起点。 */
  dropKeepFrom: number;
}

/**
 * 决定这次请求带哪些历史。
 *
 * 丢弃模式：只保留上限内最近的一段。
 * 摘要模式：已有摘要覆盖的部分不再发送；其余部分放得下就原样发，放不下时
 * 一次把较早的一半并入摘要——这样摘要请求只在对话又涨了半个上限后才会再发生，
 * 而不是每轮都多发一次。
 */
export function planHistory(
  history: readonly HistoryEntry[],
  limit: HistoryLimit,
  overflow: ContextOverflowMode,
  cached: ContextSummary | null,
): HistoryPlan {
  if (overflow === "drop") {
    const keepFrom = keepFromIndex(history, limit);
    return { keepFrom, summary: null, summarize: null, dropKeepFrom: keepFrom };
  }
  // 用户编辑过更早的消息后，摘要指向的那条已经不存在，整份摘要作废。
  const coveredIndex = cached ? history.findIndex((entry) => entry.id === cached.throughMessageId) : -1;
  const summary = coveredIndex >= 0 ? cached : null;
  const covered = coveredIndex + 1;
  const rest = history.slice(covered);
  const dropKeepFrom = covered + keepFromIndex(rest, limit);
  if (dropKeepFrom === covered) return { keepFrom: covered, summary, summarize: null, dropKeepFrom };
  const compactTo = covered + keepFromIndex(rest, halved(limit));
  // 减半后一条都留不下（最近几条里没有用户消息）时不压缩，按丢弃处理。
  if (compactTo >= history.length) return { keepFrom: dropKeepFrom, summary, summarize: null, dropKeepFrom };
  return { keepFrom: compactTo, summary, summarize: { from: covered, to: compactTo }, dropKeepFrom };
}

const SUMMARY_INSTRUCTION = [
  "你负责把小说创作助手与作者之间较早的对话压缩成摘要，供助手在后续对话里当作记忆使用。",
  "只输出摘要正文，不要寒暄，不要解释，不要调用工具。",
  "必须保留：作者明确提出的要求、偏好和禁忌；已经确定的设定、情节走向和人物决定；已经完成的操作（写了或改了哪些章节、角色、世界书、笔记）；还没完成、作者仍在等待的事项。",
  "按要点分条书写，忠于原对话，不要补充原文没有的内容，总长度不超过 800 字。",
].join("\n");

function clip(text: string, maximum: number): string {
  return text.length > maximum ? `${text.slice(0, maximum)}…（已截断）` : text;
}

/** 组装摘要请求：把已有摘要和要并入的旧对话交给模型，合并成一份新摘要。 */
export function buildSummaryRequest(previous: string | null, entries: readonly HistoryEntry[]): AgentMessage[] {
  const lines: string[] = [];
  let characters = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    const speaker = entry.role === "user" ? "作者" : entry.role === "assistant" ? "助手" : "系统";
    const line = `【${speaker}】${clip(entry.content.trim(), SUMMARY_MESSAGE_MAX_CHARACTERS)}`;
    if (lines.length && characters + line.length > SUMMARY_SOURCE_MAX_CHARACTERS) break;
    characters += line.length;
    lines.unshift(line);
  }
  const sections = [
    previous ? `此前的摘要：\n${previous}` : null,
    `需要并入摘要的对话：\n${lines.join("\n\n")}`,
    previous ? "请输出合并后的完整摘要。" : "请输出摘要。",
  ].filter(Boolean);
  return [
    { role: "system", content: SUMMARY_INSTRUCTION },
    { role: "user", content: sections.join("\n\n") },
  ];
}

export function normalizeSummaryContent(content: string): string {
  return clip(content.trim(), SUMMARY_MAX_CHARACTERS);
}

/** 把摘要接在系统提示词后面，不占用对话里的 user/assistant 轮次。 */
export function appendSummaryToPrompt(prompt: string, summary: string): string {
  return `${prompt}\n\n# 较早对话的摘要\n以下是本次对话较早部分的摘要，原文已不在上下文里。把它当作已经发生过的事实来延续对话，不要向作者复述这份摘要。\n${summary}`;
}

/**
 * Token 上限模式下的兜底：一次任务里工具结果把请求撑过上限时，不论累计字符数多少，
 * 都清理较早的只读工具结果，仍超出就只保留最近一条。写入类结果始终保留，
 * 所以极端情况下仍可能超限——那时由供应商返回明确的超长错误。
 */
export function fitToolOutputs(messages: AgentMessage[], maxTokens: number): AgentMessage[] {
  let fitted = messages;
  for (const keepRecent of [PRUNE_KEEP_RECENT, 1]) {
    if (estimateMessagesTokens(fitted) <= maxTokens) break;
    fitted = pruneToolOutputs(messages, { minimumCharacters: 0, keepRecent });
  }
  return fitted;
}
