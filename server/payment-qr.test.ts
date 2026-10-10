import express from "express";
import { createServer, type Server } from "http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Merchant, PaymentIntent } from "../drizzle/schema";
import { buildWalletPaymentUri } from "../shared/wallet-payment-uri";
import { ENV } from "./_core/env";
import { verifyCheckoutPayload } from "./checkout-payload";
import { screenWalletAddress } from "./compliance";
import { createPaymentIntent, getApiKeyConfigRecord, getMerchantByApiKey, getMerchantByStoreAddress, getMerchantByWallet } from "./db";
import { assertPaymentIntentBindable } from "./payment-binding";
import { createPaymentQrRouter } from "./payment-qr-routes";
import { paymentRouter, fetchSeraRestFxRate, SeraRateLimitedError } from "./payment-routes";
import type { PaymentQrExchangeRate } from "./payment-qr-service";
import { QrImageError, renderPaymentQrPng } from "./qr-image";
import { callSeraApi, getSeraTokens, SeraApiError, type SeraToken } from "./sera-api";
import type { SeraSwapQuoteRequest } from "./sera-swap-quote";
import { decodeQrCard } from "./test-utils/qr-image";

vi.mock("./db", () => ({
  getMerchantByApiKey: vi.fn(),
  getMerchantByWallet: vi.fn(),
  getMerchantByStoreAddress: vi.fn(),
  getApiKeyConfigRecord: vi.fn(),
  createPaymentIntent: vi.fn(),
  getPendingTransactions: vi.fn(async () => []),
  getPendingSeraSwapTransactions: vi.fn(async () => []),
  getUnsyncedSeraSwapOutcomes: vi.fn(async () => []),
}));
vi.mock("./compliance", () => ({ screenWalletAddress: vi.fn() }));
vi.mock("./sera-api", async (importOriginal) => ({
  ...await importOriginal<typeof import("./sera-api")>(),
  getSeraTokens: vi.fn(),
  callSeraApi: vi.fn(),
}));
vi.mock("./qr-image", () => ({
  renderPaymentQrPng: vi.fn(),
  QrImageError: class extends Error {
    constructor(message: string, readonly status = 422) { super(message); }
  },
}));

const WALLET = "0x1111111111111111111111111111111111111111";
const RECEIVER = "0x2222222222222222222222222222222222222222";
const SERA = "0x5555555555555555555555555555555555555555";
const SOR = "0x7777777777777777777777777777777777777777";
const NOW = 2_000_000_000;
const input = { baseAmount: "100", baseCurrency: "USDC", targetCurrency: "XSGD" };
const exchangeRate = vi.fn<PaymentQrExchangeRate>();
const tokens: SeraToken[] = [
  { symbol: "USDC", address: "0x3333333333333333333333333333333333333333", decimals: 6, currency: "USD", min_trade_amount_raw: "10000000", min_trade_amount: "10" },
  { symbol: "XSGD", address: "0x4444444444444444444444444444444444444444", decimals: 6, currency: "SGD", min_trade_amount_raw: "10000000", min_trade_amount: "10" },
  { symbol: "IDRT", address: "0x8888888888888888888888888888888888888888", decimals: 2, currency: "IDR", min_trade_amount_raw: "1000", min_trade_amount: "10" },
];

function makeMerchant(): Merchant {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    walletAddress: WALLET,
    storeAddress: RECEIVER,
    name: "Test store",
    apiKey: "sk_test",
    receiveCoin: "USDC",
    description: null,
    logoData: null,
    qrFgColor: "#123456",
    qrBgColor: "#ffffff",
    qrStyle: "rounded",
    qrMode: "standard",
    webhookUrl: null,
    webhookSecret: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function quote(request: SeraSwapQuoteRequest) {
  return {
    uuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    route_params: {
      taker: request.owner_address,
      inputToken: request.from_token,
      outputToken: request.to_token,
      maxInputAmount: request.from_amount,
      minOutputAmount: "100000000",
      recipient: request.recipient,
      initialDepositAmount: request.from_amount,
      uuid: "123456789",
      deadline: request.expiration,
    },
    fee_breakdown: { gas_cost_usd: "0", gas_cost_from_token: "0" },
    expires_at: NOW + 30,
    permit: {
      permit_supported: false,
      permit_required: false,
      token: request.from_token,
      spender: SOR,
      owner: request.owner_address,
      value_raw: request.from_amount,
      current_allowance_raw: "0",
    },
  };
}

let server: Server;
let origin: string;
let merchant: Merchant;
const originalEnv = { ...ENV };

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", createPaymentQrRouter(exchangeRate));
  app.use("/api", paymentRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  origin = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  vi.clearAllMocks();
  exchangeRate.mockImplementation(fetchSeraRestFxRate);
  merchant = makeMerchant();
  Object.assign(ENV, originalEnv, {
    paymentBaseUrl: "https://pay.example.test",
    seraEnableTestnet: false,
    seraPreflightProbeAddress: "0x9999999999999999999999999999999999999999",
    seraMaxGasCostUsd: "",
    seraMaxQuoteInputDeviationBps: "",
  });
  vi.mocked(getMerchantByApiKey).mockImplementation(async (key) => key === "sk_test" ? merchant : undefined);
  vi.mocked(getMerchantByWallet).mockImplementation(async (wallet) => wallet === merchant.walletAddress ? merchant : undefined);
  vi.mocked(getMerchantByStoreAddress).mockImplementation(async (wallet) => wallet === merchant.storeAddress ? merchant : undefined);
  vi.mocked(getApiKeyConfigRecord).mockResolvedValue(undefined);
  vi.mocked(createPaymentIntent).mockResolvedValue();
  vi.mocked(screenWalletAddress).mockResolvedValue({
    address: RECEIVER, status: "clear", blocked: false, identifications: [],
    provider: "chainalysis-sanctions", checkType: "recipient_wallet", message: "Clear",
  });
  vi.mocked(renderPaymentQrPng).mockResolvedValue("data:image/png;base64,test");
  vi.mocked(getSeraTokens).mockResolvedValue({ tokens });
  vi.mocked(callSeraApi).mockImplementation(async (options) => {
    switch (options.path) {
      case "/system/time": return { timestamp: NOW };
      case "/fx/rate": return { rate: "1.3", as_of: NOW };
      case "/config": return {
        chain_id: options.baseUrl?.includes("testnet") ? 11155111 : 1,
        sera_address: SERA,
        vault_address: "0x6666666666666666666666666666666666666666",
        sor_address: SOR,
        domain_separator: `0x${"8".repeat(64)}`,
        eip712_domain: { name: "Sera", version: "1", chainId: options.baseUrl?.includes("testnet") ? 11155111 : 1, verifyingContract: SERA },
      };
      case "/swap/quote": return quote(options.body as SeraSwapQuoteRequest);
      default: throw new Error(`Unexpected Sera call: ${options.path}`);
    }
  });
  const fetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((url, options) => {
    if (!String(url).startsWith(`${origin}/`)) throw new Error(`Unexpected external fetch: ${url}`);
    return fetch(url, options);
  });
});

afterEach(() => {
  Object.assign(ENV, originalEnv);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

async function post(body: unknown, status = 201, key: string | null = "sk_test") {
  const response = await fetch(`${origin}/api/payment/qr`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key === null ? {} : { "X-Api-Key": key }) },
    body: JSON.stringify(body),
  });
  const result = response.headers.get("Content-Type")?.includes("application/json")
    ? await response.json()
    : await response.text();
  expect(response.status, JSON.stringify(result)).toBe(status);
  return { body: result, headers: response.headers };
}

describe("owner QR endpoint", () => {
  it("rejects an invalid saved receiver before screening or quoting", async () => {
    merchant.storeAddress = "invalid-wallet";
    const { body } = await post(input, 400);
    expect(body).toMatchObject({ errorCode: "invalid_receiver" });
    expect(screenWalletAddress).not.toHaveBeenCalled();
    expect(exchangeRate).not.toHaveBeenCalled();
    expect(renderPaymentQrPng).not.toHaveBeenCalled();
  });

  it("reports rate backoff with a rounded-up Retry-After header", async () => {
    exchangeRate.mockRejectedValue(new SeraRateLimitedError(1501));
    const { body, headers } = await post({ ...input, singleUse: true }, 429);
    expect(headers.get("retry-after")).toBe("2");
    expect(body).toMatchObject({ errorCode: "sera_rate_limited" });
    expect(renderPaymentQrPng).not.toHaveBeenCalled();
    expect(createPaymentIntent).not.toHaveBeenCalled();
  });

  it.each([["USDC", -1], ["XSGD", 1.5], ["XSGD", 256]] as const)("rejects invalid %s token precision %s before pricing", async (symbol, decimals) => {
    ENV.seraApiBaseUrl = `https://tokens-${symbol.toLowerCase()}-${String(decimals).replace(".", "-")}.example.test`;
    vi.mocked(getSeraTokens).mockResolvedValue({ tokens: tokens.map(token => token.symbol === symbol ? { ...token, decimals } : token) });
    const { body } = await post(input, 503);
    expect(body).toMatchObject({ errorCode: "invalid_config" });
    expect(exchangeRate).not.toHaveBeenCalled();
    expect(renderPaymentQrPng).not.toHaveBeenCalled();
  });

  it("keeps the maximum accepted amount exact in the wallet URI", async () => {
    const { body: result } = await post({ ...input, baseAmount: "9007199254.740991", targetCurrency: "USDC" });
    expect(result.targetAmount).toBe("9007199254.740991");
    expect(result.qrValue).toContain("uint256=9007199254740991");
  });

  it.each([
    ["direct", { ...input, targetCurrency: "USDC" }],
    ["conversion", input],
    ["single-use", { ...input, targetCurrency: "USDC", singleUse: true }],
  ])("returns a real scannable PNG for a %s payment", async (kind, input) => {
    const actual = await vi.importActual<typeof import("./qr-image")>("./qr-image");
    vi.mocked(renderPaymentQrPng).mockImplementation(actual.renderPaymentQrPng);
    const { body } = await post(input);
    expect(decodeQrCard(body.qrCodeDataUrl)).toEqual({ width: 1440, height: 1840, value: body.qrValue });
    if (kind === "direct") expect(body.qrValue).toMatch(/^ethereum:/);
    else expect(body.qrValue).toBe(body.checkoutUrl);
  }, 60000);

  it.each([null, "wrong-key"])("rejects missing/invalid API keys (%s)", async (key) => {
    await post(input, 401, key);
    expect(renderPaymentQrPng).not.toHaveBeenCalled();
    expect(callSeraApi).not.toHaveBeenCalled();
  });

  it("returns a retryable response when API key lookup fails", async () => {
    vi.mocked(getMerchantByApiKey).mockRejectedValueOnce(new Error("Database connection timed out"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { body } = await post(input, 503);
    expect(body).toEqual({ error: "Database is temporarily unavailable. Please retry." });
    expect(renderPaymentQrPng).not.toHaveBeenCalled();
    expect(callSeraApi).not.toHaveBeenCalled();
  });

  it("creates a signed reusable conversion QR using the saved receiving wallet and branding", async () => {
    const { body, headers } = await post({ ...input, baseAmount: "00100.000000", baseCurrency: " usdc ", targetCurrency: "xsgd" });
    expect(headers.get("cache-control")).toBe("no-store");
    expect(body).toMatchObject({
      ...input, targetAmount: "130", receiverAddress: RECEIVER, chainId: 1,
      singleUse: false, paymentIntentId: null, requiresCustomerRequote: true,
      qrCodeDataUrl: "data:image/png;base64,test",
    });
    expect(body.checkoutUrl).toMatch(/^https:\/\/pay\.example\.test\/pay\//);
    expect(body.qrValue).toBe(body.checkoutUrl);
    expect(verifyCheckoutPayload(body.checkoutUrl.split("/pay/")[1])).toMatchObject({
      amount: "100", receiveCoin: "USDC", payCoin: "XSGD", payAmount: "130",
      receiverAddress: RECEIVER, singleUse: false, chainId: 1,
    });
    expect(renderPaymentQrPng).toHaveBeenCalledWith(body.qrValue, merchant, { amount: "130", coin: "XSGD" });
    expect(createPaymentIntent).not.toHaveBeenCalled();
    const quoteCall = vi.mocked(callSeraApi).mock.calls.find(([options]) => options.path === "/swap/quote")?.[0];
    expect(quoteCall?.body).toMatchObject({
      from_token: tokens[1].address, to_token: tokens[0].address, from_amount: "130000000", recipient: RECEIVER,
    });
  });

  it("persists a single-use intent bound to the signed link and existing paid-state enforcement", async () => {
    const { body } = await post({ ...input, singleUse: true });
    expect(body.singleUse).toBe(true);
    expect(body.qrValue).toBe(body.checkoutUrl);
    const saved = vi.mocked(createPaymentIntent).mock.calls[0][0];
    expect(saved).toMatchObject({
      id: body.paymentIntentId, merchantId: merchant.id, amount: "100", coin: "USDC",
      receiverAddress: RECEIVER, status: "open", checkoutUrl: body.checkoutUrl, expiresAt: null,
    });
    expect(verifyCheckoutPayload(body.checkoutUrl.split("/pay/")[1])).toMatchObject({
      singleUse: true, paymentIntentId: saved.id, amount: saved.amount, receiveCoin: saved.coin,
    });
    const intent: PaymentIntent = {
      ...saved, subWalletId: null, chainId: 1, customerEmail: null, customerName: null,
      description: null, metadata: saved.metadata ?? null, status: "open", transactionId: null,
      expiresAt: null, createdAt: new Date(), updatedAt: new Date(),
    };
    const binding = { merchantId: merchant.id, receiverAddress: RECEIVER, receiveCoin: "USDC", chainId: 1 };
    expect(assertPaymentIntentBindable(intent, binding)).toBe("100");
    expect(() => assertPaymentIntentBindable({ ...intent, status: "paid" }, binding)).toThrow("already been paid");
    expect(vi.mocked(renderPaymentQrPng).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(createPaymentIntent).mock.invocationCallOrder[0]);
  });

  it("supports direct payments without FX or swap liquidity, including wallet fallback", async () => {
    merchant.storeAddress = null;
    const { body } = await post({ ...input, targetCurrency: "USDC" });
    expect(body).toMatchObject({ targetAmount: "100", receiverAddress: WALLET, requiresCustomerRequote: false });
    expect(body.qrValue).toBe(buildWalletPaymentUri({
      receiverAddress: WALLET, coin: "USDC", amount: "100", chainId: 1,
      tokenAddress: tokens[0].address, tokenDecimals: tokens[0].decimals,
    }));
    expect(body.qrValue).toBe(`ethereum:${tokens[0].address}@1/transfer?address=${WALLET}&uint256=100000000`);
    expect(renderPaymentQrPng).toHaveBeenCalledWith(body.qrValue, merchant, { amount: "100", coin: "USDC" });
    expect(callSeraApi).not.toHaveBeenCalled();
  });

  it("keeps single-use same-currency scans on checkout rather than bypassing enforcement", async () => {
    const { body } = await post({ ...input, targetCurrency: "USDC", singleUse: true });
    expect(body.qrValue).toBe(body.checkoutUrl);
    expect(body.qrValue).not.toMatch(/^ethereum:/);
    expect(verifyCheckoutPayload(body.qrValue.split("/pay/")[1])).toMatchObject({
      singleUse: true, paymentIntentId: body.paymentIntentId, amount: "100",
    });
  });

  it("preserves the existing dashboard preflight response through the shared quote helper", async () => {
    const response = await fetch(`${origin}/api/payment/swap/preflight`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": "sk_test" },
      body: JSON.stringify({
        receiverAddress: RECEIVER, payCoin: "XSGD", receiveCoin: "USDC",
        receiveAmount: "100", estimatedPayAmount: "130", chainId: 1,
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      executable: true, toAddress: RECEIVER, payCoin: "XSGD", receiveCoin: "USDC", chainId: 1,
      requestedPayAmount: "130", maximumPayAmount: "130", targetReceiveAmount: "100",
      minimumReceiveAmount: "100", requiresCustomerRequote: true,
    });
  });

  it.each([
    { ...input, baseAmount: "0" }, { ...input, baseAmount: "-1" },
    { ...input, baseAmount: "1e2" }, { ...input, baseAmount: "Infinity" },
    { ...input, baseAmount: 100 }, { ...input, baseAmount: "0.0000001" },
    { ...input, baseAmount: "9007199254.740992" },
    { ...input, baseAmount: "1000000000000000000" },
    { ...input, singleUse: "false" }, { ...input, targetCurrency: "??" },
    { ...input, receiverAddress: WALLET }, { ...input, chainId: 137 },
    { baseAmount: "100", baseCurrency: "USDC" }, null, [],
  ])("rejects invalid or overriding request fields: %j", async (body) => {
    await post(body, 400);
    expect(renderPaymentQrPng).not.toHaveBeenCalled();
    expect(createPaymentIntent).not.toHaveBeenCalled();
  });

  it("rejects unknown tokens and excess token-specific precision", async () => {
    const { body: unsupported } = await post({ ...input, targetCurrency: "UNKNOWN" }, 400);
    expect(unsupported).toMatchObject({ errorCode: "unsupported_token" });
    const { body: precision } = await post({ baseAmount: "10.001", baseCurrency: "IDRT", targetCurrency: "IDRT" }, 400);
    expect(precision).toMatchObject({ errorCode: "invalid_request", field: "baseAmount" });
    expect(renderPaymentQrPng).not.toHaveBeenCalled();
  });

  it("does not silently increase the requested payment to meet a swap minimum", async () => {
    const { body } = await post({ ...input, baseAmount: "1" }, 400);
    expect(body).toMatchObject({ errorCode: "amount_below_min" });
    expect(renderPaymentQrPng).not.toHaveBeenCalled();
  });

  it("uses the executable fixed-output estimate rather than the bare FX amount", async () => {
    const implementation = vi.mocked(callSeraApi).getMockImplementation()!;
    vi.mocked(callSeraApi).mockImplementation(async (options) => {
      if (options.path !== "/swap/quote") return implementation(options);
      const request = options.body as SeraSwapQuoteRequest;
      const result = quote(request);
      result.route_params.minOutputAmount = (BigInt(request.from_amount) * 9n / 13n).toString();
      return result;
    });
    const { body } = await post(input);
    expect(Number(body.targetAmount)).toBeGreaterThan(130);
    expect(verifyCheckoutPayload(body.checkoutUrl.split("/pay/")[1])).toMatchObject({
      amount: "100", payAmount: body.targetAmount,
    });
    expect(vi.mocked(callSeraApi).mock.calls.filter(([options]) => options.path === "/swap/quote").length).toBeGreaterThan(1);
  });

  it("surfaces Sera outages without creating a link", async () => {
    vi.mocked(callSeraApi).mockRejectedValue(new SeraApiError(503, "unavailable"));
    const { body } = await post({ ...input, singleUse: true }, 503);
    expect(body).toMatchObject({ errorCode: "sera_unavailable" });
    expect(createPaymentIntent).not.toHaveBeenCalled();
    expect(renderPaymentQrPng).not.toHaveBeenCalled();
  });

  it("does not generate or save a QR when preflight has no liquidity", async () => {
    const implementation = vi.mocked(callSeraApi).getMockImplementation()!;
    vi.mocked(callSeraApi).mockImplementation(async (options) => {
      if (options.path === "/swap/quote") throw new SeraApiError(409, "No liquidity", null, "NO_LIQUIDITY");
      return implementation(options);
    });
    const { body } = await post({ ...input, singleUse: true }, 409);
    expect(body).toMatchObject({ errorCode: "no_liquidity" });
    expect(renderPaymentQrPng).not.toHaveBeenCalled();
    expect(createPaymentIntent).not.toHaveBeenCalled();
  });

  it("screens the recipient before requesting a quote", async () => {
    vi.mocked(screenWalletAddress).mockResolvedValue({
      address: RECEIVER, status: "blocked", blocked: true, identifications: [],
      provider: "chainalysis-sanctions", checkType: "recipient_wallet", message: "Blocked",
    });
    await post(input, 403);
    expect(callSeraApi).not.toHaveBeenCalled();
    expect(renderPaymentQrPng).not.toHaveBeenCalled();
  });

  it.each([
    ["live", true, 1], ["mock", true, 1], ["test", false, 1], ["test", true, 11155111],
  ] as const)("respects saved mode %s with testnet enabled=%s", async (mode, enabled, chainId) => {
    ENV.seraEnableTestnet = enabled;
    vi.mocked(getApiKeyConfigRecord).mockResolvedValue({
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      merchantId: merchant.id, mode, seraApiBaseUrl: "", seraApiKeyEncrypted: null,
      seraApiKeyLast4: null, seraWebhookSecretEncrypted: null, seraWebhookSecretLast4: null,
      createdAt: new Date(), updatedAt: new Date(),
    });
    const { body } = await post({ ...input, targetCurrency: "USDC" });
    expect(body.chainId).toBe(chainId);
    expect(verifyCheckoutPayload(body.checkoutUrl.split("/pay/")[1])?.chainId).toBe(chainId);
  });

  it("returns rendering errors without leaving an intent behind", async () => {
    vi.mocked(renderPaymentQrPng).mockRejectedValue(new QrImageError("Unable to load merchant logo", 422));
    const { body } = await post({ ...input, singleUse: true }, 422);
    expect(body).toMatchObject({ errorCode: "qr_image_unavailable" });
    expect(createPaymentIntent).not.toHaveBeenCalled();
  });

  it("returns a failure rather than a usable-looking response if persistence fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(createPaymentIntent).mockRejectedValue(new Error("database down"));
    const { body } = await post({ ...input, singleUse: true }, 500);
    expect(body).toEqual({ error: "Unable to generate payment QR", errorCode: "internal_error" });
  });

  it("fails closed when production checkout signing is unavailable", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_SECRET", "");
    await post(input, 503);
    expect(renderPaymentQrPng).not.toHaveBeenCalled();
    expect(createPaymentIntent).not.toHaveBeenCalled();
  });
});
