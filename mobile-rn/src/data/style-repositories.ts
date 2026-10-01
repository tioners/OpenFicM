import { createId } from "@/lib/id";
import type {
  StyleProfile,
  StyleProfileKind,
  StyleSource,
  StyleSourceFormat,
} from "@/types";

import { getDatabase } from "./database";

const MAX_STYLE_GUIDE_CHARACTERS = 100_000;
const ACTIVE_STYLE_KEY_PREFIX = "style.activeProfile.";
const NO_STYLE_PROFILE_VALUE = "__none__";

export interface ActiveStyleSelection {
  configured: boolean;
  profile: StyleProfile | null;
}

type StyleSourceRow = {
  id: string;
  title: string;
  file_name: string;
  format: StyleSourceFormat;
  file_uri: string;
  size_bytes: number;
  content_hash: string;
  character_count: number;
  created_at: string;
  updated_at: string;
};

type StyleProfileRow = {
  id: string;
  series_id: string;
  project_id: string | null;
  source_id: string | null;
  kind: StyleProfileKind;
  name: string;
  version: number;
  guide: string;
  created_at: string;
  updated_at: string;
};

const mapStyleSource = (row: StyleSourceRow): StyleSource => ({
  id: row.id,
  title: row.title,
  fileName: row.file_name,
  format: row.format,
  fileUri: row.file_uri,
  sizeBytes: row.size_bytes,
  contentHash: row.content_hash,
  characterCount: row.character_count,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapStyleProfile = (row: StyleProfileRow): StyleProfile => ({
  id: row.id,
  seriesId: row.series_id,
  projectId: row.project_id,
  sourceId: row.source_id,
  kind: row.kind,
  name: row.name,
  version: row.version,
  guide: row.guide,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label}不能为空`);
  return normalized;
}

export async function listStyleSources(): Promise<StyleSource[]> {
  const database = await getDatabase();
  return (await database.getAllAsync<StyleSourceRow>(
    "SELECT * FROM style_sources ORDER BY updated_at DESC, created_at DESC",
  )).map(mapStyleSource);
}

export async function getStyleSource(id: string): Promise<StyleSource | null> {
  const database = await getDatabase();
  const row = await database.getFirstAsync<StyleSourceRow>("SELECT * FROM style_sources WHERE id = ?", id);
  return row ? mapStyleSource(row) : null;
}

export async function findStyleSourceByHash(contentHash: string): Promise<StyleSource | null> {
  const database = await getDatabase();
  const row = await database.getFirstAsync<StyleSourceRow>(
    "SELECT * FROM style_sources WHERE content_hash = ?",
    contentHash,
  );
  return row ? mapStyleSource(row) : null;
}

export async function createStyleSource(input: {
  id: string;
  title: string;
  fileName: string;
  format: StyleSourceFormat;
  fileUri: string;
  sizeBytes: number;
  contentHash: string;
  characterCount: number;
}): Promise<StyleSource> {
  const database = await getDatabase();
  const now = new Date().toISOString();
  const title = requiredText(input.title, "书名").slice(0, 200);
  const fileName = requiredText(input.fileName, "文件名").slice(0, 500);
  if (!["txt", "markdown", "epub"].includes(input.format)) throw new Error("不支持的书籍格式");
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1) throw new Error("书籍文件大小无效");
  if (!Number.isSafeInteger(input.characterCount) || input.characterCount < 1) throw new Error("书籍正文为空");
  await database.runAsync(
    `INSERT INTO style_sources(
      id, title, file_name, format, file_uri, size_bytes, content_hash, character_count, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.id,
    title,
    fileName,
    input.format,
    input.fileUri,
    input.sizeBytes,
    requiredText(input.contentHash, "文件摘要"),
    input.characterCount,
    now,
    now,
  );
  return {
    id: input.id,
    title,
    fileName,
    format: input.format,
    fileUri: input.fileUri,
    sizeBytes: input.sizeBytes,
    contentHash: input.contentHash,
    characterCount: input.characterCount,
    createdAt: now,
    updatedAt: now,
  };
}

export async function renameStyleSource(id: string, title: string): Promise<StyleSource> {
  const database = await getDatabase();
  const existing = await database.getFirstAsync<StyleSourceRow>("SELECT * FROM style_sources WHERE id = ?", id);
  if (!existing) throw new Error("参考书不存在");
  const normalizedTitle = requiredText(title, "书名").slice(0, 200);
  const updatedAt = new Date().toISOString();
  await database.runAsync(
    "UPDATE style_sources SET title = ?, updated_at = ? WHERE id = ?",
    normalizedTitle,
    updatedAt,
    id,
  );
  return mapStyleSource({ ...existing, title: normalizedTitle, updated_at: updatedAt });
}

export async function deleteStyleSourceRecord(id: string): Promise<void> {
  const database = await getDatabase();
  await database.withExclusiveTransactionAsync(async (transaction) => {
    // 独占事务跑在 expo-sqlite 新开的连接上，那里的 PRAGMA foreign_keys 默认关闭，
    // ON DELETE CASCADE / SET NULL 都不会触发——曾经因此留下过孤儿参考文风（选择器里显示"参考书已删除"）。
    // 这里显式删除该参考书下的文风，并清掉引用它的活跃选择与章节草稿。
    const profiles = await transaction.getAllAsync<{ id: string }>(
      "SELECT id FROM style_profiles WHERE source_id = ?",
      id,
    );
    const profileIds = profiles.map((profile) => profile.id);
    if (profileIds.length) {
      const placeholders = profileIds.map(() => "?").join(", ");
      await transaction.runAsync(
        `UPDATE chapter_drafts SET style_profile_id = NULL WHERE style_profile_id IN (${placeholders})`,
        ...profileIds,
      );
      await transaction.runAsync(
        `DELETE FROM app_settings WHERE key LIKE ? AND value IN (${placeholders})`,
        `${ACTIVE_STYLE_KEY_PREFIX}%`,
        ...profileIds,
      );
      await transaction.runAsync(
        `DELETE FROM style_profiles WHERE id IN (${placeholders})`,
        ...profileIds,
      );
    }
    await transaction.runAsync("DELETE FROM style_sources WHERE id = ?", id);
  });
}

export async function listStyleProfiles(projectId: string): Promise<StyleProfile[]> {
  const database = await getDatabase();
  return (await database.getAllAsync<StyleProfileRow>(
    `SELECT * FROM style_profiles
     WHERE kind = 'reference' OR (kind = 'author' AND project_id = ?)
     ORDER BY CASE kind WHEN 'author' THEN 0 ELSE 1 END, updated_at DESC, version DESC`,
    projectId,
  )).map(mapStyleProfile);
}

export async function listStyleProfilesForSource(sourceId: string): Promise<StyleProfile[]> {
  const database = await getDatabase();
  return (await database.getAllAsync<StyleProfileRow>(
    "SELECT * FROM style_profiles WHERE source_id = ? ORDER BY version DESC",
    sourceId,
  )).map(mapStyleProfile);
}

export async function getStyleProfile(id: string): Promise<StyleProfile | null> {
  const database = await getDatabase();
  const row = await database.getFirstAsync<StyleProfileRow>("SELECT * FROM style_profiles WHERE id = ?", id);
  return row ? mapStyleProfile(row) : null;
}

export async function getLatestAuthorStyleProfile(projectId: string): Promise<StyleProfile | null> {
  const database = await getDatabase();
  const row = await database.getFirstAsync<StyleProfileRow>(
    `SELECT * FROM style_profiles
     WHERE kind = 'author' AND project_id = ?
     ORDER BY version DESC, updated_at DESC LIMIT 1`,
    projectId,
  );
  return row ? mapStyleProfile(row) : null;
}

function boundedGuide(value: string): string {
  const guide = requiredText(value, "文风指南");
  if (guide.length > MAX_STYLE_GUIDE_CHARACTERS) {
    throw new Error(`文风指南超过 ${MAX_STYLE_GUIDE_CHARACTERS} 字符限制`);
  }
  return guide;
}

/**
 * 作者文风按作品累积多个版本：每次对比 AI 原稿与作者定稿都保留历史，便于回看演进。
 * 参考文风不走这里——每本参考书只有一份，见 saveReferenceStyleProfile。
 */
export async function createAuthorStyleProfileVersion(input: {
  projectId: string;
  name: string;
  guide: string;
  activateForProjectId?: string | null;
}): Promise<StyleProfile> {
  const database = await getDatabase();
  const guide = boundedGuide(input.guide);
  const projectId = requiredText(input.projectId, "作品").trim();
  const seriesId = `author-${projectId}`;
  const name = requiredText(input.name, "文风名称").slice(0, 200);
  const now = new Date().toISOString();
  let profile: StyleProfile | null = null;
  await database.withExclusiveTransactionAsync(async (transaction) => {
    const project = await transaction.getFirstAsync<{ id: string }>("SELECT id FROM projects WHERE id = ?", projectId);
    if (!project) throw new Error("作品不存在");
    const latest = await transaction.getFirstAsync<StyleProfileRow>(
      "SELECT * FROM style_profiles WHERE series_id = ? ORDER BY version DESC LIMIT 1",
      seriesId,
    );
    if (latest?.guide.trim() === guide) {
      profile = mapStyleProfile(latest);
    } else {
      const id = createId();
      const version = (latest?.version ?? 0) + 1;
      await transaction.runAsync(
        `INSERT INTO style_profiles(
          id, series_id, project_id, source_id, kind, name, version, guide, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        seriesId,
        projectId,
        null,
        "author",
        name,
        version,
        guide,
        now,
        now,
      );
      profile = {
        id,
        seriesId,
        projectId,
        sourceId: null,
        kind: "author",
        name,
        version,
        guide,
        createdAt: now,
        updatedAt: now,
      };
    }
    const activateProjectId = input.activateForProjectId?.trim() || null;
    if (activateProjectId && profile) {
      if (profile.projectId !== activateProjectId) throw new Error("该作者文风不属于当前作品");
      await transaction.runAsync(
        `INSERT INTO app_settings(key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        `${ACTIVE_STYLE_KEY_PREFIX}${activateProjectId}`,
        profile.id,
      );
    }
  });
  if (!profile) throw new Error("文风版本保存失败");
  return profile;
}

/**
 * 保存参考文风：每本参考书只保留一份，反复蒸馏就地改写它，不再累积 V2/V3。
 * 历史遗留的多版本在这里合并到最新一份（最新的指南已经包含前几轮的结论），
 * 指向被删版本的活跃选择一并改指保留的那份，避免作品静默退回"不使用文风"。
 */
export async function saveReferenceStyleProfile(input: {
  sourceId: string;
  name: string;
  guide: string;
}): Promise<StyleProfile> {
  const database = await getDatabase();
  const guide = boundedGuide(input.guide);
  const sourceId = requiredText(input.sourceId, "参考书").trim();
  const seriesId = `reference-${sourceId}`;
  const name = requiredText(input.name, "文风名称").slice(0, 200);
  const now = new Date().toISOString();
  let profile: StyleProfile | null = null;
  await database.withExclusiveTransactionAsync(async (transaction) => {
    const source = await transaction.getFirstAsync<{ id: string }>("SELECT id FROM style_sources WHERE id = ?", sourceId);
    if (!source) throw new Error("参考书不存在");
    const existing = await transaction.getAllAsync<StyleProfileRow>(
      "SELECT * FROM style_profiles WHERE series_id = ? ORDER BY version DESC",
      seriesId,
    );
    const kept = existing[0];
    if (!kept) {
      const id = createId();
      await transaction.runAsync(
        `INSERT INTO style_profiles(
          id, series_id, project_id, source_id, kind, name, version, guide, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        seriesId,
        null,
        sourceId,
        "reference",
        name,
        1,
        guide,
        now,
        now,
      );
      profile = {
        id,
        seriesId,
        projectId: null,
        sourceId,
        kind: "reference",
        name,
        version: 1,
        guide,
        createdAt: now,
        updatedAt: now,
      };
      return;
    }
    const stale = existing.slice(1);
    if (stale.length) {
      const placeholders = stale.map(() => "?").join(", ");
      const staleIds = stale.map((row) => row.id);
      // 合并前先把指向旧版本的引用改到保留的那份：作品的活跃选择不能静默退回"不使用文风"，
      // 章节草稿记录的"当时用了哪份文风"也应该继续指向同一本书的文风。
      await transaction.runAsync(
        `UPDATE app_settings SET value = ? WHERE key LIKE ? AND value IN (${placeholders})`,
        kept.id,
        `${ACTIVE_STYLE_KEY_PREFIX}%`,
        ...staleIds,
      );
      await transaction.runAsync(
        `UPDATE chapter_drafts SET style_profile_id = ? WHERE style_profile_id IN (${placeholders})`,
        kept.id,
        ...staleIds,
      );
      await transaction.runAsync(
        `DELETE FROM style_profiles WHERE id IN (${placeholders})`,
        ...staleIds,
      );
    }
    // 版本号归一为 1：只剩一份文件时 V 号没有意义，也让 UNIQUE(series_id, version) 保持可插入。
    await transaction.runAsync(
      "UPDATE style_profiles SET name = ?, guide = ?, version = 1, updated_at = ? WHERE id = ?",
      name,
      guide,
      now,
      kept.id,
    );
    profile = { ...mapStyleProfile(kept), name, guide, version: 1, updatedAt: now };
  });
  if (!profile) throw new Error("参考文风保存失败");
  return profile;
}

export async function deleteStyleProfile(id: string): Promise<void> {
  const database = await getDatabase();
  await database.withExclusiveTransactionAsync(async (transaction) => {
    const profile = await transaction.getFirstAsync<{ id: string }>("SELECT id FROM style_profiles WHERE id = ?", id);
    if (!profile) throw new Error("文风版本不存在");
    // 独占事务里外键不生效，chapter_drafts.style_profile_id 的 SET NULL 要自己写。
    await transaction.runAsync("UPDATE chapter_drafts SET style_profile_id = NULL WHERE style_profile_id = ?", id);
    await transaction.runAsync(
      "DELETE FROM app_settings WHERE key LIKE ? AND value = ?",
      `${ACTIVE_STYLE_KEY_PREFIX}%`,
      id,
    );
    await transaction.runAsync("DELETE FROM style_profiles WHERE id = ?", id);
  });
}

export async function getActiveStyleProfile(projectId: string): Promise<StyleProfile | null> {
  return (await getActiveStyleSelection(projectId)).profile;
}

export async function getActiveStyleSelection(projectId: string): Promise<ActiveStyleSelection> {
  const database = await getDatabase();
  const key = `${ACTIVE_STYLE_KEY_PREFIX}${projectId}`;
  const setting = await database.getFirstAsync<{ value: string }>("SELECT value FROM app_settings WHERE key = ?", key);
  if (!setting?.value) return { configured: false, profile: null };
  if (setting.value === NO_STYLE_PROFILE_VALUE) return { configured: true, profile: null };
  const row = await database.getFirstAsync<StyleProfileRow>(
    `SELECT * FROM style_profiles
     WHERE id = ? AND (kind = 'reference' OR project_id = ?)`,
    setting.value,
    projectId,
  );
  if (row) return { configured: true, profile: mapStyleProfile(row) };
  await database.runAsync("DELETE FROM app_settings WHERE key = ?", key);
  return { configured: false, profile: null };
}

export async function setActiveStyleProfile(projectId: string, profileId: string | null): Promise<void> {
  const database = await getDatabase();
  const key = `${ACTIVE_STYLE_KEY_PREFIX}${projectId}`;
  if (!profileId) {
    await database.runAsync(
      `INSERT INTO app_settings(key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      NO_STYLE_PROFILE_VALUE,
    );
    return;
  }
  const profile = await database.getFirstAsync<StyleProfileRow>(
    `SELECT * FROM style_profiles
     WHERE id = ? AND (kind = 'reference' OR project_id = ?)`,
    profileId,
    projectId,
  );
  if (!profile) throw new Error("文风不存在或不属于当前作品");
  await database.runAsync(
    `INSERT INTO app_settings(key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    key,
    profileId,
  );
}
