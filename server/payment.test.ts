import { describe, it, expect } from "vitest";
import type { Transaction } from "../drizzle/schema";

describe("Sera API audit log redaction", () => {
  it.each([
    "/swap/quote",
    "/swap",
    "/orders",
    "/fills",
    "/balances",
    "/api-keys",
    "/permit",
    "/transfer",
    "/withdraw",
  ])("redacts request and response payloads for %s", async (path) => {
    const { isSensitiveSeraAuditPayload } = await import("./sera-api");
    expect(isSensitiveSeraAuditPayload(path, "request")).toBe(true);
    expect(isSensitiveSeraAuditPayload(path, "response")).toBe(true);
  });

  it("keeps non-transactional registry responses available for diagnostics", async () => {
    const { isSensitiveSeraAuditPayload } = await import("./sera-api");
    expect(isSensitiveSeraAuditPayload("/tokens", "request")).toBe(false);
    expect(isSensitiveSeraAuditPayload("/markets", "response")).toBe(false);
  });
});

describe("Sera settlement tracking", () => {
  it("computes the exact struct hash emitted by a live SeraSOR IntentMatched event", async () => {
    const { hashSeraIntentStruct } = await import("./sera-intent");
    const hash = hashSeraIntentStruct({
      taker: "0x1214d5d6340B010eE83529417d4eb6f26778963e",
      inputToken: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      outputToken: "0x3Fc98a885E99420d0ce43Bcb81bF21A4e3F45E5f",
      maxInputAmount: "35412440000",
      minOutputAmount: "143416032813",
      recipient: "0x1214d5d6340B010eE83529417d4eb6f26778963e",
      initialDepositAmount: "35412440000",
      uuid: "589531935230036357682167359874103379040761013914032481661750112100805398528",
      deadline: "1784630196",
    });
    expect(hash).toBe("0x0b301dfff325d82ca84accd180051be983def7c7b0b73f75d807c1416053ad6b");
  }, 10_000);
});

// Test the stablecoins data structure
describe("stablecoins lib", () => {
  it("should have USDT and USDC in the stablecoins list", async () => {
    // Dynamic import to test the client-side lib from server context
    const { STABLECOINS } = await import("../client/src/lib/stablecoins");
    const symbols = STABLECOINS.map((c) => c.symbol);
    expect(symbols).toContain("USDT");
    expect(symbols).toContain("USDC");
  });

  it("each stablecoin should have required fields", async () => {
    const { STABLECOINS } = await import("../client/src/lib/stablecoins");
    for (const coin of STABLECOINS) {
      expect(coin.symbol).toBeTruthy();
      expect(coin.name).toBeTruthy();
      expect(coin.decimals).toBeGreaterThan(0);
    }
  });

  it.each(["USDC", "USDT", "XSGD", "IDRT", "MYRT", "EUROP", "CADC"])("has a display logo fallback for %s", async (symbol) => {
    const { getStablecoinLogoUrl } = await import("../client/src/lib/stablecoins");
    expect(getStablecoinLogoUrl(symbol)).toBe(`https://app.sera.cx/stablecoins/${symbol.toLowerCase()}.png`);
  });

  it("uses Sera's own default stablecoin artwork when a symbol image is unavailable", async () => {
    const { getStablecoinDefaultLogoUrl } = await import("../client/src/lib/stablecoins");
    expect(getStablecoinDefaultLogoUrl()).toBe("https://app.sera.cx/stablecoins/default.png");
  });
});

// Test the payment URL encoder directly (no window dependency)
describe("payment URL encoder", () => {
  it("should encode and decode a payment request correctly", async () => {
    const { encodePaymentRequest, decodePaymentRequest } = await import("../client/src/lib/payment");
    const req = {
      receiverAddress: "0x1234567890abcdef1234567890abcdef12345678",
      receiveCoin: "USDT",
      amount: "100",
      merchantName: "Test Merchant",
      chainId: 11155111,
    };
    const encoded = encodePaymentRequest(req);
    expect(encoded).toBeTruthy();
    expect(typeof encoded).toBe("string");
    const decoded = decodePaymentRequest(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded!.receiverAddress).toBe(req.receiverAddress);
    expect(decoded!.receiveCoin).toBe(req.receiveCoin);
    expect(decoded!.amount).toBe(req.amount);
    expect(decoded!.chainId).toBe(req.chainId);
  });

  it("resolves every non-test mode to Ethereum mainnet", async () => {
    const { resolvePaymentChainId, LIVE_PAYMENT_CHAIN_ID, TEST_PAYMENT_CHAIN_ID } =
      await import("../client/src/lib/payment");

    // "mock" is the historical database default for merchants who never opened
    // the Sera API settings, and undefined is what the config query returns
    // before it resolves. Both used to land on Sepolia.
    expect(resolvePaymentChainId(undefined, undefined)).toBe(LIVE_PAYMENT_CHAIN_ID);
    expect(resolvePaymentChainId(undefined, "mock" as any)).toBe(LIVE_PAYMENT_CHAIN_ID);
    expect(resolvePaymentChainId(undefined, "live")).toBe(LIVE_PAYMENT_CHAIN_ID);
    expect(resolvePaymentChainId(null, null)).toBe(LIVE_PAYMENT_CHAIN_ID);

    // A stale chain id persisted by wagmi in the browser must not win.
    expect(resolvePaymentChainId(TEST_PAYMENT_CHAIN_ID, undefined)).toBe(LIVE_PAYMENT_CHAIN_ID);
    expect(resolvePaymentChainId(137, "live")).toBe(LIVE_PAYMENT_CHAIN_ID);

    // Only an explicit saved test mode reaches Sepolia.
    expect(resolvePaymentChainId(1, "test")).toBe(TEST_PAYMENT_CHAIN_ID);
  });

  it("keeps live QR codes on mainnet and test QR codes on Sepolia", async () => {
    const { resolvePaymentChainId, buildWalletPaymentUri, LIVE_PAYMENT_CHAIN_ID, TEST_PAYMENT_CHAIN_ID } =
      await import("../client/src/lib/payment");
    const receiverAddress = "0x1234567890abcdef1234567890abcdef12345678";

    // A LIVE merchant must never mint a Sepolia QR, whatever the wallet or a
    // stale persisted chain id says.
    for (const walletChain of [undefined, null, 1, 11155111, 137]) {
      const chainId = resolvePaymentChainId(walletChain as any, "live");
      expect(chainId).toBe(LIVE_PAYMENT_CHAIN_ID);
      const uri = buildWalletPaymentUri({
        receiverAddress, coin: "USDC", amount: "10", chainId,
        tokenAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", tokenDecimals: 6,
      });
      expect(uri).toContain("@1/transfer?");
      expect(uri).not.toContain("11155111");
    }

    // A TEST merchant must stay on Sepolia and never mint a mainnet QR.
    for (const walletChain of [undefined, null, 1, 11155111]) {
      const chainId = resolvePaymentChainId(walletChain as any, "test");
      expect(chainId).toBe(TEST_PAYMENT_CHAIN_ID);
      const uri = buildWalletPaymentUri({
        receiverAddress, coin: "CNGN", amount: "111", chainId,
        tokenAddress: "0x33d3c739c9ff714fd3d5c572eadaa1741902723d", tokenDecimals: 6,
      });
      expect(uri).toContain("@11155111/transfer?");
    }
  });

  it("defaults a wallet QR to mainnet when the chain id is missing", async () => {
    const { buildWalletPaymentUri } = await import("../client/src/lib/payment");
    // TransactionsPage and MenuManagerPage pass a nullable chainId from a
    // stored row; a Sepolia fallback here asked real customers to pay on a
    // test network.
    for (const chainId of [undefined, null, 0]) {
      const uri = buildWalletPaymentUri({
        receiverAddress: "0x1234567890abcdef1234567890abcdef12345678",
        coin: "USDC",
        amount: "5",
        chainId: chainId as any,
        tokenAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        tokenDecimals: 6,
      });
      expect(uri).toContain("@1/transfer?");
      expect(uri).not.toContain("@11155111");
    }
  });

  it("scales an 18-decimal mainnet token correctly", async () => {
    const { buildWalletPaymentUri } = await import("../client/src/lib/payment");
    // JPYC, BRZ, CADC, EURE and ZARP are 18 decimals on mainnet while the local
    // stablecoins.ts table claims 6 for every entry. Guessing 6 here would
    // under-request the payment by a factor of 10^12.
    const uri = buildWalletPaymentUri({
      receiverAddress: "0x1234567890abcdef1234567890abcdef12345678",
      coin: "JPYC",
      amount: "1",
      chainId: 1,
      tokenAddress: "0x431d5dff03120afa4bdf332c61a6e1766ef37bdb",
      tokenDecimals: 18,
    });
    expect(uri).toContain("uint256=1000000000000000000");
  });

  it("should build a Sepolia wallet QR URI with token and amount", async () => {
    const { buildWalletPaymentUri } = await import("../client/src/lib/payment");
    const receiverAddress = "0x1234567890abcdef1234567890abcdef12345678";
    const uri = buildWalletPaymentUri({
      receiverAddress,
      coin: "USDC",
      amount: "1.23",
      chainId: 11155111,
      tokenAddress: "0x965d4b4546716e416e950bc30467d128455d2d0e",
      tokenDecimals: 6,
    });
    expect(uri.toLowerCase()).toContain("ethereum:0x965d4b4546716e416e950bc30467d128455d2d0e@11155111/transfer?");
    expect(uri).toContain(`address=${receiverAddress}`);
    expect(uri).toContain("uint256=1230000");
  });

  it("should build a live wallet QR URI with token and amount", async () => {
    const { buildWalletPaymentUri } = await import("../client/src/lib/payment");
    const receiverAddress = "0x1234567890abcdef1234567890abcdef12345678";
    const uri = buildWalletPaymentUri({
      receiverAddress,
      coin: "USDC",
      amount: "2.5",
      chainId: 1,
      tokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      tokenDecimals: 6,
    });
    expect(uri.toLowerCase()).toContain("ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48@1/transfer?");
    expect(uri).toContain(`address=${receiverAddress}`);
    expect(uri).toContain("uint256=2500000");
  });

  it.each([
    {
      symbol: "XSGD",
      address: "0x70e8de73ce538da2beed35d14187f6959a8eca96",
      decimals: 6,
      amount: "12.34",
      raw: "12340000",
    },
    {
      symbol: "IDRT",
      address: "0x998ffe1e43facffb941dc337dd0468d52ba5b48a",
      decimals: 2,
      amount: "2000.25",
      raw: "200025",
    },
    {
      symbol: "USDT",
      address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
      decimals: 6,
      amount: "10",
      raw: "10000000",
    },
    {
      symbol: "MYRT",
      address: "0x3fc98a885e99420d0ce43bcb81bf21a4e3f45e5f",
      decimals: 6,
      amount: "10",
      raw: "10000000",
    },
    {
      symbol: "JPYC",
      address: "0x431d5dff03120afa4bdf332c61a6e1766ef37bdb",
      decimals: 18,
      amount: "5",
      raw: "5000000000000000000",
    },
    {
      symbol: "EUROP",
      address: "0x888883b5f5d21fb10dfeb70e8f9722b9fb0e5e51",
      decimals: 6,
      amount: "5",
      raw: "5000000",
    },
    {
      symbol: "CADC",
      address: "0xcadc0acd4b445166f12d2c07eac6e2544fbe2eef",
      decimals: 18,
      amount: "5",
      raw: "5000000000000000000",
    },
  ])("uses the exact live $symbol contract and decimals", async ({ symbol, address, decimals, amount, raw }) => {
    const { buildWalletPaymentUri } = await import("../client/src/lib/payment");
    const uri = buildWalletPaymentUri({
      receiverAddress: "0x1234567890abcdef1234567890abcdef12345678",
      coin: symbol,
      amount,
      chainId: 1,
      tokenAddress: address,
      tokenDecimals: decimals,
    });
    expect(uri.toLowerCase()).toContain(`ethereum:${address.toLowerCase()}@1/transfer?`);
    expect(uri).toContain(`uint256=${raw}`);
  });

  it("does not round a live IDRT amount that exceeds its registry precision", async () => {
    const { buildWalletPaymentUri } = await import("../client/src/lib/payment");
    expect(buildWalletPaymentUri({
      receiverAddress: "0x1234567890abcdef1234567890abcdef12345678",
      coin: "IDRT",
      amount: "2000.251",
      chainId: 1,
      tokenAddress: "0x998ffe1e43facffb941dc337dd0468d52ba5b48a",
      tokenDecimals: 2,
    })).toBe("");
  });

  it("does not silently turn an unknown ERC-20 into a plain/native payment", async () => {
    const { buildWalletPaymentUri } = await import("../client/src/lib/payment");
    expect(buildWalletPaymentUri({
      receiverAddress: "0x1234567890abcdef1234567890abcdef12345678",
      coin: "IDRX",
      amount: "1000",
      chainId: 1,
    })).toBe("");
  });

  it("never puts an http link inside a payment QR", async () => {
    const { buildPaymentQrValue } = await import("../client/src/lib/payment");
    const paymentUrl = "https://pay.sera.cx/pay/abc123";

    // Token metadata missing — the case that used to silently degrade the QR
    // into a web link that no wallet scanner can pay.
    expect(buildPaymentQrValue({
      receiverAddress: "0x1234567890abcdef1234567890abcdef12345678",
      coin: "CNGN",
      amount: "1",
      chainId: 1,
      paymentUrl,
    })).toBe("");

    // Amount finer than the token's precision — also refused, not downgraded.
    expect(buildPaymentQrValue({
      receiverAddress: "0x1234567890abcdef1234567890abcdef12345678",
      coin: "IDRT",
      amount: "2000.251",
      chainId: 1,
      tokenAddress: "0x998ffe1e43facffb941dc337dd0468d52ba5b48a",
      tokenDecimals: 2,
      paymentUrl,
    })).toBe("");

    // With full metadata it must be an ethereum: URI, never http(s).
    const valid = buildPaymentQrValue({
      receiverAddress: "0x43d671ad45b07309e91cedba0f74abb55ed8c3da",
      coin: "CNGN",
      amount: "1",
      chainId: 1,
      tokenAddress: "0x17cdb2a01e7a34cbb3dd4b83260b05d0274c8dab",
      tokenDecimals: 6,
      paymentUrl,
    });
    expect(valid.startsWith("ethereum:")).toBe(true);
    expect(valid).not.toMatch(/https?:\/\//);
    expect(valid).toContain("uint256=1000000");
  });

  it("uses an exact ERC-20 wallet QR when customer and merchant coins match", async () => {
    const { buildPaymentQrValue } = await import("../client/src/lib/payment");
    const paymentUrl = "https://pay.sera.cx/pay/example";
    const qrValue = buildPaymentQrValue({
      receiverAddress: "0x1234567890abcdef1234567890abcdef12345678",
      receiveCoin: "MYRT",
      coin: "MYRT",
      amount: "10",
      chainId: 1,
      tokenAddress: "0x3fc98a885e99420d0ce43bcb81bf21a4e3f45e5f",
      tokenDecimals: 6,
      paymentUrl,
    });
    expect(qrValue.toLowerCase()).toContain("ethereum:0x3fc98a885e99420d0ce43bcb81bf21a4e3f45e5f@1/transfer?");
  });

  it("opens the signed hosted checkout when the merchant leaves the payment coin open", async () => {
    const { buildPaymentQrValue, encodePaymentRequest } = await import("../client/src/lib/payment");
    const { buildClientAppUrl } = await import("../client/src/lib/app-url");
    const receiverAddress = "0x1234567890abcdef1234567890abcdef12345678";
    const encoded = encodePaymentRequest({
      receiverAddress,
      receiveCoin: "USDC",
      amount: "10",
      chainId: 1,
    });
    const paymentUrl = buildClientAppUrl(`/pay/${encoded}.${"A".repeat(43)}`);

    expect(buildPaymentQrValue({
      receiverAddress,
      receiveCoin: "USDC",
      receiveAmount: "10",
      chainId: 1,
      paymentUrl,
    })).toBe(paymentUrl);
  });

  it("opens the signed hosted checkout for a cross-currency payment", async () => {
    const { buildPaymentQrValue, encodePaymentRequest } = await import("../client/src/lib/payment");
    const { buildClientAppUrl } = await import("../client/src/lib/app-url");
    const receiverAddress = "0x1234567890abcdef1234567890abcdef12345678";
    const encoded = encodePaymentRequest({
      receiverAddress,
      receiveCoin: "MYRT",
      amount: "1",
      payCoin: "USDC",
      payAmount: "2.61",
      chainId: 1,
    });
    const paymentUrl = buildClientAppUrl(`/pay/${encoded}.${"A".repeat(43)}`);
    const qrValue = buildPaymentQrValue({
      receiverAddress,
      receiveCoin: "MYRT",
      receiveAmount: "1",
      coin: "USDC",
      amount: "2.61",
      chainId: 1,
      tokenAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      tokenDecimals: 6,
      paymentUrl,
    });
    expect(qrValue).toBe(paymentUrl);
  });

  it("refuses an unsigned or stale hosted conversion URL", async () => {
    const { buildPaymentQrValue, encodePaymentRequest } = await import("../client/src/lib/payment");
    const { buildClientAppUrl } = await import("../client/src/lib/app-url");
    const receiverAddress = "0x1234567890abcdef1234567890abcdef12345678";
    const encoded = encodePaymentRequest({
      receiverAddress,
      receiveCoin: "MYRT",
      amount: "1",
      payCoin: "USDC",
      payAmount: "2.61",
      chainId: 1,
    });
    const request = {
      receiverAddress,
      receiveCoin: "MYRT",
      receiveAmount: "1",
      coin: "USDC",
      amount: "2.61",
      chainId: 1,
      paymentUrl: buildClientAppUrl(`/pay/${encoded}`),
    };
    expect(buildPaymentQrValue(request)).toBe("");
    expect(buildPaymentQrValue({
      ...request,
      receiveAmount: "2",
      paymentUrl: `${request.paymentUrl}.${"A".repeat(43)}`,
    })).toBe("");
  });

  it.each(["USDC", "XSGD", "IDRX"])("keeps %s unchanged in copied checkout payloads", async (symbol) => {
    const { encodePaymentRequest, decodePaymentRequest } = await import("../client/src/lib/payment");
    const encoded = encodePaymentRequest({
      receiverAddress: "0x1234567890abcdef1234567890abcdef12345678",
      receiveCoin: symbol,
      payCoin: symbol,
      amount: "100",
      payAmount: "100",
      chainId: symbol === "IDRX" ? 11155111 : 1,
    });
    const decoded = decodePaymentRequest(encoded);
    expect(decoded?.receiveCoin).toBe(symbol);
    expect(decoded?.payCoin).toBe(symbol);
  });

  it("migrates legacy Polygon live links to the current Sera Ethereum deployment", async () => {
    const { encodePaymentRequest, decodePaymentRequest } = await import("../client/src/lib/payment");
    const encoded = encodePaymentRequest({
      receiverAddress: "0x1234567890abcdef1234567890abcdef12345678",
      receiveCoin: "XSGD",
      payCoin: "XSGD",
      amount: "5",
      chainId: 137,
    });
    const decoded = decodePaymentRequest(encoded);
    expect(decoded?.chainId).toBe(1);
    expect(decoded?.receiveCoin).toBe("XSGD");
    expect(decoded?.payCoin).toBe("XSGD");
  });

  it("uses the short public message for unavailable Sera liquidity", async () => {
    const { SERA_NO_LIQUIDITY_MESSAGE } = await import("../client/src/lib/payment");
    expect(SERA_NO_LIQUIDITY_MESSAGE).toBe("No liquidity for this pair — try another currency.");
    // Short enough to fit the merchant QR banner on one line.
    expect(SERA_NO_LIQUIDITY_MESSAGE.length).toBeLessThanOrEqual(60);
  });

  it("maps every rate failure to friendly copy, never raw upstream text", async () => {
    const { seraRateErrorMessage, SERA_NO_LIQUIDITY_MESSAGE, SERA_RATE_UNAVAILABLE_MESSAGE } =
      await import("../client/src/lib/payment");

    // No market maker quoting this pair.
    expect(seraRateErrorMessage(new Error("whatever"), "no_liquidity")).toBe(SERA_NO_LIQUIDITY_MESSAGE);
    expect(seraRateErrorMessage(new Error("Sera API 400: no_liquidity"))).toBe(SERA_NO_LIQUIDITY_MESSAGE);
    expect(seraRateErrorMessage(Object.assign(new Error(""), { errorCode: "no_liquidity" })))
      .toBe(SERA_NO_LIQUIDITY_MESSAGE);

    // Sera's FX service itself is down — this is what NGN/USD returns today.
    expect(seraRateErrorMessage(new Error("x"), "sera_fx_unavailable")).toBe(SERA_RATE_UNAVAILABLE_MESSAGE);
    expect(seraRateErrorMessage(new Error("Sera API 503: Service temporarily unavailable; please retry")))
      .toBe(SERA_RATE_UNAVAILABLE_MESSAGE);

    // An empty failure must still produce a sentence, not a blank banner.
    expect(seraRateErrorMessage(undefined)).toBe(SERA_RATE_UNAVAILABLE_MESSAGE);
    expect(seraRateErrorMessage(new Error(""))).toBe(SERA_RATE_UNAVAILABLE_MESSAGE);

    // Raw 503 wording must never reach a merchant standing at a till.
    for (const input of [
      new Error("Sera API 503: Service temporarily unavailable; please retry"),
      Object.assign(new Error(""), { errorCode: "sera_fx_unavailable" }),
    ]) {
      expect(seraRateErrorMessage(input)).not.toMatch(/503|Sera API/);
    }

    // Both must stay short enough for the inline banner.
    expect(SERA_RATE_UNAVAILABLE_MESSAGE.length).toBeLessThanOrEqual(60);
  });
});

// Test the auth logout procedure (existing test)
describe("auth.logout", () => {
  it("should be importable and have the correct structure", async () => {
    const { appRouter } = await import("./routers");
    expect(appRouter).toBeDefined();
    expect(appRouter._def.procedures).toHaveProperty("auth.logout");
  });
});

// Scan & Pay (wallet-URI QR) server-side watch and poller ownership
describe("Scan & Pay watch rows", () => {
  const RECEIVER = "0x1234567890abcdef1234567890abcdef12345678";
  const LINK = "https://pay.sera.cx/pay/abc.sig";
  const OTHER_LINK = "https://pay.sera.cx/pay/def.sig";
  const HASH = "0x" + "ab".repeat(32);
  const watchNotes = (paymentUrl: string | null) => JSON.stringify({ type: "direct_wallet_qr", paymentUrl, watch: true });
  const qrKey = { receiveAddress: RECEIVER, coin: "IDRT", amount: "2000", chainId: 1, decimals: 2, paymentUrl: LINK };

  function makeTx(overrides: Partial<Transaction> = {}): Transaction {
    return {
      id: "tx-1",
      merchantId: "merchant-1",
      txHash: null,
      fromAddress: null,
      toAddress: RECEIVER,
      coin: "IDRT",
      amount: "2000",
      amountUsd: null,
      chainId: 1,
      status: "pending",
      payCoin: "IDRT",
      payAmount: "2000",
      memo: null,
      notes: watchNotes(LINK),
      verified: 0,
      notifiedAt: null,
      webhookSentAt: null,
      createdAt: new Date("2026-09-04T10:00:00Z"),
      updatedAt: new Date("2026-09-04T10:00:00Z"),
      ...overrides,
    } as Transaction;
  }

  it("reuses the live watch row for the same QR instead of inserting another", async () => {
    const { findDirectQrWatchRow, isLiveDirectQrWatch } = await import("./payment-routes");
    // Postgres returns numeric(36,18) padded to 18 decimals; the row must
    // still match a 2-decimal IDRT amount of "2000".
    const live = makeTx({ id: "watch-live", amount: "2000.000000000000000000" });
    const rows = [
      makeTx({ id: "other-link", notes: watchNotes(OTHER_LINK) }),
      makeTx({ id: "other-coin", coin: "USDC", payCoin: "USDC" }),
      makeTx({ id: "other-amount", amount: "2000.01", payAmount: "2000.01" }),
      makeTx({ id: "checkout-row", notes: JSON.stringify({ paymentUrl: LINK }) }),
      makeTx({ id: "old-direct-row", notes: JSON.stringify({ type: "direct_wallet_qr", paymentUrl: LINK }) }),
      live,
    ];
    const found = findDirectQrWatchRow(rows, qrKey);
    expect(found?.id).toBe("watch-live");
    expect(isLiveDirectQrWatch(found!)).toBe(true);
    expect(findDirectQrWatchRow(rows, { ...qrKey, paymentUrl: OTHER_LINK })?.id).toBe("other-link");
    expect(findDirectQrWatchRow(rows, { ...qrKey, amount: "3000" })).toBeNull();
  // Importing the full payment router also loads the chain/provider stack.
  // Keep this behavioral assertion tolerant of cold CI module transforms.
  }, 60_000);

  it("returns a settled watch row as the QR's anchor but never as a live watch", async () => {
    const { findDirectQrWatchRow, isLiveDirectQrWatch } = await import("./payment-routes");
    const confirmed = makeTx({ id: "watch-paid", status: "confirmed", verified: 1, txHash: HASH });
    const expired = makeTx({ id: "watch-expired", status: "canceled" });
    for (const row of [confirmed, expired]) {
      // Newest first, as getMerchantTransactions orders them.
      expect(findDirectQrWatchRow([row], qrKey)?.id).toBe(row.id);
      expect(isLiveDirectQrWatch(row)).toBe(false);
    }
  }, 15_000);

  it("keeps unpaid watch rows out of the merchant's list until a transfer confirms them", async () => {
    const { isUnpaidDirectQrWatch, isDirectQrWatchTransaction } = await import("./payment-routes");
    expect(isUnpaidDirectQrWatch(makeTx())).toBe(true);
    expect(isUnpaidDirectQrWatch(makeTx({ status: "canceled" }))).toBe(true);
    expect(isUnpaidDirectQrWatch(makeTx({ status: "confirmed", verified: 1, txHash: HASH }))).toBe(false);
    // Rows the scan route recorded directly, or the sweep, are payments.
    const plain = makeTx({ txHash: HASH, status: "confirmed", notes: JSON.stringify({ type: "direct_wallet_qr", paymentUrl: LINK }) });
    expect(isDirectQrWatchTransaction(plain)).toBe(false);
    expect(isUnpaidDirectQrWatch(plain)).toBe(false);
    expect(isDirectQrWatchTransaction(makeTx({ notes: "free text the merchant typed" }))).toBe(false);
    expect(isDirectQrWatchTransaction(makeTx({ notes: null }))).toBe(false);
  }, 15_000);

  it("reports a transfer already on file only when it belongs to this QR", async () => {
    const { directTransferBelongsToQr } = await import("./payment-routes");
    const watchStartedAt = new Date("2026-09-04T10:00:00Z");
    const before = new Date("2026-09-04T09:59:30Z");
    const after = new Date("2026-09-04T10:00:20Z");
    const recorded = (notes: string | null, createdAt: Date) =>
      makeTx({ txHash: HASH, status: "confirmed", verified: 1, notes, createdAt });

    // The watch row the sweep confirmed, or a re-poll of this QR's own record.
    expect(directTransferBelongsToQr(recorded(watchNotes(LINK), watchStartedAt), LINK, watchStartedAt)).toBe(true);
    expect(directTransferBelongsToQr(recorded(JSON.stringify({ type: "direct_wallet_qr", paymentUrl: LINK }), after), LINK, watchStartedAt)).toBe(true);
    // The sweep records what it cannot match without a link.
    expect(directTransferBelongsToQr(recorded(JSON.stringify({ type: "direct_wallet_qr", paymentUrl: null }), after), LINK, watchStartedAt)).toBe(true);
    expect(directTransferBelongsToQr(recorded(null, after), LINK, watchStartedAt)).toBe(true);

    // Another QR's payment in the look-back window.
    expect(directTransferBelongsToQr(recorded(JSON.stringify({ type: "direct_wallet_qr", paymentUrl: OTHER_LINK }), after), LINK, watchStartedAt)).toBe(false);
    // The previous customer's identically priced QR carries the identical
    // link; only the watch's start time tells them apart.
    expect(directTransferBelongsToQr(recorded(watchNotes(LINK), before), LINK, watchStartedAt)).toBe(false);
    expect(directTransferBelongsToQr(recorded(null, before), LINK, watchStartedAt)).toBe(false);

    // Without a watch row (a receiver no merchant owns) the link alone decides.
    expect(directTransferBelongsToQr(recorded(watchNotes(LINK), before), LINK, null)).toBe(true);
    expect(directTransferBelongsToQr(recorded(JSON.stringify({ paymentUrl: OTHER_LINK }), before), LINK, null)).toBe(false);
  }, 15_000);
});
