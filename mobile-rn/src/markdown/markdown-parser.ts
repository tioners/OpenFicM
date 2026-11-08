import MarkdownIt from "markdown-it";

/**
 * 助手回复里的 Markdown 解析（多步）：
 * 用 markdown-it 生成 token 流，再由 markdown-view 渲染成 RN 组件。
 *
 * 这里刻意**不启用** html 与 linkify：
 * - html: false —— 模型输出里的 <script>/<img onerror> 之类不该进 TextView，也避免 XSS 面；
 * - linkify 交给渲染层判断，不在解析期把普通文本切成链接。
 */

const parser = new MarkdownIt({
  html: false,
  linkify: false,
  breaks: true, // 中文写作里单个换行通常就是要换行，而不是同一段落
  typographer: false,
});

export type MarkdownToken = {
  type: string;
  tag: string;
  nesting: number;
  content: string;
  markup: string;
  info: string;
  meta: unknown;
  block: boolean;
  hidden: boolean;
  attrs: [string, string][] | null;
  children: MarkdownToken[] | null;
};

/** 解析成 token 流；调用方负责渲染。解析异常时退回单段纯文本，绝不让助手消息整条消失。 */
export function parseMarkdown(source: string): MarkdownToken[] {
  const normalized = source.replace(/\r\n?/g, "\n");
  try {
    return parser.parse(normalized, {}) as MarkdownToken[];
  } catch {
    return [{
      type: "paragraph_open",
      tag: "p",
      nesting: 1,
      content: "",
      markup: "",
      info: "",
      meta: null,
      block: true,
      hidden: false,
      attrs: null,
      children: null,
    }, {
      type: "inline",
      tag: "",
      nesting: 0,
      content: normalized,
      markup: "",
      info: "",
      meta: null,
      block: true,
      hidden: false,
      attrs: null,
      children: [{ type: "text", tag: "", nesting: 0, content: normalized, markup: "", info: "", meta: null, block: false, hidden: false, attrs: null, children: null }],
    }, {
      type: "paragraph_close",
      tag: "p",
      nesting: -1,
      content: "",
      markup: "",
      info: "",
      meta: null,
      block: true,
      hidden: false,
      attrs: null,
      children: null,
    }];
  }
}

/** 把 token 的属性数组转成便于取值的对象。 */
export function tokenAttr(token: MarkdownToken, name: string): string | null {
  if (!token.attrs) return null;
  const found = token.attrs.find(([key]) => key === name);
  return found ? found[1] : null;
}
