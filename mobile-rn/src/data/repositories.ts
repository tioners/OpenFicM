import * as SecureStore from "expo-secure-store";

import { createId } from "@/lib/id";
import type {
  Chapter,
  Character,
  ChatMessage,
  ChatMessageMetadata,
  ChatSession,
  Model,
  Project,
  Provider,
  ProviderType,
  Volume,
  WorldInfo,
  WorldInfoEntry,
} from "@/types";

import { getDatabase } from "./database";

const MAX_EDITOR_CONTENT_CHARACTERS = 100_000;
const MAX_EDITOR_CONTENT_LINES = 2_000;

type ProjectRow = { id: string; title: string; description: string; created_at: string; updated_at: string };
type VolumeRow = { id: string; project_id: string; title: string; order_index: number };
type ChapterRow = { id: string; project_id: string; volume_id: string; title: string; content: string; order_index: number; updated_at: string };
type ProviderRow = { id: string; name: string; type: ProviderType; base_url: string; api_key_ref: string; created_at: string };
type ModelRow = { id: string; provider_id: string; name: string; model_id: string; temperature: number; max_tokens: number };
type SessionRow = { id: string; project_id: string; title: string; model_id: string | null; created_at: string; updated_at: string };
type MessageRow = {
  id: string;
  project_id: string;
  session_id: string;
  role: ChatMessage["role"];
  content: string;
  metadata_json: string | null;
  created_at: string;
};
type CharacterRow = {
  id: string;
  project_id: string;
  name: string;
  description: string;
  image_path: string | null;
  is_favorited: number;
  created_at: string;
  updated_at: string;
};
type WorldInfoRow = {
  id: string;
  project_id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
};
type WorldInfoEntryRow = {
  id: string;
  world_info_id: string;
  uid: number;
  name: string;
  entry_order: number;
  content: string;
  token_count: number;
  is_enabled: number;
  created_at: string;
  updated_at: string;
};

const mapProject = (row: ProjectRow): Project => ({
  id: row.id, title: row.title, description: row.description, createdAt: row.created_at, updatedAt: row.updated_at,
});
const mapVolume = (row: VolumeRow): Volume => ({
  id: row.id, projectId: row.project_id, title: row.title, orderIndex: row.order_index,
});
const mapChapter = (row: ChapterRow): Chapter => ({
  id: row.id, projectId: row.project_id, volumeId: row.volume_id, title: row.title,
  content: row.content, orderIndex: row.order_index, updatedAt: row.updated_at,
});
const mapProvider = (row: ProviderRow): Provider => ({
  id: row.id, name: row.name, type: row.type, baseUrl: row.base_url,
  apiKeyRef: row.api_key_ref, createdAt: row.created_at,
});
const mapModel = (row: ModelRow): Model => ({
  id: row.id, providerId: row.provider_id, name: row.name, modelId: row.model_id,
  temperature: row.temperature, maxTokens: row.max_tokens,
});
const mapSession = (row: SessionRow): ChatSession => ({
  id: row.id, projectId: row.project_id, title: row.title, modelId: row.model_id,
  createdAt: row.created_at, updatedAt: row.updated_at,
});
function parseMessageMetadata(value: string | null): ChatMessageMetadata | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as ChatMessageMetadata
      : null;
  } catch {
    return null;
  }
}

const mapMessage = (row: MessageRow): ChatMessage => ({
  id: row.id, projectId: row.project_id, sessionId: row.session_id,
  role: row.role, content: row.content, metadata: parseMessageMetadata(row.metadata_json), createdAt: row.created_at,
});
const mapCharacter = (row: CharacterRow): Character => ({
  id: row.id,
  projectId: row.project_id,
  name: row.name,
  description: row.description,
  imagePath: row.image_path,
  isFavorited: row.is_favorited === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
const mapWorldInfo = (row: WorldInfoRow): WorldInfo => ({
  id: row.id,
  projectId: row.project_id,
  name: row.name,
  description: row.description,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
const mapWorldInfoEntry = (row: WorldInfoEntryRow): WorldInfoEntry => ({
  id: row.id,
  worldInfoId: row.world_info_id,
  uid: row.uid,
  name: row.name,
  order: row.entry_order,
  content: row.content,
  tokenCount: row.token_count,
  isEnabled: row.is_enabled === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label}不能为空`);
  return normalized;
}

function normalizeBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s]+$/i.test(normalized)) throw new Error("Base URL 必须是 http 或 https 地址");
  return normalized;
}

function validateChapterContent(content: string): void {
  const lineCount = content.split(/\r?\n/).length;
  if (content.length > MAX_EDITOR_CONTENT_CHARACTERS || lineCount > MAX_EDITOR_CONTENT_LINES) {
    throw new Error(`内容超出限制：单一章节最多 ${MAX_EDITOR_CONTENT_LINES} 行或 ${MAX_EDITOR_CONTENT_CHARACTERS} 字符`);
  }
}

function generatedMessageTitle(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 24) || "新对话";
}

export async function listProjects(): Promise<Project[]> {
  const db = await getDatabase();
  return (await db.getAllAsync<ProjectRow>("SELECT * FROM projects ORDER BY updated_at DESC")).map(mapProject);
}

export async function getProject(id: string): Promise<Project | null> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<ProjectRow>("SELECT * FROM projects WHERE id = ?", id);
  return row ? mapProject(row) : null;
}

export async function createProject(title: string, description = ""): Promise<Project> {
  const db = await getDatabase();
  const id = createId();
  const now = new Date().toISOString();
  const normalizedTitle = requiredText(title, "作品名");
  const normalizedDescription = description.trim();
  const volumeId = createId();
  const chapterId = createId();
  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync(
      "INSERT INTO projects(id, title, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      id, normalizedTitle, normalizedDescription, now, now,
    );
    await txn.runAsync(
      "INSERT INTO volumes(id, project_id, title, order_index) VALUES (?, ?, ?, 1)",
      volumeId, id, "正文",
    );
    await txn.runAsync(
      "INSERT INTO chapters(id, project_id, volume_id, title, content, order_index, updated_at) VALUES (?, ?, ?, ?, '', 1, ?)",
      chapterId, id, volumeId, "第一章", now,
    );
    await txn.runAsync(
      "INSERT INTO chapter_fts(chapter_id, project_id, title, content) VALUES (?, ?, ?, '')",
      chapterId, id, "第一章",
    );
  });
  return { id, title: normalizedTitle, description: normalizedDescription, createdAt: now, updatedAt: now };
}

export async function deleteProject(id: string): Promise<void> {
  const db = await getDatabase();
  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync("DELETE FROM chapter_fts WHERE project_id = ?", id);
    await txn.runAsync("DELETE FROM projects WHERE id = ?", id);
    await txn.runAsync(
      "DELETE FROM app_settings WHERE key IN (?, ?)",
      `assistant.activeSession.${id}`,
      `agent.pendingConsistency.${id}`,
    );
  });
}

export async function listVolumes(projectId: string): Promise<Volume[]> {
  const db = await getDatabase();
  return (await db.getAllAsync<VolumeRow>(
    "SELECT * FROM volumes WHERE project_id = ? ORDER BY order_index", projectId,
  )).map(mapVolume);
}

export async function createVolume(projectId: string, title: string): Promise<Volume> {
  const db = await getDatabase();
  const id = createId();
  const normalizedTitle = requiredText(title, "卷名");
  const now = new Date().toISOString();
  let orderIndex = 1;
  await db.withExclusiveTransactionAsync(async (txn) => {
    const orderRow = await txn.getFirstAsync<{ next_order: number }>(
      "SELECT COALESCE(MAX(order_index), 0) + 1 AS next_order FROM volumes WHERE project_id = ?", projectId,
    );
    orderIndex = orderRow?.next_order ?? 1;
    await txn.runAsync("INSERT INTO volumes(id, project_id, title, order_index) VALUES (?, ?, ?, ?)", id, projectId, normalizedTitle, orderIndex);
    await txn.runAsync("UPDATE projects SET updated_at = ? WHERE id = ?", now, projectId);
  });
  return { id, projectId, title: normalizedTitle, orderIndex };
}

export async function renameVolume(id: string, title: string): Promise<Volume> {
  const db = await getDatabase();
  const volume = await db.getFirstAsync<VolumeRow>("SELECT * FROM volumes WHERE id = ?", id);
  if (!volume) throw new Error("卷不存在");
  const normalizedTitle = requiredText(title, "卷名");
  const now = new Date().toISOString();
  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync("UPDATE volumes SET title = ? WHERE id = ?", normalizedTitle, id);
    await txn.runAsync("UPDATE projects SET updated_at = ? WHERE id = ?", now, volume.project_id);
  });
  return mapVolume({ ...volume, title: normalizedTitle });
}

export async function deleteVolume(id: string): Promise<void> {
  const db = await getDatabase();
  const now = new Date().toISOString();
  await db.withExclusiveTransactionAsync(async (txn) => {
    const volume = await txn.getFirstAsync<VolumeRow>("SELECT * FROM volumes WHERE id = ?", id);
    if (!volume) throw new Error("卷不存在");
    const countRow = await txn.getFirstAsync<{ volume_count: number }>(
      "SELECT COUNT(*) AS volume_count FROM volumes WHERE project_id = ?",
      volume.project_id,
    );
    if ((countRow?.volume_count ?? 0) <= 1) throw new Error("每部作品至少需要保留一卷");
    const chapterCountRow = await txn.getFirstAsync<{ chapter_count: number }>(
      "SELECT COUNT(*) AS chapter_count FROM chapters WHERE volume_id = ?",
      id,
    );
    await txn.runAsync(
      "DELETE FROM chapter_fts WHERE chapter_id IN (SELECT id FROM chapters WHERE volume_id = ?)",
      id,
    );
    await txn.runAsync(
      "DELETE FROM vector_chunks WHERE project_id = ? AND source_type = 'chapter' AND source_id IN (SELECT id FROM chapters WHERE volume_id = ?)",
      volume.project_id,
      id,
    );
    await txn.runAsync("DELETE FROM volumes WHERE id = ?", id);
    await txn.runAsync("UPDATE projects SET updated_at = ? WHERE id = ?", now, volume.project_id);
    if ((chapterCountRow?.chapter_count ?? 0) > 0) {
      await txn.runAsync(
        "INSERT INTO app_settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        `agent.pendingConsistency.${volume.project_id}`,
        JSON.stringify({ change: "volume_deleted", volumeId: id, volumeTitle: volume.title, chapterCount: chapterCountRow?.chapter_count ?? 0, updatedAt: now }),
      );
    }
  });
}

export async function listChapters(projectId: string): Promise<Chapter[]> {
  const db = await getDatabase();
  return (await db.getAllAsync<ChapterRow>(`
    SELECT c.* FROM chapters c
    JOIN volumes v ON v.id = c.volume_id
    WHERE c.project_id = ?
    ORDER BY v.order_index, c.order_index
  `, projectId)).map(mapChapter);
}

export async function getChapter(id: string): Promise<Chapter | null> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<ChapterRow>("SELECT * FROM chapters WHERE id = ?", id);
  return row ? mapChapter(row) : null;
}

export async function createChapter(
  projectId: string,
  volumeId: string,
  title: string,
  content = "",
): Promise<Chapter> {
  const db = await getDatabase();
  const id = createId();
  const now = new Date().toISOString();
  const normalizedTitle = requiredText(title, "章节标题");
  validateChapterContent(content);
  const consistencyKey = `agent.pendingConsistency.${projectId}`;
  const consistencyValue = JSON.stringify({ chapterId: id, chapterTitle: normalizedTitle, updatedAt: now });
  let orderIndex = 1;
  await db.withExclusiveTransactionAsync(async (txn) => {
    const volume = await txn.getFirstAsync<{ id: string }>(
      "SELECT id FROM volumes WHERE id = ? AND project_id = ?",
      volumeId,
      projectId,
    );
    if (!volume) throw new Error("卷不属于当前作品");
    const orderRow = await txn.getFirstAsync<{ next_order: number }>(
      "SELECT COALESCE(MAX(order_index), 0) + 1 AS next_order FROM chapters WHERE volume_id = ?", volumeId,
    );
    orderIndex = orderRow?.next_order ?? 1;
    await txn.runAsync(
      "INSERT INTO chapters(id, project_id, volume_id, title, content, order_index, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id, projectId, volumeId, normalizedTitle, content, orderIndex, now,
    );
    await txn.runAsync(
      "INSERT INTO chapter_fts(chapter_id, project_id, title, content) VALUES (?, ?, ?, ?)",
      id,
      projectId,
      normalizedTitle,
      content,
    );
    await txn.runAsync("UPDATE projects SET updated_at = ? WHERE id = ?", now, projectId);
    if (content.trim()) {
      await txn.runAsync(
        "INSERT INTO app_settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        consistencyKey,
        consistencyValue,
      );
    }
  });
  return { id, projectId, volumeId, title: normalizedTitle, content, orderIndex, updatedAt: now };
}

export async function saveChapter(id: string, title: string, content: string): Promise<void> {
  const db = await getDatabase();
  const now = new Date().toISOString();
  const chapter = await getChapter(id);
  if (!chapter) throw new Error("章节不存在");
  const normalizedTitle = requiredText(title, "章节标题");
  validateChapterContent(content);
  const consistencyKey = `agent.pendingConsistency.${chapter.projectId}`;
  const consistencyValue = JSON.stringify({ chapterId: id, chapterTitle: normalizedTitle, updatedAt: now });
  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync("UPDATE chapters SET title = ?, content = ?, updated_at = ? WHERE id = ?", normalizedTitle, content, now, id);
    await txn.runAsync("UPDATE projects SET updated_at = ? WHERE id = ?", now, chapter.projectId);
    await txn.runAsync(
      "INSERT INTO app_settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      consistencyKey, consistencyValue,
    );
    await txn.runAsync("DELETE FROM vector_chunks WHERE project_id = ? AND source_type = 'chapter' AND source_id = ?", chapter.projectId, id);
    await txn.runAsync("DELETE FROM chapter_fts WHERE chapter_id = ?", id);
    await txn.runAsync("INSERT INTO chapter_fts(chapter_id, project_id, title, content) VALUES (?, ?, ?, ?)", id, chapter.projectId, normalizedTitle, content);
  });
}

export async function renameChapter(id: string, title: string): Promise<Chapter> {
  const db = await getDatabase();
  const chapter = await db.getFirstAsync<ChapterRow>("SELECT * FROM chapters WHERE id = ?", id);
  if (!chapter) throw new Error("章节不存在");
  const normalizedTitle = requiredText(title, "章节标题");
  const now = new Date().toISOString();
  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync("UPDATE chapters SET title = ?, updated_at = ? WHERE id = ?", normalizedTitle, now, id);
    await txn.runAsync("UPDATE projects SET updated_at = ? WHERE id = ?", now, chapter.project_id);
    await txn.runAsync("DELETE FROM vector_chunks WHERE project_id = ? AND source_type = 'chapter' AND source_id = ?", chapter.project_id, id);
    await txn.runAsync("DELETE FROM chapter_fts WHERE chapter_id = ?", id);
    await txn.runAsync(
      "INSERT INTO chapter_fts(chapter_id, project_id, title, content) VALUES (?, ?, ?, ?)",
      id,
      chapter.project_id,
      normalizedTitle,
      chapter.content,
    );
    await txn.runAsync(
      "INSERT INTO app_settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      `agent.pendingConsistency.${chapter.project_id}`,
      JSON.stringify({ change: "chapter_renamed", chapterId: id, chapterTitle: normalizedTitle, updatedAt: now }),
    );
  });
  return mapChapter({ ...chapter, title: normalizedTitle, updated_at: now });
}

export async function deleteChapter(id: string): Promise<void> {
  const db = await getDatabase();
  const now = new Date().toISOString();
  await db.withExclusiveTransactionAsync(async (txn) => {
    const chapter = await txn.getFirstAsync<ChapterRow>("SELECT * FROM chapters WHERE id = ?", id);
    if (!chapter) throw new Error("章节不存在");
    await txn.runAsync("DELETE FROM chapter_fts WHERE chapter_id = ?", id);
    await txn.runAsync("DELETE FROM vector_chunks WHERE project_id = ? AND source_type = 'chapter' AND source_id = ?", chapter.project_id, id);
    await txn.runAsync("DELETE FROM chapters WHERE id = ?", id);
    await txn.runAsync("UPDATE projects SET updated_at = ? WHERE id = ?", now, chapter.project_id);
    await txn.runAsync(
      "INSERT INTO app_settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      `agent.pendingConsistency.${chapter.project_id}`,
      JSON.stringify({ change: "chapter_deleted", chapterId: id, chapterTitle: chapter.title, updatedAt: now }),
    );
  });
}

export async function searchChapters(projectId: string, query: string): Promise<Chapter[]> {
  const db = await getDatabase();
  const terms = query.trim().replace(/[^\p{L}\p{N}_]+/gu, " ").split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const matchQuery = terms.map((term) => `"${term.replace(/"/g, '""')}"*`).join(" AND ");
  try {
    return (await db.getAllAsync<ChapterRow>(`
      SELECT c.* FROM chapter_fts f JOIN chapters c ON c.id = f.chapter_id
      WHERE f.project_id = ? AND chapter_fts MATCH ? ORDER BY rank LIMIT 20
    `, projectId, matchQuery)).map(mapChapter);
  } catch {
    const likeQuery = `%${query.trim()}%`;
    return (await db.getAllAsync<ChapterRow>(`
      SELECT * FROM chapters WHERE project_id = ? AND (title LIKE ? OR content LIKE ?)
      ORDER BY updated_at DESC LIMIT 20
    `, projectId, likeQuery, likeQuery)).map(mapChapter);
  }
}

export async function listProviders(): Promise<Provider[]> {
  const db = await getDatabase();
  return (await db.getAllAsync<ProviderRow>("SELECT * FROM providers ORDER BY created_at")).map(mapProvider);
}

export async function saveProvider(input: { id?: string; name: string; type: ProviderType; baseUrl: string; apiKey: string }): Promise<Provider> {
  const db = await getDatabase();
  const id = input.id ?? createId();
  const name = requiredText(input.name, "供应商名称");
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const apiKey = requiredText(input.apiKey, "API Key");
  const apiKeyRef = `openfic.provider.${id}`;
  const now = new Date().toISOString();
  const existing = await db.getFirstAsync<ProviderRow>("SELECT * FROM providers WHERE id = ?", id);
  const previousApiKey = existing ? await SecureStore.getItemAsync(existing.api_key_ref) : null;
  await SecureStore.setItemAsync(apiKeyRef, apiKey);
  try {
    await db.withExclusiveTransactionAsync(async (txn) => {
      await txn.runAsync(`
        INSERT INTO providers(id, name, type, base_url, api_key_ref, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, type = excluded.type,
          base_url = excluded.base_url, api_key_ref = excluded.api_key_ref
      `, id, name, input.type, baseUrl, apiKeyRef, existing?.created_at ?? now);
    });
  } catch (error) {
    if (previousApiKey === null) await SecureStore.deleteItemAsync(apiKeyRef);
    else await SecureStore.setItemAsync(apiKeyRef, previousApiKey);
    throw error;
  }
  return { id, name, type: input.type, baseUrl, apiKeyRef, createdAt: existing?.created_at ?? now };
}

export async function getProviderApiKey(provider: Provider): Promise<string> {
  return (await SecureStore.getItemAsync(provider.apiKeyRef)) ?? "";
}

export async function deleteProvider(provider: Provider): Promise<void> {
  const db = await getDatabase();
  await db.withExclusiveTransactionAsync(async (txn) => {
    const active = await txn.getFirstAsync<{ value: string }>("SELECT value FROM app_settings WHERE key = 'activeModelId'");
    const activeModel = active
      ? await txn.getFirstAsync<{ provider_id: string }>("SELECT provider_id FROM models WHERE id = ?", active.value)
      : null;
    if (activeModel?.provider_id === provider.id) await txn.runAsync("DELETE FROM app_settings WHERE key = 'activeModelId'");
    await txn.runAsync("DELETE FROM providers WHERE id = ?", provider.id);
  });
  await SecureStore.deleteItemAsync(provider.apiKeyRef).catch(() => undefined);
}

export async function listModels(providerId?: string): Promise<Model[]> {
  const db = await getDatabase();
  const rows = providerId
    ? await db.getAllAsync<ModelRow>("SELECT * FROM models WHERE provider_id = ? ORDER BY name", providerId)
    : await db.getAllAsync<ModelRow>("SELECT * FROM models ORDER BY name");
  return rows.map(mapModel);
}

export async function saveModel(input: Omit<Model, "id"> & { id?: string }): Promise<Model> {
  const db = await getDatabase();
  const id = input.id ?? createId();
  const name = requiredText(input.name, "模型名称");
  const modelId = requiredText(input.modelId, "模型 ID");
  if (!Number.isFinite(input.temperature) || input.temperature < 0 || input.temperature > 2) throw new Error("温度必须在 0 到 2 之间");
  if (!Number.isInteger(input.maxTokens) || input.maxTokens < 1) throw new Error("最大输出 Token 数必须是正整数");
  const provider = await db.getFirstAsync<{ id: string }>("SELECT id FROM providers WHERE id = ?", input.providerId);
  if (!provider) throw new Error("供应商不存在");
  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync(`
      INSERT INTO models(id, provider_id, name, model_id, temperature, max_tokens)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET provider_id = excluded.provider_id, name = excluded.name,
        model_id = excluded.model_id, temperature = excluded.temperature, max_tokens = excluded.max_tokens
    `, id, input.providerId, name, modelId, input.temperature, input.maxTokens);
  });
  return { id, providerId: input.providerId, name, modelId, temperature: input.temperature, maxTokens: input.maxTokens };
}

export async function listChatSessions(projectId: string): Promise<ChatSession[]> {
  const db = await getDatabase();
  return (await db.getAllAsync<SessionRow>(
    "SELECT * FROM chat_sessions WHERE project_id = ? ORDER BY updated_at DESC, created_at DESC",
    projectId,
  )).map(mapSession);
}

export async function getChatSession(id: string): Promise<ChatSession | null> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<SessionRow>("SELECT * FROM chat_sessions WHERE id = ?", id);
  return row ? mapSession(row) : null;
}

export async function createChatSession(projectId: string, modelId: string | null = null): Promise<ChatSession> {
  const db = await getDatabase();
  const project = await db.getFirstAsync<{ id: string }>("SELECT id FROM projects WHERE id = ?", projectId);
  if (!project) throw new Error("作品不存在");
  const normalizedModelId = modelId?.trim() || null;
  if (normalizedModelId) {
    const model = await db.getFirstAsync<{ id: string }>("SELECT id FROM models WHERE id = ?", normalizedModelId);
    if (!model) throw new Error("模型不存在");
  }
  const session: ChatSession = {
    id: createId(),
    projectId,
    title: "新对话",
    modelId: normalizedModelId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await db.runAsync(
    "INSERT INTO chat_sessions(id, project_id, title, model_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    session.id, session.projectId, session.title, session.modelId, session.createdAt, session.updatedAt,
  );
  return session;
}

export async function updateChatSession(input: {
  id: string;
  title?: string;
  modelId?: string | null;
}): Promise<ChatSession> {
  const db = await getDatabase();
  const existing = await db.getFirstAsync<SessionRow>("SELECT * FROM chat_sessions WHERE id = ?", input.id);
  if (!existing) throw new Error("对话不存在");
  const title = input.title === undefined ? existing.title : requiredText(input.title, "对话标题").slice(0, 80);
  const modelId = input.modelId === undefined ? existing.model_id : input.modelId?.trim() || null;
  if (modelId) {
    const model = await db.getFirstAsync<{ id: string }>("SELECT id FROM models WHERE id = ?", modelId);
    if (!model) throw new Error("模型不存在");
  }
  const updatedAt = new Date().toISOString();
  await db.runAsync(
    "UPDATE chat_sessions SET title = ?, model_id = ?, updated_at = ? WHERE id = ?",
    title, modelId, updatedAt, input.id,
  );
  return mapSession({ ...existing, title, model_id: modelId, updated_at: updatedAt });
}

export async function deleteChatSession(id: string): Promise<void> {
  const db = await getDatabase();
  await db.runAsync("DELETE FROM chat_sessions WHERE id = ?", id);
}

export async function listMessages(sessionId: string): Promise<ChatMessage[]> {
  const db = await getDatabase();
  return (await db.getAllAsync<MessageRow>(
    "SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at, rowid",
    sessionId,
  )).map(mapMessage);
}

export async function deleteMessagesFrom(sessionId: string, messageId: string): Promise<void> {
  const db = await getDatabase();
  await db.withExclusiveTransactionAsync(async (txn) => {
    const target = await txn.getFirstAsync<{ rowid: number }>(
      "SELECT rowid FROM chat_messages WHERE session_id = ? AND id = ?",
      sessionId,
      messageId,
    );
    if (!target) throw new Error("要编辑的消息不存在");
    await txn.runAsync(
      "DELETE FROM chat_messages WHERE session_id = ? AND rowid >= ?",
      sessionId,
      target.rowid,
    );
    await txn.runAsync(
      "UPDATE chat_sessions SET updated_at = ? WHERE id = ?",
      new Date().toISOString(),
      sessionId,
    );
  });
}

export async function replaceUserMessageBranch(
  sessionId: string,
  messageId: string,
  content: string,
): Promise<{ message: ChatMessage; session: ChatSession }> {
  if (!content.trim()) throw new Error("消息内容不能为空");
  const db = await getDatabase();
  let replacement: { message: ChatMessage; session: ChatSession } | null = null;
  await db.withExclusiveTransactionAsync(async (txn) => {
    const session = await txn.getFirstAsync<SessionRow>("SELECT * FROM chat_sessions WHERE id = ?", sessionId);
    if (!session) throw new Error("对话不存在");
    const target = await txn.getFirstAsync<{ rowid: number; role: ChatMessage["role"] }>(
      "SELECT rowid, role FROM chat_messages WHERE session_id = ? AND id = ?",
      sessionId,
      messageId,
    );
    if (!target || target.role !== "user") throw new Error("要编辑的用户消息不存在");
    const earlierUser = await txn.getFirstAsync<{ found: number }>(
      "SELECT 1 AS found FROM chat_messages WHERE session_id = ? AND role = 'user' AND rowid < ? LIMIT 1",
      sessionId,
      target.rowid,
    );
    const createdAt = new Date().toISOString();
    const message: ChatMessage = {
      id: createId(),
      projectId: session.project_id,
      sessionId,
      role: "user",
      content,
      metadata: null,
      createdAt,
    };
    const title = earlierUser ? session.title : generatedMessageTitle(content);
    await txn.runAsync("DELETE FROM chat_messages WHERE session_id = ? AND rowid >= ?", sessionId, target.rowid);
    await txn.runAsync(
      "INSERT INTO chat_messages(id, project_id, session_id, role, content, metadata_json, created_at) VALUES (?, ?, ?, 'user', ?, NULL, ?)",
      message.id,
      message.projectId,
      message.sessionId,
      message.content,
      message.createdAt,
    );
    await txn.runAsync(
      "UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ?",
      title,
      createdAt,
      sessionId,
    );
    replacement = {
      message,
      session: mapSession({ ...session, title, updated_at: createdAt }),
    };
  });
  if (!replacement) throw new Error("消息编辑事务未完成");
  return replacement;
}

export async function addMessage(
  sessionId: string,
  role: ChatMessage["role"],
  content: string,
  metadata: ChatMessageMetadata | null = null,
): Promise<ChatMessage> {
  if (!content.trim()) throw new Error("消息内容不能为空");
  const db = await getDatabase();
  const session = await db.getFirstAsync<SessionRow>("SELECT * FROM chat_sessions WHERE id = ?", sessionId);
  if (!session) throw new Error("对话不存在");
  const createdAt = new Date().toISOString();
  const message: ChatMessage = { id: createId(), projectId: session.project_id, sessionId, role, content, metadata, createdAt };
  const generatedTitle = generatedMessageTitle(content);
  const metadataJson = metadata ? JSON.stringify(metadata) : null;
  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync(
      "INSERT INTO chat_messages(id, project_id, session_id, role, content, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      message.id, message.projectId, message.sessionId, message.role, message.content, metadataJson, message.createdAt,
    );
    await txn.runAsync(
      "UPDATE chat_sessions SET title = CASE WHEN title = '新对话' AND ? = 'user' THEN ? ELSE title END, updated_at = ? WHERE id = ?",
      role, generatedTitle, createdAt, sessionId,
    );
  });
  return message;
}

export async function getSetting(key: string): Promise<string | null> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<{ value: string }>("SELECT value FROM app_settings WHERE key = ?", key);
  return row?.value ?? null;
}

const UPSERT_SETTING_SQL = "INSERT INTO app_settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value";

export async function setSetting(key: string, value: string): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(UPSERT_SETTING_SQL, key, value);
}

export async function setSettings(entries: ReadonlyArray<readonly [string, string]>): Promise<void> {
  if (!entries.length) return;
  const db = await getDatabase();
  await db.withExclusiveTransactionAsync(async (transaction) => {
    for (const [key, value] of entries) {
      await transaction.runAsync(UPSERT_SETTING_SQL, key, value);
    }
  });
}

export async function listCharacters(projectId: string, query = ""): Promise<Character[]> {
  const db = await getDatabase();
  const normalized = query.trim();
  const rows = normalized
    ? await db.getAllAsync<CharacterRow>(
      "SELECT * FROM characters WHERE project_id = ? AND (name LIKE ? OR description LIKE ?) ORDER BY is_favorited DESC, updated_at DESC",
      projectId,
      `%${normalized}%`,
      `%${normalized}%`,
    )
    : await db.getAllAsync<CharacterRow>(
      "SELECT * FROM characters WHERE project_id = ? ORDER BY is_favorited DESC, updated_at DESC",
      projectId,
    );
  return rows.map(mapCharacter);
}

export async function getCharacter(id: string): Promise<Character | null> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<CharacterRow>("SELECT * FROM characters WHERE id = ?", id);
  return row ? mapCharacter(row) : null;
}

export async function saveCharacter(input: {
  id?: string;
  projectId: string;
  name: string;
  description?: string;
  imagePath?: string | null;
  isFavorited?: boolean;
}): Promise<Character> {
  const db = await getDatabase();
  const id = input.id ?? createId();
  const name = requiredText(input.name, "角色名称");
  const description = input.description?.trim() ?? "";
  validateChapterContent(description);
  const now = new Date().toISOString();
  const existing = await db.getFirstAsync<CharacterRow>("SELECT * FROM characters WHERE id = ?", id);
  await db.runAsync(`
    INSERT INTO characters(id, project_id, name, description, image_path, is_favorited, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description,
      image_path = excluded.image_path, is_favorited = excluded.is_favorited, updated_at = excluded.updated_at
  `, id, input.projectId, name, description, input.imagePath ?? null, input.isFavorited ? 1 : 0, existing?.created_at ?? now, now);
  return {
    id,
    projectId: input.projectId,
    name,
    description,
    imagePath: input.imagePath ?? null,
    isFavorited: Boolean(input.isFavorited),
    createdAt: existing?.created_at ?? now,
    updatedAt: now,
  };
}

export async function deleteCharacter(id: string): Promise<void> {
  const db = await getDatabase();
  const now = new Date().toISOString();
  await db.withExclusiveTransactionAsync(async (txn) => {
    const character = await txn.getFirstAsync<CharacterRow>("SELECT * FROM characters WHERE id = ?", id);
    if (!character) throw new Error("角色不存在");
    await txn.runAsync(
      "DELETE FROM vector_chunks WHERE project_id = ? AND source_type = 'character' AND source_id = ?",
      character.project_id,
      id,
    );
    await txn.runAsync("DELETE FROM characters WHERE id = ?", id);
    await txn.runAsync("UPDATE projects SET updated_at = ? WHERE id = ?", now, character.project_id);
  });
}

export async function getOrCreateWorldInfo(projectId: string): Promise<WorldInfo> {
  const db = await getDatabase();
  const existing = await db.getFirstAsync<WorldInfoRow>("SELECT * FROM world_info WHERE project_id = ?", projectId);
  if (existing) return mapWorldInfo(existing);
  const id = createId();
  const now = new Date().toISOString();
  await db.runAsync(
    "INSERT INTO world_info(id, project_id, name, description, created_at, updated_at) VALUES (?, ?, ?, '', ?, ?)",
    id,
    projectId,
    "世界书",
    now,
    now,
  );
  return { id, projectId, name: "世界书", description: "", createdAt: now, updatedAt: now };
}

export async function saveWorldInfo(input: {
  id: string;
  projectId: string;
  name: string;
  description?: string;
}): Promise<WorldInfo> {
  const db = await getDatabase();
  const existing = await db.getFirstAsync<WorldInfoRow>("SELECT * FROM world_info WHERE id = ? AND project_id = ?", input.id, input.projectId);
  if (!existing) throw new Error("世界书不存在");
  const name = requiredText(input.name, "世界书名称");
  const description = input.description?.trim() ?? "";
  const now = new Date().toISOString();
  await db.runAsync(
    "UPDATE world_info SET name = ?, description = ?, updated_at = ? WHERE id = ? AND project_id = ?",
    name,
    description,
    now,
    input.id,
    input.projectId,
  );
  return { id: input.id, projectId: input.projectId, name, description, createdAt: existing.created_at, updatedAt: now };
}

export async function listWorldInfoEntries(worldInfoId: string): Promise<WorldInfoEntry[]> {
  const db = await getDatabase();
  return (await db.getAllAsync<WorldInfoEntryRow>(
    "SELECT * FROM world_info_entries WHERE world_info_id = ? ORDER BY entry_order, uid",
    worldInfoId,
  )).map(mapWorldInfoEntry);
}

export async function getWorldInfoEntry(id: string): Promise<WorldInfoEntry | null> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<WorldInfoEntryRow>("SELECT * FROM world_info_entries WHERE id = ?", id);
  return row ? mapWorldInfoEntry(row) : null;
}

export async function saveWorldInfoEntry(input: {
  id?: string;
  worldInfoId: string;
  name: string;
  content?: string;
  isEnabled?: boolean;
}): Promise<WorldInfoEntry> {
  const db = await getDatabase();
  const id = input.id ?? createId();
  const name = requiredText(input.name, "世界书条目名称");
  const content = input.content?.trim() ?? "";
  validateChapterContent(content);
  const now = new Date().toISOString();
  const existing = await db.getFirstAsync<WorldInfoEntryRow>("SELECT * FROM world_info_entries WHERE id = ?", id);
  let uid = existing?.uid;
  let order = existing?.entry_order;
  if (uid === undefined || order === undefined) {
    const next = await db.getFirstAsync<{ next_uid: number }>(
      "SELECT COALESCE(MAX(uid), 0) + 1 AS next_uid FROM world_info_entries WHERE world_info_id = ?",
      input.worldInfoId,
    );
    uid = next?.next_uid ?? 1;
    order = uid;
  }
  await db.runAsync(`
    INSERT INTO world_info_entries(id, world_info_id, uid, name, entry_order, content, token_count, is_enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, content = excluded.content,
      token_count = excluded.token_count, is_enabled = excluded.is_enabled, updated_at = excluded.updated_at
  `, id, input.worldInfoId, uid, name, order, content, content.length, input.isEnabled === false ? 0 : 1, existing?.created_at ?? now, now);
  return {
    id,
    worldInfoId: input.worldInfoId,
    uid,
    name,
    order,
    content,
    tokenCount: content.length,
    isEnabled: input.isEnabled !== false,
    createdAt: existing?.created_at ?? now,
    updatedAt: now,
  };
}

export async function deleteWorldInfoEntry(id: string): Promise<void> {
  const db = await getDatabase();
  const now = new Date().toISOString();
  await db.withExclusiveTransactionAsync(async (txn) => {
    const entry = await txn.getFirstAsync<WorldInfoEntryRow & { project_id: string }>(`
      SELECT entry.*, world.project_id
      FROM world_info_entries entry
      JOIN world_info world ON world.id = entry.world_info_id
      WHERE entry.id = ?
    `, id);
    if (!entry) throw new Error("世界书条目不存在");
    await txn.runAsync(
      "DELETE FROM vector_chunks WHERE project_id = ? AND source_type = 'world-entry' AND source_id = ?",
      entry.project_id,
      id,
    );
    await txn.runAsync("DELETE FROM world_info_entries WHERE id = ?", id);
    await txn.runAsync("UPDATE world_info SET updated_at = ? WHERE id = ?", now, entry.world_info_id);
    await txn.runAsync("UPDATE projects SET updated_at = ? WHERE id = ?", now, entry.project_id);
  });
}
