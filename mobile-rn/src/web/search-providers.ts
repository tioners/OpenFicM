import type { SearchProviderType } from "@/types";

/**
 * 联网搜索服务的请求组装与响应解析。接口格式对照上游 OpenFic 的 provider 实现，
 * 但每个服务的 Base URL 都可以由用户改写（中转站、自建实例）。
 *
 * 纯函数，不依赖 expo 或数据库，可转译后在 Node 里断言。
 */

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchResponse {
  answer: string | null;
  results: WebSearchResult[];
}

export interface SearchRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}

export const SEARCH_PROVIDER_PRESETS: Record<SearchProviderType, {
  label: string;
  defaultBaseUrl: string;
  requiresApiKey: boolean;
  hint: string;
}> = {
  tavily: { label: "Tavily", defaultBaseUrl: "https://api.tavily.com", requiresApiKey: true, hint: "POST /search" },
  zhipu: { label: "智谱", defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4", requiresApiKey: true, hint: "POST /web_search" },
  brave: { label: "Brave", defaultBaseUrl: "https://api.search.brave.com", requiresApiKey: true, hint: "GET /res/v1/web/search" },
  serper: { label: "Serper", defaultBaseUrl: "https://google.serper.dev", requiresApiKey: true, hint: "POST /search" },
  jina: { label: "Jina", defaultBaseUrl: "https://s.jina.ai", requiresApiKey: true, hint: "GET /?q=" },
  exa: { label: "Exa", defaultBaseUrl: "https://api.exa.ai", requiresApiKey: true, hint: "POST /search" },
  searxng: { label: "SearXNG", defaultBaseUrl: "", requiresApiKey: false, hint: "自建实例，GET /search?format=json" },
};

export const DEFAULT_SEARCH_RESULTS = 8;
export const MAX_SEARCH_RESULTS = 20;
const MAX_SNIPPET_CHARACTERS = 600;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function query(parameters: Record<string, string | number>): string {
  return Object.entries(parameters)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
}

export function clampResultCount(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_SEARCH_RESULTS;
  return Math.min(MAX_SEARCH_RESULTS, Math.max(1, Math.round(parsed)));
}

export function buildSearchRequest(input: {
  type: SearchProviderType;
  baseUrl: string;
  apiKey: string;
  query: string;
  count: number;
}): SearchRequest {
  const base = input.baseUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) throw new Error("搜索服务的 Base URL 无效");
  const key = input.apiKey.trim();
  if (SEARCH_PROVIDER_PRESETS[input.type].requiresApiKey && !key) throw new Error("搜索服务没有可用的 API Key，请到设置里重新保存");
  const json = { "Content-Type": "application/json", Accept: "application/json" };
  const bearer = { Authorization: `Bearer ${key}` };
  switch (input.type) {
    case "tavily":
      return {
        url: `${base}/search`,
        method: "POST",
        headers: { ...json, ...bearer },
        body: JSON.stringify({ query: input.query, max_results: input.count, search_depth: "basic", include_answer: true }),
      };
    case "zhipu":
      return {
        url: `${base}/web_search`,
        method: "POST",
        headers: { ...json, ...bearer },
        body: JSON.stringify({
          search_engine: "search_pro",
          search_query: input.query,
          search_intent: false,
          count: input.count,
          content_size: "medium",
        }),
      };
    case "brave":
      return {
        url: `${base}/res/v1/web/search?${query({ q: input.query, count: input.count })}`,
        method: "GET",
        headers: { Accept: "application/json", "X-Subscription-Token": key },
      };
    case "serper":
      return {
        url: `${base}/search`,
        method: "POST",
        headers: { ...json, "X-API-KEY": key },
        body: JSON.stringify({ q: input.query, num: input.count }),
      };
    case "jina":
      return {
        url: `${base}/?${query({ q: input.query, num: input.count })}`,
        method: "GET",
        headers: { Accept: "application/json", ...bearer },
      };
    case "exa":
      return {
        url: `${base}/search`,
        method: "POST",
        headers: { ...json, "x-api-key": key },
        body: JSON.stringify({
          query: input.query,
          numResults: input.count,
          contents: { highlights: true, text: { maxCharacters: 300 } },
        }),
      };
    case "searxng":
      return {
        url: `${base}/search?${query({ q: input.query, format: "json", safesearch: 0 })}`,
        method: "GET",
        headers: { Accept: "application/json", ...(key ? bearer : {}) },
      };
    default:
      throw new Error("不支持的搜索服务类型");
  }
}

function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function result(title: unknown, url: unknown, snippet: unknown): WebSearchResult {
  return { title: text(title), url: text(url), snippet: text(snippet).slice(0, MAX_SNIPPET_CHARACTERS) };
}

export function parseSearchResponse(type: SearchProviderType, payload: unknown, count: number): WebSearchResponse {
  const data = isRecord(payload) ? payload : {};
  let answer: string | null = null;
  let results: WebSearchResult[] = [];
  switch (type) {
    case "tavily":
      answer = text(data.answer) || null;
      results = rows(data.results).map((item) => result(item.title, item.url, item.content));
      break;
    case "zhipu":
      results = rows(data.search_result).map((item) => result(item.title, item.link, item.content));
      break;
    case "brave":
      results = rows(isRecord(data.web) ? data.web.results : undefined)
        .map((item) => result(item.title, item.url, item.description));
      break;
    case "serper":
      results = rows(data.organic).map((item) => result(item.title, item.link, item.snippet));
      break;
    case "jina":
      results = rows(data.data).map((item) => result(item.title, item.url, item.description || item.content));
      break;
    case "exa":
      results = rows(data.results).map((item) => {
        const highlights = Array.isArray(item.highlights)
          ? item.highlights.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
          : [];
        return result(item.title, item.url, highlights.length ? highlights.join("\n") : item.text);
      });
      break;
    case "searxng":
      results = rows(data.results).map((item) => result(item.title, item.url, item.content));
      break;
    default:
      break;
  }
  return {
    answer,
    results: results.filter((item) => /^https?:\/\//i.test(item.url)).slice(0, count),
  };
}
