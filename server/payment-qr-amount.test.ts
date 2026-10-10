import { describe, expect, it } from "vitest";
import { generatePaymentQrInputSchema } from "../shared/payment-qr";
import { estimateQrPayAmount } from "./payment-qr-amount";

const input = { baseAmount: "100", baseCurrency: "USDC", targetCurrency: "XSGD" };

describe("QR amount calculation", () => {
  it.each([
    ["100", 1.3, 6, "130"],
    ["1", 0.00000001, 6, "0.000001"],
    ["3", 1.23456789, 2, "3.71"],
    ["0.000001", 1.000001, 18, "0.000002"],
    ["1", 1.01, 0, "2"],
    ["9007199254.740991", 1, 6, "9007199254.740991"],
    ["2", 1e7, 6, "20000000"],
  ])("rounds %s at rate %s to token decimals %s", (amount, rate, decimals, expected) => {
    expect(estimateQrPayAmount(amount, rate, decimals)).toBe(expected);
  });

  it.each([0, -1, Infinity, NaN])("rejects invalid rate %s", (rate) => {
    expect(() => estimateQrPayAmount("1", rate, 6)).toThrow("invalid exchange rate");
  });

  it("rejects overflow and malformed token precision", () => {
    expect(() => estimateQrPayAmount("9007199254", 2, 6)).toThrow("exceeds");
    expect(() => estimateQrPayAmount("1", 1, -1)).toThrow("invalid token decimals");
    expect(() => estimateQrPayAmount("1", 1, 1.5)).toThrow("invalid token decimals");
  });

  it("preserves exact normalized decimal input up to the checkout limit", () => {
    expect(generatePaymentQrInputSchema.parse({ ...input, baseAmount: "9007199254.740991" }).baseAmount).toBe("9007199254.740991");
    expect(generatePaymentQrInputSchema.parse({ ...input, baseAmount: "000.010000" }).baseAmount).toBe("0.01");
  });
});
