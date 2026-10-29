import { Router } from "express";
import { getSeraPublicErrorMessage } from "../shared/sera-errors";
import { seraErrorDiagnostic, seraRouteErrorResponse } from "./sera-error-response";
import { v4 as uuidv4 } from "uuid";
import { ZodError } from "zod";
import { ENV } from "./_core/env";
import { verifySeraTokens } from "./token-verify";
import { getWalletRecognition, getWalletScanPayability } from "./token-recognition";
import { getPairSnapshot, refreshPairLiquidity } from "./pair-liquidity";
import {
  createPaymentIntentInputSchema,
  createSubWalletInputSchema,
  seraApiConfigInputSchema,
  seraApiKeyGenerationInputSchema,
} from "../shared/gateway";
import {
  createPaymentIntent,
  createSubWallet,
  getApiKeyConfigRecord,
  getMerchantTransactions,
  getPaymentIntentById,
  getSubWalletById,
  listComplianceScreeningLogs,
  listSeraApiRequestLogs,
  listPaymentIntents,
  listSubWallets,
  updateMerchant,
  updateSubWallet,
  upsertApiKeyConfig,
} from "./db";
import { isUnpaidDirectQrWatch, requireApiKey } from "./payment-routes";
import { screenWalletAddress } from "./compliance";
import { decryptSecret, encryptSecret, isSecretEncryptionReady, maskSecret } from "./secret-vault";
import { signCheckoutPayload } from "./checkout-payload";
import {
  DEFAULT_SERA_API_BASE_URL,
  DEFAULT_SERA_API_TESTNET_BASE_URL,
  SeraApiError,
  callSeraApi,
  getSeraFxRate,
  getSeraMarkets,
  getSeraSystemSnapshot,
  getSeraTokens,
  isSensitiveSeraAuditPayload,
  normalizeSeraBaseUrl,
  verifySeraApiCredential,
  type SeraMode,
  type SeraToken,
} from "./sera-api";

export const gatewayRouter = Router();
const SERA_TESTNET_CHAIN_ID = 11155111;

function validationError(res: any, error: unknown) {
  if (error instanceof ZodError) {
    res.status(400).json({ error: error.issues[0]?.message ?? "Invalid request" });
    return true;
  }
  return false;
}

function safeGatewayLog(scope: string, error: unknown) {
  console.error(`[gateway/${scope}] failed`, seraErrorDiagnostic(error));
}

function redactSeraLogForResponse<T extends {
  endpoint: string;
  requestQuery?: string | null;
  requestBody?: string | null;
  responseBody?: string | null;
  errorMessage?: string | null;
}>(log: T): T {
  const redactRequest = isSensitiveSeraAuditPayload(log.endpoint, "request");
  const redactResponse = isSensitiveSeraAuditPayload(log.endpoint, "response");
  if (!redactRequest && !redactResponse) return log;
  return {
    ...log,
    requestQuery: redactRequest ? null : log.requestQuery,
    requestBody: redactRequest ? JSON.stringify({ redacted: true }) : log.requestBody,
    responseBody: redactResponse ? JSON.stringify({ redacted: true }) : log.responseBody,
    errorMessage: redactRequest || redactResponse ? null : log.errorMessage,
  };
}

function getPublicBaseUrl(req: any): string {
  const configured = ENV.paymentBaseUrl;
  if (configured) return configured.replace(/\/+$/, "");
  return `${req.protocol}://${req.get("host")}`;
}

/**
 * Checkout payloads are signed (see server/checkout-payload.ts): the payer's
 * checkout sends the segment back to /api/payment/*, which refuses anything
 * that does not authenticate.
 */
function encodeCheckoutPayload(payload: Record<string, unknown>): string {
  return signCheckoutPayload(payload);
}

/** Sepolia is only ever reachable when the server explicitly enables it. */
function testnetAllowed(): boolean {
  return ENV.seraEnableTestnet;
}

function normalizeSeraMode(value: unknown): SeraMode {
  if (value === "test") return testnetAllowed() ? "test" : "live";
  // "mock" was the historical default for merchants who never opened the Sera
  // API settings, and it resolved to Sepolia everywhere downstream. Mainnet is
  // now the resting state for anything that is not an explicit test opt-in.
  return value === "live" || value === "mock" ? "live" : "live";
}

function querySeraMode(query: any): SeraMode {
  if (query.mode === "test") return testnetAllowed() ? "test" : "live";
  if (query.mode === "live" || query.mode === "mock") return "live";
  const requestedChainId = Number(query.chainId ?? query.chain_id);
  if (Number.isInteger(requestedChainId) && requestedChainId === SERA_TESTNET_CHAIN_ID) {
    return testnetAllowed() ? "test" : "live";
  }
  return "live";
}

function defaultSeraBaseUrlForMode(mode: SeraMode): string {
  if (mode === "test") return ENV.seraApiTestnetBaseUrl || DEFAULT_SERA_API_TESTNET_BASE_URL;
  return ENV.seraApiBaseUrl || DEFAULT_SERA_API_BASE_URL;
}

/**
 * The allowlist is scoped to the mode. Previously it accepted either base URL
 * for any mode, so a merchant row saying `mode: "live"` could still carry the
 * testnet URL and silently send every authenticated Sera call to Sepolia while
 * the dashboard displayed "Live".
 */
function resolveSeraBaseUrl(mode: SeraMode, configuredBaseUrl?: string | null): string {
  const candidate = normalizeSeraBaseUrl(configuredBaseUrl || defaultSeraBaseUrlForMode(mode));
  const allowed = mode === "test" && testnetAllowed()
    ? new Set([
        normalizeSeraBaseUrl(DEFAULT_SERA_API_TESTNET_BASE_URL),
        ...(ENV.seraApiTestnetBaseUrl ? [normalizeSeraBaseUrl(ENV.seraApiTestnetBaseUrl)] : []),
      ])
    : new Set([
        normalizeSeraBaseUrl(DEFAULT_SERA_API_BASE_URL),
        ...(ENV.seraApiBaseUrl ? [normalizeSeraBaseUrl(ENV.seraApiBaseUrl)] : []),
      ]);
  // A stale testnet URL on a live merchant must not silently downgrade the
  // network — fall back to the correct base URL for the mode instead.
  if (!allowed.has(candidate)) return normalizeSeraBaseUrl(defaultSeraBaseUrlForMode(mode));
  return candidate;
}

function modeFromBaseUrl(baseUrl: string): SeraMode {
  if (!testnetAllowed()) return "live";
  const normalized = normalizeSeraBaseUrl(baseUrl);
  const testnetUrls = new Set([
    normalizeSeraBaseUrl(DEFAULT_SERA_API_TESTNET_BASE_URL),
    ...(ENV.seraApiTestnetBaseUrl ? [normalizeSeraBaseUrl(ENV.seraApiTestnetBaseUrl)] : []),
  ]);
  return testnetUrls.has(normalized) ? "test" : "live";
}

function paymentIntentToJson(intent: any) {
  return {
    id: intent.id,
    merchantId: intent.merchantId,
    subWalletId: intent.subWalletId,
    amount: intent.amount,
    coin: intent.coin,
    receiverAddress: intent.receiverAddress,
    chainId: intent.chainId,
    customerEmail: intent.customerEmail,
    customerName: intent.customerName,
    description: intent.description,
    metadata: intent.metadata ? JSON.parse(intent.metadata) : null,
    checkoutUrl: intent.checkoutUrl,
    status: intent.status,
    expiresAt: intent.expiresAt,
    createdAt: intent.createdAt,
    updatedAt: intent.updatedAt,
  };
}

function apiConfigToJson(config: any) {
  const mode = normalizeSeraMode(config?.mode);
  return {
    merchantId: config?.merchantId ?? null,
    seraApiBaseUrl: resolveSeraBaseUrl(mode, config?.seraApiBaseUrl),
    hasSeraApiKey: Boolean(config?.seraApiKeyEncrypted),
    seraApiKeyLast4: config?.seraApiKeyLast4 ?? null,
    hasWebhookSecret: Boolean(config?.seraWebhookSecretEncrypted),
    webhookSecretLast4: config?.seraWebhookSecretLast4 ?? null,
    mode,
    encryptionReady: isSecretEncryptionReady(),
    updatedAt: config?.updatedAt,
  };
}

function walletViewsForMerchant(merchant: any, subWallets: any[]) {
  const merchantWallet = String(merchant.walletAddress || "").toLowerCase();
  const defaultAddress = String(merchant.storeAddress || merchant.walletAddress || "").toLowerCase();
  const masterIsDefault = !merchant.storeAddress || defaultAddress === merchantWallet;
  const viewedSubWallets = subWallets.map((wallet) => ({
    ...wallet,
    isDefault: String(wallet.address || "").toLowerCase() === defaultAddress,
  }));
  const selectedSubWallet = viewedSubWallets.find((wallet) => wallet.isDefault);
  const hasCustomDefault = Boolean(merchant.storeAddress) && !masterIsDefault && !selectedSubWallet;
  return {
    masterWallet: {
      id: merchant.id,
      merchantId: merchant.id,
      type: "master",
      address: merchant.walletAddress,
      settlementAddress: merchant.storeAddress || merchant.walletAddress,
      receiveCoin: merchant.receiveCoin,
      chainId: 1,
      isDefault: masterIsDefault,
      createdAt: merchant.createdAt,
    },
    subWallets: viewedSubWallets,
    defaultWallet: selectedSubWallet
      ? {
          id: selectedSubWallet.id,
          type: "sub-wallet",
          label: selectedSubWallet.label,
          address: selectedSubWallet.address,
          receiveCoin: selectedSubWallet.receiveCoin,
          chainId: selectedSubWallet.chainId,
        }
      : hasCustomDefault
      ? {
          id: "custom",
          type: "custom",
          label: "Custom Address",
          address: merchant.storeAddress,
          receiveCoin: merchant.receiveCoin,
          chainId: 1,
        }
      : {
          id: "master",
          type: "master",
          label: "Master Wallet",
          address: merchant.walletAddress,
          receiveCoin: merchant.receiveCoin,
          chainId: 1,
        },
    defaultWalletId: selectedSubWallet?.id ?? (hasCustomDefault ? "custom" : "master"),
    defaultWalletAddress: defaultAddress || merchantWallet,
  };
}

gatewayRouter.get("/sera/system", async (req, res) => {
  try {
    const requestedMode = querySeraMode(req.query);
    const effectiveMode = requestedMode === "mock" ? "live" : requestedMode;
    const baseUrl = resolveSeraBaseUrl(effectiveMode);
    const snapshot = await getSeraSystemSnapshot(baseUrl, effectiveMode);
    res.json(snapshot);
  } catch (error) {
    res.status(502).json({ error: "Unable to reach Sera API" });
  }
});

/**
 * SeraPay's own copy of the verified token registry, one entry per mode.
 *
 * Token identity — address, symbol, decimals — is immutable once deployed, and
 * we have already confirmed each entry against the chain. Holding it means a
 * Sera outage can no longer empty the currency picker or strip the token
 * details a customer needs to recognise what they are paying. Kept for the
 * process lifetime rather than expired: a slightly stale list that names every
 * currency correctly beats a fresh error that names none.
 */
const verifiedRegistrySnapshots = new Map<SeraMode, { tokens: Awaited<ReturnType<typeof verifySeraTokens>>["tokens"]; fetchedAt: number }>();

/**
 * Which pairs the liquidity sweep has managed to price.
 *
 * The currency picker already calls this; without the route the request fell
 * through to the SPA fallback, which answers 200 with index.html, so the fetch
 * "succeeded", JSON parsing failed, and the catch swallowed it — leaving the
 * filter permanently empty with nothing logged. Answering honestly costs
 * nothing: an empty map means "not measured", and the picker is required to
 * show every token in that case rather than hide any.
 */
gatewayRouter.get("/sera/pairs", async (req, res) => {
  try {
    refreshPairLiquidity(resolveSeraBaseUrl(querySeraMode(req.query)));
  } catch { /* advisory only; never fail the request over it */ }
  res.json(getPairSnapshot());
});

gatewayRouter.get("/sera/tokens", async (req, res) => {
  const mode = querySeraMode(req.query);
  try {
    const registry = await getSeraTokens(resolveSeraBaseUrl(mode));
    // Confirm each contract against the chain before it can back a payment QR.
    // A wallet reads symbol()/decimals() from this address; if it has no code
    // or reports different decimals, the customer sees "Unknown" and the
    // transfer moves the wrong amount or reverts.
    const chainId = mode === "test" ? SERA_TESTNET_CHAIN_ID : 1;
    const { tokens, rejected } = await verifySeraTokens(chainId, registry.tokens ?? []);
    if (rejected.length) {
      console.warn(`[Sera tokens] Dropped ${rejected.length} token(s) failing on-chain verification on chain ${chainId}:`,
        rejected.map((entry) => entry.reason).join("; "));
    }
    // A verified contract still renders as "Unknown" in a wallet that has never
    // heard of it — the URI carries no symbol. Tell the merchant which of their
    // currencies a customer's wallet will actually be able to name.
    const recognitionOf = await getWalletRecognition(chainId);
    const scanPayableOf = await getWalletScanPayability(chainId);
    const annotated = tokens.map((token) => {
      const walletScanPayable = scanPayableOf(token.address);
      return {
        ...token,
        walletRecognition: recognitionOf(token.address),
        // Omitted while unproven — the client treats absence as "not scannable"
        // and routes the QR through the checkout link, which always works.
        ...(walletScanPayable === null ? {} : { walletScanPayable }),
      };
    });
    if (tokens.length > 0) verifiedRegistrySnapshots.set(mode, { tokens, fetchedAt: Date.now() });
    res.json({ tokens: annotated, ...(rejected.length ? { rejected } : {}) });
  } catch (error) {
    // Serve our own copy rather than an error. Every entry here was already
    // verified against the chain, so it is safe to build a payment against —
    // and a merchant mid-sale needs the contract far more than they need us to
    // be pedantic about Sera being reachable this second.
    const snapshot = verifiedRegistrySnapshots.get(mode);
    if (snapshot?.tokens.length) {
      safeGatewayLog("sera/tokens-serving-cached", error);
      const chainId = mode === "test" ? SERA_TESTNET_CHAIN_ID : 1;
      const recognitionOf = await getWalletRecognition(chainId);
      const scanPayableOf = await getWalletScanPayability(chainId);
      res.json({
        tokens: snapshot.tokens.map((token) => {
          const walletScanPayable = scanPayableOf(token.address);
          return { ...token, walletRecognition: recognitionOf(token.address), ...(walletScanPayable === null ? {} : { walletScanPayable }) };
        }),
        stale: true,
        stableAsOf: new Date(snapshot.fetchedAt).toISOString(),
      });
      return;
    }
    res.status(502).json({ error: "Unable to fetch Sera tokens" });
  }
});

gatewayRouter.get("/sera/markets", async (req, res) => {
  try {
    const mode = querySeraMode(req.query);
    res.json(await getSeraMarkets(resolveSeraBaseUrl(mode)));
  } catch (error) {
    res.status(502).json({ error: "Unable to fetch Sera markets" });
  }
});

gatewayRouter.get("/sera/fx-rate", async (req, res) => {
  try {
    const base = String(req.query.base ?? "").trim();
    const quote = String(req.query.quote ?? "").trim();
    // Sera documents these as alphabetic codes, not strictly three letters.
    if (!/^[A-Za-z]+$/.test(base) || !/^[A-Za-z]+$/.test(quote)) {
      res.status(400).json({ error: "base and quote must be alphabetic currency codes, e.g. SGD and MYR." });
      return;
    }
    const mode = querySeraMode(req.query);
    res.json(await getSeraFxRate(resolveSeraBaseUrl(mode), base, quote));
  } catch (error) {
    // Sera's own 503 (no provider data for this pair) is a different problem
    // from a malformed request, and flattening both into 502 sent callers
    // looking in the wrong place. Pass the distinction through.
    if (error instanceof SeraApiError && error.status >= 500) {
      res.status(503).json({ error: getSeraPublicErrorMessage("sera_fx_unavailable"), errorCode: "sera_fx_unavailable" });
      return;
    }
    safeGatewayLog("sera/fx-rate", error);
    const response = seraRouteErrorResponse(error);
    res.status(response.status).json(response.body);
  }
});

gatewayRouter.post("/sera/swap/quote", requireApiKey as any, async (req: any, res) => {
  try {
    const { baseUrl } = await getMerchantSeraCredential(req.merchant.id);
    const ownerAddress = String(req.body.owner_address ?? req.body.ownerAddress ?? "").trim();
    const recipient = String(req.body.recipient ?? "").trim();
    // Two documented values only. A typo used to be forwarded verbatim and came
    // back as an untyped "Invalid request"; and the old "receive_less" default
    // silently took Sera's execution cost out of the MERCHANT's proceeds, which
    // is the wrong default for a payment gateway.
    const requestedGasMode = String(req.body.gas_mode ?? req.body.gasMode ?? "pay_more");
    if (requestedGasMode !== "pay_more" && requestedGasMode !== "receive_less") {
      res.status(400).json({ error: "gas_mode must be pay_more or receive_less." });
      return;
    }
    const gasMode = requestedGasMode;
    // Sera directs clients to base expiration on ITS clock, not ours. Drift here
    // surfaces much later, as INTENT_DEADLINE_EXPIRED at submit time.
    const seraNow = await callSeraApi<{ timestamp?: number }>({
      baseUrl,
      path: "/system/time",
      authMode: "none",
      merchantId: req.merchant.id,
    });
    const seraNowSec = Number(seraNow.timestamp);
    if (!Number.isInteger(seraNowSec) || seraNowSec <= 0) {
      throw new Error("Sera /system/time did not return a valid timestamp");
    }
    const expiration = Number(req.body.expiration ?? seraNowSec + 900);

    const fromTokenInput = String(req.body.from_token ?? req.body.fromToken ?? req.body.fromSymbol ?? "").trim();
    const toTokenInput = String(req.body.to_token ?? req.body.toToken ?? req.body.toSymbol ?? "").trim();
    const fromToken = await resolveSeraToken(baseUrl, fromTokenInput);
    const toToken = await resolveSeraToken(baseUrl, toTokenInput);
    const providedRawAmount = req.body.from_amount ?? req.body.fromAmountRaw;
    const fromAmountRaw = providedRawAmount
      ? String(providedRawAmount)
      : toRawTokenAmount(String(req.body.fromAmount ?? ""), fromToken.decimals);

    const body = {
      from_token: fromToken.address,
      to_token: toToken.address,
      from_amount: fromAmountRaw,
      owner_address: ownerAddress,
      recipient,
      expiration,
      gas_mode: gasMode,
    };

    const quote = await callSeraApi({
      baseUrl,
      path: "/swap/quote",
      method: "POST",
      body,
      merchantId: req.merchant.id,
    });

    res.json({
      quote,
      request: {
        ...body,
        from_symbol: fromToken.symbol,
        to_symbol: toToken.symbol,
      },
    });
  } catch (error) {
    const response = seraRouteErrorResponse(error);
    res.status(response.status).json(response.body);
  }
});

gatewayRouter.get("/sera/orders", requireApiKey as any, async (req: any, res) => {
  try {
    const { baseUrl, credential } = await getMerchantSeraCredential(req.merchant.id);
    if (!credential) {
      res.status(400).json({ error: "No Sera API key saved. Add api_key:api_secret in Developers / API Keys." });
      return;
    }
    const data = await callSeraApi({
      baseUrl,
      path: "/orders",
      query: ownerScopedQuery(req.query, req.merchant.walletAddress),
      credential,
      authMode: "api_key",
      merchantId: req.merchant.id,
    });
    res.json(data);
  } catch (error) {
    const response = seraRouteErrorResponse(error);
    res.status(response.status).json(response.body);
  }
});

gatewayRouter.get("/sera/fills", requireApiKey as any, async (req: any, res) => {
  try {
    const { baseUrl, credential } = await getMerchantSeraCredential(req.merchant.id);
    if (!credential) {
      res.status(400).json({ error: "No Sera API key saved. Add api_key:api_secret in Developers / API Keys." });
      return;
    }
    const data = await callSeraApi({
      baseUrl,
      path: "/fills",
      query: ownerScopedQuery(req.query, req.merchant.walletAddress),
      credential,
      authMode: "api_key",
      merchantId: req.merchant.id,
    });
    res.json(data);
  } catch (error) {
    const response = seraRouteErrorResponse(error);
    res.status(response.status).json(response.body);
  }
});

gatewayRouter.get("/sera/balances", requireApiKey as any, async (req: any, res) => {
  try {
    const { baseUrl, credential } = await getMerchantSeraCredential(req.merchant.id);
    if (!credential) {
      res.status(400).json({ error: "No Sera API key saved. Add api_key:api_secret in Developers / API Keys." });
      return;
    }
    const data = await callSeraApi({
      baseUrl,
      path: "/balances",
      query: ownerScopedQuery(req.query, req.merchant.walletAddress),
      credential,
      authMode: "api_key",
      merchantId: req.merchant.id,
    });
    res.json(data);
  } catch (error) {
    const response = seraRouteErrorResponse(error);
    res.status(response.status).json(response.body);
  }
});

gatewayRouter.get("/sera/logs", requireApiKey as any, async (req: any, res) => {
  try {
    const logs = await listSeraApiRequestLogs(req.merchant.id, Number(req.query.limit) || 50);
    res.json({ logs: logs.map(redactSeraLogForResponse) });
  } catch {
    res.status(500).json({ error: "Unable to fetch Sera API logs" });
  }
});

gatewayRouter.get("/compliance/logs", requireApiKey as any, async (req: any, res) => {
  try {
    const logs = await listComplianceScreeningLogs(req.merchant.id, Number(req.query.limit) || 50);
    res.json({ logs });
  } catch {
    res.status(500).json({ error: "Unable to fetch compliance logs" });
  }
});

gatewayRouter.post("/compliance/screen-address", requireApiKey as any, async (req: any, res) => {
  try {
    const address = String(req.body.address ?? "").trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      res.status(400).json({ error: "Invalid address" });
      return;
    }
    const result = await screenWalletAddress(address, req.body.checkType ?? "recipient_wallet", req.merchant.id);
    res.json(result);
  } catch (error) {
    safeGatewayLog("compliance/screen-address", error);
    res.status(500).json({ error: "Unable to screen address" });
  }
});

/**
 * Scales a decimal amount to a token's raw integer units.
 *
 * Previously this capped input at 6 decimals and then did
 * `fraction.padEnd(decimals).slice(0, decimals)`, which SILENTLY TRUNCATED any
 * token with fewer than 6 decimals — "2000.251" against a 2-decimal token
 * (EURS, IDRT) became 2000.25, undercharging the payer with no error. The 6
 * decimal cap also made mainnet's 18-decimal tokens (JPYC, BRZ, CADC, EURE,
 * ZARP) unusable at full precision. Precision loss on money must throw.
 */
function toRawTokenAmount(amount: string, decimals: number): string {
  const normalized = amount.replace(/,/g, "").trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) throw new Error("Invalid token amount.");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error("Invalid token decimals.");
  }
  const [whole, fraction = ""] = normalized.split(".");
  if (fraction.length > decimals) {
    throw new Error(`Invalid amount. ${decimals} decimal places maximum for this token.`);
  }
  const raw = `${whole}${fraction.padEnd(decimals, "0")}`.replace(/^0+(?=\d)/, "");
  return raw || "0";
}

async function getMerchantSeraCredential(merchantId: string) {
  const config = await getApiKeyConfigRecord(merchantId);
  const mode = normalizeSeraMode(config?.mode);
  const baseUrl = resolveSeraBaseUrl(mode, config?.seraApiBaseUrl);
  const credential = decryptSecret(config?.seraApiKeyEncrypted) || ENV.seraApiKey || "";
  return { config, baseUrl, credential };
}

/**
 * Sera's owner-scoped reads reject a mismatched owner with 403 and an absent one
 * with 422, and treat the address as case-sensitive. A merchant's credential can
 * only ever read their own wallet, so fill it in rather than making them
 * discover that through an error - and clamp `limit` to the documented ceiling
 * of 500 instead of letting Sera reject the whole call.
 */
function ownerScopedQuery(query: any, merchantWallet: string | null | undefined) {
  const base = queryObject(query);
  const requestedOwner = String(base.owner_address ?? base.ownerAddress ?? merchantWallet ?? "").trim();
  delete base.ownerAddress;
  if (requestedOwner) base.owner_address = requestedOwner.toLowerCase();
  const limit = Number(base.limit);
  if (Number.isFinite(limit) && limit > 500) base.limit = "500";
  return base;
}

function queryObject(query: any) {
  return Object.fromEntries(
    Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== "")
  ) as Record<string, string>;
}

async function resolveSeraToken(baseUrl: string, symbolOrAddress: string): Promise<SeraToken> {
  const normalized = symbolOrAddress.trim().toLowerCase();
  const registry = await getSeraTokens(baseUrl);
  const token = registry.tokens.find(
    (item) => item.symbol.toLowerCase() === normalized || item.address.toLowerCase() === normalized
  );
  if (!token) {
    throw new Error(`Unsupported Sera token: ${symbolOrAddress}`);
  }
  return token;
}

gatewayRouter.get("/wallets/master", requireApiKey as any, async (req: any, res) => {
  const merchant = req.merchant;
  res.json({
    id: merchant.id,
    merchantId: merchant.id,
    type: "master",
    address: merchant.walletAddress,
    settlementAddress: merchant.storeAddress || merchant.walletAddress,
    receiveCoin: merchant.receiveCoin,
    chainId: 1,
    isDefault: !merchant.storeAddress || String(merchant.storeAddress).toLowerCase() === String(merchant.walletAddress).toLowerCase(),
    createdAt: merchant.createdAt,
  });
});

gatewayRouter.get("/wallets", requireApiKey as any, async (req: any, res) => {
  try {
    const merchant = req.merchant;
    const subWallets = await listSubWallets(merchant.id);
    res.json(walletViewsForMerchant(merchant, subWallets));
  } catch (error) {
    safeGatewayLog("wallets", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

gatewayRouter.put("/wallets/default", requireApiKey as any, async (req: any, res) => {
  try {
    const walletId = String(req.body?.walletId ?? req.body?.id ?? "").trim();
    if (!walletId) {
      res.status(400).json({ error: "walletId is required" });
      return;
    }

    if (walletId === "master" || walletId === req.merchant.id) {
      await updateMerchant(req.merchant.id, { storeAddress: null });
      const subWallets = await listSubWallets(req.merchant.id);
      res.json(walletViewsForMerchant({ ...req.merchant, storeAddress: null }, subWallets));
      return;
    }

    const wallet = await getSubWalletById(walletId);
    if (!wallet || wallet.merchantId !== req.merchant.id || wallet.status !== "active") {
      res.status(404).json({ error: "Sub-wallet not found" });
      return;
    }

    const compliance = await screenWalletAddress(wallet.address, "recipient_wallet", req.merchant.id);
    if (compliance.blocked) {
      res.status(403).json({ error: "Wallet address failed compliance screening", compliance });
      return;
    }

    await updateMerchant(req.merchant.id, { storeAddress: wallet.address });
    const subWallets = await listSubWallets(req.merchant.id);
    res.json(walletViewsForMerchant({ ...req.merchant, storeAddress: wallet.address }, subWallets));
  } catch (error) {
    safeGatewayLog("wallets/default", error);
    res.status(500).json({ error: "Unable to set default wallet" });
  }
});

gatewayRouter.get("/sub-wallets", requireApiKey as any, async (req: any, res) => {
  try {
    res.json({ subWallets: await listSubWallets(req.merchant.id) });
  } catch (error) {
    safeGatewayLog("sub-wallets", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

gatewayRouter.post("/sub-wallets", requireApiKey as any, async (req: any, res) => {
  try {
    const input = createSubWalletInputSchema.parse(req.body);
    const compliance = await screenWalletAddress(input.address, "sub_wallet", req.merchant.id);
    if (compliance.blocked) {
      res.status(403).json({ error: "Sub-wallet address failed compliance screening", compliance });
      return;
    }
    const id = uuidv4();
    await createSubWallet({
      id,
      merchantId: req.merchant.id,
      label: input.label,
      address: input.address,
      chainId: input.chainId,
      receiveCoin: input.receiveCoin,
      status: "active",
    });
    const subWallet = await getSubWalletById(id);
    res.status(201).json(subWallet);
  } catch (error) {
    if (validationError(res, error)) return;
    safeGatewayLog("sub-wallets/create", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

gatewayRouter.delete("/sub-wallets/:id", requireApiKey as any, async (req: any, res) => {
  try {
    const wallet = await getSubWalletById(req.params.id);
    if (!wallet) {
      res.status(404).json({ error: "Sub-wallet not found" });
      return;
    }
    if (wallet.merchantId !== req.merchant.id) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    await updateSubWallet(wallet.id, { status: "archived" });
    if (String(req.merchant.storeAddress || "").toLowerCase() === String(wallet.address || "").toLowerCase()) {
      await updateMerchant(req.merchant.id, { storeAddress: null });
    }
    res.json({ ok: true });
  } catch (error) {
    safeGatewayLog("sub-wallets/delete", error);
    res.status(500).json({ error: "Unable to delete sub-wallet" });
  }
});

gatewayRouter.get("/payments", requireApiKey as any, async (req: any, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const paymentIntents = await listPaymentIntents(req.merchant.id, limit);
    res.json({ paymentIntents: paymentIntents.map(paymentIntentToJson) });
  } catch (error) {
    safeGatewayLog("payment-intents", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

gatewayRouter.post("/payments", requireApiKey as any, async (req: any, res) => {
  try {
    const input = createPaymentIntentInputSchema.parse(req.body);
    const subWallet = input.subWalletId ? await getSubWalletById(input.subWalletId) : undefined;
    if (input.subWalletId && (!subWallet || subWallet.merchantId !== req.merchant.id)) {
      res.status(404).json({ error: "Sub-wallet not found" });
      return;
    }

    const receiverAddress = subWallet?.address || req.merchant.storeAddress || req.merchant.walletAddress;
    const compliance = await screenWalletAddress(receiverAddress, "recipient_wallet", req.merchant.id);
    if (compliance.blocked) {
      res.status(403).json({ error: "Recipient address failed compliance screening", compliance });
      return;
    }
    const id = uuidv4();
    const payload = {
      receiverAddress,
      receiveCoin: input.coin,
      amount: input.amount,
      chainId: input.chainId,
      merchantName: req.merchant.name,
      description: input.description || undefined,
      expiresAt: input.expiresAt?.getTime(),
      singleUse: true,
      paymentIntentId: id,
      _n: id.slice(0, 8),
    };
    const checkoutUrl = `${getPublicBaseUrl(req)}/pay/${encodeCheckoutPayload(payload)}`;

    await createPaymentIntent({
      id,
      merchantId: req.merchant.id,
      subWalletId: subWallet?.id ?? null,
      amount: input.amount,
      coin: input.coin,
      receiverAddress,
      chainId: input.chainId,
      customerEmail: input.customerEmail || null,
      customerName: input.customerName || null,
      description: input.description || null,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      checkoutUrl,
      status: "open",
      expiresAt: input.expiresAt ?? null,
    });

    const intent = await getPaymentIntentById(id);
    if (!intent) throw new Error("Payment intent was not created");
    res.status(201).json({ paymentIntent: paymentIntentToJson(intent), checkoutUrl });
  } catch (error) {
    if (validationError(res, error)) return;
    safeGatewayLog("payments/create", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

gatewayRouter.get("/payments/:id", requireApiKey as any, async (req: any, res) => {
  try {
    const intent = await getPaymentIntentById(req.params.id);
    if (!intent || intent.merchantId !== req.merchant.id) {
      res.status(404).json({ error: "Payment intent not found" });
      return;
    }
    res.json({ paymentIntent: paymentIntentToJson(intent) });
  } catch (error) {
    safeGatewayLog("payments/read", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

gatewayRouter.get("/transactions", requireApiKey as any, async (req: any, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 1000);
    const offset = Number(req.query.offset) || 0;
    const rows = await getMerchantTransactions(req.merchant.id, limit, offset);
    // Scan & Pay mints a placeholder row so the 60s sweep keeps watching a QR
    // after the merchant closes the screen. It is bookkeeping, not a payment:
    // no hash, no money. The dashboard routes already hide these, and an API
    // integrator polling this endpoint must not see phantom pending/canceled
    // transactions either.
    const transactions = rows.filter((tx) => !isUnpaidDirectQrWatch(tx));
    res.json({ transactions, pagination: { limit, offset } });
  } catch (error) {
    safeGatewayLog("transactions", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

gatewayRouter.get("/merchant/sera-config", requireApiKey as any, async (req: any, res) => {
  try {
    const config = await getApiKeyConfigRecord(req.merchant.id);
    res.json(apiConfigToJson(config));
  } catch (error) {
    safeGatewayLog("sera-config/read", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

gatewayRouter.put("/merchant/sera-config", requireApiKey as any, async (req: any, res) => {
  try {
    const input = seraApiConfigInputSchema.parse(req.body);
    const existing = await getApiKeyConfigRecord(req.merchant.id);
    const hasNewSeraKey = Boolean(input.seraApiKey);
    const hasNewWebhookSecret = Boolean(input.seraWebhookSecret);

    let seraApiKeyEncrypted = existing?.seraApiKeyEncrypted ?? null;
    let seraApiKeyLast4 = existing?.seraApiKeyLast4 ?? null;
    let seraWebhookSecretEncrypted = existing?.seraWebhookSecretEncrypted ?? null;
    let seraWebhookSecretLast4 = existing?.seraWebhookSecretLast4 ?? null;

    if (hasNewSeraKey) {
      seraApiKeyEncrypted = encryptSecret(input.seraApiKey);
      seraApiKeyLast4 = maskSecret(input.seraApiKey);
    }
    if (hasNewWebhookSecret) {
      seraWebhookSecretEncrypted = encryptSecret(input.seraWebhookSecret);
      seraWebhookSecretLast4 = maskSecret(input.seraWebhookSecret);
    }

    await upsertApiKeyConfig({
      id: existing?.id ?? uuidv4(),
      merchantId: req.merchant.id,
      seraApiBaseUrl: resolveSeraBaseUrl(input.mode, input.seraApiBaseUrl),
      seraApiKeyEncrypted,
      seraApiKeyLast4,
      seraWebhookSecretEncrypted,
      seraWebhookSecretLast4,
      mode: input.mode,
    });

    const updated = await getApiKeyConfigRecord(req.merchant.id);
    res.json(apiConfigToJson(updated));
  } catch (error) {
    if (validationError(res, error)) return;
    if (error instanceof Error && error.message.includes("SERA_CONFIG_ENCRYPTION_KEY")) {
      safeGatewayLog("sera-config/update", error);
      res.status(503).json({ error: getSeraPublicErrorMessage("invalid_config"), errorCode: "invalid_config" });
      return;
    }
    safeGatewayLog("sera-config/update", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

gatewayRouter.post("/merchant/sera-config/test", requireApiKey as any, async (req: any, res) => {
  try {
    const config = await getApiKeyConfigRecord(req.merchant.id);
    const mode = normalizeSeraMode(config?.mode);
    const baseUrl = resolveSeraBaseUrl(mode, config?.seraApiBaseUrl);
    const credential = decryptSecret(config?.seraApiKeyEncrypted);
    const snapshot = await getSeraSystemSnapshot(baseUrl, mode, req.merchant.id);
    const verification = credential
      ? await verifySeraApiCredential(baseUrl, credential, req.merchant.id)
      : { ok: false, message: "No Sera API key saved." };
    res.json({ snapshot, verification });
  } catch (error) {
    safeGatewayLog("sera-config/test", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

gatewayRouter.post("/merchant/sera-config/generate-api-key", requireApiKey as any, async (req: any, res) => {
  try {
    const input = seraApiKeyGenerationInputSchema.parse(req.body);
    const merchantWallet = String(req.merchant.walletAddress ?? "").toLowerCase();
    if (input.owner !== merchantWallet) {
      res.status(403).json({ error: "Signed owner address must match the merchant wallet." });
      return;
    }

    const normalizedInputBaseUrl = normalizeSeraBaseUrl(input.seraApiBaseUrl);
    const mode = modeFromBaseUrl(normalizedInputBaseUrl);
    const baseUrl = resolveSeraBaseUrl(mode, normalizedInputBaseUrl);
    const result = await callSeraApi<{
      api_key?: string;
      api_secret?: string;
      apiKey?: string;
      apiSecret?: string;
      credential?: string;
    }>({
      baseUrl,
      path: "/api-keys",
      method: "POST",
      authMode: "eip712",
      merchantId: req.merchant.id,
      body: {
        owner_address: input.owner,
        action: input.action,
        timestamp: input.timestamp,
        signature: input.signature,
        label: input.label,
      },
      sensitiveRequest: true,
      sensitiveResponse: true,
    });

    const apiKey = result.api_key ?? result.apiKey ?? "";
    const apiSecret = result.api_secret ?? result.apiSecret ?? "";
    const credential = result.credential || (apiKey && apiSecret ? `${apiKey}:${apiSecret}` : "");
    if (!credential) {
      res.status(502).json({ error: getSeraPublicErrorMessage("sera_unavailable"), errorCode: "sera_unavailable" });
      return;
    }

    const existing = await getApiKeyConfigRecord(req.merchant.id);
    await upsertApiKeyConfig({
      id: existing?.id ?? uuidv4(),
      merchantId: req.merchant.id,
      seraApiBaseUrl: baseUrl,
      seraApiKeyEncrypted: encryptSecret(credential),
      seraApiKeyLast4: maskSecret(apiKey || credential),
      seraWebhookSecretEncrypted: existing?.seraWebhookSecretEncrypted ?? null,
      seraWebhookSecretLast4: existing?.seraWebhookSecretLast4 ?? null,
      mode,
    });

    const updated = await getApiKeyConfigRecord(req.merchant.id);
    res.status(201).json({
      config: apiConfigToJson(updated),
      ownerAddress: input.owner,
      apiKeyLast4: maskSecret(apiKey || credential),
      message: "Sera API key generated, encrypted, and saved. The api_secret was only handled server-side.",
    });
  } catch (error) {
    if (validationError(res, error)) return;
    if (error instanceof Error && error.message.includes("SERA_CONFIG_ENCRYPTION_KEY")) {
      safeGatewayLog("sera-config/generate-api-key", error);
      res.status(503).json({ error: getSeraPublicErrorMessage("invalid_config"), errorCode: "invalid_config" });
      return;
    }
    const response = seraRouteErrorResponse(error);
    res.status(response.status).json(response.body);
  }
});

// The Sera webhook receiver that used to live here has been removed.
//
// Sera has no push mechanism of any kind. Every page of docs.sera.cx was
// checked: there are zero references to webhooks, callbacks, push
// notifications, SSE, or subscriptions, and the FAQ states plainly that a
// WebSocket API is "not currently for public users. Use polling with the REST
// API for order status updates." The handler was therefore built against an
// API that does not exist and could never have been called by Sera.
//
// It was also an unauthenticated way to mark any merchant's order paid: the
// secret check ran only `if (secret)`, so a merchant with no webhook secret
// configured — the default for every merchant — accepted anonymous requests
// that inserted a `status: "confirmed", verified: 1` transaction row.
//
// Settlement is reconciled by polling instead: on-chain transfer scanning for
// direct payments (see /payment/direct/scan in payment-routes.ts) and Sera's
// GET /orders/{trade_id} for swaps.
