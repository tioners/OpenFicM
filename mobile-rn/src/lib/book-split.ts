/**
 * 把一本小说的纯文本拆成卷和章（书架"导入书籍"用）。
 * 最初的实现来自社区补丁（打包一份凉皮），这里补上了卷识别、标题前的序言、
 * 超长章节与超长段落的拆分，以及避免把正文句子误判成标题。
 *
 * 纯函数，不依赖 expo 或数据库，可转译后在 Node 里断言。
 */

export interface SplitChapter {
  title: string;
  content: string;
}

export interface SplitVolume {
  title: string;
  chapters: SplitChapter[];
}

export interface SplitBook {
  volumes: SplitVolume[];
  chapterCount: number;
  /** 识别到的章节标题数；0 表示整本没有标题，只按长度切分。 */
  detectedHeadings: number;
}

/** 低于编辑器单章上限（100,000 字符 / 2,000 行），留出余量。 */
export const MAX_CHAPTER_CHARACTERS = 95_000;
export const MAX_CHAPTER_LINES = 1_800;
export const MAX_IMPORT_CHAPTERS = 5_000;
const MAX_HEADING_CHARACTERS = 50;
const DEFAULT_VOLUME_TITLE = "正文";

const NUMERAL = "[0-9０-９零〇一二两三四五六七八九十百千万]+";
// 单位字后面必须是行尾或分隔符：这样"第一回合，他先出手"不会被当成"第一回"。
const AFTER_UNIT = "(?=$|[\\s:：、．.\\-—·【（(《])";
const CHAPTER_PATTERN = new RegExp(
  `^(?:第\\s*${NUMERAL}\\s*[章节回话]${AFTER_UNIT}|(?:chapter|chap\\.?)\\s*[0-9]+\\b|(?:楔子|序章|序言|序幕|引子|前言|尾声|终章|后记|番外)${AFTER_UNIT})`,
  "i",
);
const VOLUME_PATTERN = new RegExp(`^第\\s*${NUMERAL}\\s*[卷部集篇]${AFTER_UNIT}`);
const MARKDOWN_HEADING_PATTERN = /^#{1,3}\s+\S/;

type Line = { text: string; heading: "chapter" | "volume" | null; title: string };

function stripMarkdownHeading(line: string): string {
  return line.replace(/^\s*#{1,6}\s+/, "").replace(/\s+#+\s*$/, "").trim();
}

function looksLikeHeading(line: string, pattern: RegExp): boolean {
  if (!line || line.length > MAX_HEADING_CHARACTERS) return false;
  if (!pattern.test(line)) return false;
  // 标题不会以逗号、句号收尾；以这些结尾的多半是正文句子。
  return !/[，,。；;]$/.test(line);
}

function classify(lines: string[], useMarkdownHeadings: boolean): Line[] {
  return lines.map((text) => {
    const stripped = stripMarkdownHeading(text);
    if (looksLikeHeading(stripped, VOLUME_PATTERN)) return { text, heading: "volume" as const, title: stripped };
    if (looksLikeHeading(stripped, CHAPTER_PATTERN)) return { text, heading: "chapter" as const, title: stripped };
    if (useMarkdownHeadings && MARKDOWN_HEADING_PATTERN.test(text.trim()) && stripped.length <= MAX_HEADING_CHARACTERS) {
      return { text, heading: "chapter" as const, title: stripped };
    }
    return { text, heading: null, title: "" };
  });
}

function trimBlankLines(lines: string[]): string {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start += 1;
  while (end > start && !lines[end - 1].trim()) end -= 1;
  return lines.slice(start, end).join("\n");
}

/** 把超过单章上限的正文按行切成几段；单行超长时再按字符硬切。 */
export function splitOversizedContent(content: string): string[] {
  if (content.length <= MAX_CHAPTER_CHARACTERS && content.split("\n").length <= MAX_CHAPTER_LINES) return [content];
  const parts: string[] = [];
  let buffer: string[] = [];
  let bufferCharacters = 0;
  const flush = () => {
    const text = trimBlankLines(buffer);
    if (text) parts.push(text);
    buffer = [];
    bufferCharacters = 0;
  };
  for (const line of content.split("\n")) {
    let rest = line;
    while (rest.length > MAX_CHAPTER_CHARACTERS) {
      flush();
      parts.push(rest.slice(0, MAX_CHAPTER_CHARACTERS));
      rest = rest.slice(MAX_CHAPTER_CHARACTERS);
    }
    if (buffer.length + 1 > MAX_CHAPTER_LINES || bufferCharacters + rest.length + 1 > MAX_CHAPTER_CHARACTERS) flush();
    buffer.push(rest);
    bufferCharacters += rest.length + 1;
  }
  flush();
  return parts;
}

function pushChapter(volume: SplitVolume, title: string, lines: string[]): void {
  const content = trimBlankLines(lines);
  if (!content) return;
  const parts = splitOversizedContent(content);
  parts.forEach((part, index) => {
    volume.chapters.push({ title: parts.length > 1 ? `${title}（${index + 1}）` : title, content: part });
  });
}

export function splitBook(rawText: string, options?: { markdown?: boolean }): SplitBook {
  const text = rawText.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const rawLines = text.split("\n");
  let lines = classify(rawLines, false);
  let detectedHeadings = lines.filter((line) => line.heading === "chapter").length;
  // Markdown 文件没有"第X章"式标题时，退而使用 #/##/### 标题分章。
  if (detectedHeadings < 2 && options?.markdown) {
    const markdownLines = classify(rawLines, true);
    const markdownHeadings = markdownLines.filter((line) => line.heading === "chapter").length;
    if (markdownHeadings >= 2) {
      lines = markdownLines;
      detectedHeadings = markdownHeadings;
    }
  }

  const volumes: SplitVolume[] = [];
  let volume: SplitVolume = { title: DEFAULT_VOLUME_TITLE, chapters: [] };
  let chapterTitle: string | null = null;
  let buffer: string[] = [];
  const closeChapter = () => {
    // 第一个标题之前的内容（序、简介）不能丢，单独存成一章。
    pushChapter(volume, chapterTitle ?? (volume.chapters.length || volumes.length ? "卷首" : "前言"), buffer);
    buffer = [];
  };
  const closeVolume = () => {
    closeChapter();
    if (volume.chapters.length) volumes.push(volume);
  };

  for (const line of lines) {
    if (line.heading === "volume") {
      closeVolume();
      volume = { title: line.title, chapters: [] };
      chapterTitle = null;
    } else if (line.heading === "chapter") {
      closeChapter();
      chapterTitle = line.title;
    } else {
      buffer.push(line.text);
    }
  }
  closeVolume();

  // 整本没有任何标题：只按长度切分，标题用序号。
  if (!detectedHeadings && volumes.length === 1 && volumes[0].title === DEFAULT_VOLUME_TITLE) {
    const chapters = volumes[0].chapters;
    volumes[0].chapters = chapters.map((chapter, index) => ({
      title: chapters.length > 1 ? `第 ${index + 1} 部分` : "正文",
      content: chapter.content,
    }));
  }

  const chapterCount = volumes.reduce((total, item) => total + item.chapters.length, 0);
  if (chapterCount > MAX_IMPORT_CHAPTERS) {
    throw new Error(`识别出 ${chapterCount} 章，超过单次导入上限 ${MAX_IMPORT_CHAPTERS} 章，请拆成几个文件分别导入`);
  }
  return { volumes, chapterCount, detectedHeadings };
}
