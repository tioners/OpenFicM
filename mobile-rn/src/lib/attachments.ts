import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { unzipSync } from "fflate";

import { addAttachment } from "@/data/workspace-repositories";
import { docxXmlToText } from "@/lib/docx-text";
import { decodeText, extractEpub, normalizeText } from "@/style/source-library";
import type { ChatAttachment, ChatAttachmentFormat } from "@/types";

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENT_CHARACTERS = 2_000_000;
const MAX_DOCX_XML_BYTES = 30 * 1024 * 1024;

const FORMATS: Record<string, ChatAttachmentFormat> = {
  txt: "txt",
  md: "markdown",
  markdown: "markdown",
  docx: "docx",
  epub: "epub",
};

function extractDocx(bytes: Uint8Array): string {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, {
      filter: (entry) => {
        if (entry.name !== "word/document.xml") return false;
        if (entry.originalSize > MAX_DOCX_XML_BYTES) throw new Error("Word 文档正文过大");
        return true;
      },
    });
  } catch (error) {
    if (error instanceof Error && /过大/.test(error.message)) throw error;
    throw new Error("无法解析这个 Word 文档");
  }
  const xml = entries["word/document.xml"];
  if (!xml) throw new Error("Word 文档里没有正文（仅支持 .docx，不支持旧的 .doc）");
  return docxXmlToText(decodeText(xml));
}

/** 让用户选一个文件，解析出文本后挂到当前对话上。助手用 read_file 按需分段读取。 */
export async function pickAttachment(sessionId: string): Promise<ChatAttachment | null> {
  const picked = await DocumentPicker.getDocumentAsync({ type: "*/*", copyToCacheDirectory: true, multiple: false });
  if (picked.canceled) return null;
  const asset = picked.assets[0];
  const extension = (/\.([^.]+)$/.exec(asset.name.trim())?.[1] ?? "").toLowerCase();
  const format = FORMATS[extension];
  if (!format) throw new Error("附件仅支持 TXT、Markdown、Word（.docx）和 EPUB");
  const inputFile = new File(asset.uri);
  const sizeBytes = asset.size ?? inputFile.size;
  if (!sizeBytes) throw new Error("文件是空的");
  if (sizeBytes > MAX_ATTACHMENT_BYTES) throw new Error("附件不能超过 10 MB");
  const bytes = await inputFile.bytes();
  const text = format === "docx"
    ? extractDocx(bytes)
    : format === "epub"
      ? extractEpub(bytes).text
      : normalizeText(decodeText(bytes));
  if (!text.trim()) throw new Error("没有从文件里读到文字");
  if (text.length > MAX_ATTACHMENT_CHARACTERS) throw new Error("附件文字超过 200 万字符，请拆分后再添加");
  return addAttachment({ sessionId, fileName: asset.name, format, sizeBytes, content: text });
}
