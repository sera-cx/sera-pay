/**
 * Positive Sera settlements can be acknowledged before Ethereum finality once
 * they have a small, explicit confirmation depth. Negative proof remains a
 * finalized-chain decision in payment-routes.ts: an absent event at `latest`
 * is never enough to fail a payment.
 */

export const DEFAULT_SERA_PROVISIONAL_CONFIRMATIONS = 2;
export const MAX_SERA_PROVISIONAL_CONFIRMATIONS = 2;

const HASH_RE = /^0x[0-9a-f]{64}$/;

function normalizedHash(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return HASH_RE.test(normalized) ? normalized : null;
}

function nonNegativeBlockNumber(value: unknown): bigint | null {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") return null;
  try {
    const blockNumber = BigInt(value);
    return blockNumber >= 0n ? blockNumber : null;
  } catch {
    return null;
  }
}

export function parseSeraProvisionalConfirmations(value: string | null | undefined): number {
  const normalized = value?.trim() ?? "";
  if (!normalized) return DEFAULT_SERA_PROVISIONAL_CONFIRMATIONS;
  if (!/^\d+$/.test(normalized)) {
    throw new Error("SERA_PROVISIONAL_CONFIRMATIONS must be an integer");
  }
  const confirmations = Number(normalized);
  if (
    !Number.isSafeInteger(confirmations)
    || confirmations < 1
    || confirmations > MAX_SERA_PROVISIONAL_CONFIRMATIONS
  ) {
    throw new Error(`SERA_PROVISIONAL_CONFIRMATIONS must be between 1 and ${MAX_SERA_PROVISIONAL_CONFIRMATIONS}`);
  }
  return confirmations;
}

/** Highest block with the configured number of confirmations at `latest`. */
export function seraProvisionalSettlementScanHead(
  latestBlockNumber: bigint,
  requiredConfirmations: number,
): bigint | null {
  if (
    latestBlockNumber < 0n
    || !Number.isSafeInteger(requiredConfirmations)
    || requiredConfirmations < 1
  ) return null;
  const blocksBehindHead = BigInt(requiredConfirmations - 1);
  return latestBlockNumber >= blocksBehindHead
    ? latestBlockNumber - blocksBehindHead
    : null;
}

export type SeraSettlementObservationStage = "finalized" | "provisional" | "immature";

/** Finalized always wins; confirmation depth alone is never terminal. */
export function classifySeraSettlementObservationStage({
  settlementBlockNumber,
  provisionalScanHead,
  finalizedBlockNumber,
}: {
  settlementBlockNumber: bigint;
  provisionalScanHead: bigint | null;
  finalizedBlockNumber: bigint | null;
}): SeraSettlementObservationStage {
  if (finalizedBlockNumber !== null && settlementBlockNumber <= finalizedBlockNumber) return "finalized";
  if (provisionalScanHead !== null && settlementBlockNumber <= provisionalScanHead) return "provisional";
  return "immature";
}

export type SeraSettlementReceiptEvidence = {
  status?: unknown;
  transactionHash?: unknown;
  blockNumber?: unknown;
  blockHash?: unknown;
};

export type SeraSettlementBlockEvidence = {
  number?: unknown;
  hash?: unknown;
};

/**
 * Re-check a candidate against a successful receipt and the canonical block
 * currently returned for its height. This closes the race where getLogs saw a
 * block that was replaced before the payment was committed.
 *
 * It cannot eliminate a deeper reorg after this check. The configured depth
 * is the merchant's explicit latency/risk trade-off.
 */
export function isCanonicalSuccessfulSeraSettlement({
  expectedTransactionHash,
  expectedBlockNumber,
  matchedLogBlockHash,
  matchedLogRemoved,
  receipt,
  canonicalBlock,
}: {
  expectedTransactionHash: string;
  expectedBlockNumber: bigint;
  matchedLogBlockHash?: unknown;
  matchedLogRemoved?: unknown;
  receipt: SeraSettlementReceiptEvidence;
  canonicalBlock: SeraSettlementBlockEvidence;
}): boolean {
  const expectedHash = normalizedHash(expectedTransactionHash);
  const receiptHash = normalizedHash(receipt.transactionHash);
  const receiptBlockHash = normalizedHash(receipt.blockHash);
  const canonicalBlockHash = normalizedHash(canonicalBlock.hash);
  const receiptBlockNumber = nonNegativeBlockNumber(receipt.blockNumber);
  const canonicalBlockNumber = nonNegativeBlockNumber(canonicalBlock.number);
  const logBlockHash = matchedLogBlockHash == null ? null : normalizedHash(matchedLogBlockHash);

  return Boolean(
    expectedHash
    && receipt.status === "success"
    && receiptHash === expectedHash
    && receiptBlockNumber === expectedBlockNumber
    && canonicalBlockNumber === expectedBlockNumber
    && receiptBlockHash
    && canonicalBlockHash === receiptBlockHash
    && (matchedLogBlockHash == null || logBlockHash === receiptBlockHash)
    && matchedLogRemoved !== true
  );
}
