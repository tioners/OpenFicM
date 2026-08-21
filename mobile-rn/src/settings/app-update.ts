import appConfig from "../../app.json";

import { getSetting, setSetting } from "@/data/repositories";

const REPOSITORY = "tioners/OpenFicM";
const RELEASE_API = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const RELEASE_PAGE = `https://github.com/${REPOSITORY}/releases`;
const LAST_CHECK_KEY = "app.update.lastCheck";
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_NOTES_CHARACTERS = 4_000;

/** 版本号来自 app.json，也就是构建 APK 时使用的同一份配置。 */
export const CURRENT_APP_VERSION: string = appConfig.expo.version;

export interface AppUpdateInfo {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  releaseUrl: string;
  publishedAt: string;
  apkUrl: string | null;
  apkSizeBytes: number | null;
  notes: string;
  checkedAt: string;
}

function versionSegments(value: string): number[] {
  return value.trim().replace(/^v/i, "").split(/[.\-+]/)
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isInteger(part));
}

/** 按段做数值比较，避免 "0.10.0" 被字典序判成小于 "0.7.5"。 */
export function compareVersions(left: string, right: string): number {
  const a = versionSegments(left);
  const b = versionSegments(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseStoredUpdate(raw: string | null): AppUpdateInfo | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)
      || typeof value.currentVersion !== "string"
      || typeof value.latestVersion !== "string"
      || typeof value.releaseUrl !== "string"
      || typeof value.checkedAt !== "string") return null;
    return {
      currentVersion: value.currentVersion,
      // 存下来之后应用可能已经升级过，所以重新判断而不是信任存档里的 hasUpdate。
      latestVersion: value.latestVersion,
      hasUpdate: compareVersions(value.latestVersion, CURRENT_APP_VERSION) > 0,
      releaseUrl: value.releaseUrl,
      publishedAt: typeof value.publishedAt === "string" ? value.publishedAt : "",
      apkUrl: typeof value.apkUrl === "string" ? value.apkUrl : null,
      apkSizeBytes: typeof value.apkSizeBytes === "number" ? value.apkSizeBytes : null,
      notes: typeof value.notes === "string" ? value.notes : "",
      checkedAt: value.checkedAt,
    };
  } catch {
    return null;
  }
}

export async function getLastAppUpdateCheck(): Promise<AppUpdateInfo | null> {
  return parseStoredUpdate(await getSetting(LAST_CHECK_KEY));
}

export async function checkAppUpdate(): Promise<AppUpdateInfo> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let payload: unknown;
  try {
    const response = await fetch(RELEASE_API, {
      headers: { Accept: "application/vnd.github+json" },
      signal: controller.signal,
    });
    if (response.status === 404) throw new Error("仓库还没有发布任何 Release");
    if (!response.ok) throw new Error(`GitHub 返回 HTTP ${response.status}`);
    payload = await response.json();
  } catch (error) {
    if (isRecord(error) && error.name === "AbortError") throw new Error("检查更新超时，请确认网络可以访问 GitHub");
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    clearTimeout(timeout);
  }
  if (!isRecord(payload)) throw new Error("GitHub Release 数据格式无效");
  const latestVersion = typeof payload.tag_name === "string" ? payload.tag_name.replace(/^v/i, "").trim() : "";
  if (!latestVersion) throw new Error("GitHub Release 没有版本号");
  const assets = Array.isArray(payload.assets) ? payload.assets.filter(isRecord) : [];
  const apk = assets.find((asset) => typeof asset.name === "string" && asset.name.toLowerCase().endsWith(".apk"));
  const info: AppUpdateInfo = {
    currentVersion: CURRENT_APP_VERSION,
    latestVersion,
    hasUpdate: compareVersions(latestVersion, CURRENT_APP_VERSION) > 0,
    releaseUrl: typeof payload.html_url === "string" ? payload.html_url : RELEASE_PAGE,
    publishedAt: typeof payload.published_at === "string" ? payload.published_at : "",
    apkUrl: typeof apk?.browser_download_url === "string" ? apk.browser_download_url : null,
    apkSizeBytes: typeof apk?.size === "number" ? apk.size : null,
    notes: typeof payload.body === "string" ? payload.body.slice(0, MAX_NOTES_CHARACTERS) : "",
    checkedAt: new Date().toISOString(),
  };
  await setSetting(LAST_CHECK_KEY, JSON.stringify(info));
  return info;
}
