import { fetch as nativeFetch } from "expo/fetch";

import { getActiveSearchProvider, getSearchProviderApiKey } from "@/data/workspace-repositories";
import { decodeText } from "@/style/source-library";

import { htmlToText, normalizeFetchUrl } from "./page-text";
import { buildSearchRequest, clampResultCount, parseSearchResponse, type WebSearchResponse } from "./search-providers";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const MAX_PAGE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_FETCH_CHARACTERS = 12_000;
export const MAX_FETCH_CHARACTERS = 32_000;

async function withTimeout<T>(signal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const abortFromCaller = () => controller.abort();
  signal?.addEventListener("abort", abortFromCaller, { once: true });
  try {
    return await run(controller.signal);
  } catch (error) {
    if (signal?.aborted) throw new Error("已取消本次请求");
    if (controller.signal.aborted) throw new Error("请求超时");
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}

export async function runWebSearch(
  query: string,
  count: unknown,
  signal?: AbortSignal,
): Promise<WebSearchResponse & { provider: string }> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) throw new Error("检索关键词不能为空");
  const provider = await getActiveSearchProvider();
  if (!provider) throw new Error("还没有配置联网搜索服务，请到“设置 → 联网搜索”添加");
  const resultCount = clampResultCount(count);
  const request = buildSearchRequest({
    type: provider.type,
    baseUrl: provider.baseUrl,
    apiKey: await getSearchProviderApiKey(provider),
    query: normalizedQuery,
    count: resultCount,
  });
  return withTimeout(signal, async (requestSignal) => {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: requestSignal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${provider.name} 返回 HTTP ${response.status}：${text.trim().slice(0, 200) || "无详情"}`);
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`${provider.name} 返回了无法解析的内容：${text.trim().slice(0, 200)}`);
    }
    return { ...parseSearchResponse(provider.type, payload, resultCount), provider: provider.name };
  });
}

export interface FetchedPage {
  url: string;
  finalUrl: string;
  title: string;
  content: string;
  contentLength: number;
  startIndex: number;
  nextStartIndex: number | null;
}

async function readLimited(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PAGE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("网页超过 5 MB，已停止读取");
    }
    chunks.push(value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function resolveRedirect(current: string, location: string): string {
  if (/^https?:\/\//i.test(location)) return location;
  const origin = /^(https?:\/\/[^/?#]+)/i.exec(current)?.[1] ?? "";
  if (location.startsWith("//")) return `${current.slice(0, current.indexOf(":"))}:${location}`;
  if (location.startsWith("/")) return `${origin}${location}`;
  const path = current.slice(origin.length).split(/[?#]/)[0];
  return `${origin}${path.slice(0, path.lastIndexOf("/") + 1)}${location}`;
}

/**
 * 读取一个公开网页并转成纯文本，按字符分段返回。
 * 重定向逐跳手动跟随并重新校验地址，防止公开网址跳转到局域网地址。
 */
export async function fetchWebPage(input: {
  url: string;
  startIndex?: unknown;
  maxCharacters?: unknown;
  signal?: AbortSignal;
}): Promise<FetchedPage> {
  const requestedUrl = normalizeFetchUrl(input.url);
  const startIndex = Math.max(0, Math.floor(Number(input.startIndex) || 0));
  const maxCharacters = Math.min(
    MAX_FETCH_CHARACTERS,
    Math.max(1, Math.floor(Number(input.maxCharacters) || DEFAULT_FETCH_CHARACTERS)),
  );
  return withTimeout(input.signal, async (signal) => {
    let currentUrl = requestedUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const response = await nativeFetch(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal,
        headers: {
          Accept: "text/html,application/xhtml+xml,text/plain;q=0.9",
          "User-Agent": "Mozilla/5.0 (Linux; Android 14) OpenFicM-WebFetch/1.0",
        },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error(`网页返回了没有目标的重定向（HTTP ${response.status}）`);
        if (hop >= MAX_REDIRECTS) throw new Error("重定向次数过多");
        currentUrl = normalizeFetchUrl(resolveRedirect(currentUrl, location));
        continue;
      }
      if (!response.ok) throw new Error(`网页返回 HTTP ${response.status}`);
      const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      const isHtml = contentType === "text/html" || contentType === "application/xhtml+xml" || !contentType;
      if (!isHtml && !contentType.startsWith("text/")) throw new Error(`不支持的内容类型：${contentType}，只能读取网页或纯文本`);
      const bytes = response.body ? await readLimited(response.body) : new Uint8Array(await response.arrayBuffer());
      const raw = decodeText(bytes);
      const page = isHtml ? htmlToText(raw) : { title: "", text: raw.replace(/\r\n?/g, "\n").trim() };
      if (!page.text) throw new Error("没有从网页里提取到正文（可能是需要登录或由脚本渲染的页面）");
      if (startIndex > page.text.length) throw new Error("起始位置超过正文长度");
      const end = Math.min(startIndex + maxCharacters, page.text.length);
      return {
        url: requestedUrl,
        finalUrl: currentUrl,
        title: page.title,
        content: page.text.slice(startIndex, end),
        contentLength: page.text.length,
        startIndex,
        nextStartIndex: end < page.text.length ? end : null,
      };
    }
    throw new Error("重定向次数过多");
  });
}
