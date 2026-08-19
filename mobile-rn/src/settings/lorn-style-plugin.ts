import { callModel } from "@/llm/client";
import type { AgentMessage } from "@/llm/types";
import type { ModelSelection } from "@/types";
import { getSetting, setSetting } from "@/data/repositories";

const MAX_STYLE_TEXT_CHARACTERS = 100_000;
const EVOLUTION_TIMEOUT_MS = 120_000;
export const LORN_STYLE_SKILL_IDS = ["plugin-lorn-style--distillation", "plugin-lorn-style--evolution"] as const;
const LORN_STYLE_BACKEND_ENDPOINT = "/evolve-author-style";

function guideKey(projectId: string): string {
  return `plugin.lorn-style-evolution.guide.${projectId}`;
}

export const LORN_STYLE_ENDPOINT_KEY = "plugin.lorn-style-evolution.endpoint";

function boundedText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label}不能为空`);
  if (normalized.length > MAX_STYLE_TEXT_CHARACTERS) throw new Error(`${label}超过 ${MAX_STYLE_TEXT_CHARACTERS} 字符限制`);
  return normalized;
}

export function isLornStyleSkillId(id: string): boolean {
  return LORN_STYLE_SKILL_IDS.includes(id as (typeof LORN_STYLE_SKILL_IDS)[number]);
}

export function shouldAttachLornStyleSkills(agent: { id: string; name: string; kind: string }): boolean {
  return agent.kind === "primary" || /(narrative-writer|writer|写手|正文)/i.test(`${agent.id} ${agent.name}`);
}

export function shouldInjectAuthorStyleGuide(agent: { id: string; name: string }, request: string): boolean {
  return /(narrative-writer|writer|写手|正文)/i.test(`${agent.id} ${agent.name}`)
    || /(正文|章节|续写|扩写|改写|重写|润色|写作)/.test(request);
}

export async function getAuthorStyleGuide(projectId: string): Promise<string> {
  return (await getSetting(guideKey(projectId)))?.trim() ?? "";
}

export async function saveAuthorStyleGuide(projectId: string, guide: string): Promise<void> {
  const normalized = guide.trim();
  if (normalized.length > MAX_STYLE_TEXT_CHARACTERS) throw new Error(`文风指南超过 ${MAX_STYLE_TEXT_CHARACTERS} 字符限制`);
  await setSetting(guideKey(projectId), normalized);
}

function evolutionPrompt(aiDraft: string, authorRevision: string, currentGuide: string): string {
  return `比较 AI 原稿与作者定稿，更新作者专属文风约束指南。必须分析作者增加、删除或替换的具体词汇，长短句偏好、句子连接和段落节奏，对话称呼、语气、潜台词和长度，以及感官、修辞、情绪表达和去 AI 味规则。只依据两份文本差异；样本不足时明确标注，不把单次修改提升为硬规则，不复制大段原文，不生成小说正文。只输出新版 Markdown《作者专属文风约束指南》。\n\n当前指南：\n<current_style_guide>\n${currentGuide || "暂无"}\n</current_style_guide>\n\nAI 原稿：\n<ai_draft>\n${aiDraft}\n</ai_draft>\n\n作者定稿：\n<author_revision>\n${authorRevision}\n</author_revision>`;
}

function endpointUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s]+$/i.test(normalized)) throw new Error("Lorn 文风进化服务地址无效");
  return normalized.endsWith(LORN_STYLE_BACKEND_ENDPOINT) ? normalized : `${normalized}${LORN_STYLE_BACKEND_ENDPOINT}`;
}

async function callPluginEndpoint(endpoint: string, aiDraft: string, authorRevision: string, currentGuide: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EVOLUTION_TIMEOUT_MS);
  try {
    const response = await fetch(endpointUrl(endpoint), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ai_draft: aiDraft, author_revision: authorRevision, current_style_guide: currentGuide }),
      signal: controller.signal,
    });
    const text = await response.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new Error("Lorn 文风进化服务返回了无法解析的响应");
    }
    if (!response.ok) {
      const detail = data && typeof data === "object" && "detail" in data ? String(data.detail) : text;
      throw new Error(`Lorn 文风进化服务返回 ${response.status}: ${detail || response.statusText}`);
    }
    if (!data || typeof data !== "object" || !("style_guide" in data) || typeof data.style_guide !== "string") {
      throw new Error("Lorn 文风进化服务没有返回文风指南");
    }
    return boundedText(data.style_guide, "文风指南");
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("Lorn 文风进化服务请求超时");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function evolveWithCurrentModel(selection: ModelSelection, aiDraft: string, authorRevision: string, currentGuide: string): Promise<string> {
  const messages: AgentMessage[] = [
    { role: "system", content: "你是严谨的中文文风编辑，只输出可执行的 Markdown 文风约束指南。" },
    { role: "user", content: evolutionPrompt(aiDraft, authorRevision, currentGuide) },
  ];
  const result = await callModel(selection, messages, []);
  return boundedText(result.content, "模型返回的文风指南");
}

export async function evolveAuthorStyle(input: {
  projectId: string;
  aiDraft: string;
  authorRevision: string;
  selection: ModelSelection;
}): Promise<{ guide: string; source: "plugin-endpoint" | "current-model" }> {
  const aiDraft = boundedText(input.aiDraft, "AI 原稿");
  const authorRevision = boundedText(input.authorRevision, "作者定稿");
  const [currentGuide, endpoint] = await Promise.all([
    getAuthorStyleGuide(input.projectId),
    getSetting(LORN_STYLE_ENDPOINT_KEY),
  ]);
  const guide = endpoint?.trim()
    ? await callPluginEndpoint(endpoint, aiDraft, authorRevision, currentGuide)
    : await evolveWithCurrentModel(input.selection, aiDraft, authorRevision, currentGuide);
  await saveAuthorStyleGuide(input.projectId, guide);
  return { guide, source: endpoint?.trim() ? "plugin-endpoint" : "current-model" };
}
