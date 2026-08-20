import * as DocumentPicker from "expo-document-picker";
import { Directory, File, Paths } from "expo-file-system";
import { Buffer } from "buffer";
import { unzipSync } from "fflate";
import { XMLParser } from "fast-xml-parser";
import iconv from "iconv-lite";

import {
  createStyleSource,
  deleteStyleSourceRecord,
  findStyleSourceByHash,
  getStyleSource,
} from "@/data/style-repositories";
import { createId } from "@/lib/id";
import { sha256File } from "@/lib/sha256";
import type { StyleSource, StyleSourceFormat } from "@/types";

const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
const MAX_EXTRACTED_CHARACTERS = 8_000_000;
const MAX_EPUB_TEXT_ENTRY_BYTES = 4 * 1024 * 1024;
const MAX_EPUB_TOTAL_TEXT_BYTES = 20 * 1024 * 1024;
const SAMPLE_SECTION_COUNT = 6;
const SAMPLE_CHARACTERS_PER_SECTION = 4_000;
const LIBRARY_DIRECTORY_NAME = "style-library";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: false,
});

const xhtmlParser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  preserveOrder: true,
  parseTagValue: false,
  trimValues: false,
});

function libraryDirectory(): Directory {
  const directory = new Directory(Paths.document, LIBRARY_DIRECTORY_NAME);
  directory.create({ idempotent: true, intermediates: true });
  return directory;
}

function contentFile(sourceId: string): File {
  return new File(libraryDirectory(), `${sourceId}.content.txt`);
}

function extensionOf(fileName: string): string {
  const match = /\.([^.]+)$/.exec(fileName.trim());
  return match?.[1]?.toLowerCase() ?? "";
}

function formatForExtension(extension: string): StyleSourceFormat {
  if (extension === "txt") return "txt";
  if (extension === "md" || extension === "markdown") return "markdown";
  if (extension === "epub") return "epub";
  throw new Error("仅支持 TXT、Markdown 和 EPUB 文件");
}

function decodeText(bytes: Uint8Array): string {
  const buffer = Buffer.from(bytes);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return iconv.decode(buffer.subarray(3), "utf8");
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return iconv.decode(buffer.subarray(2), "utf16-le");
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return iconv.decode(buffer.subarray(2), "utf16-be");
  const utf8 = iconv.decode(buffer, "utf8");
  const utf8ReplacementCount = (utf8.match(/\uFFFD/g) ?? []).length;
  if (utf8ReplacementCount === 0) return utf8;
  const gb18030 = iconv.decode(buffer, "gb18030");
  const gbReplacementCount = (gb18030.match(/\uFFFD/g) ?? []).length;
  return gbReplacementCount < utf8ReplacementCount ? gb18030 : utf8;
}

function normalizeText(value: string): string {
  return value
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\u00A0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function archivePath(basePath: string, relativePath: string): string {
  const decoded = decodeURIComponent(relativePath.split("#")[0]);
  const parts = `${basePath}/${decoded}`.split("/");
  const normalized: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") normalized.pop();
    else normalized.push(part);
  }
  return normalized.join("/");
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function findArchiveEntry(entries: Record<string, Uint8Array>, path: string): Uint8Array | null {
  if (entries[path]) return entries[path];
  const lowerPath = path.toLowerCase();
  const key = Object.keys(entries).find((candidate) => candidate.toLowerCase() === lowerPath);
  return key ? entries[key] : null;
}

function collectMarkupText(value: unknown, output: string[], parentKey = ""): void {
  if (typeof value === "string" || typeof value === "number") {
    const text = String(value).trim();
    if (text) output.push(text);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectMarkupText(item, output, parentKey);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (["script", "style", "head", "svg", "nav"].includes(key.toLowerCase())) continue;
    collectMarkupText(item, output, key);
    if (/^(p|div|section|article|h[1-6]|li|blockquote|br)$/i.test(key) && parentKey !== key) output.push("\n");
  }
}

function fallbackMarkupText(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&(nbsp|amp|lt|gt|quot|apos);/gi, (_match, entity: string) => ({
      nbsp: " ",
      amp: "&",
      lt: "<",
      gt: ">",
      quot: '"',
      apos: "'",
    })[entity.toLowerCase()] ?? " ");
}

function extractMarkupText(value: string): string {
  try {
    const output: string[] = [];
    collectMarkupText(xhtmlParser.parse(value), output);
    const parsed = normalizeText(output.join(" "));
    if (parsed) return parsed;
  } catch {
    // Some EPUBs contain non-XML HTML; the bounded fallback still strips executable markup.
  }
  return normalizeText(fallbackMarkupText(value));
}

function extractEpub(bytes: Uint8Array): { title: string | null; text: string } {
  let totalTextBytes = 0;
  const entries = unzipSync(bytes, {
    filter: (entry) => {
      const normalizedName = entry.name.toLowerCase();
      const textEntry = normalizedName === "meta-inf/container.xml"
        || /\.(opf|xhtml|html|htm|xml|ncx)$/.test(normalizedName);
      if (!textEntry) return false;
      if (entry.originalSize > MAX_EPUB_TEXT_ENTRY_BYTES) throw new Error("EPUB 单个文本条目超过 4 MB 限制");
      totalTextBytes += entry.originalSize;
      if (totalTextBytes > MAX_EPUB_TOTAL_TEXT_BYTES) throw new Error("EPUB 解压后的文本超过 20 MB 限制");
      return true;
    },
  });
  const containerBytes = findArchiveEntry(entries, "META-INF/container.xml");
  if (!containerBytes) throw new Error("EPUB 缺少 META-INF/container.xml");
  const container = xmlParser.parse(decodeText(containerBytes)) as {
    container?: { rootfiles?: { rootfile?: { "full-path"?: string } | Array<{ "full-path"?: string }> } };
  };
  const rootfile = asArray(container.container?.rootfiles?.rootfile)[0];
  const packagePath = rootfile?.["full-path"];
  if (!packagePath) throw new Error("EPUB 没有声明内容包");
  const packageBytes = findArchiveEntry(entries, packagePath);
  if (!packageBytes) throw new Error("EPUB 内容包不存在");
  const packageDocument = xmlParser.parse(decodeText(packageBytes)) as {
    package?: {
      metadata?: { title?: string | string[] };
      manifest?: { item?: Array<{ id?: string; href?: string; "media-type"?: string }> | { id?: string; href?: string; "media-type"?: string } };
      spine?: { itemref?: Array<{ idref?: string }> | { idref?: string } };
    };
  };
  const packageRoot = packageDocument.package;
  if (!packageRoot) throw new Error("EPUB 内容包格式无效");
  const basePath = packagePath.includes("/") ? packagePath.slice(0, packagePath.lastIndexOf("/")) : "";
  const manifest = new Map(
    asArray(packageRoot.manifest?.item)
      .filter((item) => item.id && item.href)
      .map((item) => [item.id as string, item]),
  );
  const spineItems = asArray(packageRoot.spine?.itemref);
  const sections: string[] = [];
  for (const itemref of spineItems) {
    const item = itemref.idref ? manifest.get(itemref.idref) : null;
    if (!item?.href) continue;
    const entry = findArchiveEntry(entries, archivePath(basePath, item.href));
    if (!entry) continue;
    const section = extractMarkupText(decodeText(entry));
    if (section) sections.push(section);
    if (sections.reduce((total, value) => total + value.length, 0) > MAX_EXTRACTED_CHARACTERS) {
      throw new Error("EPUB 提取后的正文超过 800 万字符限制");
    }
  }
  const text = normalizeText(sections.join("\n\n"));
  if (!text) throw new Error("EPUB 书脊中没有可读取的正文");
  const titleValue = asArray(packageRoot.metadata?.title)[0];
  return { title: typeof titleValue === "string" ? normalizeText(titleValue) : null, text };
}

function sourceTitle(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "").trim() || "未命名参考书";
}

export async function importStyleSource(): Promise<StyleSource | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: "*/*",
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  const format = formatForExtension(extensionOf(asset.name));
  const inputFile = new File(asset.uri);
  const sizeBytes = asset.size ?? inputFile.size;
  if (!sizeBytes || sizeBytes > MAX_IMPORT_BYTES) throw new Error("参考书文件必须小于 50 MB");
  const contentHash = await sha256File(inputFile);
  const duplicate = await findStyleSourceByHash(contentHash);
  if (duplicate) throw new Error(`《${duplicate.title}》已在参考书库中`);
  const bytes = await inputFile.bytes();
  const extracted = format === "epub"
    ? extractEpub(bytes)
    : { title: null, text: normalizeText(decodeText(bytes)) };
  if (!extracted.text) throw new Error("文件中没有可读取的正文");
  if (extracted.text.length > MAX_EXTRACTED_CHARACTERS) throw new Error("正文超过 800 万字符限制");
  const id = createId();
  const originalFile = new File(libraryDirectory(), `${id}.${extensionOf(asset.name)}`);
  const normalizedFile = contentFile(id);
  try {
    originalFile.create({ overwrite: true });
    originalFile.write(bytes);
    normalizedFile.create({ overwrite: true });
    normalizedFile.write(extracted.text);
    return await createStyleSource({
      id,
      title: extracted.title || sourceTitle(asset.name),
      fileName: asset.name,
      format,
      fileUri: originalFile.uri,
      sizeBytes,
      contentHash,
      characterCount: extracted.text.length,
    });
  } catch (error) {
    if (originalFile.exists) originalFile.delete();
    if (normalizedFile.exists) normalizedFile.delete();
    throw error;
  }
}

export async function readStyleSourceText(sourceId: string): Promise<string> {
  const source = await getStyleSource(sourceId);
  if (!source) throw new Error("参考书不存在");
  const file = contentFile(source.id);
  if (!file.exists) throw new Error("参考书正文文件已丢失，请重新导入");
  return file.text();
}

export async function readStyleSourceSample(sourceId: string): Promise<string> {
  const text = await readStyleSourceText(sourceId);
  if (text.length <= SAMPLE_SECTION_COUNT * SAMPLE_CHARACTERS_PER_SECTION) return text;
  const sections: string[] = [];
  const maximumStart = text.length - SAMPLE_CHARACTERS_PER_SECTION;
  for (let index = 0; index < SAMPLE_SECTION_COUNT; index += 1) {
    const approximateStart = Math.round(maximumStart * index / (SAMPLE_SECTION_COUNT - 1));
    const paragraphStart = text.lastIndexOf("\n", approximateStart);
    const start = Math.max(0, paragraphStart >= approximateStart - 500 ? paragraphStart + 1 : approximateStart);
    sections.push(`[样本 ${index + 1}/${SAMPLE_SECTION_COUNT}]\n${text.slice(start, start + SAMPLE_CHARACTERS_PER_SECTION)}`);
  }
  return sections.join("\n\n");
}

export async function deleteStyleSource(sourceId: string): Promise<void> {
  const source = await getStyleSource(sourceId);
  if (!source) throw new Error("参考书不存在");
  await deleteStyleSourceRecord(source.id);
  const originalFile = new File(source.fileUri);
  const normalizedFile = contentFile(source.id);
  if (originalFile.exists) originalFile.delete();
  if (normalizedFile.exists) normalizedFile.delete();
}
