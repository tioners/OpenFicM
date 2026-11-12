import type { AgentToolDefinition } from "@/llm/types";
import type { AgentDefinition } from "@/settings/config";

/**
 * 每个智能体实际可用的工具。
 *
 * 内容包里的 toolNames 白名单固定在某次提交上（拉取时校验 SHA-256），新增工具
 * 若必须等目录更新才能用，就得重新发布内容包。这里按上游 OpenFic"工具类别"的
 * 思路，从智能体已有的能力推导同类工具：能列章节就能列卷，会写章节就带上卷管理，
 * 会写正文才带文风工具。只读子智能体因此不会白白多背十几份工具定义——每份都会
 * 在每一轮请求里重新发送。
 *
 * 纯函数，不依赖 expo 或数据库，可转译后在 Node 里用真实目录断言。
 */

const CHAPTER_WRITE_TOOL_NAMES = new Set(["write_chapter", "edit_chapter"]);

/** 会写章节的智能体同时拿到卷管理与删章节（对应上游的 chapter_write 类别）。 */
const CHAPTER_MANAGEMENT_TOOL_NAMES = [
  "create_volume",
  "edit_volume",
  "delete_volume",
  "delete_chapter",
  "move_chapter_to_volume",
];

/** 文风工具只配给会写正文的智能体：主智能体，以及白名单里带写章节能力的子智能体。 */
const STYLE_TOOL_NAMES = [
  "read_author_style_guide",
  "save_author_style_guide",
  "evolve_author_style",
  "list_style_sources",
  "read_style_source_sample",
  "list_style_profiles",
  "read_style_profile",
  "select_style_profile",
  "save_reference_style_profile",
];

export function toolsForAgent(
  agent: AgentDefinition,
  tools: AgentToolDefinition[],
): AgentToolDefinition[] {
  // 白名单为空表示"不限制"，用全部工具兜底（自定义智能体的默认行为）。
  const allowed = new Set(agent.toolNames.length ? agent.toolNames : tools.map((tool) => tool.name));
  allowed.add("ask_user");
  // 能列章节就能列卷：写新章节要指定卷，没有 list_volumes 只能靠猜。
  if (allowed.has("list_chapters")) allowed.add("list_volumes");
  const writesChapters = [...CHAPTER_WRITE_TOOL_NAMES].some((name) => allowed.has(name));
  if (writesChapters) for (const name of CHAPTER_MANAGEMENT_TOOL_NAMES) allowed.add(name);
  if (agent.kind === "primary" || writesChapters) for (const name of STYLE_TOOL_NAMES) allowed.add(name);
  if (agent.kind !== "primary") allowed.delete("delegate_agent");
  return tools.filter((tool) => allowed.has(tool.name));
}
