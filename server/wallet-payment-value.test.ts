import { describe, expect, it } from "vitest";
import { buildWalletPaymentUri, parseAmountToRaw } from "../shared/wallet-payment-uri";
import { formatDecimalAmount, formatDecimalAmountForDisplay, limitDecimalPlaces } from "../shared/decimal-input";

const request = {
  receiverAddress: "0x2222222222222222222222222222222222222222",
  coin: "USDC",
  tokenAddress: "0x3333333333333333333333333333333333333333",
  tokenDecimals: 6,
};

describe("exact wallet payment amounts", () => {
  it.each(["-1", "+1", "1e3", "1,000", "1.2.3", "1abc", "0", "0.0000001", "1.0000001"])(
    "refuses an invalid or unrepresentable amount instead of changing it: %s", (amount) => {
      expect(buildWalletPaymentUri({ ...request, amount })).toBe("");
    },
  );

  it("preserves all native wei and token units without using floating point", () => {
    expect(buildWalletPaymentUri({ ...request, coin: "ETH", amount: "0.000000000000000001" }))
      .toBe(`ethereum:${request.receiverAddress}@1?value=1&gas=21000`);
    expect(buildWalletPaymentUri({ ...request, tokenDecimals: 18, amount: "1.000000000000000001" }))
      .toContain("uint256=1000000000000000001");
    expect(parseAmountToRaw("9007199254.740991", 6)).toBe(9007199254740991n);
  });

  it("accepts zero-decimal tokens and insignificant trailing fractional zeroes", () => {
    expect(buildWalletPaymentUri({ ...request, tokenDecimals: 0, amount: "100.000" })).toContain("uint256=100");
    expect(parseAmountToRaw("001.230000", 2)).toBe(123n);
    expect(() => parseAmountToRaw("1.231", 2)).toThrow(/precision/);
  });

  it("allows amount-free requests while refusing supplied invalid native amounts", () => {
    expect(buildWalletPaymentUri(request)).toBe(`ethereum:${request.tokenAddress}@1/transfer?address=${request.receiverAddress}`);
    expect(buildWalletPaymentUri({ ...request, coin: "ETH", amount: "-1" })).toBe("");
  });

  it.each([null, undefined, -1, 1.5, 256, NaN])("rejects missing or invalid token precision: %s", (tokenDecimals) => {
    expect(buildWalletPaymentUri({ ...request, tokenDecimals, amount: "1" })).toBe("");
  });

  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid chain identifiers: %s", (chainId) => {
    expect(buildWalletPaymentUri({ ...request, chainId, amount: "1" })).toBe("");
  });

  it("refuses amounts that cannot fit in a wallet's uint256", () => {
    const limit = 1n << 256n;
    expect(buildWalletPaymentUri({ ...request, tokenDecimals: 0, amount: (limit - 1n).toString() }))
      .toContain(`uint256=${limit - 1n}`);
    expect(buildWalletPaymentUri({ ...request, tokenDecimals: 0, amount: limit.toString() })).toBe("");
  });
});

describe("payment amount display", () => {
  it("displays the checkout maximum without rounding away a micro-unit", () => {
    expect(formatDecimalAmountForDisplay("9007199254.740991", "en-US")).toBe("9,007,199,254.740991");
    expect(formatDecimalAmountForDisplay("9007199254.740991", "de-DE")).toBe("9.007.199.254,740991");
    expect(formatDecimalAmountForDisplay("100.000000", "en-US")).toBe("100");
  });

  it("preserves integer zeroes when formatting zero-decimal currencies", () => {
    expect(formatDecimalAmount("100", 0)).toBe("100");
    expect(formatDecimalAmount("0", 0)).toBe("0");
    expect(formatDecimalAmount("10.120000")).toBe("10.12");
    expect(formatDecimalAmount("100.000000")).toBe("100");
  });

  it("keeps permissive form cleanup separate from strict wallet amount parsing", () => {
    expect(limitDecimalPlaces("1,234.1234567")).toBe("1234.123456");
    expect(limitDecimalPlaces(".5")).toBe("0.5");
  });
});
