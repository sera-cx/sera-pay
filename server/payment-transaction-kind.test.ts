import { describe, expect, it } from "vitest";
import {
  SERA_SWAP_MARKER_FIELDS,
  isDirectTransferCandidate,
  isSeraVaultPayoutSender,
  isSeraSwapTransactionRecord,
} from "./payment-transaction-kind";

describe("Sera swap/direct transaction classification", () => {
  it.each(["sera_swap_quote", "sera_swap", " SERA_SWAP "])(
    "keeps notes.type=%s out of generic direct-transfer matching",
    (type) => {
      const transaction = { notes: JSON.stringify({ type }) };
      expect(isSeraSwapTransactionRecord(transaction)).toBe(true);
      expect(isDirectTransferCandidate(transaction)).toBe(false);
    },
  );

  it.each(SERA_SWAP_MARKER_FIELDS)(
    "keeps a row with durable %s state out of generic direct-transfer matching",
    (field) => {
      const transaction = { [field]: field.endsWith("At") ? new Date() : "present" };
      expect(isSeraSwapTransactionRecord(transaction)).toBe(true);
      expect(isDirectTransferCandidate(transaction)).toBe(false);
    },
  );

  it("does not throw on malformed notes and fails closed when a swap marker remains", () => {
    expect(isDirectTransferCandidate({ notes: '{"type":"sera_swap"' })).toBe(false);
    expect(isDirectTransferCandidate({ notes: "truncated sera_swap_quote metadata" })).toBe(false);
  });

  it("allows ordinary direct rows, legacy free-text notes, and empty durable fields", () => {
    expect(isDirectTransferCandidate({ notes: JSON.stringify({ type: "direct_wallet_qr" }) })).toBe(true);
    expect(isDirectTransferCandidate({ notes: "merchant memo", quoteUuid: "", tradeId: null })).toBe(true);
    expect(isDirectTransferCandidate({ notes: JSON.stringify(["sera_swap"]) })).toBe(true);
    expect(isDirectTransferCandidate({ notes: JSON.stringify("sera_swap") })).toBe(true);
  });

  it("accepts already-parsed notes from callers that avoid serializing twice", () => {
    expect(isDirectTransferCandidate({ notes: { type: "sera_swap_quote" } })).toBe(false);
    expect(isDirectTransferCandidate({ notes: { type: "direct_wallet_qr" } })).toBe(true);
  });
});

describe("Sera Vault payout boundary", () => {
  const vault = "0x1234567890abcdef1234567890abcdef12345678";

  it("matches the Vault sender case-insensitively", () => {
    expect(isSeraVaultPayoutSender(vault.toUpperCase().replace("0X", "0x"), vault)).toBe(true);
  });

  it("does not exclude an ordinary sender", () => {
    expect(isSeraVaultPayoutSender("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", vault)).toBe(false);
  });

  it.each([null, undefined, "", "0x1234"])("fails closed at the caller for invalid sender %s", (sender) => {
    expect(isSeraVaultPayoutSender(sender, vault)).toBe(false);
  });
});
