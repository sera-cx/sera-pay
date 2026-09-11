import { describe, expect, it } from "vitest";
import {
  SERA_SUBMISSION_MAX_ANCHOR_LAG_SECONDS,
  validateSeraSubmissionAnchor,
} from "./sera-submission-anchor";

describe("Sera submission recovery anchor", () => {
  it("accepts a finalized anchor comfortably inside the bounded scan window", () => {
    expect(validateSeraSubmissionAnchor({
      blockNumber: 21_000_000n,
      blockTimestamp: 2_000_000_000n,
      intentDeadline: 2_000_000_300n,
    })).toEqual({
      valid: true,
      blockNumber: "21000000",
      blockTimestamp: "2000000000",
    });
  });

  it("rejects a responsive but stale finalized RPC head", () => {
    expect(validateSeraSubmissionAnchor({
      blockNumber: "21000000",
      blockTimestamp: "2000000000",
      intentDeadline: 2_000_000_000n + SERA_SUBMISSION_MAX_ANCHOR_LAG_SECONDS + 1n,
    })).toEqual({ valid: false, reason: "stale_anchor" });
  });

  it("rejects an Intent already expired at the finalized head", () => {
    expect(validateSeraSubmissionAnchor({
      blockNumber: 1n,
      blockTimestamp: 1000n,
      intentDeadline: 1000n,
    })).toEqual({ valid: false, reason: "intent_expired" });
  });

  it("rejects missing, malformed, or negative anchor data", () => {
    expect(validateSeraSubmissionAnchor({
      blockNumber: null,
      blockTimestamp: 1000n,
      intentDeadline: 1100n,
    })).toEqual({ valid: false, reason: "invalid_anchor" });
    expect(validateSeraSubmissionAnchor({
      blockNumber: 1n,
      blockTimestamp: "not-a-time",
      intentDeadline: 1100n,
    })).toEqual({ valid: false, reason: "invalid_anchor" });
    expect(validateSeraSubmissionAnchor({
      blockNumber: -1n,
      blockTimestamp: 1000n,
      intentDeadline: 1100n,
    })).toEqual({ valid: false, reason: "invalid_anchor" });
  });
});
