import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";

import type { Chapter, Project, Volume } from "@/types";

export type ExportScope = "chapter" | "volume" | "book";

export interface ExportNovelInput {
  project: Project;
  volumes: Volume[];
  chapters: Chapter[];
  scope: ExportScope;
  chapterId?: string;
  volumeId?: string;
}

function safeFileName(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").trim().slice(0, 80) || "OpenFicM";
}

function renderChapter(chapter: Chapter): string {
  return `### ${chapter.title}\n\n${chapter.content.trim() || "（本章暂无正文）"}\n`;
}

export async function exportNovel(input: ExportNovelInput): Promise<void> {
  const orderedVolumes = [...input.volumes].sort((left, right) => left.orderIndex - right.orderIndex);
  const orderedChapters = [...input.chapters].sort((left, right) => left.orderIndex - right.orderIndex);
  let title = input.project.title;
  let markdown = `# ${input.project.title}\n\n`;

  if (input.project.description.trim()) markdown += `${input.project.description.trim()}\n\n`;

  if (input.scope === "chapter") {
    const chapter = orderedChapters.find((item) => item.id === input.chapterId);
    if (!chapter) throw new Error("当前章节不存在，无法导出");
    title = chapter.title;
    markdown += renderChapter(chapter);
  } else {
    const volumes = input.scope === "volume"
      ? orderedVolumes.filter((volume) => volume.id === input.volumeId)
      : orderedVolumes;
    if (!volumes.length) throw new Error(input.scope === "volume" ? "当前卷不存在，无法导出" : "作品没有可导出的卷");
    if (input.scope === "volume") title = volumes[0].title;
    for (const volume of volumes) {
      markdown += `## ${volume.title}\n\n`;
      const volumeChapters = orderedChapters.filter((chapter) => chapter.volumeId === volume.id);
      markdown += volumeChapters.length
        ? volumeChapters.map(renderChapter).join("\n")
        : "（本卷暂无章节）\n\n";
    }
  }

  const scopeLabel = input.scope === "chapter" ? "章节" : input.scope === "volume" ? "卷" : "全书";
  const timestamp = new Date().toISOString().replace(/[.:]/g, "-");
  const file = new File(Paths.cache, `${safeFileName(input.project.title)}-${safeFileName(title)}-${scopeLabel}-${timestamp}.md`);
  if (file.exists) file.delete();
  file.write(markdown);
  if (!(await Sharing.isAvailableAsync())) throw new Error("当前设备不支持系统分享，请稍后重试");
  await Sharing.shareAsync(file.uri, {
    mimeType: "text/markdown",
    dialogTitle: `导出${scopeLabel}`,
  });
}