import { getDatabase } from "@/data/database";
import {
  getOrCreateWorldInfo,
  listChapters,
  listCharacters,
  listWorldInfoEntries,
} from "@/data/repositories";
import { createId } from "@/lib/id";
import { getIndexSettings, type IndexSettings } from "@/settings/config";
import type { IndexSourceType, LocalSearchResult } from "@/types";

import { embedPassage, embedQuery, rerankDocuments } from "./local-models";

type IndexSource = {
  type: IndexSourceType;
  id: string;
  title: string;
  content: string;
  updatedAt: string;
};

type IndexedSourceRow = {
  source_id: string;
  source_updated_at: string;
};

type VectorChunkRow = {
  id: string;
  source_type: IndexSourceType;
  source_id: string;
  title: string;
  content: string;
  embedding: Uint8Array;
};

export interface IndexProgress {
  completed: number;
  total: number;
  title: string;
}

export interface IndexSummary {
  sourceCount: number;
  indexedSources: number;
  chunkCount: number;
}

function splitIntoChunks(text: string, size: number, overlap: number): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  const chunks: string[] = [];
  const step = Math.max(1, size - overlap);
  for (let start = 0; start < normalized.length; start += step) {
    const chunk = normalized.slice(start, start + size).trim();
    if (chunk) chunks.push(chunk);
    if (start + size >= normalized.length) break;
  }
  return chunks;
}

function vectorToBlob(vector: number[]): Uint8Array {
  const values = new Float32Array(vector);
  return new Uint8Array(values.buffer);
}

function blobToVector(blob: Uint8Array): Float32Array {
  const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  const copy = bytes.slice();
  return new Float32Array(copy.buffer);
}

function cosineSimilarity(query: number[], candidate: Float32Array): number {
  if (query.length !== candidate.length || query.length === 0) return -1;
  let dot = 0;
  let queryNorm = 0;
  let candidateNorm = 0;
  for (let index = 0; index < query.length; index += 1) {
    dot += query[index] * candidate[index];
    queryNorm += query[index] * query[index];
    candidateNorm += candidate[index] * candidate[index];
  }
  const denominator = Math.sqrt(queryNorm) * Math.sqrt(candidateNorm);
  return denominator > 0 ? dot / denominator : -1;
}

async function listIndexSources(projectId: string): Promise<IndexSource[]> {
  const [chapters, characters, worldInfo] = await Promise.all([
    listChapters(projectId),
    listCharacters(projectId),
    getOrCreateWorldInfo(projectId),
  ]);
  const worldEntries = await listWorldInfoEntries(worldInfo.id);
  return [
    ...chapters.map((chapter): IndexSource => ({
      type: "chapter",
      id: chapter.id,
      title: chapter.title,
      content: chapter.content,
      updatedAt: chapter.updatedAt,
    })),
    ...characters.map((character): IndexSource => ({
      type: "character",
      id: character.id,
      title: character.name,
      content: character.description,
      updatedAt: character.updatedAt,
    })),
    ...worldEntries.filter((entry) => entry.isEnabled).map((entry): IndexSource => ({
      type: "world-entry",
      id: entry.id,
      title: entry.name,
      content: entry.content,
      updatedAt: entry.updatedAt,
    })),
  ].filter((source) => source.content.trim().length > 0);
}

async function replaceSourceChunks(
  projectId: string,
  source: IndexSource,
  settings: IndexSettings,
): Promise<number> {
  const db = await getDatabase();
  const texts = splitIntoChunks(source.content, settings.chunkSize, settings.chunkOverlap);
  const chunks: Array<{ index: number; text: string; embedding: Uint8Array }> = [];
  for (let index = 0; index < texts.length; index += 1) {
    const text = texts[index];
    const embedding = await embedPassage(`${source.title}\n${text}`);
    chunks.push({ index, text, embedding: vectorToBlob(embedding) });
  }
  await db.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.runAsync(
      "DELETE FROM vector_chunks WHERE project_id = ? AND source_id = ?",
      projectId,
      source.id,
    );
    for (const chunk of chunks) {
      await transaction.runAsync(`
        INSERT INTO vector_chunks(
          id, project_id, source_type, source_id, chunk_index, title, content, embedding, source_updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, createId(), projectId, source.type, source.id, chunk.index, source.title, chunk.text, chunk.embedding, source.updatedAt);
    }
  });
  return chunks.length;
}

export async function indexProject(
  projectId: string,
  options: {
    force?: boolean;
    onProgress?: (progress: IndexProgress) => void;
  } = {},
): Promise<IndexSummary> {
  const settings = await getIndexSettings();
  if (!settings.enabled) throw new Error("本地索引已关闭");
  const db = await getDatabase();
  const sources = await listIndexSources(projectId);
  const currentSourceIds = new Set(sources.map((source) => source.id));
  const indexedRows = await db.getAllAsync<IndexedSourceRow>(`
    SELECT source_id, MAX(source_updated_at) AS source_updated_at
    FROM vector_chunks WHERE project_id = ? GROUP BY source_id
  `, projectId);
  const indexedBySource = new Map(indexedRows.map((row) => [row.source_id, row.source_updated_at]));
  const removedIds = indexedRows.filter((row) => !currentSourceIds.has(row.source_id)).map((row) => row.source_id);
  for (const sourceId of removedIds) {
    await db.runAsync("DELETE FROM vector_chunks WHERE project_id = ? AND source_id = ?", projectId, sourceId);
  }
  const changed = sources.filter((source) => options.force || indexedBySource.get(source.id) !== source.updatedAt);
  let chunkCount = 0;
  for (let index = 0; index < changed.length; index += 1) {
    const source = changed[index];
    options.onProgress?.({ completed: index, total: changed.length, title: source.title });
    chunkCount += await replaceSourceChunks(projectId, source, settings);
    options.onProgress?.({ completed: index + 1, total: changed.length, title: source.title });
  }
  const count = await db.getFirstAsync<{ total: number }>(
    "SELECT COUNT(*) AS total FROM vector_chunks WHERE project_id = ?",
    projectId,
  );
  return {
    sourceCount: sources.length,
    indexedSources: changed.length,
    chunkCount: count?.total ?? chunkCount,
  };
}

export async function getProjectIndexStats(projectId: string): Promise<{
  sources: number;
  chunks: number;
}> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<{ sources: number; chunks: number }>(`
    SELECT COUNT(DISTINCT source_id) AS sources, COUNT(*) AS chunks
    FROM vector_chunks WHERE project_id = ?
  `, projectId);
  return { sources: row?.sources ?? 0, chunks: row?.chunks ?? 0 };
}

export async function clearProjectIndex(projectId: string): Promise<void> {
  const db = await getDatabase();
  await db.runAsync("DELETE FROM vector_chunks WHERE project_id = ?", projectId);
}

export async function searchProjectKnowledge(
  projectId: string,
  query: string,
): Promise<LocalSearchResult[]> {
  const normalized = query.trim();
  if (!normalized) return [];
  const settings = await getIndexSettings();
  if (!settings.enabled) return [];
  await indexProject(projectId);
  const db = await getDatabase();
  const rows = await db.getAllAsync<VectorChunkRow>(`
    SELECT id, source_type, source_id, title, content, embedding
    FROM vector_chunks WHERE project_id = ?
  `, projectId);
  if (!rows.length) return [];
  const queryVector = await embedQuery(normalized);
  const candidateLimit = Math.min(rows.length, Math.max(settings.retrievalTopK * 4, 20));
  const candidates = rows
    .map((row) => ({
      id: row.id,
      sourceType: row.source_type,
      sourceId: row.source_id,
      title: row.title,
      content: row.content,
      score: cosineSimilarity(queryVector, blobToVector(row.embedding)),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, candidateLimit);
  if (!settings.rerankEnabled || candidates.length < 2) {
    return candidates.slice(0, settings.retrievalTopK);
  }
  const reranked = await rerankDocuments(
    normalized,
    candidates.map((candidate) => `${candidate.title}\n${candidate.content}`),
  );
  return reranked.slice(0, settings.rerankTopK).map((result) => ({
    ...candidates[result.index],
    rerankScore: result.score,
  }));
}
