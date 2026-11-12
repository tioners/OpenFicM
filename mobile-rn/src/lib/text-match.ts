/**
 * 正文局部替换：先按原样精确匹配，失败时退化为"忽略空白差异"的匹配。
 *
 * 模型把整章正文重新输出一遍既费输出 Token，又容易撞上输出上限被截断，
 * 所以改章节以局部替换为主。但模型抄写 old_content 时常把缩进、空行、
 * 段间换行写得不完全一致，只做精确匹配会大面积失败，于是这里额外允许
 * 空白（空格、制表、换行）数量的差异，其余字符必须逐字相同。
 *
 * 纯函数，不依赖 expo 或数据库，可转译后在 Node 里断言。
 */

export interface TextReplacement {
  content: string;
  /** 实际替换的处数。 */
  replacements: number;
}

interface NormalizedText {
  text: string;
  /** 规范化后的每个字符在原文中的下标。 */
  positions: number[];
}

function normalize(text: string): NormalizedText {
  const characters: string[] = [];
  const positions: number[] = [];
  let previousWasWhitespace = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (/\s/.test(character)) {
      if (previousWasWhitespace) continue;
      characters.push(" ");
      positions.push(index);
      previousWasWhitespace = true;
      continue;
    }
    characters.push(character);
    positions.push(index);
    previousWasWhitespace = false;
  }
  return { text: characters.join(""), positions };
}

function findNext(
  content: string,
  oldText: string,
  fromIndex: number,
): { start: number; end: number } | null {
  const exact = content.indexOf(oldText, fromIndex);
  if (exact >= 0) return { start: exact, end: exact + oldText.length };

  const normalizedContent = normalize(content);
  const normalizedOld = normalize(oldText).text;
  if (!normalizedOld) return null;
  // 规范化后的下标与原文下标不同，起点要按同样规则换算。
  const normalizedStart = normalize(content.slice(0, fromIndex)).text.length;
  const hit = normalizedContent.text.indexOf(normalizedOld, normalizedStart);
  if (hit < 0) return null;
  return {
    start: normalizedContent.positions[hit],
    end: normalizedContent.positions[hit + normalizedOld.length - 1] + 1,
  };
}

const MAX_REPLACEMENTS = 500;

/**
 * 用 newText 替换 content 中的 oldText。
 * 找不到时返回 null，由调用方给出可操作的报错，不要静默改写正文。
 */
export function replaceText(
  content: string,
  oldText: string,
  newText: string,
  replaceAll = false,
): TextReplacement | null {
  if (!oldText) return null;
  let result = content;
  let replacements = 0;
  let searchFrom = 0;
  while (replacements < MAX_REPLACEMENTS) {
    const range = findNext(result, oldText, searchFrom);
    if (!range) break;
    result = result.slice(0, range.start) + newText + result.slice(range.end);
    replacements += 1;
    searchFrom = range.start + newText.length;
    if (!replaceAll) break;
  }
  return replacements ? { content: result, replacements } : null;
}
