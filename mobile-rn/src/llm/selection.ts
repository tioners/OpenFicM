import {
  getProviderApiKey,
  getSetting,
  listModels,
  listProviders,
} from "@/data/repositories";
import type { ModelSelection } from "@/types";

export async function resolveModelSelection(modelId?: string | null): Promise<ModelSelection> {
  const [models, providers, activeModelId] = await Promise.all([
    listModels(),
    listProviders(),
    modelId === undefined ? getSetting("activeModelId") : Promise.resolve(modelId),
  ]);
  const normalizedModelId = activeModelId?.trim() || null;
  if (!normalizedModelId) throw new Error("请先在设置中选择默认模型");
  const model = models.find((item) => item.id === normalizedModelId);
  if (!model) throw new Error("所选模型不存在，请重新选择");
  const provider = providers.find((item) => item.id === model.providerId);
  if (!provider) throw new Error("模型供应商不存在，请重新配置");
  const apiKey = await getProviderApiKey(provider);
  if (!apiKey) throw new Error(`${provider.name} 没有可用的 API Key，请重新保存`);
  return { model, provider, apiKey };
}
