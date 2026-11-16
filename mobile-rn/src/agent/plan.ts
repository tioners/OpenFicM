import type { PlanTodo, PlanTodoPriority, PlanTodoStatus } from "@/types";

/**
 * 会话计划（write_plan 工具）的校验与格式化。与上游 OpenFic 一致：
 * 每次调用全量覆盖，同一时间最多一项 in_progress。
 *
 * 纯函数，不依赖 expo 或数据库。
 */

const STATUSES: readonly PlanTodoStatus[] = ["pending", "in_progress", "completed"];
const PRIORITIES: readonly PlanTodoPriority[] = ["low", "medium", "high"];
export const MAX_PLAN_TODOS = 30;
const MAX_TODO_CHARACTERS = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 校验模型传入的 todos；不合法时抛出可读的错误，让模型能自行修正。 */
export function normalizePlanTodos(value: unknown): PlanTodo[] {
  if (!Array.isArray(value)) throw new Error("todos 必须是数组");
  if (value.length > MAX_PLAN_TODOS) throw new Error(`计划最多 ${MAX_PLAN_TODOS} 项`);
  const todos = value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`第 ${index + 1} 项格式无效`);
    const content = typeof item.content === "string" ? item.content.trim() : "";
    if (!content) throw new Error(`第 ${index + 1} 项缺少内容`);
    const status = STATUSES.find((candidate) => candidate === item.status);
    if (!status) throw new Error(`第 ${index + 1} 项的 status 必须是 pending、in_progress 或 completed`);
    // 优先级省略时按 medium 处理，少一个必填字段能减少模型出错重发。
    const priority = PRIORITIES.find((candidate) => candidate === item.priority) ?? "medium";
    return { content: content.slice(0, MAX_TODO_CHARACTERS), status, priority };
  });
  if (todos.filter((todo) => todo.status === "in_progress").length > 1) {
    throw new Error("同一时间只能有一项处于 in_progress");
  }
  return todos;
}

const STATUS_LABEL: Record<PlanTodoStatus, string> = {
  pending: "待办",
  in_progress: "进行中",
  completed: "已完成",
};

const STATUS_MARK: Record<PlanTodoStatus, string> = {
  pending: "[ ]",
  in_progress: "[>]",
  completed: "[x]",
};

/** 给用户看的清单（执行过程里显示）。 */
export function formatPlanForDisplay(todos: PlanTodo[]): string {
  if (!todos.length) return "计划已清空";
  return todos.map((todo) => `${STATUS_MARK[todo.status]} ${todo.content}`).join("\n");
}

/** 给模型看的当前计划（放进系统提示词）。 */
export function formatPlanForPrompt(todos: PlanTodo[]): string {
  return todos
    .map((todo, index) => `${index + 1}. [${STATUS_LABEL[todo.status]} / ${todo.priority}] ${todo.content}`)
    .join("\n");
}

export function planProgress(todos: PlanTodo[]): string {
  const completed = todos.filter((todo) => todo.status === "completed").length;
  return `${completed}/${todos.length} 已完成`;
}
