import { describe, expect, it } from "vitest";
import {
  DEFAULT_SERA_PROVISIONAL_CONFIRMATIONS,
  classifySeraSettlementObservationStage,
  isCanonicalSuccessfulSeraSettlement,
  parseSeraProvisionalConfirmations,
  seraProvisionalSettlementScanHead,
} from "./sera-confirmation-policy";

const TX_HASH = `0x${"11".repeat(32)}`;
const BLOCK_HASH = `0x${"22".repeat(32)}`;

function canonicalEvidence(overrides: Record<string, unknown> = {}) {
  return {
    expectedTransactionHash: TX_HASH,
    expectedBlockNumber: 100n,
    matchedLogBlockHash: BLOCK_HASH,
    receipt: {
      status: "success",
      transactionHash: TX_HASH,
      blockNumber: 100n,
      blockHash: BLOCK_HASH,
    },
    canonicalBlock: {
      number: 100n,
      hash: BLOCK_HASH,
    },
    ...overrides,
  };
}

describe("Sera settlement confirmation policy", () => {
  it("defaults to two confirmations and accepts the faster one-block override", () => {
    expect(parseSeraProvisionalConfirmations(undefined)).toBe(DEFAULT_SERA_PROVISIONAL_CONFIRMATIONS);
    expect(parseSeraProvisionalConfirmations("")).toBe(2);
    expect(parseSeraProvisionalConfirmations(" 1 ")).toBe(1);
  });

  it.each(["0", "3", "2.5", "fast", "-1"])("rejects unsafe confirmation setting %s", (value) => {
    expect(() => parseSeraProvisionalConfirmations(value)).toThrow(/SERA_PROVISIONAL_CONFIRMATIONS/);
  });

  it("computes the highest eligible positive-settlement block", () => {
    expect(seraProvisionalSettlementScanHead(100n, 1)).toBe(100n);
    expect(seraProvisionalSettlementScanHead(100n, 2)).toBe(99n);
  });

  it("keeps confirmation-depth evidence provisional until the finalized head reaches it", () => {
    expect(classifySeraSettlementObservationStage({
      settlementBlockNumber: 100n,
      provisionalScanHead: 100n,
      finalizedBlockNumber: 90n,
    })).toBe("provisional");
    expect(classifySeraSettlementObservationStage({
      settlementBlockNumber: 100n,
      provisionalScanHead: 110n,
      finalizedBlockNumber: 100n,
    })).toBe("finalized");
    expect(classifySeraSettlementObservationStage({
      settlementBlockNumber: 100n,
      provisionalScanHead: 99n,
      finalizedBlockNumber: 90n,
    })).toBe("immature");
  });

  it("accepts only a successful receipt in the canonical block", () => {
    expect(isCanonicalSuccessfulSeraSettlement(canonicalEvidence())).toBe(true);
    expect(isCanonicalSuccessfulSeraSettlement(canonicalEvidence({
      receipt: {
        status: "reverted",
        transactionHash: TX_HASH,
        blockNumber: 100n,
        blockHash: BLOCK_HASH,
      },
    }))).toBe(false);
    expect(isCanonicalSuccessfulSeraSettlement(canonicalEvidence({
      canonicalBlock: { number: 100n, hash: `0x${"33".repeat(32)}` },
    }))).toBe(false);
  });

  it("rejects a replaced or removed log envelope", () => {
    expect(isCanonicalSuccessfulSeraSettlement(canonicalEvidence({
      matchedLogBlockHash: `0x${"44".repeat(32)}`,
    }))).toBe(false);
    expect(isCanonicalSuccessfulSeraSettlement(canonicalEvidence({
      matchedLogRemoved: true,
    }))).toBe(false);
  });
});
