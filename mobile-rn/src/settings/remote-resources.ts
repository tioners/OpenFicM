import * as Crypto from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import { z } from "zod";

import { getSetting, setSetting } from "@/data/repositories";
import { sha256File } from "@/lib/sha256";
import type { AgentDefinition, AgentSkill } from "@/settings/config";
import {
  checkOhStoryRelease,
  getInstalledOhStoryPackage,
  installOhStoryRelease,
} from "@/settings/oh-story-updater";

const OPENFICM_CATALOG_KEY = "content.openficm.catalog.v1";
const LORN_PACKAGE_KEY = "content.lornStyle.package.v1";
const MODEL_VERIFICATION_PREFIX = "resources.localModel.verified.";
const OPENFICM_CONTENT_COMMIT = "1a848fbe77f9952c38aac8c18240026154446114";
const OPENFICM_CATALOG_URL = `https://raw.githubusercontent.com/tioners/OpenFicM/${OPENFICM_CONTENT_COMMIT}/resources/openficm-agent-catalog.json`;
const OPENFICM_CATALOG_SHA256 = "3a186be06211eb659c81f5b1dc77ed65566fd4f295577acc540eb51ef3af17ef";
const OPENFICM_CATALOG_MAX_BYTES = 750_000;
const LORN_MOBILE_CATALOG_URL = `https://raw.githubusercontent.com/tioners/OpenFicM/${OPENFICM_CONTENT_COMMIT}/plugins/lorn-style-evolution/mobile-catalog.json`;
const LORN_MOBILE_CATALOG_SHA256 = "c4941dae92e2af7c58a016e9bf5204dacecf17a442f361e1b07875f43967433d";
const LORN_REPOSITORY = "lornshrimp/Lorn.NovelWriteSkills";
const LORN_COMMIT = "5acd34586d5d241193bd36ceed9341f7f482ea3b";
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_FETCH_ATTEMPTS = 3;
const MAX_LORN_FILE_BYTES = 100_000;
const MAX_LORN_PACKAGE_BYTES = 500_000;
const MAX_LORN_RUNTIME_INSTRUCTIONS_CHARACTERS = 36_000;
const DOWNLOAD_SPACE_RESERVE = 128 * 1024 * 1024;

const LORN_SOURCE_PATHS = [
  "CommonSkills/通用-蒸馏作者文风/SKILL.md",
  "CommonSkills/通用-蒸馏作者文风/references/作者风格模板格式定义.md",
  "CommonSkills/通用-蒸馏作者文风/references/写作思维模型与神似层提炼.md",
  "CommonSkills/通用-蒸馏作者文风/references/文风可移植性评估与移植技法.md",
  "CommonSkills/通用-蒸馏作者文风/references/轻量语感蒸馏模式.md",
  "CommonSkills/通用-蒸馏作者文风/references/多作者风格融合策略.md",
  "CommonSkills/通用-蒸馏作者文风/references/蒸馏维度详解（16维）.md",
  "CommonSkills/通用-蒸馏作者文风/references/风格DNA符合度审计.md",
  "CommonSkills/通用-蒸馏作者文风/references/执行流程检查点清单.md",
  "CommonSkills/通用-蒸馏作者文风/references/仿写文风适配指南模板.md",
  "CommonSkills/写作研究/GEO小说项目核心参考.md",
] as const;

const catalogSkillSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  instructions: z.string().min(1),
  enabled: z.boolean(),
  source: z.enum(["builtin", "custom", "plugin", "remote"]).optional(),
});

const catalogAgentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  systemPrompt: z.string().min(1),
  modelId: z.string(),
  enabled: z.boolean(),
  kind: z.enum(["primary", "subagent"]),
  skillIds: z.array(z.string()),
  toolNames: z.array(z.string()),
  delegatableAgentIds: z.array(z.string()),
  source: z.enum(["builtin", "custom", "plugin", "remote"]).optional(),
});

const catalogSchema = z.object({
  generatedFrom: z.string().optional(),
  skills: z.array(catalogSkillSchema).min(1),
  agents: z.array(catalogAgentSchema).min(1),
}).superRefine((catalog, context) => {
  if (!catalog.agents.some((agent) => agent.kind === "primary")) {
    context.addIssue({ code: "custom", message: "基础内容包缺少主智能体" });
  }
});

const openFicMCatalogPackageSchema = z.object({
  source: z.literal("openficm-github"),
  version: z.literal(1),
  installedAt: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  catalog: catalogSchema,
});

const lornMobileCatalogSchema = z.object({
  id: z.literal("lorn-style-evolution"),
  version: z.number().int().positive(),
  backendEndpoint: z.string().min(1).optional(),
  skills: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string(),
    enabled: z.boolean(),
    instructions: z.string().min(1),
  })).min(2),
});

const lornPackageSchema = z.object({
  source: z.literal("lorn-novel-write-skills"),
  version: z.literal(1),
  repository: z.literal(LORN_REPOSITORY),
  commitSha: z.literal(LORN_COMMIT),
  installedAt: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  upstreamLicense: z.literal("not-declared-at-repository-root"),
  skills: z.array(catalogSkillSchema.extend({ source: z.literal("plugin") })).length(2),
});

const modelVerificationSchema = z.object({
  fileName: z.string(),
  bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  lastModified: z.number().nullable(),
  verifiedAt: z.string().min(1),
});

export type LocalModelKind = "embedding" | "rerank";

export const LOCAL_MODEL_INFO = {
  embedding: {
    name: "BGE small zh v1.5 Q4_K_M",
    fileName: "bge-small-zh-v1.5-q4_k_m.gguf",
    url: "https://huggingface.co/CompendiumLabs/bge-small-zh-v1.5-gguf/resolve/main/bge-small-zh-v1.5-q4_k_m.gguf",
    bytes: 15_448_256,
    sha256: "0c17cc6ed7ec697db6768c2db6dd22c4e816a12c68ed14ff4d764927338532f8",
  },
  rerank: {
    name: "BGE reranker base Q4_K_M",
    fileName: "bge-reranker-base-q4_k_m.gguf",
    url: "https://huggingface.co/sabafallah/bge-reranker-base-Q4_K_M-GGUF/resolve/main/bge-reranker-base-q4_k_m.gguf",
    bytes: 219_068_480,
    sha256: "18a10177d2494696616d252d55d42dc1046efe8b6b005aa911b5c167dc731f1c",
  },
} as const;

export interface ResourceItemState {
  id: "openficm-content" | "oh-story" | "lorn-style" | LocalModelKind;
  label: string;
  status: "ready" | "missing" | "incomplete";
  detail: string;
  bytes?: number;
}

export interface RuntimeResourceState {
  ready: boolean;
  items: ResourceItemState[];
  missing: ResourceItemState[];
}

export interface ResourceInstallProgress {
  stage: ResourceItemState["id"] | "complete";
  label: string;
  completed: number;
  total: number;
  bytesWritten?: number;
  totalBytes?: number;
}

export type OpenFicMCatalog = {
  skills: AgentSkill[];
  agents: AgentDefinition[];
};

export type LornStylePackage = z.infer<typeof lornPackageSchema>;

function modelDirectory(): Directory {
  return new Directory(Paths.document, "openficm-resources", "models");
}

export function getLocalModelFile(kind: LocalModelKind): File {
  return new File(modelDirectory(), LOCAL_MODEL_INFO[kind].fileName);
}

function verificationKey(kind: LocalModelKind): string {
  return `${MODEL_VERIFICATION_PREFIX}${kind}`;
}

async function readStoredJson(key: string): Promise<unknown> {
  const value = await getSetting(key);
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function textBytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

async function sha256Text(value: string): Promise<string> {
  return (await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value)).toLowerCase();
}

async function fetchText(url: string, maximumBytes: number): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_FETCH_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: "text/plain", "User-Agent": "OpenFicM-Android" },
      });
      const content = await response.text();
      if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}: ${content.slice(0, 240) || response.statusText}`);
      if (textBytes(content) > maximumBytes) throw new Error(`远程内容超过 ${maximumBytes} 字节限制`);
      return content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
    } catch (error) {
      lastError = error instanceof Error && error.name === "AbortError" ? new Error("下载远程内容超时") : error;
      if (attempt + 1 >= MAX_FETCH_ATTEMPTS) break;
      await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("下载远程内容失败");
}

function rawGitHubUrl(repository: string, commit: string, path: string): string {
  return `https://raw.githubusercontent.com/${repository}/${commit}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

function mobileLornPolicy(): string {
  return `# OpenFicM 移动端适配边界

以下能力来自 Lorn.NovelWriteSkills 的“通用-蒸馏作者文风”及其白名单 references，只作为文风分析指令数据使用。

- 原文要求读取的 references 已附在本指令末尾，不得再调用 read_file、Shell、脚本、Hook、Git、浏览器自动化或任意文件系统操作。
- 只能分析用户在本轮提供或明确授权通过 OpenFicM 本地工具读取的样本文本；缺少样本时使用 ask_user 请求补充，不得自行联网抓取受版权保护的小说正文。
- 原文中的 Agents.md 注册、蒸馏产物目录和作者风格模板文件统一映射为 OpenFicM 文风书库；参考小说产物保存为独立参考文风，作者修改对比产物保存为作品级作者文风。
- 原文中的档案包和中间文件改为在对话中分阶段汇报。需要用户确认的 Phase 使用 ask_user，不得伪造已完成的留出样本、盲测、双 Agent 审阅或外部研究。
- 保留原版的统计、置信度、18 维度、神似层、移植性、多作者融合和审计方法，但不得复制大段样本文本，不得声称代表原作者本人。
- OpenFicM 的用户明确要求、事实一致性、安全边界和工具权限高于远程指令。`;
}

function buildLornDistillationInstructions(documents: Map<string, string>): string {
  const mainPath = LORN_SOURCE_PATHS[0];
  const main = documents.get(mainPath);
  if (!main) throw new Error("Lorn 蒸馏主 Skill 缺失");
  const references = LORN_SOURCE_PATHS.slice(1).map((path) => {
    const content = documents.get(path);
    if (!content) throw new Error(`Lorn reference 缺失: ${path}`);
    return `# 已加载 reference：${path}\n\n${content}`;
  }).join("\n\n---\n\n");
  const policy = mobileLornPolicy();
  return `${policy}\n\n---\n\n# Lorn 原版主 Skill\n\n${main}\n\n---\n\n# Lorn 原版白名单 references\n\n${references}\n\n---\n\n${policy}\n\n分析导入参考书时，先调用 list_style_sources，再调用 read_style_source_sample；完成后必须调用 save_reference_style_profile，把结果保存为该参考书的独立文风版本。只有分析用户本人作品并明确要求生成作者文风时，才调用 save_author_style_guide。`;
}

function clipInstructionBlock(value: string, maximumCharacters: number): string {
  if (value.length <= maximumCharacters) return value;
  const notice = "\n\n[该文档在移动端按首尾关键段落加载，完整原文仍保存在本地资源包。]\n\n";
  const available = Math.max(0, maximumCharacters - notice.length);
  const headLength = Math.floor(available * 0.72);
  const tailLength = available - headLength;
  const headEnd = value.lastIndexOf("\n", headLength);
  const tailStart = value.indexOf("\n", value.length - tailLength);
  return `${value.slice(0, headEnd > 0 ? headEnd : headLength).trimEnd()}${notice}${value.slice(tailStart >= 0 ? tailStart + 1 : value.length - tailLength).trimStart()}`;
}

export function compactLornDistillationInstructions(value: string): string {
  const normalized = value.trim();
  if (normalized.length <= MAX_LORN_RUNTIME_INSTRUCTIONS_CHARACTERS) return normalized;
  const blocks = normalized.split(/\n\n---\n\n/).map((block) => block.trim()).filter(Boolean);
  const selected = [
    ["# OpenFicM 移动端适配边界", 2_500],
    ["# Lorn 原版主 Skill", 9_000],
    ["作者风格模板格式定义.md", 4_500],
    ["蒸馏维度详解（16维）.md", 9_000],
    ["轻量语感蒸馏模式.md", 3_500],
    ["风格DNA符合度审计.md", 4_000],
    ["分析导入参考书时", 2_000],
  ] as const;
  const usedIndexes = new Set<number>();
  const runtimeBlocks = selected.flatMap(([marker, maximumCharacters]) => {
    const index = blocks.findIndex((block, blockIndex) => !usedIndexes.has(blockIndex) && block.includes(marker));
    if (index < 0) return [];
    usedIndexes.add(index);
    return [clipInstructionBlock(blocks[index], maximumCharacters)];
  });
  const compacted = runtimeBlocks.join("\n\n---\n\n");
  return clipInstructionBlock(compacted || normalized, MAX_LORN_RUNTIME_INSTRUCTIONS_CHARACTERS);
}

export async function getLornDistillationInstructions(): Promise<string> {
  const installed = await getInstalledLornStylePackage();
  const skill = installed?.skills.find((item) => item.id === "plugin-lorn-style--distillation");
  if (!skill) throw new Error("Lorn 文风蒸馏 Skill 尚未安装，请先修复运行资源");
  return compactLornDistillationInstructions(skill.instructions
    .replace(
      /原文中的 Agents\.md 注册、蒸馏产物目录和作者风格模板文件统一映射为 save_author_style_guide；最终必须把完整 Markdown 指南保存到当前作品。/g,
      "原文中的 Agents.md 注册、蒸馏产物目录和作者风格模板文件统一映射为 OpenFicM 文风书库。",
    )
    .replace(
      /完成蒸馏后必须调用 save_author_style_guide 保存完整结果。/g,
      "当前调用由文风书库负责保存结果；模型只输出完整 Markdown 参考文风指南。",
    ));
}

export async function getInstalledOpenFicMCatalog(): Promise<OpenFicMCatalog | null> {
  const parsed = openFicMCatalogPackageSchema.safeParse(await readStoredJson(OPENFICM_CATALOG_KEY));
  if (!parsed.success || parsed.data.sha256 !== OPENFICM_CATALOG_SHA256) return null;
  return parsed.data.catalog as OpenFicMCatalog;
}

export async function getInstalledLornStylePackage(): Promise<LornStylePackage | null> {
  const parsed = lornPackageSchema.safeParse(await readStoredJson(LORN_PACKAGE_KEY));
  return parsed.success ? parsed.data : null;
}

async function installOpenFicMCatalog(onProgress?: (progress: ResourceInstallProgress) => void): Promise<void> {
  onProgress?.({ stage: "openficm-content", label: "下载 OpenFicM 基础 Agent/Skill", completed: 0, total: 1 });
  const content = await fetchText(OPENFICM_CATALOG_URL, OPENFICM_CATALOG_MAX_BYTES);
  const sha256 = await sha256Text(content);
  if (sha256 !== OPENFICM_CATALOG_SHA256) throw new Error("OpenFicM 基础内容包 SHA-256 校验失败");
  const catalog = catalogSchema.parse(JSON.parse(content));
  await setSetting(OPENFICM_CATALOG_KEY, JSON.stringify({
    source: "openficm-github",
    version: 1,
    installedAt: new Date().toISOString(),
    sha256,
    catalog,
  }));
  onProgress?.({ stage: "openficm-content", label: "OpenFicM 基础 Agent/Skill 已安装", completed: 1, total: 1 });
}

async function installLornStylePackage(onProgress?: (progress: ResourceInstallProgress) => void): Promise<void> {
  const mobileCatalogText = await fetchText(LORN_MOBILE_CATALOG_URL, 50_000);
  if (await sha256Text(mobileCatalogText) !== LORN_MOBILE_CATALOG_SHA256) {
    throw new Error("Lorn 移动端目录 SHA-256 校验失败");
  }
  const mobileCatalog = lornMobileCatalogSchema.parse(JSON.parse(mobileCatalogText));
  const documents = new Map<string, string>();
  let packageBytes = textBytes(mobileCatalogText);
  for (let index = 0; index < LORN_SOURCE_PATHS.length; index += 1) {
    const path = LORN_SOURCE_PATHS[index];
    onProgress?.({ stage: "lorn-style", label: `下载 Lorn：${path.split("/").at(-1)}`, completed: index, total: LORN_SOURCE_PATHS.length });
    const content = await fetchText(rawGitHubUrl(LORN_REPOSITORY, LORN_COMMIT, path), MAX_LORN_FILE_BYTES);
    packageBytes += textBytes(content);
    if (packageBytes > MAX_LORN_PACKAGE_BYTES) throw new Error(`Lorn 文风包超过 ${MAX_LORN_PACKAGE_BYTES} 字节限制`);
    documents.set(path, content);
  }
  const sourceHash = [...documents.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, content]) => `${path}\n${content}`)
    .join("\n\u0000\n");
  const distillationMetadata = mobileCatalog.skills.find((skill) => skill.id === "plugin-lorn-style--distillation");
  const evolutionSkill = mobileCatalog.skills.find((skill) => skill.id === "plugin-lorn-style--evolution");
  if (!distillationMetadata || !evolutionSkill) throw new Error("Lorn 移动端目录缺少必需 Skill");
  const skills: AgentSkill[] = [
    {
      ...distillationMetadata,
      name: "Lorn 原版作者文风蒸馏",
      description: "基于 Lorn.NovelWriteSkills 原版主 Skill 与白名单 references，从导入参考书中蒸馏独立参考文风版本。",
      instructions: buildLornDistillationInstructions(documents),
      source: "plugin",
    },
    { ...evolutionSkill, source: "plugin" },
  ];
  const packageValue = lornPackageSchema.parse({
    source: "lorn-novel-write-skills",
    version: 1,
    repository: LORN_REPOSITORY,
    commitSha: LORN_COMMIT,
    installedAt: new Date().toISOString(),
    sha256: await sha256Text(`${mobileCatalogText}\n\u0000\n${sourceHash}`),
    upstreamLicense: "not-declared-at-repository-root",
    skills,
  });
  await setSetting(LORN_PACKAGE_KEY, JSON.stringify(packageValue));
  onProgress?.({ stage: "lorn-style", label: "Lorn 原版文风 Skill 已安装", completed: LORN_SOURCE_PATHS.length, total: LORN_SOURCE_PATHS.length });
}

async function verifyModel(kind: LocalModelKind, onProgress?: (bytesRead: number, totalBytes: number) => void): Promise<ResourceItemState> {
  const info = LOCAL_MODEL_INFO[kind];
  const file = getLocalModelFile(kind);
  const base = { id: kind, label: info.name, bytes: info.bytes } as const;
  if (!file.exists) return { ...base, status: "missing", detail: "尚未下载" };
  if (file.size !== info.bytes) return { ...base, status: "incomplete", detail: `文件大小异常：${file.size}/${info.bytes}` };
  const cached = modelVerificationSchema.safeParse(await readStoredJson(verificationKey(kind)));
  if (cached.success
    && cached.data.fileName === info.fileName
    && cached.data.bytes === info.bytes
    && cached.data.sha256 === info.sha256
    && cached.data.lastModified === file.lastModified) {
    return { ...base, status: "ready", detail: "完整性已验证" };
  }
  const sha256 = await sha256File(file, onProgress);
  if (sha256 !== info.sha256) return { ...base, status: "incomplete", detail: "SHA-256 校验失败" };
  await setSetting(verificationKey(kind), JSON.stringify({
    fileName: info.fileName,
    bytes: info.bytes,
    sha256,
    lastModified: file.lastModified,
    verifiedAt: new Date().toISOString(),
  }));
  return { ...base, status: "ready", detail: "完整性已验证" };
}

async function downloadModel(kind: LocalModelKind, onProgress?: (progress: ResourceInstallProgress) => void): Promise<void> {
  const info = LOCAL_MODEL_INFO[kind];
  const directory = modelDirectory();
  directory.create({ intermediates: true, idempotent: true });
  const target = getLocalModelFile(kind);
  const temporary = new File(directory, `${info.fileName}.download`);
  if (temporary.exists) temporary.delete();
  const task = File.createDownloadTask(info.url, temporary, {
    headers: { Accept: "application/octet-stream", "User-Agent": "OpenFicM-Android" },
    onProgress: ({ bytesWritten, totalBytes }) => onProgress?.({
      stage: kind,
      label: `下载 ${info.name}`,
      completed: 0,
      total: 1,
      bytesWritten,
      totalBytes: totalBytes > 0 ? totalBytes : info.bytes,
    }),
  });
  try {
    const downloaded = await task.downloadAsync();
    if (!downloaded) throw new Error(`${info.name} 下载被暂停`);
    if (downloaded.size !== info.bytes) throw new Error(`${info.name} 下载不完整：${downloaded.size}/${info.bytes}`);
    onProgress?.({ stage: kind, label: `校验 ${info.name}`, completed: 0, total: 1, bytesWritten: 0, totalBytes: info.bytes });
    const sha256 = await sha256File(downloaded, (bytesRead, totalBytes) => onProgress?.({
      stage: kind,
      label: `校验 ${info.name}`,
      completed: 0,
      total: 1,
      bytesWritten: bytesRead,
      totalBytes,
    }));
    if (sha256 !== info.sha256) throw new Error(`${info.name} SHA-256 校验失败`);
    if (target.exists) target.delete();
    await downloaded.move(target);
    await setSetting(verificationKey(kind), JSON.stringify({
      fileName: info.fileName,
      bytes: info.bytes,
      sha256,
      lastModified: target.lastModified,
      verifiedAt: new Date().toISOString(),
    }));
    onProgress?.({ stage: kind, label: `${info.name} 已就绪`, completed: 1, total: 1, bytesWritten: info.bytes, totalBytes: info.bytes });
  } catch (error) {
    if (temporary.exists) temporary.delete();
    throw error;
  } finally {
    task.release();
  }
}

export async function getRuntimeResourceState(): Promise<RuntimeResourceState> {
  const [catalog, ohStory, lorn, embedding, rerank] = await Promise.all([
    getInstalledOpenFicMCatalog(),
    getInstalledOhStoryPackage(),
    getInstalledLornStylePackage(),
    verifyModel("embedding"),
    verifyModel("rerank"),
  ]);
  const items: ResourceItemState[] = [
    {
      id: "openficm-content",
      label: "OpenFicM 基础 Agent/Skill",
      status: catalog ? "ready" : "missing",
      detail: catalog ? `${catalog.agents.length} 个智能体 · ${catalog.skills.length} 个技能` : "尚未安装或校验失败",
    },
    {
      id: "oh-story",
      label: "oh-story Agent/Skill",
      status: ohStory ? "ready" : "missing",
      detail: ohStory ? `${ohStory.version} · ${ohStory.agents.length} 个智能体 · ${ohStory.skills.length} 个技能` : "尚未安装",
    },
    {
      id: "lorn-style",
      label: "Lorn 原版文风 Skill",
      status: lorn ? "ready" : "missing",
      detail: lorn ? `${lorn.commitSha.slice(0, 8)} · ${lorn.skills.length} 个技能` : "尚未安装",
    },
    embedding,
    rerank,
  ];
  const missing = items.filter((item) => item.status !== "ready");
  return { ready: missing.length === 0, items, missing };
}

export async function installMissingRuntimeResources(
  onProgress?: (progress: ResourceInstallProgress) => void,
): Promise<RuntimeResourceState> {
  const before = await getRuntimeResourceState();
  const errors: string[] = [];
  const run = async (label: string, task: () => Promise<void>) => {
    try {
      await task();
    } catch (error) {
      errors.push(`${label}：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  if (before.missing.some((item) => item.id === "openficm-content")) {
    await run("OpenFicM 基础内容", () => installOpenFicMCatalog(onProgress));
  }
  if (before.missing.some((item) => item.id === "oh-story")) {
    await run("oh-story", async () => {
      onProgress?.({ stage: "oh-story", label: "检查 GitHub Release", completed: 0, total: 1 });
      const release = await checkOhStoryRelease();
      await installOhStoryRelease(release, ({ completed, total, label }) => onProgress?.({
        stage: "oh-story", label: `下载 oh-story：${label}`, completed, total,
      }));
      onProgress?.({ stage: "oh-story", label: `oh-story ${release.version} 已安装`, completed: 1, total: 1 });
    });
  }
  if (before.missing.some((item) => item.id === "lorn-style")) {
    await run("Lorn 文风包", () => installLornStylePackage(onProgress));
  }

  const missingModelBytes = before.missing
    .filter((item): item is ResourceItemState & { id: LocalModelKind } => item.id === "embedding" || item.id === "rerank")
    .reduce((total, item) => total + LOCAL_MODEL_INFO[item.id].bytes, 0);
  if (missingModelBytes && Paths.availableDiskSpace < missingModelBytes + DOWNLOAD_SPACE_RESERVE) {
    errors.push(`本地模型：存储空间不足，至少需要 ${Math.ceil((missingModelBytes + DOWNLOAD_SPACE_RESERVE) / 1024 / 1024)} MB 可用空间`);
  } else {
    for (const kind of ["embedding", "rerank"] as const) {
      if (before.missing.some((item) => item.id === kind)) {
        await run(LOCAL_MODEL_INFO[kind].name, () => downloadModel(kind, onProgress));
      }
    }
  }

  const after = await getRuntimeResourceState();
  if (errors.length || !after.ready) {
    const missing = after.missing.map((item) => item.label).join("、");
    throw new Error([...errors, missing ? `仍缺少：${missing}` : ""].filter(Boolean).join("\n"));
  }
  onProgress?.({ stage: "complete", label: "全部运行资源已就绪", completed: 1, total: 1 });
  return after;
}
