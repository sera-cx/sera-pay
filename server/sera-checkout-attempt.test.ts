import { describe, expect, it } from "vitest";
import { deriveSeraCheckoutAttemptKey } from "./sera-checkout-attempt";

const payer = "0x1111111111111111111111111111111111111111";

describe("durable Sera checkout-attempt key", () => {
  it("is deterministic, normalized, and database-sized", () => {
    const first = deriveSeraCheckoutAttemptKey("signed.body.signature", payer.toUpperCase().replace("0X", "0x"));
    const second = deriveSeraCheckoutAttemptKey("signed.body.signature", payer);
    expect(first).toBe(second);
    expect(first).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("separates signed checkout snapshots and payer wallets", () => {
    const key = deriveSeraCheckoutAttemptKey("signed.body.signature", payer);
    expect(deriveSeraCheckoutAttemptKey("signed.other.signature", payer)).not.toBe(key);
    expect(deriveSeraCheckoutAttemptKey(
      "signed.body.signature",
      "0x2222222222222222222222222222222222222222",
    )).not.toBe(key);
  });

  it("rejects unsigned/empty identity inputs", () => {
    expect(() => deriveSeraCheckoutAttemptKey("", payer)).toThrow(/cannot be empty/);
    expect(() => deriveSeraCheckoutAttemptKey("signed", "not-an-address")).toThrow(/normalized EVM address/);
  });
});
