// 4096 写不下一章正文加工具参数：输出被截断后工具参数残缺，模型只能反复重发。
// 思考型模型的推理 Token 也计入这个上限，所以默认值留出余量。
export const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
export const MAX_CONFIGURED_OUTPUT_TOKENS = 131_072;

export function normalizeMaxOutputTokens(value: unknown): number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= 1
    && value <= MAX_CONFIGURED_OUTPUT_TOKENS
    ? value
    : DEFAULT_MAX_OUTPUT_TOKENS;
}
