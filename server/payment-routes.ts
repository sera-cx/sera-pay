/**
 * SeraPay Payment API Routes
 * Registered under /api/ in server/_core/index.ts
 */
import { Router, Request, Response } from "express";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import { createPublicClient, fallback, http, webSocket, parseAbi, parseAbiItem, decodeEventLog, keccak256, toHex, encodeAbiParameters, parseAbiParameters, verifyMessage } from "viem";
import { sepolia, mainnet } from "viem/chains";
import {
  getMerchantByWallet,
  getMerchantByStoreAddress,
  getMerchantByApiKey,
  getMerchantById,
  createMerchant,
  updateMerchant,
  updateUserNameByWallet,
  upsertUser,
  createTransaction,
  getTransactionById,
  getTransactionByHash,
  updateTransaction,
  getMerchantTransactions,
  getPendingTransactions,
  createWebhookLog,
  getMerchantWebhookLogs,
  getTransactionsByFromAddress,
  listSubWallets,
  getSubWalletByAddress,
  getApiKeyConfigRecord,
  updatePaymentIntent,
  updateMenuOrderPayment,
} from "./db";
import { screenWalletAddress } from "./compliance";
import { ENV } from "./_core/env";
import { PrivyAuthError, assertPrivyWalletOwnership, getPrivyWalletSummary, sendPrivyAuthError, verifyPrivyRequest, type PrivyIdentity, type PrivyWalletOwnership } from "./_core/privy";
import { isR2StorageConfigured, storagePut, storageRead } from "./storage";
import { decryptSecret } from "./secret-vault";
import { hashSeraIntentStruct, SERA_INTENT_TYPES, type SeraIntentMessage } from "./sera-intent";
import {
  DEFAULT_SERA_API_BASE_URL,
  DEFAULT_SERA_API_TESTNET_BASE_URL,
  SeraApiError,
  callSeraApi,
  getSeraTokens,
  normalizeSeraBaseUrl,
  type SeraToken,
} from "./sera-api";
import type { Merchant, Transaction } from "../drizzle/schema";

export const paymentRouter = Router();

const PUBLIC_STORAGE_PREFIXES = ["merchant-logos/", "menu-items/", "generated/"];
const PENDING_TRANSACTION_CANCEL_AFTER_MS = 5 * 60 * 1000;
const SERA_TESTNET_CHAIN_ID = sepolia.id;
const SERA_MAINNET_CHAIN_ID = mainnet.id;
const COIN_SYMBOL_RE = /^[A-Z0-9]{2,20}$/;

function getSeraApiBaseUrlForChain(chainId?: number | null): string {
  const baseUrl = chainId === SERA_TESTNET_CHAIN_ID
    ? ENV.seraApiTestnetBaseUrl || DEFAULT_SERA_API_TESTNET_BASE_URL
    : ENV.seraApiBaseUrl || DEFAULT_SERA_API_BASE_URL;
  return normalizeSeraBaseUrl(baseUrl);
}

function transactionToJson(tx: Transaction) {
  let meta: any = null;
  if (typeof tx.notes === "string" && tx.notes.trim().startsWith("{")) {
    try { meta = JSON.parse(tx.notes); } catch {}
  }
  return {
    ...tx,
    paymentUrl: typeof meta?.paymentUrl === "string" ? meta.paymentUrl : null,
    orderId: typeof meta?.orderId === "string" ? meta.orderId : null,
    paymentIntentId: typeof meta?.paymentIntentId === "string" ? meta.paymentIntentId : null,
    quoteUuid: typeof meta?.quoteUuid === "string" ? meta.quoteUuid : null,
    paymentSource: typeof meta?.source === "string"
      ? meta.source
      : typeof meta?.type === "string"
        ? meta.type
        : null,
  };
}

function getTransactionVolumeValue(tx: Transaction): number {
  const preferredValue = tx.amountUsd ?? tx.amount;
  const parsed = Number(preferredValue);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

paymentRouter.get("/storage/objects/*", async (req, res) => {
  try {
    const key = String((req.params as Record<string, string | undefined>)[0] || "").replace(/^\/+/, "");
    if (!PUBLIC_STORAGE_PREFIXES.some(prefix => key.startsWith(prefix))) {
      res.status(404).json({ error: "Object not found" }); return;
    }

    const object = await storageRead(key);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.type(object.contentType);
    res.send(object.body);
  } catch (error) {
    console.error("[Storage] Failed to read object");
    res.status(404).json({ error: "Object not found" });
  }
});

// ─── Constants ────────────────────────────────────────────────────────────────

const VALID_QR_MODES = new Set(["standard", "advanced"]);

type SeraRouteParams = SeraIntentMessage;

type SeraSwapQuote = {
  uuid?: string | number;
  route_params?: SeraRouteParams;
  routeParams?: SeraRouteParams;
  permit?: unknown;
  expires_at?: string | number;
  [key: string]: unknown;
};

type SeraConfigResponse = {
  chain_id?: number;
  sera_address?: string;
  vault_address?: string;
  sor_address?: string;
  eip712_domain?: Record<string, unknown>;
};

type SeraSystemTimeResponse = {
  timestamp?: number;
};

async function getSeraServerTimestamp(baseUrl: string, merchantId?: string | null): Promise<number> {
  const response = await callSeraApi<SeraSystemTimeResponse>({
    baseUrl,
    path: "/system/time",
    authMode: "none",
    merchantId,
  });
  const timestamp = Number(response.timestamp);
  if (!Number.isInteger(timestamp) || timestamp <= 0) {
    throw new Error("Sera /system/time did not return a valid timestamp");
  }
  return timestamp;
}

// In-memory SSE clients: txId → Set<Response>
const sseClients = new Map<string, Set<Response>>();
const transactionVerificationInFlight = new Set<string>();

function notifySseClients(txId: string, data: object) {
  const clients = sseClients.get(txId);
  if (!clients) return;
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of Array.from(clients)) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
}

// ─── Auth middleware ──────────────────────────────────────────────────────────

export async function requireApiKey(req: Request, res: Response, next: Function) {
  try {
    const apiKey = req.headers["x-api-key"] as string;
    if (!apiKey) { res.status(401).json({ error: "Missing X-Api-Key header" }); return; }
    const merchant = await getMerchantByApiKey(apiKey);
    if (!merchant) { res.status(401).json({ error: "Invalid API key" }); return; }
    (req as any).merchant = merchant;
    next();
  } catch (error) {
    // Express 4 does not automatically catch rejected async middleware. A
    // transient database timeout must return an error, not kill the process.
    console.error("[auth] Unable to validate API key");
    if (!res.headersSent) {
      res.status(503).json({ error: "Database is temporarily unavailable. Please retry." });
    }
  }
}

// ─── Merchant endpoints ───────────────────────────────────────────────────────

type RegistrationWalletProof = {
  message?: unknown;
  signature?: unknown;
  timestamp?: unknown;
  walletType?: unknown;
};

function normalizeWalletType(value: unknown) {
  if (typeof value !== "string") return "external";
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32);
  return normalized || "external";
}

function buildRegistrationMessage(walletAddress: string, privyUserId: string, timestamp: string) {
  return [
    "SeraPay wallet registration",
    `Wallet: ${walletAddress.toLowerCase()}`,
    `Privy user: ${privyUserId}`,
    `Timestamp: ${timestamp}`,
  ].join("\n");
}

async function verifyRegistrationWalletProof(
  identity: PrivyIdentity,
  walletAddress: string,
  proof: RegistrationWalletProof | undefined,
): Promise<PrivyWalletOwnership | null> {
  if (!proof || typeof proof.message !== "string" || typeof proof.signature !== "string" || typeof proof.timestamp !== "string") return null;
  const normalized = walletAddress.toLowerCase();
  const expectedMessage = buildRegistrationMessage(normalized, identity.userId, proof.timestamp);
  if (proof.message !== expectedMessage) throw new PrivyAuthError("Invalid wallet registration message", "PRIVY_WALLET_MISMATCH", 403);

  const signedAt = Date.parse(proof.timestamp);
  if (!Number.isFinite(signedAt) || Math.abs(Date.now() - signedAt) > 5 * 60_000) {
    throw new PrivyAuthError("Wallet registration signature has expired", "PRIVY_WALLET_MISMATCH", 403);
  }

  const valid = await verifyMessage({
    address: normalized as `0x${string}`,
    message: proof.message,
    signature: proof.signature as `0x${string}`,
  });
  if (!valid) throw new PrivyAuthError("Wallet signature does not match the selected wallet", "PRIVY_WALLET_MISMATCH", 403);

  const summary = getPrivyWalletSummary(identity);
  return {
    walletAddress: normalized,
    userWallet: normalized,
    privyWallet: summary.privyWallet,
    walletType: normalizeWalletType(proof.walletType) || summary.walletType,
  };
}

/** POST /api/merchant/register */
paymentRouter.post("/merchant/register", async (req, res) => {
  try {
    const identity = await verifyPrivyRequest(req);
    const { walletAddress, name: rawName, walletProof } = req.body;
    if (!walletAddress || typeof walletAddress !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(walletAddress)) {
      res.status(400).json({ error: "Invalid walletAddress" }); return;
    }
    // Name is optional — fall back to a wallet-derived placeholder
    const addr = walletAddress.toLowerCase();
    const fallbackName = addr.slice(0, 6) + "..." + addr.slice(-4);
    const name = (typeof rawName === "string" && rawName.trim().length > 0)
      ? rawName.trim().slice(0, 120)
      : fallbackName;
    const proofOwnership = await verifyRegistrationWalletProof(identity, addr, walletProof);
    const walletOwnership = proofOwnership ?? await assertPrivyWalletOwnership(identity, addr);
    await upsertUser({
      openId: identity.userId,
      name,
      email: identity.email,
      loginMethod: "privy",
      privyWallet: walletOwnership.privyWallet,
      userWallet: walletOwnership.userWallet,
      walletType: walletOwnership.walletType,
      lastSignedIn: new Date(),
    });
    const compliance = await screenWalletAddress(addr, "merchant_wallet");
    if (compliance.blocked) {
      res.status(403).json({ error: "Wallet address failed compliance screening", compliance });
      return;
    }
    const existing = await getMerchantByWallet(addr);
    if (existing) {
      if (existing.name === fallbackName && name !== fallbackName) {
        await updateMerchant(existing.id, { name });
        existing.name = name;
      }
      res.json({ id: existing.id, userId: identity.userId, walletAddress: existing.walletAddress, name: existing.name, apiKey: existing.apiKey, isNew: false });
      return;
    }
    const id = uuidv4();
    const apiKey = "sk_" + crypto.randomBytes(32).toString("hex");
    await createMerchant({ id, walletAddress: addr, name: name.trim(), apiKey, receiveCoin: "USDC" });
    res.json({ id, userId: identity.userId, walletAddress: addr, name: name.trim(), apiKey, isNew: true });
  } catch (e) {
    if (e instanceof PrivyAuthError) { sendPrivyAuthError(res, e); return; }
    logSeraOperationFailure("payment-route", e); res.status(500).json({ error: "Internal server error" });
  }
});

const LOGO_DATA_URI_RE = /^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,([A-Za-z0-9+/=]+)$/;
const LOGO_URL_RE = /^https:\/\/[\w.-]+(?:\/[\w./%+~-]*)?(?:\?[\w=&.%+-]*)?$/;
const MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024;

async function normalizeLogoDataInput(logoData: unknown, merchantId: string): Promise<string | null> {
  if (logoData === null || logoData === "") return null;
  if (typeof logoData !== "string") throw new Error("Invalid logoData: must be an image data URI or HTTPS URL");
  if (LOGO_URL_RE.test(logoData)) return logoData.slice(0, 2048);

  const match = logoData.match(LOGO_DATA_URI_RE);
  if (!match) throw new Error("Invalid logoData: must be a valid image data URI or HTTPS URL");
  const buffer = Buffer.from(match[2], "base64");
  if (buffer.length > MAX_IMAGE_UPLOAD_BYTES) throw new Error("Invalid logoData: max 10 MB");
  if (!isR2StorageConfigured()) return logoData;

  const mimeSubtype = match[1];
  const contentType = `image/${mimeSubtype}`;
  const fileKey = `merchant-logos/${merchantId}/logo`;
  const { url } = await storagePut(fileKey, buffer, contentType);
  return `${url}?v=${Date.now()}`;
}

paymentRouter.get("/auth/session", async (req, res) => {
  try {
    const identity = await verifyPrivyRequest(req);
    res.json({
      authenticated: true,
      userId: identity.userId,
      email: identity.email,
      name: identity.name,
      walletAddresses: identity.walletAddresses,
    });
  } catch (error) {
    sendPrivyAuthError(res, error);
  }
});

paymentRouter.post("/auth/logout", (_req, res) => {
  res.json({ success: true });
});

/** GET /api/merchant/public/:address or /api/merchant/public?address=0x... */
paymentRouter.get("/merchant/public/:address?", async (req, res) => {
  try {
    const address = ((req.params.address || req.query.address) as string)?.toLowerCase();
    if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      res.status(400).json({ error: "Invalid address" }); return;
    }
    let resolved: Awaited<ReturnType<typeof resolvePaymentMerchant>>;
    try {
      resolved = await resolvePaymentMerchant(address);
    } catch {
      res.status(404).json({ error: "Merchant not found" }); return;
    }
    const { merchant } = resolved;
    // Cache public merchant profile for 60 seconds at CDN/proxy level
    res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=120");
    res.json({
      name: merchant.name,
      description: (merchant as any).description,
      logoData: merchant.logoData,
      receiveCoin: merchant.receiveCoin,
      storeAddress: merchant.storeAddress,
      qrFgColor: merchant.qrFgColor,
      qrBgColor: merchant.qrBgColor,
      qrStyle: merchant.qrStyle,
      qrMode: (merchant as any).qrMode || "standard",
    });
  } catch (e) { logSeraOperationFailure("payment-route", e); res.status(500).json({ error: "Internal server error" }); }
});

/** PUT /api/merchant/settings — update merchant profile */
paymentRouter.put("/merchant/settings", requireApiKey as any, async (req: any, res) => {
  try {
    const merchant = req.merchant;
    const { name, description, receiveCoin, logoData, webhookUrl, webhookSecret, storeAddress, qrFgColor, qrBgColor, qrStyle, qrMode } = req.body;
    const updates: Record<string, any> = {};
    if (name !== undefined) {
      if (typeof name !== "string" || name.trim().length < 1 || name.length > 120) { res.status(400).json({ error: "Invalid name" }); return; }
      updates.name = name.trim();
    }
    if (description !== undefined) {
      if (description !== null && typeof description !== "string") { res.status(400).json({ error: "Invalid description" }); return; }
      updates.description = description?.trim()?.slice(0, 500) || null;
    }
    if (receiveCoin !== undefined) {
      if (typeof receiveCoin !== "string" || !COIN_SYMBOL_RE.test(receiveCoin)) { res.status(400).json({ error: "Invalid receiveCoin" }); return; }
      updates.receiveCoin = receiveCoin;
    }
    if (logoData !== undefined) {
      try {
        updates.logoData = await normalizeLogoDataInput(logoData, merchant.id);
      } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : "Invalid logoData" }); return;
      }
    }
    if (webhookUrl !== undefined) {
      if (webhookUrl !== null && (typeof webhookUrl !== "string" || webhookUrl.length > 512 || !/^https:\/\//.test(webhookUrl))) {
        res.status(400).json({ error: "webhookUrl must be an HTTPS URL" }); return;
      }
      updates.webhookUrl = webhookUrl;
    }
    if (webhookSecret !== undefined) updates.webhookSecret = webhookSecret?.slice(0, 64) || null;
    if (storeAddress !== undefined) {
      if (storeAddress !== null && !/^0x[0-9a-fA-F]{40}$/.test(storeAddress)) { res.status(400).json({ error: "Invalid storeAddress" }); return; }
      if (storeAddress) {
        const compliance = await screenWalletAddress(storeAddress, "recipient_wallet", merchant.id);
        if (compliance.blocked) {
          res.status(403).json({ error: "Store address failed compliance screening", compliance });
          return;
        }
      }
      updates.storeAddress = storeAddress?.toLowerCase() || null;
    }
    if (qrFgColor !== undefined) updates.qrFgColor = qrFgColor?.slice(0, 9) || null;
    if (qrBgColor !== undefined) updates.qrBgColor = qrBgColor?.slice(0, 9) || null;
    if (qrStyle !== undefined) updates.qrStyle = qrStyle?.slice(0, 20) || null;
    if (qrMode !== undefined) {
      if (qrMode !== null && (typeof qrMode !== "string" || !VALID_QR_MODES.has(qrMode))) { res.status(400).json({ error: "Invalid qrMode" }); return; }
      updates.qrMode = qrMode || "standard";
    }
    await updateMerchant(merchant.id, updates);
    if (typeof updates.name === "string") await updateUserNameByWallet(merchant.walletAddress, updates.name);
    const updated = await getMerchantById(merchant.id);
    res.json(updated || { success: true });
  } catch (e) { logSeraOperationFailure("payment-route", e); res.status(500).json({ error: "Internal server error" }); }
});

/** GET /api/merchant/me — get merchant profile */
paymentRouter.get("/merchant/me", requireApiKey as any, async (req: any, res) => {
  const m = req.merchant;
  res.json({ id: m.id, walletAddress: m.walletAddress, name: m.name, description: (m as any).description, receiveCoin: m.receiveCoin, logoData: m.logoData, webhookUrl: m.webhookUrl, storeAddress: m.storeAddress, qrFgColor: m.qrFgColor, qrBgColor: m.qrBgColor, qrStyle: (m as any).qrStyle, qrMode: (m as any).qrMode || "standard", createdAt: m.createdAt, updatedAt: m.updatedAt });
});

/** GET /api/merchant/profile — alias for /merchant/me (used by dashboard) */
paymentRouter.get("/merchant/profile", requireApiKey as any, async (req: any, res) => {
  const m = req.merchant;
  res.json({ id: m.id, walletAddress: m.walletAddress, name: m.name, description: (m as any).description, receiveCoin: m.receiveCoin, logoData: m.logoData, webhookUrl: m.webhookUrl, storeAddress: m.storeAddress, qrFgColor: m.qrFgColor, qrBgColor: m.qrBgColor, qrStyle: (m as any).qrStyle, qrMode: (m as any).qrMode || "standard", createdAt: m.createdAt, updatedAt: m.updatedAt });
});

/** PUT /api/merchant/profile — update profile (used by dashboard Settings page) */
paymentRouter.put("/merchant/profile", requireApiKey as any, async (req: any, res) => {
  try {
    const merchant = req.merchant;
    const { name, description, receiveCoin, logoData, webhookUrl, storeAddress, qrFgColor, qrBgColor, qrStyle, qrMode } = req.body;
    const updates: Record<string, any> = {};
    if (name !== undefined) {
      if (typeof name !== "string" || name.trim().length < 1 || name.length > 120) { res.status(400).json({ error: "Invalid name" }); return; }
      updates.name = name.trim();
    }
    if (description !== undefined) {
      if (description !== null && typeof description !== "string") { res.status(400).json({ error: "Invalid description" }); return; }
      updates.description = description?.trim()?.slice(0, 500) || null;
    }
    if (receiveCoin !== undefined) {
      if (receiveCoin !== null && (typeof receiveCoin !== "string" || !COIN_SYMBOL_RE.test(receiveCoin))) {
        res.status(400).json({ error: "Invalid receiveCoin" }); return;
      }
      updates.receiveCoin = receiveCoin || null;
    }
    if (logoData !== undefined) {
      try {
        updates.logoData = await normalizeLogoDataInput(logoData, merchant.id);
      } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : "Invalid logoData" }); return;
      }
    }
    if (webhookUrl !== undefined) {
      if (webhookUrl !== null && (typeof webhookUrl !== "string" || !/^https:\/\//.test(webhookUrl))) { res.status(400).json({ error: "webhookUrl must be HTTPS" }); return; }
      updates.webhookUrl = webhookUrl;
    }
    if (storeAddress !== undefined) {
      if (storeAddress !== null && storeAddress && !/^0x[0-9a-fA-F]{40}$/.test(storeAddress)) {
        res.status(400).json({ error: "Invalid storeAddress" }); return;
      }
      if (storeAddress) {
        const compliance = await screenWalletAddress(storeAddress, "recipient_wallet", merchant.id);
        if (compliance.blocked) {
          res.status(403).json({ error: "Store address failed compliance screening", compliance });
          return;
        }
      }
      updates.storeAddress = storeAddress?.toLowerCase() || null;
    }
    if (qrFgColor !== undefined) updates.qrFgColor = qrFgColor?.slice(0, 9) || null;
    if (qrBgColor !== undefined) updates.qrBgColor = qrBgColor?.slice(0, 9) || null;
    if (qrStyle !== undefined) updates.qrStyle = qrStyle?.slice(0, 20) || null;
    if (qrMode !== undefined) {
      if (qrMode !== null && (typeof qrMode !== "string" || !VALID_QR_MODES.has(qrMode))) { res.status(400).json({ error: "Invalid qrMode" }); return; }
      updates.qrMode = qrMode || "standard";
    }
    await updateMerchant(merchant.id, updates);
    if (typeof updates.name === "string") await updateUserNameByWallet(merchant.walletAddress, updates.name);
    const updated = await getMerchantById(merchant.id);
    res.json(updated);
  } catch (e) { logSeraOperationFailure("payment-route", e); res.status(500).json({ error: "Internal server error" }); }
});

/** POST /api/merchant/webhook — update webhook URL (used by dashboard Developer page) */
paymentRouter.post("/merchant/webhook", requireApiKey as any, async (req: any, res) => {
  try {
    const { webhookUrl } = req.body;
    if (webhookUrl !== undefined && webhookUrl !== null && (typeof webhookUrl !== "string" || !/^https:\/\//.test(webhookUrl))) {
      res.status(400).json({ error: "webhookUrl must be an HTTPS URL" }); return;
    }
    await updateMerchant(req.merchant.id, { webhookUrl: webhookUrl || null });
    res.json({ success: true, webhookUrl: webhookUrl || null });
  } catch (e) { logSeraOperationFailure("payment-route", e); res.status(500).json({ error: "Internal server error" }); }
});

/** POST /api/merchant/webhook/test — fire a sample payload to the merchant's webhook URL */
paymentRouter.post("/merchant/webhook/test", requireApiKey as any, async (req: any, res) => {
  try {
    const targetUrl = req.body?.webhookUrl || req.merchant.webhookUrl;
    if (!targetUrl) { res.status(400).json({ error: "No webhook URL configured" }); return; }
    if (!/^https:\/\//.test(targetUrl)) { res.status(400).json({ error: "webhookUrl must be HTTPS" }); return; }

    const samplePayload = {
      event: "payment.confirmed",
      test: true,
      txId: 0,
      txHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
      coin: "XSGD",
      amount: "10.00",
      fromAddress: "0x0000000000000000000000000000000000000001",
      toAddress: req.merchant.walletAddress,
      verified: true,
      timestamp: new Date().toISOString(),
    };

    // SSRF protection: block private/local hostnames and IP ranges
    const urlObj = new URL(targetUrl);
    const hostname = urlObj.hostname.toLowerCase();
    const privatePatterns = [
      /^localhost$/i,
      /\.local$/i,          // *.local mDNS
      /^127\./,             // IPv4 loopback
      /^0\.0\.0\.0$/,
      /^10\./,              // RFC1918 class A
      /^172\.(1[6-9]|2\d|3[01])\./,  // RFC1918 class B
      /^192\.168\./,        // RFC1918 class C
      /^169\.254\./,        // link-local
      /^::1$/,              // IPv6 loopback
      /^fc[0-9a-f]{2}:/i,   // IPv6 ULA
      /^fe80:/i,            // IPv6 link-local
      /^\[::1\]$/,          // IPv6 loopback bracket form
    ];
    if (privatePatterns.some(p => p.test(hostname))) {
      res.status(400).json({ error: "Private/local URLs are not allowed for security reasons" }); return;
    }

    const body = JSON.stringify(samplePayload);
    const secret = req.merchant.webhookSecret;
    const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": "SeraPay-Webhook/1.0" };
    if (secret) {
      const { createHmac } = await import("crypto");
      headers["X-SeraPay-Signature"] = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
    }

    let statusCode = 0;
    let responseBody = "";
    try {
      const resp = await fetch(targetUrl, { method: "POST", headers, body, signal: AbortSignal.timeout(10000) });
      statusCode = resp.status;
      responseBody = await resp.text().catch(() => "");
    } catch (fetchErr: any) {
      res.status(502).json({ error: "Webhook delivery failed", detail: fetchErr?.message || "Network error" }); return;
    }

    res.json({ success: statusCode >= 200 && statusCode < 300, statusCode, responseBody: responseBody.slice(0, 500), payload: samplePayload });
  } catch (e) { logSeraOperationFailure("payment-route", e); res.status(500).json({ error: "Internal server error" }); }
});

/** POST /api/merchant/webhook/secret/regenerate — rotate HMAC signing secret */
paymentRouter.post("/merchant/webhook/secret/regenerate", requireApiKey as any, async (req: any, res) => {
  try {
    const { randomBytes } = await import("crypto");
    const newSecret = "whsec_" + randomBytes(24).toString("hex"); // 48-char hex prefixed
    await updateMerchant(req.merchant.id, { webhookSecret: newSecret });
    res.json({ success: true, webhookSecret: newSecret });
  } catch (e) { logSeraOperationFailure("payment-route", e); res.status(500).json({ error: "Internal server error" }); }
});

/** GET /api/merchant/webhook/logs — recent webhook delivery log */
paymentRouter.get("/merchant/webhook/logs", requireApiKey as any, async (req: any, res) => {
  try {
    const logs = await getMerchantWebhookLogs(req.merchant.id, 50);
    res.json(logs.map(l => ({
      id: l.id,
      txId: l.txId,
      txHash: l.txHash,
      url: l.url,
      statusCode: l.statusCode,
      success: l.success === 1,
      responseBody: l.responseBody,
      error: l.error,
      sentAt: l.sentAt.getTime(),
    })));
  } catch (e) { logSeraOperationFailure("payment-route", e); res.status(500).json({ error: "Internal server error" }); }
});

/** GET /api/merchant/stats — aggregate stats for dashboard */
paymentRouter.get("/merchant/stats", requireApiKey as any, async (req: any, res) => {
  try {
    const requestedChainId = Number(req.query.chainId ?? req.query.chain_id);
    const preferredSyncChainId = Number.isInteger(requestedChainId) && requestedChainId > 0 ? requestedChainId : null;
    if (req.query.syncDirect === "1") {
      await syncMerchantDirectActivity(req.merchant, preferredSyncChainId).catch((error) => {
        logSeraOperationFailure("direct-sync/stats", error);
      });
    }
    let txs = await getMerchantTransactions(req.merchant.id, 1000);
    const canceled = await cancelStaleMerchantTransactions(req.merchant.id, txs);
    if (canceled > 0) txs = await getMerchantTransactions(req.merchant.id, 1000);
    if (Number.isInteger(requestedChainId) && requestedChainId > 0) {
      txs = txs.filter((tx) => Number(tx.chainId ?? 11155111) === requestedChainId);
    }
    const totalCount = txs.length;
    const confirmedCount = txs.filter(t => t.status === "confirmed").length;
    const pendingCount = txs.filter(t => t.status === "pending" || t.status === "confirming").length;
    const unverifiedCount = txs.filter(t => t.verified === 0 && t.status !== "failed" && t.status !== "canceled").length;
    const totalVolume = txs
      .filter(t => t.status === "confirmed")
      .reduce((sum, t) => sum + getTransactionVolumeValue(t), 0)
      .toFixed(6);
    // Daily volume for last 14 days
    const now = new Date();
    const dailyMap = new Map<string, number>();
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now); d.setDate(d.getDate() - i);
      dailyMap.set(d.toISOString().slice(0, 10), 0);
    }
    for (const t of txs) {
      if (t.status !== "confirmed") continue;
      const day = new Date(t.createdAt).toISOString().slice(0, 10);
      if (dailyMap.has(day)) dailyMap.set(day, (dailyMap.get(day) || 0) + getTransactionVolumeValue(t));
    }
    const dailyVolume = Array.from(dailyMap.entries()).map(([date, volume]) => ({ date, volume: volume.toFixed(6) }));
    res.json({ totalCount, confirmedCount, pendingCount, unverifiedCount, totalVolume, dailyVolume });
  } catch (e) { logSeraOperationFailure("payment-route", e); res.status(500).json({ error: "Internal server error" }); }
});

// In-memory SSE clients per merchant: merchantId → Set<Response>
const merchantSseClients = new Map<string, Set<Response>>();
// Short-lived SSE tokens: token → { merchantId, expiresAt }
// Tokens are valid for 60 seconds and consumed on first use.
const sseTokens = new Map<string, { merchantId: string; expiresAt: number }>();
function cleanupSseTokens() {
  const now = Date.now();
  for (const [token, val] of sseTokens) {
    if (val.expiresAt < now) sseTokens.delete(token);
  }
}
setInterval(cleanupSseTokens, 30_000);

// ─── In-memory event buffer for polling (Cloudflare kills SSE after 100s) ──────
type MerchantEvent = { event: string; data: Record<string, unknown>; ts: number };
const merchantEventBuffer = new Map<string, MerchantEvent[]>();
const EVENT_BUFFER_TTL_MS = 5 * 60 * 1000; // keep events for 5 minutes
function pushMerchantEvent(merchantId: string, event: string, data: Record<string, unknown>) {
  const buf = merchantEventBuffer.get(merchantId) ?? [];
  buf.push({ event, data, ts: Date.now() });
  const cutoff = Date.now() - EVENT_BUFFER_TTL_MS;
  merchantEventBuffer.set(merchantId, buf.filter(e => e.ts >= cutoff));
}
setInterval(() => {
  const cutoff = Date.now() - EVENT_BUFFER_TTL_MS;
  for (const [id, buf] of merchantEventBuffer) {
    const trimmed = buf.filter(e => e.ts >= cutoff);
    if (trimmed.length === 0) merchantEventBuffer.delete(id);
    else merchantEventBuffer.set(id, trimmed);
  }
}, 60_000);;

/** POST /api/merchant/sse-token — exchange API key for a short-lived SSE token */
paymentRouter.post("/merchant/sse-token", requireApiKey as any, async (req: any, res) => {
  const token = uuidv4();
  sseTokens.set(token, { merchantId: req.merchant.id, expiresAt: Date.now() + 60_000 });
  res.json({ token });
});

export function notifyMerchantSse(merchantId: string, data: Record<string, unknown>) {
  // Push to in-memory buffer so polling clients also get the event
  if (data.event) pushMerchantEvent(merchantId, data.event as string, data);
  // Also push to any active SSE connections
  const clients = merchantSseClients.get(merchantId);
  if (!clients) return;
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of Array.from(clients)) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
}

/** GET /api/merchant/events — SSE stream for live payment notifications
 *  Accepts API key via X-Api-Key header (preferred) or apiKey query param (legacy, logged as warning).
 */
paymentRouter.get("/merchant/events", async (req, res) => {
  // Auth: accept short-lived SSE token (preferred), X-Api-Key header, or legacy query param
  const sseToken = req.query.token as string | undefined;
  let merchantId: string | undefined;
  if (sseToken) {
    const entry = sseTokens.get(sseToken);
    if (!entry || entry.expiresAt < Date.now()) {
      res.status(401).json({ error: "Invalid or expired SSE token" }); return;
    }
    merchantId = entry.merchantId;
    sseTokens.delete(sseToken); // one-time use
  } else {
    const apiKey = (req.headers["x-api-key"] as string) || (req.query.apiKey as string);
    if (!apiKey) { res.status(401).json({ error: "Missing authentication" }); return; }
    const merchant = await getMerchantByApiKey(apiKey);
    if (!merchant) { res.status(401).json({ error: "Invalid API key" }); return; }
    merchantId = merchant.id;
  }
  const merchant = await getMerchantById(merchantId!);
  if (!merchant) { res.status(401).json({ error: "Merchant not found" }); return; }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ event: "connected", merchantId: merchant.id })}\n\n`);
  if (!merchantSseClients.has(merchant.id)) merchantSseClients.set(merchant.id, new Set());
  merchantSseClients.get(merchant.id)!.add(res);
  // Send recent confirmed transactions as replay
  const since = req.query.since as string;
  if (since) {
    try {
      const sinceDate = new Date(since);
      const recent = await getMerchantTransactions(merchant.id, 20);
      for (const tx of recent) {
        if (new Date(tx.createdAt) > sinceDate && tx.status === "confirmed") {
          res.write(`data: ${JSON.stringify({ event: "payment_received", transactionId: tx.id, amount: tx.amount, coin: tx.coin, from: tx.fromAddress, replay: true })}\n\n`);
        }
      }
    } catch {}
  }
  // Heartbeat every 25s
  const heartbeat = setInterval(() => { try { res.write(": heartbeat\n\n"); } catch { clearInterval(heartbeat); } }, 25000);
  req.on("close", () => {
    clearInterval(heartbeat);
    merchantSseClients.get(merchant.id)?.delete(res);
    if (merchantSseClients.get(merchant.id)?.size === 0) merchantSseClients.delete(merchant.id);
  });
});

/** GET /api/merchant/events/poll — polling fallback for Cloudflare environments
 *  Returns all events since ?since=<ISO timestamp>. Responds immediately.
 */
paymentRouter.get("/merchant/events/poll", requireApiKey as any, async (req: any, res) => {
  try {
    const since = req.query.since ? new Date(req.query.since as string).getTime() : Date.now() - 30_000;
    const buf = merchantEventBuffer.get(req.merchant.id) ?? [];
    const events = buf.filter(e => e.ts > since);
    // Also include recent confirmed transactions from DB as a fallback
    let dbEvents: MerchantEvent[] = [];
    if (events.length === 0) {
      try {
        const recent = await getMerchantTransactions(req.merchant.id, 10);
        const sinceDate = new Date(since);
        for (const tx of recent) {
          if (new Date(tx.createdAt) > sinceDate && tx.status === "confirmed") {
            dbEvents.push({ event: "payment_received", data: { event: "payment_received", transactionId: tx.id, amount: tx.amount, coin: tx.coin, from: tx.fromAddress, replay: true }, ts: new Date(tx.createdAt).getTime() });
          }
        }
      } catch {}
    }
    res.json({ events: [...events, ...dbEvents], serverTime: Date.now() });
  } catch (e) { logSeraOperationFailure("payment-route", e); res.status(500).json({ error: "Internal server error" }); }
});

/** GET /api/merchant/transactions — list transactions */
paymentRouter.get("/merchant/transactions", requireApiKey as any, async (req: any, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 1000);
    const offset = parseInt(req.query.offset as string) || 0;
    const requestedChainId = Number(req.query.chainId ?? req.query.chain_id);
    const preferredSyncChainId = Number.isInteger(requestedChainId) && requestedChainId > 0 ? requestedChainId : null;
    if (req.query.syncDirect === "1") {
      await syncMerchantDirectActivity(req.merchant, preferredSyncChainId).catch((error) => {
        logSeraOperationFailure("direct-sync", error);
      });
    }
    let txs = await getMerchantTransactions(req.merchant.id, limit, offset);
    const canceled = await cancelStaleMerchantTransactions(req.merchant.id, txs);
    if (canceled > 0) txs = await getMerchantTransactions(req.merchant.id, limit, offset);
    if (Number.isInteger(requestedChainId) && requestedChainId > 0) {
      txs = txs.filter((tx) => Number(tx.chainId ?? 11155111) === requestedChainId);
    }
    res.json({ transactions: txs.map(transactionToJson), pagination: { limit, offset } });
  } catch (e) { logSeraOperationFailure("payment-route", e); res.status(500).json({ error: "Internal server error" }); }
});

/** PATCH /api/merchant/transactions/:id/notes — update notes/memo on a transaction */
paymentRouter.patch("/merchant/transactions/:id/notes", requireApiKey as any, async (req: any, res) => {
  try {
    const { id } = req.params;
    const { notes, memo } = req.body;
    const tx = await getTransactionById(id);
    if (!tx) { res.status(404).json({ error: "Transaction not found" }); return; }
    if (tx.merchantId !== req.merchant.id) { res.status(403).json({ error: "Forbidden" }); return; }
    await updateTransaction(id, { notes: notes ?? tx.notes, memo: memo ?? tx.memo });
    res.json({ ok: true });
  } catch (e) { logSeraOperationFailure("payment-route", e); res.status(500).json({ error: "Internal server error" }); }
});

/** PATCH /api/merchant/transactions/:id/cancel — cancel a pending payment request */
paymentRouter.patch("/merchant/transactions/:id/cancel", requireApiKey as any, async (req: any, res) => {
  try {
    const { id } = req.params;
    const tx = await getTransactionById(id);
    if (!tx) { res.status(404).json({ error: "Transaction not found" }); return; }
    if (tx.merchantId !== req.merchant.id) { res.status(403).json({ error: "Forbidden" }); return; }
    if (tx.status !== "pending" && tx.status !== "confirming") {
      res.status(409).json({ error: "Only pending or confirming transactions can be canceled" });
      return;
    }
    await cancelTransactionRecord(tx, "Canceled by merchant.", "transaction_canceled");
    res.json({ ok: true, status: "canceled" });
  } catch (e) { logSeraOperationFailure("payment-route", e); res.status(500).json({ error: "Internal server error" }); }
});

// ─── Payment endpoints ────────────────────────────────────────────────────────

function toRawTokenAmount(amount: string, decimals: number): string {
  const normalized = amount.replace(/,/g, "").trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) throw new Error("Invalid token amount.");
  const [whole, fraction = ""] = normalized.split(".");
  if (fraction.length > decimals) {
    throw new Error(`Invalid amount. ${decimals} decimal places maximum for this token.`);
  }
  const raw = `${whole}${fraction.padEnd(decimals, "0").slice(0, decimals)}`.replace(/^0+(?=\d)/, "");
  return raw || "0";
}

function fromRawTokenAmount(raw: string | number | bigint, decimals: number): string {
  const value = BigInt(String(raw));
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = value % scale;
  if (fraction === 0n) return whole.toString();
  const fractionText = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole}.${fractionText}`;
}

function normalizeDecimalAmount(amount: unknown): string {
  const value = String(amount ?? "").replace(/,/g, "").trim();
  if (!/^\d+(\.\d{1,6})?$/.test(value) || Number(value) <= 0) {
    throw new Error("Invalid amount. Max 6 decimals.");
  }
  return value.replace(/^0+(?=\d)/, "");
}

async function resolvePaymentMerchant(merchantAddress: string) {
  const normalizedMerchantAddress = merchantAddress.toLowerCase();
  let merchant = await getMerchantByWallet(normalizedMerchantAddress) || await getMerchantByStoreAddress(normalizedMerchantAddress);
  const subWallet = merchant ? undefined : await getSubWalletByAddress(normalizedMerchantAddress);
  if (!merchant && subWallet) {
    merchant = await getMerchantById(subWallet.merchantId);
  }
  if (!merchant) throw new Error("Merchant not found");
  const toAddress = subWallet?.address || merchant.storeAddress || merchant.walletAddress;
  return { merchant, subWallet, toAddress: toAddress.toLowerCase() };
}

const paymentTokenRegistryCache = new Map<string, { expiresAt: number; tokens: SeraToken[]; request?: Promise<SeraToken[]> }>();

async function getPaymentTokenRegistry(baseUrl: string): Promise<SeraToken[]> {
  const key = normalizeSeraBaseUrl(baseUrl);
  const cached = paymentTokenRegistryCache.get(key);
  if (cached?.tokens.length && cached.expiresAt > Date.now()) return cached.tokens;
  if (cached?.request) return cached.request;

  const request = getSeraTokens(key)
    .then((registry) => {
      const tokens = registry.tokens.filter((token) => /^0x[0-9a-fA-F]{40}$/.test(token.address));
      paymentTokenRegistryCache.set(key, { tokens, expiresAt: Date.now() + 30_000 });
      return tokens;
    })
    .catch((error) => {
      paymentTokenRegistryCache.delete(key);
      throw error;
    });
  paymentTokenRegistryCache.set(key, { tokens: cached?.tokens ?? [], expiresAt: cached?.expiresAt ?? 0, request });
  return request;
}

async function resolveSeraTokenBySymbol(baseUrl: string, symbol: string): Promise<SeraToken> {
  const registry = await getPaymentTokenRegistry(baseUrl);
  const token = registry.find((item) => item.symbol.toUpperCase() === symbol.toUpperCase());
  if (!token) throw new Error(`Unsupported Sera token: ${symbol}`);
  return token;
}

async function resolveSeraTokenForChain(chainId: number, symbol: string): Promise<SeraToken> {
  if (chainId !== SERA_MAINNET_CHAIN_ID && chainId !== SERA_TESTNET_CHAIN_ID) {
    throw new Error(`Sera payments are not supported on chain ${chainId}`);
  }
  return resolveSeraTokenBySymbol(getSeraApiBaseUrlForChain(chainId), symbol);
}

function unwrapSeraQuote(raw: unknown): SeraSwapQuote {
  const candidate = raw && typeof raw === "object" && "quote" in raw
    ? (raw as { quote: unknown }).quote
    : raw;
  if (!candidate || typeof candidate !== "object") throw new Error("Sera quote response was empty");
  return candidate as SeraSwapQuote;
}

function getRouteParams(quote: SeraSwapQuote): SeraRouteParams {
  const routeParams = quote.route_params ?? quote.routeParams;
  if (!routeParams) throw new Error("Sera quote did not return route_params");
  return routeParams;
}

function getPermitTypedData(permit: unknown): unknown | null {
  if (!permit || typeof permit !== "object") return null;
  const value = permit as Record<string, unknown>;
  return value.typed_data ?? value.typedData ?? value.eip712 ?? null;
}

function getPermitDeadline(permit: unknown): string | number | null {
  if (!permit || typeof permit !== "object") return null;
  const value = permit as Record<string, unknown>;
  const typedData = getPermitTypedData(permit) as Record<string, unknown> | null;
  const message = typedData?.message as Record<string, unknown> | undefined;
  const deadline = value.deadline ?? value.permit_deadline ?? message?.deadline ?? message?.sigDeadline;
  return typeof deadline === "string" || typeof deadline === "number" ? deadline : null;
}

function getPermitApproval(permit: unknown, fallbackAmountRaw: string): { spender: string; amountRaw: string } | null {
  if (!permit || typeof permit !== "object") return null;
  const value = permit as Record<string, unknown>;
  if (value.permit_supported !== false && value.permitSupported !== false) return null;
  const spender = String(value.spender || "");
  const amountRaw = String(value.value_raw ?? value.valueRaw ?? fallbackAmountRaw);
  if (!/^0x[0-9a-fA-F]{40}$/.test(spender) || !/^\d+$/.test(amountRaw)) return null;
  return { spender, amountRaw };
}

function extractTransactionHash(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const direct = value as Record<string, unknown>;
  for (const key of ["txHash", "tx_hash", "transactionHash", "transaction_hash", "hash"]) {
    const candidate = direct[key];
    if (typeof candidate === "string" && /^0x[0-9a-fA-F]{64}$/.test(candidate)) return candidate;
  }
  for (const nested of Object.values(direct)) {
    const candidate = extractTransactionHash(nested);
    if (candidate) return candidate;
  }
  return null;
}

function transactionNotesMeta(notes: string | null | undefined): { orderId: string | null; paymentIntentId: string | null } {
  if (!notes) return { orderId: null, paymentIntentId: null };
  try {
    const parsed = JSON.parse(notes) as { orderId?: unknown; paymentIntentId?: unknown };
    return {
      orderId: typeof parsed.orderId === "string" && parsed.orderId ? parsed.orderId : null,
      paymentIntentId: typeof parsed.paymentIntentId === "string" && parsed.paymentIntentId ? parsed.paymentIntentId : null,
    };
  } catch {
    return { orderId: null, paymentIntentId: null };
  }
}

function orderIdFromTransactionNotes(notes: string | null | undefined): string | null {
  return transactionNotesMeta(notes).orderId;
}

function transactionFailureReason(notes: string | null | undefined): string | null {
  if (!notes) return null;
  try {
    const parsed = JSON.parse(notes) as { failureReason?: unknown; cancellationReason?: unknown };
    if (typeof parsed.failureReason === "string" && parsed.failureReason) return parsed.failureReason;
    if (typeof parsed.cancellationReason === "string" && parsed.cancellationReason) return parsed.cancellationReason;
  } catch {}
  return null;
}

function notesWithCancellationReason(notes: string | null | undefined, reason: string): string {
  const canceledAt = new Date().toISOString();
  if (!notes) return JSON.stringify({ canceledAt, cancellationReason: reason });
  try {
    const parsed = JSON.parse(notes) as Record<string, unknown>;
    return JSON.stringify({ ...parsed, canceledAt, cancellationReason: reason });
  } catch {
    return `${notes}\n${reason} (${canceledAt})`;
  }
}

function notesWithFailureReason(notes: string | null | undefined, reason: string): string {
  const failedAt = new Date().toISOString();
  if (!notes) return JSON.stringify({ failedAt, failureReason: reason });
  try {
    const parsed = JSON.parse(notes) as Record<string, unknown>;
    return JSON.stringify({ ...parsed, failedAt, failureReason: reason });
  } catch {
    return `${notes}\n${reason} (${failedAt})`;
  }
}

async function cancelTransactionRecord(tx: Transaction, reason: string, event: "transaction_auto_canceled" | "transaction_canceled") {
  if (tx.status !== "pending" && tx.status !== "confirming") return false;
  const meta = transactionNotesMeta(tx.notes);
  await updateTransaction(tx.id, {
    status: "canceled",
    memo: tx.memo || reason.slice(0, 200),
    notes: notesWithCancellationReason(tx.notes, reason),
  });
  if (meta.orderId) {
    await updateMenuOrderPayment(meta.orderId, tx.merchantId, { status: "canceled", paymentId: tx.id, transactionId: tx.id }).catch(() => undefined);
  }
  if (meta.paymentIntentId) {
    await updatePaymentIntent(meta.paymentIntentId, { status: "canceled" }).catch(() => undefined);
  }
  notifySseClients(tx.id, { status: "canceled", reason });
  notifyMerchantSse(tx.merchantId, {
    event,
    transactionId: tx.id,
    status: "canceled",
    amount: tx.amount,
    coin: tx.coin,
    reason,
  });
  return true;
}

async function failTransactionRecord(tx: Transaction, reason: string) {
  if (tx.status !== "pending" && tx.status !== "confirming") return false;
  const meta = transactionNotesMeta(tx.notes);
  await updateTransaction(tx.id, {
    status: "failed",
    memo: tx.memo || reason.slice(0, 200),
    notes: notesWithFailureReason(tx.notes, reason),
  });
  if (meta.orderId) {
    await updateMenuOrderPayment(meta.orderId, tx.merchantId, { status: "failed", paymentId: tx.id, transactionId: tx.id }).catch(() => undefined);
  }
  if (meta.paymentIntentId) {
    await updatePaymentIntent(meta.paymentIntentId, { status: "failed" }).catch(() => undefined);
  }
  notifySseClients(tx.id, { status: "failed", reason });
  notifyMerchantSse(tx.merchantId, {
    event: "payment_failed",
    transactionId: tx.id,
    status: "failed",
    amount: tx.amount,
    coin: tx.coin,
    reason,
  });
  return true;
}

async function cancelStaleMerchantTransactions(merchantId: string, transactions?: Transaction[]) {
  const txs = transactions ?? await getMerchantTransactions(merchantId, 1000);
  const cutoff = Date.now() - PENDING_TRANSACTION_CANCEL_AFTER_MS;
  let canceled = 0;
  for (const tx of txs) {
    // "confirming" means a wallet transaction or Sera trade was already
    // submitted. Never auto-cancel submitted money just because settlement is slow.
    if (tx.status === "pending" && new Date(tx.createdAt).getTime() <= cutoff) {
      if (await cancelTransactionRecord(tx, "Auto-canceled after 5 minutes without payment confirmation.", "transaction_auto_canceled")) {
        canceled += 1;
      }
    }
  }
  return canceled;
}

function seraPaymentErrorResponse(error: unknown, fallback: string) {
  if (error instanceof SeraApiError) {
    const code = error.errorCode;
    const isQuoteStale = error.status === 409
      || error.status === 410
      || code === "QUOTE_STALE"
      || code === "quote_stale";
    const isUnavailable = error.status >= 500;
    const message = code === "no_liquidity" || code === "NO_LIQUIDITY"
      ? "Currently there's no liquidity on this exchange in Sera.cx. Please try another option."
      : isQuoteStale
        ? "This quote closed before it could be submitted. Please try again."
      : isUnavailable
        ? "Sera is temporarily unavailable. Please try again shortly."
        : code === "AMOUNT_BELOW_MIN"
          ? "This payment amount is below Sera's minimum for this currency pair."
          : fallback;
    return {
      status: error.status >= 400 && error.status < 500 ? error.status : 502,
      body: {
        error: message,
        errorCode: isQuoteStale ? "quote_stale" : code ?? (isUnavailable ? "sera_connection_error" : null),
        seraStatus: error.status,
      },
    };
  }
  return {
    status: 502,
    body: {
      error: "Unable to reach Sera right now. Please try again shortly.",
      errorCode: "sera_connection_error",
    },
  };
}

function logSeraOperationFailure(scope: string, error: unknown) {
  if (error instanceof SeraApiError) {
    if (error.errorCode === "no_liquidity" || error.errorCode === "NO_LIQUIDITY") return;
    console.error(`[${scope}] failed`, { status: error.status, code: error.errorCode || "sera_api_error" });
    return;
  }
  console.error(`[${scope}] failed`, { type: error instanceof Error ? error.name : "unknown_error" });
}

async function cancelAllStalePendingTransactions() {
  try {
    const pending = await getPendingTransactions();
    const byMerchant = new Map<string, Transaction[]>();
    for (const tx of pending) {
      const list = byMerchant.get(tx.merchantId) ?? [];
      list.push(tx);
      byMerchant.set(tx.merchantId, list);
    }
    for (const [merchantId, txs] of byMerchant) {
      await cancelStaleMerchantTransactions(merchantId, txs);
    }
  } catch (error) {
    logSeraOperationFailure("payments/auto-cancel", error);
  }
}

setInterval(() => { void cancelAllStalePendingTransactions(); }, 60_000);

type SeraTrackedOrder = {
  status?: string;
  error?: string | null;
  error_code?: string | null;
  settlement_summary?: {
    latest_tx_hash?: string | null;
    latest_failed_fill_failure_reason?: string | null;
  } | null;
};

async function reconcileSeraSwapTransaction(tx: Transaction): Promise<Transaction> {
  if (tx.status !== "confirming") return tx;
  let notes: Record<string, unknown>;
  try {
    notes = tx.notes ? JSON.parse(tx.notes) as Record<string, unknown> : {};
  } catch {
    return tx;
  }
  const tradeId = typeof notes.tradeId === "string" ? notes.tradeId : null;
  if (notes.type !== "sera_swap" || !tradeId) return tx;

  const config = await getApiKeyConfigRecord(tx.merchantId).catch(() => undefined);
  const credential = decryptSecret(config?.seraApiKeyEncrypted) || ENV.seraApiKey || "";
  if (!credential) return reconcileSeraSwapOnChain(tx, notes);

  let order: SeraTrackedOrder;
  try {
    order = await callSeraApi<SeraTrackedOrder>({
      baseUrl: getSeraApiBaseUrlForChain(tx.chainId),
      path: `/orders/${encodeURIComponent(tradeId)}`,
      credential,
      authMode: "api_key",
      merchantId: tx.merchantId,
    });
  } catch (error) {
    logSeraOperationFailure("payment/swap/reconcile", error);
    return reconcileSeraSwapOnChain(tx, notes);
  }

  const seraStatus = String(order.status || "pending").toLowerCase();
  const txHash = order.settlement_summary?.latest_tx_hash;
  const nextNotes = JSON.stringify({ ...notes, seraStatus, seraOrder: order });

  if (seraStatus === "failed" || seraStatus === "cancelled") {
    const reason = order.error || order.settlement_summary?.latest_failed_fill_failure_reason || order.error_code || `Sera swap ${seraStatus}`;
    await updateTransaction(tx.id, { notes: nextNotes });
    await failTransactionRecord({ ...tx, notes: nextNotes }, reason);
    return await getTransactionById(tx.id) ?? tx;
  }

  if (seraStatus !== "settled") {
    await updateTransaction(tx.id, { notes: nextNotes, ...(txHash && /^0x[0-9a-fA-F]{64}$/.test(txHash) ? { txHash } : {}) });
    const refreshed = await getTransactionById(tx.id) ?? { ...tx, notes: nextNotes };
    return reconcileSeraSwapOnChain(refreshed, { ...notes, seraStatus, seraOrder: order });
  }

  const verifiedHash = txHash && /^0x[0-9a-fA-F]{64}$/.test(txHash) ? txHash : tx.txHash;
  await updateTransaction(tx.id, {
    status: "confirmed",
    verified: 1,
    ...(verifiedHash ? { txHash: verifiedHash } : {}),
    notes: nextNotes,
    notifiedAt: new Date(),
    webhookSentAt: new Date(),
  });
  const meta = transactionNotesMeta(tx.notes);
  if (meta.paymentIntentId) await updatePaymentIntent(meta.paymentIntentId, { status: "paid" }).catch(() => undefined);
  if (meta.orderId) await updateMenuOrderPayment(meta.orderId, tx.merchantId, { status: "paid", paymentId: tx.id, transactionId: tx.id }).catch(() => undefined);
  notifySseClients(tx.id, { status: "confirmed", txHash: verifiedHash, verified: true, tradeId });
  notifyMerchantSse(tx.merchantId, {
    event: "payment_received",
    transactionId: tx.id,
    txHash: verifiedHash,
    amount: tx.amount,
    coin: tx.coin,
    payAmount: tx.payAmount,
    payCoin: tx.payCoin,
    from: tx.fromAddress,
    verified: true,
    source: "sera_swap",
  });

  const merchant = await getMerchantById(tx.merchantId);
  if (merchant?.webhookUrl) {
    sendWebhook(
      merchant.webhookUrl,
      merchant.webhookSecret,
      {
        event: "payment.confirmed",
        txId: tx.id,
        txHash: verifiedHash,
        coin: tx.coin,
        amount: tx.amount,
        payCoin: tx.payCoin,
        payAmount: tx.payAmount,
        fromAddress: tx.fromAddress,
        toAddress: tx.toAddress,
        verified: true,
        source: "sera_swap",
        tradeId,
      },
      { merchantId: merchant.id, txId: tx.id, txHash: verifiedHash },
    ).catch((error) => logSeraOperationFailure("payment-notification", error));
  }
  return await getTransactionById(tx.id) ?? tx;
}

function isSeraSwapTransaction(tx: Transaction): boolean {
  if (!tx.notes) return false;
  try {
    const parsed = JSON.parse(tx.notes) as { type?: unknown };
    return parsed.type === "sera_swap";
  } catch {
    return false;
  }
}

/** POST /api/payment/create — create a pending payment request */
paymentRouter.post("/payment/create", async (req, res) => {
  try {
    const { merchantAddress, coin, amount, chainId } = req.body;
    const orderId = typeof req.body.orderId === "string" ? req.body.orderId : null;
    const paymentIntentId = typeof req.body.paymentIntentId === "string" ? req.body.paymentIntentId : null;
    const paymentUrl = typeof req.body.paymentUrl === "string" && req.body.paymentUrl.length <= 4096 ? req.body.paymentUrl : null;
    if (!merchantAddress || !/^0x[0-9a-fA-F]{40}$/.test(merchantAddress)) { res.status(400).json({ error: "Invalid merchantAddress" }); return; }
    const coinSymbol = String(coin || "").trim().toUpperCase();
    if (!COIN_SYMBOL_RE.test(coinSymbol)) { res.status(400).json({ error: "Invalid coin" }); return; }
    let normalizedAmount = "";
    try {
      normalizedAmount = normalizeDecimalAmount(amount);
    } catch (error: any) {
      res.status(400).json({ error: error?.message || "Invalid amount" });
      return;
    }
    const parsedAmount = parseFloat(normalizedAmount);
    if (isNaN(parsedAmount) || parsedAmount <= 0 || parsedAmount > 1_000_000) { res.status(400).json({ error: "Invalid amount" }); return; }
    const normalizedMerchantAddress = merchantAddress.toLowerCase();
    const merchantAddressCompliance = await screenWalletAddress(normalizedMerchantAddress, "recipient_wallet");
    if (merchantAddressCompliance.blocked) {
      res.status(403).json({ error: "Merchant address failed compliance screening", compliance: merchantAddressCompliance });
      return;
    }
    let resolved: Awaited<ReturnType<typeof resolvePaymentMerchant>>;
    try {
      resolved = await resolvePaymentMerchant(normalizedMerchantAddress);
    } catch {
      res.status(404).json({ error: "Merchant not found" }); return;
    }
    const { merchant, toAddress } = resolved;
    const id = uuidv4();
    const toAddressCompliance = await screenWalletAddress(toAddress, "recipient_wallet", merchant.id);
    if (toAddressCompliance.blocked) {
      res.status(403).json({ error: "Recipient address failed compliance screening", compliance: toAddressCompliance });
      return;
    }
    const resolvedChainId = Number(chainId || SERA_TESTNET_CHAIN_ID);
    let paymentToken: SeraToken;
    try {
      paymentToken = await resolveSeraTokenForChain(resolvedChainId, coinSymbol);
      toRawTokenAmount(normalizedAmount, paymentToken.decimals);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Unsupported coin on this network" });
      return;
    }
    await createTransaction({
      id,
      merchantId: merchant.id,
      toAddress,
      coin: coinSymbol,
      amount: normalizedAmount,
      chainId: resolvedChainId,
      status: "pending",
      verified: 0,
      notes: orderId || paymentIntentId || paymentUrl
        ? JSON.stringify({
            ...(orderId ? { orderId, source: "public_menu" } : {}),
            ...(paymentIntentId ? { paymentIntentId } : {}),
            ...(paymentUrl ? { paymentUrl } : {}),
          })
        : null,
    });
    if (orderId) {
      await updateMenuOrderPayment(orderId, merchant.id, { paymentId: id, transactionId: id, status: "payment_pending" }).catch(() => undefined);
    }
    if (paymentIntentId) {
      await updatePaymentIntent(paymentIntentId, { status: "open" }).catch(() => undefined);
    }
    res.json({
      txId: id,
      toAddress,
      coin: coinSymbol,
      amount: normalizedAmount,
      chainId: resolvedChainId,
      tokenAddress: paymentToken.address,
      tokenDecimals: paymentToken.decimals,
    });
  } catch (e) { logSeraOperationFailure("payment-route", e); res.status(500).json({ error: "Internal server error" }); }
});

/** POST /api/payment/swap/quote - Sera quote for customer coin -> merchant receive coin */
paymentRouter.post("/payment/swap/quote", async (req, res) => {
  try {
    const merchantAddress = String(req.body.merchantAddress ?? "").trim();
    const payerAddress = String(req.body.payerAddress ?? "").trim().toLowerCase();
    const payCoin = String(req.body.payCoin ?? "").trim().toUpperCase();
    const receiveCoin = String(req.body.receiveCoin ?? "").trim().toUpperCase();
    let payAmount = "";
    let requestedReceiveAmount: string | null = null;
    try {
      payAmount = normalizeDecimalAmount(req.body.payAmount);
      requestedReceiveAmount = req.body.receiveAmount ? normalizeDecimalAmount(req.body.receiveAmount) : null;
    } catch (error: any) {
      res.status(400).json({ error: error?.message || "Invalid amount" });
      return;
    }
    const requestedChainId = Number(req.body.chainId ?? 1);
    const chainId = Number.isInteger(requestedChainId) && requestedChainId > 0 ? requestedChainId : 1;
    const paymentIntentId = typeof req.body.paymentIntentId === "string" ? req.body.paymentIntentId : null;
    const orderId = typeof req.body.orderId === "string" ? req.body.orderId : null;
    const requestedExpiration = Number(req.body.expiration);

    if (!/^0x[0-9a-fA-F]{40}$/.test(merchantAddress)) { res.status(400).json({ error: "Invalid merchantAddress" }); return; }
    if (!/^0x[0-9a-fA-F]{40}$/.test(payerAddress)) { res.status(400).json({ error: "Invalid payerAddress" }); return; }
    if (!COIN_SYMBOL_RE.test(payCoin) || !COIN_SYMBOL_RE.test(receiveCoin)) { res.status(400).json({ error: "Invalid coin" }); return; }
    if (payCoin === receiveCoin) { res.status(400).json({ error: "Sera swap quote requires different pay and receive coins." }); return; }

    const payerCompliance = await screenWalletAddress(payerAddress, "payer_wallet");
    if (payerCompliance.blocked) {
      res.status(403).json({ error: "Payer address failed compliance screening", compliance: payerCompliance });
      return;
    }

    const { merchant, toAddress } = await resolvePaymentMerchant(merchantAddress);
    const recipientCompliance = await screenWalletAddress(toAddress, "recipient_wallet", merchant.id);
    if (recipientCompliance.blocked) {
      res.status(403).json({ error: "Recipient address failed compliance screening", compliance: recipientCompliance });
      return;
    }

    const baseUrl = getSeraApiBaseUrlForChain(chainId);
    const [fromToken, toToken, config, seraNowSec] = await Promise.all([
      resolveSeraTokenBySymbol(baseUrl, payCoin),
      resolveSeraTokenBySymbol(baseUrl, receiveCoin),
      callSeraApi<SeraConfigResponse>({ baseUrl, path: "/config", authMode: "none" }),
      getSeraServerTimestamp(baseUrl, merchant.id),
    ]);
    if (!config.eip712_domain) throw new Error("Sera /config did not return eip712_domain");
    if (config.chain_id !== chainId) {
      throw new Error(`Sera /config returned chain ${config.chain_id ?? "unknown"}, expected ${chainId}`);
    }
    // Sera explicitly requires deadlines to be based on GET /system/time.
    // This avoids rejecting otherwise valid payments when a phone clock drifts.
    const expiration = Number.isInteger(requestedExpiration) && requestedExpiration > seraNowSec + 15
      ? Math.min(requestedExpiration, seraNowSec + 300)
      : seraNowSec + 300;

    const quoteRequest = {
      from_token: fromToken.address,
      to_token: toToken.address,
      from_amount: toRawTokenAmount(payAmount, fromToken.decimals),
      owner_address: payerAddress,
      recipient: toAddress,
      expiration,
      // A payment must preserve what the merchant receives. Sera adds the
      // execution cost to the customer's maximum input instead of subtracting
      // it from the merchant's output.
      gas_mode: "pay_more",
    };
    const requestQuote = async () => unwrapSeraQuote(await callSeraApi<unknown>({
        baseUrl,
        path: "/swap/quote",
        method: "POST",
        body: quoteRequest,
        authMode: "none",
        merchantId: merchant.id,
      }));
    let quote = await requestQuote();
    let routeParams = getRouteParams(quote);
    if (requestedReceiveAmount) {
      const requestedOutputRaw = BigInt(toRawTokenAmount(requestedReceiveAmount, toToken.decimals));
      const quotedOutputRaw = BigInt(String(routeParams.minOutputAmount));
      if (quotedOutputRaw <= 0n) throw new Error("Sera quote returned no output");
      if (quotedOutputRaw < requestedOutputRaw) {
        const currentInputRaw = BigInt(quoteRequest.from_amount);
        // Round up proportionally, then add a small buffer for quote refresh
        // movement so the merchant amount is not underpaid by token rounding.
        const adjustedInputRaw = ((currentInputRaw * requestedOutputRaw + quotedOutputRaw - 1n) / quotedOutputRaw * 1001n + 999n) / 1000n;
        quoteRequest.from_amount = adjustedInputRaw.toString();
        quote = await requestQuote();
        routeParams = getRouteParams(quote);
        if (BigInt(String(routeParams.minOutputAmount)) < requestedOutputRaw) {
          throw new Error("Sera quote cannot currently cover the merchant receive amount");
        }
      }
    }
    const quoteUuid = quote.uuid ?? routeParams.uuid;
    // SeraSOR's IntentMatched event emits the EIP-712 struct hash (before the
    // domain separator), so persist exactly that value for public on-chain
    // settlement reconciliation.
    const intentHash = hashSeraIntentStruct(routeParams);
    const expectedReceiveAmount = requestedReceiveAmount ?? fromRawTokenAmount(routeParams.minOutputAmount, toToken.decimals);
    const maximumPayAmount = fromRawTokenAmount(routeParams.maxInputAmount, fromToken.decimals);
    const approval = getPermitApproval(quote.permit, routeParams.maxInputAmount);
    if (approval && (!config.sor_address || approval.spender.toLowerCase() !== config.sor_address.toLowerCase())) {
      throw new Error("Sera quote approval target does not match the live SOR contract");
    }
    const requestedTxId = typeof req.body.txId === "string" ? req.body.txId.trim() : "";
    const txId = requestedTxId || uuidv4();
    const transactionNotes = JSON.stringify({
      type: "sera_swap_quote",
      quoteUuid,
      intentHash,
      paymentIntentId,
      orderId,
      payToken: fromToken.address,
      receiveToken: toToken.address,
      chainId,
      expiresAt: quote.expires_at ?? null,
      requestedPayAmount: payAmount,
    });

    if (requestedTxId) {
      const existing = await getTransactionById(requestedTxId);
      const samePayment = existing
        && existing.status === "pending"
        && existing.merchantId === merchant.id
        && existing.fromAddress?.toLowerCase() === payerAddress
        && existing.toAddress.toLowerCase() === toAddress.toLowerCase()
        && existing.coin === receiveCoin
        && existing.payCoin === payCoin
        && existing.chainId === (config.chain_id ?? chainId);
      if (!samePayment) {
        res.status(409).json({ error: "The previous Sera quote can no longer be refreshed.", errorCode: "quote_stale" });
        return;
      }
      await updateTransaction(txId, {
        amount: expectedReceiveAmount,
        payAmount: maximumPayAmount,
        notes: transactionNotes,
      });
    } else {
      await createTransaction({
        id: txId,
        merchantId: merchant.id,
        fromAddress: payerAddress,
        toAddress,
        coin: receiveCoin,
        amount: expectedReceiveAmount,
        chainId: config.chain_id ?? chainId,
        status: "pending",
        verified: 0,
        payCoin,
        payAmount: maximumPayAmount,
        notes: transactionNotes,
      });
      if (orderId) {
        await updateMenuOrderPayment(orderId, merchant.id, { paymentId: txId, paymentIntentId, transactionId: txId, status: "payment_pending" }).catch(() => undefined);
      }
    }
    res.json({
      txId,
      chainId: config.chain_id ?? chainId,
      toAddress,
      payCoin,
      receiveCoin,
      payAmount: maximumPayAmount,
      requestedPayAmount: payAmount,
      expectedReceiveAmount,
      quoteUuid,
      quote,
      intentTypedData: {
        domain: config.eip712_domain,
        types: SERA_INTENT_TYPES,
        primaryType: "Intent",
        message: routeParams,
      },
      permitTypedData: getPermitTypedData(quote.permit),
      permitDeadline: getPermitDeadline(quote.permit),
      approvalRequired: Boolean(approval),
      approvalSpender: approval?.spender ?? null,
      approvalAmountRaw: approval?.amountRaw ?? null,
      request: {
        ...quoteRequest,
        from_symbol: payCoin,
        to_symbol: receiveCoin,
      },
    });
  } catch (e: any) {
    logSeraOperationFailure("payment/swap/quote", e);
    const response = seraPaymentErrorResponse(e, "Unable to create Sera swap quote");
    res.status(response.status).json(response.body);
  }
});

/** POST /api/payment/swap/submit - submit signed Sera swap intent */
paymentRouter.post("/payment/swap/submit", async (req, res) => {
  let txForFailure: Transaction | undefined;
  try {
    const txId = String(req.body.txId ?? "").trim();
    const quoteUuid = String(req.body.quoteUuid ?? req.body.uuid ?? "").trim();
    const signature = String(req.body.signature ?? "").trim();
    const permitSignature = typeof req.body.permitSignature === "string" ? req.body.permitSignature.trim() : "";
    const permitDeadline = req.body.permitDeadline ?? null;

    if (!txId) { res.status(400).json({ error: "Missing txId" }); return; }
    if (!quoteUuid) { res.status(400).json({ error: "Missing quoteUuid" }); return; }
    if (!/^0x[0-9a-fA-F]+$/.test(signature)) { res.status(400).json({ error: "Invalid Sera intent signature" }); return; }
    if (permitSignature && !/^0x[0-9a-fA-F]+$/.test(permitSignature)) {
      res.status(400).json({ error: "Invalid permit signature" });
      return;
    }

    let tx = await getTransactionById(txId);
    if (!tx) { res.status(404).json({ error: "Transaction not found" }); return; }
    const staleCanceled = await cancelStaleMerchantTransactions(tx.merchantId, [tx]);
    if (staleCanceled > 0) tx = await getTransactionById(txId);
    if (!tx) { res.status(404).json({ error: "Transaction not found" }); return; }
    if (tx.status === "canceled") { res.status(409).json({ error: "Transaction was canceled" }); return; }
    if (tx.status === "confirmed") { res.json({ success: true, status: "confirmed" }); return; }
    txForFailure = tx;

    const body: Record<string, unknown> = {
      uuid: quoteUuid,
      signature,
    };
    if (permitSignature) {
      body.permit_signature = permitSignature;
      if (permitDeadline !== null && permitDeadline !== undefined && permitDeadline !== "") {
        body.permit_deadline = permitDeadline;
      }
    }

    await updateTransaction(txId, { status: "confirming", notifiedAt: new Date() });
    notifySseClients(txId, { status: "confirming" });

    const baseUrl = getSeraApiBaseUrlForChain(tx.chainId);
    const submittedBlockNumber = await CHAIN_CLIENTS[tx.chainId]?.getBlockNumber()
      .then((blockNumber: bigint) => blockNumber.toString())
      .catch(() => null);
    const result = await callSeraApi<Record<string, unknown>>({
      baseUrl,
      path: "/swap",
      method: "POST",
      body,
      authMode: "eip712",
      merchantId: tx.merchantId,
    });

    const tradeId = typeof result.trade_id === "string" ? result.trade_id : null;
    const seraStatus = typeof result.status === "string" ? result.status.toLowerCase() : "pending";
    const success = result.success === true && Boolean(tradeId);
    const txHash = extractTransactionHash(result);
    let existingNotes: Record<string, unknown> = {};
    try {
      existingNotes = tx.notes ? JSON.parse(tx.notes) as Record<string, unknown> : {};
    } catch {}
    const notes = JSON.stringify({
      ...existingNotes,
      type: "sera_swap",
      tradeId,
      seraStatus,
      submittedBlockNumber,
      seraSubmitResponse: result,
    });

    if (!success) {
      await updateTransaction(txId, { status: "failed", notes });
      const orderId = orderIdFromTransactionNotes(tx.notes);
      if (orderId) await updateMenuOrderPayment(orderId, tx.merchantId, { status: "failed", paymentId: txId, transactionId: txId }).catch(() => undefined);
      notifySseClients(txId, { status: "failed" });
      res.status(502).json({ success: false, status: "failed", sera: result });
      return;
    }

    if (seraStatus !== "settled") {
      await updateTransaction(txId, {
        status: "confirming",
        verified: 0,
        ...(txHash ? { txHash } : {}),
        notes,
        notifiedAt: new Date(),
      });
      const orderId = orderIdFromTransactionNotes(tx.notes);
      if (orderId) {
        await updateMenuOrderPayment(orderId, tx.merchantId, { status: "payment_submitted", paymentId: txId, transactionId: txId }).catch(() => undefined);
      }
      notifySseClients(txId, { status: "confirming", txHash, tradeId });
      void getTransactionById(txId)
        .then((fresh) => fresh ? reconcileSeraSwapTransaction(fresh) : undefined)
        .catch((error) => logSeraOperationFailure("payment/swap/reconcile", error));
      res.json({ success: true, status: "confirming", tradeId, txHash, sera: result });
      return;
    }

    await updateTransaction(txId, {
      status: "confirmed",
      verified: 1,
      ...(txHash ? { txHash } : {}),
      notes,
      notifiedAt: new Date(),
      webhookSentAt: new Date(),
    });

    notifySseClients(txId, { status: "confirmed", txHash, verified: true });
    notifyMerchantSse(tx.merchantId, {
      event: "payment_received",
      transactionId: txId,
      txHash,
      amount: tx.amount,
      coin: tx.coin,
      payAmount: tx.payAmount,
      payCoin: tx.payCoin,
      from: tx.fromAddress,
      verified: true,
      source: "sera_swap",
    });

    const paymentIntentId = (() => {
      try {
        const parsed = tx.notes ? JSON.parse(tx.notes) as { paymentIntentId?: string | null } : null;
        return parsed?.paymentIntentId ?? null;
      } catch { return null; }
    })();
    if (paymentIntentId) {
      await updatePaymentIntent(paymentIntentId, { status: "paid" }).catch(() => undefined);
    }
    const orderId = orderIdFromTransactionNotes(tx.notes);
    if (orderId) {
      await updateMenuOrderPayment(orderId, tx.merchantId, { status: "paid", paymentId: txId, transactionId: txId }).catch(() => undefined);
    }

    const merchant = await getMerchantById(tx.merchantId);
    if (merchant?.webhookUrl) {
      sendWebhook(
        merchant.webhookUrl,
        merchant.webhookSecret,
        {
          event: "payment.confirmed",
          txId,
          txHash,
          coin: tx.coin,
          amount: tx.amount,
          payCoin: tx.payCoin,
          payAmount: tx.payAmount,
          fromAddress: tx.fromAddress,
          toAddress: tx.toAddress,
          verified: true,
          source: "sera_swap",
        },
        { merchantId: merchant.id, txId, txHash }
      ).catch((error) => logSeraOperationFailure("payment-notification", error));
    }

    res.json({ success: true, status: "confirmed", txHash, sera: result });
  } catch (e: any) {
    const response = seraPaymentErrorResponse(e, "Unable to submit Sera swap");
    logSeraOperationFailure("payment/swap/submit", e);
    if (txForFailure) {
      await failTransactionRecord(txForFailure, response.body.error).catch((failError) => {
        logSeraOperationFailure("payment/swap/status-update", failError);
      });
    }
    res.status(response.status).json(response.body);
  }
});

/** POST /api/payment/notify — customer submits tx hash after sending */
paymentRouter.post("/payment/notify", async (req, res) => {
  try {
    const { txId, txHash, fromAddress } = req.body;
    if (!txId || typeof txId !== "string") { res.status(400).json({ error: "Missing txId" }); return; }
    if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) { res.status(400).json({ error: "Invalid txHash" }); return; }
    let tx = await getTransactionById(txId);
    if (!tx) { res.status(404).json({ error: "Transaction not found" }); return; }
    const staleCanceled = await cancelStaleMerchantTransactions(tx.merchantId, [tx]);
    if (staleCanceled > 0) tx = await getTransactionById(txId);
    if (!tx) { res.status(404).json({ error: "Transaction not found" }); return; }
    if (tx.status === "canceled") { res.status(409).json({ error: "Transaction was canceled" }); return; }
    if (tx.txHash && tx.txHash !== txHash) { res.status(409).json({ error: "Transaction already has a different txHash" }); return; }
    if (fromAddress) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(fromAddress)) { res.status(400).json({ error: "Invalid fromAddress" }); return; }
      const compliance = await screenWalletAddress(fromAddress, "payer_wallet", tx.merchantId);
      if (compliance.blocked) {
        await updateTransaction(txId, { status: "failed", notes: "Blocked by compliance screening" });
        res.status(403).json({ error: "Payer address failed compliance screening", compliance });
        return;
      }
    }
    try {
      await updateTransaction(txId, { txHash, fromAddress: fromAddress?.toLowerCase() || null, status: "confirming", notifiedAt: new Date() });
      const orderId = orderIdFromTransactionNotes(tx.notes);
      if (orderId) await updateMenuOrderPayment(orderId, tx.merchantId, { status: "payment_submitted", paymentId: txId, transactionId: txId }).catch(() => undefined);
    } catch (dbErr: any) {
      // Duplicate txHash across different payment records.
      if (dbErr?.cause?.code === "23505" || dbErr?.code === "23505") {
        res.status(409).json({ error: "This transaction hash is already associated with another payment" }); return;
      }
      throw dbErr;
    }
    notifySseClients(txId, { status: "confirming", txHash });
    // Fire-and-forget verification. The in-flight guard prevents duplicate
    // receipt watchers when the browser polls status at the same time.
    scheduleTransactionVerification(txId, txHash as `0x${string}`);
    res.json({ success: true, status: "confirming" });
  } catch (e) { logSeraOperationFailure("payment-route", e); res.status(500).json({ error: "Internal server error" }); }
});

/** GET /api/payment/status/:txId — poll payment status */
paymentRouter.get("/payment/status/:txId", async (req, res) => {
  try {
    let tx = await getTransactionById(req.params.txId);
    if (!tx) { res.status(404).json({ error: "Not found" }); return; }
    if (tx.status === "confirming") {
      tx = await reconcileSeraSwapTransaction(tx);
      if (tx.status === "confirming" && tx.txHash && !isSeraSwapTransaction(tx)) {
        scheduleTransactionVerification(tx.id, tx.txHash as `0x${string}`);
      }
    }
    const canceled = await cancelStaleMerchantTransactions(tx.merchantId, [tx]);
    if (canceled > 0) tx = await getTransactionById(req.params.txId);
    if (!tx) { res.status(404).json({ error: "Not found" }); return; }
    const merchant = await getMerchantById(tx.merchantId);
    res.json({
      txId: tx.id,
      status: tx.status,
      verified: tx.verified === 1,
      txHash: tx.txHash,
      coin: tx.coin,
      amount: tx.amount,
      toAddress: tx.toAddress,
      fromAddress: tx.fromAddress,
      memo: tx.memo || null,
      failureReason: transactionFailureReason(tx.notes) || tx.memo || null,
      createdAt: tx.createdAt,
      chainId: tx.chainId ?? 11155111,
      merchantName: merchant?.name || null,
      merchantLogo: merchant?.logoData || null,
      merchantDescription: (merchant as any)?.description || null,
    });
  } catch (e) { logSeraOperationFailure("payment-route", e); res.status(500).json({ error: "Internal server error" }); }
});

/** GET /api/payment/events/:txId — SSE stream for real-time status */
/** POST /api/payment/direct/scan — detect and record direct wallet QR ERC-20 transfers */
function withDirectScanTimeout<T>(promise: Promise<T>, timeoutMs = 8000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Direct scan RPC timeout")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

paymentRouter.post("/payment/direct/scan", async (req, res) => {
  try {
    const toAddress = String(req.body.toAddress ?? "").trim().toLowerCase();
    const coin = String(req.body.coin ?? "").trim().toUpperCase();
    const amount = String(req.body.amount ?? "").trim();
    const chainId = Number(req.body.chainId ?? 11155111);
    const paymentUrl = typeof req.body.paymentUrl === "string" ? req.body.paymentUrl : null;
    const requestedFromBlock = req.body.fromBlock !== undefined && req.body.fromBlock !== null && req.body.fromBlock !== ""
      ? BigInt(String(req.body.fromBlock))
      : null;

    if (!/^0x[0-9a-fA-F]{40}$/.test(toAddress)) { res.status(400).json({ error: "Invalid receiver wallet" }); return; }
    if (!COIN_SYMBOL_RE.test(coin)) { res.status(400).json({ error: "Unsupported coin" }); return; }
    if (!/^\d+(\.\d{1,6})?$/.test(amount) || Number(amount) <= 0) { res.status(400).json({ error: "Invalid amount" }); return; }
    const client = CHAIN_CLIENTS[chainId];
    if (!client) { res.status(400).json({ error: "Unsupported chain" }); return; }
    try {
      await resolveSeraTokenForChain(chainId, coin);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Unsupported coin on this network" });
      return;
    }

    let latestBlock: bigint;
    try {
      latestBlock = await withDirectScanTimeout(client.getBlockNumber(), 8000);
    } catch {
      res.json({ status: "pending", fromBlock: requestedFromBlock?.toString() ?? null, warning: "Scanner RPC is temporarily slow" });
      return;
    }
    const minimumFromBlock = latestBlock > 49n ? latestBlock - 49n : 0n;
    const requestedStart = requestedFromBlock ?? (latestBlock > 3n ? latestBlock - 3n : 0n);
    // Clamp every request to the provider-safe 50-block inclusive window.
    const fromBlock = requestedStart < minimumFromBlock
      ? minimumFromBlock
      : requestedStart > latestBlock
        ? latestBlock
        : requestedStart;
    let match: Awaited<ReturnType<typeof findDirectTransfer>> | null = null;
    try {
      match = await withDirectScanTimeout(findDirectTransfer({ toAddress, coin, amount, chainId, fromBlock, toBlock: latestBlock }), 8000);
    } catch {
      res.json({ status: "pending", fromBlock: fromBlock.toString(), latestBlock: latestBlock.toString(), warning: "Scanner RPC is temporarily slow" });
      return;
    }
    if (!match?.txHash) {
      res.json({ status: "pending", fromBlock: (latestBlock + 1n).toString(), latestBlock: latestBlock.toString() });
      return;
    }

    if ("amountMismatch" in match && match.amountMismatch) {
      const actualAmount = match.actualAmount || "0";
      const recorded = await recordDirectTransferFailure({
        txHash: match.txHash,
        fromAddress: match.fromAddress,
        toAddress,
        coin,
        expectedAmount: amount,
        actualAmount,
        chainId,
        paymentUrl,
        reason: `Expected ${amount} ${coin}, received ${actualAmount} ${coin}.`,
      });
      res.json({
        status: "amount_mismatch",
        fromBlock: (latestBlock + 1n).toString(),
        latestBlock: (match.latestBlock ?? latestBlock).toString(),
        expectedAmount: amount,
        actualAmount,
        coin,
        message: `Received ${actualAmount} ${coin}, but this QR requires ${amount} ${coin}.`,
        transaction: transactionToJson(recorded.transaction),
        created: recorded.created,
      });
      return;
    }

    const recorded = await recordDirectTransferPayment({
      txHash: match.txHash,
      fromAddress: match.fromAddress,
      toAddress,
      coin,
      amount,
      chainId,
      paymentUrl,
      verified: true,
    });
    res.json({
      status: "confirmed",
      fromBlock: fromBlock.toString(),
      latestBlock: (match.latestBlock ?? latestBlock).toString(),
      transaction: transactionToJson(recorded.transaction),
      created: recorded.created,
    });
  } catch (e: any) {
    logSeraOperationFailure("payment/direct/scan", e);
    res.status(500).json({ error: "Unable to scan direct payment" });
  }
});

paymentRouter.get("/payment/events/:txId", (req, res) => {
  const txId = req.params.txId;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  if (!sseClients.has(txId)) sseClients.set(txId, new Set());
  sseClients.get(txId)!.add(res);
  res.write(`data: ${JSON.stringify({ status: "connected" })}\n\n`);
  const heartbeat = setInterval(() => { try { res.write(": heartbeat\n\n"); } catch { clearInterval(heartbeat); } }, 25000);
  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.get(txId)?.delete(res);
    if (sseClients.get(txId)?.size === 0) sseClients.delete(txId);
  });
});

// ─── Async verification ───────────────────────────────────────────────────────

// ─── ERC-20 Transfer ABI (only the Transfer event) ──────────────────────────
const ERC20_ABI = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function decimals() view returns (uint8)",
]);
const ERC20_TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const SERA_INTENT_MATCHED_EVENT = parseAbiItem("event IntentMatched(bytes32 indexed intentHash, address indexed taker, uint256 legCount)");

// Sepolia USDC contract address (Circle's official)
const ALCHEMY_API_KEY = ENV.alchemyApiKey;
const ALCHEMY_HTTP_URLS: Record<number, string> = {
  1: "https://eth-mainnet.g.alchemy.com/v2",
  11155111: "https://eth-sepolia.g.alchemy.com/v2",
};
const PUBLIC_RPC_URLS: Record<number, string[]> = {
  1: ["https://ethereum.publicnode.com", "https://eth.llamarpc.com", "https://1rpc.io/eth"],
  11155111: ["https://ethereum-sepolia-rpc.publicnode.com", "https://sepolia.drpc.org"],
};

function rpcHttpTransport(chainId: number) {
  const configuredRpcUrl = ENV.rpcUrls[chainId];
  if (configuredRpcUrl) return http(configuredRpcUrl);
  const alchemyBaseUrl = ALCHEMY_API_KEY ? ALCHEMY_HTTP_URLS[chainId] : null;
  const urls = [
    ...(alchemyBaseUrl ? [`${alchemyBaseUrl}/${ALCHEMY_API_KEY}`] : []),
    ...(PUBLIC_RPC_URLS[chainId] ?? []),
  ];
  return urls.length > 0 ? fallback(urls.map((url) => http(url))) : http();
}

// WebSocket client for Sepolia (Alchemy) — used for real-time log subscriptions
const sepoliaWsClient = ALCHEMY_API_KEY
  ? createPublicClient({
      chain: sepolia,
      transport: webSocket(`wss://eth-sepolia.g.alchemy.com/v2/${ALCHEMY_API_KEY}`),
    })
  : null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CHAIN_CLIENTS: Record<number, any> = {
  1:        createPublicClient({ chain: mainnet,  transport: rpcHttpTransport(1) }),
  11155111: createPublicClient({ chain: sepolia,  transport: rpcHttpTransport(11155111) }),
};

const SERA_CHAIN_SCAN_INTERVAL_MS = 8_000;
const SERA_CHAIN_SCAN_CHUNK_SIZE = 49n;
const SERA_CHAIN_SCAN_MAX_BLOCKS = SERA_CHAIN_SCAN_CHUNK_SIZE * 10n;
const seraChainScanState = new Map<string, { lastFinishedAt: number; promise: Promise<Transaction> | null }>();

function parseStoredBlockNumber(value: unknown): bigint | null {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") return null;
  try {
    const blockNumber = BigInt(value);
    return blockNumber >= 0n ? blockNumber : null;
  } catch {
    return null;
  }
}

async function performSeraSwapOnChainReconciliation(tx: Transaction, notes: Record<string, unknown>): Promise<Transaction> {
  const intentHash = typeof notes.intentHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(notes.intentHash)
    ? notes.intentHash as `0x${string}`
    : null;
  const client = CHAIN_CLIENTS[Number(tx.chainId)];
  if (!intentHash || !client) return tx;

  const baseUrl = getSeraApiBaseUrlForChain(tx.chainId);
  const [config, token] = await Promise.all([
    callSeraApi<SeraConfigResponse>({ baseUrl, path: "/config", authMode: "none", merchantId: tx.merchantId }),
    resolveSeraTokenForChain(tx.chainId, tx.coin),
  ]);
  if (Number(config.chain_id) !== Number(tx.chainId)) return tx;
  if (!config.sor_address || !/^0x[0-9a-fA-F]{40}$/.test(config.sor_address)) return tx;
  if (!config.vault_address || !/^0x[0-9a-fA-F]{40}$/.test(config.vault_address)) return tx;

  const latestBlock = BigInt(String(await withDirectScanTimeout(client.getBlockNumber(), 8_000)));
  const submittedBlock = parseStoredBlockNumber(notes.submittedBlockNumber);
  const lastScannedBlock = parseStoredBlockNumber(notes.seraLastScannedBlock);
  let fromBlock = lastScannedBlock !== null
    ? lastScannedBlock + 1n
    : submittedBlock !== null
      ? (submittedBlock > 2n ? submittedBlock - 2n : 0n)
      : (latestBlock > SERA_CHAIN_SCAN_CHUNK_SIZE ? latestBlock - SERA_CHAIN_SCAN_CHUNK_SIZE : 0n);
  if (fromBlock > latestBlock) return tx;

  const scanToBlock = fromBlock + SERA_CHAIN_SCAN_MAX_BLOCKS - 1n < latestBlock
    ? fromBlock + SERA_CHAIN_SCAN_MAX_BLOCKS - 1n
    : latestBlock;
  const expectedRawAmount = BigInt(toRawTokenAmount(String(tx.amount), token.decimals));

  for (let chunkFrom = fromBlock; chunkFrom <= scanToBlock; chunkFrom += SERA_CHAIN_SCAN_CHUNK_SIZE) {
    const chunkTo = chunkFrom + SERA_CHAIN_SCAN_CHUNK_SIZE - 1n < scanToBlock
      ? chunkFrom + SERA_CHAIN_SCAN_CHUNK_SIZE - 1n
      : scanToBlock;
    const matchedLogs = await withDirectScanTimeout(client.getLogs({
      address: config.sor_address.toLowerCase() as `0x${string}`,
      event: SERA_INTENT_MATCHED_EVENT,
      args: { intentHash },
      fromBlock: chunkFrom,
      toBlock: chunkTo,
    }), 8_000);

    for (const matchedLog of matchedLogs as any[]) {
      const txHash = String(matchedLog.transactionHash || "").toLowerCase();
      const blockNumber = parseStoredBlockNumber(matchedLog.blockNumber);
      if (!/^0x[0-9a-f]{64}$/.test(txHash) || blockNumber === null) continue;

      const payoutLogs = await withDirectScanTimeout(client.getLogs({
        address: token.address.toLowerCase() as `0x${string}`,
        event: ERC20_TRANSFER_EVENT,
        args: {
          from: config.vault_address.toLowerCase() as `0x${string}`,
          to: tx.toAddress.toLowerCase() as `0x${string}`,
        },
        fromBlock: blockNumber,
        toBlock: blockNumber,
      }), 8_000);
      const payout = (payoutLogs as any[]).find((log) => {
        if (String(log.transactionHash || "").toLowerCase() !== txHash) return false;
        try { return BigInt(String(log.args?.value ?? 0)) >= expectedRawAmount; } catch { return false; }
      });
      if (!payout) continue;

      const alreadyRecorded = await getTransactionByHash(txHash);
      if (alreadyRecorded && alreadyRecorded.id !== tx.id) {
        console.warn("[payment/swap/reconcile-chain] Settlement hash already belongs to another payment");
        return tx;
      }
      const merchant = await getMerchantById(tx.merchantId);
      if (!merchant) return tx;

      const rawPayout = BigInt(String(payout.args?.value ?? 0));
      const settlementNotes = JSON.stringify({
        ...notes,
        seraStatus: "settled",
        seraOnchainSettlement: {
          intentHash,
          txHash,
          blockNumber: blockNumber.toString(),
          payoutRaw: rawPayout.toString(),
          verifiedAgainst: "IntentMatched+VaultTransfer",
        },
      });
      await updateTransaction(tx.id, { notes: settlementNotes });
      const pending = await getTransactionById(tx.id) ?? { ...tx, notes: settlementNotes };
      return confirmPendingDirectTransfer({
        pending,
        merchant,
        txHash: txHash as `0x${string}`,
        fromAddress: tx.fromAddress,
        toAddress: tx.toAddress,
        coin: tx.coin,
        amount: fromRawTokenAmount(rawPayout, token.decimals),
        verified: true,
      });
    }
  }

  const current = await getTransactionById(tx.id) ?? tx;
  let currentNotes = notes;
  try { currentNotes = current.notes ? JSON.parse(current.notes) as Record<string, unknown> : notes; } catch {}
  await updateTransaction(tx.id, {
    notes: JSON.stringify({ ...currentNotes, seraLastScannedBlock: scanToBlock.toString() }),
  });
  return await getTransactionById(tx.id) ?? current;
}

async function reconcileSeraSwapOnChain(tx: Transaction, notes: Record<string, unknown>): Promise<Transaction> {
  if (tx.status !== "confirming") return tx;
  const existing = seraChainScanState.get(tx.id);
  if (existing?.promise) return existing.promise;
  if (existing && Date.now() - existing.lastFinishedAt < SERA_CHAIN_SCAN_INTERVAL_MS) return tx;

  const promise = performSeraSwapOnChainReconciliation(tx, notes).catch((error) => {
    logSeraOperationFailure("payment/swap/reconcile-chain", error);
    return tx;
  });
  seraChainScanState.set(tx.id, { lastFinishedAt: existing?.lastFinishedAt ?? 0, promise });
  try {
    return await promise;
  } finally {
    seraChainScanState.set(tx.id, { lastFinishedAt: Date.now(), promise: null });
  }
}

const DIRECT_SYNC_INTERVAL_MS = 30_000;
const DIRECT_SYNC_LOOKBACK_BLOCKS: Record<number, bigint> = {
  // Public RPC providers commonly cap eth_getLogs at 50 inclusive blocks.
  1: 49n,
  11155111: 49n,
};
const directSyncState = new Map<string, { lastFinishedAt: number; promise: Promise<void> | null }>();

async function getTokenDecimals(client: any, tokenAddress: `0x${string}`): Promise<number> {
  try {
    const decimals = await client.readContract({ address: tokenAddress, abi: ERC20_ABI, functionName: "decimals" });
    const parsed = Number(decimals);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 6;
  } catch {
    return 6;
  }
}

function uniqueEvmAddresses(addresses: Array<string | null | undefined>): string[] {
  return Array.from(new Set(
    addresses
      .map((address) => String(address || "").trim().toLowerCase())
      .filter((address) => /^0x[0-9a-fA-F]{40}$/.test(address)),
  ));
}

async function tokenSymbolsForMerchantChain(merchant: Merchant, chainId: number): Promise<string[]> {
  const registry = await getPaymentTokenRegistry(getSeraApiBaseUrlForChain(chainId));
  const supported = new Set(registry.map((token) => token.symbol.toUpperCase()));
  const recent = await getMerchantTransactions(merchant.id, 100).catch(() => []);
  return Array.from(new Set([
    String(merchant.receiveCoin || "").toUpperCase(),
    ...recent
      .filter((tx) => Number(tx.chainId ?? SERA_TESTNET_CHAIN_ID) === chainId)
      .map((tx) => String(tx.coin || "").toUpperCase()),
  ])).filter((symbol) => supported.has(symbol));
}

async function directSyncChainCandidates(merchant: Merchant, preferredChainId?: number | null): Promise<number[]> {
  void merchant;
  if (preferredChainId === SERA_MAINNET_CHAIN_ID || preferredChainId === SERA_TESTNET_CHAIN_ID) {
    return [preferredChainId];
  }
  return [SERA_MAINNET_CHAIN_ID];
}

function rawAmountsNearlyEqual(a: bigint, b: bigint) {
  const diff = a > b ? a - b : b - a;
  return diff <= 1n;
}

async function findMatchingPendingTransaction({
  merchantId,
  toAddress,
  coin,
  chainId,
  rawAmount,
  decimals,
}: {
  merchantId: string;
  toAddress: string;
  coin: string;
  chainId: number;
  rawAmount: bigint;
  decimals: number;
}) {
  const recent = await getMerchantTransactions(merchantId, 100);
  return recent.find((tx) => {
    if (tx.txHash) return false;
    if (tx.status !== "pending" && tx.status !== "confirming") return false;
    if (String(tx.toAddress || "").toLowerCase() !== toAddress.toLowerCase()) return false;
    if (String(tx.coin || "").toUpperCase() !== coin.toUpperCase()) return false;
    if (Number(tx.chainId ?? 11155111) !== chainId) return false;
    try {
      return rawAmountsNearlyEqual(BigInt(toRawTokenAmount(String(tx.amount), decimals)), rawAmount);
    } catch {
      return false;
    }
  });
}

async function notifyRecordedDirectTransfer({
  merchant,
  txId,
  txHash,
  coin,
  amount,
  payCoin,
  payAmount,
  fromAddress,
  toAddress,
  verified,
  source = "direct_wallet_qr",
}: {
  merchant: Merchant;
  txId: string;
  txHash: `0x${string}`;
  coin: string;
  amount: string;
  payCoin?: string | null;
  payAmount?: string | null;
  fromAddress?: string | null;
  toAddress: string;
  verified: boolean;
  source?: "direct_wallet_qr" | "sera_swap";
}) {
  notifyMerchantSse(merchant.id, {
    event: "payment_received",
    transactionId: txId,
    txHash,
    amount,
    coin,
    payAmount: payAmount || amount,
    payCoin: payCoin || coin,
    from: fromAddress?.toLowerCase() || null,
    verified,
    source,
  });

  if (merchant.webhookUrl) {
    sendWebhook(
      merchant.webhookUrl,
      merchant.webhookSecret,
      {
        event: "payment.confirmed",
        txId,
        txHash,
        coin,
        amount,
        payCoin: payCoin || coin,
        payAmount: payAmount || amount,
        fromAddress: fromAddress?.toLowerCase() || null,
        toAddress,
        verified,
        source,
      },
      { merchantId: merchant.id, txId, txHash },
    ).catch((error) => logSeraOperationFailure("payment-notification", error));
  }
}

async function confirmPendingDirectTransfer({
  pending,
  merchant,
  txHash,
  fromAddress,
  toAddress,
  coin,
  amount,
  verified,
}: {
  pending: Transaction;
  merchant: Merchant;
  txHash: `0x${string}`;
  fromAddress?: string | null;
  toAddress: string;
  coin: string;
  amount: string;
  verified: boolean;
}) {
  const meta = transactionNotesMeta(pending.notes);
  const source = isSeraSwapTransaction(pending) ? "sera_swap" : "direct_wallet_qr";
  await updateTransaction(pending.id, {
    txHash,
    fromAddress: source === "sera_swap"
      ? pending.fromAddress
      : fromAddress?.toLowerCase() || null,
    status: "confirmed",
    verified: verified ? 1 : 0,
    payCoin: pending.payCoin || coin,
    payAmount: pending.payAmount || amount,
    notifiedAt: new Date(),
    webhookSentAt: merchant.webhookUrl ? new Date() : null,
  });
  if (meta.orderId) {
    await updateMenuOrderPayment(meta.orderId, merchant.id, { status: "paid", paymentId: pending.id, transactionId: pending.id }).catch(() => undefined);
  }
  if (meta.paymentIntentId) {
    await updatePaymentIntent(meta.paymentIntentId, { status: "paid" }).catch(() => undefined);
  }
  notifySseClients(pending.id, { status: "confirmed", txHash, verified });
  await notifyRecordedDirectTransfer({
    merchant,
    txId: pending.id,
    txHash,
    coin: pending.coin,
    amount: pending.amount,
    payCoin: pending.payCoin || coin,
    payAmount: pending.payAmount || amount,
    fromAddress: source === "sera_swap" ? pending.fromAddress : fromAddress,
    toAddress,
    verified,
    source,
  });
  return await getTransactionById(pending.id) ?? pending;
}

async function scanDirectTransfersForReceiver({
  merchant,
  toAddress,
  coin,
  chainId,
  fromBlock,
}: {
  merchant: Merchant;
  toAddress: string;
  coin: string;
  chainId: number;
  fromBlock: bigint;
}) {
  const client = CHAIN_CLIENTS[chainId];
  const token = await resolveSeraTokenForChain(chainId, coin).catch(() => null);
  const coinAddress = token?.address as `0x${string}` | undefined;
  if (!client || !coinAddress) return;

  const decimals = token?.decimals ?? await getTokenDecimals(client, coinAddress);
  const logs = await client.getLogs({
    address: coinAddress,
    event: ERC20_TRANSFER_EVENT,
    args: { to: toAddress.toLowerCase() as `0x${string}` },
    fromBlock,
    toBlock: "latest",
  });

  for (const log of logs) {
    const txHash = String(log.transactionHash || "");
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) continue;
    if (await getTransactionByHash(txHash)) continue;

    const args = (log as any).args || {};
    const rawAmount = BigInt(String(args.value ?? 0));
    if (rawAmount <= 0n) continue;
    const amount = fromRawTokenAmount(rawAmount, decimals);
    const fromAddress = typeof args.from === "string" ? args.from.toLowerCase() : null;
    const pending = await findMatchingPendingTransaction({
      merchantId: merchant.id,
      toAddress,
      coin,
      chainId,
      rawAmount,
      decimals,
    });

    if (pending) {
      await confirmPendingDirectTransfer({
        pending,
        merchant,
        txHash: txHash as `0x${string}`,
        fromAddress,
        toAddress,
        coin,
        amount,
        verified: true,
      });
      continue;
    }

    await recordDirectTransferPayment({
      txHash: txHash as `0x${string}`,
      fromAddress,
      toAddress,
      coin,
      amount,
      chainId,
      paymentUrl: null,
      verified: true,
    });
  }
}

async function syncMerchantDirectTransfers(merchant: Merchant, chainId: number) {
  const client = CHAIN_CLIENTS[chainId];
  if (!client) return;
  const symbols = await tokenSymbolsForMerchantChain(merchant, chainId).catch(() => []);
  if (symbols.length === 0) return;

  const key = `${merchant.id}:${chainId}`;
  const existing = directSyncState.get(key);
  if (existing?.promise) return existing.promise;
  if (existing && Date.now() - existing.lastFinishedAt < DIRECT_SYNC_INTERVAL_MS) return;

  const promise = (async () => {
    const latestBlock = BigInt(String(await withDirectScanTimeout(client.getBlockNumber(), 8000)));
    const lookback = DIRECT_SYNC_LOOKBACK_BLOCKS[chainId] ?? 900n;
    const fromBlock = latestBlock > lookback ? latestBlock - lookback : 0n;
    const subWallets = await listSubWallets(merchant.id).catch(() => []);
    const receiverAddresses = uniqueEvmAddresses([
      merchant.walletAddress,
      merchant.storeAddress,
      ...subWallets
        .filter((wallet) => wallet.status === "active" && Number(wallet.chainId ?? chainId) === chainId)
        .map((wallet) => wallet.address),
    ]);

    const scanTasks = receiverAddresses.flatMap((toAddress) =>
      symbols.map((coin) =>
        withDirectScanTimeout(scanDirectTransfersForReceiver({ merchant, toAddress, coin, chainId, fromBlock }), 8000)
          .catch((error) => logSeraOperationFailure("direct-sync/scan", error)),
      ),
    );
    await Promise.allSettled(scanTasks);
  })();

  directSyncState.set(key, { lastFinishedAt: existing?.lastFinishedAt ?? 0, promise });
  try {
    await promise;
  } finally {
    directSyncState.set(key, { lastFinishedAt: Date.now(), promise: null });
  }
}

async function syncMerchantDirectActivity(merchant: Merchant, preferredChainId?: number | null) {
  const chainIds = await directSyncChainCandidates(merchant, preferredChainId);
  await Promise.allSettled(chainIds.map((chainId) =>
    syncMerchantDirectTransfers(merchant, chainId)
      .catch((error) => logSeraOperationFailure("direct-sync/chain", error)),
  ));
}

async function resolveMerchantForReceiver(toAddress: string) {
  const normalizedTo = toAddress.toLowerCase();
  const subWallet = await getSubWalletByAddress(normalizedTo);
  if (subWallet) {
    const merchant = await getMerchantById(subWallet.merchantId);
    if (merchant) return { merchant, receiveAddress: subWallet.address.toLowerCase() };
  }
  const merchant = await getMerchantByWallet(normalizedTo) || await getMerchantByStoreAddress(normalizedTo);
  if (!merchant) return null;
  return { merchant, receiveAddress: normalizedTo };
}

async function recordDirectTransferPayment({
  txHash,
  fromAddress,
  toAddress,
  coin,
  amount,
  chainId,
  paymentUrl,
  verified,
}: {
  txHash: `0x${string}`;
  fromAddress?: string | null;
  toAddress: string;
  coin: string;
  amount: string;
  chainId: number;
  paymentUrl?: string | null;
  verified: boolean;
}) {
  const normalizedTxHash = txHash.toLowerCase() as `0x${string}`;
  const existing = await getTransactionByHash(normalizedTxHash) || await getTransactionByHash(txHash);
  if (existing) {
    return { transaction: existing, created: false };
  }

  const resolved = await resolveMerchantForReceiver(toAddress);
  if (!resolved) {
    throw new Error("Receiver wallet is not attached to a SeraPay merchant.");
  }

  const client = CHAIN_CLIENTS[chainId];
  const token = await resolveSeraTokenForChain(chainId, coin).catch(() => null);
  const coinAddress = token?.address as `0x${string}` | undefined;
  if (client && coinAddress) {
    const decimals = token?.decimals ?? await getTokenDecimals(client, coinAddress);
    const rawAmount = BigInt(toRawTokenAmount(amount, decimals));
    const pending = await findMatchingPendingTransaction({
      merchantId: resolved.merchant.id,
      toAddress: resolved.receiveAddress,
      coin,
      chainId,
      rawAmount,
      decimals,
    });
    if (pending) {
      const transaction = await confirmPendingDirectTransfer({
        pending,
        merchant: resolved.merchant,
        txHash: normalizedTxHash,
        fromAddress,
        toAddress: resolved.receiveAddress,
        coin,
        amount,
        verified,
      });
      return { transaction, created: false };
    }
  }

  const txId = uuidv4();
  const notes = JSON.stringify({
    type: "direct_wallet_qr",
    paymentUrl: typeof paymentUrl === "string" ? paymentUrl.slice(0, 1200) : null,
  });

  await createTransaction({
    id: txId,
    merchantId: resolved.merchant.id,
    txHash: normalizedTxHash,
    fromAddress: fromAddress?.toLowerCase() || null,
    toAddress: resolved.receiveAddress,
    coin,
    amount,
    chainId,
    status: "confirmed",
    verified: verified ? 1 : 0,
    payCoin: coin,
    payAmount: amount,
    notes,
    notifiedAt: new Date(),
    webhookSentAt: resolved.merchant.webhookUrl ? new Date() : null,
  });

  const transaction = await getTransactionById(txId);
  notifyMerchantSse(resolved.merchant.id, {
    event: "payment_received",
    transactionId: txId,
    txHash: normalizedTxHash,
    amount,
    coin,
    payAmount: amount,
    payCoin: coin,
    from: fromAddress?.toLowerCase() || null,
    verified,
    source: "direct_wallet_qr",
  });

  if (resolved.merchant.webhookUrl) {
    sendWebhook(
      resolved.merchant.webhookUrl,
      resolved.merchant.webhookSecret,
      {
        event: "payment.confirmed",
        txId,
        txHash: normalizedTxHash,
        coin,
        amount,
        payCoin: coin,
        payAmount: amount,
        fromAddress: fromAddress?.toLowerCase() || null,
        toAddress: resolved.receiveAddress,
        verified,
        source: "direct_wallet_qr",
      },
      { merchantId: resolved.merchant.id, txId, txHash: normalizedTxHash },
    ).catch((error) => logSeraOperationFailure("payment-notification", error));
  }

  return { transaction: transaction!, created: true };
}

async function recordDirectTransferFailure({
  txHash,
  fromAddress,
  toAddress,
  coin,
  expectedAmount,
  actualAmount,
  chainId,
  paymentUrl,
  reason,
}: {
  txHash: `0x${string}`;
  fromAddress?: string | null;
  toAddress: string;
  coin: string;
  expectedAmount: string;
  actualAmount: string;
  chainId: number;
  paymentUrl?: string | null;
  reason: string;
}) {
  const normalizedTxHash = txHash.toLowerCase() as `0x${string}`;
  const existing = await getTransactionByHash(normalizedTxHash) || await getTransactionByHash(txHash);
  if (existing) {
    return { transaction: existing, created: false };
  }

  const resolved = await resolveMerchantForReceiver(toAddress);
  if (!resolved) {
    throw new Error("Receiver wallet is not attached to a SeraPay merchant.");
  }

  const txId = uuidv4();
  const safeReason = reason.slice(0, 180);
  const notes = JSON.stringify({
    type: "direct_wallet_qr",
    paymentUrl: typeof paymentUrl === "string" ? paymentUrl.slice(0, 1200) : null,
    errorCode: "amount_mismatch",
    expectedAmount,
    actualAmount,
    reason: safeReason,
  });

  await createTransaction({
    id: txId,
    merchantId: resolved.merchant.id,
    txHash: normalizedTxHash,
    fromAddress: fromAddress?.toLowerCase() || null,
    toAddress: resolved.receiveAddress,
    coin,
    amount: actualAmount,
    chainId,
    status: "failed",
    verified: 1,
    payCoin: coin,
    payAmount: actualAmount,
    memo: safeReason,
    notes,
    notifiedAt: new Date(),
  });

  const transaction = await getTransactionById(txId);
  notifyMerchantSse(resolved.merchant.id, {
    event: "payment_failed",
    transactionId: txId,
    txHash: normalizedTxHash,
    amount: actualAmount,
    coin,
    payAmount: actualAmount,
    payCoin: coin,
    from: fromAddress?.toLowerCase() || null,
    verified: true,
    source: "direct_wallet_qr",
    errorCode: "amount_mismatch",
    expectedAmount,
  });

  return { transaction: transaction!, created: true };
}

async function findDirectTransfer({
  toAddress,
  coin,
  amount,
  chainId,
  fromBlock,
  toBlock,
}: {
  toAddress: string;
  coin: string;
  amount: string;
  chainId: number;
  fromBlock: bigint;
  toBlock: bigint;
}) {
  const client = CHAIN_CLIENTS[chainId];
  const token = await resolveSeraTokenForChain(chainId, coin).catch(() => null);
  const coinAddress = token?.address as `0x${string}` | undefined;
  if (!client || !coinAddress) return null;

  const decimals = token?.decimals ?? await getTokenDecimals(client, coinAddress);
  const expectedRaw = BigInt(toRawTokenAmount(amount, decimals));
  const logs = await client.getLogs({
    address: coinAddress,
    event: ERC20_TRANSFER_EVENT,
    args: { to: toAddress.toLowerCase() as `0x${string}` },
    fromBlock,
    toBlock,
  });

  let mismatch: {
    txHash: `0x${string}`;
    fromAddress: string | null;
    latestBlock: bigint;
    amountMismatch: true;
    actualAmount: string;
  } | null = null;

  for (const log of logs) {
    const args = (log as any).args || {};
    const actualRaw = BigInt(String(args.value ?? 0));
    const txHash = String(log.transactionHash || "");
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) continue;
    const diff = actualRaw > expectedRaw ? actualRaw - expectedRaw : expectedRaw - actualRaw;
    if (diff > 1n) {
      mismatch ??= {
        txHash: txHash as `0x${string}`,
        fromAddress: typeof args.from === "string" ? args.from.toLowerCase() : null,
        latestBlock: toBlock,
        amountMismatch: true,
        actualAmount: fromRawTokenAmount(actualRaw, decimals),
      };
      continue;
    }
    return {
      txHash: txHash as `0x${string}`,
      fromAddress: typeof args.from === "string" ? args.from.toLowerCase() : null,
      latestBlock: toBlock,
    };
  }

  return mismatch ?? { txHash: null, fromAddress: null, latestBlock: toBlock };
}

/**
 * Wait for a transaction receipt using Alchemy WebSocket subscription.
 * Subscribes to new block headers and checks for the receipt on each block.
 * Falls back gracefully if the WebSocket times out.
 */
async function waitForReceiptViaWs(
  wsClient: ReturnType<typeof createPublicClient>,
  txHash: `0x${string}`,
  timeoutMs: number
): Promise<any> {
  return new Promise((resolve, reject) => {
    let unwatch: (() => void) | null = null;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (unwatch) { try { unwatch(); } catch {} }
      reject(new Error("WebSocket receipt wait timed out"));
    }, timeoutMs);

    const cleanup = (result?: any, err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (unwatch) { try { unwatch(); } catch {} }
      if (err) reject(err); else resolve(result);
    };

    // Subscribe to new blocks and check receipt on each
    (wsClient as any).watchBlockNumber({
      onBlockNumber: async () => {
        if (settled) return;
        try {
          const receipt = await (wsClient as any).getTransactionReceipt({ hash: txHash });
          if (receipt) cleanup(receipt);
        } catch { /* not yet mined, wait for next block */ }
      },
      onError: (err: Error) => {
        console.warn("[ws] block subscription error");
        cleanup(undefined, err);
      },
    }).then((unwatchFn: () => void) => {
      unwatch = unwatchFn;
      // Also do an immediate check in case it's already mined
      (wsClient as any).getTransactionReceipt({ hash: txHash })
        .then((receipt: any) => { if (receipt) cleanup(receipt); })
        .catch(() => {});
    }).catch((err: Error) => cleanup(undefined, err));
  });
}

async function verifyTransactionAsync(txId: string, txHash: `0x${string}`) {
  const tx = await getTransactionById(txId);
  if (!tx || tx.status === "confirmed") return;
  const meta = transactionNotesMeta(tx.notes);
  const orderId = meta.orderId;

  const chainId = tx.chainId ?? 11155111;
  const client = CHAIN_CLIENTS[chainId];
  if (!client) {
    console.error(`[verify] No client for chainId ${chainId}`);
    await updateTransaction(txId, { status: "failed" });
    if (orderId) await updateMenuOrderPayment(orderId, tx.merchantId, { status: "failed", paymentId: txId, transactionId: txId }).catch(() => undefined);
    if (meta.paymentIntentId) await updatePaymentIntent(meta.paymentIntentId, { status: "failed" }).catch(() => undefined);
    notifySseClients(txId, { status: "failed", txHash });
    return;
  }

  // Try WebSocket subscription first (Sepolia + Alchemy key available)
  let receipt = null;
  if (chainId === 11155111 && sepoliaWsClient) {
    try {
      receipt = await waitForReceiptViaWs(sepoliaWsClient, txHash, 180_000);
    } catch (e) {
      console.warn("[verify] WebSocket receipt wait failed; falling back to polling");
    }
  }

  // Fallback: poll for receipt up to 3 minutes (36 × 5s)
  if (!receipt) {
    for (let i = 0; i < 36; i++) {
      try {
        receipt = await client.getTransactionReceipt({ hash: txHash });
        if (receipt) break;
      } catch { /* not yet mined */ }
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  if (!receipt) {
    // RPCs and chains can be slow. A timeout is not evidence that the transfer
    // failed, so keep it confirming and allow a later status poll to retry.
    console.warn("[verify] Transaction is still pending after the receipt wait window");
    notifySseClients(txId, { status: "confirming", txHash });
    return;
  }

  if (receipt.status !== "success") {
    console.warn("[verify] Transaction reverted");
    await updateTransaction(txId, { status: "failed" });
    if (orderId) await updateMenuOrderPayment(orderId, tx.merchantId, { status: "failed", paymentId: txId, transactionId: txId }).catch(() => undefined);
    if (meta.paymentIntentId) await updatePaymentIntent(meta.paymentIntentId, { status: "failed" }).catch(() => undefined);
    notifySseClients(txId, { status: "failed", txHash });
    return;
  }

  // Verify the Transfer event matches expected coin, toAddress, and amount
  const token = await resolveSeraTokenForChain(chainId, tx.coin).catch(() => null);
  const coinAddress = token?.address as `0x${string}` | undefined;
  if (!token || !coinAddress) {
    console.warn(`[verify] Unknown coin ${tx.coin} on chain ${chainId}`);
    await failTransactionRecord(tx, `Token ${tx.coin} is not in the active Sera registry for chain ${chainId}.`);
    return;
  }

  // Parse Transfer logs from the ERC-20 contract
  let transferVerified = false;
  const tokenDecimals = token.decimals;
  const expectedRaw = BigInt(toRawTokenAmount(String(tx.amount), tokenDecimals));
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== coinAddress.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: ERC20_ABI, data: log.data, topics: log.topics as any }) as any;
      if (decoded.eventName !== "Transfer") continue;
      const toMatch = (decoded.args.to as string).toLowerCase() === tx.toAddress.toLowerCase();
      if (!toMatch) continue;
      // Verify amount (allow ±1 unit tolerance for rounding)
      const actualRaw = BigInt(decoded.args.value);
      const diff = actualRaw > expectedRaw ? actualRaw - expectedRaw : expectedRaw - actualRaw;
      if (diff <= 1n) {
        transferVerified = true;
        break;
      }
    } catch { /* skip malformed log */ }
  }

  if (!transferVerified) {
    console.warn("[verify] Transfer event not found or amount mismatch");
    await failTransactionRecord(tx, "The submitted transaction did not contain the expected token transfer, recipient, and amount.");
    return;
  } else {
    await updateTransaction(txId, { status: "confirmed", verified: 1 });
    if (orderId) await updateMenuOrderPayment(orderId, tx.merchantId, { status: "paid", paymentId: txId, transactionId: txId }).catch(() => undefined);
    if (meta.paymentIntentId) await updatePaymentIntent(meta.paymentIntentId, { status: "paid" }).catch(() => undefined);
    notifySseClients(txId, { status: "confirmed", txHash, verified: true });
  }

  // Notify merchant dashboard (SSE + polling buffer)
  notifyMerchantSse(tx.merchantId, { event: "payment_received", transactionId: txId, txHash, amount: tx.amount, coin: tx.coin, from: tx.fromAddress, verified: transferVerified });

  // Send webhook
  const merchant = await getMerchantById(tx.merchantId);
  if (merchant?.webhookUrl) {
    sendWebhook(
      merchant.webhookUrl,
      merchant.webhookSecret,
      { event: "payment.confirmed", txId, txHash, coin: tx.coin, amount: tx.amount, fromAddress: tx.fromAddress, toAddress: tx.toAddress, verified: transferVerified },
      { merchantId: merchant.id, txId, txHash }
    ).catch((error) => logSeraOperationFailure("payment-notification", error));
  }
}

function scheduleTransactionVerification(txId: string, txHash: `0x${string}`) {
  if (transactionVerificationInFlight.has(txId)) return;
  transactionVerificationInFlight.add(txId);
  void verifyTransactionAsync(txId, txHash)
    .catch((error) => logSeraOperationFailure("verify", error))
    .finally(() => transactionVerificationInFlight.delete(txId));
}

async function sendWebhook(
  url: string,
  secret: string | null | undefined,
  payload: object,
  logCtx?: { merchantId: string; txId: string; txHash?: string | null }
) {
  // SSRF protection: block private IPs
  const urlObj = new URL(url);
  if (!/^https:$/.test(urlObj.protocol)) return;
  const privatePatterns = [/^localhost$/i, /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./];
  if (privatePatterns.some(p => p.test(urlObj.hostname))) return;
  const body = JSON.stringify(payload);
  const sig = secret ? "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex") : undefined;
  const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": "SeraPay-Webhook/1.0" };
  if (sig) headers["X-SeraPay-Signature"] = sig;
  let statusCode: number | undefined;
  let responseBody: string | undefined;
  let errorMsg: string | undefined;
  let success = false;
  try {
    const resp = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(10000) });
    statusCode = resp.status;
    success = resp.ok;
    try { responseBody = (await resp.text()).slice(0, 2000); } catch {}
  } catch (e: any) {
    errorMsg = e?.message || String(e);
    console.error("[webhook] delivery failed");
  }
  // Persist delivery log
  if (logCtx) {
    try {
      await createWebhookLog({
        id: uuidv4(),
        merchantId: logCtx.merchantId,
        txId: logCtx.txId,
        txHash: logCtx.txHash || null,
        url,
        statusCode: statusCode ?? null,
        success: success ? 1 : 0,
        responseBody: responseBody ?? null,
        error: errorMsg ?? null,
      });
    } catch { console.error("[webhook-log] persistence failed"); }
  }
}

/** GET /api/payer/history?address=0x... — public payer payment history */
paymentRouter.get("/payer/history", async (req, res) => {
  try {
    const address = (req.query.address as string)?.toLowerCase();
    if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      res.status(400).json({ error: "Invalid address" }); return;
    }
    const txs = await getTransactionsByFromAddress(address, 50);
    // Fetch merchant names for each unique merchantId
    const merchantIds = [...new Set(txs.map(t => t.merchantId))];
    const merchantNames: Record<string, string> = {};
    await Promise.all(merchantIds.map(async (id) => {
      const m = await getMerchantById(id);
      if (m) merchantNames[id] = m.name;
    }));
    res.json(txs.map(t => ({
      id: t.id,
      txHash: t.txHash,
      coin: t.coin,
      amount: t.amount,
      amountUsd: t.amountUsd,
      status: t.status,
      merchantId: t.merchantId,
      merchantName: merchantNames[t.merchantId] || "Unknown Merchant",
      toAddress: t.toAddress,
      memo: t.memo,
      createdAt: t.createdAt.getTime(),
    })));
  } catch (e) { logSeraOperationFailure("payment-route", e); res.status(500).json({ error: "Internal server error" }); }
});

/** GET /api/healthz */
paymentRouter.get("/healthz", (_req, res) => res.json({ status: "ok", ts: Date.now() }));

// ─── Exchange Rates endpoint (Sera FX API with Sera-derived fallbacks) ───────

const GOLDSKY_URL = ENV.goldskyGraphqlUrl;

// Simple in-memory rate cache: { [pair]: { rate, ts } }
const rateCache = new Map<string, { rate: number; ts: number }>();
const CACHE_TTL_MS = 60_000; // 1 minute

// Strict allowlist of known stablecoin symbols (alphanumeric only, 2–8 chars)
const USD_BRIDGE: Record<string, string> = { USDC: "USDT", EURC: "EURT" };

type SeraFxRateResponse = {
  pair: string;
  rate: string;
  as_of: number;
  rate_24h_ago: string | null;
  as_of_24h_ago: number | null;
  change_pct: string | null;
};

async function fetchSeraRate(from: string, to: string): Promise<number> {
  if (from === to) return 1;

  // Bridge coins that have no direct Sera markets to their equivalents
  const resolvedFrom = USD_BRIDGE[from] ?? from;
  const resolvedTo   = USD_BRIDGE[to]   ?? to;
  if (resolvedFrom === resolvedTo) return 1; // e.g. USDC→USDT

  const cacheKey = `${from}:${to}`;
  const cached = rateCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.rate;
  if (!GOLDSKY_URL) throw new Error("GOLDSKY_GRAPHQL_URL is not configured");

  // Use resolved symbols for the actual Goldsky query
  const effectiveFrom = resolvedFrom;
  const effectiveTo   = resolvedTo;

  // Use GraphQL variables — symbols are passed as JSON values, not interpolated into query string
  const query = `
    query GetRate($from: String!, $to: String!) {
      direct: markets(where: { quoteToken_: { symbol: $from }, baseToken_: { symbol: $to } }, first: 1) {
        latestPrice
      }
      reverse: markets(where: { quoteToken_: { symbol: $to }, baseToken_: { symbol: $from } }, first: 1) {
        latestPrice
      }
    }
  `;

  const res = await fetch(GOLDSKY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: { from: effectiveFrom, to: effectiveTo } }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Goldsky fetch failed: ${res.status}`);
  const json = await res.json() as { data: { direct: { latestPrice: string }[]; reverse: { latestPrice: string }[] }; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(`Goldsky error: ${json.errors[0].message}`);

  let rate: number;
  if (json.data.direct.length > 0 && json.data.direct[0].latestPrice !== "0") {
    const priceFromPerTo = Number(BigInt(json.data.direct[0].latestPrice)) / 1e18;
    rate = 1 / priceFromPerTo;
  } else if (json.data.reverse.length > 0 && json.data.reverse[0].latestPrice !== "0") {
    rate = Number(BigInt(json.data.reverse[0].latestPrice)) / 1e18;
  } else {
    // No direct market — try two-hop bridge via USDT
    // e.g. THBT→IDRX = (THBT→USDT) × (USDT→IDRX)
    if (effectiveFrom !== "USDT" && effectiveTo !== "USDT") {
      const [rateFromUsd, rateToUsd] = await Promise.all([
        fetchSeraRate(from, "USDT"),
        fetchSeraRate("USDT", to),
      ]);
      rate = rateFromUsd * rateToUsd;
    } else {
      throw new Error(`No Sera market found for ${from}/${to}`);
    }
  }

  rateCache.set(cacheKey, { rate, ts: Date.now() });
  rateCache.set(`${to}:${from}`, { rate: 1 / rate, ts: Date.now() });
  return rate;
}

async function fetchSeraRestFxRate(from: string, to: string, chainId?: number): Promise<{ rate: number; source: string }> {
  if (chainId !== undefined && chainId !== SERA_MAINNET_CHAIN_ID && chainId !== SERA_TESTNET_CHAIN_ID) {
    throw new Error(`Sera payments are not supported on chain ${chainId}`);
  }
  const cacheScope = chainId === SERA_TESTNET_CHAIN_ID ? "test" : "live";
  const cacheKey = `sera-quote:${cacheScope}:${from}:${to}`;
  const cached = rateCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return { rate: cached.rate, source: "cache" };
  }

  // Use the active Sera registry for both token support and its represented
  // fiat currency. A local token-to-currency table goes stale as assets change.
  const resolvedChainId = chainId === SERA_TESTNET_CHAIN_ID ? SERA_TESTNET_CHAIN_ID : SERA_MAINNET_CHAIN_ID;
  const baseUrl = getSeraApiBaseUrlForChain(resolvedChainId);
  const [fromToken, toToken, seraNowSec] = await Promise.all([
    resolveSeraTokenForChain(resolvedChainId, from),
    resolveSeraTokenForChain(resolvedChainId, to),
    getSeraServerTimestamp(baseUrl),
  ]);
  if (fromToken.address.toLowerCase() === toToken.address.toLowerCase()) {
    return { rate: 1, source: "identity" };
  }

  const fromCurrency = String(fromToken.currency || from).trim().toUpperCase();
  const toCurrency = String(toToken.currency || to).trim().toUpperCase();
  if (fromCurrency === toCurrency) {
    rateCache.set(cacheKey, { rate: 1, ts: Date.now() });
    return { rate: 1, source: "sera-fx-same-currency" };
  }

  let lastRateError: unknown = null;
  if (/^[A-Z]{3}$/.test(fromCurrency) && /^[A-Z]{3}$/.test(toCurrency)) {
    try {
      const fx = await callSeraApi<SeraFxRateResponse>({
        baseUrl,
        path: "/fx/rate",
        method: "GET",
        query: { base: fromCurrency, quote: toCurrency },
        authMode: "none",
      });
      const rate = Number(fx.rate);
      if (!Number.isFinite(rate) || rate <= 0) {
        throw new Error(`Invalid Sera FX rate for ${fromCurrency}/${toCurrency}`);
      }
      rateCache.set(cacheKey, { rate, ts: Date.now() });
      return { rate, source: "sera-fx-rate" };
    } catch (error) {
      lastRateError = error;
    }
  }

  try {
    const rate = await fetchSeraRate(from, to);
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error(`Invalid Sera market rate for ${from}/${to}`);
    }
    rateCache.set(cacheKey, { rate, ts: Date.now() });
    return { rate, source: "sera-goldsky" };
  } catch (error) {
    lastRateError = error;
  }

  // Final fallback: Sera swap quotes can still provide a live price if the
  // reference FX feed is temporarily unavailable. Direct QR payments do not
  // require swap liquidity, so try both quote orientations before giving up.
  const buildReferenceInputs = (inputToken: SeraToken) => {
    const scale = 10n ** BigInt(inputToken.decimals);
    const minimumRaw = BigInt(String(inputToken.min_trade_amount_raw || "0"));
    return Array.from(new Set([
      minimumRaw > 10n * scale ? minimumRaw : 10n * scale,
      minimumRaw > 100n * scale ? minimumRaw : 100n * scale,
      minimumRaw > 1000n * scale ? minimumRaw : 1000n * scale,
    ].map((value) => value.toString()))).map((value) => BigInt(value));
  };

  const quoteRate = async (
    inputToken: SeraToken,
    outputToken: SeraToken,
    rateFromQuote: (inputAmount: number, outputAmount: number) => number,
  ) => {
    let lastQuoteError: unknown = null;
    for (const referenceInputRaw of buildReferenceInputs(inputToken)) {
      const quoteRequest = {
        from_token: inputToken.address,
        to_token: outputToken.address,
        from_amount: referenceInputRaw.toString(),
        owner_address: "0x0000000000000000000000000000000000000001",
        recipient: "0x0000000000000000000000000000000000000001",
        expiration: seraNowSec + 180,
        gas_mode: "pay_more",
      };
      try {
        const rawQuote = await callSeraApi<unknown>({
          baseUrl,
          path: "/swap/quote",
          method: "POST",
          body: quoteRequest,
          authMode: "none",
        });
        const quote = unwrapSeraQuote(rawQuote);
        const routeParams = getRouteParams(quote);
        const outputRaw = BigInt(String(routeParams.minOutputAmount));
        if (outputRaw <= 0n) throw new Error(`Sera returned no executable output for ${inputToken.symbol}/${outputToken.symbol}`);
        const referenceInput = Number(fromRawTokenAmount(referenceInputRaw, inputToken.decimals));
        const quotedOutput = Number(fromRawTokenAmount(outputRaw, outputToken.decimals));
        const rate = rateFromQuote(referenceInput, quotedOutput);
        if (!Number.isFinite(rate) || rate <= 0) {
          throw new Error(`Invalid Sera swap quote rate for ${from}/${to}`);
        }
        return rate;
      } catch (error) {
        lastQuoteError = error;
        const canTryAnotherSize = error instanceof SeraApiError
          && (error.status === 503 || error.errorCode === "no_liquidity" || error.errorCode === "NO_LIQUIDITY");
        if (!canTryAnotherSize) throw error;
      }
    }
    throw lastQuoteError instanceof Error ? lastQuoteError : new Error(`Sera returned no executable quote for ${from}/${to}`);
  };

  let lastQuoteError: unknown = null;
  try {
    const rate = await quoteRate(
      toToken,
      fromToken,
      (inputAmountInTo, outputAmountInFrom) => inputAmountInTo / outputAmountInFrom,
    );
    rateCache.set(cacheKey, { rate, ts: Date.now() });
    return { rate, source: "sera-swap-quote" };
  } catch (error) {
    lastQuoteError = error;
  }

  try {
    const rate = await quoteRate(
      fromToken,
      toToken,
      (_inputAmountInFrom, outputAmountInTo) => outputAmountInTo / _inputAmountInFrom,
    );
    rateCache.set(cacheKey, { rate, ts: Date.now() });
    return { rate, source: "sera-swap-quote-reverse" };
  } catch (error) {
    lastQuoteError = error;
  }

  if (lastQuoteError instanceof SeraApiError && (lastQuoteError.errorCode === "no_liquidity" || lastQuoteError.errorCode === "NO_LIQUIDITY")) {
    throw lastRateError instanceof Error
      ? new Error(`No Sera FX rate available for ${from}/${to}: ${lastRateError.message}`)
      : new Error(`No Sera FX rate available for ${from}/${to}`);
  }
  throw lastQuoteError instanceof Error ? lastQuoteError : new Error(`Sera returned no usable rate for ${from}/${to}`);
}

/**
 * GET /api/rates?from=XSGD&to=USDC
 * Returns { rate: number, from: string, to: string, source: "sera" }
 * rate = how many units of `to` coin equal 1 unit of `from` coin
 */
paymentRouter.get("/rates", async (req, res) => {
  try {
    const from = (req.query.from as string)?.toUpperCase();
    const to = (req.query.to as string)?.toUpperCase();
    if (!from || !to) { res.status(400).json({ error: "Missing from/to query params" }); return; }
    if (!COIN_SYMBOL_RE.test(from)) { res.status(400).json({ error: `Invalid symbol: ${from}` }); return; }
    if (!COIN_SYMBOL_RE.test(to)) { res.status(400).json({ error: `Invalid symbol: ${to}` }); return; }

    const requestedChainId = Number(req.query.chainId ?? req.query.chain_id ?? 1);
    const chainId = Number.isInteger(requestedChainId) && requestedChainId > 0 ? requestedChainId : 1;
    const { rate, source } = await fetchSeraRestFxRate(from, to, chainId);
    /*
    // Apply SeraPay's 0.5% silent spread — customer pays slightly more than the raw Sera rate.
    // The merchant receives exactly what they requested; SeraPay keeps the difference.
    const SERA_MARKUP = 1.005;
    const rate = rawRate * SERA_MARKUP;
    */
    // Cache exchange rates for 10 seconds — matches server-side TTL
    res.setHeader("Cache-Control", "public, max-age=10, stale-while-revalidate=30");
    res.json({ from, to, rate, source });
  } catch (e: any) {
    if (typeof e?.message === "string" && e.message.startsWith("Unsupported Sera token:")) {
      res.status(400).json({ error: e.message });
      return;
    }
    if (typeof e?.message === "string" && e.message.startsWith("Sera payments are not supported on chain")) {
      res.status(400).json({ error: e.message });
      return;
    }
    if (e instanceof SeraApiError && (e.errorCode === "no_liquidity" || e.errorCode === "NO_LIQUIDITY")) {
      res.status(409).json({
        error: "Currently there's no liquidity on this exchange in Sera.cx. Please try another option.",
        errorCode: "no_liquidity",
      });
      return;
    }
    logSeraOperationFailure("rates", e);
    res.status(502).json({ error: "Failed to fetch exchange rate from Sera" });
  }
});
