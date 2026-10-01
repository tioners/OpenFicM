import { createId } from "@/lib/id";
import { resolveModelSelection } from "@/llm/selection";
import {
  distillReferenceStyle,
  getStyleDistillationCoverage,
  type StyleDistillationResult,
} from "@/settings/lorn-style-plugin";
import type { ModelSelection } from "@/types";

import { useStyleDistillationStore } from "./distillation-store";

let controller: AbortController | null = null;

export interface StartDistillationResult {
  started: boolean;
  message?: string;
}

/**
 * 发起参考文风蒸馏并立刻返回：任务在后台继续，进度写进 distillation-store。
 * 页面不需要（也不应该）await 它，否则又会退化成"必须等任务结束才能操作"。
 */
export async function startStyleDistillation(input: {
  sourceId: string;
  sourceTitle: string;
  restart?: boolean;
}): Promise<StartDistillationResult> {
  const store = useStyleDistillationStore.getState();
  if (store.task) {
    return {
      started: false,
      message: `正在蒸馏《${store.task.sourceTitle}》，等它完成或取消后再开始新的任务`,
    };
  }
  let selection: ModelSelection;
  try {
    selection = await resolveModelSelection();
  } catch (error) {
    return { started: false, message: error instanceof Error ? error.message : String(error) };
  }
  const runId = createId();
  controller = new AbortController();
  store.startTask({
    runId,
    sourceId: input.sourceId,
    sourceTitle: input.sourceTitle,
    stage: "sampling",
    label: input.restart ? "重新开始蒸馏章节样本" : "准备蒸馏章节样本",
    completed: 0,
    total: 1,
    startedAt: new Date().toISOString(),
  });
  void runDistillation({
    runId,
    sourceId: input.sourceId,
    sourceTitle: input.sourceTitle,
    restart: input.restart,
    selection,
    signal: controller.signal,
  });
  return { started: true };
}

export function cancelStyleDistillation(): void {
  controller?.abort();
}

async function runDistillation(input: {
  runId: string;
  sourceId: string;
  sourceTitle: string;
  restart?: boolean;
  selection: ModelSelection;
  signal: AbortSignal;
}): Promise<void> {
  const store = useStyleDistillationStore.getState();
  try {
    const result: StyleDistillationResult = await distillReferenceStyle({
      sourceId: input.sourceId,
      selection: input.selection,
      restart: input.restart,
      signal: input.signal,
      onProgress: (progress) => useStyleDistillationStore.getState().updateTask(progress),
    });
    store.finishTask({
      runId: input.runId,
      sourceId: input.sourceId,
      sourceTitle: input.sourceTitle,
      cancelled: false,
      error: null,
      round: result.round,
      coveredUntil: result.coverage.coveredUntil,
      totalUnits: result.coverage.totalUnits,
      unitKind: result.coverage.unitKind,
      reachedEnd: result.reachedEnd,
      finishedAt: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const cancelled = input.signal.aborted;
    // 失败或取消时进度只停在数据库里，读回来告诉用户"已覆盖到哪、还能接着蒸"。
    const coverage = await getStyleDistillationCoverage(input.sourceId).catch(() => null);
    store.finishTask({
      runId: input.runId,
      sourceId: input.sourceId,
      sourceTitle: input.sourceTitle,
      cancelled,
      error: cancelled ? null : message,
      round: coverage?.rounds ?? 0,
      coveredUntil: coverage?.coveredUntil ?? 0,
      totalUnits: coverage?.totalUnits ?? 0,
      unitKind: coverage?.unitKind ?? "chapter",
      reachedEnd: false,
      finishedAt: new Date().toISOString(),
    });
  } finally {
    controller = null;
  }
}
