/**
 * SeraPay Payment API Routes
 * Registered under /api/ in server/_core/index.ts
 */
import { Router, Request, Response } from "express";
import crypto from "crypto";
import { assertPublicHttpUrl, UrlGuardError } from "./url-guard";
import { v4 as uuidv4 } from "uuid";
import { createPublicClient, fallback, http, webSocket, parseAbi, parseAbiItem, decodeEventLog, verifyMessage } from "viem";
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
  getPaymentIntentById,
  getMenuOrderById,
  updatePaymentIntent,
  updateMenuOrderPayment,
} from "./db";
import { screenWalletAddress } from "./compliance";
import { ENV } from "./_core/env";
import { PrivyAuthError, assertPrivyWalletOwnership, getPrivyWalletSummary, sendPrivyAuthError, verifyPrivyRequest, type PrivyIdentity, type PrivyWalletOwnership } from "./_core/privy";
import { isR2StorageConfigured, storagePut, storageRead } from "./storage";
import { decryptSecret } from "./secret-vault";
import { notePairResult } from "./pair-liquidity";
import { hashSeraIntentStruct, SERA_INTENT_TYPES, type SeraIntentMessage } from "./sera-intent";
import { PaymentBindingError, assertAmountMatchesReference, assertMenuOrderBindable, assertPaymentIntentBindable } from "./payment-binding";
import { CheckoutPayloadError, isCheckoutSigningReady, signCheckoutPayload, verifyCheckoutPayload } from "./checkout-payload";
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

/** Testnet is reachable only when SERA_ENABLE_TESTNET=true on the server. */
function isTestnetChainEnabled(chainId?: number | null): boolean {
  return chainId === SERA_TESTNET_CHAIN_ID && ENV.seraEnableTestnet;
}

function getSeraApiBaseUrlForChain(chainId?: number | null): string {
  // A caller-supplied `chainId: 11155111` must not be able to redirect the
  // token registry, quote, and FX pipeline at the testnet deployment.
  const baseUrl = isTestnetChainEnabled(chainId)
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
    // Defense in depth for whatever is in the bucket: an object opened
    // directly must never execute (CSP), must download rather than render,
    // and must not be MIME-sniffed into something active. <img> rendering
    // ignores Content-Disposition, so logos keep displaying normally.
    res.setHeader("Content-Security-Policy", "default-src 'none'");
    res.setHeader("Content-Disposition", "attachment");
    res.setHeader("X-Content-Type-Options", "nosniff");
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
    // Name the cause. This line previously printed nothing but itself, so a
     // merchant reporting "Unable to validate API key" gave us no way to tell a
     // pool timeout from a bad connection string. Message only, no stack and no
     // driver object, since those can carry host and credential details.
    console.error("[auth] Unable to validate API key", {
      reason: error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160),
    });
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
    // Linkage first, signature only as a degraded fallback.
    //
    // A signature proves the caller controls the wallet - not that the wallet
    // belongs to this Privy account. Checking the proof first therefore let any
    // wallet that could sign register as a merchant under whoever happened to be
    // logged in, silently bypassing the ownership check that had just refused
    // it. Ask Privy first, and accept a signature only when Privy itself could
    // not answer.
    let walletOwnership: PrivyWalletOwnership;
    try {
      walletOwnership = await assertPrivyWalletOwnership(identity, addr);
    } catch (ownershipError) {
      const lookupUnavailable = ownershipError instanceof PrivyAuthError
        && (ownershipError.code === "PRIVY_USER_LOOKUP_FAILED" || ownershipError.code === "PRIVY_CONFIG_MISSING");
      const proofOwnership = lookupUnavailable
        ? await verifyRegistrationWalletProof(identity, addr, walletProof)
        : null;
      if (!proofOwnership) throw ownershipError;
      walletOwnership = proofOwnership;
    }
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

// SVG is deliberately absent: it is the one image format that can carry
// script. Uploaded logos are stored to R2 and served back, and an SVG served
// from a storage domain executes when opened directly, even though <img>
// rendering is inert. The client uploader only ever sends jpeg/png/webp.
const LOGO_DATA_URI_RE = /^data:image\/(png|jpeg|jpg|gif|webp);base64,([A-Za-z0-9+/=]+)$/;
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
    // SSRF: delivery and webhook/test both run this guard and fail closed, so
    // an internal URL was never actually fetched — but a merchant who saved one
    // got a success response and then silence on every payment. Reject it at
    // save time so the mistake surfaces when it is made, not weeks later in a
    // webhook log. Clearing the URL (null/empty) has nothing to resolve.
    if (typeof webhookUrl === "string" && webhookUrl) {
      try {
        await assertPublicHttpUrl(webhookUrl);
      } catch (guardErr) {
        if (guardErr instanceof UrlGuardError) { res.status(guardErr.status).json({ error: guardErr.message }); return; }
        throw guardErr;
      }
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

    // SSRF: resolve the host and refuse any private/internal address. Checking
    // the resolved IPs (not the hostname string) also defeats DNS rebinding,
    // and the shared guard covers the Tailscale CGNAT range and alternate IP
    // encodings the old inline list missed.
    try {
      await assertPublicHttpUrl(targetUrl);
    } catch (guardErr) {
      if (guardErr instanceof UrlGuardError) { res.status(guardErr.status).json({ error: guardErr.message }); return; }
      throw guardErr;
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
      // redirect:"manual" is load-bearing, not a nicety. The guard above vetted
      // the addresses this URL resolves to, but fetch follows a 3xx by default
      // and resolves the Location itself — so a merchant could name a public
      // host that simply redirects to 169.254.169.254 or a Tailnet address and
      // walk straight past the check. A webhook endpoint has no legitimate
      // reason to redirect, so a 3xx is a failed delivery, not something to follow.
      const resp = await fetch(targetUrl, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(10000) });
      if (resp.status >= 300 && resp.status < 400) {
        res.status(400).json({ error: "Webhook endpoint redirected; redirects are not allowed" });
        return;
      }
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
    // Unpaid Scan & Pay watch rows are the sweep's bookkeeping, not payments;
    // counting them would inflate pending/unverified with every QR shown.
    txs = txs.filter((tx) => !isUnpaidDirectQrWatch(tx));
    if (Number.isInteger(requestedChainId) && requestedChainId > 0) {
      txs = txs.filter((tx) => Number(tx.chainId ?? SERA_MAINNET_CHAIN_ID) === requestedChainId);
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
  // Express 4 does not catch a rejected async handler, and this one awaits the
  // database twice before it streams anything. Unguarded, a single DB blip
  // here became an unhandled rejection and took the whole payment server down.
  try {
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
  } catch (e) {
    logSeraOperationFailure("merchant/events", e);
    // The stream may already be open, in which case the headers are gone and
    // ending it so the client reconnects is the only correct move left.
    if (!res.headersSent) res.status(503).json({ error: "Event stream is temporarily unavailable. Please retry." });
    else { try { res.end(); } catch {} }
  }
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
    // Unpaid Scan & Pay watch rows are the sweep's bookkeeping, not payments
    // the merchant made or a customer began; they show only once a transfer
    // confirms them (see isUnpaidDirectQrWatch).
    txs = txs.filter((tx) => !isUnpaidDirectQrWatch(tx));
    if (Number.isInteger(requestedChainId) && requestedChainId > 0) {
      txs = txs.filter((tx) => Number(tx.chainId ?? SERA_MAINNET_CHAIN_ID) === requestedChainId);
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

/**
 * Our own copy of the Sera token registry, kept indefinitely once fetched.
 *
 * The fresh cache above expires in 30s and used to be *deleted* whenever Sera
 * errored, so an outage on their side erased every contract address and decimal
 * we hold — and Sera's API is demonstrably flaky. A token's address, symbol and
 * decimals are immutable, so there is no reason to ever discard them: the only
 * risk of serving a stale registry is missing a newly-listed currency, which is
 * vastly preferable to being unable to describe the currency a merchant is
 * actively taking money in.
 */
const lastKnownGoodRegistry = new Map<string, { tokens: SeraToken[]; fetchedAt: number }>();

/** Whether the registry currently being served came from a Sera failure path. */
export function registrySnapshotAge(baseUrl: string): number | null {
  const snapshot = lastKnownGoodRegistry.get(normalizeSeraBaseUrl(baseUrl));
  return snapshot ? Date.now() - snapshot.fetchedAt : null;
}

async function getPaymentTokenRegistry(baseUrl: string): Promise<SeraToken[]> {
  const key = normalizeSeraBaseUrl(baseUrl);
  const cached = paymentTokenRegistryCache.get(key);
  if (cached?.tokens.length && cached.expiresAt > Date.now()) return cached.tokens;
  if (cached?.request) return cached.request;

  const request = getSeraTokens(key)
    .then((registry) => {
      const tokens = registry.tokens.filter((token) => /^0x[0-9a-fA-F]{40}$/.test(token.address));
      paymentTokenRegistryCache.set(key, { tokens, expiresAt: Date.now() + 30_000 });
      if (tokens.length > 0) lastKnownGoodRegistry.set(key, { tokens, fetchedAt: Date.now() });
      return tokens;
    })
    .catch((error) => {
      paymentTokenRegistryCache.delete(key);
      // Fall back to our own copy rather than propagating Sera's outage into a
      // checkout that only needed a contract address we already had.
      const snapshot = lastKnownGoodRegistry.get(key);
      if (snapshot?.tokens.length) {
        logSeraOperationFailure("tokens/serving-cached-registry", error);
        return snapshot.tokens;
      }
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

/**
 * The spender named inside the permit the PAYER is asked to sign.
 *
 * getPermitApproval below only reports a spender on the non-EIP-2612 fallback
 * branch, so on the ordinary permit path nothing was checking who the customer
 * authorises. They sign quote.permit.eip712 blind in their wallet, so the
 * spender inside it has to be held against the live SOR contract too.
 *
 * Returns null when the payload names no spender we recognise — callers must
 * treat that as "nothing to check", never as approval.
 */
function getPermitSpender(permit: unknown): string | null {
  const typedData = getPermitTypedData(permit) as Record<string, unknown> | null;
  const message = typedData?.message as Record<string, unknown> | undefined;
  const details = message?.details as Record<string, unknown> | undefined;
  const spender = message?.spender ?? details?.spender;
  return typeof spender === "string" && /^0x[0-9a-fA-F]{40}$/.test(spender) ? spender : null;
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
      if (isDirectQrWatchTransaction(tx)) {
        // A Scan & Pay watch row stands for a QR nobody paid, not for a
        // customer who walked away mid-payment. Expire it so the sweep stops
        // scanning for it, but without transaction_auto_canceled: that event
        // is the dashboard's "a payment was abandoned" toast, and a merchant
        // who merely left the QR screen has nothing to be told.
        if (await expireDirectQrWatch(tx)) canceled += 1;
        continue;
      }
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

/**
 * Detect direct ERC-20 payments without waiting to be asked.
 *
 * A plain transfer never touches Sera's contracts and Sera has no webhooks, so
 * nothing tells us a customer paid — we have to find it by scanning Transfer
 * logs to the merchant's receiving addresses. That scan only ever ran when a
 * request carried `?syncDirect=1`, a parameter no client sends, so in practice
 * it never ran at all: an order was confirmed only if the merchant happened to
 * have a dashboard open at the right moment. A counter terminal cannot depend
 * on that.
 *
 * Scoped to merchants holding a pending transaction — precisely the set with a
 * payment outstanding — so RPC cost tracks real trade rather than the size of
 * the merchant table. syncMerchantDirectTransfers throttles itself per
 * merchant+chain, so an overlapping tick is a no-op rather than duplicate work.
 */
async function sweepPendingMerchantDirectActivity() {
  const SWEEP_CONCURRENCY = 4;
  try {
    const pending = await getPendingTransactions();
    // One sweep per merchant; the chain of their oldest pending payment is the
    // one worth scanning first.
    const chainByMerchant = new Map<string, number | null>();
    for (const tx of pending) {
      if (!chainByMerchant.has(tx.merchantId)) {
        chainByMerchant.set(tx.merchantId, Number(tx.chainId) || null);
      }
    }

    const entries = Array.from(chainByMerchant.entries());
    for (let index = 0; index < entries.length; index += SWEEP_CONCURRENCY) {
      // Bounded concurrency: each merchant fans out to one eth_getLogs per
      // (receiving address × coin), and an unbounded burst would trip public
      // RPC rate limits and starve the checkout path of the same providers.
      await Promise.allSettled(entries.slice(index, index + SWEEP_CONCURRENCY).map(async ([merchantId, chainId]) => {
        const merchant = await getMerchantById(merchantId).catch(() => null);
        if (!merchant) return;
        await syncMerchantDirectActivity(merchant, chainId).catch((error) => {
          logSeraOperationFailure("payments/direct-sweep", error);
        });
      }));
    }
  } catch (error) {
    logSeraOperationFailure("payments/direct-sweep", error);
  }
}

setInterval(() => {
  void (async () => {
    // Detect arrivals *before* expiring anything: a payment that landed moments
    // before the staleness cutoff must be confirmed, not cancelled out from
    // under the customer who just sent real funds.
    await sweepPendingMerchantDirectActivity();
    await cancelAllStalePendingTransactions();
    await reverifyConfirmingTransactions();
  })();
}, 60_000);

/**
 * Re-checks every "confirming" row on the server's own clock.
 *
 * Verification was previously re-armed only by the payer's status polls, so a
 * payer who broadcast from their wallet and then closed the tab left a payment
 * that had settled on-chain sitting at "Processing" forever — the merchant's
 * transaction list never triggers verification. The transfer is real money
 * already received; finding it must not depend on the customer's browser.
 */
async function reverifyConfirmingTransactions() {
  try {
    const pending = await getPendingTransactions();
    // A week covers any realistic gap between a payment landing and a deploy
    // that can finally verify it — real stuck rows deserve capture, not
    // abandonment. Older rows are structural leftovers (dead test data, an
    // unindexable hash); the per-tx backoff already keeps their retries and
    // log lines rare.
    const reverifyCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const tx of pending) {
      if (tx.status !== "confirming") continue;
      if (new Date(tx.createdAt).getTime() < reverifyCutoff) continue;
      if (isSeraSwapTransaction(tx)) {
        await reconcileSeraSwapTransaction(tx).catch((error) => logSeraOperationFailure("payments/reverify-swap", error));
      } else if (tx.txHash && /^0x[0-9a-fA-F]{64}$/.test(tx.txHash)) {
        // Fire-and-forget with a per-tx in-flight guard, so a slow receipt
        // wait never stacks a second watcher for the same payment.
        scheduleTransactionVerification(tx.id, tx.txHash as `0x${string}`);
      }
    }
  } catch (error) {
    logSeraOperationFailure("payments/reverify", error);
  }
}

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
  if (notes.type !== "sera_swap") return tx;
  // A submit whose answer was lost in transit (see /payment/swap/submit) has
  // no trade id to ask Sera about; the chain is the only witness left.
  if (!tradeId) return reconcileSeraSwapOnChain(tx, notes);

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

  // Sera is explicit that error_code is the field to branch on and `error` is
  // display-only. TRANSIENT_SETTLEMENT_FAILURE is documented as retryable
  // infrastructure noise, so treating it as terminal would abandon a swap that
  // is still going to settle - and the payer has already parted with funds.
  const seraErrorCode = String(order.error_code || "").toUpperCase();
  const retryableFailure = seraErrorCode === "TRANSIENT_SETTLEMENT_FAILURE";
  if ((seraStatus === "failed" || seraStatus === "cancelled") && !retryableFailure) {
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

/**
 * When the payment names what it is for (a payment intent or a menu order),
 * the stored record is authoritative: this re-verifies ownership, life-cycle
 * state and currency on the server and returns the amount the payment must
 * cover. Without it, a checkout link could be re-encoded with a smaller
 * amount, paid, and still fulfil the order.
 */
async function resolvePayableReferenceAmount({
  merchant,
  receiveCoin,
  paymentIntentId,
  orderId,
}: {
  merchant: Merchant;
  receiveCoin: string;
  paymentIntentId: string | null;
  orderId: string | null;
}): Promise<{ amount: string; label: string } | null> {
  if (!paymentIntentId && !orderId) return null;
  const references: Array<{ amount: string; label: string }> = [];
  if (paymentIntentId) {
    const intent = await getPaymentIntentById(paymentIntentId);
    references.push({
      amount: assertPaymentIntentBindable(intent, { merchantId: merchant.id, receiveCoin }),
      label: "payment intent",
    });
  }
  if (orderId) {
    const order = await getMenuOrderById(orderId);
    references.push({
      amount: assertMenuOrderBindable(order, {
        merchantId: merchant.id,
        receiveCoin,
        merchantReceiveCoin: merchant.receiveCoin,
      }),
      label: "menu order",
    });
  }
  // When both are named, the larger amount is the one that has to be covered.
  return references.sort((a, b) => Number(b.amount) - Number(a.amount))[0] ?? null;
}

/**
 * Verifies the signed checkout segment a /pay checkout sends back with its
 * payment calls. When present, the payload's receiver, currency and amount
 * override whatever the request body says — the signed link, not the browser
 * body, decides where money moves. Returns null when no payload was sent;
 * throws CheckoutPayloadError (400) on anything unsigned or tampered.
 */
function bindCheckoutRequest(raw: unknown): Record<string, any> | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") throw new CheckoutPayloadError("Invalid checkout payload");
  const request = verifyCheckoutPayload(raw.trim());
  if (!request) {
    throw new CheckoutPayloadError("This checkout link failed verification. Ask the merchant for a fresh link.");
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(request.receiverAddress || ""))) {
    throw new CheckoutPayloadError("Checkout link has an invalid receiver address");
  }
  if (!COIN_SYMBOL_RE.test(String(request.receiveCoin || ""))) {
    throw new CheckoutPayloadError("Checkout link has an invalid currency");
  }
  // Enforce the link's own expiry on the server. The checkout page already
  // refuses an expired link, but that is only a client-side courtesy — a
  // request made straight to this endpoint bypassed it entirely and an expired
  // link stayed payable. Signed into the payload, so a payer cannot extend it.
  const expiresAt = Number(request.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt > 0 && Date.now() > expiresAt) {
    throw new CheckoutPayloadError("This checkout link has expired. Ask the merchant for a fresh link.", 410);
  }
  return request;
}

function getPublicBaseUrl(req: Request): string {
  if (ENV.paymentBaseUrl) return ENV.paymentBaseUrl.replace(/\/+$/, "");
  return `${req.protocol}://${req.get("host")}`;
}

/**
 * Clamps a dashboard checkout request down to the fields a signed payload may
 * carry. Amounts must survive normalizeDecimalAmount; anything unrecognized is
 * dropped rather than signed blind. Testnet is only signable when the server
 * enabled it.
 */
function sanitizeCheckoutRequest(input: any): Record<string, unknown> | null {
  if (!input || typeof input !== "object") return null;
  const receiverAddress = String(input.receiverAddress ?? "").toLowerCase();
  if (!/^0x[0-9a-fA-F]{40}$/.test(receiverAddress)) return null;
  const receiveCoin = String(input.receiveCoin ?? "").trim().toUpperCase();
  if (!COIN_SYMBOL_RE.test(receiveCoin)) return null;

  const payload: Record<string, unknown> = { receiverAddress, receiveCoin };
  try {
    if (input.amount !== undefined && input.amount !== null && input.amount !== "") {
      payload.amount = normalizeDecimalAmount(input.amount);
    }
    if (input.payAmount !== undefined && input.payAmount !== null && input.payAmount !== "") {
      payload.payAmount = normalizeDecimalAmount(input.payAmount);
    }
  } catch {
    return null;
  }
  // payCoin is the "Customer Pays" token the merchant set alongside payAmount.
  // It is a display preset only: the checkout uses it to pre-select the pay
  // token and to fire the express wallet connect on Scan & Pay links. No
  // server route reads it to move money — /payment/create takes the coin from
  // the request body and /payment/swap/quote from req.body.payCoin, and both
  // stay bound to the signed receiveCoin/amount. Dropping it here meant every
  // conversion-mode link opened on the receive coin instead of the coin the
  // merchant had just quoted the customer.
  if (typeof input.payCoin === "string") {
    const payCoin = input.payCoin.trim().toUpperCase();
    if (COIN_SYMBOL_RE.test(payCoin)) payload.payCoin = payCoin;
  }
  const chainId = Number(input.chainId ?? SERA_MAINNET_CHAIN_ID);
  if (chainId !== SERA_MAINNET_CHAIN_ID && !isTestnetChainEnabled(chainId)) return null;
  payload.chainId = chainId;

  if (typeof input.description === "string" && input.description.trim()) payload.description = input.description.trim().slice(0, 300);
  if (typeof input.merchantName === "string" && input.merchantName.trim()) payload.merchantName = input.merchantName.trim().slice(0, 120);
  if (typeof input.merchantIcon === "string" && input.merchantIcon.length <= 4096) payload.merchantIcon = input.merchantIcon;
  const expiresAt = Number(input.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt > Date.now()) payload.expiresAt = expiresAt;
  if (input.singleUse === true) payload.singleUse = true;

  for (const key of ["paymentIntentId", "orderId", "menuName", "menuSlug"] as const) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) payload[key] = value.trim().slice(0, 120);
  }
  if (Array.isArray(input.orderItems)) {
    const items = input.orderItems.slice(0, 80).map((item: any) => ({
      id: String(item?.id ?? "").slice(0, 64),
      n: String(item?.n ?? "").slice(0, 200),
      p: String(item?.p ?? "").slice(0, 32),
      q: Math.max(0, Math.min(99, Number.parseInt(String(item?.q ?? 0), 10) || 0)),
      ...(item?.c ? { c: String(item.c).trim().slice(0, 20).toUpperCase() } : {}),
    })).filter((item: any) => item.id && item.n && item.q > 0);
    if (items.length > 0) payload.orderItems = items;
  }

  payload._n = crypto.randomBytes(4).toString("hex");
  return payload;
}

/** POST /api/payment/checkout/sign — mint a signed checkout link for this merchant */
paymentRouter.post("/payment/checkout/sign", requireApiKey as any, async (req: any, res) => {
  try {
    if (!isCheckoutSigningReady()) {
      res.status(503).json({ error: "Checkout link signing is unavailable (SESSION_SECRET is not configured)" });
      return;
    }
    const payload = sanitizeCheckoutRequest(req.body?.request ?? req.body);
    if (!payload) {
      res.status(400).json({ error: "Invalid checkout request" });
      return;
    }
    const receiver = String(payload.receiverAddress);
    const subWallets = await listSubWallets(req.merchant.id);
    const owned = [req.merchant.walletAddress, req.merchant.storeAddress, ...subWallets
      .filter((wallet) => wallet.status === "active")
      .map((wallet) => wallet.address)]
      .some((address) => String(address || "").toLowerCase() === receiver);
    if (!owned) {
      res.status(403).json({ error: "Receiver address does not belong to this merchant" });
      return;
    }
    const encoded = signCheckoutPayload(payload);
    res.json({ encoded, paymentUrl: `${getPublicBaseUrl(req)}/pay/${encoded}` });
  } catch (e) {
    if (e instanceof CheckoutPayloadError) { res.status(e.status).json({ error: e.message }); return; }
    logSeraOperationFailure("payment/checkout/sign", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

/** POST /api/payment/create — create a pending payment request */
paymentRouter.post("/payment/create", async (req, res) => {
  try {
    const checkoutRequest = bindCheckoutRequest(req.body.checkoutPayload);
    const merchantAddress = String(checkoutRequest?.receiverAddress ?? req.body.merchantAddress ?? "");
    const coin = String(checkoutRequest?.receiveCoin ?? req.body.coin ?? "");
    // The signed payload's receiveCoin is authoritative for a direct transfer
    // and the body cannot override it. A body coin that differs is not a
    // forgery though — it is the checkout paying in another token, which is a
    // Sera swap and belongs on /payment/swap/quote, never here. Silently
    // substituting the receive coin returned the wrong token address, the
    // checkout's consistency check threw, and the pending row inserted below
    // sat orphaned until the 5-minute auto-cancel woke the merchant for a
    // payment that never began. Refuse before anything is screened, resolved
    // or written.
    const requestedCoin = typeof req.body.coin === "string" ? req.body.coin.trim().toUpperCase() : "";
    if (checkoutRequest && requestedCoin && requestedCoin !== String(checkoutRequest.receiveCoin)) {
      // Cross-coin settles through /payment/swap/*, so a direct create naming
      // another coin is a stale page or a raw API call. Says which currency the
      // link is priced in rather than a bare "Invalid coin", because the payer
      // can act on that (owner-approved wording, 2026-09-04).
      const requestedLabel = COIN_SYMBOL_RE.test(requestedCoin) ? requestedCoin : "another currency";
      res.status(400).json({
        error: `This checkout is priced in ${checkoutRequest.receiveCoin}. Paying in ${requestedLabel} goes through a swap — refresh the page and try again.`,
      });
      return;
    }
    const amount = checkoutRequest?.amount ?? req.body.amount;
    const chainId = checkoutRequest ? checkoutRequest.chainId : req.body.chainId;
    const orderId = typeof (checkoutRequest?.orderId ?? req.body.orderId) === "string"
      ? String(checkoutRequest?.orderId ?? req.body.orderId)
      : null;
    const paymentIntentId = typeof (checkoutRequest?.paymentIntentId ?? req.body.paymentIntentId) === "string"
      ? String(checkoutRequest?.paymentIntentId ?? req.body.paymentIntentId)
      : null;
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
    const payableReference = await resolvePayableReferenceAmount({
      merchant,
      receiveCoin: coinSymbol,
      paymentIntentId,
      orderId,
    });
    const id = uuidv4();
    const toAddressCompliance = await screenWalletAddress(toAddress, "recipient_wallet", merchant.id);
    if (toAddressCompliance.blocked) {
      res.status(403).json({ error: "Recipient address failed compliance screening", compliance: toAddressCompliance });
      return;
    }
    const resolvedChainId = Number(chainId || SERA_MAINNET_CHAIN_ID);
    let paymentToken: SeraToken;
    try {
      paymentToken = await resolveSeraTokenForChain(resolvedChainId, coinSymbol);
      toRawTokenAmount(normalizedAmount, paymentToken.decimals);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Unsupported coin on this network" });
      return;
    }
    if (payableReference) {
      assertAmountMatchesReference(normalizedAmount, payableReference.amount, { exact: true, label: payableReference.label });
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
  } catch (e) {
    if (e instanceof PaymentBindingError) { res.status(e.status).json({ error: e.message }); return; }
    if (e instanceof CheckoutPayloadError) { res.status(e.status).json({ error: e.message }); return; }
    logSeraOperationFailure("payment-route", e); res.status(500).json({ error: "Internal server error" });
  }
});

/** POST /api/payment/swap/quote - Sera quote for customer coin -> merchant receive coin */
paymentRouter.post("/payment/swap/quote", async (req, res) => {
  try {
    const checkoutRequest = bindCheckoutRequest(req.body.checkoutPayload);
    const merchantAddress = String(checkoutRequest?.receiverAddress ?? req.body.merchantAddress ?? "").trim();
    const payerAddress = String(req.body.payerAddress ?? "").trim().toLowerCase();
    const payCoin = String(req.body.payCoin ?? "").trim().toUpperCase();
    const receiveCoin = String(checkoutRequest?.receiveCoin ?? req.body.receiveCoin ?? "").trim().toUpperCase();
    let payAmount = "";
    let requestedReceiveAmount: string | null = null;
    try {
      payAmount = normalizeDecimalAmount(req.body.payAmount);
      // A signed checkout fixes what the merchant receives; the body only
      // supplies a receive amount for open-amount checkouts.
      const checkoutAmount = typeof checkoutRequest?.amount === "string" ? checkoutRequest.amount : "";
      requestedReceiveAmount = checkoutAmount
        ? normalizeDecimalAmount(checkoutAmount)
        : req.body.receiveAmount
          ? normalizeDecimalAmount(req.body.receiveAmount)
          : null;
    } catch (error: any) {
      res.status(400).json({ error: error?.message || "Invalid amount" });
      return;
    }
    const requestedChainId = Number(checkoutRequest ? checkoutRequest.chainId : (req.body.chainId ?? 1));
    const chainId = Number.isInteger(requestedChainId) && requestedChainId > 0 ? requestedChainId : 1;
    const paymentIntentId = typeof (checkoutRequest?.paymentIntentId ?? req.body.paymentIntentId) === "string"
      ? String(checkoutRequest?.paymentIntentId ?? req.body.paymentIntentId)
      : null;
    const orderId = typeof (checkoutRequest?.orderId ?? req.body.orderId) === "string"
      ? String(checkoutRequest?.orderId ?? req.body.orderId)
      : null;
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
    const payableReference = await resolvePayableReferenceAmount({
      merchant,
      receiveCoin,
      paymentIntentId,
      orderId,
    });

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

    const fromAmountRaw = toRawTokenAmount(payAmount, fromToken.decimals);

    // Pre-flight Sera's per-token minimum so the payer gets a specific number
    // instead of a bare AMOUNT_BELOW_MIN after a round trip. This constrains
    // SWAPS only — a direct ERC-20 transfer never touches Sera's contracts and
    // has no minimum, so this check lives on the swap path alone.
    const minimumRaw = BigInt(String(fromToken.min_trade_amount_raw || "0"));
    if (minimumRaw > 0n && BigInt(fromAmountRaw) < minimumRaw) {
      res.status(400).json({
        error: `Minimum ${fromToken.min_trade_amount} ${fromToken.symbol} is required to convert with Sera.`,
        errorCode: "amount_below_min",
        detail: {
          coin: fromToken.symbol,
          minimum: fromToken.min_trade_amount,
          requested: payAmount,
        },
      });
      return;
    }

    const quoteRequest = {
      from_token: fromToken.address,
      to_token: toToken.address,
      from_amount: fromAmountRaw,
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
    // Sera answers HTTP 200 with minOutputAmount "0" when no executable route
    // exists at this size. Those quotes are informational only and POST /swap
    // rejects them, so refuse here rather than persisting a transaction the
    // payer can never settle. This has to sit OUTSIDE the requestedReceiveAmount
    // branch below: receiveAmount is optional on this route, and a zero-output
    // quote is equally unusable with or without it.
    const assertExecutableRoute = () => {
      if (BigInt(String(routeParams.minOutputAmount)) <= 0n) {
        throw new SeraApiError(
          409,
          `Sera has no executable route for ${fromToken.symbol}/${toToken.symbol} at this amount`,
          undefined,
          "no_liquidity",
        );
      }
    };
    assertExecutableRoute();
    if (requestedReceiveAmount) {
      const requestedOutputRaw = BigInt(toRawTokenAmount(requestedReceiveAmount, toToken.decimals));
      const quotedOutputRaw = BigInt(String(routeParams.minOutputAmount));
      if (quotedOutputRaw < requestedOutputRaw) {
        const currentInputRaw = BigInt(quoteRequest.from_amount);
        // Round up proportionally, then add a small buffer for quote refresh
        // movement so the merchant amount is not underpaid by token rounding.
        const adjustedInputRaw = ((currentInputRaw * requestedOutputRaw + quotedOutputRaw - 1n) / quotedOutputRaw * 1001n + 999n) / 1000n;
        quoteRequest.from_amount = adjustedInputRaw.toString();
        quote = await requestQuote();
        routeParams = getRouteParams(quote);
        assertExecutableRoute();
        if (BigInt(String(routeParams.minOutputAmount)) < requestedOutputRaw) {
          throw new Error("Sera quote cannot currently cover the merchant receive amount");
        }
      }
    }
    // quote.uuid is the quote record id POST /swap resolves; routeParams.uuid is
    // the composite uint256 bound into the signed intent. They are different
    // values, so falling back from one to the other submits an id Sera cannot
    // resolve — and does it silently, at settlement time. Fail here instead.
    const quoteUuid = typeof quote.uuid === "string" || typeof quote.uuid === "number"
      ? String(quote.uuid)
      : "";
    if (!quoteUuid) throw new Error("Sera quote did not return a quote id");
    // SeraSOR's IntentMatched event emits the EIP-712 struct hash (before the
    // domain separator), so persist exactly that value for public on-chain
    // settlement reconciliation.
    const intentHash = hashSeraIntentStruct(routeParams);
    const expectedReceiveAmount = requestedReceiveAmount ?? fromRawTokenAmount(routeParams.minOutputAmount, toToken.decimals);
    if (payableReference) {
      assertAmountMatchesReference(expectedReceiveAmount, payableReference.amount, { exact: false, label: payableReference.label });
    }
    const maximumPayAmount = fromRawTokenAmount(routeParams.maxInputAmount, fromToken.decimals);
    const approval = getPermitApproval(quote.permit, routeParams.maxInputAmount);
    if (approval && (!config.sor_address || approval.spender.toLowerCase() !== config.sor_address.toLowerCase())) {
      throw new Error("Sera quote approval target does not match the live SOR contract");
    }
    // Same guarantee for the ordinary EIP-2612 path, which the check above
    // never reached: whoever the payer is about to approve for maxInputAmount
    // must be the SOR contract Sera itself reports.
    const permitSpender = getPermitSpender(quote.permit);
    if (permitSpender && (!config.sor_address || permitSpender.toLowerCase() !== config.sor_address.toLowerCase())) {
      throw new Error("Sera quote permit spender does not match the live SOR contract");
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
    if (e instanceof PaymentBindingError) { res.status(e.status).json({ error: e.message }); return; }
    if (e instanceof CheckoutPayloadError) { res.status(e.status).json({ error: e.message }); return; }
    logSeraOperationFailure("payment/swap/quote", e);
    const response = seraPaymentErrorResponse(e, "Unable to create Sera swap quote");
    res.status(response.status).json(response.body);
  }
});

/**
 * Sera matches and may settle the order inside POST /swap itself, so the 8s
 * default in callSeraApi regularly fired after Sera had accepted the order.
 * Give settlement room; the answer-lost handling below covers the rest.
 */
const SERA_SWAP_SUBMIT_TIMEOUT_MS = 25_000;

/**
 * Error codes that prove a request never reached Sera: no connection (or TLS
 * session) was ever established, so nothing could have been accepted.
 */
const SERA_NEVER_CONNECTED_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);

/**
 * True when Sera never answered the call, so its outcome is unknown: an abort
 * on our own timeout, ECONNRESET, ETIMEDOUT mid-read, undici's socket, headers
 * and body timeouts, a 2xx whose body could not be read. A SeraApiError is the
 * opposite case — Sera answered, and the answer was no — and so is a failure
 * to connect at all. Node's fetch wraps the socket error in a
 * TypeError("fetch failed") whose cause carries the code, hence the walk.
 */
function isSeraAnswerMissing(error: unknown): boolean {
  if (error instanceof SeraApiError) return false;
  for (let current: any = error, depth = 0; current && typeof current === "object" && depth < 5; current = current.cause, depth += 1) {
    const code = typeof current.code === "string" ? current.code.toUpperCase() : "";
    if (SERA_NEVER_CONNECTED_CODES.has(code) || /^ERR_TLS_|CERT|SSL/.test(code)) return false;
  }
  return true;
}

/** POST /api/payment/swap/submit - submit signed Sera swap intent */
paymentRouter.post("/payment/swap/submit", async (req, res) => {
  let txForFailure: Transaction | undefined;
  // Where the order stands with Sera when an error reaches the catch below.
  // "unknown" from the instant POST /swap leaves this process until Sera
  // answers; "accepted" once it has, even if our own bookkeeping then throws.
  // Only "unsent", "rejected" and a proven non-delivery may fail the row —
  // anything else means the order may well be settling.
  let seraOutcome: "unsent" | "unknown" | "rejected" | "accepted" = "unsent";
  let seraTradeId: string | null = null;
  let submittedBlockNumber: string | null = null;
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
    submittedBlockNumber = await CHAIN_CLIENTS[tx.chainId]?.getBlockNumber()
      .then((blockNumber: bigint) => blockNumber.toString())
      .catch(() => null) ?? null;
    seraOutcome = "unknown";
    const result = await callSeraApi<Record<string, unknown>>({
      baseUrl,
      path: "/swap",
      method: "POST",
      body,
      authMode: "eip712",
      merchantId: tx.merchantId,
      timeoutMs: SERA_SWAP_SUBMIT_TIMEOUT_MS,
    });

    const tradeId = typeof result.trade_id === "string" ? result.trade_id : null;
    const seraStatus = typeof result.status === "string" ? result.status.toLowerCase() : "pending";
    const success = result.success === true && Boolean(tradeId);
    seraOutcome = success ? "accepted" : "rejected";
    seraTradeId = tradeId;
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
      // Sera answered and declined (or returned no trade id). Route it through
      // failTransactionRecord like every other terminal failure so the
      // merchant SSE fires and the payment intent, not only the menu order,
      // leaves "open" — this branch used to tell the payer alone.
      // Sera's own words when it gives any, and nothing of ours when it does
      // not: an empty reason leaves failureReason unset, so the checkout falls
      // back to its existing approved "Payment verification failed" line.
      const reason = [result.error, result.message, result.error_code]
        .find((value): value is string => typeof value === "string" && value.trim().length > 0)
        ?? "";
      await updateTransaction(txId, { notes });
      await failTransactionRecord({ ...tx, notes }, reason);
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
    logSeraOperationFailure("payment/swap/submit", e);
    if (txForFailure && (seraOutcome === "accepted" || (seraOutcome === "unknown" && isSeraAnswerMissing(e)))) {
      // Either Sera accepted the order and our own bookkeeping threw, or the
      // order left this process and Sera never answered — an abort after the
      // budget above, a reset socket, a dropped response. In both cases Sera
      // may be settling it and the payer has already signed away funds, so
      // this must not become "failed": the row stays "confirming" under
      // notes.type "sera_swap" and reconciliation decides. With no trade id
      // to look up, reconcileSeraSwapTransaction falls back to the on-chain
      // IntentMatched scan keyed by the intentHash the quote already stored.
      // The checkout treats a non-2xx here as final and offers a retry, and a
      // second signed intent could pay the merchant twice if the first lands,
      // so the answer is the state the row is actually in.
      const current = await getTransactionById(txForFailure.id).catch(() => null);
      if (current && current.status !== "pending" && current.status !== "confirming") {
        // The success path (or a concurrent reconcile) already settled it.
        res.json({ success: current.status === "confirmed", status: current.status, txHash: current.txHash ?? null });
        return;
      }
      let existingNotes: Record<string, unknown> = {};
      try {
        const raw = (current ?? txForFailure).notes;
        existingNotes = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      } catch {}
      const tradeId = seraTradeId ?? (typeof existingNotes.tradeId === "string" ? existingNotes.tradeId : null);
      const notes = JSON.stringify({
        ...existingNotes,
        type: "sera_swap",
        tradeId,
        submittedBlockNumber: existingNotes.submittedBlockNumber ?? submittedBlockNumber,
        seraSubmitError: e instanceof Error ? e.message : "Sera did not answer the swap submission",
      });
      await updateTransaction(txForFailure.id, { status: "confirming", notes }).catch((updateError) => {
        logSeraOperationFailure("payment/swap/status-update", updateError);
      });
      res.json({ success: true, status: "confirming", tradeId, txHash: current?.txHash ?? null });
      return;
    }
    const response = seraPaymentErrorResponse(e, "Unable to submit Sera swap");
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
      chainId: tx.chainId ?? SERA_MAINNET_CHAIN_ID,
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

/**
 * eth_getLogs span per request when DIRECT_SYNC_LOOKBACK_BLOCKS has no entry
 * for the chain: public providers commonly cap the inclusive window at 50.
 */
const DIRECT_SCAN_CHUNK_BLOCKS = 49n;
/**
 * Chunks one poll may walk before handing its cursor back. Six 50-block
 * chunks is about five minutes of mainnet — enough for a QR screen whose tab
 * was suspended for a while to catch up within a poll or two, small enough
 * that no single poll monopolises the RPC providers the checkout path shares.
 */
const DIRECT_SCAN_MAX_CHUNKS = 6;
/** Wall-clock budget for one poll's log scan, across all of its chunks. */
const DIRECT_SCAN_TIME_BUDGET_MS = 8000;

paymentRouter.post("/payment/direct/scan", async (req, res) => {
  try {
    const toAddress = String(req.body.toAddress ?? "").trim().toLowerCase();
    const coin = String(req.body.coin ?? "").trim().toUpperCase();
    const amount = String(req.body.amount ?? "").trim();
    const chainId = Number(req.body.chainId ?? SERA_MAINNET_CHAIN_ID);
    const paymentUrl = typeof req.body.paymentUrl === "string" ? req.body.paymentUrl : null;
    const requestedFromBlock = req.body.fromBlock !== undefined && req.body.fromBlock !== null && req.body.fromBlock !== ""
      ? BigInt(String(req.body.fromBlock))
      : null;

    if (!/^0x[0-9a-fA-F]{40}$/.test(toAddress)) { res.status(400).json({ error: "Invalid receiver wallet" }); return; }
    if (!COIN_SYMBOL_RE.test(coin)) { res.status(400).json({ error: "Unsupported coin" }); return; }
    if (!/^\d+(\.\d{1,6})?$/.test(amount) || Number(amount) <= 0) { res.status(400).json({ error: "Invalid amount" }); return; }
    const client = CHAIN_CLIENTS[chainId];
    if (!client) { res.status(400).json({ error: "Unsupported chain" }); return; }
    let token: SeraToken;
    try {
      token = await resolveSeraTokenForChain(chainId, coin);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Unsupported coin on this network" });
      return;
    }
    const storedPaymentUrl = storedDirectQrPaymentUrl(paymentUrl);

    // The QR's server-side watch row (see resolveDirectQrWatch): armed by the
    // first poll — before the RPC is asked anything, so a slow provider cannot
    // leave the QR unwatched — and afterwards only looked up, lazily, when a
    // transfer already on file needs the anchor for the ownership test below.
    // A receiver no merchant owns has nowhere to hang a row, and
    // recordDirectTransferPayment refuses such transfers anyway. A failure
    // here must not cost the poll its scan.
    let watch: Transaction | null = null;
    let watchResolved = false;
    const resolveWatch = async (create: boolean) => {
      if (watchResolved) return watch;
      watchResolved = true;
      try {
        const resolved = await resolveMerchantForReceiver(toAddress);
        if (!resolved) return null;
        const decimals = token.decimals ?? await getTokenDecimals(client, token.address as `0x${string}`);
        watch = await resolveDirectQrWatch({
          merchant: resolved.merchant,
          receiveAddress: resolved.receiveAddress,
          coin,
          amount,
          chainId,
          paymentUrl: storedPaymentUrl,
          decimals,
          create,
        });
      } catch (error) {
        logSeraOperationFailure("payment/direct/watch", error);
      }
      return watch;
    };
    if (requestedFromBlock === null) await resolveWatch(true);

    // A log whose hash is already on file was recorded by an earlier poll, by
    // the sweep, or for a previous customer — and only the last must not
    // count. The first poll's look-back window (or a cursor pulled back to a
    // lagging node's head) re-surfaces the transfer that paid the QR shown a
    // minute ago, quite possibly an identically priced one with the identical
    // link; answering "confirmed" to it marked this QR paid while its real
    // payment was never looked for. directTransferBelongsToQr decides; the
    // watch row supplies the moment this QR began.
    const transferBelongsToThisQr = async (txHash: `0x${string}`) => {
      const existing = await getTransactionByHash(txHash.toLowerCase()) || await getTransactionByHash(txHash);
      if (!existing) return true;
      const anchor = await resolveWatch(false);
      return directTransferBelongsToQr(existing, storedPaymentUrl, anchor?.createdAt ?? null);
    };

    let latestBlock: bigint;
    try {
      latestBlock = await withDirectScanTimeout(client.getBlockNumber(), 8000);
    } catch {
      res.json({ status: "pending", fromBlock: requestedFromBlock?.toString() ?? null, warning: "Scanner RPC is temporarily slow" });
      return;
    }

    // The first poll for a QR looks back a few blocks so a wallet quicker than
    // the screen is not missed; each later poll resumes at the cursor the
    // previous answer handed back. That cursor used to be clamped forward to
    // latest-49: a phone that had suspended the tab for a couple of minutes
    // came back to find the blocks in between skipped without a word, and
    // with them the payment. The poll now walks forward from the cursor in
    // provider-safe chunks, a bounded number per call, and answers with
    // wherever it got to, so a paused poller catches up over a few polls
    // instead of losing the gap. A cursor past the head (a fallback node
    // lagging the one that answered last time) is pulled back to latest+1:
    // rescanning a block is harmless, skipping one is not.
    const chunkSpan = DIRECT_SYNC_LOOKBACK_BLOCKS[chainId] ?? DIRECT_SCAN_CHUNK_BLOCKS;
    let cursor = requestedFromBlock ?? (latestBlock > 3n ? latestBlock - 3n : 0n);
    if (cursor > latestBlock + 1n) cursor = latestBlock + 1n;
    const deadline = Date.now() + DIRECT_SCAN_TIME_BUDGET_MS;
    let mismatch: DirectTransferCandidate | null = null;
    for (let chunk = 0; chunk < DIRECT_SCAN_MAX_CHUNKS && cursor <= latestBlock; chunk += 1) {
      const toBlock = cursor + chunkSpan < latestBlock ? cursor + chunkSpan : latestBlock;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      let found: Awaited<ReturnType<typeof findDirectTransfer>>;
      try {
        found = await withDirectScanTimeout(findDirectTransfer({ toAddress, coin, amount, chainId, fromBlock: cursor, toBlock }), remaining);
      } catch {
        res.json({ status: "pending", fromBlock: cursor.toString(), latestBlock: latestBlock.toString(), warning: "Scanner RPC is temporarily slow" });
        return;
      }
      for (const candidate of found?.candidates ?? []) {
        if (!await transferBelongsToThisQr(candidate.txHash)) continue;
        // Record what actually moved, as the sweep does. The watch row still
        // matches within ±1 base unit and keeps its own payAmount when it is
        // the row confirmed.
        const recorded = await recordDirectTransferPayment({
          txHash: candidate.txHash,
          fromAddress: candidate.fromAddress,
          toAddress,
          coin,
          amount: candidate.actualAmount,
          chainId,
          paymentUrl: storedPaymentUrl,
          verified: true,
        });
        res.json({
          status: "confirmed",
          fromBlock: cursor.toString(),
          latestBlock: latestBlock.toString(),
          txHash: recorded.transaction.txHash,
          transaction: transactionToJson(recorded.transaction),
          created: recorded.created,
        });
        return;
      }
      // An exact match anywhere in the walk beats a wrong-amount transfer, so
      // the first mismatch that is ours is kept and reported only at the end.
      for (const candidate of found?.mismatches ?? []) {
        if (mismatch) break;
        if (await transferBelongsToThisQr(candidate.txHash)) mismatch = candidate;
      }
      cursor = toBlock + 1n;
    }

    if (mismatch) {
      const actualAmount = mismatch.actualAmount || "0";
      const recorded = await recordDirectTransferFailure({
        txHash: mismatch.txHash,
        fromAddress: mismatch.fromAddress,
        toAddress,
        coin,
        expectedAmount: amount,
        actualAmount,
        chainId,
        paymentUrl: storedPaymentUrl,
        reason: `Expected ${amount} ${coin}, received ${actualAmount} ${coin}.`,
      });
      res.json({
        status: "amount_mismatch",
        fromBlock: cursor.toString(),
        latestBlock: latestBlock.toString(),
        expectedAmount: amount,
        actualAmount,
        coin,
        message: `Received ${actualAmount} ${coin}, but this QR requires ${amount} ${coin}.`,
        transaction: transactionToJson(recorded.transaction),
        created: recorded.created,
      });
      return;
    }

    res.json({ status: "pending", fromBlock: cursor.toString(), latestBlock: latestBlock.toString() });
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

// Registering a Sepolia client is what makes every chain-scanning path accept
// chainId 11155111. Gating it here turns the existing "Unsupported chain"
// guards into the single enforcement point for accidental testnet work.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CHAIN_CLIENTS: Record<number, any> = {
  1:        createPublicClient({ chain: mainnet,  transport: rpcHttpTransport(1) }),
  ...(ENV.seraEnableTestnet
    ? { 11155111: createPublicClient({ chain: sepolia, transport: rpcHttpTransport(11155111) }) }
    : {}),
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
      .filter((tx) => Number(tx.chainId ?? SERA_MAINNET_CHAIN_ID) === chainId)
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

/**
 * Postgres hands a numeric(36,18) column back as "2000.000000000000000000",
 * and toRawTokenAmount refuses a fraction longer than the token's decimals —
 * so no stored amount ever converted and the pending-row match below silently
 * never fired against a real database. Trailing zeros carry no value; drop
 * them before converting what the database stored. Integers are left alone:
 * "2000" must not become "2".
 */
function rawAmountFromStored(amount: unknown, decimals: number): bigint {
  const text = String(amount ?? "").trim();
  const trimmed = text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
  return BigInt(toRawTokenAmount(trimmed, decimals));
}

/** Column cap for the payment URL kept in a direct-QR row's notes. */
const DIRECT_QR_PAYMENT_URL_MAX = 1200;

/** The payment URL in the form the notes column keeps it, or null when absent. */
function storedDirectQrPaymentUrl(paymentUrl: string | null | undefined): string | null {
  return typeof paymentUrl === "string" && paymentUrl ? paymentUrl.slice(0, DIRECT_QR_PAYMENT_URL_MAX) : null;
}

/**
 * Lenient view of a direct-QR row's notes: rows predate `watch`, the sweep's
 * rows carry no URL, and a merchant may have overwritten notes with free text.
 */
function directQrNotes(tx: Pick<Transaction, "notes">): { type: string | null; paymentUrl: string | null; watch: boolean } {
  if (!tx.notes) return { type: null, paymentUrl: null, watch: false };
  try {
    const parsed = JSON.parse(tx.notes) as { type?: unknown; paymentUrl?: unknown; watch?: unknown };
    return {
      type: typeof parsed.type === "string" ? parsed.type : null,
      paymentUrl: typeof parsed.paymentUrl === "string" && parsed.paymentUrl ? parsed.paymentUrl : null,
      watch: parsed.watch === true,
    };
  } catch {
    return { type: null, paymentUrl: null, watch: false };
  }
}

/** A row the scan route created purely so the sweep watches a Scan & Pay QR. */
export function isDirectQrWatchTransaction(tx: Pick<Transaction, "notes">): boolean {
  const notes = directQrNotes(tx);
  return notes.type === "direct_wallet_qr" && notes.watch;
}

/**
 * A watch row no transfer has confirmed. It is bookkeeping for the sweep, not
 * a payment anyone began, so the dashboard's list and counts leave it out;
 * the moment a transfer confirms it, it carries that hash and shows like any
 * other payment.
 */
export function isUnpaidDirectQrWatch(tx: Pick<Transaction, "notes" | "txHash">): boolean {
  return !tx.txHash && isDirectQrWatchTransaction(tx);
}

/** Still pending, unverified and hashless — the shape getPendingTransactions sweeps. */
export function isLiveDirectQrWatch(tx: Pick<Transaction, "notes" | "txHash" | "status" | "verified">): boolean {
  return tx.status === "pending" && Number(tx.verified) === 0 && !tx.txHash && isDirectQrWatchTransaction(tx);
}

/**
 * Whether a transfer already on file may be reported as the payment of the QR
 * at `paymentUrl`, which began at `watchStartedAt` when its watch row is known.
 *
 * The row is ours when it names this link, or names no link at all — the
 * sweep records transfers it could not match to a pending row without one,
 * and a re-poll after the sweep got there first must still hear "confirmed".
 * Neither test tells two identically priced QRs apart, though: a link carries
 * no nonce unless an expiry is set, so the QR shown to the previous customer
 * had the very same URL. Time does tell them apart — a row that already
 * existed when this QR's watch began cannot be its payment.
 */
export function directTransferBelongsToQr(
  tx: Pick<Transaction, "notes" | "createdAt">,
  paymentUrl: string | null | undefined,
  watchStartedAt: Date | string | null | undefined,
): boolean {
  if (watchStartedAt) {
    const startedAt = new Date(watchStartedAt).getTime();
    const recordedAt = new Date(tx.createdAt).getTime();
    if (Number.isFinite(startedAt) && Number.isFinite(recordedAt) && recordedAt < startedAt) return false;
  }
  const recordedUrl = directQrNotes(tx).paymentUrl;
  if (!recordedUrl) return true;
  return recordedUrl === storedDirectQrPaymentUrl(paymentUrl);
}

/**
 * Newest watch row for a QR among `rows` (newest first, as
 * getMerchantTransactions returns them), whatever its status. The key is what
 * the QR fixes: receiver, pay coin, pay amount, chain and link.
 */
export function findDirectQrWatchRow(rows: Transaction[], key: {
  receiveAddress: string;
  coin: string;
  amount: string;
  chainId: number;
  decimals: number;
  paymentUrl: string | null;
}): Transaction | null {
  const expectedRaw = BigInt(toRawTokenAmount(key.amount, key.decimals));
  const storedUrl = storedDirectQrPaymentUrl(key.paymentUrl);
  return rows.find((tx) => {
    if (!isDirectQrWatchTransaction(tx)) return false;
    if (String(tx.toAddress || "").toLowerCase() !== key.receiveAddress.toLowerCase()) return false;
    if (String(tx.coin || "").toUpperCase() !== key.coin.toUpperCase()) return false;
    if (Number(tx.chainId ?? SERA_MAINNET_CHAIN_ID) !== key.chainId) return false;
    if (directQrNotes(tx).paymentUrl !== storedUrl) return false;
    try {
      return rawAmountFromStored(tx.amount, key.decimals) === expectedRaw;
    } catch {
      return false;
    }
  }) ?? null;
}

/**
 * Server-side watch for a Scan & Pay QR.
 *
 * A wallet-URI QR never touches the checkout page, so until now nothing on
 * the server knew it existed: the only thing looking for its payment was the
 * 5-second poll from the merchant's own QR screen. The moment the merchant
 * tapped Back, opened the dashboard, or the phone suspended the tab, a
 * transfer landing afterwards was never recorded, never toasted, never
 * webhooked. The sweep (sweepPendingMerchantDirectActivity) already finds
 * direct transfers for every merchant holding a pending unverified row — so
 * the first poll for a QR leaves exactly such a row behind: a pending
 * `direct_wallet_qr` transaction flagged `watch: true`, keyed by receiver,
 * coin, amount, chain and link. The sweep then confirms it through the
 * ordinary pending-match path, notifying the merchant as for any payment,
 * with no browser open at all.
 *
 * Returns the newest watch row for the key whatever its status: it also
 * anchors the scan route's "is this transfer ours?" test, because a QR of the
 * same price minted a minute ago carries the very same link. A new row is
 * inserted only when `create` is set and no live (pending, unverified,
 * hashless) row exists, so a poll retrying its first request, or a re-minted
 * identical QR whose customer has not paid yet, reuses the row rather than
 * stacking phantoms.
 */
async function resolveDirectQrWatch({
  merchant,
  receiveAddress,
  coin,
  amount,
  chainId,
  paymentUrl,
  decimals,
  create,
}: {
  merchant: Merchant;
  receiveAddress: string;
  coin: string;
  amount: string;
  chainId: number;
  paymentUrl: string | null;
  decimals: number;
  create: boolean;
}): Promise<Transaction | null> {
  const recent = await getMerchantTransactions(merchant.id, 100);
  const latest = findDirectQrWatchRow(recent, { receiveAddress, coin, amount, chainId, decimals, paymentUrl });
  if (!create || (latest && isLiveDirectQrWatch(latest))) return latest;

  const id = uuidv4();
  await createTransaction({
    id,
    merchantId: merchant.id,
    toAddress: receiveAddress,
    coin,
    amount,
    chainId,
    status: "pending",
    verified: 0,
    payCoin: coin,
    payAmount: amount,
    notes: JSON.stringify({ type: "direct_wallet_qr", paymentUrl: storedDirectQrPaymentUrl(paymentUrl), watch: true }),
  });
  return await getTransactionById(id) ?? null;
}

/**
 * Expires a stale watch row quietly. A watch row stands for a QR nobody paid,
 * not for a customer who walked away mid-payment, so unlike
 * cancelTransactionRecord this raises no merchant event and touches no order
 * or intent — a watch row has neither.
 */
async function expireDirectQrWatch(tx: Transaction) {
  if (tx.status !== "pending") return false;
  const reason = "QR watch expired after 5 minutes without payment.";
  await updateTransaction(tx.id, {
    status: "canceled",
    memo: tx.memo || reason.slice(0, 200),
    notes: notesWithCancellationReason(tx.notes, reason),
  });
  return true;
}

async function findMatchingPendingTransaction({
  merchantId,
  toAddress,
  coin,
  chainId,
  rawAmount,
  decimals,
  paymentUrl,
}: {
  merchantId: string;
  toAddress: string;
  coin: string;
  chainId: number;
  rawAmount: bigint;
  decimals: number;
  paymentUrl?: string | null;
}) {
  const recent = await getMerchantTransactions(merchantId, 100);
  const candidates = recent.filter((tx) => {
    if (tx.txHash) return false;
    if (tx.status !== "pending" && tx.status !== "confirming") return false;
    if (String(tx.toAddress || "").toLowerCase() !== toAddress.toLowerCase()) return false;
    if (String(tx.coin || "").toUpperCase() !== coin.toUpperCase()) return false;
    if (Number(tx.chainId ?? SERA_MAINNET_CHAIN_ID) !== chainId) return false;
    try {
      return rawAmountsNearlyEqual(rawAmountFromStored(tx.amount, decimals), rawAmount);
    } catch {
      return false;
    }
  });
  // Several pending rows can await the same amount at the same address: the
  // QR's own watch row and, a few minutes back, an identical QR's. When the
  // caller knows which link it is scanning for, that link's row is the one to
  // confirm; the sweep knows no link and takes the newest, as before.
  const storedUrl = storedDirectQrPaymentUrl(paymentUrl);
  if (storedUrl) {
    const own = candidates.find((tx) => directQrNotes(tx).paymentUrl === storedUrl);
    if (own) return own;
  }
  return candidates[0];
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
      paymentUrl,
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

type DirectTransferCandidate = {
  txHash: `0x${string}`;
  fromAddress: string | null;
  /** What actually moved on-chain, in token units. */
  actualAmount: string;
};

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

  // Every transfer in the window, in log order, split into the ones within
  // ±1 base unit of the QR amount and the rest. This used to stop at the
  // first exact match — but the scan route now skips a hash already on file
  // for a previous customer, so it needs the ones behind it too.
  const candidates: DirectTransferCandidate[] = [];
  const mismatches: DirectTransferCandidate[] = [];
  for (const log of logs) {
    const args = (log as any).args || {};
    const actualRaw = BigInt(String(args.value ?? 0));
    const txHash = String(log.transactionHash || "");
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) continue;
    const entry: DirectTransferCandidate = {
      txHash: txHash as `0x${string}`,
      fromAddress: typeof args.from === "string" ? args.from.toLowerCase() : null,
      actualAmount: fromRawTokenAmount(actualRaw, decimals),
    };
    const diff = actualRaw > expectedRaw ? actualRaw - expectedRaw : expectedRaw - actualRaw;
    (diff > 1n ? mismatches : candidates).push(entry);
  }

  return { candidates, mismatches };
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

  const chainId = tx.chainId ?? SERA_MAINNET_CHAIN_ID;
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
  // Rows written before the create-side precision guard can carry more
  // decimals than the token itself (rate-derived 6dp figures on 2-decimal
  // tokens like IDRT). toRawTokenAmount throws on those, and a throw here
  // re-armed itself through every status poll. Round to the nearest
  // representable unit instead — that is what the payer's wallet actually
  // sent — and let the ±1-unit tolerance below absorb the direction. The
  // float path is only reachable for low-decimal tokens (fractions never
  // exceed 6 digits), so it stays far inside Number's exact-integer range.
  let expectedRaw: bigint;
  try {
    expectedRaw = BigInt(toRawTokenAmount(String(tx.amount), tokenDecimals));
  } catch {
    const scaled = Number(String(tx.amount).replace(/,/g, "")) * 10 ** tokenDecimals;
    if (!Number.isFinite(scaled) || scaled <= 0) {
      await failTransactionRecord(tx, `Stored amount ${tx.amount} cannot be expressed in ${tx.coin}'s ${tokenDecimals}-decimal precision.`);
      return;
    }
    expectedRaw = BigInt(Math.round(scaled));
  }
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

/**
 * Exponential backoff per transaction. Status polls arrive every 5 seconds
 * from every open checkout, and each used to re-arm verification immediately —
 * so one fast-throwing row printed the same failure line for hours (the
 * "[verify] failed" wall). Retrying is still right; retrying at poll frequency
 * never was.
 */
const transactionVerificationFailures = new Map<string, { count: number; nextAttemptAt: number }>();

function scheduleTransactionVerification(txId: string, txHash: `0x${string}`) {
  if (transactionVerificationInFlight.has(txId)) return;
  const failureState = transactionVerificationFailures.get(txId);
  if (failureState && Date.now() < failureState.nextAttemptAt) return;
  transactionVerificationInFlight.add(txId);
  void verifyTransactionAsync(txId, txHash)
    .then(() => transactionVerificationFailures.delete(txId))
    .catch((error) => {
      const count = (transactionVerificationFailures.get(txId)?.count ?? 0) + 1;
      const delayMs = Math.min(30_000 * 2 ** (count - 1), 10 * 60_000);
      transactionVerificationFailures.set(txId, { count, nextAttemptAt: Date.now() + delayMs });
      // The global logger redacts messages by design, which left these lines
      // reading "[verify] failed { type: 'Error' }" — undiagnosable. Whether a
      // merchant reaches paid-state hangs on this path, so name the cause;
      // truncated and without a stack, since driver errors can carry hosts.
      const message = error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160);
      console.error("[verify] failed", { txId, attempt: count, retryInMs: delayMs, message });
    })
    .finally(() => transactionVerificationInFlight.delete(txId));
}

async function sendWebhook(
  url: string,
  secret: string | null | undefined,
  payload: object,
  logCtx?: { merchantId: string; txId: string; txHash?: string | null }
) {
  // SSRF: resolve the host and refuse any private/internal address before the
  // outbound POST. A stored webhook URL is fetched unattended, so this is the
  // last line of defence if a merchant configured an internal target.
  try {
    await assertPublicHttpUrl(url);
  } catch {
    return; // silently skip delivery to a non-public address
  }
  const body = JSON.stringify(payload);
  const sig = secret ? "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex") : undefined;
  const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": "SeraPay-Webhook/1.0" };
  if (sig) headers["X-SeraPay-Signature"] = sig;
  let statusCode: number | undefined;
  let responseBody: string | undefined;
  let errorMsg: string | undefined;
  let success = false;
  try {
    // See the note on the test endpoint: without redirect:"manual" the SSRF
    // guard is decorative, because fetch would follow a 3xx to an address the
    // guard never saw.
    const resp = await fetch(url, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(10000) });
    if (resp.status >= 300 && resp.status < 400) {
      throw new Error("Webhook endpoint redirected; redirects are not allowed");
    }
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
const rateCache = new Map<string, { rate: number; ts: number; asOf?: number }>();
const CACHE_TTL_MS = 60_000; // 1 minute

/**
 * Negative cache + rate-limit backoff for Sera pricing.
 *
 * Successful rates are cached above, but failures were not, so every pair Sera
 * cannot price re-hit their API on every keystroke and currency switch. With
 * most cross-currency pairs currently answering 503, a merchant browsing the
 * currency list generated a burst large enough to earn a 429 — at which point
 * even the working pairs started failing. The outage was ours to amplify.
 *
 * So: remember which pairs just failed and answer from memory for a short
 * while, and when Sera does rate-limit us, stop calling entirely until the
 * window passes rather than digging deeper.
 */
const rateFailureCache = new Map<string, { error: unknown; ts: number }>();
const RATE_FAILURE_TTL_MS = 30_000;
let seraRateLimitedUntil = 0;

export class SeraRateLimitedError extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super("Too many pricing requests right now. Try again in a moment.");
    this.name = "SeraRateLimitedError";
    this.retryAfterMs = retryAfterMs;
  }
}

const SERA_RATE_LIMIT_BACKOFF_MS = 20_000;

function noteRateFailure(cacheKey: string, error: unknown) {
  if (error instanceof SeraApiError && error.status === 429) {
    // Global, not per-pair: the limit is on our client, not on the currency.
    seraRateLimitedUntil = Date.now() + SERA_RATE_LIMIT_BACKOFF_MS;
    return;
  }
  rateFailureCache.set(cacheKey, { error, ts: Date.now() });
}

function replayRateFailure(cacheKey: string) {
  if (Date.now() < seraRateLimitedUntil) {
    throw new SeraRateLimitedError(seraRateLimitedUntil - Date.now());
  }
  const failed = rateFailureCache.get(cacheKey);
  if (failed && Date.now() - failed.ts < RATE_FAILURE_TTL_MS) throw failed.error;
  if (failed) rateFailureCache.delete(cacheKey);
}

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

export async function fetchSeraRate(from: string, to: string): Promise<number> {
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

const SERA_NO_LIQUIDITY_RATE_MESSAGE =
  "Currently there's no liquidity on this exchange in Sera.cx. Please try another option.";

/**
 * Raised when no Sera price source could produce a rate. `errorCode`
 * distinguishes a Sera-wide FX outage from a pair with no market maker, so the
 * merchant is told which one it is instead of a generic failure.
 */
class SeraRateUnavailableError extends Error {
  errorCode: "sera_fx_unavailable" | "no_liquidity";
  constructor(message: string, errorCode: "sera_fx_unavailable" | "no_liquidity") {
    super(message);
    this.name = "SeraRateUnavailableError";
    this.errorCode = errorCode;
  }
}

/**
 * Wrapper so every caller — the /rates route, the swap-quote pre-flight, the
 * checkout refresh — shares one negative cache and one backoff window. Recording
 * the failure only at the route would leave the other paths free to keep
 * hammering Sera and re-trip the limit for everyone.
 */
/**
 * `source` says WHERE a rate came from, and `asOf` how old the underlying
 * quote is. Both matter: only "sera-fx-rate" is a true reference FX rate, and
 * Sera returns HTTP 200 on that feed even when its provider data has coverage
 * gaps, so the timestamp is the only staleness signal there is.
 */
async function fetchSeraRestFxRate(from: string, to: string, chainId?: number): Promise<{ rate: number; source: string; asOf?: number }> {
  const scope = chainId === SERA_TESTNET_CHAIN_ID ? "test" : "live";
  const failureKey = `sera-quote:${scope}:${from}:${to}`;
  try {
    return await fetchSeraRestFxRateUncached(from, to, chainId);
  } catch (error) {
    // A bad symbol or unsupported chain is the caller's mistake, not a Sera
    // outage — caching it would hide a fix the moment they correct the input.
    const isCallerError = typeof (error as Error)?.message === "string"
      && ((error as Error).message.startsWith("Unsupported Sera token:")
        || (error as Error).message.startsWith("Sera payments are not supported on chain"));
    if (!isCallerError && !(error instanceof SeraRateLimitedError)) noteRateFailure(failureKey, error);
    throw error;
  }
}

async function fetchSeraRestFxRateUncached(from: string, to: string, chainId?: number): Promise<{ rate: number; source: string; asOf?: number }> {
  if (chainId !== undefined && chainId !== SERA_MAINNET_CHAIN_ID && chainId !== SERA_TESTNET_CHAIN_ID) {
    throw new Error(`Sera payments are not supported on chain ${chainId}`);
  }
  // `?chainId=11155111` on the public /rates route must not price against the
  // testnet deployment unless this server explicitly enables testnet.
  if (chainId === SERA_TESTNET_CHAIN_ID && !ENV.seraEnableTestnet) {
    throw new Error(`Sera payments are not supported on chain ${chainId}`);
  }
  const cacheScope = chainId === SERA_TESTNET_CHAIN_ID ? "test" : "live";
  const cacheKey = `sera-quote:${cacheScope}:${from}:${to}`;
  const cached = rateCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return { rate: cached.rate, source: "cache", asOf: cached.asOf };
  }
  // Answer a recently-failed pair from memory rather than asking Sera again.
  replayRateFailure(cacheKey);

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
  // Tracked separately from lastRateError: the Goldsky and quote fallbacks
  // below overwrite lastRateError, which would otherwise mask a Sera /fx/rate
  // outage and mislabel it as "no liquidity".
  let fxFeedError: unknown = null;
  // Sera documents these as alphabetic currency codes, not strictly three
  // letters. The old {3} test SILENTLY skipped the reference feed for anything
  // else and dropped straight to the fallbacks, with no error to explain why.
  if (/^[A-Z]+$/.test(fromCurrency) && /^[A-Z]+$/.test(toCurrency)) {
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
      // Sera documents as_of as "unix timestamp of newest provider quote in
      // cluster" and returns 200 even with coverage gaps, so this is the only
      // way a caller can tell a fresh price from an old one.
      const asOf = Number((fx as { as_of?: unknown }).as_of);
      const freshness = Number.isFinite(asOf) && asOf > 0 ? asOf : undefined;
      rateCache.set(cacheKey, { rate, ts: Date.now(), asOf: freshness });
      return { rate, source: "sera-fx-rate", asOf: freshness };
    } catch (error) {
      lastRateError = error;
      fxFeedError = error;
    }
  }

  /*
    Sera's reference FX feed, as used by Sera's own swap UI.

    GET /fx/rate on api.sera.cx has been answering 503 for every real pair,
    which left cross-currency payments unpriceable — while sera.cx itself kept
    showing live rates for those same pairs. This is where those come from:
    ECB reference rates (with a commercial feed filling the gaps), covering all
    22 registry currencies.

    It sits above the swap-quote fallback deliberately. A quote only reports
    minOutputAmount, so a rate derived from one carries that route's slippage
    and needs liquidity to exist at all; this is a true mid-market FX rate and
    needs neither. It stays BELOW /fx/rate so the documented feed wins whenever
    Sera restores it.
  */
  if (/^[A-Z]+$/.test(fromCurrency) && /^[A-Z]+$/.test(toCurrency)) {
    try {
      const referenceUrl = `${ENV.seraAppBaseUrl.replace(/\/+$/, "")}/api/rate?from=${encodeURIComponent(fromCurrency)}&to=${encodeURIComponent(toCurrency)}`;
      const response = await fetch(referenceUrl, { signal: AbortSignal.timeout(8000) });
      if (response.ok) {
        const payload = await response.json() as { found?: boolean; rate?: unknown; timestamp?: unknown; source?: unknown };
        const rate = Number(payload?.rate);
        if (payload?.found === true && Number.isFinite(rate) && rate > 0) {
          const asOfSeconds = Number(payload.timestamp);
          const freshness = Number.isFinite(asOfSeconds) && asOfSeconds > 0 ? asOfSeconds : undefined;
          rateCache.set(cacheKey, { rate, ts: Date.now(), asOf: freshness });
          return { rate, source: `sera-fx-reference${payload.source ? `:${payload.source}` : ""}`, asOf: freshness };
        }
      }
    } catch (error) {
      // Advisory tier: never let it mask the primary feed's own failure.
      if (!fxFeedError) fxFeedError = error;
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

  /*
    Quote BOTH orientations and take the geometric mean.

    A Sera quote reports only `minOutputAmount` - the slippage-protected floor,
    not a mid-market price - so any single quote is off by that buffer, and which
    way it errs depends on which direction was quoted. Quoting to->from and
    inverting overstates the rate by the buffer; quoting from->to understates it
    by the same buffer. sqrt(a * b) lands back on mid.

    Measured on XSGD/MYRT: the two orientations give 3.19180864 and 3.16349578,
    whose product is 0.99113 of unity - a ~0.44% buffer per hop - and whose
    geometric mean, 3.177606, is the mid-market rate. Taking one orientation
    alone would misprice every payment by that much, in a direction decided by
    nothing more meaningful than which side happened to have liquidity.

    This only runs when GET /fx/rate is unavailable; that feed already reports a
    true reference rate and is preferred above.
  */
  const [inverseResult, directResult] = await Promise.allSettled([
    quoteRate(
      toToken,
      fromToken,
      (inputAmountInTo, outputAmountInFrom) => inputAmountInTo / outputAmountInFrom,
    ),
    quoteRate(
      fromToken,
      toToken,
      (inputAmountInFrom, outputAmountInTo) => outputAmountInTo / inputAmountInFrom,
    ),
  ]);

  const inverseRate = inverseResult.status === "fulfilled" ? inverseResult.value : null;
  const directRate = directResult.status === "fulfilled" ? directResult.value : null;

  if (inverseRate && directRate) {
    const rate = Math.sqrt(inverseRate * directRate);
    if (Number.isFinite(rate) && rate > 0) {
      rateCache.set(cacheKey, { rate, ts: Date.now() });
      return { rate, source: "sera-quote-mid" };
    }
  }

  // Only one side is quotable, so the buffer cannot be cancelled. A rate that is
  // ~0.4% off still beats refusing the payment outright, but it is labelled
  // differently so the difference is visible to anyone reading the response.
  const singleSidedRate = inverseRate ?? directRate;
  if (singleSidedRate) {
    rateCache.set(cacheKey, { rate: singleSidedRate, ts: Date.now() });
    return { rate: singleSidedRate, source: inverseRate ? "sera-quote-inverse" : "sera-quote-direct" };
  }

  lastQuoteError = inverseResult.status === "rejected"
    ? inverseResult.reason
    : (directResult as PromiseRejectedResult).reason;

  // Every source failed. Say WHICH one and why rather than emitting a generic
  // "unable to fetch rate" — the two causes need completely different actions.
  // Sera's reference feed (GET /fx/rate) returning 503 is an outage on their
  // side and affects every pair; no_liquidity is specific to this pair and
  // means no market maker is quoting it.
  const fxFeedDown = fxFeedError instanceof SeraApiError && fxFeedError.status >= 500;
  const noLiquidity = lastQuoteError instanceof SeraApiError
    && (lastQuoteError.errorCode === "no_liquidity" || lastQuoteError.errorCode === "NO_LIQUIDITY");

  if (fxFeedDown) {
    throw new SeraRateUnavailableError(
      `Sera's FX rate service is currently unavailable, so ${from}/${to} cannot be priced. Same-coin payments are unaffected.`,
      "sera_fx_unavailable",
    );
  }
  if (noLiquidity) {
    throw new SeraRateUnavailableError(
      `${SERA_NO_LIQUIDITY_RATE_MESSAGE} (pair: ${from}/${to})`,
      "no_liquidity",
    );
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
    const { rate, source, asOf } = await fetchSeraRestFxRate(from, to, chainId);
    // Reality check for the pair tracker: this pair just priced successfully.
    notePairResult(from, to, true);
    /*
    // Apply SeraPay's 0.5% silent spread — customer pays slightly more than the raw Sera rate.
    // The merchant receives exactly what they requested; SeraPay keeps the difference.
    const SERA_MARKUP = 1.005;
    const rate = rawRate * SERA_MARKUP;
    */
    // Deliberately shorter than the 60s in-process TTL above: a shared cache
    // hands the same response to every merchant, so it errs on the fresh side.
    res.setHeader("Cache-Control", "public, max-age=10, stale-while-revalidate=30");
    // `source` distinguishes a true reference rate ("sera-fx-rate") from one
    // derived from a swap quote, which carries that route's slippage buffer.
    // `asOf` is present only for the reference feed, which is the only source
    // that publishes its own freshness.
    res.json({ from, to, rate, source, ...(asOf ? { asOf } : {}) });
  } catch (e: any) {
    if (typeof e?.message === "string" && e.message.startsWith("Unsupported Sera token:")) {
      res.status(400).json({ error: e.message });
      return;
    }
    if (typeof e?.message === "string" && e.message.startsWith("Sera payments are not supported on chain")) {
      res.status(400).json({ error: e.message });
      return;
    }
    if (e instanceof SeraRateLimitedError) {
      // Being throttled is not the same as Sera being down: it clears on its
      // own in seconds, and calling it an outage sends merchants chasing a
      // problem that does not exist.
      res.setHeader("Retry-After", String(Math.ceil(e.retryAfterMs / 1000)));
      res.status(429).json({ error: e.message, errorCode: "sera_rate_limited" });
      return;
    }
    if (e instanceof SeraRateUnavailableError && e.errorCode === "no_liquidity") {
      // Only a liquidity verdict is about the PAIR. An FX outage is global and
      // must never mark good pairs dead.
      notePairResult(String(req.query.from ?? ""), String(req.query.to ?? ""), false);
    }
    if (e instanceof SeraRateUnavailableError) {
      // 503 for a Sera-side outage so callers and uptime checks can tell it
      // apart from a pair-specific 409.
      res.status(e.errorCode === "sera_fx_unavailable" ? 503 : 409)
        .json({ error: e.message, errorCode: e.errorCode });
      return;
    }
    if (e instanceof SeraApiError && (e.errorCode === "no_liquidity" || e.errorCode === "NO_LIQUIDITY")) {
      res.status(409).json({
        error: SERA_NO_LIQUIDITY_RATE_MESSAGE,
        errorCode: "no_liquidity",
      });
      return;
    }
    logSeraOperationFailure("rates", e);
    res.status(502).json({ error: "Failed to fetch exchange rate from Sera" });
  }
});
