/**
 * 参考书抽样的纯逻辑。这个模块不依赖 expo 或数据库，便于单独推演和验证窗口走向。
 */

export type StyleUnitKind = "chapter" | "segment";

export interface StyleSampleWindow {
  start: number;
  count: number;
}

/** 每轮蒸馏抽取的单元数，也是全书均匀抽样时的样本上限。 */
export const ANALYSIS_PASSAGE_COUNT = 24;

/** 单轮最大跳跃幅度相对窗口大小的倍数。限制它是为了让长篇小说的采样点沿全书铺开，而不是一跳就落到后半本。 */
const MAX_JUMP_WINDOWS = 4;

/** 在 totalUnits 个单元上均匀取 count 个下标，用于不带窗口的全书抽样。 */
export function spreadIndices(totalUnits: number, count: number): number[] {
  const size = Math.min(count, totalUnits);
  return Array.from(
    { length: size },
    (_, index) => Math.round((totalUnits - 1) * index / Math.max(1, size - 1)),
  );
}

/**
 * 单向递增、互不重叠地选出下一个连续采样窗口。
 * 起点从上轮结束位置往后随机跳跃，跳幅上界取剩余单元的一半，
 * 这样既有"1-24 章跳到 100-124 章"的跳跃感，又保证每轮至少推进一个窗口、必然收敛到书尾。
 * 已覆盖到书尾时返回 null。
 */
export function nextSampleWindow(input: {
  totalUnits: number;
  coveredUntil: number;
  windowSize?: number;
  random?: () => number;
}): StyleSampleWindow | null {
  const windowSize = Math.max(1, Math.floor(input.windowSize ?? ANALYSIS_PASSAGE_COUNT));
  const totalUnits = Math.max(0, Math.floor(input.totalUnits));
  const coveredUntil = Math.max(0, Math.min(Math.floor(input.coveredUntil), totalUnits));
  if (totalUnits < 1 || coveredUntil >= totalUnits) return null;
  if (coveredUntil < 1) return { start: 0, count: Math.min(windowSize, totalUnits) };
  const remaining = totalUnits - coveredUntil;
  // 剩余不足两个窗口时直接贴到书尾，避免起点无限逼近却永远读不完最后一段。
  if (remaining <= windowSize * 2) {
    const start = Math.max(coveredUntil, totalUnits - windowSize);
    return { start, count: totalUnits - start };
  }
  const random = input.random ?? Math.random;
  // 跳幅同时受两个上界约束：剩余的一半保证收敛，窗口的固定倍数保证长篇不会一跳跳到后半本。
  const maximumJump = Math.min(
    windowSize * MAX_JUMP_WINDOWS,
    Math.floor((remaining - windowSize) / 2),
  );
  const ratio = Math.min(Math.max(random(), 0), 0.999_999);
  const start = coveredUntil + Math.floor(ratio * (maximumJump + 1));
  return { start, count: Math.min(windowSize, totalUnits - start) };
}

export function describeWindow(unitKind: StyleUnitKind, window: StyleSampleWindow): string {
  const unit = unitKind === "chapter" ? "章" : "段";
  return `第 ${window.start + 1}-${window.start + window.count} ${unit}`;
}
