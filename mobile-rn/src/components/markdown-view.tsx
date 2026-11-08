import { useMemo, type ReactNode } from "react";
import {
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type TextStyle,
} from "react-native";

import { parseMarkdown, type MarkdownToken } from "@/markdown/markdown-parser";

import { colors, radius, spacing } from "@/theme";

/**
 * 把助手回复渲染成移动端友好的 Markdown。
 *
 * 设计取舍：
 * - 不加载远程图片：图片只显示占位文字，避免对话内容触发不可控的网络请求（隐私与流量）；
 * - 链接只放行 http/https/mailto，其余按普通文本处理；
 * - 代码块单独成块、等宽字体、可横向滚动；行内代码用轻底色；
 * - 每一段都可以长按选择复制，整条消息的原文复制仍由 MessageActionBar 负责。
 */

const HEADING_SIZES: Record<string, number> = {
  h1: 22,
  h2: 20,
  h3: 18,
  h4: 17,
  h5: 16,
  h6: 16,
};

const SAFE_LINK = /^(https?:\/\/|mailto:)/i;

function isSafeLink(href: string): boolean {
  return SAFE_LINK.test(href.trim());
}

function tokenAttrValue(token: MarkdownToken, name: string): string {
  if (!token.attrs) return "";
  const found = token.attrs.find(([key]) => key === name);
  return found ? found[1] : "";
}
function findMatchingClose(tokens: MarkdownToken[], openIndex: number, openType: string, closeType: string): number {
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index += 1) {
    if (tokens[index].type === openType) depth += 1;
    else if (tokens[index].type === closeType) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return tokens.length - 1;
}

function inlineStyle(state: {
  bold: number;
  italic: number;
  strike: number;
  href: string | null;
}): TextStyle {
  return {
    ...(state.bold > 0 ? { fontWeight: "700" } : null),
    ...(state.italic > 0 ? { fontStyle: "italic" } : null),
    ...(state.strike > 0 ? { textDecorationLine: "line-through" } : null),
    ...(state.href ? { color: colors.primary, textDecorationLine: state.strike > 0 ? "underline line-through" : "underline" } : null),
  };
}

function openLink(href: string): void {
  if (!isSafeLink(href)) return;
  Linking.openURL(href).catch(() => undefined);
}

/** 行内 token → 一串 Text；用状态栈合并粗体/斜体/删除线/链接，避免深层嵌套。 */
function renderInline(
  tokens: MarkdownToken[] | null,
  keyPrefix: string,
  baseStyle?: TextStyle,
): ReactNode[] {
  if (!tokens || !tokens.length) return [];
  const nodes: ReactNode[] = [];
  const state = { bold: 0, italic: 0, strike: 0, href: null as string | null };
  let bufferKey = 0;

  const pushText = (content: string) => {
    if (!content) return;
    const style = [baseStyle, inlineStyle(state)];
    const key = `${keyPrefix}-t${bufferKey++}`;
    if (state.href) {
      const href = state.href;
      nodes.push(
        <Text key={key} style={style} onPress={() => openLink(href)} suppressHighlighting>
          {content}
        </Text>,
      );
      return;
    }
    nodes.push(<Text key={key} style={style}>{content}</Text>);
  };

  for (const token of tokens) {
    switch (token.type) {
      case "text":
        pushText(token.content);
        break;
      case "strong_open":
        state.bold += 1;
        break;
      case "strong_close":
        state.bold = Math.max(0, state.bold - 1);
        break;
      case "em_open":
        state.italic += 1;
        break;
      case "em_close":
        state.italic = Math.max(0, state.italic - 1);
        break;
      case "s_open":
        state.strike += 1;
        break;
      case "s_close":
        state.strike = Math.max(0, state.strike - 1);
        break;
      case "link_open":
        state.href = tokenAttrValue(token, "href") || null;
        break;
      case "link_close":
        state.href = null;
        break;
      case "code_inline":
        nodes.push(
          <Text key={`${keyPrefix}-c${bufferKey++}`} style={[baseStyle, styles.inlineCode]}>
            {token.content}
          </Text>,
        );
        break;
      case "softbreak":
      case "hardbreak":
        nodes.push(<Text key={`${keyPrefix}-b${bufferKey++}`} style={baseStyle}>{"\n"}</Text>);
        break;
      case "image":
        // 不加载远程图片：只提示这里原本有一张图，避免对话内容触发外部请求。
        nodes.push(
          <Text key={`${keyPrefix}-img${bufferKey++}`} style={[baseStyle, styles.imagePlaceholder]}>
            {`[图片：${token.content || tokenAttrValue(token, "src") || "未命名"}]`}
          </Text>,
        );
        break;
      case "html_inline":
        // html 已在解析期关闭，这里只可能出现转义后的残留，按纯文本展示。
        pushText(token.content);
        break;
      default:
        if (token.content) pushText(token.content);
        break;
    }
  }
  return nodes;
}

function CodeBlock({ content, language, keyPrefix }: { content: string; language: string; keyPrefix: string }) {
  return (
    <View style={styles.codeBlock}>
      {language ? <Text style={styles.codeLanguage}>{language}</Text> : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.codeScroll}>
        <Text selectable key={`${keyPrefix}-code`} style={styles.codeText}>{content.replace(/\n$/, "")}</Text>
      </ScrollView>
    </View>
  );
}

type TableCell = { header: boolean; align: "left" | "center" | "right"; children: ReactNode[] };

function renderTable(tokens: MarkdownToken[], start: number, end: number, keyPrefix: string): ReactNode {
  const rows: TableCell[][] = [];
  let currentRow: TableCell[] | null = null;
  let headerRow = false;

  for (let index = start; index < end; index += 1) {
    const token = tokens[index];
    if (token.type === "thead_open") headerRow = true;
    else if (token.type === "thead_close") headerRow = false;
    else if (token.type === "tr_open") currentRow = [];
    else if (token.type === "tr_close") {
      if (currentRow) rows.push(currentRow);
      currentRow = null;
    } else if ((token.type === "th_open" || token.type === "td_open") && currentRow) {
      const alignRaw = tokenAttrValue(token, "style");
      const align: TableCell["align"] = alignRaw.includes("center") ? "center" : alignRaw.includes("right") ? "right" : "left";
      // 单元格内容紧跟一个 inline token
      const inline = tokens[index + 1];
      currentRow.push({
        header: token.type === "th_open" || headerRow,
        align,
        children: inline?.type === "inline"
          ? renderInline(inline.children, `${keyPrefix}-cell-${rows.length}-${currentRow.length}`)
          : [],
      });
    }
  }

  if (!rows.length) return null;
  return (
    <ScrollView key={`${keyPrefix}-table`} horizontal showsHorizontalScrollIndicator={false} style={styles.tableScroll}>
      <View style={styles.table}>
        {rows.map((row, rowIndex) => (
          <View key={`${keyPrefix}-row-${rowIndex}`} style={[styles.tableRow, rowIndex === 0 && styles.tableHeaderRow]}>
            {row.map((cell, cellIndex) => (
              <View
                key={`${keyPrefix}-cellwrap-${rowIndex}-${cellIndex}`}
                style={[
                  styles.tableCell,
                  { alignItems: cell.align === "center" ? "center" : cell.align === "right" ? "flex-end" : "flex-start" },
                ]}
              >
                <Text style={[styles.tableText, cell.header && styles.tableHeaderText]}>{cell.children}</Text>
              </View>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

/** 块级 token 渲染。tight 用于列表项内的段落：不加段间距。 */
function renderBlocks(tokens: MarkdownToken[], start: number, end: number, keyPrefix: string, tight = false): ReactNode[] {
  const nodes: ReactNode[] = [];
  let index = start;

  while (index < end) {
    const token = tokens[index];
    if (!token || token.hidden) {
      index += 1;
      continue;
    }

    if (token.type === "paragraph_open") {
      const inline = tokens[index + 1];
      nodes.push(
        <Text
          key={`${keyPrefix}-p-${index}`}
          selectable
          style={[styles.paragraph, tight && styles.paragraphTight]}
        >
          {inline?.type === "inline" ? renderInline(inline.children, `${keyPrefix}-p${index}`) : null}
        </Text>,
      );
      index += 3;
      continue;
    }

    if (token.type === "heading_open") {
      const inline = tokens[index + 1];
      const size = HEADING_SIZES[token.tag] ?? 16;
      nodes.push(
        <Text
          key={`${keyPrefix}-h-${index}`}
          selectable
          style={[styles.heading, { fontSize: size, lineHeight: size * 1.45 }]}
        >
          {inline?.type === "inline" ? renderInline(inline.children, `${keyPrefix}-h${index}`) : null}
        </Text>,
      );
      index += 3;
      continue;
    }

    if (token.type === "fence" || token.type === "code_block") {
      nodes.push(
        <CodeBlock
          key={`${keyPrefix}-fence-${index}`}
          content={token.content}
          language={token.info.trim().split(/\s+/)[0] ?? ""}
          keyPrefix={`${keyPrefix}-f${index}`}
        />,
      );
      index += 1;
      continue;
    }

    if (token.type === "blockquote_open") {
      const close = findMatchingClose(tokens, index, "blockquote_open", "blockquote_close");
      nodes.push(
        <View key={`${keyPrefix}-bq-${index}`} style={styles.blockquote}>
          {renderBlocks(tokens, index + 1, close, `${keyPrefix}-bq${index}`, true)}
        </View>,
      );
      index = close + 1;
      continue;
    }

    if (token.type === "bullet_list_open" || token.type === "ordered_list_open") {
      const ordered = token.type === "ordered_list_open";
      const markerChar = token.markup || "-";
      const start = Number(tokenAttrValue(token, "start") || "1");
      const close = findMatchingClose(tokens, index, token.type, ordered ? "ordered_list_close" : "bullet_list_close");
      const items = renderListItems(tokens, index + 1, close, `${keyPrefix}-li${index}`);
      nodes.push(
        <View key={`${keyPrefix}-list-${index}`} style={styles.list}>
          {items.map((children, itemIndex) => (
            <View key={`${keyPrefix}-item-${itemIndex}`} style={styles.listItem}>
              <Text style={styles.listMarker}>
                {ordered ? `${start + itemIndex}.` : markerChar === "*" ? "•" : markerChar}
              </Text>
              <View style={styles.listContent}>{children}</View>
            </View>
          ))}
        </View>,
      );
      index = close + 1;
      continue;
    }

    if (token.type === "table_open") {
      const close = findMatchingClose(tokens, index, "table_open", "table_close");
      nodes.push(renderTable(tokens, index + 1, close, `${keyPrefix}-tb${index}`));
      index = close + 1;
      continue;
    }

    if (token.type === "hr") {
      nodes.push(<View key={`${keyPrefix}-hr-${index}`} style={styles.hr} />);
      index += 1;
      continue;
    }

    if (token.type === "inline") {
      // 兜底：出现在块级上下文里的孤立 inline。
      nodes.push(
        <Text key={`${keyPrefix}-inl-${index}`} selectable style={styles.paragraph}>
          {renderInline(token.children, `${keyPrefix}-i${index}`)}
        </Text>,
      );
      index += 1;
      continue;
    }

    // 其余开闭标签（列表中未匹配的段落等）直接跳过，交给对应分支处理。
    index += 1;
  }

  return nodes;
}

function renderListItems(tokens: MarkdownToken[], start: number, end: number, keyPrefix: string): ReactNode[][] {
  const items: ReactNode[][] = [];
  let index = start;
  while (index < end) {
    const token = tokens[index];
    if (token?.type !== "list_item_open") {
      index += 1;
      continue;
    }
    const close = findMatchingClose(tokens, index, "list_item_open", "list_item_close");
    items.push(renderBlocks(tokens, index + 1, close, `${keyPrefix}-${items.length}`, true));
    index = close + 1;
  }
  return items;
}

export function MarkdownView({ content }: { content: string }) {
  // 长对话里每条消息都会渲染，解析结果按内容缓存，流式刷新时不做无谓重建。
  const nodes = useMemo(() => {
    const tokens = parseMarkdown(content);
    return renderBlocks(tokens, 0, tokens.length, "md");
  }, [content]);

  return <View style={styles.container}>{nodes}</View>;
}

/** 给外部一个仅测解析的入口，便于用 Node 跑断言。 */
export { parseMarkdown } from "@/markdown/markdown-parser";

const styles = StyleSheet.create({
  container: { gap: spacing.xs },
  paragraph: { color: colors.text, fontSize: 16, lineHeight: 24 },
  paragraphTight: { marginBottom: 0 },
  heading: { color: colors.text, fontWeight: "700", marginTop: spacing.sm },
  inlineCode: {
    fontFamily: "monospace",
    fontSize: 14,
    color: colors.accent,
    backgroundColor: colors.surfaceMuted,
  },
  imagePlaceholder: { color: colors.textMuted, fontStyle: "italic" },
  codeBlock: {
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
  },
  codeLanguage: { color: colors.textMuted, fontSize: 11, marginBottom: spacing.xs, textTransform: "lowercase" },
  codeScroll: { paddingRight: spacing.sm },
  codeText: { fontFamily: "monospace", fontSize: 13, lineHeight: 20, color: colors.text },
  blockquote: {
    borderLeftWidth: 3,
    borderLeftColor: colors.primary,
    paddingLeft: spacing.md,
    paddingVertical: spacing.xs,
    backgroundColor: colors.surfaceMuted,
  },
  list: { gap: spacing.xs },
  listItem: { flexDirection: "row", gap: spacing.sm },
  listMarker: { color: colors.textMuted, fontSize: 16, lineHeight: 24, minWidth: 18 },
  listContent: { flex: 1, minWidth: 0, gap: spacing.xs },
  hr: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: spacing.sm },
  tableScroll: { marginVertical: spacing.xs },
  table: { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: radius.sm, overflow: "hidden" },
  tableRow: { flexDirection: "row", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  tableHeaderRow: { backgroundColor: colors.surfaceMuted },
  tableCell: { minWidth: 96, maxWidth: 220, paddingVertical: spacing.xs, paddingHorizontal: spacing.sm, justifyContent: "center" },
  tableText: { color: colors.text, fontSize: 14, lineHeight: 20 },
  tableHeaderText: { fontWeight: "700" },
});
