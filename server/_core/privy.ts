import type { NextFunction, Request, Response } from "express";
import { createLocalJWKSet, createRemoteJWKSet, importSPKI, jwtVerify, type JWTPayload } from "jose";
import type { User } from "../../drizzle/schema";
import * as db from "../db";
import { ENV } from "./env";

type PrivyAuthErrorCode = "PRIVY_CONFIG_MISSING" | "PRIVY_TOKEN_MISSING" | "PRIVY_TOKEN_INVALID" | "PRIVY_WALLET_MISMATCH" | "PRIVY_USER_LOOKUP_FAILED";

export class PrivyAuthError extends Error {
  constructor(message: string, public code: PrivyAuthErrorCode, public status = 401) {
    super(message);
    this.name = "PrivyAuthError";
  }
}

export type PrivyIdentity = {
  userId: string;
  appId: string | null;
  email: string | null;
  name: string | null;
  walletAddresses: string[];
  walletRecords: PrivyWalletRecord[];
  payload: JWTPayload;
};

export type PrivyWalletRecord = {
  address: string;
  walletType: string;
  isPrivyWallet: boolean;
};

export type PrivyWalletOwnership = {
  walletAddress: string;
  userWallet: string;
  privyWallet: string | null;
  walletType: string;
};

let cachedRemoteJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let cachedRemoteJwksUrl = "";
let cachedLocalJwks: ReturnType<typeof createLocalJWKSet> | null = null;
let cachedLocalJwksSource = "";
let cachedVerificationKey: unknown = null;
let cachedVerificationKeySource = "";

function getBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header || !header.toLowerCase().startsWith("bearer ")) return null;
  const token = header.slice("bearer ".length).trim();
  return token || null;
}

function getJwksUrl(): string {
  if (!ENV.privyAppId) return "";
  return `https://auth.privy.io/api/v1/apps/${ENV.privyAppId}/jwks.json`;
}

function hasConfiguredVerificationKey(): boolean {
  return Boolean(ENV.privyJwks.trim());
}

function shouldRetryWithRemoteJwks(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no applicable key|jwks|jwk|key set|kid/i.test(message);
}

function getRemoteVerificationKey() {
  const jwksUrl = getJwksUrl();
  if (!jwksUrl) {
    throw new PrivyAuthError("Privy JWKS URL or verification key is not configured", "PRIVY_CONFIG_MISSING", 503);
  }

  if (!cachedRemoteJwks || cachedRemoteJwksUrl !== jwksUrl) {
    cachedRemoteJwks = createRemoteJWKSet(new URL(jwksUrl));
    cachedRemoteJwksUrl = jwksUrl;
  }
  return cachedRemoteJwks;
}

async function getVerificationKey() {
  const configuredJwks = ENV.privyJwks.trim();
  if (configuredJwks) {
    if (/^https?:\/\//i.test(configuredJwks)) {
      if (!cachedRemoteJwks || cachedRemoteJwksUrl !== configuredJwks) {
        cachedRemoteJwks = createRemoteJWKSet(new URL(configuredJwks));
        cachedRemoteJwksUrl = configuredJwks;
      }
      return cachedRemoteJwks;
    }

    if (configuredJwks.startsWith("{")) {
      if (!cachedLocalJwks || cachedLocalJwksSource !== configuredJwks) {
        cachedLocalJwks = createLocalJWKSet(JSON.parse(configuredJwks));
        cachedLocalJwksSource = configuredJwks;
      }
      return cachedLocalJwks;
    }

    const source = configuredJwks;
    if (cachedVerificationKey && cachedVerificationKeySource === source) return cachedVerificationKey;
    cachedVerificationKey = await importSPKI(source.replace(/\\n/g, "\n"), "ES256");
    cachedVerificationKeySource = source;
    return cachedVerificationKey;
  }

  return getRemoteVerificationKey();
}

function getVerificationOptions() {
  const audience = [ENV.privyAppId, ENV.privyClientId].filter(Boolean);
  const issuer = ENV.privyJwtIssuer
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);

  return {
    ...(audience.length > 0 ? { audience } : {}),
    ...(issuer.length > 0 ? { issuer } : {}),
  };
}

function normalizeAddress(value: string): string | null {
  return /^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : null;
}

function getStringValue(value: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const item = value[key];
    if (typeof item === "string" && item.trim()) return item.trim();
  }
  return "";
}

function toWalletRecord(value: unknown): PrivyWalletRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const address = normalizeAddress(getStringValue(record, ["address", "wallet_address", "walletAddress"]));
  if (!address) return null;

  const type = getStringValue(record, ["type", "chain_type", "chainType"]);
  const client = getStringValue(record, ["wallet_client_type", "walletClientType", "connector_type", "connectorType", "wallet_client", "walletClient"]);
  const marker = `${type} ${client}`.toLowerCase();
  const isWalletLike = /wallet|ethereum|evm|solana/.test(marker) || Boolean(client);
  if (!isWalletLike) return null;

  const isPrivyWallet = /embedded|privy/.test(marker);
  const walletType = isPrivyWallet ? "privy" : (client || type || "external").toLowerCase();
  return { address, walletType, isPrivyWallet };
}

function collectWalletRecords(value: unknown, depth = 0, seen = new Set<unknown>()): PrivyWalletRecord[] {
  if (depth > 5 || value === null || value === undefined || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);

  const records: PrivyWalletRecord[] = [];
  const ownRecord = toWalletRecord(value);
  if (ownRecord) records.push(ownRecord);

  if (Array.isArray(value)) {
    for (const item of value) records.push(...collectWalletRecords(item, depth + 1, seen));
  } else {
    for (const item of Object.values(value as Record<string, unknown>)) {
      if (item && typeof item === "object") records.push(...collectWalletRecords(item, depth + 1, seen));
    }
  }

  const unique = new Map<string, PrivyWalletRecord>();
  for (const record of records) {
    const existing = unique.get(record.address);
    if (!existing || (existing.isPrivyWallet && !record.isPrivyWallet)) unique.set(record.address, record);
  }
  return Array.from(unique.values());
}

function collectWalletAddresses(value: unknown, depth = 0, seen = new Set<unknown>()): string[] {
  if (depth > 5 || value === null || value === undefined) return [];
  if (typeof value === "string") {
    const normalized = normalizeAddress(value);
    return normalized ? [normalized] : [];
  }
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);

  const addresses: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) addresses.push(...collectWalletAddresses(item, depth + 1, seen));
  } else {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key.toLowerCase().includes("address") || key.toLowerCase().includes("wallet") || typeof item === "object") {
        addresses.push(...collectWalletAddresses(item, depth + 1, seen));
      }
    }
  }

  return Array.from(new Set(addresses));
}

function getStringClaim(payload: JWTPayload, keys: string[]): string | null {
  for (const key of keys) {
    const value = (payload as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function normalizePrivyDisplayName(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return /^0x[0-9a-fA-F]{4}\.\.\.[0-9a-fA-F]{4}$/.test(trimmed) || /^0x[0-9a-fA-F]{40}$/.test(trimmed)
    ? "My Store"
    : trimmed;
}

export async function verifyPrivyAccessToken(token: string): Promise<PrivyIdentity> {
  if (!ENV.privyAppId) {
    throw new PrivyAuthError("Privy App ID is not configured", "PRIVY_CONFIG_MISSING", 503);
  }

  try {
    const key = await getVerificationKey();
    const { payload } = await jwtVerify(token, key as never, getVerificationOptions());
    return buildPrivyIdentity(payload);
  } catch (error) {
    if (error instanceof PrivyAuthError) throw error;
    if (hasConfiguredVerificationKey() && shouldRetryWithRemoteJwks(error)) {
      try {
        const key = getRemoteVerificationKey();
        const { payload } = await jwtVerify(token, key as never, getVerificationOptions());
        return buildPrivyIdentity(payload);
      } catch (remoteError) {
        console.warn("[Privy] JWT remote JWKS fallback failed", { message: remoteError instanceof Error ? remoteError.message : String(remoteError) });
      }
    }
    console.warn("[Privy] JWT verification failed", { message: error instanceof Error ? error.message : String(error) });
    throw new PrivyAuthError("Invalid Privy access token", "PRIVY_TOKEN_INVALID", 401);
  }
}

function buildPrivyIdentity(payload: JWTPayload): PrivyIdentity {
  const userId = typeof payload.sub === "string" ? payload.sub : getStringClaim(payload, ["userId", "user_id"]);
  if (!userId) throw new PrivyAuthError("Privy token is missing subject", "PRIVY_TOKEN_INVALID", 401);
  const walletRecords = collectWalletRecords(payload);

  return {
    userId,
    appId: getStringClaim(payload, ["aud", "appId", "app_id"]),
    email: getStringClaim(payload, ["email"]),
    name: normalizePrivyDisplayName(getStringClaim(payload, ["name"])),
    walletAddresses: Array.from(new Set([...walletRecords.map(record => record.address), ...collectWalletAddresses(payload)])),
    walletRecords,
    payload,
  };
}

export async function verifyPrivyRequest(req: Request): Promise<PrivyIdentity> {
  const token = getBearerToken(req);
  if (!token) throw new PrivyAuthError("Missing Authorization bearer token", "PRIVY_TOKEN_MISSING", 401);
  return verifyPrivyAccessToken(token);
}

async function fetchPrivyUser(identity: PrivyIdentity): Promise<unknown> {
  if (!ENV.privyAppSecret) {
    throw new PrivyAuthError("PRIVY_SECRET is required to verify wallet ownership", "PRIVY_CONFIG_MISSING", 503);
  }

  const basicAuth = Buffer.from(`${ENV.privyAppId}:${ENV.privyAppSecret}`).toString("base64");
  const response = await fetch(`https://api.privy.io/v1/users/${encodeURIComponent(identity.userId)}`, {
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "privy-app-id": ENV.privyAppId,
    },
  });

  if (!response.ok) {
    console.warn("[Privy] User lookup failed", { status: response.status, userId: identity.userId });
    throw new PrivyAuthError("Privy user lookup failed", "PRIVY_USER_LOOKUP_FAILED", 502);
  }

  return response.json();
}

function walletOwnershipFromRecords(records: PrivyWalletRecord[], walletAddress: string): PrivyWalletOwnership | null {
  const normalized = normalizeAddress(walletAddress);
  if (!normalized) return null;
  const userWallet = records.find(record => record.address === normalized && !record.isPrivyWallet)
    ?? records.find(record => record.address === normalized);
  if (!userWallet) return null;
  const privyWallet = records.find(record => record.isPrivyWallet)?.address ?? null;
  return {
    walletAddress: normalized,
    userWallet: normalized,
    privyWallet,
    walletType: userWallet.isPrivyWallet ? "privy" : userWallet.walletType,
  };
}

export function getPrivyWalletSummary(identity: PrivyIdentity): Pick<PrivyWalletOwnership, "privyWallet" | "walletType"> {
  const privyWallet = identity.walletRecords.find(record => record.isPrivyWallet)?.address ?? null;
  const externalWallet = identity.walletRecords.find(record => !record.isPrivyWallet);
  return {
    privyWallet,
    walletType: externalWallet?.walletType ?? (privyWallet ? "privy" : "unknown"),
  };
}

export async function assertPrivyWalletOwnership(identity: PrivyIdentity, walletAddress: string): Promise<PrivyWalletOwnership> {
  const normalized = normalizeAddress(walletAddress);
  if (!normalized) throw new PrivyAuthError("Invalid wallet address", "PRIVY_WALLET_MISMATCH", 403);

  const tokenOwnership = walletOwnershipFromRecords(identity.walletRecords, normalized);
  if (tokenOwnership) return tokenOwnership;
  if (identity.walletAddresses.includes(normalized)) {
    const summary = getPrivyWalletSummary(identity);
    return {
      walletAddress: normalized,
      userWallet: normalized,
      privyWallet: summary.privyWallet,
      walletType: summary.privyWallet === normalized ? "privy" : summary.walletType,
    };
  }

  const privyUser = await fetchPrivyUser(identity);
  const remoteRecords = collectWalletRecords(privyUser);
  const remoteOwnership = walletOwnershipFromRecords(remoteRecords, normalized);
  if (remoteOwnership) return remoteOwnership;
  const remoteWallets = Array.from(new Set([...remoteRecords.map(record => record.address), ...collectWalletAddresses(privyUser)]));
  if (remoteWallets.includes(normalized)) {
    const privyWallet = remoteRecords.find(record => record.isPrivyWallet)?.address ?? getPrivyWalletSummary(identity).privyWallet;
    return {
      walletAddress: normalized,
      userWallet: normalized,
      privyWallet,
      walletType: privyWallet === normalized ? "privy" : "external",
    };
  }

  console.warn("[Privy] Wallet ownership mismatch", { userId: identity.userId, walletAddress: normalized });
  throw new PrivyAuthError("Wallet address is not linked to the authenticated Privy user", "PRIVY_WALLET_MISMATCH", 403);
}

export async function authenticatePrivyRequest(req: Request): Promise<User> {
  const identity = await verifyPrivyRequest(req);
  const signedInAt = new Date();

  await db.upsertUser({
    openId: identity.userId,
    name: undefined,
    email: identity.email,
    loginMethod: "privy",
    privyWallet: getPrivyWalletSummary(identity).privyWallet,
    userWallet: identity.walletRecords.find(record => !record.isPrivyWallet)?.address ?? null,
    walletType: getPrivyWalletSummary(identity).walletType,
    lastSignedIn: signedInAt,
  });

  const user = await db.getUserByOpenId(identity.userId);
  if (!user) throw new PrivyAuthError("Authenticated user is not available", "PRIVY_TOKEN_INVALID", 401);
  return user;
}

export function sendPrivyAuthError(res: Response, error: unknown): void {
  if (error instanceof PrivyAuthError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  console.error("[Privy] Authentication error", error);
  res.status(500).json({ error: "Authentication failed" });
}

export async function requirePrivyAuth(req: Request, res: Response, next: NextFunction) {
  try {
    (req as Request & { privy: PrivyIdentity }).privy = await verifyPrivyRequest(req);
    next();
  } catch (error) {
    sendPrivyAuthError(res, error);
  }
}
