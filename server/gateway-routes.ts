import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { ZodError } from "zod";
import { ENV } from "./_core/env";
import {
  createPaymentIntentInputSchema,
  createSubWalletInputSchema,
  seraApiConfigInputSchema,
  seraApiKeyGenerationInputSchema,
  seraWebhookPayloadSchema,
} from "../shared/gateway";
import {
  createPaymentIntent,
  createSubWallet,
  createTransaction,
  getApiKeyConfigRecord,
  getMerchantTransactions,
  getPaymentIntentById,
  getSubWalletById,
  getTransactionByHash,
  listComplianceScreeningLogs,
  listSeraApiRequestLogs,
  listPaymentIntents,
  listSubWallets,
  updateMerchant,
  updatePaymentIntent,
  updateSubWallet,
  upsertApiKeyConfig,
} from "./db";
import { requireApiKey } from "./payment-routes";
import { screenWalletAddress } from "./compliance";
import { decryptSecret, encryptSecret, isSecretEncryptionReady, maskSecret } from "./secret-vault";
import {
  DEFAULT_SERA_API_BASE_URL,
  DEFAULT_SERA_API_TESTNET_BASE_URL,
  SeraApiError,
  callSeraApi,
  getSeraFxRate,
  getSeraMarkets,
  getSeraSystemSnapshot,
  getSeraTokens,
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

function seraGatewayErrorResponse(error: unknown, fallback: string) {
  if (error instanceof SeraApiError) {
    const code = error.errorCode;
    const detail = error.detail && typeof error.detail === "object" ? error.detail as Record<string, unknown> : null;
    const humanDetail = typeof detail?.detail === "string"
      ? detail.detail
      : typeof detail?.message === "string"
        ? detail.message
        : null;
    const isQuoteStale = error.status === 409
      || error.status === 410
      || code === "QUOTE_STALE"
      || code === "quote_stale";
    const isUnavailable = error.status >= 500;
    const message = code === "no_liquidity" || code === "NO_LIQUIDITY"
      ? "Currently there is no liquidity for this transaction. Please try a different payment coin."
      : isQuoteStale
        ? "This quote closed before it could be submitted. Please try again."
      : isUnavailable
        ? "Sera is temporarily unavailable. Please try again shortly."
        : humanDetail || error.message;
    return {
      status: error.status >= 400 && error.status < 500 ? error.status : 502,
      body: {
        error: message,
        errorCode: isQuoteStale ? "quote_stale" : code ?? (isUnavailable ? "sera_connection_error" : null),
        seraStatus: error.status,
        detail: error.detail,
      },
    };
  }
  const detail = error instanceof Error ? error.message : fallback;
  return {
    status: 502,
    body: {
      error: "Unable to reach Sera right now. Please try again shortly.",
      errorCode: "sera_connection_error",
      detail,
    },
  };
}

function getPublicBaseUrl(req: any): string {
  const configured = ENV.paymentBaseUrl;
  if (configured) return configured.replace(/\/+$/, "");
  return `${req.protocol}://${req.get("host")}`;
}

function encodeCheckoutPayload(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), "utf8")
    .toString("base64url")
    .replace(/=+$/, "");
}

function normalizeSeraMode(value: unknown): SeraMode {
  return value === "test" || value === "live" || value === "mock" ? value : "mock";
}

function querySeraMode(query: any): SeraMode {
  if (query.mode === "test" || query.mode === "live" || query.mode === "mock") return query.mode;
  const requestedChainId = Number(query.chainId ?? query.chain_id);
  if (Number.isInteger(requestedChainId) && requestedChainId > 0) {
    return requestedChainId === SERA_TESTNET_CHAIN_ID ? "test" : "live";
  }
  return "live";
}

function defaultSeraBaseUrlForMode(mode: SeraMode): string {
  if (mode === "test") return ENV.seraApiTestnetBaseUrl || DEFAULT_SERA_API_TESTNET_BASE_URL;
  return ENV.seraApiBaseUrl || DEFAULT_SERA_API_BASE_URL;
}

function resolveSeraBaseUrl(mode: SeraMode, configuredBaseUrl?: string | null): string {
  return normalizeSeraBaseUrl(configuredBaseUrl || defaultSeraBaseUrlForMode(mode));
}

function modeFromBaseUrl(baseUrl: string): SeraMode {
  return baseUrl.toLowerCase().includes("testnet") ? "test" : "live";
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
    const requestedBaseUrl = String(req.query.baseUrl ?? req.query.base_url ?? defaultSeraBaseUrlForMode(requestedMode));
    const baseUrl = normalizeSeraBaseUrl(requestedBaseUrl);
    new URL(baseUrl);
    const snapshot = await getSeraSystemSnapshot(baseUrl, requestedMode === "mock" ? modeFromBaseUrl(baseUrl) : requestedMode);
    res.json(snapshot);
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : "Unable to reach Sera API" });
  }
});

gatewayRouter.get("/sera/tokens", async (req, res) => {
  try {
    const mode = querySeraMode(req.query);
    res.json(await getSeraTokens(resolveSeraBaseUrl(mode)));
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : "Unable to fetch Sera tokens" });
  }
});

gatewayRouter.get("/sera/markets", async (req, res) => {
  try {
    const mode = querySeraMode(req.query);
    res.json(await getSeraMarkets(resolveSeraBaseUrl(mode)));
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : "Unable to fetch Sera markets" });
  }
});

gatewayRouter.get("/sera/fx-rate", async (req, res) => {
  try {
    const base = String(req.query.base ?? "").trim();
    const quote = String(req.query.quote ?? "").trim();
    if (!/^[A-Za-z]{3}$/.test(base) || !/^[A-Za-z]{3}$/.test(quote)) {
      res.status(400).json({ error: "base and quote must be ISO currency codes, e.g. SGD and MYR." });
      return;
    }
    const mode = querySeraMode(req.query);
    res.json(await getSeraFxRate(resolveSeraBaseUrl(mode), base, quote));
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : "Unable to fetch Sera FX rate" });
  }
});

gatewayRouter.post("/sera/swap/quote", requireApiKey as any, async (req: any, res) => {
  try {
    const { baseUrl } = await getMerchantSeraCredential(req.merchant.id);
    const ownerAddress = String(req.body.owner_address ?? req.body.ownerAddress ?? "").trim();
    const recipient = String(req.body.recipient ?? "").trim();
    const gasMode = req.body.gas_mode ?? req.body.gasMode ?? "receive_less";
    const expiration = Number(req.body.expiration ?? Math.floor(Date.now() / 1000) + 900);

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
    const response = seraGatewayErrorResponse(error, "Unable to fetch Sera swap quote");
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
      query: queryObject(req.query),
      credential,
      authMode: "api_key",
      merchantId: req.merchant.id,
    });
    res.json(data);
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : "Unable to fetch Sera orders" });
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
      query: queryObject(req.query),
      credential,
      authMode: "api_key",
      merchantId: req.merchant.id,
    });
    res.json(data);
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : "Unable to fetch Sera fills" });
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
      query: queryObject(req.query),
      credential,
      authMode: "api_key",
      merchantId: req.merchant.id,
    });
    res.json(data);
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : "Unable to fetch Sera balances" });
  }
});

gatewayRouter.get("/sera/logs", requireApiKey as any, async (req: any, res) => {
  try {
    const logs = await listSeraApiRequestLogs(req.merchant.id, Number(req.query.limit) || 50);
    res.json({ logs });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unable to fetch Sera API logs" });
  }
});

gatewayRouter.get("/compliance/logs", requireApiKey as any, async (req: any, res) => {
  try {
    const logs = await listComplianceScreeningLogs(req.merchant.id, Number(req.query.limit) || 50);
    res.json({ logs });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unable to fetch compliance logs" });
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
    res.status(500).json({ error: error instanceof Error ? error.message : "Unable to screen address" });
  }
});

function toRawTokenAmount(amount: string, decimals: number): string {
  const normalized = amount.replace(/,/g, "").trim();
  if (!/^\d+(\.\d{1,6})?$/.test(normalized)) throw new Error("Invalid amount. Max 6 decimals.");
  const [whole, fraction = ""] = normalized.split(".");
  const normalizedFraction = fraction.padEnd(decimals, "0").slice(0, decimals);
  const raw = `${whole}${normalizedFraction}`.replace(/^0+(?=\d)/, "");
  return raw || "0";
}

async function getMerchantSeraCredential(merchantId: string) {
  const config = await getApiKeyConfigRecord(merchantId);
  const mode = normalizeSeraMode(config?.mode);
  const baseUrl = resolveSeraBaseUrl(mode, config?.seraApiBaseUrl);
  const credential = decryptSecret(config?.seraApiKeyEncrypted) || ENV.seraApiKey || "";
  return { config, baseUrl, credential };
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
    console.error(error);
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
    console.error(error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Unable to set default wallet" });
  }
});

gatewayRouter.get("/sub-wallets", requireApiKey as any, async (req: any, res) => {
  try {
    res.json({ subWallets: await listSubWallets(req.merchant.id) });
  } catch (error) {
    console.error(error);
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
    console.error(error);
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
    res.status(500).json({ error: error instanceof Error ? error.message : "Unable to delete sub-wallet" });
  }
});

gatewayRouter.get("/payments", requireApiKey as any, async (req: any, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const paymentIntents = await listPaymentIntents(req.merchant.id, limit);
    res.json({ paymentIntents: paymentIntents.map(paymentIntentToJson) });
  } catch (error) {
    console.error(error);
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
    console.error(error);
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
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

gatewayRouter.get("/transactions", requireApiKey as any, async (req: any, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 1000);
    const offset = Number(req.query.offset) || 0;
    const transactions = await getMerchantTransactions(req.merchant.id, limit, offset);
    res.json({ transactions, pagination: { limit, offset } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

gatewayRouter.get("/merchant/sera-config", requireApiKey as any, async (req: any, res) => {
  try {
    const config = await getApiKeyConfigRecord(req.merchant.id);
    res.json(apiConfigToJson(config));
  } catch (error) {
    console.error(error);
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
      seraApiBaseUrl: normalizeSeraBaseUrl(input.seraApiBaseUrl),
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
      res.status(400).json({ error: error.message });
      return;
    }
    console.error(error);
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
    console.error(error);
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

    const baseUrl = normalizeSeraBaseUrl(input.seraApiBaseUrl);
    const mode = modeFromBaseUrl(baseUrl);
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
      sensitiveResponse: true,
    });

    const apiKey = result.api_key ?? result.apiKey ?? "";
    const apiSecret = result.api_secret ?? result.apiSecret ?? "";
    const credential = result.credential || (apiKey && apiSecret ? `${apiKey}:${apiSecret}` : "");
    if (!credential) {
      res.status(502).json({ error: "Sera API did not return an api_key/api_secret pair." });
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
      res.status(400).json({ error: error.message });
      return;
    }
    res.status(502).json({ error: error instanceof Error ? error.message : "Unable to generate Sera API key" });
  }
});

gatewayRouter.post("/webhooks/sera", async (req, res) => {
  try {
    const payload = seraWebhookPayloadSchema.parse(req.body);
    const intent = await getPaymentIntentById(payload.paymentIntentId);
    if (!intent) {
      res.status(404).json({ error: "Payment intent not found" });
      return;
    }

    const config = await getApiKeyConfigRecord(intent.merchantId);
    const secret = decryptSecret(config?.seraWebhookSecretEncrypted);
    if (secret) {
      // TODO(Sera API): replace this shared-secret check with the exact Sera
      // webhook signature header and raw-body HMAC scheme once documented.
      const supplied = req.header("x-sera-webhook-secret");
      if (supplied !== secret) {
        res.status(401).json({ error: "Invalid Sera webhook secret" });
        return;
      }
    }

    await updatePaymentIntent(intent.id, { status: payload.status });

    if (payload.status === "paid" && payload.txHash) {
      const existingTx = await getTransactionByHash(payload.txHash);
      if (!existingTx) {
        await createTransaction({
          id: uuidv4(),
          merchantId: intent.merchantId,
          txHash: payload.txHash,
          fromAddress: payload.fromAddress ?? null,
          toAddress: payload.toAddress ?? intent.receiverAddress,
          coin: payload.coin ?? intent.coin,
          amount: payload.amount ?? intent.amount,
          chainId: intent.chainId,
          status: "confirmed",
          verified: 1,
          memo: intent.description,
          notes: `Sera webhook paymentIntentId=${intent.id}`,
          notifiedAt: new Date(),
          webhookSentAt: new Date(),
        });
      }
    }

    res.json({ received: true });
  } catch (error) {
    if (validationError(res, error)) return;
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});
