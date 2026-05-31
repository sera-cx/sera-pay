export const DEVELOPMENT_APP_ORIGIN = "http://localhost:3000";
export const PRODUCTION_APP_ORIGIN = "https://pay.sera.cx";

export function normalizeOrigin(value: string | null | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    return url.origin;
  } catch {
    return "";
  }
}

export function isLocalAppOrigin(origin: string): boolean {
  try {
    const { hostname, protocol } = new URL(origin);
    return (protocol === "http:" || protocol === "https:") && ["localhost", "127.0.0.1", "::1"].includes(hostname);
  } catch {
    return false;
  }
}

export function resolveAppOrigin(options: {
  configuredOrigin?: string | null;
  nodeEnv?: string | null;
  fallbackOrigin?: string | null;
} = {}): string {
  const configured = normalizeOrigin(options.configuredOrigin);
  if (options.nodeEnv === "production" && isLocalAppOrigin(configured)) return PRODUCTION_APP_ORIGIN;
  if (configured) return configured;
  if (options.nodeEnv === "production") return PRODUCTION_APP_ORIGIN;
  return normalizeOrigin(options.fallbackOrigin) || DEVELOPMENT_APP_ORIGIN;
}

export function buildAppUrl(path = "/", origin = PRODUCTION_APP_ORIGIN): string {
  const normalizedOrigin = normalizeOrigin(origin) || PRODUCTION_APP_ORIGIN;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return new URL(normalizedPath, `${normalizedOrigin}/`).toString();
}

