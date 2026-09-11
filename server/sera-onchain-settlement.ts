/**
 * Pure validation for the ERC-20 evidence that corroborates a SeraSOR
 * IntentMatched event.
 *
 * SeraSOR may satisfy one Intent through several terminal route legs. It
 * enforces their aggregate output against the Intent's signed minOutputAmount
 * before emitting IntentMatched. Conversely, SeraBatcher may execute several
 * Intents in one transaction, so summing every matching ERC-20 Transfer in the
 * transaction could accidentally include another Intent's payout.
 *
 * The signed Intent/event pair is therefore the amount and recipient proof.
 * This helper only requires at least one correctly-addressed, positive Vault
 * transfer in the same transaction as on-chain corroboration; its values are
 * deliberately never reported as the payment's actual aggregate output.
 */

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const HASH_RE = /^0x[0-9a-f]{64}$/;

export type SeraErc20TransferLog = {
  address?: unknown;
  transactionHash?: unknown;
  args?: {
    from?: unknown;
    to?: unknown;
    value?: unknown;
  } | null;
};

export type SeraPayoutCorroboration = {
  transactionHash: `0x${string}`;
  observedTransferCount: number;
};

function normalizedHex(value: unknown, pattern: RegExp): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return pattern.test(normalized) ? normalized : null;
}
function positiveRawAmount(value: unknown): boolean {
  try {
    return (typeof value === "string" || typeof value === "number" || typeof value === "bigint")
      && BigInt(value) > 0n;
  } catch {
    return false;
  }
}

export function corroborateSeraIntentPayout({
  settlementTxHash,
  outputTokenAddress,
  vaultAddress,
  recipientAddress,
  signedMinimumOutputRaw,
  requiredOutputRaw,
  transferLogs,
}: {
  settlementTxHash: string;
  outputTokenAddress: string;
  vaultAddress: string;
  recipientAddress: string;
  signedMinimumOutputRaw: string;
  requiredOutputRaw: string;
  transferLogs: readonly SeraErc20TransferLog[];
}): SeraPayoutCorroboration | null {
  const transactionHash = normalizedHex(settlementTxHash, HASH_RE);
  const outputToken = normalizedHex(outputTokenAddress, ADDRESS_RE);
  const vault = normalizedHex(vaultAddress, ADDRESS_RE);
  const recipient = normalizedHex(recipientAddress, ADDRESS_RE);
  if (!transactionHash || !outputToken || !vault || !recipient) return null;

  try {
    const signedMinimum = BigInt(signedMinimumOutputRaw);
    const requiredOutput = BigInt(requiredOutputRaw);
    if (requiredOutput <= 0n || signedMinimum < requiredOutput) return null;
  } catch {
    return null;
  }

  const observedTransferCount = transferLogs.filter((log) => (
    normalizedHex(log.address, ADDRESS_RE) === outputToken
    && normalizedHex(log.transactionHash, HASH_RE) === transactionHash
    && normalizedHex(log.args?.from, ADDRESS_RE) === vault
    && normalizedHex(log.args?.to, ADDRESS_RE) === recipient
    && positiveRawAmount(log.args?.value)
  )).length;
  if (observedTransferCount === 0) return null;

  return {
    transactionHash: transactionHash as `0x${string}`,
    observedTransferCount,
  };
}
