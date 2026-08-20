export const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;
export const MAX_CONFIGURED_OUTPUT_TOKENS = 131_072;

export function normalizeMaxOutputTokens(value: unknown): number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= 1
    && value <= MAX_CONFIGURED_OUTPUT_TOKENS
    ? value
    : DEFAULT_MAX_OUTPUT_TOKENS;
}
