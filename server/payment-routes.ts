/**
 * SeraPay Payment API Routes
 * Registered under /api/ in server/_core/index.ts
 */
import { Router, Request, Response, type NextFunction } from "express";
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
  createDirectTransactionWithReservation,
  getTransactionById,
  getActiveSeraSwapTransactionByCheckoutAttemptKey,
  getTransactionByHash,
  updateTransaction,
  claimDirectTransactionNotification,
  claimDirectTransactionCancellation,
  claimDirectTransactionConfirmation,
  claimDirectTransactionFailure,
  releaseTentativeDirectTransactionHash,
  updateSeraSwapLifecycle,
  refreshSeraSwapQuote,
  claimSeraSwapSubmission,
  claimSeraSwapCancellation,
  reopenSeraSwapAfterStaleRejection,
  claimSeraSwapSettlementConfirmation,
  markSeraIntentMatchedEvidence,
  claimSeraSwapProvisionalSettlement,
  clearSeraSwapProvisionalSettlement,
  claimSeraSwapTerminalFailure,
  claimSeraSwapPostNetworkUpdate,
  prepareSeraSwapOutcomeSync,
  completeSeraSwapOutcomeSync,
  getMerchantTransactions,
  getPendingTransactions,
  getPendingSeraSwapTransactions,
  getRecentPendingSeraSwapTransactions,
  getUnsyncedSeraSwapOutcomes,
  deferSeraSwapOutcomeSync,
  getSeraVaultAddressesForChain,
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
  updateDirectLinkedPaymentStatus,
} from "./db";
import { screenWalletAddress } from "./compliance";
import { ENV } from "./_core/env";
import { PrivyAuthError, assertPrivyWalletOwnership, getPrivyWalletSummary, sendPrivyAuthError, verifyPrivyRequest, type PrivyIdentity, type PrivyWalletOwnership } from "./_core/privy";
import { isR2StorageConfigured, storagePut, storageRead } from "./storage";
import { decryptSecret } from "./secret-vault";
import { notePairResult } from "./pair-liquidity";
import { hashSeraIntentStruct, SERA_INTENT_TYPES, type SeraIntentMessage } from "./sera-intent";
import { PaymentBindingError, assertAmountMatchesReference, assertMenuOrderBindable, assertPaymentIntentBindable, sameMicroAmount } from "./payment-binding";
import { CheckoutPayloadError, isCheckoutSigningReady, signCheckoutPayload, verifyCheckoutPayload } from "./checkout-payload";
import { isDirectTransferCandidate, isSeraSwapTransactionRecord } from "./payment-transaction-kind";
import { selectDirectTransferEvidence, type DecodedErc20TransferEvidence } from "./direct-transfer-evidence";
import {
  SeraQuoteValidationError,
  serializeSeraQuoteError,
  solveSeraFixedOutputQuote,
  toSeraPreflightSummary,
  validateSeraDeploymentConfig,
  type SeraFixedOutputPolicy,
  type SeraSwapQuoteRequest,
} from "./sera-swap-quote";
import { SeraSettlementValidationError, validateSeraSettledOrder } from "./sera-settlement";
import { corroborateSeraIntentPayout } from "./sera-onchain-settlement";
import { validateSeraSubmissionAnchor } from "./sera-submission-anchor";
import { deriveSeraCheckoutAttemptKey } from "./sera-checkout-attempt";
import {
  classifySeraSettlementObservationStage,
  isCanonicalSuccessfulSeraSettlement,
  parseSeraProvisionalConfirmations,
  seraProvisionalSettlementScanHead,
} from "./sera-confirmation-policy";
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
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Testnet is reachable only when SERA_ENABLE_TESTNET=true on the server. */
function isTestnetChainEnabled(chainId?: number | null): boolean {
  return chainId === SERA_TESTNET_CHAIN_ID && ENV.seraEnableTestnet;
}

export function getSeraApiBaseUrlForChain(chainId?: number | null): string {
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
    quoteUuid: tx.quoteUuid ?? (typeof meta?.quoteUuid === "string" ? meta.quoteUuid : null),
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

type SeraSystemTimeResponse = {
  timestamp?: number;
};

// Deterministic throwaway identity used only before a payer is known. No
// private key is held or needed: preflight quotes are always discarded.
const DEFAULT_SERA_PREFLIGHT_PROBE_ADDRESS = "0x7a49ae7c534d3907fb78d96ba0f9863c1b12e51d";

function getSeraPreflightProbeAddress(): `0x${string}` {
  const address = (ENV.seraPreflightProbeAddress || DEFAULT_SERA_PREFLIGHT_PROBE_ADDRESS).trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address) || /^0x0{40}$/.test(address)) {
    throw new SeraQuoteValidationError(
      "invalid_config",
      "SERA_PREFLIGHT_PROBE_ADDRESS must be a non-zero EVM address",
      { field: "SERA_PREFLIGHT_PROBE_ADDRESS" },
    );
  }
  return address as `0x${string}`;
}

function getSeraFixedOutputPolicy(): SeraFixedOutputPolicy | undefined {
  const policy: SeraFixedOutputPolicy = {};
  const maxGasCostUsd = ENV.seraMaxGasCostUsd.trim();
  if (maxGasCostUsd) {
    if (!/^\d+(?:\.\d+)?$/.test(maxGasCostUsd)) {
      throw new SeraQuoteValidationError(
        "invalid_config",
        "SERA_MAX_GAS_COST_USD must be a non-negative decimal",
        { field: "SERA_MAX_GAS_COST_USD" },
      );
    }
    policy.maxGasCostUsd = maxGasCostUsd;
  }

  const maxInputDeviation = ENV.seraMaxQuoteInputDeviationBps.trim();
  if (maxInputDeviation) {
    const bps = Number(maxInputDeviation);
    if (!/^\d+$/.test(maxInputDeviation) || !Number.isSafeInteger(bps) || bps > 1_000_000) {
      throw new SeraQuoteValidationError(
        "invalid_config",
        "SERA_MAX_QUOTE_INPUT_DEVIATION_BPS must be an integer from 0 to 1000000",
        { field: "SERA_MAX_QUOTE_INPUT_DEVIATION_BPS" },
      );
    }
    policy.maxInputIncreaseBps = bps;
  }
  return Object.keys(policy).length > 0 ? policy : undefined;
}

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

const SERA_DEPLOYMENT_CACHE_TTL_MS = 5 * 60 * 1000;
const seraDeploymentCache = new Map<number, {
  deployment: ReturnType<typeof validateSeraDeploymentConfig>;
  expiresAt: number;
}>();
const seraDeploymentInFlight = new Map<number, Promise<ReturnType<typeof validateSeraDeploymentConfig>>>();

/**
 * Generic ERC-20 scanners must know the live Sera Vault address. Otherwise a
 * Vault payout can race swap reconciliation and be recorded as a second,
 * unrelated direct payment that owns the settlement hash.
 */
async function getSeraDeploymentForChain(chainId: number, merchantId?: string | null) {
  const cached = seraDeploymentCache.get(chainId);
  if (cached && cached.expiresAt > Date.now()) return cached.deployment;
  const existing = seraDeploymentInFlight.get(chainId);
  if (existing) return existing;
  const request = callSeraApi<unknown>({
      baseUrl: getSeraApiBaseUrlForChain(chainId),
      path: "/config",
      authMode: "none",
      merchantId,
    })
    .then((rawConfig) => {
      const deployment = validateSeraDeploymentConfig(rawConfig, chainId);
      seraDeploymentCache.set(chainId, { deployment, expiresAt: Date.now() + SERA_DEPLOYMENT_CACHE_TTL_MS });
      return deployment;
    })
    .finally(() => {
      if (seraDeploymentInFlight.get(chainId) === request) seraDeploymentInFlight.delete(chainId);
    });
  seraDeploymentInFlight.set(chainId, request);
  return request;
}

class SeraVaultPayoutExcludedError extends Error {
  constructor() {
    super("Sera Vault payouts are reserved for swap settlement reconciliation");
    this.name = "SeraVaultPayoutExcludedError";
  }
}

async function getSeraVaultExclusionSet(chainId: number, merchantId?: string | null): Promise<ReadonlySet<string>> {
  // The live config covers a deployment before its first quote. Durable
  // quote-time addresses cover both sides of a rotation (including after a
  // process restart), so a payout from any historical Sera Vault can never be
  // claimed by the generic direct-transfer path.
  const [deployment, historicalVaults] = await Promise.all([
    getSeraDeploymentForChain(chainId, merchantId),
    getSeraVaultAddressesForChain(chainId),
  ]);
  return new Set([
    deployment.vaultAddress.toLowerCase(),
    ...historicalVaults.map((address) => address.toLowerCase()),
  ]);
}

async function assertDirectTransferSender(fromAddress: string | null | undefined, chainId: number) {
  // A standard ERC-20 Transfer always exposes `from`. Fail closed if a
  // non-standard log does not, rather than letting it bypass the Vault guard.
  if (!fromAddress || !/^0x[0-9a-fA-F]{40}$/.test(fromAddress)) {
    throw new Error("Direct transfer sender is unavailable");
  }
  const excludedVaults = await getSeraVaultExclusionSet(chainId);
  if (excludedVaults.has(fromAddress.toLowerCase())) {
    throw new SeraVaultPayoutExcludedError();
  }
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

export async function requireApiKey(req: Request, res: Response, next: NextFunction) {
  try {
    const apiKey = req.get("X-Api-Key");
    if (!apiKey) { res.status(401).json({ error: "Missing X-Api-Key header" }); return; }
    if (typeof apiKey !== "string") { res.status(401).json({ error: "Invalid API key" }); return; }
    const merchant = await getMerchantByApiKey(apiKey);
    if (!merchant) { res.status(401).json({ error: "Invalid API key" }); return; }
    (req as any).merchant = merchant;
    res.locals.merchant = merchant;
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
    // Sera notes contain the durable quote, Intent, deployment, and linked
    // order references used for recovery. Keep merchant annotations in `memo`;
    // replacing the internal JSON could make a submitted payment impossible
    // to reconcile after a restart.
    if (isSeraSwapTransaction(tx) && notes !== undefined && notes !== tx.notes) {
      res.status(409).json({
        error: "Sera swap recovery metadata cannot be edited. Use memo for merchant notes.",
      });
      return;
    }
    const patch: { notes?: string | null; memo?: string | null } = {};
    if (!isSeraSwapTransaction(tx) && notes !== undefined) patch.notes = notes;
    if (memo !== undefined) patch.memo = memo;
    if (Object.keys(patch).length > 0) await updateTransaction(id, patch);
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
    const canceled = await cancelTransactionRecord(tx, "Canceled by merchant.", "transaction_canceled");
    if (!canceled) {
      res.status(409).json({ error: "A submitted Sera swap cannot be canceled; settlement reconciliation is still in progress." });
      return;
    }
    res.json({ ok: true, status: "canceled" });
  } catch (e) { logSeraOperationFailure("payment-route", e); res.status(500).json({ error: "Internal server error" }); }
});

// ─── Payment endpoints ────────────────────────────────────────────────────────

export function toRawTokenAmount(amount: string, decimals: number): string {
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

export async function resolveSeraSwapToken(baseUrl: string, symbol: string): Promise<SeraToken> {
  try {
    return await resolveSeraTokenBySymbol(baseUrl, symbol);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unsupported Sera token:")) {
      throw new SeraQuoteValidationError(
        "unsupported_token",
        `${symbol.toUpperCase()} is not available in Sera's token registry`,
        { field: "coin", detail: { symbol: symbol.toUpperCase() } },
      );
    }
    throw error;
  }
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
  // Once a single-use quote may have reached Sera, cancellation is only a UI
  // label and cannot stop its atomic on-chain settlement. Keep reconciling it.
  if (isSeraSwapTransaction(tx) && tx.submitState && tx.submitState !== "quote_ready") return false;
  if (isSeraSwapTransaction(tx)) {
    if (!tx.quoteUuid || !tx.intentHash || tx.submitState !== "quote_ready") return false;
    const cancellation = await claimSeraSwapCancellation({
      transactionId: tx.id,
      quoteUuid: tx.quoteUuid,
      intentHash: tx.intentHash,
      memo: tx.memo || reason.slice(0, 200),
      notes: notesWithCancellationReason(tx.notes, reason),
    });
    if (cancellation.outcome !== "claimed") return false;
    tx = cancellation.transaction;
  } else {
    const cancellation = await claimDirectTransactionCancellation({
      transactionId: tx.id,
      memo: tx.memo || reason.slice(0, 200),
      notes: notesWithCancellationReason(tx.notes, reason),
    });
    if (cancellation.outcome !== "claimed") return false;
    tx = cancellation.transaction;
  }
  // Both Sera and direct branches atomically changed any still-owned linked
  // resource before returning `claimed`; only that winner emits effects.
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
  if (isSeraSwapTransaction(tx) || tx.status !== "confirming" || !tx.txHash) return false;
  const failureNotes = notesWithFailureReason(tx.notes, reason);
  const claim = await claimDirectTransactionFailure({
    transactionId: tx.id,
    txHash: tx.txHash,
    memo: tx.memo || reason.slice(0, 200),
    notes: failureNotes,
  });
  if (claim.outcome !== "claimed") return false;
  await emitTransactionFailureSideEffects(claim.transaction, reason);
  return true;
}

async function releaseRejectedDirectSubmission(
  tx: Transaction,
  txHash: `0x${string}`,
  reason: string,
  errorCode: string,
) {
  const release = await releaseTentativeDirectTransactionHash({
    transactionId: tx.id,
    txHash,
  });
  if (release.outcome !== "released") return false;
  notifySseClients(tx.id, { status: "pending", errorCode, reason });
  return true;
}

/**
 * Emits the linked-order and realtime effects for a failure whose state change
 * has already been won. Terminal Sera failure uses a database CAS, so keeping
 * these effects separate prevents two reconcilers from announcing the same
 * failure or racing a successful on-chain settlement.
 */
async function emitTransactionFailureSideEffects(tx: Transaction, reason: string) {
  const meta = transactionNotesMeta(tx.notes);
  if (meta.orderId || meta.paymentIntentId) {
    await updateDirectLinkedPaymentStatus({
      transactionId: tx.id,
      merchantId: tx.merchantId,
      status: "failed",
    }).catch(() => undefined);
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

export function seraPaymentErrorResponse(error: unknown, fallback: string) {
  const quoteError = serializeSeraQuoteError(error);
  if (quoteError) return quoteError;
  if (error instanceof SeraApiError) {
    const providerCode = String(error.errorCode || "").toUpperCase();
    const isQuoteStale = providerCode === "QUOTE_STALE";
    const isUnavailable = error.status >= 500;
    const stableCode = providerCode === "NO_LIQUIDITY" || providerCode === "PAIR_INACTIVE"
      ? "no_liquidity"
      : providerCode === "AMOUNT_BELOW_MIN"
        ? "amount_below_min"
        : isQuoteStale || error.status === 410
          ? "quote_stale"
          : providerCode === "ALLOWANCE_INSUFFICIENT"
            ? "allowance_insufficient"
            : providerCode === "INTENT_DEADLINE_EXPIRED"
              ? "intent_deadline_expired"
              : providerCode === "SLIPPAGE_EXCEEDED"
                ? "slippage_exceeded"
                : providerCode === "STP_BLOCKED"
                  ? "stp_blocked"
                  : error.status === 429
                    ? "sera_rate_limited"
                    : isUnavailable
                      ? "sera_unavailable"
                      : providerCode
                        ? providerCode.toLowerCase()
                        : "invalid_quote";
    const message = stableCode === "no_liquidity"
      ? "Currently there's no liquidity on this exchange in Sera.cx. Please try another option."
      : stableCode === "quote_stale"
        ? "This quote closed before it could be submitted. Please try again."
        : stableCode === "sera_unavailable"
          ? "Sera is temporarily unavailable. Please try again shortly."
          : stableCode === "sera_rate_limited"
            ? "Sera is receiving too many requests. Please try again shortly."
            : stableCode === "amount_below_min"
              ? "This payment amount is below Sera's minimum for this currency pair."
              : fallback;
    return {
      status: error.status >= 400 && error.status < 500 ? error.status : 503,
      body: {
        error: message,
        errorCode: stableCode,
        seraStatus: error.status,
      },
    };
  }
  return {
    status: 502,
    body: {
      error: "Unable to reach Sera right now. Please try again shortly.",
      errorCode: "sera_unavailable",
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

function errorHasDatabaseConstraint(error: unknown, constraint: string, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 5) return false;
  const value = error as Record<string, unknown>;
  return value.constraint === constraint
    || errorHasDatabaseConstraint(value.cause, constraint, depth + 1);
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

let paymentMaintenanceInFlight: Promise<void> | null = null;
let seraOutcomeRecoveryTickInFlight: Promise<void> | null = null;
let seraSettlementReconciliationTickInFlight: Promise<void> | null = null;

function schedulePaymentMaintenance() {
  if (paymentMaintenanceInFlight) return;
  const run = (async () => {
    // Detect arrivals *before* expiring anything: a payment that landed moments
    // before the staleness cutoff must be confirmed, not cancelled out from
    // under the customer who just sent real funds.
    await sweepPendingMerchantDirectActivity();
    await cancelAllStalePendingTransactions();
    await reverifyConfirmingTransactions();
  })().finally(() => {
    if (paymentMaintenanceInFlight === run) paymentMaintenanceInFlight = null;
  });
  paymentMaintenanceInFlight = run;
}

function scheduleSeraOutcomeRecovery() {
  if (seraOutcomeRecoveryTickInFlight) return;
  const run = recoverUnsyncedSeraSwapOutcomes().finally(() => {
    if (seraOutcomeRecoveryTickInFlight === run) seraOutcomeRecoveryTickInFlight = null;
  });
  seraOutcomeRecoveryTickInFlight = run;
}

function scheduleSeraSettlementReconciliation() {
  if (seraSettlementReconciliationTickInFlight) return;
  const run = (async () => {
    // The hot queue is newest-first and bounded, keeping fresh checkouts under
    // the latency target without blasting every historical recovery row at the
    // RPC. The existing 60-second oldest-first Sera queue still guarantees
    // eventual recovery and prevents old submissions from starving.
    const candidates = await getRecentPendingSeraSwapTransactions(100);
    const concurrency = 4;
    for (let index = 0; index < candidates.length; index += concurrency) {
      await Promise.allSettled(candidates.slice(index, index + concurrency).map(async (transaction) => {
        await reconcileSeraSwapOnChain(transaction, parseSeraTransactionNotes(transaction.notes)).catch((error) => {
          logSeraOperationFailure("payments/swap-fast-reconcile", error);
        });
      }));
    }
  })().catch((error) => {
    logSeraOperationFailure("payments/swap-fast-reconcile", error);
  }).finally(() => {
    if (seraSettlementReconciliationTickInFlight === run) {
      seraSettlementReconciliationTickInFlight = null;
    }
  });
  seraSettlementReconciliationTickInFlight = run;
}

const paymentMaintenanceInterval = setInterval(schedulePaymentMaintenance, 60_000);
const seraOutcomeRecoveryInterval = setInterval(scheduleSeraOutcomeRecovery, 15_000);
const seraSettlementReconciliationInterval = process.env.NODE_ENV === "test"
  ? null
  : setInterval(scheduleSeraSettlementReconciliation, 5_000);
paymentMaintenanceInterval.unref();
seraOutcomeRecoveryInterval.unref();
seraSettlementReconciliationInterval?.unref();

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
    const [pending, pendingSeraSwaps] = await Promise.all([
      getPendingTransactions(),
      getPendingSeraSwapTransactions(),
    ]);
    // A week covers any realistic gap between a payment landing and a deploy
    // that can finally verify it — real stuck rows deserve capture, not
    // abandonment. Older rows are structural leftovers (dead test data, an
    // unindexable hash); the per-tx backoff already keeps their retries and
    // log lines rare.
    // Sera rows deliberately bypass this legacy direct-transfer cutoff: once
    // payer funds may have moved, age alone can never abandon reconciliation.
    const reverifyCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    // The generic queue is newest-first and capped for direct-payment sweep
    // latency. Merge its direct rows with an oldest-first Sera recovery queue
    // so a submitted swap cannot be starved by newer traffic.
    const byId = new Map([...pending, ...pendingSeraSwaps].map((tx) => [tx.id, tx]));
    const candidates = Array.from(byId.values()).filter((tx) => tx.status === "confirming");
    const concurrency = 4;
    for (let index = 0; index < candidates.length; index += concurrency) {
      await Promise.allSettled(candidates.slice(index, index + concurrency).map(async (tx) => {
        if (isSeraSwapTransaction(tx)) {
          await reconcileSeraSwapTransaction(tx).catch((error) => {
            logSeraOperationFailure("payments/reverify-swap", error);
          });
        } else if (
          new Date(tx.createdAt).getTime() >= reverifyCutoff
          && tx.txHash
          && /^0x[0-9a-fA-F]{64}$/.test(tx.txHash)
        ) {
          // Fire-and-forget with a per-tx in-flight guard, so a slow receipt
          // wait never stacks a second watcher for the same payment.
          scheduleTransactionVerification(tx.id, tx.txHash as `0x${string}`);
        }
      }));
    }
  } catch (error) {
    logSeraOperationFailure("payments/reverify", error);
  }
}

const seraOutcomeEffectsInFlight = new Map<string, Promise<Transaction | undefined>>();

function seraOutcomeDisplayAmount(
  rawAmount: string | null | undefined,
  decimals: number | null | undefined,
  fallback: string | number,
): string {
  if (rawAmount != null && parseStoredTokenDecimals(decimals) != null) {
    try {
      return fromRawTokenAmount(rawAmount, decimals!);
    } catch {
      // Legacy rows can contain malformed optional accounting fields. The
      // merchant's protected transaction amount remains the safe fallback.
    }
  }
  return String(fallback);
}

async function performSeraSwapOutcomeEffects(
  transactionId: string,
  knownMerchant?: Merchant,
): Promise<Transaction | undefined> {
  // Failure may be superseded exactly once by an authoritative on-chain
  // success. Loop so the success notification is the final observable event
  // even when it wins while a stale failure worker is finishing.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const prepared = await prepareSeraSwapOutcomeSync(transactionId);
    if (prepared.outcome === "not_found") return undefined;
    if (prepared.outcome === "already_synced" || prepared.outcome === "invalid_state") {
      return prepared.transaction;
    }
    if (prepared.outcome === "binding_conflict") {
      console.error("[payment/swap/outcome] Refused conflicting linked-payment binding", {
        transactionId,
        resource: prepared.resource,
        resourceId: prepared.resourceId,
      });
      // Keep this row unsynced for operator repair, but rotate it behind other
      // due outcomes so 100 poisoned rows cannot starve every newer webhook.
      await deferSeraSwapOutcomeSync(transactionId);
      return prepared.transaction;
    }
    if (prepared.outcome !== "prepared") return prepared.transaction;

    const transaction = prepared.transaction;
    const terminalOutcome = prepared.terminalOutcome;
    const latest = await getTransactionById(transaction.id);
    if (!latest) return undefined;

    // If the terminal fingerprint changed after preparation, do not emit the
    // stale event. Completion will report state_changed and the loop will
    // prepare the authoritative outcome instead.
    const stillCurrent = terminalOutcome.kind === "confirmed"
      ? latest.status === "confirmed"
        && latest.verified === 1
        && latest.submitState === "settled"
        && latest.txHash?.toLowerCase() === terminalOutcome.txHash
        && latest.settlementTxHash?.toLowerCase() === terminalOutcome.txHash
      : latest.status === "failed"
        && latest.verified === 0
        && latest.submitState === "failed"
        && latest.failureCode === terminalOutcome.failureCode
        && latest.txHash == null
        && latest.settlementTxHash == null;

    let webhookRequested = false;
    let webhookDelivered = false;
    if (stillCurrent) {
      const merchant = knownMerchant?.id === latest.merchantId
        ? knownMerchant
        : await getMerchantById(latest.merchantId);
      if (!merchant) throw new Error("Merchant for terminal Sera outcome was not found");

      if (terminalOutcome.kind === "confirmed") {
        const amount = seraOutcomeDisplayAmount(
          latest.actualReceiveAmountRaw,
          latest.receiveTokenDecimals,
          latest.amount,
        );
        const payAmount = seraOutcomeDisplayAmount(
          latest.actualPayAmountRaw,
          latest.payTokenDecimals,
          latest.payAmount ?? amount,
        );
        notifySseClients(latest.id, {
          status: "confirmed",
          txHash: terminalOutcome.txHash,
          verified: true,
        });
        webhookRequested = Boolean(merchant.webhookUrl);
        webhookDelivered = await notifyRecordedDirectTransfer({
          merchant,
          txId: latest.id,
          txHash: terminalOutcome.txHash as `0x${string}`,
          coin: latest.coin,
          amount,
          payCoin: latest.payCoin || latest.coin,
          payAmount,
          fromAddress: latest.fromAddress,
          toAddress: latest.toAddress,
          verified: true,
          source: "sera_swap",
        });
      } else {
        const reason = transactionFailureReason(latest.notes) || "Sera swap settlement failed.";
        notifySseClients(latest.id, { status: "failed", reason });
        notifyMerchantSse(merchant.id, {
          event: "payment_failed",
          transactionId: latest.id,
          status: "failed",
          amount: latest.amount,
          coin: latest.coin,
          reason,
          source: "sera_swap",
        });
      }
    }

    const completed = await completeSeraSwapOutcomeSync({
      transactionId: transaction.id,
      terminalOutcome,
      webhookRequested,
      webhookDelivered,
    });
    if (completed.outcome !== "state_changed") return completed.transaction;
  }

  return getTransactionById(transactionId);
}

async function deliverSeraSwapOutcomeEffects(
  tx: Transaction,
  merchant?: Merchant,
): Promise<Transaction | undefined> {
  const existing = seraOutcomeEffectsInFlight.get(tx.id);
  if (existing) return existing;
  const delivery = performSeraSwapOutcomeEffects(tx.id, merchant);
  seraOutcomeEffectsInFlight.set(tx.id, delivery);
  try {
    return await delivery;
  } finally {
    if (seraOutcomeEffectsInFlight.get(tx.id) === delivery) {
      seraOutcomeEffectsInFlight.delete(tx.id);
    }
  }
}

async function recoverUnsyncedSeraSwapOutcomes() {
  try {
    const outcomes = await getUnsyncedSeraSwapOutcomes();
    const concurrency = 4;
    for (let index = 0; index < outcomes.length; index += concurrency) {
      await Promise.allSettled(outcomes.slice(index, index + concurrency).map((transaction) => (
        deliverSeraSwapOutcomeEffects(transaction)
      )));
    }
  } catch (error) {
    logSeraOperationFailure("payments/swap-outcome-recovery", error);
  }
}

type SeraTrackedOrder = {
  trade_id?: string;
  owner_address?: string;
  status?: string;
  order_type?: string;
  from_token?: string;
  to_token?: string;
  error?: string | null;
  error_code?: string | null;
  settlement_summary?: {
    latest_tx_hash?: string | null;
    latest_failed_fill_failure_reason?: string | null;
  } | null;
  settlement_economics?: unknown;
  [key: string]: unknown;
};

function trackedSeraOrderMatchesPayment(
  order: SeraTrackedOrder,
  tx: Transaction,
  notes: Record<string, unknown>,
  tradeId: string,
): boolean {
  const inputToken = tx.payTokenAddress ?? (typeof notes.payToken === "string" ? notes.payToken : null);
  const outputToken = tx.receiveTokenAddress ?? (typeof notes.receiveToken === "string" ? notes.receiveToken : null);
  return Boolean(
    inputToken
    && outputToken
    && tx.fromAddress
    && order.trade_id === tradeId
    && String(order.owner_address || "").toLowerCase() === tx.fromAddress.toLowerCase()
    && String(order.order_type || "").toLowerCase() === "swap"
    && String(order.from_token || "").toLowerCase() === inputToken.toLowerCase()
    && String(order.to_token || "").toLowerCase() === outputToken.toLowerCase()
  );
}

async function reconcileSeraSwapTransaction(tx: Transaction): Promise<Transaction> {
  if (tx.status !== "confirming") return tx;
  if (!isSeraSwapTransaction(tx)) return tx;
  if (!tx.quoteUuid || !tx.intentHash) return tx;
  const notes = parseSeraTransactionNotes(tx.notes);
  const tradeId = tx.tradeId ?? (typeof notes.tradeId === "string" ? notes.tradeId : null);
  // A submit whose answer was lost in transit (see /payment/swap/submit) has
  // no trade id to ask Sera about; the chain is the only witness left.
  if (!tradeId) return reconcileSeraSwapOnChain(tx, notes);
  const applyOrderEvidence = (patch: Parameters<typeof claimSeraSwapPostNetworkUpdate>[0]["patch"]) => (
    claimSeraSwapPostNetworkUpdate({
      transactionId: tx.id,
      intentHash: tx.intentHash!,
      quoteUuid: tx.quoteUuid!,
      expectedTradeId: tradeId,
      patch,
    })
  );

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
  const nextNotes = JSON.stringify({ ...notes, seraStatus, seraOrder: order });

  // A response for a different owner/token/order must never decide this
  // payment's state. Keep the public on-chain proof as the recovery path.
  if (!trackedSeraOrderMatchesPayment(order, tx, notes, tradeId)) {
    const mismatchNotes = JSON.stringify({
      ...notes,
      seraStatus,
      seraOrderValidationError: "ORDER_IDENTITY_MISMATCH",
    });
    const update = await applyOrderEvidence({
      notes: mismatchNotes,
      failureCode: "settlement_unknown",
      seraStatus,
    });
    if (update.outcome !== "claimed") return update.outcome === "not_found" ? tx : update.transaction;
    const refreshed = update.transaction;
    return reconcileSeraSwapOnChain(refreshed, parseSeraTransactionNotes(mismatchNotes));
  }

  // Sera's order state is useful operational evidence, but it cannot prove
  // that no atomic settlement landed on-chain. Even a provider-side
  // failed/cancelled result therefore remains advisory until a gap-free scan
  // of finalized blocks reaches the signed Intent deadline.
  const seraErrorCode = String(order.error_code || "").toUpperCase();
  const retryableFailure = seraErrorCode === "TRANSIENT_SETTLEMENT_FAILURE";
  if (seraStatus === "failed" || seraStatus === "cancelled" || seraStatus === "canceled") {
    const reason = order.error || order.settlement_summary?.latest_failed_fill_failure_reason || order.error_code || `Sera swap ${seraStatus}`;
    const advisoryNotes = JSON.stringify({
      ...notes,
      seraStatus,
      seraOrder: order,
      seraOrderTerminalAdvisory: {
        status: seraStatus,
        errorCode: seraErrorCode || null,
        reason,
        retryable: retryableFailure,
        observedAt: new Date().toISOString(),
      },
    });
    const update = await applyOrderEvidence({
      notes: advisoryNotes,
      tradeId,
      submitState: "settlement_unknown",
      seraStatus,
      failureCode: "settlement_unknown",
    });
    if (update.outcome !== "claimed") return update.outcome === "not_found" ? tx : update.transaction;
    const refreshed = update.transaction;
    return reconcileSeraSwapOnChain(refreshed, parseSeraTransactionNotes(advisoryNotes));
  }

  if (seraStatus !== "settled") {
    const update = await applyOrderEvidence({
      notes: nextNotes,
      tradeId,
      submitState: tx.submitState === "settlement_unknown" ? "settlement_unknown" : "submitted",
      seraStatus,
      failureCode: tx.submitState === "settlement_unknown" ? "settlement_unknown" : null,
    });
    if (update.outcome !== "claimed") return update.outcome === "not_found" ? tx : update.transaction;
    const refreshed = update.transaction;
    return reconcileSeraSwapOnChain(refreshed, { ...notes, seraStatus, seraOrder: order });
  }

  if (!tx.fromAddress || !tx.payTokenAddress || !tx.receiveTokenAddress || !tx.targetReceiveAmountRaw) {
    return reconcileSeraSwapOnChain(tx, notes);
  }

  let settlement: ReturnType<typeof validateSeraSettledOrder>;
  try {
    settlement = validateSeraSettledOrder(order, {
      tradeId,
      payerAddress: tx.fromAddress,
      inputTokenAddress: tx.payTokenAddress,
      outputTokenAddress: tx.receiveTokenAddress,
      targetOutputAmountRaw: tx.targetReceiveAmountRaw,
    });
  } catch (error) {
    const validationCode = error instanceof SeraSettlementValidationError ? error.code : "MALFORMED_ORDER";
    const invalidNotes = JSON.stringify({
      ...notes,
      seraStatus,
      seraOrder: order,
      seraOrderValidationError: validationCode,
    });
    const update = await applyOrderEvidence({
      notes: invalidNotes,
      seraStatus,
      failureCode: "settlement_unknown",
    });
    if (update.outcome !== "claimed") return update.outcome === "not_found" ? tx : update.transaction;
    const refreshed = update.transaction;
    return reconcileSeraSwapOnChain(refreshed, parseSeraTransactionNotes(invalidNotes));
  }

  // The schema has one fee token column. Prefer the input-token fee (the
  // normal pay_more gas case); preserve the complete multi-token list in notes.
  const storedFee = settlement.fees.find((fee) => fee.tokenAddress === settlement.inputTokenAddress)
    ?? (settlement.fees.length === 1 ? settlement.fees[0] : null);
  const economicsNotes = JSON.stringify({
    ...notes,
    seraStatus,
    seraOrder: order,
    seraSettlementEconomics: settlement,
  });
  const update = await applyOrderEvidence({
    tradeId,
    seraStatus,
    actualPayAmountRaw: settlement.actualPayRaw,
    actualReceiveAmountRaw: settlement.actualReceiveRaw,
    feeAmountRaw: storedFee?.amountRaw ?? null,
    feeTokenAddress: storedFee?.tokenAddress ?? null,
    // settlement.txHash is API evidence only and remains in notes until the
    // finalized-chain proof claims it. Reserving settlementTxHash for a
    // verified result keeps an incorrect provider response recoverable.
    failureCode: null,
    notes: economicsNotes,
  });
  if (update.outcome !== "claimed") return update.outcome === "not_found" ? tx : update.transaction;
  const refreshed = update.transaction;
  // GET /orders has no recipient field. Require the same-transaction
  // IntentMatched + Vault→merchant output transfer before marking paid.
  return reconcileSeraSwapOnChain(refreshed, parseSeraTransactionNotes(economicsNotes));
}

function isSeraSwapTransaction(tx: Transaction): boolean {
  return isSeraSwapTransactionRecord(tx);
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
  receiverAddress,
  chainId,
  paymentIntentId,
  orderId,
}: {
  merchant: Merchant;
  receiveCoin: string;
  receiverAddress: string;
  chainId: number;
  paymentIntentId: string | null;
  orderId: string | null;
}): Promise<{ amount: string; label: string } | null> {
  if (!paymentIntentId && !orderId) return null;
  const references: Array<{ amount: string; label: string }> = [];
  let paymentIntent: Awaited<ReturnType<typeof getPaymentIntentById>>;
  let menuOrder: Awaited<ReturnType<typeof getMenuOrderById>>;
  if (paymentIntentId) {
    paymentIntent = await getPaymentIntentById(paymentIntentId);
    references.push({
      amount: assertPaymentIntentBindable(paymentIntent, {
        merchantId: merchant.id,
        receiveCoin,
        receiverAddress,
        chainId,
      }),
      label: "payment intent",
    });
  }
  if (orderId) {
    menuOrder = await getMenuOrderById(orderId);
    references.push({
      amount: assertMenuOrderBindable(menuOrder, {
        merchantId: merchant.id,
        receiveCoin,
        merchantReceiveCoin: merchant.receiveCoin,
      }),
      label: "menu order",
    });
  }
  if (paymentIntentId && orderId && menuOrder?.paymentIntentId !== paymentIntentId) {
    throw new PaymentBindingError("Payment intent is not linked to this menu order", 409);
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
    const attemptId = typeof req.body.attemptId === "string" ? req.body.attemptId.trim() : "";
    if (attemptId && !UUID_RE.test(attemptId)) {
      res.status(400).json({ error: "Invalid payment attempt ID", errorCode: "invalid_request" });
      return;
    }
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
    if (!checkoutRequest && (req.body.orderId || req.body.paymentIntentId)) {
      throw new CheckoutPayloadError("Order and payment-intent references require a signed checkout payload.");
    }
    // A signed checkout is a closed capability: references absent from its
    // payload cannot be injected through mutable request-body fields.
    const orderReference = checkoutRequest ? checkoutRequest.orderId : req.body.orderId;
    const paymentIntentReference = checkoutRequest ? checkoutRequest.paymentIntentId : req.body.paymentIntentId;
    const orderId = typeof orderReference === "string" ? orderReference : null;
    const paymentIntentId = typeof paymentIntentReference === "string" ? paymentIntentReference : null;
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
    const resolvedChainId = Number(chainId || SERA_MAINNET_CHAIN_ID);
    const id = attemptId || uuidv4();
    const previousAttempt = attemptId ? await getTransactionById(attemptId) : undefined;
    if (previousAttempt) {
      const previousReferences = transactionNotesMeta(previousAttempt.notes);
      const sameAttempt = previousAttempt.merchantId === merchant.id
        && previousAttempt.toAddress.toLowerCase() === toAddress.toLowerCase()
        && previousAttempt.coin.toUpperCase() === coinSymbol
        && Number(previousAttempt.chainId) === resolvedChainId
        && sameMicroAmount(String(previousAttempt.amount), normalizedAmount)
        && previousAttempt.status === "pending"
        && previousAttempt.verified === 0
        && previousAttempt.txHash == null
        && !isSeraSwapTransaction(previousAttempt)
        && previousReferences.orderId === orderId
        && previousReferences.paymentIntentId === paymentIntentId;
      if (!sameAttempt) {
        res.status(409).json({ error: "This payment attempt can no longer be reused.", errorCode: "payment_attempt_stale" });
        return;
      }
    }
    const payableReference = previousAttempt ? null : await resolvePayableReferenceAmount({
      merchant,
      receiveCoin: coinSymbol,
      receiverAddress: toAddress,
      chainId: resolvedChainId,
      paymentIntentId,
      orderId,
    });
    const toAddressCompliance = await screenWalletAddress(toAddress, "recipient_wallet", merchant.id);
    if (toAddressCompliance.blocked) {
      res.status(403).json({ error: "Recipient address failed compliance screening", compliance: toAddressCompliance });
      return;
    }
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
    if (!previousAttempt) {
      const created = await createDirectTransactionWithReservation({
        transaction: {
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
        },
        orderId,
        paymentIntentId,
      });
      if (created.outcome === "binding_conflict") {
        res.status(409).json({
          error: "Another payment has already claimed this checkout.",
          errorCode: "payment_already_submitted",
        });
        return;
      }
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

/**
 * Shared disposable quote check for dashboard and API-generated QR codes.
 * Callers validate ownership and screen the recipient before invoking it.
 */
export async function preflightSeraConversion({
  merchantId,
  receiverAddress,
  payCoin,
  receiveCoin,
  receiveAmount,
  estimatedPayAmount,
  chainId,
}: {
  merchantId: string;
  receiverAddress: string;
  payCoin: string;
  receiveCoin: string;
  receiveAmount: string;
  estimatedPayAmount: string;
  chainId: number;
}) {
  const baseUrl = getSeraApiBaseUrlForChain(chainId);
  const [fromToken, toToken] = await Promise.all([
    resolveSeraSwapToken(baseUrl, payCoin),
    resolveSeraSwapToken(baseUrl, receiveCoin),
  ]);
  let requestedInputRaw: string;
  let targetOutputRaw: string;
  try {
    requestedInputRaw = toRawTokenAmount(estimatedPayAmount, fromToken.decimals);
    targetOutputRaw = toRawTokenAmount(receiveAmount, toToken.decimals);
  } catch (error) {
    throw new SeraQuoteValidationError(
      "invalid_request",
      error instanceof Error ? error.message : "Payment amount exceeds token precision",
      { field: "amount" },
    );
  }

  if (payCoin === receiveCoin) {
    if (fromToken.address.toLowerCase() !== toToken.address.toLowerCase()) {
      throw new SeraQuoteValidationError("invalid_config", "Sera returned inconsistent token metadata for a direct payment");
    }
    if (requestedInputRaw !== targetOutputRaw) {
      throw new SeraQuoteValidationError(
        "invalid_request",
        "A direct payment must pay exactly the requested receive amount",
        { field: "estimatedPayAmount" },
      );
    }
    return {
      executable: true,
      advisory: false,
      requiresCustomerRequote: false,
      direct: true,
      source: "direct-payment",
      chainId,
      toAddress: receiverAddress,
      payCoin,
      receiveCoin,
      requestedPayAmount: estimatedPayAmount,
      maximumPayAmount: receiveAmount,
      targetReceiveAmount: receiveAmount,
      minimumReceiveAmount: receiveAmount,
      checkedAt: Math.floor(Date.now() / 1000),
    };
  }

  const [rawConfig, seraNowSec] = await Promise.all([
    callSeraApi<unknown>({ baseUrl, path: "/config", authMode: "none", merchantId }),
    getSeraServerTimestamp(baseUrl, merchantId),
  ]);
  const probeOwner = getSeraPreflightProbeAddress();
  if (probeOwner === receiverAddress.toLowerCase()) {
    throw new SeraQuoteValidationError(
      "invalid_config",
      "The Sera preflight probe address must differ from the merchant recipient",
      { field: "SERA_PREFLIGHT_PROBE_ADDRESS" },
    );
  }
  const initialRequest: SeraSwapQuoteRequest = {
    from_token: fromToken.address.toLowerCase() as `0x${string}`,
    to_token: toToken.address.toLowerCase() as `0x${string}`,
    from_amount: requestedInputRaw,
    owner_address: probeOwner,
    recipient: receiverAddress.toLowerCase() as `0x${string}`,
    expiration: seraNowSec + 300,
    gas_mode: "pay_more",
  };
  const result = await solveSeraFixedOutputQuote({
    initialRequest,
    targetOutputRaw,
    minimumInputRaw: fromToken.min_trade_amount_raw || "0",
    minimumInputSymbol: fromToken.symbol,
    config: rawConfig,
    expectedChainId: chainId,
    serverTime: seraNowSec,
    policy: getSeraFixedOutputPolicy(),
    requestQuote: (request) => callSeraApi<unknown>({
      baseUrl,
      path: "/swap/quote",
      method: "POST",
      body: request,
      authMode: "none",
      merchantId,
    }),
  });
  return {
    ...toSeraPreflightSummary(result, seraNowSec),
    chainId,
    toAddress: receiverAddress,
    payCoin,
    receiveCoin,
    requestedPayAmount: estimatedPayAmount,
    quotedPayAmount: fromRawTokenAmount(result.finalRequest.from_amount, fromToken.decimals),
    maximumPayAmount: fromRawTokenAmount(result.quote.routeParams.maxInputAmount, fromToken.decimals),
    targetReceiveAmount: receiveAmount,
    minimumReceiveAmount: fromRawTokenAmount(result.quote.routeParams.minOutputAmount, toToken.decimals),
  };
}

/**
 * POST /api/payment/swap/preflight
 *
 * Merchant-authenticated, disposable liquidity check used immediately before
 * generating a cross-currency QR. It persists no payment and deliberately
 * returns no quote UUID, Permit payload, or signable Intent.
 */
paymentRouter.post("/payment/swap/preflight", requireApiKey as any, async (req: any, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const receiverAddress = String(req.body.receiverAddress ?? req.body.merchantAddress ?? "").trim().toLowerCase();
    const payCoin = String(req.body.payCoin ?? "").trim().toUpperCase();
    const receiveCoin = String(req.body.receiveCoin ?? "").trim().toUpperCase();
    let receiveAmount: string;
    let estimatedPayAmount: string;
    try {
      receiveAmount = normalizeDecimalAmount(req.body.receiveAmount);
      estimatedPayAmount = normalizeDecimalAmount(req.body.estimatedPayAmount ?? req.body.payAmount);
    } catch (error) {
      throw new SeraQuoteValidationError(
        "invalid_request",
        error instanceof Error ? error.message : "Invalid payment amount",
        { field: "amount" },
      );
    }
    const chainId = Number(req.body.chainId ?? SERA_MAINNET_CHAIN_ID);

    if (!/^0x[0-9a-f]{40}$/.test(receiverAddress)) {
      res.status(400).json({ error: "Invalid receiverAddress", errorCode: "invalid_request" });
      return;
    }
    if (!COIN_SYMBOL_RE.test(payCoin) || !COIN_SYMBOL_RE.test(receiveCoin)) {
      res.status(400).json({ error: "Invalid coin", errorCode: "invalid_request" });
      return;
    }
    if (chainId !== SERA_MAINNET_CHAIN_ID && !isTestnetChainEnabled(chainId)) {
      res.status(400).json({ error: `Sera payments are not supported on chain ${chainId}`, errorCode: "unsupported_chain" });
      return;
    }

    let resolved: Awaited<ReturnType<typeof resolvePaymentMerchant>>;
    try {
      resolved = await resolvePaymentMerchant(receiverAddress);
    } catch {
      res.status(404).json({ error: "Merchant receiver not found", errorCode: "invalid_request" });
      return;
    }
    if (resolved.merchant.id !== req.merchant.id) {
      res.status(403).json({ error: "Receiver address does not belong to this merchant", errorCode: "invalid_request" });
      return;
    }
    const recipientCompliance = await screenWalletAddress(resolved.toAddress, "recipient_wallet", req.merchant.id);
    if (recipientCompliance.blocked) {
      res.status(403).json({ error: "Recipient address failed compliance screening", errorCode: "invalid_request", compliance: recipientCompliance });
      return;
    }

    res.json(await preflightSeraConversion({
      merchantId: req.merchant.id,
      receiverAddress: resolved.toAddress,
      payCoin,
      receiveCoin,
      receiveAmount,
      estimatedPayAmount,
      chainId,
    }));
  } catch (error) {
    logSeraOperationFailure("payment/swap/preflight", error);
    const response = seraPaymentErrorResponse(error, "Unable to verify this Sera conversion right now");
    res.status(response.status).json(response.body);
  }
});

/** POST /api/payment/swap/quote - Sera quote for customer coin -> merchant receive coin */
paymentRouter.post("/payment/swap/quote", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  let checkoutAttemptKeyForConflict: string | null = null;
  try {
    const signedCheckoutPayload = typeof req.body.checkoutPayload === "string"
      ? req.body.checkoutPayload.trim()
      : "";
    const checkoutRequest = bindCheckoutRequest(signedCheckoutPayload || undefined);
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
    if (!checkoutRequest && (req.body.orderId || req.body.paymentIntentId)) {
      throw new CheckoutPayloadError("Order and payment-intent references require a signed checkout payload.");
    }
    // Do not let an unsigned body attach a second obligation to an otherwise
    // valid signed checkout link.
    const paymentIntentReference = checkoutRequest ? checkoutRequest.paymentIntentId : req.body.paymentIntentId;
    const orderReference = checkoutRequest ? checkoutRequest.orderId : req.body.orderId;
    const paymentIntentId = typeof paymentIntentReference === "string" ? paymentIntentReference : null;
    const orderId = typeof orderReference === "string" ? orderReference : null;
    const requestedExpiration = Number(req.body.expiration);
    const requestedTxId = typeof req.body.txId === "string" ? req.body.txId.trim() : "";
    const previousQuoteUuid = typeof req.body.previousQuoteUuid === "string"
      ? req.body.previousQuoteUuid.trim()
      : "";

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
    const checkoutAttemptKey = checkoutRequest && signedCheckoutPayload
      ? deriveSeraCheckoutAttemptKey(signedCheckoutPayload, payerAddress)
      : null;
    checkoutAttemptKeyForConflict = checkoutAttemptKey;
    if (checkoutAttemptKey) {
      const activeAttempt = await getActiveSeraSwapTransactionByCheckoutAttemptKey(checkoutAttemptKey);
      if (activeAttempt && (
        activeAttempt.status === "confirming"
        || !(
          requestedTxId === activeAttempt.id
          && previousQuoteUuid
          && activeAttempt.quoteUuid === previousQuoteUuid
        )
      )) {
        // A signed checkout snapshot + payer may own only one unresolved swap.
        // This survives wallet-tab/session loss; the new page watches payment A
        // instead of creating and signing payment B.
        res.status(409).json({
          error: "This wallet already has a Sera payment for this checkout in progress.",
          errorCode: "payment_attempt_in_progress",
          detail: { txId: activeAttempt.id, status: activeAttempt.status },
        });
        return;
      }
    }

    const payableReference = await resolvePayableReferenceAmount({
      merchant,
      receiveCoin,
      receiverAddress: toAddress,
      chainId,
      paymentIntentId,
      orderId,
    });

    if (chainId !== SERA_MAINNET_CHAIN_ID && !isTestnetChainEnabled(chainId)) {
      throw new SeraQuoteValidationError(
        "unsupported_chain",
        `Sera payments are not supported on chain ${chainId}`,
        { field: "chainId" },
      );
    }
    const baseUrl = getSeraApiBaseUrlForChain(chainId);
    const [fromToken, toToken, rawConfig, seraNowSec] = await Promise.all([
      resolveSeraSwapToken(baseUrl, payCoin),
      resolveSeraSwapToken(baseUrl, receiveCoin),
      callSeraApi<unknown>({ baseUrl, path: "/config", authMode: "none", merchantId: merchant.id }),
      getSeraServerTimestamp(baseUrl, merchant.id),
    ]);
    const deployment = validateSeraDeploymentConfig(rawConfig, chainId);
    // Sera explicitly requires deadlines to be based on GET /system/time.
    // This avoids rejecting otherwise valid payments when a phone clock drifts.
    const expiration = Number.isInteger(requestedExpiration) && requestedExpiration > seraNowSec + 15
      ? Math.min(requestedExpiration, seraNowSec + 300)
      : seraNowSec + 300;

    let fromAmountRaw: string;
    let targetOutputRaw: string | undefined;
    try {
      fromAmountRaw = toRawTokenAmount(payAmount, fromToken.decimals);
      targetOutputRaw = requestedReceiveAmount
        ? toRawTokenAmount(requestedReceiveAmount, toToken.decimals)
        : undefined;
    } catch (error) {
      throw new SeraQuoteValidationError(
        "invalid_request",
        error instanceof Error ? error.message : "Payment amount exceeds token precision",
        { field: "amount" },
      );
    }
    const initialRequest: SeraSwapQuoteRequest = {
      from_token: fromToken.address.toLowerCase() as `0x${string}`,
      to_token: toToken.address.toLowerCase() as `0x${string}`,
      from_amount: fromAmountRaw,
      owner_address: payerAddress as `0x${string}`,
      recipient: toAddress as `0x${string}`,
      expiration,
      // The merchant's protected output is preserved; gas is added to the
      // payer's maximum input instead of being subtracted from the payout.
      gas_mode: "pay_more",
    };
    const quoteResult = await solveSeraFixedOutputQuote({
      initialRequest,
      targetOutputRaw,
      minimumInputRaw: fromToken.min_trade_amount_raw || "0",
      minimumInputSymbol: fromToken.symbol,
      config: rawConfig,
      expectedChainId: chainId,
      serverTime: seraNowSec,
      policy: getSeraFixedOutputPolicy(),
      requestQuote: (request) => callSeraApi<unknown>({
        baseUrl,
        path: "/swap/quote",
        method: "POST",
        body: request,
        authMode: "none",
        merchantId: merchant.id,
      }),
    });
    const quote = quoteResult.quote;
    const routeParams = quote.routeParams;
    const quoteUuid = quote.uuid;
    // SeraSOR's IntentMatched event emits the EIP-712 struct hash (before the
    // domain separator), so persist exactly that value for public on-chain
    // settlement reconciliation.
    const intentHash = hashSeraIntentStruct(routeParams);
    const expectedReceiveAmount = requestedReceiveAmount ?? fromRawTokenAmount(routeParams.minOutputAmount, toToken.decimals);
    if (payableReference) {
      assertAmountMatchesReference(expectedReceiveAmount, payableReference.amount, { exact: false, label: payableReference.label });
    }
    const maximumPayAmount = fromRawTokenAmount(routeParams.maxInputAmount, fromToken.decimals);
    const authorization = quote.permit;
    const permitDeadlineSeconds = authorization?.typedData?.message.deadline ?? null;
    const quoteExpiresAt = new Date(quote.expiresAt * 1000);
    const intentDeadline = new Date(Number(routeParams.deadline) * 1000);
    const permitDeadlineDate = permitDeadlineSeconds === null
      ? null
      : new Date(Number(permitDeadlineSeconds) * 1000);
    const txId = requestedTxId || uuidv4();
    const transactionNotes = JSON.stringify({
      type: "sera_swap_quote",
      quoteUuid,
      intentHash,
      paymentIntentId,
      orderId,
      payToken: fromToken.address,
      receiveToken: toToken.address,
      payTokenDecimals: fromToken.decimals,
      receiveTokenDecimals: toToken.decimals,
      chainId,
      expiresAt: quote.expiresAt,
      requestedPayAmount: payAmount,
      requestedReceiveAmount,
      quotedFeeBreakdown: quote.feeBreakdown,
      permitTypedData: authorization?.typedData ?? null,
      // Settlement proof must stay bound to the deployment that produced the
      // signed Intent. A later Sera config rotation must not make an in-flight
      // payment invisible to reconciliation.
      seraDeployment: {
        seraAddress: deployment.seraAddress,
        vaultAddress: deployment.vaultAddress,
        sorAddress: deployment.sorAddress,
      },
    });

    const lifecycle = {
      checkoutAttemptKey,
      amount: expectedReceiveAmount,
      payAmount: maximumPayAmount,
      quoteUuid,
      routeUuid: routeParams.uuid,
      intentHash,
      tradeId: null,
      payTokenAddress: routeParams.inputToken,
      receiveTokenAddress: routeParams.outputToken,
      seraAddress: deployment.seraAddress,
      seraVaultAddress: deployment.vaultAddress,
      seraSorAddress: deployment.sorAddress,
      payTokenDecimals: fromToken.decimals,
      receiveTokenDecimals: toToken.decimals,
      requestedPayAmountRaw: quoteResult.initialRequest.from_amount,
      maximumPayAmountRaw: routeParams.maxInputAmount,
      targetReceiveAmountRaw: quoteResult.targetOutputRaw,
      minimumReceiveAmountRaw: routeParams.minOutputAmount,
      initialDepositAmountRaw: routeParams.initialDepositAmount,
      quoteExpiresAt,
      intentDeadline,
      permitRequired: authorization?.authorizationKind === "permit" ? 1 : 0,
      permitDeadline: permitDeadlineDate,
      submitState: "quote_ready" as const,
      submittedBlockNumber: null,
      seraStatus: "quoted",
      actualPayAmountRaw: null,
      actualReceiveAmountRaw: null,
      feeAmountRaw: null,
      feeTokenAddress: null,
      settlementTxHash: null,
      failureCode: null,
      seraOutcomeSyncedAt: null,
      notes: transactionNotes,
    };

    if (requestedTxId) {
      const existing = await getTransactionById(requestedTxId);
      const existingNotes = existing ? parseSeraTransactionNotes(existing.notes) : {};
      const existingReference = existing ? transactionNotesMeta(existing.notes) : null;
      const sameTarget = requestedReceiveAmount === null
        ? existingNotes.requestedReceiveAmount === null
        : existing?.targetReceiveAmountRaw === quoteResult.targetOutputRaw;
      const samePayment = existing
        && existing.status === "pending"
        && existing.merchantId === merchant.id
        && existing.fromAddress?.toLowerCase() === payerAddress
        && existing.toAddress.toLowerCase() === toAddress.toLowerCase()
        && existing.coin === receiveCoin
        && existing.payCoin === payCoin
        && existing.chainId === deployment.chainId
        && (existing.checkoutAttemptKey == null || existing.checkoutAttemptKey === checkoutAttemptKey)
        && (existing.submitState === "quote_ready" || existing.submitState === null)
        && existingReference?.paymentIntentId === paymentIntentId
        && existingReference?.orderId === orderId
        && (sameTarget || (
          existing.targetReceiveAmountRaw === null
          && sameMicroAmount(String(existing.amount), expectedReceiveAmount)
        ));
      if (!samePayment || !previousQuoteUuid || existing?.quoteUuid !== previousQuoteUuid) {
        res.status(409).json({ error: "The previous Sera quote can no longer be refreshed.", errorCode: "quote_stale" });
        return;
      }
      const refreshed = await refreshSeraSwapQuote(txId, previousQuoteUuid, lifecycle);
      if (!refreshed) {
        res.status(409).json({ error: "The previous Sera quote changed while it was being refreshed.", errorCode: "quote_stale" });
        return;
      }
    } else {
      await createTransaction({
        id: txId,
        merchantId: merchant.id,
        fromAddress: payerAddress,
        toAddress,
        coin: receiveCoin,
        chainId: deployment.chainId,
        status: "pending",
        verified: 0,
        payCoin,
        ...lifecycle,
      });
    }
    res.json({
      txId,
      chainId: deployment.chainId,
      toAddress,
      payCoin,
      receiveCoin,
      payAmount: maximumPayAmount,
      requestedPayAmount: payAmount,
      expectedReceiveAmount,
      quoteUuid,
      quote: {
        uuid: quote.uuid,
        route_params: routeParams,
        fee_breakdown: {
          gas_cost_usd: quote.feeBreakdown.gasCostUsd,
          gas_cost_from_token: quote.feeBreakdown.gasCostFromToken,
        },
        expires_at: quote.expiresAt,
        permit: authorization ? {
          permit_supported: authorization.permitSupported,
          permit_required: authorization.permitRequired,
          token: authorization.token,
          spender: authorization.spender,
          owner: authorization.owner,
          value_raw: authorization.valueRaw,
          current_allowance_raw: authorization.currentAllowanceRaw,
          nonce: authorization.nonce,
          suggested_deadline: authorization.suggestedDeadline,
          domain: authorization.domain,
          eip712: authorization.typedData,
        } : null,
      },
      intentTypedData: {
        domain: deployment.eip712Domain,
        types: SERA_INTENT_TYPES,
        primaryType: "Intent",
        message: routeParams,
      },
      permitTypedData: authorization?.typedData ?? null,
      permitDeadline: permitDeadlineSeconds,
      approvalRequired: authorization?.authorizationKind === "approval",
      approvalSpender: authorization?.authorizationKind === "approval" ? authorization.spender : null,
      approvalAmountRaw: authorization?.authorizationKind === "approval" ? authorization.valueRaw : null,
      feeBreakdown: quote.feeBreakdown,
      quoteExpiresAt: quote.expiresAt,
      request: {
        ...quoteResult.finalRequest,
        from_symbol: payCoin,
        to_symbol: receiveCoin,
      },
    });
  } catch (e: any) {
    if (checkoutAttemptKeyForConflict && errorHasDatabaseConstraint(e, "uq_tx_active_checkout_attempt_key")) {
      const activeAttempt = await getActiveSeraSwapTransactionByCheckoutAttemptKey(checkoutAttemptKeyForConflict)
        .catch(() => undefined);
      if (activeAttempt) {
        res.status(409).json({
          error: "This wallet already has a Sera payment for this checkout in progress.",
          errorCode: "payment_attempt_in_progress",
          detail: { txId: activeAttempt.id, status: activeAttempt.status },
        });
        return;
      }
    }
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
function isSeraProvenNeverConnected(error: unknown): boolean {
  if (error instanceof SeraApiError) return false;
  for (let current: any = error, depth = 0; current && typeof current === "object" && depth < 5; current = current.cause, depth += 1) {
    const code = typeof current.code === "string" ? current.code.toUpperCase() : "";
    if (SERA_NEVER_CONNECTED_CODES.has(code) || /^ERR_TLS_|CERT|SSL/.test(code)) return true;
  }
  return false;
}

function parseSeraTransactionNotes(notes: string | null | undefined): Record<string, unknown> {
  if (!notes) return {};
  try {
    const parsed = JSON.parse(notes);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function timestampToUnixSeconds(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const milliseconds = new Date(value).getTime();
  if (!Number.isFinite(milliseconds) || milliseconds <= 0 || milliseconds % 1000 !== 0) return null;
  return String(milliseconds / 1000);
}

/** Reconstructs the exact Intent fields that were durably bound at quote time. */
function storedSeraIntent(tx: Transaction): SeraIntentMessage | null {
  const deadline = timestampToUnixSeconds(tx.intentDeadline);
  if (
    !tx.fromAddress
    || !tx.payTokenAddress
    || !tx.receiveTokenAddress
    || !tx.maximumPayAmountRaw
    || !tx.minimumReceiveAmountRaw
    || tx.initialDepositAmountRaw === null
    || !tx.routeUuid
    || !deadline
  ) return null;
  return {
    taker: tx.fromAddress,
    inputToken: tx.payTokenAddress,
    outputToken: tx.receiveTokenAddress,
    maxInputAmount: tx.maximumPayAmountRaw,
    minOutputAmount: tx.minimumReceiveAmountRaw,
    recipient: tx.toAddress,
    initialDepositAmount: tx.initialDepositAmountRaw,
    uuid: tx.routeUuid,
    deadline,
  };
}

function validSeraSignature(value: string): boolean {
  return value.length <= 16_386 && /^0x(?:[0-9a-fA-F]{2})+$/.test(value);
}

async function respondToPreviouslyClaimedSeraSwap(tx: Transaction, res: Response) {
  if (tx.status === "confirmed" || tx.submitState === "settled") {
    // A previous process may have committed the terminal database state and
    // crashed before synchronizing the linked order or delivering its webhook.
    // The durable outcome marker makes this safe to resume on every read.
    void deliverSeraSwapOutcomeEffects(tx).catch((error) => {
      logSeraOperationFailure("payment/swap/outcome-recovery", error);
    });
    res.json({
      success: true,
      status: "confirmed",
      tradeId: tx.tradeId ?? null,
      txHash: tx.settlementTxHash ?? tx.txHash ?? null,
      idempotent: true,
    });
    return;
  }
  if (tx.status === "failed" || tx.status === "canceled") {
    if (tx.status === "failed" && isSeraSwapTransaction(tx)) {
      void deliverSeraSwapOutcomeEffects(tx).catch((error) => {
        logSeraOperationFailure("payment/swap/outcome-recovery", error);
      });
    }
    res.status(409).json({
      success: false,
      status: tx.status,
      error: tx.status === "canceled" ? "Transaction was canceled" : "Sera swap failed",
      errorCode: tx.failureCode ?? (tx.status === "canceled" ? "canceled" : "settlement_failed"),
    });
    return;
  }
  void reconcileSeraSwapTransaction(tx).catch((error) => logSeraOperationFailure("payment/swap/reconcile-idempotent", error));
  const provisional = storedSeraProvisionalSettlement(tx);
  res.json({
    success: true,
    status: provisional ? "received" : "confirming",
    received: Boolean(provisional),
    finality: provisional ? "provisional" : null,
    tradeId: tx.tradeId ?? null,
    txHash: provisional?.txHash ?? tx.settlementTxHash ?? tx.txHash ?? null,
    idempotent: true,
  });
}

/** POST /api/payment/swap/submit - submit signed Sera swap intent */
paymentRouter.post("/payment/swap/submit", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
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

    if (!txId) { res.status(400).json({ error: "Missing txId", errorCode: "invalid_request" }); return; }
    if (!quoteUuid) { res.status(400).json({ error: "Missing quoteUuid", errorCode: "invalid_request" }); return; }
    if (!validSeraSignature(signature)) {
      res.status(400).json({ error: "Invalid Sera intent signature", errorCode: "invalid_request" });
      return;
    }
    if (permitSignature && !validSeraSignature(permitSignature)) {
      res.status(400).json({ error: "Invalid permit signature", errorCode: "invalid_request" });
      return;
    }

    const tx = await getTransactionById(txId);
    if (!tx) { res.status(404).json({ error: "Transaction not found" }); return; }
    if (!isSeraSwapTransaction(tx) || !tx.quoteUuid || !tx.intentHash) {
      res.status(409).json({ error: "Transaction is not a bound Sera swap quote", errorCode: "invalid_quote" });
      return;
    }
    if (tx.quoteUuid !== quoteUuid) {
      res.status(409).json({ error: "quoteUuid does not match this transaction", errorCode: "invalid_quote" });
      return;
    }
    if (tx.status === "confirmed" || tx.submitState === "settled") {
      await respondToPreviouslyClaimedSeraSwap(tx, res);
      return;
    }
    if (tx.status === "failed" || tx.status === "canceled") {
      await respondToPreviouslyClaimedSeraSwap(tx, res);
      return;
    }

    const route = storedSeraIntent(tx);
    if (
      !route
      || !tx.seraAddress
      || !/^0x[0-9a-fA-F]{40}$/.test(tx.seraAddress)
      || hashSeraIntentStruct(route).toLowerCase() !== tx.intentHash.toLowerCase()
    ) {
      res.status(409).json({ error: "Stored Sera route binding is invalid", errorCode: "invalid_quote" });
      return;
    }

    const storedPermitDeadline = timestampToUnixSeconds(tx.permitDeadline);
    if (tx.permitRequired === 1) {
      if (!permitSignature || permitDeadline === null || permitDeadline === undefined || permitDeadline === "") {
        res.status(400).json({ error: "This quote requires its bound Permit signature and deadline", errorCode: "allowance_insufficient" });
        return;
      }
      let submittedPermitDeadline: string;
      try {
        submittedPermitDeadline = BigInt(String(permitDeadline)).toString();
      } catch {
        res.status(400).json({ error: "Invalid permit deadline", errorCode: "invalid_request" });
        return;
      }
      if (!storedPermitDeadline || submittedPermitDeadline !== storedPermitDeadline) {
        res.status(409).json({ error: "Permit deadline does not match this quote", errorCode: "invalid_quote" });
        return;
      }
    } else if (permitSignature || (permitDeadline !== null && permitDeadline !== undefined && permitDeadline !== "")) {
      res.status(400).json({ error: "This quote does not accept Permit authorization", errorCode: "invalid_request" });
      return;
    }

    const settlementClient = CHAIN_CLIENTS[tx.chainId];
    if (!settlementClient) {
      res.status(409).json({ error: "Unsupported settlement chain", errorCode: "invalid_quote" });
      return;
    }
    const storedNotes = parseSeraTransactionNotes(tx.notes);
    const permitTypedData = storedNotes.permitTypedData;
    if (
      tx.permitRequired === 1
      && (!permitTypedData || typeof permitTypedData !== "object" || Array.isArray(permitTypedData))
    ) {
      res.status(409).json({ error: "Stored Permit binding is invalid", errorCode: "invalid_quote" });
      return;
    }

    // Verify control of the exact persisted taker before consuming the
    // single-use quote or claiming its order. PublicClient verification also
    // supports ERC-1271 smart-account signatures; Sera's later validation is
    // defense in depth, not the first authorization check.
    let intentSignatureValid = false;
    let permitSignatureValid = tx.permitRequired !== 1;
    try {
      intentSignatureValid = await settlementClient.verifyTypedData({
        address: tx.fromAddress,
        domain: {
          name: "Sera",
          version: "1",
          chainId: tx.chainId,
          verifyingContract: tx.seraAddress,
        },
        types: SERA_INTENT_TYPES,
        primaryType: "Intent",
        message: route,
        signature,
      });
      if (tx.permitRequired === 1) {
        permitSignatureValid = await settlementClient.verifyTypedData({
          ...(permitTypedData as Record<string, unknown>),
          address: tx.fromAddress,
          signature: permitSignature,
        });
      }
    } catch {
      res.status(503).json({
        error: "Wallet signature verification is temporarily unavailable. Please retry before this quote expires.",
        errorCode: "sera_unavailable",
      });
      return;
    }
    if (!intentSignatureValid || !permitSignatureValid) {
      res.status(403).json({ error: "Wallet signature does not authorize this Sera quote", errorCode: "invalid_signature" });
      return;
    }

    const body: Record<string, unknown> = {
      uuid: quoteUuid,
      signature,
    };
    if (permitSignature) {
      body.permit_signature = permitSignature;
      // Send the canonical value bound to this quote, not an equivalent client
      // spelling such as leading-zero decimal text.
      body.permit_deadline = storedPermitDeadline;
    }

    // A finalized block is the durable lower-bound recovery anchor if POST
    // /swap succeeds but its response is lost. Unlike a latest-head number it
    // cannot move ahead of the eventual canonical chain in a reorg and make a
    // valid settlement invisible to the negative-proof scan. Read it before
    // claiming the single-use quote: a failure here is safely retryable because
    // nothing has been submitted.
    try {
      const block = await withDirectScanTimeout(settlementClient.getBlock({ blockTag: "finalized" }), 8_000) as {
        number?: bigint | null;
        timestamp?: bigint | null;
      };
      const anchor = validateSeraSubmissionAnchor({
        blockNumber: block.number,
        blockTimestamp: block.timestamp,
        intentDeadline: route.deadline,
      });
      if (!anchor.valid) {
        if (anchor.reason === "intent_expired") {
          // Nothing has been claimed or sent yet. Let the client refresh this
          // exact pending row instead of persisting/replaying an authorization
          // whose Intent deadline can never be accepted.
          res.status(409).json({
            error: "This Sera quote has expired. Please request a fresh quote.",
            errorCode: "quote_stale",
          });
          return;
        }
        throw new Error(`Finalized submission anchor is ${anchor.reason}`);
      }
      submittedBlockNumber = anchor.blockNumber;
    } catch {
      res.status(503).json({
        error: "The settlement chain is temporarily unavailable. Please retry before this quote expires.",
        errorCode: "sera_unavailable",
      });
      return;
    }
    const claim = await claimSeraSwapSubmission({
      transactionId: txId,
      quoteUuid,
      intentHash: tx.intentHash,
      submittedBlockNumber,
    });
    if (claim.outcome === "not_found") {
      res.status(404).json({ error: "Transaction not found" });
      return;
    }
    if (claim.outcome === "binding_mismatch") {
      res.status(409).json({ error: "Sera quote binding changed before submission", errorCode: "invalid_quote" });
      return;
    }
    if (claim.outcome === "binding_conflict") {
      res.status(409).json({
        error: "Another payment has already claimed this checkout.",
        errorCode: "payment_already_submitted",
      });
      return;
    }
    if (claim.outcome === "already_claimed") {
      await respondToPreviouslyClaimedSeraSwap(claim.transaction, res);
      return;
    }
    if (claim.outcome === "invalid_state") {
      const stale = Boolean(
        (claim.transaction.quoteExpiresAt && new Date(claim.transaction.quoteExpiresAt).getTime() <= Date.now())
        || (claim.transaction.intentDeadline && new Date(claim.transaction.intentDeadline).getTime() <= Date.now()),
      );
      res.status(409).json({
        error: stale ? "This Sera quote has expired. Please request a fresh quote." : "This Sera swap is not in a submittable state.",
        errorCode: stale ? "quote_stale" : "invalid_quote",
      });
      return;
    }
    txForFailure = claim.transaction;
    const preSubmitNotes = JSON.stringify({
      ...parseSeraTransactionNotes(claim.transaction.notes),
      type: "sera_swap",
      submittedBlockNumber,
      seraStatus: "submitting",
    });
    await updateSeraSwapLifecycle(txId, { notes: preSubmitNotes, seraStatus: "submitting" });
    notifySseClients(txId, { status: "confirming" });

    const baseUrl = getSeraApiBaseUrlForChain(tx.chainId);
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

    const tradeId = typeof result.trade_id === "string" && result.trade_id.trim() ? result.trade_id.trim() : null;
    const seraStatus = typeof result.status === "string" ? result.status.toLowerCase() : "pending";
    const explicitlyRejected = result.success === false;
    if (!explicitlyRejected && (result.success !== true || !tradeId)) {
      // A 2xx response that does not satisfy Sera's documented success shape
      // cannot prove rejection. Preserve the at-most-once claim and recover
      // by Intent hash instead of telling the payer to submit another swap.
      throw new Error("Sera returned an indeterminate swap submission response");
    }
    seraOutcome = explicitlyRejected ? "rejected" : "accepted";
    seraTradeId = tradeId;
    const txHash = extractTransactionHash(result);
    const notes = JSON.stringify({
      ...parseSeraTransactionNotes(preSubmitNotes),
      type: "sera_swap",
      tradeId,
      seraStatus,
      submittedBlockNumber,
      seraSubmitResponse: result,
    });

    if (explicitlyRejected) {
      const reason = [result.error, result.message, result.error_code]
        .find((value): value is string => typeof value === "string" && value.trim().length > 0)
        ?? "Sera declined the swap";
      const code = typeof result.error_code === "string"
        ? result.error_code.toLowerCase()
        : "settlement_failed";
      // POST /swap was reached. Treat even an explicit provider rejection as
      // advisory until the finalized chain range proves this Intent did not
      // match: allowing a fresh attempt immediately could double-pay if the
      // response raced an accepted/on-chain order.
      const rejected = await claimSeraSwapPostNetworkUpdate({
        transactionId: txId,
        intentHash: tx.intentHash,
        quoteUuid,
        patch: {
          status: "confirming",
          notes: notesWithFailureReason(notes, reason),
          submitState: "settlement_unknown",
          seraStatus: "settlement_unknown",
          failureCode: `provider_rejected:${code}`.slice(0, 100),
        },
      });
      if (rejected.outcome !== "claimed") {
        if (rejected.outcome !== "not_found") await respondToPreviouslyClaimedSeraSwap(rejected.transaction, res);
        else res.status(404).json({ error: "Transaction not found" });
        return;
      }
      notifySseClients(txId, { status: "confirming" });
      void reconcileSeraSwapTransaction(rejected.transaction)
        .catch((error) => logSeraOperationFailure("payment/swap/reconcile-rejected", error));
      res.json({
        success: true,
        status: "confirming",
        tradeId,
        txHash,
        providerRejected: true,
        sera: result,
      });
      return;
    }

    const accepted = await claimSeraSwapPostNetworkUpdate({
      transactionId: txId,
      intentHash: tx.intentHash,
      quoteUuid,
      patch: {
      status: "confirming",
      tradeId,
      submitState: "submitted",
      seraStatus,
      notes,
      },
    });
    if (accepted.outcome !== "claimed") {
      if (accepted.outcome !== "not_found") await respondToPreviouslyClaimedSeraSwap(accepted.transaction, res);
      else res.status(404).json({ error: "Transaction not found" });
      return;
    }
    txForFailure = accepted.transaction;
    notifySseClients(txId, { status: "confirming", txHash, tradeId });
    void getTransactionById(txId)
      .then((fresh) => fresh ? reconcileSeraSwapTransaction(fresh) : undefined)
      .catch((error) => logSeraOperationFailure("payment/swap/reconcile", error));
    // Even when POST /swap says "settled", its documented response does not
    // include the order identity, merchant credit, or recipient proof. Only
    // reconciliation may turn this row into a confirmed payment.
    res.json({ success: true, status: "confirming", tradeId, txHash, sera: result });
  } catch (e: any) {
    logSeraOperationFailure("payment/swap/submit", e);
    const response = seraPaymentErrorResponse(e, "Unable to submit Sera swap");
    const providerCode = e instanceof SeraApiError ? String(e.errorCode || "").toUpperCase() : "";
    if (
      txForFailure
      && e instanceof SeraApiError
      && e.status === 409
      && providerCode === "QUOTE_STALE"
    ) {
      // This documented response proves this UUID was rejected before Sera
      // accepted an order, so the same transaction may be re-quoted safely.
      const stale = await reopenSeraSwapAfterStaleRejection({
        transactionId: txForFailure.id,
        intentHash: txForFailure.intentHash!,
        quoteUuid: txForFailure.quoteUuid!,
        notes: JSON.stringify({
          ...parseSeraTransactionNotes(txForFailure.notes),
          seraStatus: "quote_stale",
          seraSubmitError: e.message,
        }),
      }).catch((updateError) => {
        logSeraOperationFailure("payment/swap/status-update", updateError);
        return null;
      });
      if (stale && stale.outcome !== "claimed" && stale.outcome !== "not_found" && stale.transaction.status !== "pending") {
        await respondToPreviouslyClaimedSeraSwap(stale.transaction, res);
        return;
      }
      res.status(response.status).json(response.body);
      return;
    }
    if (txForFailure && (
      seraOutcome === "accepted"
      || seraOutcome === "rejected"
      || (seraOutcome === "unknown" && !isSeraProvenNeverConnected(e))
    )) {
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
      const existingNotes = parseSeraTransactionNotes((current ?? txForFailure).notes);
      const tradeId = seraTradeId
        ?? current?.tradeId
        ?? (typeof existingNotes.tradeId === "string" ? existingNotes.tradeId : null);
      const notes = JSON.stringify({
        ...existingNotes,
        type: "sera_swap",
        tradeId,
        submittedBlockNumber: existingNotes.submittedBlockNumber ?? submittedBlockNumber,
        seraSubmitError: e instanceof Error ? e.message : "Sera did not answer the swap submission",
      });
      const unknown = await claimSeraSwapPostNetworkUpdate({
        transactionId: txForFailure.id,
        intentHash: txForFailure.intentHash!,
        quoteUuid: txForFailure.quoteUuid!,
        patch: {
          status: "confirming",
          submitState: "settlement_unknown",
          seraStatus: "settlement_unknown",
          ...(tradeId ? { tradeId } : {}),
          failureCode: "settlement_unknown",
          notes,
        },
      }).catch((updateError) => {
        logSeraOperationFailure("payment/swap/status-update", updateError);
        return null;
      });
      if (unknown && unknown.outcome !== "claimed") {
        if (unknown.outcome !== "not_found") await respondToPreviouslyClaimedSeraSwap(unknown.transaction, res);
        else res.status(404).json({ error: "Transaction not found" });
        return;
      }
      const refreshed = unknown?.transaction ?? await getTransactionById(txForFailure.id).catch(() => undefined);
      if (refreshed) void reconcileSeraSwapTransaction(refreshed).catch((error) => logSeraOperationFailure("payment/swap/reconcile-unknown", error));
      res.json({ success: true, status: "confirming", tradeId, txHash: refreshed?.settlementTxHash ?? refreshed?.txHash ?? null });
      return;
    }
    if (txForFailure) {
      const failed = await claimSeraSwapPostNetworkUpdate({
        transactionId: txForFailure.id,
        intentHash: txForFailure.intentHash!,
        quoteUuid: txForFailure.quoteUuid!,
        patch: {
          status: "failed",
          submitState: "failed",
          seraStatus: "failed",
          failureCode: response.body.errorCode,
          notes: notesWithFailureReason(txForFailure.notes, response.body.error),
        },
      }).catch((failError) => {
        logSeraOperationFailure("payment/swap/status-update", failError);
        return null;
      });
      if (failed?.outcome === "claimed") await deliverSeraSwapOutcomeEffects(failed.transaction);
      else if (failed && failed.outcome !== "not_found") {
        await respondToPreviouslyClaimedSeraSwap(failed.transaction, res);
        return;
      }
    }
    res.status(response.status).json(response.body);
  }
});

/** POST /api/payment/notify — customer submits tx hash after sending */
paymentRouter.post("/payment/notify", async (req, res) => {
  try {
    const { txId, fromAddress } = req.body;
    const txHash = typeof req.body.txHash === "string" ? req.body.txHash.toLowerCase() : "";
    if (!txId || typeof txId !== "string") { res.status(400).json({ error: "Missing txId" }); return; }
    if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) { res.status(400).json({ error: "Invalid txHash" }); return; }
    let tx = await getTransactionById(txId);
    if (!tx) { res.status(404).json({ error: "Transaction not found" }); return; }
    if (isSeraSwapTransaction(tx)) {
      res.status(409).json({
        error: "Sera swap payments must be submitted through the signed swap endpoint.",
        errorCode: "invalid_request",
      });
      return;
    }
    const staleCanceled = await cancelStaleMerchantTransactions(tx.merchantId, [tx]);
    if (staleCanceled > 0) tx = await getTransactionById(txId);
    if (!tx) { res.status(404).json({ error: "Transaction not found" }); return; }
    if (tx.status === "canceled") { res.status(409).json({ error: "Transaction was canceled" }); return; }
    if (tx.txHash && tx.txHash.toLowerCase() !== txHash) { res.status(409).json({ error: "Transaction already has a different txHash" }); return; }
    if (fromAddress) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(fromAddress)) { res.status(400).json({ error: "Invalid fromAddress" }); return; }
    }
    // `fromAddress` in the request is advisory only. The authoritative payer
    // is decoded and screened from the matching ERC-20 receipt log. Claiming
    // the hash and linked order is one database transaction so an old direct
    // request cannot overwrite a Sera payment that already owns that order.
    const notification = await claimDirectTransactionNotification({ transactionId: txId, txHash });
    if (notification.outcome === "not_found") {
      res.status(404).json({ error: "Transaction not found" });
      return;
    }
    if (notification.outcome === "hash_conflict") {
      res.status(409).json({ error: "This transaction hash is already associated with another payment" });
      return;
    }
    if (notification.outcome === "binding_conflict") {
      res.status(409).json({ error: "This order is already assigned to another payment" });
      return;
    }
    if (notification.outcome === "invalid_state") {
      res.status(409).json({ error: "This direct payment is no longer awaiting a transaction hash" });
      return;
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
  res.setHeader("Cache-Control", "no-store");
  try {
    let tx = await getTransactionById(req.params.txId);
    if (!tx) { res.status(404).json({ error: "Not found" }); return; }
    if (tx.status === "confirming") {
      tx = await reconcileSeraSwapTransaction(tx);
      if (tx.status === "confirming" && tx.txHash && !isSeraSwapTransaction(tx)) {
        scheduleTransactionVerification(tx.id, tx.txHash as `0x${string}`);
      }
    } else if (isSeraSwapTransaction(tx) && (tx.status === "confirmed" || tx.status === "failed")) {
      void deliverSeraSwapOutcomeEffects(tx).catch((error) => {
        logSeraOperationFailure("payment/swap/outcome-status-recovery", error);
      });
    }
    const canceled = await cancelStaleMerchantTransactions(tx.merchantId, [tx]);
    if (canceled > 0) tx = await getTransactionById(req.params.txId);
    if (!tx) { res.status(404).json({ error: "Not found" }); return; }
    const merchant = await getMerchantById(tx.merchantId);
    const provisional = tx.status === "confirming" ? storedSeraProvisionalSettlement(tx) : null;
    res.json({
      txId: tx.id,
      status: provisional ? "received" : tx.status,
      received: Boolean(provisional),
      finality: provisional
        ? "provisional"
        : isSeraSwapTransaction(tx) && tx.status === "confirmed" && tx.verified === 1
          ? "finalized"
          : null,
      provisionalConfirmations: provisional?.confirmations ?? null,
      verified: tx.verified === 1,
      txHash: provisional?.txHash ?? tx.txHash,
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
    let seraVaultAddresses: ReadonlySet<string>;
    try {
      seraVaultAddresses = await getSeraVaultExclusionSet(chainId);
    } catch (error) {
      logSeraOperationFailure("payment/direct/vault-config", error);
      // Fail closed: without the live Vault address this scanner cannot safely
      // distinguish a direct payment from a Sera settlement payout.
      res.json({
        status: "pending",
        fromBlock: requestedFromBlock?.toString() ?? null,
        warning: "Payment scanner configuration is temporarily unavailable",
      });
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
        found = await withDirectScanTimeout(findDirectTransfer({
          toAddress,
          coin,
          amount,
          chainId,
          fromBlock: cursor,
          toBlock,
          excludedFromAddresses: seraVaultAddresses,
        }), remaining);
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
const SERA_PROVISIONAL_CONFIRMATIONS = parseSeraProvisionalConfirmations(ENV.seraProvisionalConfirmations);
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

type SeraSettlementDeployment = {
  seraAddress: `0x${string}`;
  vaultAddress: `0x${string}`;
  sorAddress: `0x${string}`;
};

function parseStoredSeraSettlementDeployment(value: unknown): SeraSettlementDeployment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const addresses = [record.seraAddress, record.vaultAddress, record.sorAddress]
    .map((address) => typeof address === "string" ? address.trim().toLowerCase() : "");
  if (addresses.some((address) => !/^0x[0-9a-f]{40}$/.test(address))) return null;
  if (new Set(addresses).size !== addresses.length) return null;
  return {
    seraAddress: addresses[0] as `0x${string}`,
    vaultAddress: addresses[1] as `0x${string}`,
    sorAddress: addresses[2] as `0x${string}`,
  };
}

function parseStoredTokenDecimals(value: unknown): number | null {
  const decimals = typeof value === "number" ? value : Number.NaN;
  return Number.isInteger(decimals) && decimals >= 0 && decimals <= 255 ? decimals : null;
}

function reportedSeraSettlementHash(notes: Record<string, unknown>): `0x${string}` | null {
  const economics = notes.seraSettlementEconomics;
  if (!economics || typeof economics !== "object" || Array.isArray(economics)) return null;
  const hash = (economics as Record<string, unknown>).txHash;
  return typeof hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(hash)
    ? hash.toLowerCase() as `0x${string}`
    : null;
}

function blockTimestampToDate(value: unknown): Date | null {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") return null;
  try {
    const seconds = BigInt(value);
    if (seconds < 0n || seconds > 8_640_000_000_000n) return null;
    const date = new Date(Number(seconds) * 1000);
    return Number.isFinite(date.getTime()) ? date : null;
  } catch {
    return null;
  }
}

type StoredSeraProvisionalSettlement = {
  txHash: `0x${string}`;
  blockNumber: bigint;
  blockHash: `0x${string}`;
  confirmations: 1 | 2;
  observedAt: Date;
};

function storedSeraProvisionalSettlement(tx: Transaction): StoredSeraProvisionalSettlement | null {
  const txHash = tx.provisionalSettlementTxHash?.trim().toLowerCase() ?? "";
  const blockHash = tx.provisionalSettlementBlockHash?.trim().toLowerCase() ?? "";
  const blockNumber = parseStoredBlockNumber(tx.provisionalSettlementBlockNumber);
  const confirmations = Number(tx.provisionalSettlementConfirmations);
  const observedAt = tx.provisionalSettlementAt ? new Date(tx.provisionalSettlementAt) : null;
  if (
    !/^0x[0-9a-f]{64}$/.test(txHash)
    || !/^0x[0-9a-f]{64}$/.test(blockHash)
    || blockNumber === null
    || (confirmations !== 1 && confirmations !== 2)
    || !observedAt
    || !Number.isFinite(observedAt.getTime())
  ) return null;
  return {
    txHash: txHash as `0x${string}`,
    blockNumber,
    blockHash: blockHash as `0x${string}`,
    confirmations,
    observedAt,
  };
}

const SERA_NO_SETTLEMENT_REASON = "No Sera settlement was found in finalized blocks before the signed swap deadline.";

async function claimExpiredSeraSwapAfterFinalizedScan({
  tx,
  notes,
  intentHash,
  scanFromBlock,
  scanThroughBlock,
  scanThroughTimestamp,
}: {
  tx: Transaction;
  notes: Record<string, unknown>;
  intentHash: `0x${string}`;
  scanFromBlock: bigint;
  scanThroughBlock: bigint;
  scanThroughTimestamp: Date;
}): Promise<Transaction> {
  const deadlineMs = tx.intentDeadline ? new Date(tx.intentDeadline).getTime() : Number.NaN;
  const nowMs = Date.now();
  if (
    !Number.isFinite(deadlineMs)
    || deadlineMs > nowMs
    || deadlineMs > scanThroughTimestamp.getTime()
    || scanThroughTimestamp.getTime() > nowMs
  ) {
    return tx;
  }

  const failureNotes = notesWithFailureReason(JSON.stringify({
    ...notes,
    seraFinalizedScan: {
      fromBlock: scanFromBlock.toString(),
      throughBlock: scanThroughBlock.toString(),
      throughTimestamp: scanThroughTimestamp.toISOString(),
      result: "no_valid_settlement",
    },
  }), SERA_NO_SETTLEMENT_REASON);
  const claim = await claimSeraSwapTerminalFailure({
    transactionId: tx.id,
    intentHash,
    ...(tx.quoteUuid ? { expectedQuoteUuid: tx.quoteUuid } : {}),
    ...(tx.tradeId ? { expectedTradeId: tx.tradeId } : {}),
    finalizedScanFromBlock: scanFromBlock.toString(),
    finalizedScanThroughBlock: scanThroughBlock.toString(),
    finalizedScanThroughTimestamp: scanThroughTimestamp,
    patch: {
      notes: failureNotes,
      seraStatus: "failed",
    },
  });
  if (claim.outcome === "claimed") {
    await deliverSeraSwapOutcomeEffects(claim.transaction);
    return claim.transaction;
  }
  return claim.outcome === "not_found" ? tx : claim.transaction;
}

async function performSeraSwapOnChainReconciliation(tx: Transaction, notes: Record<string, unknown>): Promise<Transaction> {
  const boundIntent = storedSeraIntent(tx);
  const storedIntentHash = tx.intentHash;
  const intentHash = boundIntent
    && storedIntentHash
    && /^0x[0-9a-fA-F]{64}$/.test(storedIntentHash)
    && hashSeraIntentStruct(boundIntent).toLowerCase() === storedIntentHash.toLowerCase()
    ? storedIntentHash.toLowerCase() as `0x${string}`
    : null;
  const client = CHAIN_CLIENTS[Number(tx.chainId)];
  if (!intentHash || !client || !boundIntent) return tx;

  const submittedBlock = parseStoredBlockNumber(tx.submittedBlockNumber);
  const receiveTokenAddress = tx.receiveTokenAddress?.trim().toLowerCase();
  if (
    submittedBlock === null
    || !tx.targetReceiveAmountRaw
    || !receiveTokenAddress
    || !/^0x[0-9a-f]{40}$/.test(receiveTokenAddress)
  ) return tx;

  // New quotes persist their exact contract deployment and token precision so
  // config/registry rotations cannot orphan an already-signed Intent. Older
  // rows fall back to the currently validated Sera deployment and registry.
  const storedDeployment = parseStoredSeraSettlementDeployment({
    seraAddress: tx.seraAddress,
    vaultAddress: tx.seraVaultAddress,
    sorAddress: tx.seraSorAddress,
  }) ?? parseStoredSeraSettlementDeployment(notes.seraDeployment);
  const deployment = storedDeployment ?? await getSeraDeploymentForChain(Number(tx.chainId), tx.merchantId);
  let tokenDecimals = parseStoredTokenDecimals(tx.receiveTokenDecimals)
    ?? parseStoredTokenDecimals(notes.receiveTokenDecimals);
  if (tokenDecimals === null) {
    const token = await resolveSeraTokenForChain(tx.chainId, tx.coin);
    if (token.address.toLowerCase() !== receiveTokenAddress) return tx;
    tokenDecimals = token.decimals;
  }

  // A positive settlement can be acknowledged at the configured confirmation
  // depth after re-checking its successful receipt and canonical block hash.
  // Absence is fundamentally different: only a finalized head can prove that
  // an expired Intent never matched. Fetch both independently so an RPC that
  // temporarily cannot serve `finalized` does not delay a real positive match.
  const [latestBlockResult, finalizedBlockResult] = await Promise.allSettled([
    withDirectScanTimeout(client.getBlockNumber(), 8_000),
    withDirectScanTimeout(client.getBlock({ blockTag: "finalized" }), 8_000),
  ]);
  const latestBlockNumber = latestBlockResult.status === "fulfilled"
    ? parseStoredBlockNumber(latestBlockResult.value)
    : null;
  const finalizedBlock = finalizedBlockResult.status === "fulfilled"
    ? finalizedBlockResult.value as { number?: bigint | null; timestamp?: bigint | null }
    : null;
  const finalizedBlockNumber = parseStoredBlockNumber(finalizedBlock?.number);
  const finalizedBlockTimestamp = blockTimestampToDate(finalizedBlock?.timestamp);
  const provisionalScanHead = latestBlockNumber === null
    ? null
    : seraProvisionalSettlementScanHead(latestBlockNumber, SERA_PROVISIONAL_CONFIRMATIONS);
  const availableScanHeads = [provisionalScanHead, finalizedBlockNumber]
    .filter((blockNumber): blockNumber is bigint => blockNumber !== null);
  if (availableScanHeads.length === 0) return tx;
  const availableScanHead = availableScanHeads.reduce((highest, blockNumber) => (
    blockNumber > highest ? blockNumber : highest
  ));

  // Re-scan from the durable pre-submit anchor on every attempt. Intent expiry
  // is capped at five minutes while this bound spans ~100 minutes on Ethereum,
  // so one gap-free range always covers every block in which this Intent could
  // validly settle. This avoids trusting a cursor written by another process.
  const fromBlock = submittedBlock > 2n ? submittedBlock - 2n : 0n;
  if (fromBlock > availableScanHead) return tx;
  const scanToBlock = fromBlock + SERA_CHAIN_SCAN_MAX_BLOCKS - 1n < availableScanHead
    ? fromBlock + SERA_CHAIN_SCAN_MAX_BLOCKS - 1n
    : availableScanHead;
  const expectedRawAmount = BigInt(tx.targetReceiveAmountRaw);
  let sawBoundIntentMatched = tx.intentMatchedAt != null;
  const durableMatchedTxHash = tx.intentMatchedTxHash?.trim().toLowerCase() ?? "";
  const durableMatchedBlockNumber = parseStoredBlockNumber(tx.intentMatchedBlockNumber);
  let durableProvisional = storedSeraProvisionalSettlement(tx);
  if (durableProvisional) sawBoundIntentMatched = true;

  if (durableProvisional) {
    try {
      const canonicalBlock = await withDirectScanTimeout(client.getBlock({
        blockNumber: durableProvisional.blockNumber,
      }), 8_000) as { hash?: unknown };
      const canonicalBlockHash = typeof canonicalBlock.hash === "string"
        ? canonicalBlock.hash.trim().toLowerCase()
        : "";
      if (/^0x[0-9a-f]{64}$/.test(canonicalBlockHash) && canonicalBlockHash !== durableProvisional.blockHash) {
        const cleared = await clearSeraSwapProvisionalSettlement({
          transactionId: tx.id,
          quoteUuid: tx.quoteUuid!,
          intentHash,
          txHash: durableProvisional.txHash,
          blockNumber: durableProvisional.blockNumber.toString(),
          blockHash: durableProvisional.blockHash,
        });
        if (cleared.outcome === "cleared") {
          tx = cleared.transaction;
          notes = parseSeraTransactionNotes(tx.notes);
          durableProvisional = null;
          sawBoundIntentMatched = tx.intentMatchedAt != null;
          notifySseClients(tx.id, { status: "confirming", received: false });
        } else if (cleared.outcome !== "already_clear" && cleared.outcome !== "evidence_mismatch") {
          return cleared.outcome === "not_found" ? tx : cleared.transaction;
        }
      }
    } catch {
      // A timeout or missing RPC response does not prove a reorg. Keep the
      // observation until a canonical block at the same height explicitly
      // returns a different hash.
    }
  }

  for (let chunkFrom = fromBlock; chunkFrom <= scanToBlock; chunkFrom += SERA_CHAIN_SCAN_CHUNK_SIZE) {
    const chunkTo = chunkFrom + SERA_CHAIN_SCAN_CHUNK_SIZE - 1n < scanToBlock
      ? chunkFrom + SERA_CHAIN_SCAN_CHUNK_SIZE - 1n
      : scanToBlock;
    const queriedMatchedLogs = await withDirectScanTimeout(client.getLogs({
      address: deployment.sorAddress,
      event: SERA_INTENT_MATCHED_EVENT,
      args: {
        intentHash,
        ...(tx.fromAddress ? { taker: tx.fromAddress.toLowerCase() as `0x${string}` } : {}),
      },
      fromBlock: chunkFrom,
      toBlock: chunkTo,
    }), 8_000);
    const matchedLogs = [...queriedMatchedLogs as any[]];
    if (
      tx.intentMatchedAt != null
      && /^0x[0-9a-f]{64}$/.test(durableMatchedTxHash)
      && durableMatchedBlockNumber != null
      && durableMatchedBlockNumber >= chunkFrom
      && durableMatchedBlockNumber <= chunkTo
      && !matchedLogs.some((log) => String(log.transactionHash || "").toLowerCase() === durableMatchedTxHash)
    ) {
      // A provider cannot erase positive evidence another replica already
      // persisted. Re-query the payout block even if this RPC omits the SOR
      // event on a later scan.
      matchedLogs.push({
        transactionHash: durableMatchedTxHash,
        blockNumber: durableMatchedBlockNumber,
      });
    }
    if (
      durableProvisional
      && durableProvisional.blockNumber >= chunkFrom
      && durableProvisional.blockNumber <= chunkTo
      && !matchedLogs.some((log) => String(log.transactionHash || "").toLowerCase() === durableProvisional!.txHash)
    ) {
      // Once this height is finalized, the previously receipt-verified
      // provisional envelope is safe to promote even if a later getLogs call
      // is incomplete. Its block hash was rechecked above.
      matchedLogs.push({
        transactionHash: durableProvisional.txHash,
        blockNumber: durableProvisional.blockNumber,
        blockHash: durableProvisional.blockHash,
      });
    }

    for (const matchedLog of matchedLogs) {
      const txHash = String(matchedLog.transactionHash || "").toLowerCase();
      const blockNumber = parseStoredBlockNumber(matchedLog.blockNumber);
      if (!/^0x[0-9a-f]{64}$/.test(txHash) || blockNumber === null) continue;
      const observationStage = classifySeraSettlementObservationStage({
        settlementBlockNumber: blockNumber,
        provisionalScanHead,
        finalizedBlockNumber,
      });
      if (observationStage === "immature") continue;
      const matchedAtFinalizedHead = observationStage === "finalized";

      // Finding the exact bound log at/before finalized is already enough to
      // forbid a negative decision in this pass. Receipt or payout RPC failure
      // is incomplete corroboration, never proof that the event was absent.
      if (matchedAtFinalizedHead) sawBoundIntentMatched = true;

      // getLogs can race a short reorg. Before persisting or notifying, require
      // the transaction's successful receipt and verify that its receipt block
      // hash is still the canonical hash at that exact height.
      let receipt: Record<string, unknown>;
      let canonicalBlock: Record<string, unknown>;
      try {
        [receipt, canonicalBlock] = await Promise.all([
          withDirectScanTimeout(client.getTransactionReceipt({ hash: txHash as `0x${string}` }), 8_000),
          withDirectScanTimeout(client.getBlock({ blockNumber }), 8_000),
        ]) as [Record<string, unknown>, Record<string, unknown>];
      } catch {
        continue;
      }
      if (!isCanonicalSuccessfulSeraSettlement({
        expectedTransactionHash: txHash,
        expectedBlockNumber: blockNumber,
        matchedLogBlockHash: matchedLog.blockHash,
        matchedLogRemoved: matchedLog.removed,
        receipt,
        canonicalBlock,
      })) continue;

      sawBoundIntentMatched = true;

      // Only finalized positive evidence is a permanent no-failure marker. An
      // early-confirmation candidate stays ephemeral until the complete payout
      // proof is committed, so a pre-commit reorg cannot strand the row behind
      // a stale marker forever.
      if (matchedAtFinalizedHead) {
        const marker = await markSeraIntentMatchedEvidence({
          transactionId: tx.id,
          quoteUuid: tx.quoteUuid!,
          intentHash,
          settlementTxHash: txHash,
          blockNumber: blockNumber.toString(),
        });
        if (marker.outcome === "not_found") return tx;
        if (marker.outcome === "already_confirmed") return marker.transaction;
        if (marker.outcome === "binding_mismatch" || marker.outcome === "invalid_state") {
          return marker.transaction;
        }
      }

      const payoutLogs = await withDirectScanTimeout(client.getLogs({
        address: receiveTokenAddress as `0x${string}`,
        event: ERC20_TRANSFER_EVENT,
        args: {
          from: deployment.vaultAddress,
          to: tx.toAddress.toLowerCase() as `0x${string}`,
        },
        fromBlock: blockNumber,
        toBlock: blockNumber,
      }), 8_000);
      const payout = corroborateSeraIntentPayout({
        settlementTxHash: txHash,
        outputTokenAddress: receiveTokenAddress,
        vaultAddress: deployment.vaultAddress,
        recipientAddress: tx.toAddress,
        signedMinimumOutputRaw: boundIntent.minOutputAmount,
        requiredOutputRaw: expectedRawAmount.toString(),
        transferLogs: payoutLogs as any[],
      });
      if (!payout) continue;

      const providerReportedHash = reportedSeraSettlementHash(notes);
      const providerHashMismatch = Boolean(providerReportedHash && providerReportedHash !== txHash);
      if (providerHashMismatch) {
        // GET /orders is useful accounting evidence, but the exact canonical
        // Intent event and payout are authoritative. A stale provider hash
        // must never hide a real merchant payment or make it fail.
        console.warn("[payment/swap/reconcile-chain] Sera order hash differs from authoritative on-chain settlement");
      }
      const settlementEvidence = {
        intentHash,
        txHash,
        blockNumber: blockNumber.toString(),
        blockHash: String(receipt.blockHash).toLowerCase(),
        signedMinimumOutputRaw: boundIntent.minOutputAmount,
        requiredOutputRaw: expectedRawAmount.toString(),
        corroboratingVaultTransferCount: payout.observedTransferCount,
        // SeraBatcher may include several intents in this transaction, so
        // transfer values are deliberately not summed as actual economics.
        verifiedAgainst: "IntentMatchedEnvelope+VaultTransferPresence+CanonicalReceipt",
      };

      if (!matchedAtFinalizedHead) {
        const provisional = await claimSeraSwapProvisionalSettlement({
          transactionId: tx.id,
          quoteUuid: tx.quoteUuid!,
          intentHash,
          txHash,
          blockNumber: blockNumber.toString(),
          blockHash: settlementEvidence.blockHash,
          confirmations: SERA_PROVISIONAL_CONFIRMATIONS,
          ...(tx.tradeId ? { expectedTradeId: tx.tradeId } : {}),
        });
        if (provisional.outcome === "not_found") return tx;
        if (provisional.outcome === "binding_mismatch" || provisional.outcome === "invalid_state") {
          return provisional.transaction;
        }
        if (provisional.outcome === "evidence_conflict") {
          // Never replace one durable observation with another implicitly. A
          // canonical block-hash mismatch must clear the first envelope before
          // any new one can be shown as received.
          return provisional.transaction;
        }
        if (provisional.outcome === "claimed") {
          notifySseClients(tx.id, {
            status: "received",
            received: true,
            finality: "provisional",
            txHash,
            confirmations: SERA_PROVISIONAL_CONFIRMATIONS,
          });
        }
        return provisional.transaction;
      }

      const merchant = await getMerchantById(tx.merchantId);
      if (!merchant) return tx;
      const settlementNotes = JSON.stringify({
        ...notes,
        seraStatus: "settled",
        ...(providerHashMismatch ? {
          seraOrderHashMismatch: {
            reportedTxHash: providerReportedHash,
            verifiedTxHash: txHash,
            observedAt: new Date().toISOString(),
          },
        } : {}),
        seraOnchainSettlement: { ...settlementEvidence, confirmationPolicy: "finalized" },
      });
      // Do not persist a half-settled `settled + confirming` state. The CAS
      // below writes proof, final state and notification ownership together.
      const pending: Transaction = {
        ...tx,
        notes: settlementNotes,
      };
      const confirmedOutputRaw = pending.actualReceiveAmountRaw;
      return confirmPendingDirectTransfer({
        pending,
        merchant,
        txHash: txHash as `0x${string}`,
        fromAddress: tx.fromAddress,
        toAddress: tx.toAddress,
        coin: tx.coin,
        amount: confirmedOutputRaw
          ? fromRawTokenAmount(BigInt(confirmedOutputRaw), tokenDecimals)
          : String(tx.amount),
        verified: true,
      });
    }
  }

  const current = await getTransactionById(tx.id) ?? tx;
  const currentNotes = parseSeraTransactionNotes(current.notes);
  if (sawBoundIntentMatched) {
    console.warn("[payment/swap/reconcile-chain] Canonical IntentMatched is awaiting merchant payout corroboration", {
      transactionId: tx.id,
      intentHash,
    });
    const pendingEvidence = await claimSeraSwapPostNetworkUpdate({
      transactionId: current.id,
      intentHash,
      quoteUuid: current.quoteUuid!,
      patch: {
        status: "confirming",
        submitState: "settlement_unknown",
        seraStatus: "settlement_unknown",
        failureCode: "payout_evidence_pending",
        notes: JSON.stringify({
          ...currentNotes,
          seraStatus: "settlement_unknown",
          seraOnchainEvidence: {
            state: "intent_matched_payout_pending",
            intentHash,
            txHash: current.intentMatchedTxHash,
            blockNumber: current.intentMatchedBlockNumber,
            observedAt: new Date().toISOString(),
          },
        }),
      },
    });
    return pendingEvidence.outcome === "not_found" ? current : pendingEvidence.transaction;
  }
  // Never derive negative proof from the faster head. A swap may fail only
  // after the finalized range reaches its signed deadline with no match.
  if (finalizedBlockNumber === null || !finalizedBlockTimestamp || fromBlock > finalizedBlockNumber) return current;
  const finalizedScanToBlock = fromBlock + SERA_CHAIN_SCAN_MAX_BLOCKS - 1n < finalizedBlockNumber
    ? fromBlock + SERA_CHAIN_SCAN_MAX_BLOCKS - 1n
    : finalizedBlockNumber;
  let scanThroughTimestamp: Date | null = finalizedBlockTimestamp;
  if (finalizedScanToBlock !== finalizedBlockNumber) {
    const scanThroughBlock = await withDirectScanTimeout(
      client.getBlock({ blockNumber: finalizedScanToBlock }),
      8_000,
    ) as { timestamp?: bigint | null };
    scanThroughTimestamp = blockTimestampToDate(scanThroughBlock.timestamp);
  }
  if (!scanThroughTimestamp) return current;
  return claimExpiredSeraSwapAfterFinalizedScan({
    tx: current,
    notes: currentNotes,
    intentHash,
    scanFromBlock: fromBlock,
    scanThroughBlock: finalizedScanToBlock,
    scanThroughTimestamp,
  });
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
  const reason = "QR watch expired after 5 minutes without payment.";
  const cancellation = await claimDirectTransactionCancellation({
    transactionId: tx.id,
    memo: tx.memo || reason.slice(0, 200),
    notes: notesWithCancellationReason(tx.notes, reason),
  });
  return cancellation.outcome === "claimed";
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
    if (!isDirectTransferCandidate(tx)) return false;
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
}): Promise<boolean> {
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
    const delivery = sendWebhook(
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
    );
    // Sera terminal state is recovered from a durable queue, so its completion
    // marker must be written only after the webhook request really succeeds.
    // Direct-transfer behavior stays fire-and-forget for backward compatibility.
    if (source === "sera_swap") return delivery;
    void delivery.catch((error) => logSeraOperationFailure("payment-notification", error));
  }
  return true;
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
  const source = isSeraSwapTransaction(pending) ? "sera_swap" : "direct_wallet_qr";
  let finalized: Transaction;
  if (source === "sera_swap") {
    if (!pending.intentHash || !pending.quoteUuid) {
      console.warn("[payment/swap/confirm] Refused settlement without durable quote and Intent binding");
      return pending;
    }
    const claim = await claimSeraSwapSettlementConfirmation({
      transactionId: pending.id,
      intentHash: pending.intentHash,
      txHash,
      expectedQuoteUuid: pending.quoteUuid,
      ...(pending.tradeId ? { expectedTradeId: pending.tradeId } : {}),
      patch: {
        notes: pending.notes,
        actualPayAmountRaw: pending.actualPayAmountRaw,
        // For SeraBatcher transactions, raw ERC-20 values cannot be safely
        // aggregated across intents. Only API-validated economics are stored
        // as the actual receive amount; IntentMatched proves the signed floor.
        actualReceiveAmountRaw: pending.actualReceiveAmountRaw,
        feeAmountRaw: pending.feeAmountRaw,
        feeTokenAddress: pending.feeTokenAddress,
      },
    });
    if (claim.outcome === "already_confirmed") {
      await deliverSeraSwapOutcomeEffects(claim.transaction, merchant);
      return claim.transaction;
    }
    if (claim.outcome !== "claimed") {
      console.warn("[payment/swap/confirm] Settlement confirmation was not claimed", { outcome: claim.outcome });
      return claim.outcome === "not_found" ? pending : claim.transaction;
    }
    finalized = claim.transaction;
    await deliverSeraSwapOutcomeEffects(finalized, merchant);
    return finalized;
  } else {
    const claim = await claimDirectTransactionConfirmation({
      transactionId: pending.id,
      txHash,
      fromAddress: fromAddress?.toLowerCase() || null,
      payCoin: pending.payCoin || coin,
      payAmount: pending.payAmount || amount,
      notifiedAt: new Date(),
      webhookSentAt: merchant.webhookUrl ? new Date() : null,
    });
    if (claim.outcome === "already_confirmed") return claim.transaction;
    if (claim.outcome !== "claimed") {
      console.warn("[payment/direct/confirm] Direct confirmation was not claimed", { outcome: claim.outcome });
      return claim.outcome === "not_found" ? pending : claim.transaction;
    }
    finalized = claim.transaction;
  }
  notifySseClients(finalized.id, { status: "confirmed", txHash, verified });
  await notifyRecordedDirectTransfer({
    merchant,
    txId: finalized.id,
    txHash,
    coin: finalized.coin,
    amount,
    payCoin: finalized.payCoin || coin,
    payAmount: finalized.payAmount || amount,
    fromAddress,
    toAddress,
    verified,
    source: "direct_wallet_qr",
  });
  return finalized;
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
  const seraVaultAddresses = await getSeraVaultExclusionSet(chainId, merchant.id);

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
    // Swap payouts are claimed only by the IntentMatched + same-transaction
    // Vault-transfer reconciler. Never let the generic sweep reserve their
    // hash or create a competing direct-payment row.
    if (!fromAddress || seraVaultAddresses.has(fromAddress)) continue;
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
  await assertDirectTransferSender(fromAddress, chainId);
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
  await assertDirectTransferSender(fromAddress, chainId);
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
  excludedFromAddresses,
}: {
  toAddress: string;
  coin: string;
  amount: string;
  chainId: number;
  fromBlock: bigint;
  toBlock: bigint;
  excludedFromAddresses: ReadonlySet<string>;
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
    const fromAddress = typeof args.from === "string" ? args.from.toLowerCase() : null;
    if (!fromAddress || excludedFromAddresses.has(fromAddress)) continue;
    const entry: DirectTransferCandidate = {
      txHash: txHash as `0x${string}`,
      fromAddress,
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
  if (!tx || tx.status !== "confirming" || isSeraSwapTransaction(tx)) return;

  const chainId = tx.chainId ?? SERA_MAINNET_CHAIN_ID;
  const client = CHAIN_CLIENTS[chainId];
  if (!client) {
    console.error(`[verify] No client for chainId ${chainId}`);
    await releaseRejectedDirectSubmission(
      tx,
      txHash,
      `No settlement RPC is configured for chain ${chainId}.`,
      "settlement_rpc_unavailable",
    );
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
    await releaseRejectedDirectSubmission(
      tx,
      txHash,
      "The submitted transaction reverted on-chain.",
      "transaction_reverted",
    );
    return;
  }

  // Verify the Transfer event matches expected coin, toAddress, and amount
  const token = await resolveSeraTokenForChain(chainId, tx.coin).catch(() => null);
  const coinAddress = token?.address as `0x${string}` | undefined;
  if (!token || !coinAddress) {
    console.warn(`[verify] Unknown coin ${tx.coin} on chain ${chainId}`);
    await releaseRejectedDirectSubmission(
      tx,
      txHash,
      `Token ${tx.coin} is not in the active Sera registry for chain ${chainId}.`,
      "token_registry_unavailable",
    );
    return;
  }

  // Parse Transfer logs from the ERC-20 contract
  // Combine the current deployment with every Vault bound to a persisted
  // quote. If this lookup fails, verification fails closed and the normal
  // backoff retries instead of guessing whether a swap payout was direct.
  const seraVaultAddresses = await getSeraVaultExclusionSet(chainId, tx.merchantId);
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
      await releaseRejectedDirectSubmission(
        tx,
        txHash,
        `Stored amount ${tx.amount} cannot be expressed in ${tx.coin}'s ${tokenDecimals}-decimal precision.`,
        "invalid_stored_amount",
      );
      return;
    }
    expectedRaw = BigInt(Math.round(scaled));
  }
  const transferEvidence: DecodedErc20TransferEvidence[] = [];
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({ abi: ERC20_ABI, data: log.data, topics: log.topics as any }) as any;
      if (decoded.eventName !== "Transfer") continue;
      transferEvidence.push({
        tokenAddress: log.address,
        fromAddress: decoded.args?.from,
        toAddress: decoded.args?.to,
        amountRaw: decoded.args?.value,
      });
    } catch { /* skip malformed log */ }
  }
  const selectedTransfer = selectDirectTransferEvidence({
    transfers: transferEvidence,
    expectedTokenAddress: coinAddress,
    expectedRecipientAddress: tx.toAddress,
    expectedAmountRaw: expectedRaw,
    seraVaultAddresses,
  });

  if (selectedTransfer?.kind === "sera_vault") {
    // The hash belongs to swap reconciliation, not this direct-payment watch.
    // Release the tentative claim without failing the linked order, so a real
    // direct transfer may still be submitted against this watch row.
    await releaseTentativeDirectTransactionHash({ transactionId: txId, txHash });
    notifySseClients(txId, {
      status: "pending",
      errorCode: "sera_swap_hash",
      reason: "This transaction hash belongs to a Sera swap settlement.",
    });
    return;
  }

  if (!selectedTransfer) {
    console.warn("[verify] Transfer event not found or amount mismatch");
    await releaseRejectedDirectSubmission(
      tx,
      txHash,
      "The submitted transaction did not contain the expected token transfer, recipient, and amount.",
      "transfer_evidence_mismatch",
    );
    return;
  }
  const verifiedFromAddress = selectedTransfer.sender;
  const transferVerified = true;
  const compliance = await screenWalletAddress(verifiedFromAddress, "payer_wallet", tx.merchantId);
  if (compliance.blocked) {
    await failTransactionRecord(tx, "The on-chain payer address failed compliance screening.");
    return;
  }
  const confirmation = await claimDirectTransactionConfirmation({
    transactionId: txId,
    txHash,
    fromAddress: verifiedFromAddress,
  });
  if (confirmation.outcome === "already_confirmed") return;
  if (confirmation.outcome !== "claimed") {
    if (confirmation.outcome === "hash_conflict") {
      // A finalized Sera settlement won terminal ownership while this direct
      // receipt was being checked. Release only this exact tentative claim and
      // leave any order now owned by the swap untouched.
      await releaseTentativeDirectTransactionHash({ transactionId: txId, txHash });
    }
    notifySseClients(txId, {
      status: confirmation.transaction?.status ?? "pending",
      ...(confirmation.outcome === "hash_conflict" ? {
        errorCode: "transaction_hash_conflict",
        reason: "This transaction hash is already owned by another finalized payment.",
      } : {}),
    });
    return;
  }
  notifySseClients(txId, { status: "confirmed", txHash, verified: true });

  // Notify merchant dashboard (SSE + polling buffer)
  notifyMerchantSse(tx.merchantId, { event: "payment_received", transactionId: txId, txHash, amount: tx.amount, coin: tx.coin, from: verifiedFromAddress, verified: transferVerified });

  // Send webhook
  const merchant = await getMerchantById(tx.merchantId);
  if (merchant?.webhookUrl) {
    sendWebhook(
      merchant.webhookUrl,
      merchant.webhookSecret,
      { event: "payment.confirmed", txId, txHash, coin: tx.coin, amount: tx.amount, fromAddress: verifiedFromAddress, toAddress: tx.toAddress, verified: transferVerified },
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
): Promise<boolean> {
  // SSRF: resolve the host and refuse any private/internal address before the
  // outbound POST. A stored webhook URL is fetched unattended, so this is the
  // last line of defence if a merchant configured an internal target.
  try {
    await assertPublicHttpUrl(url);
  } catch {
    return false; // silently skip delivery to a non-public address
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
  return success;
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
export class SeraRateUnavailableError extends Error {
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
export async function fetchSeraRestFxRate(from: string, to: string, chainId?: number): Promise<{ rate: number; source: string; asOf?: number }> {
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
