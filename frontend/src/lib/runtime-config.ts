export interface RuntimeConfig {
  backendBaseUrl: string;
}

let runtimeConfigPromise: Promise<RuntimeConfig | null> | null = null;
let runtimeConfig: RuntimeConfig | null = null;

function normalizeBackendBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function isNativeApp(): boolean {
  if (typeof window === "undefined") return false;
  const capacitor = (window as Window & {
    Capacitor?: { isNativePlatform?: () => boolean };
  }).Capacitor;
  return capacitor?.isNativePlatform?.() === true;
}

function isRuntimeConfig(value: unknown): value is RuntimeConfig {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { backendBaseUrl?: unknown };
  return typeof candidate.backendBaseUrl === "string" && candidate.backendBaseUrl.length > 0;
}

export async function loadRuntimeConfig(): Promise<RuntimeConfig | null> {
  if (runtimeConfigPromise) return runtimeConfigPromise;

  runtimeConfigPromise = fetch("/runtime-config.json", { cache: "no-store" })
    .then(async (response) => {
      if (!response.ok) return null;
      const data = (await response.json()) as unknown;
      if (!isRuntimeConfig(data)) {
        runtimeConfigPromise = null;
        return null;
      }
      runtimeConfig = {
        backendBaseUrl: normalizeBackendBaseUrl(data.backendBaseUrl),
      };
      return runtimeConfig;
    })
    .catch(() => {
      runtimeConfigPromise = null;
      return null;
    });

  return runtimeConfigPromise;
}

export function getRuntimeConfig(): RuntimeConfig | null {
  return runtimeConfig;
}

/**
 * Resolve the local backend without relying on Windows' `localhost` address order.
 *
 * The CLI intentionally binds local services to IPv4. On Windows, `localhost`
 * may resolve to `::1` first, while the service is only listening on
 * `127.0.0.1`. Keep the page's port so custom backend ports continue to work.
 *
 * The desktop shell is intentionally excluded: its local backend uses a free
 * port and supplies the exact URL through runtime-config.json. Guessing a fixed port
 * when that config is unavailable could connect to an unrelated process.
 */
export function getFallbackBackendBaseUrl(): string | null {
  if (import.meta.env.DEV || typeof window === "undefined" || isNativeApp()) return null;

  const { protocol, hostname, port } = window.location;
  const isLoopbackHostname =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]";

  if (!isLoopbackHostname || (protocol !== "http:" && protocol !== "https:")) return null;

  return `${protocol}//127.0.0.1${port ? `:${port}` : ""}`;
}

export function getConfiguredBackendBaseUrl(): string | null {
  const explicitBackendUrl = import.meta.env.VITE_BACKEND_URL as string | undefined;
  if (explicitBackendUrl) return explicitBackendUrl.replace(/\/+$/, "");

  if (typeof window !== "undefined") {
    const queryBackendUrl = new URLSearchParams(window.location.search).get("backend");
    if (queryBackendUrl) {
      const normalized = normalizeBackendBaseUrl(queryBackendUrl);
      window.localStorage.setItem("openfic.backendBaseUrl", normalized);
      return normalized;
    }

    const storedBackendUrl = window.localStorage.getItem("openfic.backendBaseUrl");
    if (storedBackendUrl) return normalizeBackendBaseUrl(storedBackendUrl);
  }

  return getFallbackBackendBaseUrl();
}

export function setConfiguredBackendBaseUrl(value: string): string {
  const normalized = normalizeBackendBaseUrl(value);
  const url = new URL(normalized);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Backend URL must use HTTP or HTTPS");
  }
  window.localStorage.setItem("openfic.backendBaseUrl", normalized);
  return normalized;
}
