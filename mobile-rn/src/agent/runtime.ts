import { callModel } from "@/llm/client";
import type { AgentMessage, AgentToolCall, AgentToolDefinition } from "@/llm/types";
import { createId } from "@/lib/id";
import {
  getAgentDefinitions,
  getAgentRules,
  getAgentSkills,
  getToolPermissions,
  TOOL_CATALOG,
  type AgentDefinition,
  type AgentRule,
  type AgentSkill,
  type ToolPermissionMode,
} from "@/settings/config";
import { getProviderApiKey, getSetting, listModels, listProviders, setSetting } from "@/data/repositories";
import {
  getActiveStyleProfile,
  getActiveStyleSelection,
  listStyleProfiles,
  setActiveStyleProfile,
} from "@/data/style-repositories";
import {
  evolveAuthorStyle,
  shouldInjectAuthorStyleGuide,
} from "@/settings/lorn-style-plugin";
import type {
  AgentClarificationQuestion,
  AgentClarificationRequest,
  AgentClarificationResponse,
  AgentRunTrace,
  AgentTraceEvent,
  ChatMessage,
  ModelSelection,
  Project,
  StyleProfile,
} from "@/types";

import { agentTools, executeAgentTool } from "./tools";

const MAX_AGENT_ITERATIONS = 12;
const MAX_DELEGATION_DEPTH = 1;
const MAX_TRACE_STRING_LENGTH = 700;
const CHARACTER_CONSISTENCY_TOOL_NAMES = new Set([
  "list_characters",
  "read_character",
  "create_character",
  "edit_character",
]);
const WORLD_CONSISTENCY_TOOL_NAMES = new Set([
  "list_world_entries",
  "read_world_entry",
  "create_world_entry",
  "edit_world_entry",
]);

type ToolApproval = (name: string, args: Record<string, unknown>) => Promise<boolean>;
type AskUser = (request: AgentClarificationRequest) => Promise<AgentClarificationResponse>;
type TraceListener = (trace: AgentRunTrace) => void;

type RuntimeCatalog = {
  agents: AgentDefinition[];
  rules: AgentRule[];
  skills: AgentSkill[];
  permissions: Record<string, ToolPermissionMode>;
  historyLimit: number;
  compressSystemPrompts: boolean;
  styleSelectionConfigured: boolean;
  activeStyleProfile: StyleProfile | null;
  availableStyleProfiles: StyleProfile[];
};

type LoopResult = {
  content: string;
  consistencyRequired: boolean;
  characterConsistencyChecked: boolean;
  worldConsistencyChecked: boolean;
  consistencyEventId: string | null;
  delegationSucceeded: boolean;
};

type TraceEventDraft = Omit<AgentTraceEvent, "id" | "startedAt" | "completedAt">;

type LoopInput = {
  project: Project;
  selection: ModelSelection;
  history: AgentMessage[];
  catalog: RuntimeCatalog;
  agent: AgentDefinition;
  consistencyReason: string | null;
  consistencyEventId: string | null;
  approveTool?: ToolApproval;
  askUser?: AskUser;
  recorder: TraceRecorder;
  collaborationRequired: boolean;
  requiredSkill: AgentSkill | null;
  userRequest: string;
  depth: number;
};

export interface AgentRunResult {
  content: string;
  trace: AgentRunTrace;
}

export class AgentRunError extends Error {
  readonly trace: AgentRunTrace;

  constructor(message: string, trace: AgentRunTrace) {
    super(message);
    this.name = "AgentRunError";
    this.trace = trace;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneTrace(trace: AgentRunTrace): AgentRunTrace {
  return { ...trace, events: trace.events.map((event) => ({ ...event })) };
}

function createTraceRecorder(
  agent: AgentDefinition,
  collaborationRequired: boolean,
  onTrace?: TraceListener,
) {
  let trace: AgentRunTrace = {
    version: 1,
    id: createId(),
    status: "running",
    primaryAgentId: agent.id,
    primaryAgentName: agent.name,
    collaborationRequired,
    startedAt: new Date().toISOString(),
    events: [],
  };

  const publish = () => onTrace?.(cloneTrace(trace));
  publish();

  return {
    add(event: TraceEventDraft): string {
      const id = createId();
      trace = {
        ...trace,
        events: [...trace.events, { ...event, id, startedAt: new Date().toISOString() }],
      };
      publish();
      return id;
    },
    update(id: string, patch: Partial<Omit<AgentTraceEvent, "id" | "startedAt">>): void {
      const completedAt = patch.status === "completed" || patch.status === "error"
        ? patch.completedAt ?? new Date().toISOString()
        : patch.completedAt;
      trace = {
        ...trace,
        events: trace.events.map((event) => event.id === id
          ? { ...event, ...patch, completedAt }
          : event),
      };
      publish();
    },
    complete(): void {
      trace = { ...trace, status: "completed", completedAt: new Date().toISOString() };
      publish();
    },
    fail(message: string): void {
      const completedAt = new Date().toISOString();
      trace = {
        ...trace,
        status: "error",
        completedAt,
        events: trace.events.map((event) => event.status === "running" || event.status === "waiting"
          ? {
            ...event,
            status: "error",
            detail: event.detail ? `${event.detail}\n${message}` : message,
            completedAt,
          }
          : event),
      };
      publish();
    },
    snapshot(): AgentRunTrace {
      return cloneTrace(trace);
    },
  };
}

type TraceRecorder = ReturnType<typeof createTraceRecorder>;

function truncate(value: string, maximum = MAX_TRACE_STRING_LENGTH): string {
  const normalized = value.trim();
  return normalized.length > maximum ? `${normalized.slice(0, maximum)}…` : normalized;
}

function compactTraceValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return truncate(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (value === undefined) return undefined;
  if (depth >= 3) return Array.isArray(value) ? `[${value.length} 项]` : "[对象]";
  if (Array.isArray(value)) {
    const items = value.slice(0, 8).map((item) => compactTraceValue(item, depth + 1));
    if (value.length > items.length) items.push(`…另有 ${value.length - items.length} 项`);
    return items;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).slice(0, 12);
    const output = Object.fromEntries(entries.map(([key, item]) => [key, compactTraceValue(item, depth + 1)]));
    if (Object.keys(value).length > entries.length) output["…"] = `另有 ${Object.keys(value).length - entries.length} 项`;
    return output;
  }
  return String(value);
}

function formatTracePayload(value: unknown): string | undefined {
  const compact = compactTraceValue(value);
  if (compact === undefined) return undefined;
  const output = typeof compact === "string" ? compact : JSON.stringify(compact, null, 2);
  return output.trim() || undefined;
}

function toolDisplayName(name: string): string {
  return TOOL_CATALOG.find((tool) => tool.key === name)?.name ?? name;
}

function toolResultDetail(name: string, result: Record<string, unknown>): string {
  const count = (key: string) => Array.isArray(result[key]) ? result[key].length : 0;
  if (name === "list_chapters") return `已读取 ${count("chapters")} 个章节`;
  if (name === "list_characters") return `已读取 ${count("characters")} 个角色`;
  if (name === "list_world_entries") return `已读取 ${count("entries")} 个世界书条目`;
  if (name === "search_chapters" || name === "search_knowledge") return `找到 ${count("results")} 条相关内容`;
  if (name === "read_chapter") return `已读取章节：${isRecord(result.chapter) ? String(result.chapter.title ?? "") : ""}`.trim();
  if (name === "read_character") return `已读取角色：${isRecord(result.character) ? String(result.character.name ?? "") : ""}`.trim();
  if (name === "read_world_entry") return `已读取世界书：${isRecord(result.entry) ? String(result.entry.name ?? "") : ""}`.trim();
  if (name === "read_author_style_guide") return result.exists === true ? "已读取作者文风指南" : "当前作品尚无作者文风指南";
  if (name === "list_style_sources") return `已读取 ${count("sources")} 本参考书`;
  if (name === "list_style_profiles") return `已读取 ${count("profiles")} 个文风版本`;
  if (name === "read_style_source_sample") return `已读取参考书样本：${isRecord(result.source) ? String(result.source.title ?? "") : ""}`.trim();
  if (name === "read_style_profile") return `已读取文风：${isRecord(result.profile) ? String(result.profile.name ?? "") : ""}`.trim();
  if (name === "select_style_profile") return `已切换创作文风：${String(result.active_profile_name ?? "")}`;
  if (name === "save_reference_style_profile") return `已保存参考文风：${String(result.name ?? "")}`;
  if (name === "save_author_style_guide") return "已保存作者文风指南";
  if (name === "evolve_author_style") return `已进化并保存作者文风指南 · ${String(result.source ?? "")}`;
  if (typeof result.title === "string") return `已完成：${result.title}`;
  if (typeof result.name === "string") return `已完成：${result.name}`;
  return result.success === true ? "已完成" : "已返回结果";
}

function latestUserRequest(history: ChatMessage[]): string {
  return [...history].reverse().find((message) => message.role === "user")?.content.trim() ?? "";
}

function requiresKnowledgeSynchronization(content: string): boolean {
  const hasKnowledgeSubject = /(创作思路|世界观|世界书|设定|角色|人物|关系|背景|阵营|势力|地点|规则|能力|剧情|情节)/.test(content);
  const hasDecision = /(我想|我准备|我决定|确定|设定为|改成|改为|调整|新增|加入|删除|取消|更新|同步|补充|以后|接下来|让.+(?:成为|会|要))/.test(content);
  return hasKnowledgeSubject && hasDecision;
}

function requiresAgentCollaboration(content: string): boolean {
  if (/(多智能体|子智能体|agent|协作|分工)/i.test(content)) return true;
  if (/(续写|扩写|改写|重写|润色|创作|写(?:一|这|第|下|后|个).{0,8}章|设计大纲|拆解剧情|审查正文|创作思路)/.test(content)) return true;
  const hasAction = /(帮我|请|需要|设计|规划|分析|审查|检查|完善|调整|生成|构建|梳理|推演)/.test(content);
  const dimensions = [
    /(章节|正文|文风|对话)/,
    /(剧情|情节|大纲|节奏|伏笔)/,
    /(角色|人物|关系|弧光)/,
    /(世界观|世界书|设定|背景|势力)/,
  ].filter((pattern) => pattern.test(content)).length;
  return hasAction && (dimensions >= 2 || (dimensions >= 1 && content.length >= 80));
}

function isWritingRequest(content: string): boolean {
  return /(正文|章节|续写|扩写|改写|重写|润色|仿写|写作|写(?:一|这|第|下|后|个).{0,8}章)/.test(content);
}

function requiredSkillForRequest(
  catalog: RuntimeCatalog,
  agent: AgentDefinition,
  request: string,
): AgentSkill | null {
  const skills = enabledSkillsForAgent(catalog, agent);
  const lornSkillId = /(更新我的文风|保存并进化文风)/.test(request)
    ? "plugin-lorn-style--evolution"
    : /(蒸馏文风|分析小说文风|提取文笔\s*DNA)/i.test(request)
      ? "plugin-lorn-style--distillation"
      : null;
  if (lornSkillId) return skills.find((skill) => skill.id === lornSkillId) ?? null;
  if (!requiresAgentCollaboration(request) && !requiresKnowledgeSynchronization(request)) return null;
  const preferredIds = /(审查|检查|质量|复盘)/.test(request)
    ? ["builtin-skill--story-quality", "builtin-skill--reader-contract"]
    : /(角色|人物|对白|对话|关系)/.test(request)
      ? ["builtin-skill--character-design", "builtin-skill--character-relationship", "builtin-skill--dialogue-design"]
      : /(正文|章节|续写|扩写|改写|润色)/.test(request)
        ? ["builtin-skill--prose-format", "builtin-skill--story-quality", "builtin-skill--deslop-writing"]
        : /(世界观|世界书|设定|背景|阵营|势力|创作思路)/.test(request)
          ? ["builtin-skill--story-state-tracking", "builtin-skill--story-hooks"]
          : ["builtin-skill--story-state-tracking", "builtin-skill--story-quality"];
  return preferredIds.map((id) => skills.find((skill) => skill.id === id)).find(Boolean) ?? skills[0] ?? null;
}

function requiredArgument(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`缺少参数 ${key}`);
  return value.trim();
}

function normalizeQuestions(args: Record<string, unknown>): AgentClarificationQuestion[] {
  if (!Array.isArray(args.questions) || args.questions.length < 1 || args.questions.length > 3) {
    throw new Error("ask_user 每次必须提供 1 至 3 个互不依赖的问题");
  }
  return args.questions.map((item, index) => {
    if (!isRecord(item)) throw new Error(`第 ${index + 1} 个问题格式无效`);
    const title = typeof item.title === "string" ? truncate(item.title, 160) : "";
    if (!title) throw new Error(`第 ${index + 1} 个问题缺少标题`);
    const description = typeof item.description === "string" ? truncate(item.description, 500) : undefined;
    if (!Array.isArray(item.options) || item.options.length > 5) {
      throw new Error(`问题“${title}”最多提供 5 个选项`);
    }
    const seen = new Set<string>();
    const options = item.options.flatMap((option) => {
      if (!isRecord(option) || typeof option.label !== "string") return [];
      const label = truncate(option.label, 80);
      if (!label || seen.has(label)) return [];
      seen.add(label);
      return [{
        label,
        description: typeof option.description === "string" ? truncate(option.description, 240) : undefined,
      }];
    });
    return { title, description, options };
  });
}

function enabledSkillsForAgent(catalog: RuntimeCatalog, agent: AgentDefinition): AgentSkill[] {
  const allowedIds = new Set(agent.skillIds);
  return catalog.skills.filter((skill) => skill.enabled && (!allowedIds.size || allowedIds.has(skill.id)));
}

function enabledDelegates(catalog: RuntimeCatalog, agent: AgentDefinition): AgentDefinition[] {
  const allowedIds = new Set(agent.delegatableAgentIds);
  return catalog.agents.filter((candidate) => candidate.enabled && candidate.kind === "subagent" && allowedIds.has(candidate.id));
}

function toolsForAgent(agent: AgentDefinition): AgentToolDefinition[] {
  const allowed = new Set(agent.toolNames.length ? agent.toolNames : agentTools.map((tool) => tool.name));
  allowed.add("ask_user");
  allowed.add("read_author_style_guide");
  allowed.add("save_author_style_guide");
  allowed.add("evolve_author_style");
  allowed.add("list_style_sources");
  allowed.add("read_style_source_sample");
  allowed.add("list_style_profiles");
  allowed.add("read_style_profile");
  allowed.add("select_style_profile");
  allowed.add("save_reference_style_profile");
  if (agent.kind !== "primary") allowed.delete("delegate_agent");
  return agentTools.filter((tool) => allowed.has(tool.name));
}

function systemPrompt(input: {
  project: Project;
  catalog: RuntimeCatalog;
  agent: AgentDefinition;
  consistencyReason: string | null;
  userRequest: string;
}): string {
  const sections = [`你是 OpenFicM 移动端的 ${input.agent.name} 智能体。当前作品是《${input.project.title}》。
作品简介：${input.project.description || "暂无"}
作品、章节、角色、世界书和聊天记录都保存在本机；只有调用用户配置的模型 API 时联网。
必须依据工具读取到的当前作品数据工作，不得把其他作品的信息混入本作品。
用户明确给出新的创作决定、角色变化、世界规则或剧情事实时，不要只在聊天中复述：先读取现有角色与世界书，确认属于正式设定后，调用 create/edit 工具同步到作品。若内容仍是脑暴、存在多种解释或是否采用尚不明确，先调用 ask_user 让用户确认，再写入；不得把未确认的备选想法当作正式设定。
章节新增或修改后，在最终答复前必须分别检查角色与世界书是否仍与正文一致：至少调用一次角色 list/read 工具，并至少调用一次世界书 list/read 工具；确认出现新事实或设定变化时，调用对应 create/edit 工具同步。没有变化时也要完成两类检查。删除角色或世界书条目只响应用户明确要求。所有写工具仍受用户权限审批。
任务存在会显著影响结果的偏好或歧义时，使用 ask_user 提出一至三个互不依赖的问题；简单问题不要反问。
技能不能只凭名称假设内容；任务匹配技能说明时，先调用 activate_skill 加载完整指令。工具参数必须严格符合声明。`];

  if (input.consistencyReason) {
    sections.push(`检测到需要同步检查的作品变动：${input.consistencyReason}\n本轮结束前必须完成角色和世界书一致性检查；确认的新事实应写入对应资料。`);
  }
  if (input.agent.systemPrompt.trim()) {
    sections.push(`当前智能体定义：\n${input.agent.systemPrompt.trim()}`);
  }
  if (input.catalog.activeStyleProfile && shouldInjectAuthorStyleGuide(input.agent, input.userRequest)) {
    const profile = input.catalog.activeStyleProfile;
    const profileType = profile.kind === "author" ? "作者文风" : "参考小说文风";
    sections.push(`当前创作使用的${profileType}是“${profile.name} V${profile.version}”：\n${truncate(profile.guide, 16_000)}\n\n生成或修改正文时必须把这份指南作为额外文风约束；它不能覆盖用户本轮明确要求、事实一致性或安全边界。不得复制参考小说原句或专有表达。`);
  }
  const enabledRules = input.catalog.rules.filter((rule) => rule.enabled && rule.content.trim());
  if (enabledRules.length) {
    sections.push(`必须遵循的规则：\n${enabledRules.map((rule) => `- ${rule.name}：${rule.content.trim()}`).join("\n")}`);
  }
  const skills = enabledSkillsForAgent(input.catalog, input.agent);
  if (skills.length) {
    sections.push(`可按需激活的技能：\n${skills.map((skill) => `- ${skill.name}（${skill.id}）：${skill.description}`).join("\n")}`);
  }
  const delegates = enabledDelegates(input.catalog, input.agent);
  if (delegates.length) {
    sections.push(`可委派的子智能体：\n${delegates.map((agent) => `- ${agent.name}（${agent.id}）：${agent.description}`).join("\n")}\n复杂创作任务必须按专业分工调用 delegate_agent；委派任务包含目标、作品上下文、交付物和限制。主智能体负责整合结果，不能把子智能体原文不加判断地直接转交用户。`);
  }
  return sections.join("\n\n");
}

function activePrimaryAgent(agents: AgentDefinition[], activeAgentId: string | null): AgentDefinition {
  const selected = agents.find((agent) => agent.id === activeAgentId && agent.enabled && agent.kind === "primary")
    ?? agents.find((agent) => agent.id === "builtin-agent--build" && agent.enabled)
    ?? agents.find((agent) => agent.enabled && agent.kind === "primary");
  if (!selected) throw new Error("没有可用的主智能体，请在设置中启用一个主智能体");
  return selected;
}

function latestStyleProfiles(profiles: StyleProfile[]): StyleProfile[] {
  const series = new Set<string>();
  return profiles.filter((profile) => {
    if (series.has(profile.seriesId)) return false;
    series.add(profile.seriesId);
    return true;
  });
}

async function ensureWritingStyleSelection(input: {
  projectId: string;
  request: string;
  catalog: RuntimeCatalog;
  askUser?: AskUser;
  recorder: TraceRecorder;
  agentName: string;
}): Promise<void> {
  if (!isWritingRequest(input.request)
    || input.catalog.styleSelectionConfigured
    || !input.catalog.availableStyleProfiles.length
    || !input.askUser) return;
  const profiles = latestStyleProfiles(input.catalog.availableStyleProfiles).slice(0, 4);
  const profileByLabel = new Map(profiles.map((profile) => [
    `${profile.name} V${profile.version}`,
    profile,
  ]));
  const eventId = input.recorder.add({
    kind: "question",
    status: "waiting",
    title: "选择本次创作文风",
    agentName: input.agentName,
    detail: "正文生成前确认要注入的文风版本",
  });
  const response = await input.askUser({
    id: eventId,
    agentName: input.agentName,
    questions: [{
      title: "这次正文使用哪种文风？",
      description: "选择后会绑定到本次 AI 原稿，作者修改后可据此进化个人文风。",
      options: [
        ...profiles.map((profile, index) => ({
          label: `${profile.name} V${profile.version}${index === 0 ? "（推荐）" : ""}`,
          description: profile.kind === "author" ? "使用当前作品积累的作者文风" : "使用导入参考小说蒸馏出的约束",
        })),
        { label: "不使用文风", description: "只遵循本轮要求和作品设定" },
      ],
    }],
  });
  if (response.cancelled) {
    input.recorder.update(eventId, { status: "completed", detail: "本次跳过文风选择" });
    return;
  }
  const answer = response.answers[0]?.answer.trim() ?? "";
  let selected: StyleProfile | null = null;
  if (!/不使用|不用|none/i.test(answer)) {
    const normalizedAnswer = answer.replace(/（推荐）$/, "");
    selected = profileByLabel.get(normalizedAnswer)
      ?? profiles.find((profile) => profile.id === answer || profile.name === answer)
      ?? null;
    if (!selected) {
      input.recorder.update(eventId, { status: "error", detail: "未找到选择的文风版本" });
      throw new Error("未找到选择的文风版本，请从文风书库重新选择");
    }
  }
  await setActiveStyleProfile(input.projectId, selected?.id ?? null);
  input.catalog.styleSelectionConfigured = true;
  input.catalog.activeStyleProfile = selected;
  input.recorder.update(eventId, {
    status: "completed",
    detail: selected ? `已选择 ${selected.name} V${selected.version}` : "本次不使用文风",
  });
}

async function authorizeToolCall(
  call: AgentToolCall,
  permissions: Record<string, ToolPermissionMode>,
  approveTool?: ToolApproval,
): Promise<void> {
  const permission = permissions[call.name] ?? "ask";
  if (permission === "deny") throw new Error("该工具已在设置中禁用");
  if (permission === "ask") {
    const approved = approveTool ? await approveTool(call.name, call.arguments) : false;
    if (!approved) throw new Error("用户未批准本次工具调用");
  }
}

async function selectionForAgent(agent: AgentDefinition, fallback: ModelSelection): Promise<ModelSelection> {
  if (!agent.modelId || agent.modelId === fallback.model.id) return fallback;
  const [models, providers] = await Promise.all([listModels(), listProviders()]);
  const model = models.find((item) => item.id === agent.modelId);
  if (!model) return fallback;
  const provider = providers.find((item) => item.id === model.providerId);
  if (!provider) return fallback;
  const apiKey = await getProviderApiKey(provider);
  if (!apiKey) return fallback;
  return { model, provider, apiKey };
}

function fallbackDelegate(delegates: AgentDefinition[], request: string): AgentDefinition {
  const preferredKey = /(审查|检查|复盘|质量)/.test(request)
    ? "reviewer"
    : /(角色|人物|对白|对话|关系)/.test(request)
      ? "actor"
      : /(续写|扩写|改写|重写|正文|章节)/.test(request)
        ? "writer"
        : /(大纲|规划|设定|世界观|剧情|情节|创作思路)/.test(request)
          ? "composer"
          : "explore";
  return delegates.find((agent) => agent.id.includes(preferredKey) || agent.name.toLowerCase().includes(preferredKey))
    ?? delegates[0];
}

function mergeChildResult(
  current: Pick<LoopResult, "consistencyRequired" | "characterConsistencyChecked" | "worldConsistencyChecked" | "consistencyEventId">,
  child: LoopResult,
): Pick<LoopResult, "consistencyRequired" | "characterConsistencyChecked" | "worldConsistencyChecked" | "consistencyEventId"> {
  return {
    consistencyRequired: current.consistencyRequired || child.consistencyRequired,
    characterConsistencyChecked: current.characterConsistencyChecked || child.characterConsistencyChecked,
    worldConsistencyChecked: current.worldConsistencyChecked || child.worldConsistencyChecked,
    consistencyEventId: child.consistencyEventId ?? current.consistencyEventId,
  };
}

async function runAgentLoop(input: LoopInput): Promise<LoopResult> {
  const prompt = systemPrompt({
    project: input.project,
    catalog: input.catalog,
    agent: input.agent,
    consistencyReason: input.consistencyReason,
    userRequest: input.userRequest,
  });
  const messages: AgentMessage[] = [
    {
      role: "system",
      content: input.catalog.compressSystemPrompts
        ? prompt.split("\n").map((line) => line.trim()).filter(Boolean).join("\n")
        : prompt,
    },
    ...input.history.slice(-input.catalog.historyLimit),
  ];
  const tools = toolsForAgent(input.agent);
  const allowedToolNames = new Set(tools.map((tool) => tool.name));
  let consistencyRequired = Boolean(input.consistencyReason);
  let characterConsistencyChecked = false;
  let worldConsistencyChecked = false;
  let consistencyEventId = input.consistencyEventId;
  let consistencyReminderCount = 0;
  let collaborationReminderSent = false;
  let fallbackDelegationAttempted = false;
  let delegationSucceeded = false;
  let collaborationUnavailable = false;

  if (input.requiredSkill) {
    const skillEventId = input.recorder.add({
      kind: "skill",
      status: "running",
      title: "正在激活技能：" + input.requiredSkill.name,
      agentName: input.agent.name,
      toolName: "activate_skill",
      detail: "根据当前任务自动加载专业指令",
      input: input.requiredSkill.description,
    });
    messages.push({
      role: "system",
      content: "已激活技能“" + input.requiredSkill.name + "”，必须遵循以下完整指令：\n" + input.requiredSkill.instructions,
    });
    input.recorder.update(skillEventId, {
      status: "completed",
      title: "已激活技能：" + input.requiredSkill.name,
      detail: input.requiredSkill.description,
    });
  }

  if (consistencyRequired && !consistencyEventId) {
    consistencyEventId = input.recorder.add({
      kind: "consistency",
      status: "running",
      title: "核对角色与世界书",
      agentName: input.agent.name,
      detail: input.consistencyReason ?? "正在检查作品设定变化",
    });
  }

  for (let iteration = 0; iteration < MAX_AGENT_ITERATIONS; iteration += 1) {
    const turn = await callModel(input.selection, messages, tools);
    messages.push({ role: "assistant", content: turn.content, toolCalls: turn.toolCalls });

    if (turn.toolCalls.length === 0) {
      const consistencyChecked = characterConsistencyChecked && worldConsistencyChecked;
      const initialReminders: string[] = [];
      if (consistencyRequired && !consistencyChecked && consistencyReminderCount === 0) {
        consistencyReminderCount += 1;
        const missingChecks = [
          !characterConsistencyChecked ? "角色" : "",
          !worldConsistencyChecked ? "世界书" : "",
        ].filter(Boolean).join("、");
        initialReminders.push(`尚未完成${missingChecks}一致性检查。现在调用对应 list/read 工具核对；发现已确认的新事实时使用 create/edit 工具同步。`);
      }
      if (input.collaborationRequired && !delegationSucceeded && !collaborationUnavailable && !collaborationReminderSent) {
        collaborationReminderSent = true;
        initialReminders.push("这是复杂创作任务，必须先调用 delegate_agent 让一个匹配的专业子智能体参与，再整合其结果。");
      }
      if (initialReminders.length) {
        messages.push({ role: "system", content: initialReminders.join("\n") });
        continue;
      }

      if (input.collaborationRequired && !delegationSucceeded && !collaborationUnavailable && !fallbackDelegationAttempted) {
        fallbackDelegationAttempted = true;
        const delegates = enabledDelegates(input.catalog, input.agent);
        const childAgent = fallbackDelegate(delegates, input.userRequest);
        const task = `请作为专业子智能体参与以下创作任务。先用工具读取当前作品的必要资料，再给出可供主智能体整合的具体成果。若用户已确认新的角色或世界设定，请同步更新；若仍有关键歧义，使用 ask_user。\n\n用户任务：${truncate(input.userRequest, 12_000)}\n\n主智能体当前草案：${truncate(turn.content || "尚无", 12_000)}`;
        const call: AgentToolCall = {
          id: createId(),
          name: "delegate_agent",
          arguments: { agent_id: childAgent.id, task },
        };
        const eventId = input.recorder.add({
          kind: "agent",
          status: input.catalog.permissions.delegate_agent === "ask" ? "waiting" : "running",
          title: `${childAgent.name} 正在协作`,
          agentName: input.agent.name,
          toolName: "delegate_agent",
          detail: "主智能体未主动委派，运行时已自动补充专业协作",
          input: formatTracePayload({ task }),
        });
        try {
          await authorizeToolCall(call, input.catalog.permissions, input.approveTool);
          input.recorder.update(eventId, { status: "running", detail: "正在读取作品并处理任务" });
          const childSelection = await selectionForAgent(childAgent, input.selection);
          const childResult = await runAgentLoop({
            ...input,
            selection: childSelection,
            history: [{ role: "user", content: task }],
            agent: childAgent,
            consistencyEventId,
            collaborationRequired: false,
            requiredSkill: requiredSkillForRequest(input.catalog, childAgent, task),
            userRequest: task,
            depth: input.depth + 1,
          });
          ({
            consistencyRequired,
            characterConsistencyChecked,
            worldConsistencyChecked,
            consistencyEventId,
          } = mergeChildResult({
            consistencyRequired,
            characterConsistencyChecked,
            worldConsistencyChecked,
            consistencyEventId,
          }, childResult));
          delegationSucceeded = true;
          input.recorder.update(eventId, {
            status: "completed",
            detail: `${childAgent.name} 已返回结果`,
            output: truncate(childResult.content, 1_600),
          });
          messages.push({
            role: "system",
            content: `自动专业协作结果（${childAgent.name}）：\n${childResult.content}\n\n请结合用户需求和已读取的作品资料审慎整合，不要原样转交。`,
          });
          continue;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          input.recorder.update(eventId, { status: "error", detail: message });
          collaborationUnavailable = true;
          messages.push({
            role: "system",
            content: `子智能体协作未成功（${message}）。请继续由主智能体完成任务，并在最终答复中说明协作受限。`,
          });
          continue;
        }
      }

      if (consistencyRequired && !consistencyChecked) {
        if (consistencyReminderCount < 2) {
          consistencyReminderCount += 1;
          messages.push({
            role: "system",
            content: "角色或世界书一致性检查仍未完成。必须立即调用缺少的 list/read 工具，不能直接结束。",
          });
          continue;
        }
        if (consistencyEventId) {
          input.recorder.update(consistencyEventId, {
            status: "error",
            detail: "本轮未能完成全部一致性检查，主智能体已返回当前结果；下轮任务会继续检查",
          });
        }
        return {
          content: `${turn.content || "模型没有返回内容"}\n\n提示：本轮角色或世界书一致性检查未全部完成，下一轮任务会继续补查。`,
          consistencyRequired,
          characterConsistencyChecked,
          worldConsistencyChecked,
          consistencyEventId,
          delegationSucceeded,
        };
      }
      if (input.collaborationRequired && !delegationSucceeded && !collaborationUnavailable) {
        throw new Error("复杂任务未完成专业子智能体协作");
      }
      if (consistencyRequired && consistencyEventId) {
        input.recorder.update(consistencyEventId, {
          status: "completed",
          detail: "已核对角色与世界书，并同步确认的变化",
        });
      }
      return {
        content: turn.content || "模型没有返回内容",
        consistencyRequired,
        characterConsistencyChecked,
        worldConsistencyChecked,
        consistencyEventId,
        delegationSucceeded,
      };
    }

    for (const call of turn.toolCalls) {
      const kind = call.name === "activate_skill"
        ? "skill"
        : call.name === "delegate_agent"
          ? "agent"
          : call.name === "ask_user"
            ? "question"
            : "tool";
      const permission = input.catalog.permissions[call.name] ?? "ask";
      const eventId = input.recorder.add({
        kind,
        status: permission === "ask" ? "waiting" : "running",
        title: toolDisplayName(call.name),
        agentName: input.agent.name,
        toolName: call.name,
        detail: permission === "ask" ? "等待工具权限" : "正在执行",
        input: formatTracePayload(call.arguments),
      });
      try {
        if (!allowedToolNames.has(call.name)) throw new Error(`${input.agent.name} 无权使用工具 ${call.name}`);
        await authorizeToolCall(call, input.catalog.permissions, input.approveTool);
        input.recorder.update(eventId, { status: "running", detail: "正在执行" });
        let result: Record<string, unknown>;
        let eventTitle = toolDisplayName(call.name);
        let eventDetail: string;

        if (call.name === "ask_user") {
          const questions = normalizeQuestions(call.arguments);
          if (!input.askUser) throw new Error("当前界面无法接收结构化回答");
          input.recorder.update(eventId, {
            status: "waiting",
            title: `${input.agent.name} 需要确认`,
            detail: `等待回答 ${questions.length} 个问题`,
          });
          const response = await input.askUser({ id: eventId, agentName: input.agent.name, questions });
          result = { cancelled: response.cancelled, answers: response.answers };
          eventTitle = `${input.agent.name} 的提问`;
          eventDetail = response.cancelled ? "用户跳过了本次问题" : `已回答 ${response.answers.length} 个问题`;
        } else if (call.name === "activate_skill") {
          const requested = requiredArgument(call.arguments, "skill_name");
          const skill = enabledSkillsForAgent(input.catalog, input.agent)
            .find((item) => item.id === requested || item.name === requested);
          if (!skill) throw new Error(`技能不在 ${input.agent.name} 的可用列表中: ${requested}`);
          result = { skill_id: skill.id, skill_name: skill.name, instructions: skill.instructions };
          eventTitle = `已激活技能：${skill.name}`;
          eventDetail = skill.description;
        } else if (call.name === "delegate_agent") {
          if (input.depth >= MAX_DELEGATION_DEPTH || input.agent.kind !== "primary") {
            throw new Error("只有主智能体可以委派一层子智能体");
          }
          const agentId = requiredArgument(call.arguments, "agent_id");
          const childAgent = enabledDelegates(input.catalog, input.agent).find((agent) => agent.id === agentId);
          if (!childAgent) throw new Error(`子智能体不在委派白名单中: ${agentId}`);
          const task = requiredArgument(call.arguments, "task");
          eventTitle = `${childAgent.name} 正在协作`;
          input.recorder.update(eventId, { title: eventTitle, detail: "正在读取作品并处理任务" });
          const childSelection = await selectionForAgent(childAgent, input.selection);
          const childResult = await runAgentLoop({
            ...input,
            selection: childSelection,
            history: [{ role: "user", content: task }],
            agent: childAgent,
            consistencyEventId,
            collaborationRequired: false,
            requiredSkill: requiredSkillForRequest(input.catalog, childAgent, task),
            userRequest: task,
            depth: input.depth + 1,
          });
          ({
            consistencyRequired,
            characterConsistencyChecked,
            worldConsistencyChecked,
            consistencyEventId,
          } = mergeChildResult({
            consistencyRequired,
            characterConsistencyChecked,
            worldConsistencyChecked,
            consistencyEventId,
          }, childResult));
          delegationSucceeded = true;
          result = { agent_id: childAgent.id, agent_name: childAgent.name, result: childResult.content };
          eventDetail = `${childAgent.name} 已返回结果`;
        } else if (call.name === "evolve_author_style") {
          const evolved = await evolveAuthorStyle({
            projectId: input.project.id,
            aiDraft: requiredArgument(call.arguments, "ai_draft"),
            authorRevision: requiredArgument(call.arguments, "author_revision"),
            selection: input.selection,
          });
          input.catalog.styleSelectionConfigured = true;
          input.catalog.activeStyleProfile = evolved.profile;
          input.catalog.availableStyleProfiles = [
            evolved.profile,
            ...input.catalog.availableStyleProfiles.filter((profile) => profile.id !== evolved.profile.id),
          ];
          result = {
            success: true,
            source: evolved.source,
            profile_id: evolved.profile.id,
            version: evolved.profile.version,
            guide_characters: evolved.guide.length,
          };
          eventDetail = toolResultDetail(call.name, result);
        } else {
          result = await executeAgentTool(input.project.id, call.name, call.arguments);
          eventDetail = toolResultDetail(call.name, result);
          if (call.name === "save_author_style_guide" || call.name === "select_style_profile") {
            input.catalog.styleSelectionConfigured = true;
            input.catalog.activeStyleProfile = await getActiveStyleProfile(input.project.id);
          }
          if (call.name === "save_reference_style_profile") {
            input.catalog.availableStyleProfiles = await listStyleProfiles(input.project.id);
          }
          if (call.name === "write_chapter" || call.name === "edit_chapter") {
            consistencyRequired = true;
            characterConsistencyChecked = false;
            worldConsistencyChecked = false;
            consistencyReminderCount = 0;
            if (!consistencyEventId) {
              consistencyEventId = input.recorder.add({
                kind: "consistency",
                status: "running",
                title: "核对角色与世界书",
                agentName: input.agent.name,
                detail: "章节内容已变化，正在检查关联设定",
              });
            } else {
              input.recorder.update(consistencyEventId, {
                status: "running",
                completedAt: undefined,
                detail: "章节内容已变化，正在重新检查关联设定",
              });
            }
          } else if (consistencyRequired) {
            if (CHARACTER_CONSISTENCY_TOOL_NAMES.has(call.name)) characterConsistencyChecked = true;
            if (WORLD_CONSISTENCY_TOOL_NAMES.has(call.name)) worldConsistencyChecked = true;
            if (characterConsistencyChecked && worldConsistencyChecked && consistencyEventId) {
              input.recorder.update(consistencyEventId, {
                status: "completed",
                detail: "角色与世界书均已完成核对",
              });
            }
          }
        }
        input.recorder.update(eventId, {
          status: "completed",
          title: eventTitle,
          detail: eventDetail,
          output: call.name === "activate_skill"
            ? undefined
            : formatTracePayload(result),
        });
        messages.push({ role: "tool", content: JSON.stringify(result), toolCallId: call.id, toolName: call.name });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        input.recorder.update(eventId, { status: "error", detail: message });
        if (call.name === "delegate_agent") collaborationUnavailable = true;
        messages.push({
          role: "tool",
          content: JSON.stringify({ error: message }),
          toolCallId: call.id,
          toolName: call.name,
        });
      }
    }
  }
  throw new Error(`${input.agent.name} 工具调用次数过多，已停止本次任务`);
}

export async function runAgent(input: {
  project: Project;
  selection: ModelSelection;
  history: ChatMessage[];
  agentId?: string | null;
  approveTool?: ToolApproval;
  askUser?: AskUser;
  onTrace?: TraceListener;
}): Promise<AgentRunResult> {
  const consistencyKey = `agent.pendingConsistency.${input.project.id}`;
  const [rules, skills, agents, permissions, activeAgentId, historyLimitValue, compressValue, pendingConsistency, styleSelection, availableStyleProfiles] = await Promise.all([
    getAgentRules(),
    getAgentSkills(),
    getAgentDefinitions(),
    getToolPermissions(),
    getSetting("agent.activeDefinitionId"),
    getSetting("context.historyLimit"),
    getSetting("context.compressSystemPrompts"),
    getSetting(consistencyKey),
    getActiveStyleSelection(input.project.id),
    listStyleProfiles(input.project.id),
  ]);
  const parsedHistoryLimit = Number(historyLimitValue);
  const catalog: RuntimeCatalog = {
    rules,
    skills,
    agents,
    permissions,
    historyLimit: Number.isInteger(parsedHistoryLimit) && parsedHistoryLimit >= 4 && parsedHistoryLimit <= 100
      ? parsedHistoryLimit
      : 30,
    compressSystemPrompts: compressValue === "true",
    styleSelectionConfigured: styleSelection.configured,
    activeStyleProfile: styleSelection.profile,
    availableStyleProfiles,
  };
  const agent = activePrimaryAgent(agents, input.agentId ?? activeAgentId);
  const userRequest = latestUserRequest(input.history);
  const delegates = enabledDelegates(catalog, agent);
  const collaborationRequired = requiresAgentCollaboration(userRequest)
    && delegates.length > 0
    && toolsForAgent(agent).some((tool) => tool.name === "delegate_agent")
    && permissions.delegate_agent !== "deny";
  const consistencyReason = pendingConsistency
    || (requiresKnowledgeSynchronization(userRequest)
      ? "用户本轮提供了可能影响角色或世界书的创作决定"
      : null);
  const requiredSkill = requiredSkillForRequest(catalog, agent, userRequest);
  const recorder = createTraceRecorder(agent, collaborationRequired, input.onTrace);

  try {
    await ensureWritingStyleSelection({
      projectId: input.project.id,
      request: userRequest,
      catalog,
      askUser: input.askUser,
      recorder,
      agentName: agent.name,
    });
    const result = await runAgentLoop({
      project: input.project,
      selection: input.selection,
      history: input.history.map((message) => ({ role: message.role, content: message.content })),
      catalog,
      agent,
      consistencyReason,
      consistencyEventId: null,
      approveTool: input.approveTool,
      askUser: input.askUser,
      recorder,
      collaborationRequired,
      requiredSkill,
      userRequest,
      depth: 0,
    });
    if (result.consistencyRequired && result.characterConsistencyChecked && result.worldConsistencyChecked) {
      await setSetting(consistencyKey, "");
    }
    recorder.complete();
    return { content: result.content, trace: recorder.snapshot() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recorder.fail(message);
    throw new AgentRunError(message, recorder.snapshot());
  }
}
