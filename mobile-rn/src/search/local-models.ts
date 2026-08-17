import { Asset } from "expo-asset";
import { initLlama, type LlamaContext } from "llama.rn";

const EMBEDDING_ASSET = require("../../assets/models/bge-small-zh-v1.5-q4_k_m.gguf");
const RERANK_ASSET = require("../../assets/models/bge-reranker-base-q4_k_m.gguf");

const QUERY_PREFIX = "为这个句子生成表示以用于检索相关文章：";
const MAX_MODEL_INPUT_CHARACTERS = 440;

export const LOCAL_MODEL_INFO = {
  embedding: {
    name: "BGE small zh v1.5 Q4_K_M",
    bytes: 15_448_256,
    sha256: "0c17cc6ed7ec697db6768c2db6dd22c4e816a12c68ed14ff4d764927338532f8",
  },
  rerank: {
    name: "BGE reranker base Q4_K_M",
    bytes: 219_068_480,
    sha256: "18a10177d2494696616d252d55d42dc1046efe8b6b005aa911b5c167dc731f1c",
  },
} as const;

let embeddingContextPromise: Promise<LlamaContext> | null = null;
let rerankContextPromise: Promise<LlamaContext> | null = null;

async function resolvePackagedAsset(moduleId: number): Promise<string> {
  const asset = Asset.fromModule(moduleId);
  await asset.downloadAsync();
  const path = asset.localUri ?? asset.uri;
  if (!path?.startsWith("file:")) throw new Error("无法读取 APK 内置模型资产");
  return path;
}

function createEmbeddingContext(): Promise<LlamaContext> {
  return resolvePackagedAsset(EMBEDDING_ASSET).then((model) => initLlama({
    model,
    embedding: true,
    pooling_type: "cls",
    n_ctx: 512,
    n_batch: 512,
    n_threads: 6,
    n_gpu_layers: 0,
    use_mlock: false,
  }));
}

function createRerankContext(): Promise<LlamaContext> {
  return resolvePackagedAsset(RERANK_ASSET).then((model) => initLlama({
    model,
    embedding: true,
    pooling_type: "rank",
    n_ctx: 512,
    n_batch: 512,
    n_threads: 6,
    n_gpu_layers: 0,
    use_mlock: false,
  }));
}

async function getEmbeddingContext(): Promise<LlamaContext> {
  if (!embeddingContextPromise) {
    embeddingContextPromise = createEmbeddingContext().catch((error) => {
      embeddingContextPromise = null;
      throw error;
    });
  }
  return embeddingContextPromise;
}

async function getRerankContext(): Promise<LlamaContext> {
  if (!rerankContextPromise) {
    rerankContextPromise = createRerankContext().catch((error) => {
      rerankContextPromise = null;
      throw error;
    });
  }
  return rerankContextPromise;
}

function truncateInput(text: string): string {
  return text.trim().slice(0, MAX_MODEL_INPUT_CHARACTERS);
}

export async function embedPassage(text: string): Promise<number[]> {
  const context = await getEmbeddingContext();
  const result = await context.embedding(truncateInput(text), { embd_normalize: 2 });
  return result.embedding;
}

export async function embedQuery(text: string): Promise<number[]> {
  const context = await getEmbeddingContext();
  const result = await context.embedding(`${QUERY_PREFIX}${truncateInput(text)}`, { embd_normalize: 2 });
  return result.embedding;
}

export async function rerankDocuments(query: string, documents: string[]): Promise<Array<{
  score: number;
  index: number;
}>> {
  if (!documents.length) return [];
  const context = await getRerankContext();
  return context.rerank(
    truncateInput(query),
    documents.map(truncateInput),
    { normalize: 1 },
  );
}

export function getLocalModelStatus(): {
  embeddingLoaded: boolean;
  rerankLoaded: boolean;
} {
  return {
    embeddingLoaded: embeddingContextPromise !== null,
    rerankLoaded: rerankContextPromise !== null,
  };
}

export async function warmUpLocalModels(): Promise<void> {
  await getEmbeddingContext();
  await getRerankContext();
}

export async function releaseLocalModels(): Promise<void> {
  const contexts = [embeddingContextPromise, rerankContextPromise].filter(
    (value): value is Promise<LlamaContext> => value !== null,
  );
  embeddingContextPromise = null;
  rerankContextPromise = null;
  await Promise.all(contexts.map(async (contextPromise) => {
    const context = await contextPromise.catch(() => null);
    if (context) await context.release();
  }));
}
