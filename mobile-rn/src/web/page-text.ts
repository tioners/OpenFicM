/**
 * 网页读取用的纯函数：地址校验（拒绝访问本机和局域网）与 HTML 转纯文本。
 *
 * 纯函数，不依赖 expo 或数据库，可转译后在 Node 里断言。
 */

function parseIpv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const numbers = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  return numbers.every((value) => Number.isInteger(value) && value >= 0 && value <= 255) ? numbers : null;
}

function isPrivateIpv4([a, b]: number[]): boolean {
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224;
}

/** 主机名是否指向本机、局域网或其它不该由助手访问的地址。 */
export function isPrivateHost(rawHost: string): boolean {
  const host = rawHost.trim().toLowerCase().replace(/\.$/, "");
  if (!host) return true;
  if (host.startsWith("[") || host.includes(":")) {
    const address = host.replace(/^\[|\]$/g, "");
    if (address === "::1" || address === "::") return true;
    if (/^f[cd][0-9a-f]{2}:/.test(address) || /^fe[89ab][0-9a-f]:/.test(address)) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
    if (mapped) {
      const ipv4 = parseIpv4(mapped[1]);
      return !ipv4 || isPrivateIpv4(ipv4);
    }
    return false;
  }
  const ipv4 = parseIpv4(host);
  if (ipv4) return isPrivateIpv4(ipv4);
  // 纯数字或十六进制写法的 IP（如 2130706433、0x7f.1）一律拒绝，避免绕过上面的判断。
  if (/^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+)){0,3}$/.test(host)) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (/\.(local|internal|lan|home|intranet|corp)$/.test(host)) return true;
  // 没有点的主机名只可能是局域网里的机器名。
  return !host.includes(".");
}

/** 校验并规范化要读取的网址；不合法时抛出给模型看的错误。 */
export function normalizeFetchUrl(value: string): string {
  const trimmed = value.trim();
  const match = /^(https?):\/\/([^/?#]+)([^#]*)/i.exec(trimmed);
  if (!match) throw new Error("只支持 http 或 https 网址");
  const authority = match[2];
  if (authority.includes("@")) throw new Error("网址里不能带用户名或密码");
  const host = authority.startsWith("[")
    ? authority.slice(0, authority.indexOf("]") + 1)
    : authority.replace(/:\d+$/, "");
  if (isPrivateHost(host)) throw new Error("不能读取本机或局域网地址");
  return `${match[1].toLowerCase()}://${authority}${match[3] || "/"}`;
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", hellip: "…", mdash: "—", ndash: "–",
  ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", middot: "·", copy: "©", reg: "®", emsp: " ", ensp: " ",
};

function codePoint(value: number): string {
  return Number.isInteger(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : " ";
}

export function decodeEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_match, code: string) => codePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_match, code: string) => codePoint(Number.parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

function inlineText(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

export interface ExtractedPage {
  title: string;
  text: string;
}

const DROPPED_BLOCKS = "script|style|noscript|template|svg|canvas|iframe|object|form|nav|footer|aside|button|select|head";

/**
 * 把网页 HTML 转成可读的纯文本（保留标题、列表和链接文字）。
 * 手机上没有完整的正文抽取库，这里只做结构化清洗：去掉脚本、样式、导航和表单。
 */
export function htmlToText(html: string): ExtractedPage {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? inlineText(titleMatch[1]) : "";
  let body = html;
  const mainMatch = /<(article|main)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(html);
  // 有 <article>/<main> 且内容足够多时只取它，能去掉大部分页眉页脚。
  if (mainMatch && inlineText(mainMatch[2]).length >= 400) body = mainMatch[2];
  else body = (/<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1]) ?? html;

  const text = body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(new RegExp(`<(${DROPPED_BLOCKS})\\b[^>]*>[\\s\\S]*?<\\/\\1>`, "gi"), " ")
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_match, level: string, inner: string) => {
      const heading = inlineText(inner);
      return heading ? `\n\n${"#".repeat(Number(level))} ${heading}\n\n` : "\n";
    })
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    // <li> 开头已经换行，结尾不再加，否则列表项之间会多出空行。
    .replace(/<\/li>/gi, "")
    .replace(/<\/(p|div|section|article|main|header|ul|ol|tr|table|blockquote|pre|dd|dt|figure|figcaption)>/gi, "\n\n")
    .replace(/<\/(td|th)>/gi, " | ")
    .replace(/<[^>]+>/g, "");

  const lines = decodeEntities(text)
    .split("\n")
    .map((line) => line.replace(/[ \t 　]+/g, " ").trim());
  const output: string[] = [];
  for (const line of lines) {
    if (!line || line === "-") {
      if (output.length && output[output.length - 1] !== "") output.push("");
      continue;
    }
    output.push(line);
  }
  while (output.length && output[output.length - 1] === "") output.pop();
  return { title, text: output.join("\n") };
}
