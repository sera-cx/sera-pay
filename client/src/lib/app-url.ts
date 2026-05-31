import { buildAppUrl, resolveAppOrigin } from "@shared/app-url";

export function getClientAppOrigin(): string {
  return resolveAppOrigin({
    configuredOrigin: import.meta.env.VITE_APP_BASE_URL,
    nodeEnv: import.meta.env.PROD ? "production" : "development",
  });
}

export function buildClientAppUrl(path = "/"): string {
  return buildAppUrl(path, getClientAppOrigin());
}

export function getClientAppPath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
}
