import { v4 as uuidv4 } from "uuid";
import { createSeraApiRequestLog } from "./db";

export const DEFAULT_SERA_API_BASE_URL = "https://api.sera.cx/api/v1";
export const DEFAULT_SERA_API_TESTNET_BASE_URL = "https://api.testnet.sera.cx/api/v1";

export type SeraMode = "mock" | "test" | "live";
export type SeraAuthMode = "none" | "api_key" | "eip712";

export interface SeraToken {
  address: string;
  symbol: string;
  decimals: number;
  currency: string;
  min_trade_amount_raw: string;
  min_trade_amount: string;
}

export interface SeraMarket {
  symbol: string;
  base_address: string;
  quote_address: string;
  base_symbol: string;
  quote_symbol: string;
  tick_precision: number;
  quantity_precision: number;
  base_decimals: number;
  quote_decimals: number;
  min_ask_amount_raw: string;
  min_ask_amount: string;
  min_bid_quote_amount_raw: string;
  min_bid_quote_amount: string;
}

export interface SeraFxRate {
  pair: string;
  rate: string;
  as_of: number;
  rate_24h_ago: string | null;
  as_of_24h_ago: number | null;
  change_pct: string | null;
}

export interface SeraSystemSnapshot {
  mode: SeraMode;
  baseUrl: string;
  healthy: boolean;
  chainId: number | null;
  seraAddress: string | null;
  vaultAddress: string | null;
  sorAddress: string | null;
  message: string;
}

interface SeraRequestOptions {
  baseUrl?: string;
  path: string;
  method?: "GET" | "POST" | "DELETE";
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
  credential?: string | null;
  authMode?: SeraAuthMode;
  merchantId?: string | null;
  timeoutMs?: number;
  sensitiveRequest?: boolean;
  sensitiveResponse?: boolean;
}

export function normalizeSeraBaseUrl(value: string | null | undefined): string {
  const base = value?.trim() || DEFAULT_SERA_API_BASE_URL;
  return base.replace(/\/+$/, "");
}

function withTimeout(ms = 8_000): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  if (typeof timer === "object" && "unref" in timer) {
    timer.unref();
  }
  return controller.signal;
}

function buildQuery(query: SeraRequestOptions["query"]): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, String(value));
    }
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function redactedPayload(label: "request" | "response") {
  return { redacted: true, reason: `Sensitive Sera API ${label} omitted from logs` };
}

async function writeSeraApiLog(input: {
  merchantId?: string | null;
  baseUrl: string;
  path: string;
  method: string;
  authMode: SeraAuthMode;
  query?: Record<string, unknown>;
  body?: unknown;
  status?: number;
  response?: unknown;
  error?: string;
  durationMs: number;
}) {
  try {
    await createSeraApiRequestLog({
      id: uuidv4(),
      merchantId: input.merchantId ?? null,
      seraApiBaseUrl: input.baseUrl,
      endpoint: input.path,
      method: input.method,
      authMode: input.authMode,
      requestQuery: input.query ? JSON.stringify(input.query) : null,
      requestBody: input.body === undefined ? null : JSON.stringify(input.body),
      responseStatus: input.status ?? null,
      responseBody: input.response === undefined ? null : JSON.stringify(input.response),
      errorMessage: input.error ?? null,
      durationMs: input.durationMs,
    });
  } catch (error) {
    console.warn("[Sera API] Failed to write request log:", error);
  }
}

export async function callSeraApi<T>(options: SeraRequestOptions): Promise<T> {
  const baseUrl = normalizeSeraBaseUrl(options.baseUrl);
  const method = options.method ?? "GET";
  const authMode = options.authMode ?? (options.credential ? "api_key" : "none");
  const pathWithQuery = `${options.path}${buildQuery(options.query)}`;
  const startedAt = Date.now();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.credential) headers.Authorization = `Bearer ${options.credential}`;

  try {
    const response = await fetch(`${baseUrl}${pathWithQuery}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: withTimeout(options.timeoutMs),
    });
    const text = await response.text();
    const parsed = parseJson(text);
    const durationMs = Date.now() - startedAt;

    await writeSeraApiLog({
      merchantId: options.merchantId,
      baseUrl,
      path: options.path,
      method,
      authMode,
      query: options.query,
      body: options.sensitiveRequest && options.body !== undefined ? redactedPayload("request") : options.body,
      status: response.status,
      response: options.sensitiveResponse && parsed !== undefined ? redactedPayload("response") : parsed,
      durationMs,
    });

    if (!response.ok) {
      const message = typeof parsed === "object" && parsed && "detail" in parsed
        ? String((parsed as { detail: unknown }).detail)
        : text || response.statusText;
      throw new Error(`Sera API ${response.status}: ${message}`);
    }

    return parsed as T;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    await writeSeraApiLog({
      merchantId: options.merchantId,
      baseUrl,
      path: options.path,
      method,
      authMode,
      query: options.query,
      body: options.sensitiveRequest && options.body !== undefined ? redactedPayload("request") : options.body,
      error: error instanceof Error ? error.message : "Unknown Sera API error",
      durationMs,
    });
    throw error;
  }
}

export async function getSeraTokens(baseUrl?: string, merchantId?: string | null) {
  return callSeraApi<{ tokens: SeraToken[] }>({ baseUrl, path: "/tokens", merchantId });
}

export async function getSeraMarkets(baseUrl?: string, merchantId?: string | null) {
  return callSeraApi<{ markets: SeraMarket[] }>({ baseUrl, path: "/markets", merchantId });
}

export async function getSeraFxRate(baseUrl: string | undefined, base: string, quote: string, merchantId?: string | null) {
  return callSeraApi<SeraFxRate>({
    baseUrl,
    path: "/fx/rate",
    query: { base: base.toUpperCase(), quote: quote.toUpperCase() },
    merchantId,
  });
}

export async function getSeraSystemSnapshot(
  baseUrl = DEFAULT_SERA_API_BASE_URL,
  mode: SeraMode = "mock",
  merchantId?: string | null
): Promise<SeraSystemSnapshot> {
  const normalizedBaseUrl = normalizeSeraBaseUrl(baseUrl);
  if (mode === "mock") {
    return {
      mode,
      baseUrl: normalizedBaseUrl,
      healthy: true,
      chainId: 11155111,
      seraAddress: null,
      vaultAddress: null,
      sorAddress: null,
      message: "Mock mode is active. Live Sera API calls are disabled.",
    };
  }

  try {
    const [health, config] = await Promise.all([
      callSeraApi<{ status?: string }>({ baseUrl: normalizedBaseUrl, path: "/health", merchantId }),
      callSeraApi<{
        chain_id?: number;
        sera_address?: string | null;
        vault_address?: string | null;
        sor_address?: string | null;
      }>({ baseUrl: normalizedBaseUrl, path: "/config", merchantId }),
    ]);

    return {
      mode,
      baseUrl: normalizedBaseUrl,
      healthy: health.status === "healthy",
      chainId: config.chain_id ?? null,
      seraAddress: config.sera_address ?? null,
      vaultAddress: config.vault_address ?? null,
      sorAddress: config.sor_address ?? null,
      message: health.status === "healthy" ? "Sera API is healthy." : `Sera API status: ${health.status ?? "unknown"}`,
    };
  } catch (error) {
    return {
      mode,
      baseUrl: normalizedBaseUrl,
      healthy: false,
      chainId: null,
      seraAddress: null,
      vaultAddress: null,
      sorAddress: null,
      message: error instanceof Error ? error.message : "Unable to reach Sera API",
    };
  }
}

export async function verifySeraApiCredential(baseUrl: string, credential: string, merchantId?: string | null): Promise<{
  ok: boolean;
  ownerAddress?: string;
  message: string;
}> {
  const [apiKey, apiSecret] = credential.split(":");
  if (!apiKey || !apiSecret) {
    return {
      ok: false,
      message: "Sera REST API keys are documented as api_key:api_secret pairs.",
    };
  }

  try {
    const result = await callSeraApi<{ valid?: boolean; owner_address?: string }>(
      {
        baseUrl,
        path: "/api-keys/verify",
        method: "POST",
        body: { api_key: apiKey, api_secret: apiSecret },
        authMode: "none",
        merchantId,
        sensitiveRequest: true,
      }
    );
    return {
      ok: result.valid === true,
      ownerAddress: result.owner_address,
      message: result.valid ? "Sera API key verified." : "Sera API key was not accepted.",
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Unable to verify Sera API key",
    };
  }
}
