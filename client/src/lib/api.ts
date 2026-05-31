const API_BASE = "/api";

export const DASHBOARD_API_KEY_STORAGE_KEY = "serapay_dashboard_apiKey";
export const DASHBOARD_WALLET_STORAGE_KEY = "serapay_dashboard_wallet";
export const DASHBOARD_AUTH_INVALID_EVENT = "serapay:dashboard-auth-invalid";
export const DASHBOARD_SESSION_EXPIRED_EVENT = "serapay:dashboard-session-expired";
export const DASHBOARD_SESSION_STARTED_STORAGE_KEY = "serapay_dashboard_sessionStartedAt";
export const DASHBOARD_SESSION_LAST_ACTIVE_STORAGE_KEY = "serapay_dashboard_lastActiveAt";
export const DASHBOARD_SESSION_IDLE_TIMEOUT_MS = 16 * 60 * 60 * 1000;
export const DASHBOARD_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

function readTimestamp(key: string): number | null {
  if (typeof window === "undefined") return null;
  const value = Number(localStorage.getItem(key));
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function hasStoredDashboardAuth(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(localStorage.getItem(DASHBOARD_API_KEY_STORAGE_KEY) || localStorage.getItem(DASHBOARD_WALLET_STORAGE_KEY));
}

export function clearStoredDashboardAuth(walletAddress?: string | null) {
  if (typeof window === "undefined") return;
  const storedWallet = walletAddress || localStorage.getItem(DASHBOARD_WALLET_STORAGE_KEY);
  if (storedWallet) localStorage.removeItem(`serapay_apikey_${storedWallet}`);
  localStorage.removeItem(DASHBOARD_API_KEY_STORAGE_KEY);
  localStorage.removeItem(DASHBOARD_WALLET_STORAGE_KEY);
  localStorage.removeItem(DASHBOARD_SESSION_STARTED_STORAGE_KEY);
  localStorage.removeItem(DASHBOARD_SESSION_LAST_ACTIVE_STORAGE_KEY);
}

export function isDashboardSessionExpired(now = Date.now()): boolean {
  if (!hasStoredDashboardAuth()) return false;
  const startedAt = readTimestamp(DASHBOARD_SESSION_STARTED_STORAGE_KEY);
  const lastActiveAt = readTimestamp(DASHBOARD_SESSION_LAST_ACTIVE_STORAGE_KEY);
  if (!startedAt || !lastActiveAt) return true;
  return now - startedAt > DASHBOARD_SESSION_MAX_AGE_MS || now - lastActiveAt > DASHBOARD_SESSION_IDLE_TIMEOUT_MS;
}

export function markDashboardSessionActive(now = Date.now()) {
  if (typeof window === "undefined" || !hasStoredDashboardAuth()) return;
  if (!readTimestamp(DASHBOARD_SESSION_STARTED_STORAGE_KEY)) {
    localStorage.setItem(DASHBOARD_SESSION_STARTED_STORAGE_KEY, String(now));
  }
  localStorage.setItem(DASHBOARD_SESSION_LAST_ACTIVE_STORAGE_KEY, String(now));
}

export function startDashboardSession(now = Date.now()) {
  if (typeof window === "undefined") return;
  localStorage.setItem(DASHBOARD_SESSION_STARTED_STORAGE_KEY, String(now));
  localStorage.setItem(DASHBOARD_SESSION_LAST_ACTIVE_STORAGE_KEY, String(now));
}

function notifyExpiredDashboardSession(message: string) {
  if (typeof window === "undefined") return;
  clearStoredDashboardAuth();
  window.dispatchEvent(new CustomEvent(DASHBOARD_SESSION_EXPIRED_EVENT, { detail: { message } }));
}

function notifyInvalidDashboardAuth(message: string) {
  if (typeof window === "undefined") return;
  const hadStoredAuth = hasStoredDashboardAuth();
  clearStoredDashboardAuth();
  if (!hadStoredAuth) return;
  window.dispatchEvent(new CustomEvent(DASHBOARD_AUTH_INVALID_EVENT, { detail: { message } }));
}

export async function fetchApi<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  if (isDashboardSessionExpired()) {
    notifyExpiredDashboardSession("Dashboard session expired. Please sign in again.");
    throw new ApiError(401, "Dashboard session expired. Please sign in again.");
  }
  const apiKey = typeof window !== "undefined" ? localStorage.getItem(DASHBOARD_API_KEY_STORAGE_KEY) : null;
  const headers = new Headers(options.headers);
  if (apiKey && !headers.has("x-api-key")) {
    headers.set("x-api-key", apiKey);
  }
  if (!headers.has("Content-Type") && !(options.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });
  if (!response.ok) {
    let errorMsg = "An error occurred";
    try {
      const errorData = await response.json();
      errorMsg = errorData.error || errorMsg;
    } catch {
      errorMsg = (await response.text()) || response.statusText;
    }
    if (response.status === 401 && /invalid api key|missing x-api-key/i.test(errorMsg)) {
      notifyInvalidDashboardAuth(errorMsg);
      errorMsg = "Dashboard session expired. Reconnecting your wallet workspace.";
    }
    throw new ApiError(response.status, errorMsg);
  }
  return response.json();
}
