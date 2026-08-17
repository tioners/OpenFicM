import { getSetting, setSetting } from "@/data/repositories";

import builtinCatalog from "./builtin-catalog.json";
import { getInstalledOhStoryPackage } from "./oh-story-updater";

export type ToolPermissionMode = "allow" | "ask" | "deny";
export type AgentKind = "primary" | "subagent";
export type CatalogSource = "builtin" | "custom" | "remote";

export interface IndexSettings {
  enabled: boolean;
  chunkSize: number;
  chunkOverlap: number;
  retrievalTopK: number;
  rerankTopK: number;
  rerankEnabled: boolean;
}

export interface AgentRule {
  id: string;
  name: string;
  content: string;
  enabled: boolean;
}

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
  source: CatalogSource;
}

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  modelId: string;
  enabled: boolean;
  kind: AgentKind;
  skillIds: string[];
  toolNames: string[];
  delegatableAgentIds: string[];
  source: CatalogSource;
}

export const DEFAULT_INDEX_SETTINGS: IndexSettings = {
  enabled: true,
  chunkSize: 360,
  chunkOverlap: 60,
  retrievalTopK: 8,
  rerankTopK: 5,
  rerankEnabled: true,
};

export const TOOL_CATALOG = [
  { key: "list_chapters", name: "列出章节", readonly: true },
  { key: "read_chapter", name: "读取章节", readonly: true },
  { key: "search_chapters", name: "全文搜索章节", readonly: true },
  { key: "search_knowledge", name: "语义检索项目资料", readonly: true },
  { key: "list_characters", name: "列出角色", readonly: true },
  { key: "read_character", name: "读取角色", readonly: true },
  { key: "list_world_entries", name: "列出世界书条目", readonly: true },
  { key: "read_world_entry", name: "读取世界书条目", readonly: true },
  { key: "ask_user", name: "向用户提问", readonly: true },
  { key: "activate_skill", name: "激活技能", readonly: true },
  { key: "delegate_agent", name: "委派子智能体", readonly: true },
  { key: "write_chapter", name: "创建章节", readonly: false },
  { key: "edit_chapter", name: "修改章节", readonly: false },
  { key: "create_character", name: "创建角色", readonly: false },
  { key: "edit_character", name: "修改角色", readonly: false },
  { key: "delete_character", name: "删除角色", readonly: false },
  { key: "create_world_entry", name: "创建世界书条目", readonly: false },
  { key: "edit_world_entry", name: "修改世界书条目", readonly: false },
  { key: "delete_world_entry", name: "删除世界书条目", readonly: false },
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readJson(key: string): Promise<unknown> {
  const value = await getSetting(key);
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  await setSetting(key, JSON.stringify(value));
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

export async function getIndexSettings(): Promise<IndexSettings> {
  const value = await readJson("index.settings");
  if (!isRecord(value)) return DEFAULT_INDEX_SETTINGS;
  const chunkSize = boundedInteger(value.chunkSize, DEFAULT_INDEX_SETTINGS.chunkSize, 120, 440);
  const chunkOverlap = boundedInteger(value.chunkOverlap, DEFAULT_INDEX_SETTINGS.chunkOverlap, 0, chunkSize - 1);
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : DEFAULT_INDEX_SETTINGS.enabled,
    chunkSize,
    chunkOverlap,
    retrievalTopK: boundedInteger(value.retrievalTopK, DEFAULT_INDEX_SETTINGS.retrievalTopK, 1, 20),
    rerankTopK: boundedInteger(value.rerankTopK, DEFAULT_INDEX_SETTINGS.rerankTopK, 1, 12),
    rerankEnabled: typeof value.rerankEnabled === "boolean"
      ? value.rerankEnabled
      : DEFAULT_INDEX_SETTINGS.rerankEnabled,
  };
}

export async function saveIndexSettings(settings: IndexSettings): Promise<void> {
  if (settings.chunkOverlap >= settings.chunkSize) throw new Error("分块重叠必须小于分块大小");
  await writeJson("index.settings", {
    enabled: Boolean(settings.enabled),
    chunkSize: boundedInteger(settings.chunkSize, DEFAULT_INDEX_SETTINGS.chunkSize, 120, 440),
    chunkOverlap: boundedInteger(settings.chunkOverlap, DEFAULT_INDEX_SETTINGS.chunkOverlap, 0, 439),
    retrievalTopK: boundedInteger(settings.retrievalTopK, DEFAULT_INDEX_SETTINGS.retrievalTopK, 1, 20),
    rerankTopK: boundedInteger(settings.rerankTopK, DEFAULT_INDEX_SETTINGS.rerankTopK, 1, 12),
    rerankEnabled: Boolean(settings.rerankEnabled),
  });
}

export async function getToolPermissions(): Promise<Record<string, ToolPermissionMode>> {
  const value = await readJson("agent.toolPermissions");
  const permissions: Record<string, ToolPermissionMode> = {};
  for (const tool of TOOL_CATALOG) {
    const mode = isRecord(value) ? value[tool.key] : undefined;
    permissions[tool.key] = mode === "allow" || mode === "ask" || mode === "deny"
      ? mode
      : tool.readonly ? "allow" : "ask";
  }
  return permissions;
}

export async function saveToolPermissions(permissions: Record<string, ToolPermissionMode>): Promise<void> {
  const normalized = Object.fromEntries(TOOL_CATALOG.map((tool) => {
    const mode = permissions[tool.key];
    return [tool.key, mode === "allow" || mode === "ask" || mode === "deny" ? mode : "ask"];
  }));
  await writeJson("agent.toolPermissions", normalized);
}

function parseRules(value: unknown): AgentRule[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.name !== "string" || typeof item.content !== "string") return [];
    return [{ id: item.id, name: item.name, content: item.content, enabled: item.enabled !== false }];
  });
}

function parseSkills(value: unknown): AgentSkill[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.name !== "string"
      || typeof item.description !== "string" || typeof item.instructions !== "string") return [];
    return [{
      id: item.id,
      name: item.name,
      description: item.description,
      instructions: item.instructions,
      enabled: item.enabled !== false,
      source: item.source === "builtin" || item.source === "remote" ? item.source : "custom",
    }];
  });
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())))];
}

function parseAgents(value: unknown): AgentDefinition[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.name !== "string"
      || typeof item.description !== "string" || typeof item.systemPrompt !== "string") return [];
    return [{
      id: item.id,
      name: item.name,
      description: item.description,
      systemPrompt: item.systemPrompt,
      modelId: typeof item.modelId === "string" ? item.modelId : "",
      enabled: item.enabled !== false,
      kind: item.kind === "subagent" ? "subagent" : "primary",
      skillIds: parseStringArray(item.skillIds),
      toolNames: parseStringArray(item.toolNames),
      delegatableAgentIds: parseStringArray(item.delegatableAgentIds),
      source: item.source === "builtin" || item.source === "remote" ? item.source : "custom",
    }];
  });
}

export async function getAgentRules(): Promise<AgentRule[]> {
  return parseRules(await readJson("agent.rules"));
}

export async function saveAgentRules(rules: AgentRule[]): Promise<void> {
  await writeJson("agent.rules", rules);
}

const BUILTIN_SKILLS = parseSkills(builtinCatalog.skills).map((skill) => ({ ...skill, source: "builtin" as const }));
const BUILTIN_AGENTS = parseAgents(builtinCatalog.agents).map((agent) => ({ ...agent, source: "builtin" as const }));

export async function getAgentSkills(): Promise<AgentSkill[]> {
  const [value, remotePackage] = await Promise.all([readJson("agent.skills"), getInstalledOhStoryPackage()]);
  const records = Array.isArray(value) ? value.filter(isRecord) : [];
  const overrides = new Map(records.filter((item) => typeof item.id === "string").map((item) => [item.id as string, item]));
  const builtinIds = new Set(BUILTIN_SKILLS.map((skill) => skill.id));
  const builtins = BUILTIN_SKILLS.map((skill) => {
    const override = overrides.get(skill.id);
    return { ...skill, enabled: typeof override?.enabled === "boolean" ? override.enabled : skill.enabled };
  });
  const remoteSkills = (remotePackage?.skills ?? []).map((skill) => {
    const override = overrides.get(skill.id);
    return { ...skill, enabled: typeof override?.enabled === "boolean" ? override.enabled : skill.enabled };
  });
  const managedIds = new Set([...builtinIds, ...remoteSkills.map((skill) => skill.id)]);
  const custom = parseSkills(value)
    .filter((skill) => !managedIds.has(skill.id))
    .map((skill) => ({ ...skill, source: "custom" as const }));
  return [...builtins, ...remoteSkills, ...custom];
}

export async function saveAgentSkills(skills: AgentSkill[]): Promise<void> {
  const remotePackage = await getInstalledOhStoryPackage();
  const managedIds = new Set([...BUILTIN_SKILLS.map((skill) => skill.id), ...(remotePackage?.skills ?? []).map((skill) => skill.id)]);
  await writeJson("agent.skills", skills.map((skill) => managedIds.has(skill.id)
    ? { id: skill.id, enabled: skill.enabled }
    : { ...skill, source: "custom" }));
}

export async function getAgentDefinitions(): Promise<AgentDefinition[]> {
  const [value, remotePackage] = await Promise.all([readJson("agent.definitions"), getInstalledOhStoryPackage()]);
  const records = Array.isArray(value) ? value.filter(isRecord) : [];
  const overrides = new Map(records.filter((item) => typeof item.id === "string").map((item) => [item.id as string, item]));
  const builtinIds = new Set(BUILTIN_AGENTS.map((agent) => agent.id));
  const remoteAgents = (remotePackage?.agents ?? []).map((agent) => {
    const override = overrides.get(agent.id);
    return {
      ...agent,
      modelId: typeof override?.modelId === "string" ? override.modelId : agent.modelId,
      enabled: typeof override?.enabled === "boolean" ? override.enabled : agent.enabled,
    };
  });
  const remoteAgentIds = remoteAgents.map((agent) => agent.id);
  const builtins = BUILTIN_AGENTS.map((agent) => {
    const override = overrides.get(agent.id);
    return {
      ...agent,
      modelId: typeof override?.modelId === "string" ? override.modelId : agent.modelId,
      enabled: typeof override?.enabled === "boolean" ? override.enabled : agent.enabled,
      delegatableAgentIds: agent.kind === "primary"
        ? [...new Set([...agent.delegatableAgentIds, ...remoteAgentIds])]
        : agent.delegatableAgentIds,
    };
  });
  const managedIds = new Set([...builtinIds, ...remoteAgentIds]);
  const custom = parseAgents(value)
    .filter((agent) => !managedIds.has(agent.id))
    .map((agent) => ({ ...agent, source: "custom" as const }));
  return [...builtins, ...remoteAgents, ...custom];
}

export async function saveAgentDefinitions(agents: AgentDefinition[]): Promise<void> {
  const remotePackage = await getInstalledOhStoryPackage();
  const managedIds = new Set([...BUILTIN_AGENTS.map((agent) => agent.id), ...(remotePackage?.agents ?? []).map((agent) => agent.id)]);
  await writeJson("agent.definitions", agents.map((agent) => managedIds.has(agent.id)
    ? { id: agent.id, enabled: agent.enabled, modelId: agent.modelId }
    : { ...agent, source: "custom" }));
}
