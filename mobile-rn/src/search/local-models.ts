import { initLlama, type LlamaContext } from "llama.rn";
import { getLocalModelFile, LOCAL_MODEL_INFO } from "@/settings/remote-resources";

const QUERY_PREFIX = "为这个句子生成表示以用于检索相关文章：";
const MAX_MODEL_INPUT_CHARACTERS = 440;

let embeddingContextPromise: Promise<LlamaContext> | null = null;
let rerankContextPromise: Promise<LlamaContext> | null = null;

function createEmbeddingContext(): Promise<LlamaContext> {
  const model = getLocalModelFile("embedding");
  if (!model.exists || model.size !== LOCAL_MODEL_INFO.embedding.bytes) throw new Error("嵌入模型尚未下载或文件不完整，请先在启动提示中一键拉取");
  return Promise.resolve(initLlama({
    model: model.uri,
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
  const model = getLocalModelFile("rerank");
  if (!model.exists || model.size !== LOCAL_MODEL_INFO.rerank.bytes) throw new Error("重排模型尚未下载或文件不完整，请先在启动提示中一键拉取");
  return Promise.resolve(initLlama({
    model: model.uri,
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
