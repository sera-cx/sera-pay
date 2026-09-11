import { describe, it, expect } from "vitest";
import type { Transaction } from "../drizzle/schema";

function tx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    merchantId: "22222222-2222-4222-8222-222222222222",
    txHash: null,
    fromAddress: null,
    toAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    coin: "USDC",
    amount: "5",
    chainId: 8453,
    status: "pending",
    verified: 0,
    payCoin: "USDC",
    payAmount: "5",
    notes: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  } as Transaction;
}

const LINK = "https://sera.pay/pay/qr-a";
const OTHER_LINK = "https://sera.pay/pay/qr-b";

describe("selectDirectPaymentCandidate", () => {
  it("confirms the single matching pending row when no link disambiguates", async () => {
    const { selectDirectPaymentCandidate } = await import("./payment-routes");
    const only = tx();
    expect(selectDirectPaymentCandidate([only], null)).toEqual({ transaction: only, ambiguous: false });
  });

  it("refuses to guess when several pending rows fit and no link is known", async () => {
    const { selectDirectPaymentCandidate } = await import("./payment-routes");
    const older = tx({ createdAt: new Date("2026-01-01T00:00:00Z") });
    const newer = tx({ id: "33333333-3333-4333-8333-333333333333", createdAt: new Date("2026-01-01T00:01:00Z") });
    // The old behaviour confirmed `newer` — a different customer's order.
    expect(selectDirectPaymentCandidate([newer, older], null)).toEqual({ transaction: null, ambiguous: true });
  });

  it("confirms the link's own row among several equally priced ones", async () => {
    const { selectDirectPaymentCandidate } = await import("./payment-routes");
    const own = tx({ notes: JSON.stringify({ type: "direct_wallet_qr", paymentUrl: LINK }) });
    const other = tx({
      id: "33333333-3333-4333-8333-333333333333",
      notes: JSON.stringify({ type: "direct_wallet_qr", paymentUrl: OTHER_LINK }),
    });
    expect(selectDirectPaymentCandidate([other, own], LINK)).toEqual({ transaction: own, ambiguous: false });
  });

  it("stays ambiguous when a link is known but matches none of the rows", async () => {
    const { selectDirectPaymentCandidate } = await import("./payment-routes");
    const a = tx({ notes: JSON.stringify({ type: "direct_wallet_qr", paymentUrl: OTHER_LINK }) });
    const b = tx({
      id: "33333333-3333-4333-8333-333333333333",
      notes: JSON.stringify({ type: "direct_wallet_qr", paymentUrl: OTHER_LINK }),
    });
    expect(selectDirectPaymentCandidate([a, b], LINK)).toEqual({ transaction: null, ambiguous: true });
  });

  it("answers no candidate without inventing ambiguity for an empty set", async () => {
    const { selectDirectPaymentCandidate } = await import("./payment-routes");
    expect(selectDirectPaymentCandidate([], null)).toEqual({ transaction: null, ambiguous: false });
  });
});

describe("publicTransactionJson", () => {
  it("returns null for no row", async () => {
    const { publicTransactionJson } = await import("./payment-routes");
    expect(publicTransactionJson(null)).toBeNull();
  });

  it("keeps payer-relevant fields and drops merchant data and notes", async () => {
    const { publicTransactionJson } = await import("./payment-routes");
    const row = tx({
      txHash: "0x" + "ab".repeat(32),
      notes: JSON.stringify({ type: "direct_wallet_qr", paymentUrl: LINK, orderId: "order-1", expectedAmount: "9" }),
      webhookSentAt: new Date(),
    } as Partial<Transaction>);
    const json = publicTransactionJson(row) as Record<string, unknown>;
    expect(json.status).toBe("pending");
    expect(json.coin).toBe("USDC");
    expect(json.paymentSource).toBe("direct_wallet_qr");
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain("22222222");
    expect(serialized).not.toContain("order-1");
    expect(serialized).not.toContain("expectedAmount");
    expect(serialized).not.toContain(LINK);
  });
});

describe("isDuplicateDirectFailureRow", () => {
  it("recognises a failed row that records the same transfer in its notes", async () => {
    const { isDuplicateDirectFailureRow } = await import("./payment-routes");
    const hash = "0x" + "cd".repeat(32);
    const row = tx({
      status: "failed",
      notes: JSON.stringify({ type: "direct_wallet_qr", txHash: hash, errorCode: "amount_mismatch" }),
    });
    expect(isDuplicateDirectFailureRow(row, hash)).toBe(true);
    expect(isDuplicateDirectFailureRow(row, hash.toUpperCase())).toBe(true);
  });

  it("ignores rows of other statuses or carrying other transfers", async () => {
    const { isDuplicateDirectFailureRow } = await import("./payment-routes");
    const hash = "0x" + "cd".repeat(32);
    const otherHash = "0x" + "ef".repeat(32);
    expect(isDuplicateDirectFailureRow(tx({ status: "failed", notes: JSON.stringify({ txHash: otherHash }) }), hash)).toBe(false);
    expect(isDuplicateDirectFailureRow(tx({ status: "confirmed", notes: JSON.stringify({ txHash: hash }) }), hash)).toBe(false);
    expect(isDuplicateDirectFailureRow(tx({ status: "failed", notes: null }), hash)).toBe(false);
  });
});
