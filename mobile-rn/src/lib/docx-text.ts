/**
 * 从 Word 文档的 word/document.xml 里取出纯文本（按段落分行）。
 *
 * 纯函数，不依赖 expo 或数据库，可转译后在 Node 里断言。
 */

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// 段落里按出现顺序取：正文片段、制表符、换行。修订记录里被删除的文字（w:delText）不匹配，自然被跳过。
const RUN_PATTERN = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab(?:\s[^>]*)?\/>|<w:(?:br|cr)(?:\s[^>]*)?\/>/g;

export function docxXmlToText(xml: string): string {
  const body = /<w:body(?:\s[^>]*)?>([\s\S]*)<\/w:body>/.exec(xml)?.[1] ?? xml;
  const lines = body.split(/<\/w:p>/).map((paragraph) => {
    let text = "";
    for (const match of paragraph.matchAll(RUN_PATTERN)) {
      if (match[1] !== undefined) text += match[1];
      else text += match[0].startsWith("<w:tab") ? "\t" : "\n";
    }
    return decodeXmlEntities(text).replace(/[ \t]+$/gm, "");
  });
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
