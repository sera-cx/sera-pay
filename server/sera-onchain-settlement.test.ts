import { describe, expect, it } from "vitest";
import { corroborateSeraIntentPayout, type SeraErc20TransferLog } from "./sera-onchain-settlement";

const TX_HASH = `0x${"11".repeat(32)}`;
const OTHER_TX_HASH = `0x${"22".repeat(32)}`;
const TOKEN = `0x${"aa".repeat(20)}`;
const VAULT = `0x${"bb".repeat(20)}`;
const RECIPIENT = `0x${"cc".repeat(20)}`;

function transfer(value: string, overrides: Partial<SeraErc20TransferLog> = {}): SeraErc20TransferLog {
  return {
    address: TOKEN,
    transactionHash: TX_HASH,
    args: { from: VAULT, to: RECIPIENT, value },
    ...overrides,
  };
}

describe("Sera on-chain payout corroboration", () => {
  it("accepts split terminal payouts without requiring one transfer to equal the target", () => {
    const result = corroborateSeraIntentPayout({
      settlementTxHash: TX_HASH,
      outputTokenAddress: TOKEN,
      vaultAddress: VAULT,
      recipientAddress: RECIPIENT,
      signedMinimumOutputRaw: "1000000",
      requiredOutputRaw: "1000000",
      transferLogs: [transfer("400000"), transfer("600000")],
    });

    expect(result).toEqual({ transactionHash: TX_HASH, observedTransferCount: 2 });
  });

  it("does not use transfers to raise an under-protected signed Intent to the target", () => {
    const result = corroborateSeraIntentPayout({
      settlementTxHash: TX_HASH,
      outputTokenAddress: TOKEN,
      vaultAddress: VAULT,
      recipientAddress: RECIPIENT,
      signedMinimumOutputRaw: "400000",
      requiredOutputRaw: "1000000",
      // This could belong to another Intent in the same SeraBatcher tx. The
      // values are intentionally not summed to repair our signed envelope.
      transferLogs: [transfer("400000"), transfer("600000")],
    });

    expect(result).toBeNull();
  });

  it("excludes wrong-transaction and incorrectly addressed transfers", () => {
    const result = corroborateSeraIntentPayout({
      settlementTxHash: TX_HASH,
      outputTokenAddress: TOKEN,
      vaultAddress: VAULT,
      recipientAddress: RECIPIENT,
      signedMinimumOutputRaw: "1000000",
      requiredOutputRaw: "1000000",
      transferLogs: [
        transfer("1000000", { transactionHash: OTHER_TX_HASH }),
        transfer("1000000", { address: `0x${"dd".repeat(20)}` }),
        transfer("1000000", { args: { from: VAULT, to: `0x${"ee".repeat(20)}`, value: "1000000" } }),
        transfer("0"),
      ],
    });

    expect(result).toBeNull();
  });
});
