import { createId } from "@/lib/id";
import type { Note, NoteScope } from "@/types";

import { getDatabase } from "./database";

const MAX_NOTE_TITLE_CHARACTERS = 200;
const MAX_NOTE_CONTENT_CHARACTERS = 100_000;

type NoteRow = {
  id: string;
  project_id: string;
  volume_id: string | null;
  chapter_id: string | null;
  title: string;
  content: string;
  order_index: number;
  created_at: string;
  updated_at: string;
};

const mapNote = (row: NoteRow): Note => ({
  id: row.id,
  projectId: row.project_id,
  volumeId: row.volume_id,
  chapterId: row.chapter_id,
  title: row.title,
  content: row.content,
  orderIndex: row.order_index,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export function noteScope(note: Pick<Note, "volumeId" | "chapterId">): NoteScope {
  if (note.chapterId) return "chapter";
  if (note.volumeId) return "volume";
  return "project";
}

function requiredText(value: string, label: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label}不能为空`);
  if (normalized.length > maximum) throw new Error(`${label}超过 ${maximum} 字符限制`);
  return normalized;
}

export interface NoteTarget {
  volumeId?: string | null;
  chapterId?: string | null;
}

/**
 * 归一化归属目标。章优先于卷；给了章就从章反查它所属的卷，
 * 避免出现"章属于卷 A、笔记却记着卷 B"这种不一致。
 */
async function resolveTarget(
  projectId: string,
  target: NoteTarget,
): Promise<{ volumeId: string | null; chapterId: string | null }> {
  const database = await getDatabase();
  const chapterId = target.chapterId?.trim() || null;
  if (chapterId) {
    const chapter = await database.getFirstAsync<{ volume_id: string; project_id: string }>(
      "SELECT volume_id, project_id FROM chapters WHERE id = ?",
      chapterId,
    );
    if (!chapter) throw new Error("章节不存在");
    if (chapter.project_id !== projectId) throw new Error("章节不属于当前作品");
    return { volumeId: chapter.volume_id, chapterId };
  }
  const volumeId = target.volumeId?.trim() || null;
  if (volumeId) {
    const volume = await database.getFirstAsync<{ project_id: string }>(
      "SELECT project_id FROM volumes WHERE id = ?",
      volumeId,
    );
    if (!volume) throw new Error("卷不存在");
    if (volume.project_id !== projectId) throw new Error("卷不属于当前作品");
    return { volumeId, chapterId: null };
  }
  return { volumeId: null, chapterId: null };
}

export async function listNotes(projectId: string): Promise<Note[]> {
  const database = await getDatabase();
  return (await database.getAllAsync<NoteRow>(
    `SELECT * FROM notes WHERE project_id = ?
     ORDER BY CASE WHEN chapter_id IS NOT NULL THEN 2 WHEN volume_id IS NOT NULL THEN 1 ELSE 0 END,
              order_index, created_at`,
    projectId,
  )).map(mapNote);
}

/** 取写作当前位置相关的三层笔记：整书 + 所在卷 + 该章。 */
export async function listNotesInScope(input: {
  projectId: string;
  volumeId?: string | null;
  chapterId?: string | null;
}): Promise<Note[]> {
  const database = await getDatabase();
  return (await database.getAllAsync<NoteRow>(
    `SELECT * FROM notes
     WHERE project_id = ?
       AND (
         (volume_id IS NULL AND chapter_id IS NULL)
         OR (chapter_id IS NULL AND volume_id IS NOT NULL AND volume_id = ?)
         OR (chapter_id IS NOT NULL AND chapter_id = ?)
       )
     ORDER BY CASE WHEN chapter_id IS NOT NULL THEN 2 WHEN volume_id IS NOT NULL THEN 1 ELSE 0 END,
              order_index, created_at`,
    input.projectId,
    input.volumeId ?? "",
    input.chapterId ?? "",
  )).map(mapNote);
}

export async function getNote(id: string): Promise<Note | null> {
  const database = await getDatabase();
  const row = await database.getFirstAsync<NoteRow>("SELECT * FROM notes WHERE id = ?", id);
  return row ? mapNote(row) : null;
}

export async function createNote(input: {
  projectId: string;
  title: string;
  content?: string;
  volumeId?: string | null;
  chapterId?: string | null;
}): Promise<Note> {
  const database = await getDatabase();
  const project = await database.getFirstAsync<{ id: string }>(
    "SELECT id FROM projects WHERE id = ?",
    input.projectId,
  );
  if (!project) throw new Error("作品不存在");
  const title = requiredText(input.title, "笔记标题", MAX_NOTE_TITLE_CHARACTERS);
  const content = (input.content ?? "").trim();
  if (content.length > MAX_NOTE_CONTENT_CHARACTERS) {
    throw new Error(`笔记内容超过 ${MAX_NOTE_CONTENT_CHARACTERS} 字符限制`);
  }
  const target = await resolveTarget(input.projectId, input);
  const id = createId();
  const now = new Date().toISOString();
  const next = await database.getFirstAsync<{ value: number }>(
    `SELECT COALESCE(MAX(order_index), -1) + 1 AS value FROM notes
     WHERE project_id = ? AND volume_id IS ? AND chapter_id IS ?`,
    input.projectId,
    target.volumeId,
    target.chapterId,
  );
  const orderIndex = next?.value ?? 0;
  await database.runAsync(
    `INSERT INTO notes(id, project_id, volume_id, chapter_id, title, content, order_index, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.projectId,
    target.volumeId,
    target.chapterId,
    title,
    content,
    orderIndex,
    now,
    now,
  );
  return {
    id,
    projectId: input.projectId,
    volumeId: target.volumeId,
    chapterId: target.chapterId,
    title,
    content,
    orderIndex,
    createdAt: now,
    updatedAt: now,
  };
}

export async function updateNote(input: {
  id: string;
  title?: string;
  content?: string;
}): Promise<Note> {
  const database = await getDatabase();
  const existing = await database.getFirstAsync<NoteRow>("SELECT * FROM notes WHERE id = ?", input.id);
  if (!existing) throw new Error("笔记不存在");
  const title = input.title === undefined
    ? existing.title
    : requiredText(input.title, "笔记标题", MAX_NOTE_TITLE_CHARACTERS);
  const content = input.content === undefined ? existing.content : input.content.trim();
  if (content.length > MAX_NOTE_CONTENT_CHARACTERS) {
    throw new Error(`笔记内容超过 ${MAX_NOTE_CONTENT_CHARACTERS} 字符限制`);
  }
  const updatedAt = new Date().toISOString();
  await database.runAsync(
    "UPDATE notes SET title = ?, content = ?, updated_at = ? WHERE id = ?",
    title,
    content,
    updatedAt,
    input.id,
  );
  return mapNote({ ...existing, title, content, updated_at: updatedAt });
}

export async function moveNote(id: string, target: NoteTarget): Promise<Note> {
  const database = await getDatabase();
  const existing = await database.getFirstAsync<NoteRow>("SELECT * FROM notes WHERE id = ?", id);
  if (!existing) throw new Error("笔记不存在");
  const resolved = await resolveTarget(existing.project_id, target);
  const updatedAt = new Date().toISOString();
  const next = await database.getFirstAsync<{ value: number }>(
    `SELECT COALESCE(MAX(order_index), -1) + 1 AS value FROM notes
     WHERE project_id = ? AND volume_id IS ? AND chapter_id IS ? AND id <> ?`,
    existing.project_id,
    resolved.volumeId,
    resolved.chapterId,
    id,
  );
  const orderIndex = next?.value ?? 0;
  await database.runAsync(
    "UPDATE notes SET volume_id = ?, chapter_id = ?, order_index = ?, updated_at = ? WHERE id = ?",
    resolved.volumeId,
    resolved.chapterId,
    orderIndex,
    updatedAt,
    id,
  );
  return mapNote({
    ...existing,
    volume_id: resolved.volumeId,
    chapter_id: resolved.chapterId,
    order_index: orderIndex,
    updated_at: updatedAt,
  });
}

export async function deleteNote(id: string): Promise<void> {
  const database = await getDatabase();
  await database.runAsync("DELETE FROM notes WHERE id = ?", id);
}

/** 删除章节或卷前用来提示用户有多少条笔记会受影响。 */
export async function countNotesUnder(input: {
  volumeId?: string | null;
  chapterId?: string | null;
}): Promise<number> {
  const database = await getDatabase();
  if (input.chapterId) {
    const row = await database.getFirstAsync<{ value: number }>(
      "SELECT COUNT(*) AS value FROM notes WHERE chapter_id = ?",
      input.chapterId,
    );
    return row?.value ?? 0;
  }
  if (input.volumeId) {
    const row = await database.getFirstAsync<{ value: number }>(
      `SELECT COUNT(*) AS value FROM notes
       WHERE volume_id = ? OR chapter_id IN (SELECT id FROM chapters WHERE volume_id = ?)`,
      input.volumeId,
      input.volumeId,
    );
    return row?.value ?? 0;
  }
  return 0;
}

/** 用户在删除确认框里选择"一并删除"时调用；不调用则外键 SET NULL 会让笔记上浮。 */
export async function deleteNotesUnder(input: {
  volumeId?: string | null;
  chapterId?: string | null;
}): Promise<void> {
  const database = await getDatabase();
  if (input.chapterId) {
    await database.runAsync("DELETE FROM notes WHERE chapter_id = ?", input.chapterId);
    return;
  }
  if (input.volumeId) {
    await database.runAsync(
      `DELETE FROM notes
       WHERE volume_id = ? OR chapter_id IN (SELECT id FROM chapters WHERE volume_id = ?)`,
      input.volumeId,
      input.volumeId,
    );
  }
}
