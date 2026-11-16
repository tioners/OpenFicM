import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";

import { createProjectFromImport } from "@/data/repositories";
import { splitBook } from "@/lib/book-split";
import { decodeText } from "@/style/source-library";
import type { Project } from "@/types";

const MAX_BOOK_BYTES = 50 * 1024 * 1024;

export interface BookImportResult {
  project: Project;
  chapterCount: number;
  volumeCount: number;
  /** 没识别到章节标题，只是按长度切开的。 */
  splitByLength: boolean;
}

/**
 * 选择一个 TXT / Markdown 文件，按"第X卷 / 第X章"拆分后作为新作品导入。
 * 不改动任何现有作品。功能由社区补丁提出（作者"打包一份凉皮"）。
 */
export async function importBookFile(): Promise<BookImportResult | null> {
  const picked = await DocumentPicker.getDocumentAsync({ type: "*/*", copyToCacheDirectory: true, multiple: false });
  if (picked.canceled) return null;
  const asset = picked.assets[0];
  const extension = (/\.([^.]+)$/.exec(asset.name.trim())?.[1] ?? "").toLowerCase();
  if (!["txt", "md", "markdown"].includes(extension)) throw new Error("仅支持 TXT 或 Markdown 文件");
  const inputFile = new File(asset.uri);
  const sizeBytes = asset.size ?? inputFile.size;
  if (!sizeBytes) throw new Error("文件是空的");
  if (sizeBytes > MAX_BOOK_BYTES) throw new Error("文件超过 50 MB，请拆分后再导入");

  const text = decodeText(await inputFile.bytes());
  if (!text.trim()) throw new Error("文件里没有可导入的正文");
  const book = splitBook(text, { markdown: extension !== "txt" });
  if (!book.chapterCount) throw new Error("没有从文件里解析出正文");

  const title = asset.name.replace(/\.[^.]+$/, "").trim() || "导入的书";
  const { project, chapterCount } = await createProjectFromImport({
    title,
    description: `由 ${asset.name} 导入`,
    volumes: book.volumes,
  });
  return {
    project,
    chapterCount,
    volumeCount: book.volumes.length,
    splitByLength: book.detectedHeadings === 0,
  };
}
