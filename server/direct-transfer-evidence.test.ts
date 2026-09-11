import { describe, expect, it } from "vitest";
import {
  selectDirectTransferEvidence,
  type DecodedErc20TransferEvidence,
} from "./direct-transfer-evidence";

const TOKEN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const RECIPIENT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const DIRECT_SENDER = "0xcccccccccccccccccccccccccccccccccccccccc";
const OTHER_ADDRESS = "0xdddddddddddddddddddddddddddddddddddddddd";
const VAULT = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

function transfer(overrides: Partial<DecodedErc20TransferEvidence> = {}): DecodedErc20TransferEvidence {
  return {
    tokenAddress: TOKEN,
    fromAddress: DIRECT_SENDER,
    toAddress: RECIPIENT,
    amountRaw: 1_000n,
    ...overrides,
  };
}

function select(
  transfers: readonly DecodedErc20TransferEvidence[],
  vaults: ReadonlySet<string> = new Set([VAULT]),
) {
  return selectDirectTransferEvidence({
    transfers,
    expectedTokenAddress: TOKEN,
    expectedRecipientAddress: RECIPIENT,
    expectedAmountRaw: 1_000n,
    seraVaultAddresses: vaults,
  });
}

describe("direct ERC-20 receipt evidence selection", () => {
  it.each([999n, 1_000n, 1_001n])("accepts a direct transfer at the ±1 raw-unit boundary (%s)", (amountRaw) => {
    expect(select([transfer({
      tokenAddress: TOKEN.toUpperCase().replace("0X", "0x"),
      fromAddress: DIRECT_SENDER.toUpperCase().replace("0X", "0x"),
      toAddress: RECIPIENT.toUpperCase().replace("0X", "0x"),
      amountRaw,
    })])).toEqual({ kind: "direct", sender: DIRECT_SENDER, amountRaw });
  });

  it("gives a matching Sera Vault transfer precedence over an earlier direct candidate", () => {
    expect(select([
      transfer(),
      transfer({ fromAddress: VAULT, amountRaw: 10_000n }),
      transfer({ fromAddress: OTHER_ADDRESS }),
    ])).toEqual({ kind: "sera_vault", sender: VAULT, amountRaw: 10_000n });
  });

  it("reserves even a zero-value matching Vault transfer for swap reconciliation", () => {
    expect(select([
      transfer(),
      transfer({ fromAddress: VAULT, amountRaw: 0n }),
    ])).toEqual({ kind: "sera_vault", sender: VAULT, amountRaw: 0n });
  });

  it("normalizes the supplied live and historical Vault addresses", () => {
    const mixedCaseVault = VAULT.toUpperCase().replace("0X", "0x");
    expect(select([transfer({ fromAddress: mixedCaseVault })], new Set([mixedCaseVault])))
      .toEqual({ kind: "sera_vault", sender: VAULT, amountRaw: 1_000n });
  });

  it("ignores wrong-token and wrong-recipient Vault logs and selects valid direct evidence", () => {
    expect(select([
      transfer({ fromAddress: VAULT, toAddress: OTHER_ADDRESS }),
      transfer({ fromAddress: VAULT, tokenAddress: OTHER_ADDRESS }),
      transfer(),
    ])).toMatchObject({ kind: "direct", sender: DIRECT_SENDER });
  });

  it("ignores malformed, zero, wrong-token, wrong-recipient, and wrong-amount evidence", () => {
    expect(select([
      transfer({ tokenAddress: "not-an-address" }),
      transfer({ fromAddress: "0x1234" }),
      transfer({ fromAddress: `0x${"0".repeat(40)}` }),
      transfer({ toAddress: OTHER_ADDRESS }),
      transfer({ tokenAddress: OTHER_ADDRESS }),
      transfer({ amountRaw: 0n }),
      transfer({ amountRaw: -1n }),
      transfer({ amountRaw: 1_002n }),
      transfer({ amountRaw: "1.0" }),
      transfer({ amountRaw: {} }),
    ])).toBeNull();
  });

  it("fails closed when expected evidence inputs are invalid", () => {
    expect(selectDirectTransferEvidence({
      transfers: [transfer()],
      expectedTokenAddress: "bad-token",
      expectedRecipientAddress: RECIPIENT,
      expectedAmountRaw: 1_000n,
      seraVaultAddresses: new Set([VAULT]),
    })).toBeNull();
    expect(selectDirectTransferEvidence({
      transfers: [transfer()],
      expectedTokenAddress: TOKEN,
      expectedRecipientAddress: RECIPIENT,
      expectedAmountRaw: 0n,
      seraVaultAddresses: new Set([VAULT]),
    })).toBeNull();
  });
});
