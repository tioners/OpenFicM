import { create } from "zustand";

import type { StyleDistillationProgress } from "@/settings/lorn-style-plugin";

/**
 * 蒸馏任务的后台状态：页面只负责发起，任务本身活在 store 里，
 * 所以离开文风书库、关掉弹层、切到别的作品都不影响它继续跑。
 */
export interface StyleDistillationTask {
  runId: string;
  sourceId: string;
  sourceTitle: string;
  stage: StyleDistillationProgress["stage"];
  label: string;
  completed: number;
  total: number;
  startedAt: string;
}

export interface StyleDistillationOutcome {
  runId: string;
  sourceId: string;
  sourceTitle: string;
  cancelled: boolean;
  error: string | null;
  round: number;
  coveredUntil: number;
  totalUnits: number;
  unitKind: "chapter" | "segment";
  reachedEnd: boolean;
  finishedAt: string;
}

interface StyleDistillationState {
  task: StyleDistillationTask | null;
  outcome: StyleDistillationOutcome | null;
  /** 每次任务结束自增，页面据此刷新列表与覆盖进度。 */
  revision: number;
  startTask: (task: StyleDistillationTask) => void;
  updateTask: (progress: StyleDistillationProgress) => void;
  finishTask: (outcome: StyleDistillationOutcome) => void;
  dismissOutcome: () => void;
}

export const useStyleDistillationStore = create<StyleDistillationState>((set) => ({
  task: null,
  outcome: null,
  revision: 0,
  startTask: (task) => set({ task, outcome: null }),
  updateTask: (progress) => set((state) => (state.task
    ? {
      task: {
        ...state.task,
        stage: progress.stage,
        label: progress.label,
        completed: progress.completed,
        total: progress.total,
      },
    }
    : {})),
  finishTask: (outcome) => set((state) => ({ task: null, outcome, revision: state.revision + 1 })),
  dismissOutcome: () => set({ outcome: null }),
}));

/** 是否正在蒸馏；传 sourceId 时只判断这一本参考书。 */
export function isDistilling(sourceId?: string): boolean {
  const task = useStyleDistillationStore.getState().task;
  if (!task) return false;
  return sourceId ? task.sourceId === sourceId : true;
}
