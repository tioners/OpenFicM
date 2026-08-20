import { createId } from "@/lib/id";
import type { ChapterDraftSnapshot, ChapterDraftStatus } from "@/types";

import { getDatabase } from "./database";

type ChapterDraftRow = {
  id: string;
  project_id: string;
  chapter_id: string;
  style_profile_id: string | null;
  ai_draft: string;
  author_revision: string | null;
  status: ChapterDraftStatus;
  created_at: string;
  updated_at: string;
};

const mapChapterDraft = (row: ChapterDraftRow): ChapterDraftSnapshot => ({
  id: row.id,
  projectId: row.project_id,
  chapterId: row.chapter_id,
  styleProfileId: row.style_profile_id,
  aiDraft: row.ai_draft,
  authorRevision: row.author_revision,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export async function createChapterDraftSnapshot(input: {
  projectId: string;
  chapterId: string;
  styleProfileId: string | null;
  aiDraft: string;
}): Promise<ChapterDraftSnapshot> {
  const aiDraft = input.aiDraft;
  if (!aiDraft.trim()) throw new Error("AI 原稿不能为空");
  const database = await getDatabase();
  const chapter = await database.getFirstAsync<{ id: string }>(
    "SELECT id FROM chapters WHERE id = ? AND project_id = ?",
    input.chapterId,
    input.projectId,
  );
  if (!chapter) throw new Error("章节不存在");
  const now = new Date().toISOString();
  const snapshot: ChapterDraftSnapshot = {
    id: createId(),
    projectId: input.projectId,
    chapterId: input.chapterId,
    styleProfileId: input.styleProfileId,
    aiDraft,
    authorRevision: null,
    status: "generated",
    createdAt: now,
    updatedAt: now,
  };
  await database.runAsync(
    `INSERT INTO chapter_drafts(
      id, project_id, chapter_id, style_profile_id, ai_draft, author_revision, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, NULL, 'generated', ?, ?)`,
    snapshot.id,
    snapshot.projectId,
    snapshot.chapterId,
    snapshot.styleProfileId,
    snapshot.aiDraft,
    snapshot.createdAt,
    snapshot.updatedAt,
  );
  return snapshot;
}

export async function recordLatestAuthorRevision(
  chapterId: string,
  content: string,
): Promise<ChapterDraftSnapshot | null> {
  const database = await getDatabase();
  const latest = await database.getFirstAsync<ChapterDraftRow>(
    `SELECT * FROM chapter_drafts
     WHERE chapter_id = ?
     ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    chapterId,
  );
  if (!latest) return null;
  if (content === latest.ai_draft) {
    if (latest.status !== "revised") return mapChapterDraft(latest);
    const updatedAt = new Date().toISOString();
    await database.runAsync(
      "UPDATE chapter_drafts SET author_revision = NULL, status = 'generated', updated_at = ? WHERE id = ?",
      updatedAt,
      latest.id,
    );
    return mapChapterDraft({
      ...latest,
      author_revision: null,
      status: "generated",
      updated_at: updatedAt,
    });
  }
  if (content === latest.author_revision) return mapChapterDraft(latest);
  const updatedAt = new Date().toISOString();
  await database.runAsync(
    "UPDATE chapter_drafts SET author_revision = ?, status = 'revised', updated_at = ? WHERE id = ?",
    content,
    updatedAt,
    latest.id,
  );
  return mapChapterDraft({
    ...latest,
    author_revision: content,
    status: "revised",
    updated_at: updatedAt,
  });
}

export async function getPendingChapterStyleEvolution(
  chapterId: string,
): Promise<ChapterDraftSnapshot | null> {
  const database = await getDatabase();
  const row = await database.getFirstAsync<ChapterDraftRow>(
    `SELECT * FROM chapter_drafts
     WHERE id = (
       SELECT id FROM chapter_drafts
       WHERE chapter_id = ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1
     ) AND status = 'revised'
       AND author_revision IS NOT NULL
       AND author_revision <> ai_draft`,
    chapterId,
  );
  return row ? mapChapterDraft(row) : null;
}

export async function markChapterStyleEvolved(id: string): Promise<void> {
  const database = await getDatabase();
  const result = await database.runAsync(
    "UPDATE chapter_drafts SET status = 'evolved', updated_at = ? WHERE id = ? AND status = 'revised'",
    new Date().toISOString(),
    id,
  );
  if (result.changes !== 1) throw new Error("待进化的章节原稿不存在");
}
