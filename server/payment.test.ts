import { describe, it, expect } from "vitest";

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

  it("should build a Sepolia wallet QR URI with token and amount", async () => {
    const { buildWalletPaymentUri } = await import("../client/src/lib/payment");
    const receiverAddress = "0x1234567890abcdef1234567890abcdef12345678";
    const uri = buildWalletPaymentUri({
      receiverAddress,
      coin: "USDC",
      amount: "1.23",
      chainId: 11155111,
    });
    expect(uri.toLowerCase()).toContain("ethereum:0x1c7d4b196cb0c7b01d743fbc6116a902379c7238@11155111/transfer?");
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
    });
    expect(uri.toLowerCase()).toContain("ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48@1/transfer?");
    expect(uri).toContain(`address=${receiverAddress}`);
    expect(uri).toContain("uint256=2500000");
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
