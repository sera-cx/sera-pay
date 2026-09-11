/**
 * Minimal transaction shape needed to decide whether a pending row belongs to
 * the Sera swap lifecycle. Keeping this structural avoids coupling the direct
 * transfer scanner to a particular Drizzle schema version.
 */
export type PaymentTransactionKindRecord = {
  notes?: unknown;
  quoteUuid?: unknown;
  routeUuid?: unknown;
  intentHash?: unknown;
  tradeId?: unknown;
  payTokenAddress?: unknown;
  receiveTokenAddress?: unknown;
  requestedPayAmountRaw?: unknown;
  maximumPayAmountRaw?: unknown;
  targetReceiveAmountRaw?: unknown;
  minimumReceiveAmountRaw?: unknown;
  initialDepositAmountRaw?: unknown;
  quoteExpiresAt?: unknown;
  intentDeadline?: unknown;
  permitRequired?: unknown;
  permitDeadline?: unknown;
  submitState?: unknown;
  submittedBlockNumber?: unknown;
  seraStatus?: unknown;
  actualPayAmountRaw?: unknown;
  actualReceiveAmountRaw?: unknown;
  feeAmountRaw?: unknown;
  feeTokenAddress?: unknown;
  settlementTxHash?: unknown;
  failureCode?: unknown;
};

const SERA_SWAP_NOTE_TYPES = new Set(["sera_swap_quote", "sera_swap"]);

/**
 * Durable columns that are populated only by the Sera swap processor.
 *
 * Any one is enough to fail closed: a generic ERC-20 transfer scanner must not
 * confirm a row once the swap lifecycle owns it, even if legacy JSON notes are
 * missing or damaged.
 */
export const SERA_SWAP_MARKER_FIELDS = [
  "quoteUuid",
  "routeUuid",
  "intentHash",
  "tradeId",
  "payTokenAddress",
  "receiveTokenAddress",
  "requestedPayAmountRaw",
  "maximumPayAmountRaw",
  "targetReceiveAmountRaw",
  "minimumReceiveAmountRaw",
  "initialDepositAmountRaw",
  "quoteExpiresAt",
  "intentDeadline",
  "permitRequired",
  "permitDeadline",
  "submitState",
  "submittedBlockNumber",
  "seraStatus",
  "actualPayAmountRaw",
  "actualReceiveAmountRaw",
  "feeAmountRaw",
  "feeTokenAddress",
  "settlementTxHash",
  "failureCode",
] as const satisfies readonly (keyof PaymentTransactionKindRecord)[];

function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  return typeof value !== "string" || value.trim().length > 0;
}

function noteTypeIsSeraSwap(notes: unknown): boolean {
  if (notes && typeof notes === "object" && !Array.isArray(notes)) {
    const type = (notes as Record<string, unknown>).type;
    return typeof type === "string" && SERA_SWAP_NOTE_TYPES.has(type.trim().toLowerCase());
  }
  if (typeof notes !== "string" || notes.trim().length === 0) return false;

  try {
    const parsed = JSON.parse(notes) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const type = (parsed as Record<string, unknown>).type;
    return typeof type === "string" && SERA_SWAP_NOTE_TYPES.has(type.trim().toLowerCase());
  } catch {
    // Legacy notes can be truncated during an interrupted write. Recognising
    // the explicit swap marker in malformed text is safer than allowing the
    // generic transfer scanner to mark that payment confirmed.
    return /sera_swap(?:_quote)?/i.test(notes);
  }
}

/** True when a transaction is, or has entered, Sera's swap lifecycle. */
export function isSeraSwapTransactionRecord(transaction: PaymentTransactionKindRecord): boolean {
  if (noteTypeIsSeraSwap(transaction.notes)) return true;
  return SERA_SWAP_MARKER_FIELDS.some((field) => hasValue(transaction[field]));
}

/**
 * Predicate for generic direct-transfer matching.
 *
 * Callers still apply their ordinary pending/hash/address/token/amount checks;
 * this guard only ensures the direct scanner never owns a Sera swap row.
 */
export function isDirectTransferCandidate(transaction: PaymentTransactionKindRecord): boolean {
  return !isSeraSwapTransactionRecord(transaction);
}

/** True only for a well-formed ERC-20 sender equal to the live Sera Vault. */
export function isSeraVaultPayoutSender(
  fromAddress: string | null | undefined,
  vaultAddress: string | null | undefined,
): boolean {
  const addressPattern = /^0x[0-9a-fA-F]{40}$/;
  return typeof fromAddress === "string"
    && typeof vaultAddress === "string"
    && addressPattern.test(fromAddress)
    && addressPattern.test(vaultAddress)
    && fromAddress.toLowerCase() === vaultAddress.toLowerCase();
}
