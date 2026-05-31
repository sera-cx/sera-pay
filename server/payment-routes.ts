/**
 * SeraPay Payment API Routes
 * Registered under /api/ in server/_core/index.ts
 */
import { Router, Request, Response } from "express";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import { createPublicClient, http, webSocket, parseAbi, decodeEventLog, keccak256, toHex, encodeAbiParameters, parseAbiParameters, verifyMessage } from "viem";
import { sepolia, mainnet, polygon, base, arbitrum } from "viem/chains";
import {
  getMerchantByWallet,
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
  createWebhookLog,
  getMerchantWebhookLogs,
  getTransactionsByFromAddress,
  getSubWalletByAddress,
  updatePaymentIntent,
  updateMenuOrderPayment,
} from "./db";
import { screenWalletAddress } from "./compliance";
import { ENV } from "./_core/env";
import { PrivyAuthError, assertPrivyWalletOwnership, getPrivyWalletSummary, sendPrivyAuthError, verifyPrivyRequest, type PrivyIdentity, type PrivyWalletOwnership } from "./_core/privy";
import { isR2StorageConfigured, storagePut, storageRead } from "./storage";
import {
  DEFAULT_SERA_API_BASE_URL,
  DEFAULT_SERA_API_TESTNET_BASE_URL,
  callSeraApi,
  getSeraTokens,
  normalizeSeraBaseUrl,
  type SeraToken,
} from "./sera-api";
import type { Transaction } from "../drizzle/schema";

export const paymentRouter = Router();

const PUBLIC_STORAGE_PREFIXES = ["merchant-logos/", "menu-items/", "generated/"];
const PENDING_TRANSACTION_CANCEL_AFTER_MS = 5 * 60 * 1000;
const SERA_TESTNET_CHAIN_ID = sepolia.id;

function getSeraApiBaseUrlForChain(chainId?: number | null): string {
  const baseUrl = chainId === SERA_TESTNET_CHAIN_ID
    ? ENV.seraApiTestnetBaseUrl || DEFAULT_SERA_API_TESTNET_BASE_URL
    : ENV.seraApiBaseUrl || DEFAULT_SERA_API_BASE_URL;
  return normalizeSeraBaseUrl(baseUrl);
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
    console.error("[Storage] Failed to read object", error);
    res.status(404).json({ error: "Object not found" });
  }
});

// ─── Constants ────────────────────────────────────────────────────────────────

const VALID_COINS = new Set([
  // USD
  "USDC", "USDT",
  // EUR
  "EURC", "EURT", "TNEUR", "VEUR",
  // GBP
  "GBPA", "TGBP", "VGBP",
  // SGD
  "XSGD", "TNSGD",
  // JPY
  "JPYC", "GYEN",
  // AUD
  "AUDD", "AUDF",
  // CAD
  "CADC", "QCAD",
  // BRL
  "BRLA", "BRZ",
  // KRW
  "KRW1", "KRWO", "KRWIN",
  // IDR
  "IDRX", "IDRT", "XIDR",
  // CHF
  "CCHF", "VCHF",
  // MXN
  "MXNB", "MXNT",
  // NZD
  "NZDD", "NZDS",
  // THB
  "THBK", "THBT",
  // ZAR
  "ZARP", "ZARU",
  // Other
  "ARC", "MYRT", "TRYB", "PHPC", "HKDR", "CNHT", "ARZ", "CNGN", "A7A5",
]);

type SeraRouteParams = {
  taker: string;
  inputToken: string;
  outputToken: string;
  maxInputAmount: string;
  minOutputAmount: string;
  recipient: string;
  initialDepositAmount: string;
  uuid: string | number;
  deadline: string | number;
};

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
  eip712_domain?: Record<string, unknown>;
};

const SERA_INTENT_TYPES = {
  Intent: [
    { name: "taker", type: "address" },
    { name: "inputToken", type: "address" },
    { name: "outputToken", type: "address" },
    { name: "maxInputAmount", type: "uint256" },
    { name: "minOutputAmount", type: "uint256" },
    { name: "recipient", type: "address" },
    { name: "initialDepositAmount", type: "uint256" },
    { name: "uuid", type: "uint256" },
    { name: "deadline", type: "uint48" },
  ],
} as const;

// In-memory SSE clients: txId → Set<Response>
const sseClients = new Map<string, Set<Response>>();

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
  const apiKey = req.headers["x-api-key"] as string;
  if (!apiKey) { res.status(401).json({ error: "Missing X-Api-Key header" }); return; }
  const merchant = await getMerchantByApiKey(apiKey);
  if (!merchant) { res.status(401).json({ error: "Invalid API key" }); return; }
  (req as any).merchant = merchant;
  next();
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
    console.error(e); res.status(500).json({ error: "Internal server error" });
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
    const merchant = await getMerchantByWallet(address);
    if (!merchant) { res.status(404).json({ error: "Merchant not found" }); return; }
    // Cache public merchant profile for 60 seconds at CDN/proxy level
    res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=120");
    res.json({
      name: merchant.name,
      logoData: merchant.logoData,
      receiveCoin: merchant.receiveCoin,
      storeAddress: merchant.storeAddress,
      qrFgColor: merchant.qrFgColor,
      qrBgColor: merchant.qrBgColor,
      qrStyle: merchant.qrStyle,
    });
  } catch (e) { console.error(e); res.status(500).json({ error: "Internal server error" }); }
});

/** PUT /api/merchant/settings — update merchant profile */
paymentRouter.put("/merchant/settings", requireApiKey as any, async (req: any, res) => {
  try {
    const merchant = req.merchant;
    const { name, receiveCoin, logoData, webhookUrl, webhookSecret, storeAddress, qrFgColor, qrBgColor, qrStyle } = req.body;
    const updates: Record<string, any> = {};
    if (name !== undefined) {
      if (typeof name !== "string" || name.trim().length < 1 || name.length > 120) { res.status(400).json({ error: "Invalid name" }); return; }
      updates.name = name.trim();
    }
    if (receiveCoin !== undefined) {
      if (!VALID_COINS.has(receiveCoin)) { res.status(400).json({ error: "Invalid receiveCoin" }); return; }
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
    await updateMerchant(merchant.id, updates);
    if (typeof updates.name === "string") await updateUserNameByWallet(merchant.walletAddress, updates.name);
    const updated = await getMerchantById(merchant.id);
    res.json(updated || { success: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "Internal server error" }); }
});

/** GET /api/merchant/me — get merchant profile */
paymentRouter.get("/merchant/me", requireApiKey as any, async (req: any, res) => {
  const m = req.merchant;
  res.json({ id: m.id, walletAddress: m.walletAddress, name: m.name, receiveCoin: m.receiveCoin, logoData: m.logoData, webhookUrl: m.webhookUrl, storeAddress: m.storeAddress, qrFgColor: m.qrFgColor, qrBgColor: m.qrBgColor, qrStyle: (m as any).qrStyle, createdAt: m.createdAt, updatedAt: m.updatedAt });
});

/** GET /api/merchant/profile — alias for /merchant/me (used by dashboard) */
paymentRouter.get("/merchant/profile", requireApiKey as any, async (req: any, res) => {
  const m = req.merchant;
  res.json({ id: m.id, walletAddress: m.walletAddress, name: m.name, receiveCoin: m.receiveCoin, logoData: m.logoData, webhookUrl: m.webhookUrl, storeAddress: m.storeAddress, qrFgColor: m.qrFgColor, qrBgColor: m.qrBgColor, qrStyle: (m as any).qrStyle, createdAt: m.createdAt, updatedAt: m.updatedAt });
});

/** PUT /api/merchant/profile — update profile (used by dashboard Settings page) */
paymentRouter.put("/merchant/profile", requireApiKey as any, async (req: any, res) => {
  try {
    const merchant = req.merchant;
    const { name, receiveCoin, logoData, webhookUrl, storeAddress, qrFgColor, qrBgColor, qrStyle } = req.body;
    const updates: Record<string, any> = {};
    if (name !== undefined) {
      if (typeof name !== "string" || name.trim().length < 1 || name.length > 120) { res.status(400).json({ error: "Invalid name" }); return; }
      updates.name = name.trim();
    }
    if (receiveCoin !== undefined) {
      if (receiveCoin !== null && (typeof receiveCoin !== "string" || !VALID_COINS.has(receiveCoin))) {
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
    await updateMerchant(merchant.id, updates);
    if (typeof updates.name === "string") await updateUserNameByWallet(merchant.walletAddress, updates.name);
    const updated = await getMerchantById(merchant.id);
    res.json(updated);
  } catch (e) { console.error(e); res.status(500).json({ error: "Internal server error" }); }
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
  } catch (e) { console.error(e); res.status(500).json({ error: "Internal server error" }); }
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
  } catch (e) { console.error(e); res.status(500).json({ error: "Internal server error" }); }
});

/** POST /api/merchant/webhook/secret/regenerate — rotate HMAC signing secret */
paymentRouter.post("/merchant/webhook/secret/regenerate", requireApiKey as any, async (req: any, res) => {
  try {
    const { randomBytes } = await import("crypto");
    const newSecret = "whsec_" + randomBytes(24).toString("hex"); // 48-char hex prefixed
    await updateMerchant(req.merchant.id, { webhookSecret: newSecret });
    res.json({ success: true, webhookSecret: newSecret });
  } catch (e) { console.error(e); res.status(500).json({ error: "Internal server error" }); }
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
  } catch (e) { console.error(e); res.status(500).json({ error: "Internal server error" }); }
});

/** GET /api/merchant/stats — aggregate stats for dashboard */
paymentRouter.get("/merchant/stats", requireApiKey as any, async (req: any, res) => {
  try {
    let txs = await getMerchantTransactions(req.merchant.id, 1000);
    const canceled = await cancelStaleMerchantTransactions(req.merchant.id, txs);
    if (canceled > 0) txs = await getMerchantTransactions(req.merchant.id, 1000);
    const totalCount = txs.length;
    const confirmedCount = txs.filter(t => t.status === "confirmed").length;
    const pendingCount = txs.filter(t => t.status === "pending" || t.status === "confirming").length;
    const unverifiedCount = txs.filter(t => t.verified === 0 && t.status !== "failed" && t.status !== "canceled").length;
    const totalVolume = txs
      .filter(t => t.status === "confirmed")
      .reduce((sum, t) => sum + parseFloat(t.amount as any || "0"), 0)
      .toFixed(2);
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
      if (dailyMap.has(day)) dailyMap.set(day, (dailyMap.get(day) || 0) + parseFloat(t.amount as any || "0"));
    }
    const dailyVolume = Array.from(dailyMap.entries()).map(([date, volume]) => ({ date, volume: volume.toFixed(2) }));
    res.json({ totalCount, confirmedCount, pendingCount, unverifiedCount, totalVolume, dailyVolume });
  } catch (e) { console.error(e); res.status(500).json({ error: "Internal server error" }); }
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
  } catch (e) { console.error(e); res.status(500).json({ error: "Internal server error" }); }
});

/** GET /api/merchant/transactions — list transactions */
paymentRouter.get("/merchant/transactions", requireApiKey as any, async (req: any, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 1000);
    const offset = parseInt(req.query.offset as string) || 0;
    let txs = await getMerchantTransactions(req.merchant.id, limit, offset);
    const canceled = await cancelStaleMerchantTransactions(req.merchant.id, txs);
    if (canceled > 0) txs = await getMerchantTransactions(req.merchant.id, limit, offset);
    res.json({ transactions: txs, pagination: { limit, offset } });
  } catch (e) { console.error(e); res.status(500).json({ error: "Internal server error" }); }
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
  } catch (e) { console.error(e); res.status(500).json({ error: "Internal server error" }); }
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
  } catch (e) { console.error(e); res.status(500).json({ error: "Internal server error" }); }
});

// ─── Payment endpoints ────────────────────────────────────────────────────────

function toRawTokenAmount(amount: string, decimals: number): string {
  const normalized = amount.replace(/,/g, "").trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) throw new Error("Invalid amount");
  const [whole, fraction = ""] = normalized.split(".");
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
  if (!/^\d+(\.\d+)?$/.test(value) || Number(value) <= 0) {
    throw new Error("Invalid amount");
  }
  return value;
}

async function resolvePaymentMerchant(merchantAddress: string) {
  const normalizedMerchantAddress = merchantAddress.toLowerCase();
  let merchant = await getMerchantByWallet(normalizedMerchantAddress);
  const subWallet = merchant ? undefined : await getSubWalletByAddress(normalizedMerchantAddress);
  if (!merchant && subWallet) {
    merchant = await getMerchantById(subWallet.merchantId);
  }
  if (!merchant) throw new Error("Merchant not found");
  const toAddress = subWallet?.address || merchant.storeAddress || merchant.walletAddress;
  return { merchant, subWallet, toAddress: toAddress.toLowerCase() };
}

async function resolveSeraTokenBySymbol(baseUrl: string, symbol: string): Promise<SeraToken> {
  const registry = await getSeraTokens(baseUrl);
  const token = registry.tokens.find((item) => item.symbol.toUpperCase() === symbol.toUpperCase());
  if (!token) throw new Error(`Unsupported Sera token: ${symbol}`);
  return token;
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

async function cancelStaleMerchantTransactions(merchantId: string, transactions?: Transaction[]) {
  const txs = transactions ?? await getMerchantTransactions(merchantId, 1000);
  const cutoff = Date.now() - PENDING_TRANSACTION_CANCEL_AFTER_MS;
  let canceled = 0;
  for (const tx of txs) {
    if ((tx.status === "pending" || tx.status === "confirming") && new Date(tx.createdAt).getTime() <= cutoff) {
      if (await cancelTransactionRecord(tx, "Auto-canceled after 5 minutes without payment confirmation.", "transaction_auto_canceled")) {
        canceled += 1;
      }
    }
  }
  return canceled;
}

/** POST /api/payment/create — create a pending payment request */
paymentRouter.post("/payment/create", async (req, res) => {
  try {
    const { merchantAddress, coin, amount, chainId } = req.body;
    const orderId = typeof req.body.orderId === "string" ? req.body.orderId : null;
    if (!merchantAddress || !/^0x[0-9a-fA-F]{40}$/.test(merchantAddress)) { res.status(400).json({ error: "Invalid merchantAddress" }); return; }
    if (!coin || !VALID_COINS.has(coin)) { res.status(400).json({ error: "Invalid coin" }); return; }
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0 || parsedAmount > 1_000_000) { res.status(400).json({ error: "Invalid amount" }); return; }
    const normalizedMerchantAddress = merchantAddress.toLowerCase();
    const merchantAddressCompliance = await screenWalletAddress(normalizedMerchantAddress, "recipient_wallet");
    if (merchantAddressCompliance.blocked) {
      res.status(403).json({ error: "Merchant address failed compliance screening", compliance: merchantAddressCompliance });
      return;
    }
    let merchant = await getMerchantByWallet(normalizedMerchantAddress);
    const subWallet = merchant ? undefined : await getSubWalletByAddress(normalizedMerchantAddress);
    if (!merchant && subWallet) {
      merchant = await getMerchantById(subWallet.merchantId);
    }
    if (!merchant) { res.status(404).json({ error: "Merchant not found" }); return; }
    const id = uuidv4();
    const toAddress = subWallet?.address || merchant.storeAddress || merchant.walletAddress;
    const toAddressCompliance = await screenWalletAddress(toAddress, "recipient_wallet", merchant.id);
    if (toAddressCompliance.blocked) {
      res.status(403).json({ error: "Recipient address failed compliance screening", compliance: toAddressCompliance });
      return;
    }
    const resolvedChainId = chainId || 11155111;
    await createTransaction({
      id,
      merchantId: merchant.id,
      toAddress,
      coin,
      amount: parsedAmount.toString(),
      chainId: resolvedChainId,
      status: "pending",
      verified: 0,
      notes: orderId ? JSON.stringify({ orderId, source: "public_menu" }) : null,
    });
    if (orderId) {
      await updateMenuOrderPayment(orderId, merchant.id, { paymentId: id, transactionId: id, status: "payment_pending" }).catch(() => undefined);
    }
    res.json({ txId: id, toAddress, coin, amount: parsedAmount.toString(), chainId: resolvedChainId });
  } catch (e) { console.error(e); res.status(500).json({ error: "Internal server error" }); }
});

/** POST /api/payment/swap/quote - Sera quote for customer coin -> merchant receive coin */
paymentRouter.post("/payment/swap/quote", async (req, res) => {
  try {
    const merchantAddress = String(req.body.merchantAddress ?? "").trim();
    const payerAddress = String(req.body.payerAddress ?? "").trim().toLowerCase();
    const payCoin = String(req.body.payCoin ?? "").trim().toUpperCase();
    const receiveCoin = String(req.body.receiveCoin ?? "").trim().toUpperCase();
    const payAmount = normalizeDecimalAmount(req.body.payAmount);
    const requestedReceiveAmount = req.body.receiveAmount ? normalizeDecimalAmount(req.body.receiveAmount) : null;
    const requestedChainId = Number(req.body.chainId ?? 1);
    const chainId = Number.isInteger(requestedChainId) && requestedChainId > 0 ? requestedChainId : 1;
    const paymentIntentId = typeof req.body.paymentIntentId === "string" ? req.body.paymentIntentId : null;
    const orderId = typeof req.body.orderId === "string" ? req.body.orderId : null;

    if (!/^0x[0-9a-fA-F]{40}$/.test(merchantAddress)) { res.status(400).json({ error: "Invalid merchantAddress" }); return; }
    if (!/^0x[0-9a-fA-F]{40}$/.test(payerAddress)) { res.status(400).json({ error: "Invalid payerAddress" }); return; }
    if (!VALID_COINS.has(payCoin) || !VALID_COINS.has(receiveCoin)) { res.status(400).json({ error: "Invalid coin" }); return; }
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
    const [fromToken, toToken, config] = await Promise.all([
      resolveSeraTokenBySymbol(baseUrl, payCoin),
      resolveSeraTokenBySymbol(baseUrl, receiveCoin),
      callSeraApi<SeraConfigResponse>({ baseUrl, path: "/config", authMode: "none" }),
    ]);
    if (!config.eip712_domain) throw new Error("Sera /config did not return eip712_domain");

    const expiration = Math.floor(Date.now() / 1000) + 900;
    const quoteRequest = {
      from_token: fromToken.address,
      to_token: toToken.address,
      from_amount: toRawTokenAmount(payAmount, fromToken.decimals),
      owner_address: payerAddress,
      recipient: toAddress,
      expiration,
      gas_mode: "receive_less",
    };
    const rawQuote = await callSeraApi<unknown>({
      baseUrl,
      path: "/swap/quote",
      method: "POST",
      body: quoteRequest,
      authMode: "none",
      merchantId: merchant.id,
    });
    const quote = unwrapSeraQuote(rawQuote);
    const routeParams = getRouteParams(quote);
    const quoteUuid = quote.uuid ?? routeParams.uuid;
    const expectedReceiveAmount = requestedReceiveAmount ?? fromRawTokenAmount(routeParams.minOutputAmount, toToken.decimals);
    const txId = uuidv4();

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
      payAmount,
      notes: JSON.stringify({
        type: "sera_swap_quote",
        quoteUuid,
        paymentIntentId,
        orderId,
        payToken: fromToken.address,
        receiveToken: toToken.address,
        chainId,
        expiresAt: quote.expires_at ?? null,
      }),
    });
    if (orderId) {
      await updateMenuOrderPayment(orderId, merchant.id, { paymentId: txId, paymentIntentId, transactionId: txId, status: "payment_pending" }).catch(() => undefined);
    }

    res.json({
      txId,
      chainId: config.chain_id ?? chainId,
      toAddress,
      payCoin,
      receiveCoin,
      payAmount,
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
      request: {
        ...quoteRequest,
        from_symbol: payCoin,
        to_symbol: receiveCoin,
      },
    });
  } catch (e: any) {
    console.error("[payment/swap/quote]", e?.message || e);
    res.status(502).json({ error: e?.message || "Unable to create Sera swap quote" });
  }
});

/** POST /api/payment/swap/submit - submit signed Sera swap intent */
paymentRouter.post("/payment/swap/submit", async (req, res) => {
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
    const result = await callSeraApi<Record<string, unknown>>({
      baseUrl,
      path: "/swap",
      method: "POST",
      body,
      authMode: "eip712",
      merchantId: tx.merchantId,
    });

    const success = result.success !== false;
    const txHash = extractTransactionHash(result);
    const notes = `${tx.notes ? `${tx.notes}\n` : ""}Sera swap submit response: ${JSON.stringify(result).slice(0, 1500)}`;

    if (!success) {
      await updateTransaction(txId, { status: "failed", notes });
      const orderId = orderIdFromTransactionNotes(tx.notes);
      if (orderId) await updateMenuOrderPayment(orderId, tx.merchantId, { status: "failed", paymentId: txId, transactionId: txId }).catch(() => undefined);
      notifySseClients(txId, { status: "failed" });
      res.status(502).json({ success: false, status: "failed", sera: result });
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
      ).catch(console.error);
    }

    res.json({ success: true, status: "confirmed", txHash, sera: result });
  } catch (e: any) {
    console.error("[payment/swap/submit]", e?.message || e);
    res.status(502).json({ error: e?.message || "Unable to submit Sera swap" });
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
    // Fire-and-forget verification
    verifyTransactionAsync(txId, txHash as `0x${string}`).catch(console.error);
    res.json({ success: true, status: "confirming" });
  } catch (e) { console.error(e); res.status(500).json({ error: "Internal server error" }); }
});

/** GET /api/payment/status/:txId — poll payment status */
paymentRouter.get("/payment/status/:txId", async (req, res) => {
  try {
    let tx = await getTransactionById(req.params.txId);
    if (!tx) { res.status(404).json({ error: "Not found" }); return; }
    const canceled = await cancelStaleMerchantTransactions(tx.merchantId, [tx]);
    if (canceled > 0) tx = await getTransactionById(req.params.txId);
    if (!tx) { res.status(404).json({ error: "Not found" }); return; }
    res.json({ txId: tx.id, status: tx.status, verified: tx.verified === 1, txHash: tx.txHash, coin: tx.coin, amount: tx.amount, toAddress: tx.toAddress, fromAddress: tx.fromAddress, createdAt: tx.createdAt, chainId: tx.chainId ?? 11155111 });
  } catch (e) { console.error(e); res.status(500).json({ error: "Internal server error" }); }
});

/** GET /api/payment/events/:txId — SSE stream for real-time status */
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

// Sepolia USDC contract address (Circle's official)
const COIN_CONTRACTS: Record<string, Record<number, `0x${string}`>> = {
  // USD
  USDC: {
    1: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    137: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    42161: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    11155111: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  },
  USDT: {
    1: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    137: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
    42161: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
    11155111: "0x1920bf0643ae49B4fB334586dAd6Bed29fF30F88",
  },
  // EUR
  EURC: { 11155111: "0xd3BdB2CE9cD98566EFc2e2977448c40578371779" },
  EURT: { 11155111: "0x47230df72231f594C5c598635dD92849C11532D0" },
  TNEUR: { 11155111: "0xe4AF44eF7ce074F8FA94131035108201A5ac2F3a" },
  VEUR: { 11155111: "0x4AbcbC7C307baCF5AdbFc57E822658F5D917Ca1E" },
  // GBP
  GBPA: { 11155111: "0xD685BC15a53bbb624B98Ebf97B357DB8e0DA4A23" },
  TGBP: { 11155111: "0xA26f1088f41714B696d0e7b117FA9cbd810bbE8B" },
  VGBP: { 11155111: "0x01d8b6E34a57573Ff48d49fA047b45054f939eDa" },
  // SGD
  XSGD: { 11155111: "0x1Fe69B1171d8aA5e6d432F14A9E4129ED96E40C0" },
  TNSGD: { 11155111: "0x4638F8eB9F2047Ab18d70E12539E0B16fF2998A2" },
  // JPY
  GYEN: { 11155111: "0xA39c3648Cd2b5a183Af33Dcc30af6799A13aD7aE" },
  JPYC: { 11155111: "0x2C9e4Db557af394f1F21d1E1E6754a7CB1eC1D01" },
  // AUD
  AUDD: { 11155111: "0x03A8D551Bf1d708471064aA97FeA004a45Ed8CF3" },
  AUDF: { 11155111: "0x06dCE1A62f5D3188d016e640F3a9dd3bB26f9431" },
  // CAD
  CADC: { 11155111: "0xaE64cEB804292F737C28e0Bd552d929041662970" },
  QCAD: { 11155111: "0x3BDB8BE37Ad586852ad005C5a0885211CD803250" },
  // BRL
  BRLA: { 11155111: "0x6B5256523aCD840aE97AeDE492cB31a5D500Fdf9" },
  BRZ: { 11155111: "0x1B7fA411238bf745138a59Cbd90Fb8480D85c130" },
  // KRW
  KRW1: { 11155111: "0x01943628c3E70A4F39CE905e8fea56E7A8a357F8" },
  KRWO: { 11155111: "0x4C16AF20C7f8a841397273955c6451F4fEB6a576" },
  KRWIN: { 11155111: "0xCE2dDC28068b3929ECF9787ec47284A9e3a62B3a" },
  // IDR
  IDRX: { 11155111: "0x258f1E146b8Bd0dEcf54bAD8f1f01fE69025601c" },
  IDRT: { 11155111: "0x26db12e7cB7Be8Ab22a97B7e4c3d33C0bfE89e82" },
  XIDR: { 11155111: "0xe02bbf861736147e1506d07239d7f2D291FB39fC" },
  // CHF
  CCHF: { 11155111: "0xA6B42B17219C854E4a44F40ed93d15A5FD88676E" },
  VCHF: { 11155111: "0x1e7Fd8256Cff4C61519e9E7E5E9d0496a14b0D5B" },
  // MXN
  MXNB: { 11155111: "0x510139cC0B118711ACCf9ec476b3093dF0BBb1FC" },
  MXNT: { 11155111: "0x6750EEC6a189BCBc4a9A52EE285b525c8D1940f3" },
  // NZD
  NZDD: { 11155111: "0x2cDc20d7eFEe786d28529ecC8a0A491Bee84b207" },
  NZDS: { 11155111: "0xA6DA6F948F6C95D4D6525856208B1A267a37c905" },
  // THB
  THBK: { 11155111: "0x696451A335EB929934a1020Db4ED655f33765802" },
  THBT: { 11155111: "0x5e875193255BfE0557701DceB01831C7bDFa910b" },
  // ZAR
  ZARP: { 11155111: "0x409667Ce4E4674E9fB8272774AAbFfBB7c8956a4" },
  ZARU: { 11155111: "0x721CB3e2B0BA43b0a51f2179b7D260DD98d4BAF1" },
  // Other
  ARC: { 11155111: "0xDbb492152eBd689ceF184C17e6F65AB18DCDe627" },
  MYRT: { 11155111: "0x68077f53a6562D42051C86b09160EA577f3C7476" },
  TRYB: { 11155111: "0x0d2968Dc1b9EC131bEcaB8e28193e81Bcd63040c" },
  PHPC: { 11155111: "0x9aA087afD8C3EadA4f52Dfe61aaC507Bf845BC29" },
  HKDR: { 11155111: "0x40ad01c5ade2a9202D110C621919D0a2b147EB97" },
  CNHT: { 11155111: "0x8f3F6bE3f2545d5d90275f0dA98980264F6a8913" },
  ARZ: { 11155111: "0x3A2498C86Db0e4a2E8766649f368cBD37Fe6D52a" },
  CNGN: { 11155111: "0x82167feCbB10C496F75afcD933DC0E23891E1CF3" },
  A7A5: { 11155111: "0xEf6182c0DB1466b4B24608360bEf8376A6A0578d" },
};

const ALCHEMY_API_KEY = ENV.alchemyApiKey;

// WebSocket client for Sepolia (Alchemy) — used for real-time log subscriptions
const sepoliaWsClient = ALCHEMY_API_KEY
  ? createPublicClient({
      chain: sepolia,
      transport: webSocket(`wss://eth-sepolia.g.alchemy.com/v2/${ALCHEMY_API_KEY}`),
    })
  : null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CHAIN_CLIENTS: Record<number, any> = {
  1:        createPublicClient({ chain: mainnet,  transport: http() }),
  137:      createPublicClient({ chain: polygon,  transport: http() }),
  8453:     createPublicClient({ chain: base,     transport: http() }),
  42161:    createPublicClient({ chain: arbitrum, transport: http() }),
  11155111: createPublicClient({ chain: sepolia,  transport: http() }),
};

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
        console.warn("[ws] block subscription error:", err);
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
  const orderId = orderIdFromTransactionNotes(tx.notes);

  const chainId = tx.chainId ?? 11155111;
  const client = CHAIN_CLIENTS[chainId];
  if (!client) {
    console.error(`[verify] No client for chainId ${chainId}`);
    await updateTransaction(txId, { status: "failed" });
    if (orderId) await updateMenuOrderPayment(orderId, tx.merchantId, { status: "failed", paymentId: txId, transactionId: txId }).catch(() => undefined);
    notifySseClients(txId, { status: "failed", txHash });
    return;
  }

  // Try WebSocket subscription first (Sepolia + Alchemy key available)
  let receipt = null;
  if (chainId === 11155111 && sepoliaWsClient) {
    try {
      receipt = await waitForReceiptViaWs(sepoliaWsClient, txHash, 180_000);
    } catch (e) {
      console.warn("[verify] WebSocket receipt wait failed, falling back to polling:", e);
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

  if (!receipt || receipt.status !== "success") {
    console.warn(`[verify] txHash ${txHash} failed or timed out`);
    await updateTransaction(txId, { status: "failed" });
    if (orderId) await updateMenuOrderPayment(orderId, tx.merchantId, { status: "failed", paymentId: txId, transactionId: txId }).catch(() => undefined);
    notifySseClients(txId, { status: "failed", txHash });
    return;
  }

  // Verify the Transfer event matches expected coin, toAddress, and amount
  const coinAddress = COIN_CONTRACTS[tx.coin]?.[chainId];
  if (!coinAddress) {
    console.warn(`[verify] Unknown coin ${tx.coin} on chain ${chainId}`);
    // Accept anyway — we at least have a mined tx
    await updateTransaction(txId, { status: "confirmed", verified: 1 });
    if (orderId) await updateMenuOrderPayment(orderId, tx.merchantId, { status: "paid", paymentId: txId, transactionId: txId }).catch(() => undefined);
    notifySseClients(txId, { status: "confirmed", txHash, verified: true });
    return;
  }

  // Parse Transfer logs from the ERC-20 contract
  let transferVerified = false;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== coinAddress.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: ERC20_ABI, data: log.data, topics: log.topics as any }) as any;
      if (decoded.eventName !== "Transfer") continue;
      const toMatch = (decoded.args.to as string).toLowerCase() === tx.toAddress.toLowerCase();
      if (!toMatch) continue;
      // Verify amount (allow ±1 unit tolerance for rounding)
      const decimals = ["USDT", "USDC"].includes(tx.coin) ? 6 : 18;
      const expectedRaw = BigInt(Math.round(parseFloat(tx.amount) * 10 ** decimals));
      const actualRaw = BigInt(decoded.args.value);
      const diff = actualRaw > expectedRaw ? actualRaw - expectedRaw : expectedRaw - actualRaw;
      if (diff <= BigInt(10 ** (decimals - 2))) { // within 0.01 token
        transferVerified = true;
        break;
      }
    } catch { /* skip malformed log */ }
  }

  if (!transferVerified) {
    console.warn(`[verify] Transfer event not found or amount mismatch for txId ${txId}`);
    // Still mark as confirmed — the tx mined, just log the discrepancy
    await updateTransaction(txId, { status: "confirmed", verified: 0 });
    if (orderId) await updateMenuOrderPayment(orderId, tx.merchantId, { status: "paid", paymentId: txId, transactionId: txId }).catch(() => undefined);
    notifySseClients(txId, { status: "confirmed", txHash, verified: false });
  } else {
    await updateTransaction(txId, { status: "confirmed", verified: 1 });
    if (orderId) await updateMenuOrderPayment(orderId, tx.merchantId, { status: "paid", paymentId: txId, transactionId: txId }).catch(() => undefined);
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
    ).catch(console.error);
  }
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
    console.error("[webhook] failed:", e);
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
    } catch (logErr) { console.error("[webhook-log] failed:", logErr); }
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
  } catch (e) { console.error(e); res.status(500).json({ error: "Internal server error" }); }
});

/** GET /api/healthz */
paymentRouter.get("/healthz", (_req, res) => res.json({ status: "ok", ts: Date.now() }));

// ─── Exchange Rates endpoint (Sera Goldsky GraphQL) ─────────────────────────

const GOLDSKY_URL = ENV.goldskyGraphqlUrl;

// Simple in-memory rate cache: { [pair]: { rate, ts } }
const rateCache = new Map<string, { rate: number; ts: number }>();
const CACHE_TTL_MS = 60_000; // 1 minute

// Strict allowlist of known stablecoin symbols (alphanumeric only, 2–8 chars)
const SYMBOL_RE = /^[A-Z0-9]{2,8}$/;

const USD_BRIDGE: Record<string, string> = { USDC: "USDT", EURC: "EURT" };
const TOKEN_CURRENCY: Record<string, string> = {
  USDT: "USD", USDC: "USD", DAI: "USD", PYUSD: "USD", USD1: "USD", USDE: "USD", USDE0: "USD",
  XSGD: "SGD", TNSGD: "SGD",
  MYRT: "MYR",
  IDRX: "IDR", IDRT: "IDR", XIDR: "IDR",
  EURC: "EUR", EURT: "EUR", TNEUR: "EUR", VEUR: "EUR", EUR0: "EUR", EURI: "EUR",
  JPYC: "JPY", GYEN: "JPY",
  AUDD: "AUD", AUDF: "AUD",
  CADC: "CAD", QCAD: "CAD",
  BRZ: "BRL", BRLA: "BRL",
  MXNT: "MXN", MXNB: "MXN",
  NZDD: "NZD", NZDS: "NZD",
  THBT: "THB", THBK: "THB",
  ZARP: "ZAR", ZARU: "ZAR",
  KRW1: "KRW", KRWO: "KRW", KRWIN: "KRW",
  CCHF: "CHF", VCHF: "CHF",
  TRYB: "TRY", ITRY: "TRY",
  PHPC: "PHP",
  HKDR: "HKD",
  CNHT: "CNH",
  CNGN: "NGN",
  A7A5: "RUB",
  ARZ: "ARS", ARC: "ARS", WARS: "ARS",
};

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

async function fetchSeraRestFxRate(from: string, to: string, debug = false, chainId?: number): Promise<{ rate: number; upstream: unknown }> {
  if (from === to) return { rate: 1, upstream: { source: "identity" } };

  const resolvedFrom = USD_BRIDGE[from] ?? from;
  const resolvedTo = USD_BRIDGE[to] ?? to;
  if (resolvedFrom === resolvedTo) {
    return { rate: 1, upstream: { source: "identity", reason: "same resolved currency" } };
  }

  const cacheScope = chainId === SERA_TESTNET_CHAIN_ID ? "test" : "live";
  const cacheKey = `sera-rest:${cacheScope}:${from}:${to}`;
  const cached = rateCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return { rate: cached.rate, upstream: { source: "cache", cacheKey } };
  }

  const base = TOKEN_CURRENCY[resolvedFrom] ?? resolvedFrom;
  const quote = TOKEN_CURRENCY[resolvedTo] ?? resolvedTo;
  const seraApiBaseUrl = getSeraApiBaseUrlForChain(chainId);
  const url = `${seraApiBaseUrl}/fx/rate?base=${encodeURIComponent(base)}&quote=${encodeURIComponent(quote)}`;
  const requestLog = {
    method: "GET",
    url,
    query: { base, quote },
    mappedFrom: { token: from, resolvedToken: resolvedFrom },
    mappedTo: { token: to, resolvedToken: resolvedTo },
  };

  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  const json = await response.json().catch(() => null) as SeraFxRateResponse | { detail?: string } | null;
  if (!response.ok) {
    throw new Error(`Sera FX fetch failed: ${response.status} ${JSON.stringify(json)}`);
  }

  const rate = Number((json as SeraFxRateResponse)?.rate);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(`Invalid Sera FX rate for ${base}/${quote}: ${JSON.stringify(json)}`);
  }

  rateCache.set(cacheKey, { rate, ts: Date.now() });
  rateCache.set(`sera-rest:${cacheScope}:${to}:${from}`, { rate: 1 / rate, ts: Date.now() });

  const upstream = { source: "sera-rest", request: requestLog, response: json };
  if (debug || ENV.seraApiDebug) {
    console.info("[rates:sera]", JSON.stringify(upstream));
  }
  return { rate, upstream };
}

/**
 * GET /api/rates?from=USDT&to=IDRX
 * Returns { rate: number, from: string, to: string, source: "sera" }
 * rate = how many units of `to` coin equal 1 unit of `from` coin
 */
paymentRouter.get("/rates", async (req, res) => {
  try {
    const from = (req.query.from as string)?.toUpperCase();
    const to = (req.query.to as string)?.toUpperCase();
    if (!from || !to) { res.status(400).json({ error: "Missing from/to query params" }); return; }
    if (!SYMBOL_RE.test(from)) { res.status(400).json({ error: `Invalid symbol: ${from}` }); return; }
    if (!SYMBOL_RE.test(to)) { res.status(400).json({ error: `Invalid symbol: ${to}` }); return; }
    if (from === to) { res.json({ from, to, rate: 1, source: "identity" }); return; }
    // Treat bridged equivalents as 1:1 (e.g. USDC↔USDT, EURC↔EURT)
    const bridgedFrom = USD_BRIDGE[from] ?? from;
    const bridgedTo   = USD_BRIDGE[to]   ?? to;
    if (bridgedFrom === bridgedTo) { res.json({ from, to, rate: 1, source: "identity" }); return; }

    const debug = req.query.debug === "1" || req.query.debug === "true";
    const requestedChainId = Number(req.query.chainId ?? req.query.chain_id ?? 1);
    const chainId = Number.isInteger(requestedChainId) && requestedChainId > 0 ? requestedChainId : 1;
    const { rate, upstream } = await fetchSeraRestFxRate(from, to, debug, chainId);
    /*
    // Apply SeraPay's 0.5% silent spread — customer pays slightly more than the raw Sera rate.
    // The merchant receives exactly what they requested; SeraPay keeps the difference.
    const SERA_MARKUP = 1.005;
    const rate = rawRate * SERA_MARKUP;
    */
    // Cache exchange rates for 10 seconds — matches server-side TTL
    res.setHeader("Cache-Control", "public, max-age=10, stale-while-revalidate=30");
    res.json({ from, to, rate, source: "sera-rest", ...(debug ? { upstream } : {}) });
  } catch (e: any) {
    console.error("[rates]", e?.message);
    res.status(502).json({ error: "Failed to fetch exchange rate from Sera", detail: e?.message });
  }
});
