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

export interface ToolAvailability {
  /** 已配置联网搜索服务。 */
  webSearch: boolean;
  /** 允许读取网页（配置了搜索服务，或用户单独打开了开关）。 */
  webFetch: boolean;
  /** 当前对话里有附件。 */
  attachments: boolean;
  /** 用户在设置里打开了"允许助手管理技能"。 */
  skillManagement: boolean;
}

export const NO_OPTIONAL_TOOLS: ToolAvailability = {
  webSearch: false,
  webFetch: false,
  attachments: false,
  skillManagement: false,
};

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

const RELATIONSHIP_WRITE_TOOL_NAMES = [
  "create_character_relationship",
  "edit_character_relationship",
  "delete_character_relationship",
];
const NOTE_CATEGORY_WRITE_TOOL_NAMES = [
  "create_note_category",
  "edit_note_category",
  "delete_note_category",
  "set_note_category",
];
const SKILL_MANAGEMENT_TOOL_NAMES = ["list_skills", "get_skill", "create_skill", "edit_skill", "delete_skill"];
const WEB_TOOL_NAMES = ["web_search", "web_fetch"];
const FILE_TOOL_NAMES = ["list_file", "read_file"];
/** 这些工具只按下面的规则下发；即使自定义智能体的白名单为空（不限制）也不会无条件带上。 */
const CONDITIONAL_TOOL_NAMES = [...WEB_TOOL_NAMES, ...FILE_TOOL_NAMES, ...SKILL_MANAGEMENT_TOOL_NAMES, "write_plan"];

/** 负责搜集资料的子智能体也能联网；其余子智能体由主智能体把查到的资料转交。 */
const RESEARCH_AGENT_PATTERN = /(explore|explorer|researcher)$/i;

export function toolsForAgent(
  agent: AgentDefinition,
  tools: AgentToolDefinition[],
  availability: ToolAvailability = NO_OPTIONAL_TOOLS,
): AgentToolDefinition[] {
  // 白名单为空表示"不限制"，用全部工具兜底（自定义智能体的默认行为）。
  const allowed = new Set(agent.toolNames.length ? agent.toolNames : tools.map((tool) => tool.name));
  for (const name of CONDITIONAL_TOOL_NAMES) allowed.delete(name);
  const isPrimary = agent.kind === "primary";
  allowed.add("ask_user");
  // 能列章节就能列卷：写新章节要指定卷，没有 list_volumes 只能靠猜。
  if (allowed.has("list_chapters")) allowed.add("list_volumes");
  const writesChapters = [...CHAPTER_WRITE_TOOL_NAMES].some((name) => allowed.has(name));
  if (writesChapters) for (const name of CHAPTER_MANAGEMENT_TOOL_NAMES) allowed.add(name);
  if (isPrimary || writesChapters) for (const name of STYLE_TOOL_NAMES) allowed.add(name);

  // 角色关系跟随角色能力：能读角色就能查关系，能写角色才能改关系。
  if (allowed.has("list_characters")) allowed.add("query_character_relationships");
  else allowed.delete("query_character_relationships");
  const writesCharacters = allowed.has("create_character") || allowed.has("edit_character");
  for (const name of RELATIONSHIP_WRITE_TOOL_NAMES) {
    if (writesCharacters) allowed.add(name);
    else allowed.delete(name);
  }
  // 笔记分类跟随笔记能力。
  if (allowed.has("list_notes")) allowed.add("list_note_categories");
  else allowed.delete("list_note_categories");
  for (const name of NOTE_CATEGORY_WRITE_TOOL_NAMES) {
    if (allowed.has("write_note")) allowed.add(name);
    else allowed.delete(name);
  }

  // 任务计划属于整个对话，只由主智能体维护。
  if (isPrimary) allowed.add("write_plan");
  const researches = isPrimary || RESEARCH_AGENT_PATTERN.test(agent.id);
  if (researches && availability.webSearch) allowed.add("web_search");
  if (researches && availability.webFetch) allowed.add("web_fetch");
  if (availability.attachments) for (const name of FILE_TOOL_NAMES) allowed.add(name);
  if (isPrimary && availability.skillManagement) for (const name of SKILL_MANAGEMENT_TOOL_NAMES) allowed.add(name);

  if (!isPrimary) allowed.delete("delegate_agent");
  return tools.filter((tool) => allowed.has(tool.name));
}
