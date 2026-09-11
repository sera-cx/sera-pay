/**
 * A submitted Sera Intent is recovered by rescanning at most 490 finalized
 * Ethereum blocks from the pre-submit anchor. Ethereum execution blocks use
 * 12-second slots, so limiting the anchor-to-deadline gap to one hour leaves
 * ample headroom inside that fixed recovery window.
 */
export const SERA_SUBMISSION_MAX_ANCHOR_LAG_SECONDS = 60n * 60n;

export type SeraSubmissionAnchorValidation =
  | { valid: true; blockNumber: string; blockTimestamp: string }
  | { valid: false; reason: "invalid_anchor" | "intent_expired" | "stale_anchor" };

function unsignedInteger(value: unknown): bigint | null {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") return null;
  try {
    const parsed = BigInt(value);
    return parsed >= 0n ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Validate that a finalized pre-submit block is recent enough for the bounded,
 * gap-free reconciliation scan to cover every block in which the Intent can
 * still settle. The signed deadline comes from Sera's clock, avoiding reliance
 * on the payer's device clock.
 */
export function validateSeraSubmissionAnchor(input: {
  blockNumber: unknown;
  blockTimestamp: unknown;
  intentDeadline: unknown;
  maxAnchorLagSeconds?: bigint;
}): SeraSubmissionAnchorValidation {
  const blockNumber = unsignedInteger(input.blockNumber);
  const blockTimestamp = unsignedInteger(input.blockTimestamp);
  const intentDeadline = unsignedInteger(input.intentDeadline);
  const maximumLag = input.maxAnchorLagSeconds ?? SERA_SUBMISSION_MAX_ANCHOR_LAG_SECONDS;
  if (blockNumber === null || blockTimestamp === null || intentDeadline === null || maximumLag <= 0n) {
    return { valid: false, reason: "invalid_anchor" };
  }
  if (blockTimestamp >= intentDeadline) {
    return { valid: false, reason: "intent_expired" };
  }
  if (intentDeadline - blockTimestamp > maximumLag) {
    return { valid: false, reason: "stale_anchor" };
  }
  return {
    valid: true,
    blockNumber: blockNumber.toString(),
    blockTimestamp: blockTimestamp.toString(),
  };
}
