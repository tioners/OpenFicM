import * as SecureStore from "expo-secure-store";

import { createId } from "@/lib/id";
import { normalizePlanTodos } from "@/agent/plan";
import type {
  CharacterRelationship,
  ChatAttachment,
  ChatAttachmentFormat,
  PlanTodo,
  SearchProvider,
  SearchProviderType,
} from "@/types";

import { getDatabase } from "./database";

/** 联网搜索服务、会话附件、角色关系、会话计划的仓储。 */

// ---------- 联网搜索服务 ----------

type SearchProviderRow = {
  id: string;
  name: string;
  type: SearchProviderType;
  base_url: string;
  api_key_ref: string;
  created_at: string;
};

const mapSearchProvider = (row: SearchProviderRow): SearchProvider => ({
  id: row.id,
  name: row.name,
  type: row.type,
  baseUrl: row.base_url,
  apiKeyRef: row.api_key_ref,
  createdAt: row.created_at,
});

const SEARCH_PROVIDER_TYPES: readonly SearchProviderType[] = ["tavily", "zhipu", "brave", "serper", "jina", "exa", "searxng"];
const ACTIVE_SEARCH_PROVIDER_KEY = "web.activeSearchProviderId";

function normalizeBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s]+$/i.test(normalized)) throw new Error("Base URL 必须是 http 或 https 地址");
  return normalized;
}

export async function listSearchProviders(): Promise<SearchProvider[]> {
  const db = await getDatabase();
  return (await db.getAllAsync<SearchProviderRow>("SELECT * FROM search_providers ORDER BY created_at")).map(mapSearchProvider);
}

export async function saveSearchProvider(input: {
  id?: string;
  name: string;
  type: SearchProviderType;
  baseUrl: string;
  /** 编辑时留空表示保持原 Key；SearXNG 自建实例可以不填。 */
  apiKey: string;
}): Promise<SearchProvider> {
  if (!SEARCH_PROVIDER_TYPES.includes(input.type)) throw new Error("不支持的搜索服务类型");
  const db = await getDatabase();
  const id = input.id ?? createId();
  const name = input.name.trim();
  if (!name) throw new Error("搜索服务名称不能为空");
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const apiKeyRef = `openfic.search.${id}`;
  const existing = await db.getFirstAsync<SearchProviderRow>("SELECT * FROM search_providers WHERE id = ?", id);
  const apiKey = input.apiKey.trim();
  if (!apiKey && !existing && input.type !== "searxng") throw new Error("API Key 不能为空");
  if (apiKey) await SecureStore.setItemAsync(apiKeyRef, apiKey);
  const createdAt = existing?.created_at ?? new Date().toISOString();
  await db.runAsync(
    `INSERT INTO search_providers(id, name, type, base_url, api_key_ref, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, type = excluded.type, base_url = excluded.base_url`,
    id, name, input.type, baseUrl, apiKeyRef, createdAt,
  );
  return { id, name, type: input.type, baseUrl, apiKeyRef, createdAt };
}

export async function deleteSearchProvider(provider: SearchProvider): Promise<void> {
  const db = await getDatabase();
  await db.runAsync("DELETE FROM search_providers WHERE id = ?", provider.id);
  await db.runAsync("DELETE FROM app_settings WHERE key = ? AND value = ?", ACTIVE_SEARCH_PROVIDER_KEY, provider.id);
  await SecureStore.deleteItemAsync(provider.apiKeyRef).catch(() => undefined);
}

export async function setActiveSearchProvider(id: string): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    "INSERT INTO app_settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ACTIVE_SEARCH_PROVIDER_KEY, id,
  );
}

/** 当前使用的搜索服务：用户选中的那个；没选过就用第一个。 */
export async function getActiveSearchProvider(): Promise<SearchProvider | null> {
  const db = await getDatabase();
  const [providers, selected] = await Promise.all([
    listSearchProviders(),
    db.getFirstAsync<{ value: string }>("SELECT value FROM app_settings WHERE key = ?", ACTIVE_SEARCH_PROVIDER_KEY),
  ]);
  return providers.find((provider) => provider.id === selected?.value) ?? providers[0] ?? null;
}

export async function getSearchProviderApiKey(provider: SearchProvider): Promise<string> {
  return (await SecureStore.getItemAsync(provider.apiKeyRef)) ?? "";
}

// ---------- 会话附件 ----------

type AttachmentRow = {
  id: string;
  project_id: string;
  session_id: string;
  file_name: string;
  format: ChatAttachmentFormat;
  size_bytes: number;
  character_count: number;
  created_at: string;
};

const ATTACHMENT_COLUMNS = "id, project_id, session_id, file_name, format, size_bytes, character_count, created_at";

const mapAttachment = (row: AttachmentRow): ChatAttachment => ({
  id: row.id,
  projectId: row.project_id,
  sessionId: row.session_id,
  fileName: row.file_name,
  format: row.format,
  sizeBytes: row.size_bytes,
  characterCount: row.character_count,
  createdAt: row.created_at,
});

export const MAX_SESSION_ATTACHMENTS = 20;

export async function listAttachments(sessionId: string): Promise<ChatAttachment[]> {
  const db = await getDatabase();
  return (await db.getAllAsync<AttachmentRow>(
    `SELECT ${ATTACHMENT_COLUMNS} FROM chat_attachments WHERE session_id = ? ORDER BY created_at, rowid`,
    sessionId,
  )).map(mapAttachment);
}

export async function addAttachment(input: {
  sessionId: string;
  fileName: string;
  format: ChatAttachmentFormat;
  sizeBytes: number;
  content: string;
}): Promise<ChatAttachment> {
  const db = await getDatabase();
  const session = await db.getFirstAsync<{ project_id: string }>(
    "SELECT project_id FROM chat_sessions WHERE id = ?",
    input.sessionId,
  );
  if (!session) throw new Error("对话不存在");
  const count = await db.getFirstAsync<{ value: number }>(
    "SELECT COUNT(*) AS value FROM chat_attachments WHERE session_id = ?",
    input.sessionId,
  );
  if ((count?.value ?? 0) >= MAX_SESSION_ATTACHMENTS) {
    throw new Error(`每个对话最多 ${MAX_SESSION_ATTACHMENTS} 个附件，请先移除不用的`);
  }
  const fileName = input.fileName.trim().slice(0, 200) || "未命名附件";
  const attachment: ChatAttachment = {
    id: createId(),
    projectId: session.project_id,
    sessionId: input.sessionId,
    fileName,
    format: input.format,
    sizeBytes: input.sizeBytes,
    characterCount: input.content.length,
    createdAt: new Date().toISOString(),
  };
  await db.runAsync(
    `INSERT INTO chat_attachments(id, project_id, session_id, file_name, format, size_bytes, character_count, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    attachment.id, attachment.projectId, attachment.sessionId, attachment.fileName, attachment.format,
    attachment.sizeBytes, attachment.characterCount, input.content, attachment.createdAt,
  );
  return attachment;
}

export async function getAttachmentContent(
  sessionId: string,
  attachmentId: string,
): Promise<{ attachment: ChatAttachment; content: string } | null> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<AttachmentRow & { content: string }>(
    "SELECT * FROM chat_attachments WHERE id = ? AND session_id = ?",
    attachmentId,
    sessionId,
  );
  return row ? { attachment: mapAttachment(row), content: row.content } : null;
}

export async function deleteAttachment(id: string): Promise<void> {
  const db = await getDatabase();
  await db.runAsync("DELETE FROM chat_attachments WHERE id = ?", id);
}

// ---------- 角色关系 ----------

type RelationshipRow = {
  id: string;
  project_id: string;
  source_character_id: string;
  target_character_id: string;
  name: string;
  description: string;
  updated_at: string;
};

const mapRelationship = (row: RelationshipRow): CharacterRelationship => ({
  id: row.id,
  projectId: row.project_id,
  sourceCharacterId: row.source_character_id,
  targetCharacterId: row.target_character_id,
  name: row.name,
  description: row.description,
  updatedAt: row.updated_at,
});

const MAX_RELATIONSHIP_NAME_CHARACTERS = 200;
const MAX_RELATIONSHIP_DESCRIPTION_CHARACTERS = 4_000;

export async function listRelationships(projectId: string): Promise<CharacterRelationship[]> {
  const db = await getDatabase();
  return (await db.getAllAsync<RelationshipRow>(
    "SELECT * FROM character_relationships WHERE project_id = ? ORDER BY updated_at DESC",
    projectId,
  )).map(mapRelationship);
}

/** 两个角色之间只保留一条关系：不分先后，按 ID 排序后存成固定的一对。 */
function orderedPair(first: string, second: string): [string, string] {
  return first < second ? [first, second] : [second, first];
}

export async function getRelationship(
  projectId: string,
  firstCharacterId: string,
  secondCharacterId: string,
): Promise<CharacterRelationship | null> {
  const db = await getDatabase();
  const [source, target] = orderedPair(firstCharacterId, secondCharacterId);
  const row = await db.getFirstAsync<RelationshipRow>(
    "SELECT * FROM character_relationships WHERE project_id = ? AND source_character_id = ? AND target_character_id = ?",
    projectId, source, target,
  );
  return row ? mapRelationship(row) : null;
}

/** 新建或更新两个角色之间的关系。 */
export async function saveRelationship(input: {
  projectId: string;
  firstCharacterId: string;
  secondCharacterId: string;
  name: string;
  description?: string;
}): Promise<CharacterRelationship> {
  if (input.firstCharacterId === input.secondCharacterId) throw new Error("不能给角色和自己建立关系");
  const name = input.name.trim();
  if (!name) throw new Error("关系名称不能为空");
  if (name.length > MAX_RELATIONSHIP_NAME_CHARACTERS) throw new Error(`关系名称超过 ${MAX_RELATIONSHIP_NAME_CHARACTERS} 字符限制`);
  const description = (input.description ?? "").trim();
  if (description.length > MAX_RELATIONSHIP_DESCRIPTION_CHARACTERS) {
    throw new Error(`关系说明超过 ${MAX_RELATIONSHIP_DESCRIPTION_CHARACTERS} 字符限制`);
  }
  const db = await getDatabase();
  const [source, target] = orderedPair(input.firstCharacterId, input.secondCharacterId);
  const owners = await db.getAllAsync<{ id: string }>(
    "SELECT id FROM characters WHERE project_id = ? AND id IN (?, ?)",
    input.projectId, source, target,
  );
  if (owners.length !== 2) throw new Error("角色不存在或不属于当前作品");
  const existing = await getRelationship(input.projectId, source, target);
  const now = new Date().toISOString();
  const id = existing?.id ?? createId();
  await db.runAsync(
    `INSERT INTO character_relationships(id, project_id, source_character_id, target_character_id, name, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_character_id, target_character_id)
     DO UPDATE SET name = excluded.name, description = excluded.description, updated_at = excluded.updated_at`,
    id, input.projectId, source, target, name, description, now, now,
  );
  return {
    id,
    projectId: input.projectId,
    sourceCharacterId: source,
    targetCharacterId: target,
    name,
    description,
    updatedAt: now,
  };
}

export async function deleteRelationship(id: string): Promise<void> {
  const db = await getDatabase();
  await db.runAsync("DELETE FROM character_relationships WHERE id = ?", id);
}

// ---------- 会话计划 ----------

export async function getSessionPlan(sessionId: string): Promise<PlanTodo[]> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<{ plan_json: string | null }>(
    "SELECT plan_json FROM chat_sessions WHERE id = ?",
    sessionId,
  );
  if (!row?.plan_json) return [];
  try {
    return normalizePlanTodos(JSON.parse(row.plan_json));
  } catch {
    return [];
  }
}

export async function saveSessionPlan(sessionId: string, todos: PlanTodo[]): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    "UPDATE chat_sessions SET plan_json = ? WHERE id = ?",
    todos.length ? JSON.stringify(todos) : null,
    sessionId,
  );
}
