import { describe, expect, it } from "vitest";
import {
  SERA_NO_LIQUIDITY_MESSAGE,
  SERA_SERVICE_UNAVAILABLE_MESSAGE,
  getSeraPublicErrorCode,
  getSeraPublicErrorMessage,
} from "../shared/sera-errors";

describe("public Sera error policy", () => {
  it.each([
    ["NO_LIQUIDITY", "no_liquidity"],
    ["PAIR_INACTIVE", "no_liquidity"],
    ["RATE_LIMITED", "sera_rate_limited"],
    ["TOO_MANY_REQUESTS", "sera_rate_limited"],
    ["SERA_CONNECTION_ERROR", "sera_unavailable"],
    ["upstream_unavailable", "sera_unavailable"],
    ["quote_timeout", "sera_unavailable"],
    ["internal_error", "sera_unavailable"],
    ["ALLOWANCE_INSUFFICIENT", "allowance_insufficient"],
    ["INSUFFICIENT_EQUITY", "insufficient_equity"],
    ["INTENT_DEADLINE_EXPIRED", "intent_deadline_expired"],
    ["SLIPPAGE_EXCEEDED", "slippage_exceeded"],
    ["STP_BLOCKED", "stp_blocked"],
    ["AMOUNT_BELOW_MIN", "amount_below_min"],
    ["QUOTE_STALE", "quote_stale"],
    ["TRANSIENT_SETTLEMENT_FAILURE", "transient_settlement_failure"],
    ["INVALID_CONFIG", "invalid_config"],
    ["INVALID_QUOTE", "invalid_quote"],
    ["INVALID_SIGNATURE", "invalid_signature"],
    ["OUTPUT_BELOW_TARGET", "output_below_target"],
    ["FEE_TOO_HIGH", "fee_too_high"],
    ["PRICE_DEVIATION", "price_deviation"],
    ["payment_attempt_in_progress", "payment_attempt_in_progress"],
    ["previous_payment_pending", "previous_payment_pending"],
    ["payment_already_submitted", "payment_already_submitted"],
  ])("normalizes %s without collapsing its meaning", (input, expected) => {
    expect(getSeraPublicErrorCode(input)).toBe(expected);
    expect(getSeraPublicErrorMessage(input)).toBe(getSeraPublicErrorMessage(expected));
  });

  it.each([
    "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT", "ENOTFOUND",
    "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_ABORTED",
  ])("recognizes nested network failure %s", (code) => {
    const error = Object.assign(new TypeError("raw private upstream error"), { cause: { code } });
    expect(getSeraPublicErrorCode(error)).toBe("sera_unavailable");
    expect(getSeraPublicErrorMessage(error)).toBe(SERA_SERVICE_UNAVAILABLE_MESSAGE);
  });

  it("recognizes structured provider codes and browser timeout names", () => {
    expect(getSeraPublicErrorCode({ error: "raw server failure", detail: { error_code: "NO_LIQUIDITY" } })).toBe("no_liquidity");
    expect(getSeraPublicErrorCode({ rejectionCategory: "quote_timeout" })).toBe("sera_unavailable");
    expect(getSeraPublicErrorCode({ name: "AbortError" })).toBe("sera_unavailable");
    expect(getSeraPublicErrorCode({ name: "TimeoutError" })).toBe("sera_unavailable");
  });

  it.each([
    undefined, null, 409, { status: 409 }, { status: 410 }, { status: 503 },
    "NEW_INTERNAL_ERROR", "__proto__", "constructor", "<html><svg>private failure</svg></html>",
    new Error("Sera API 400: no_liquidity with private payload"),
    { message: "QUOTE_STALE", detail: { privateKey: "do not display" } },
  ])("uses safe general copy for unknown or freeform input %#", (input) => {
    expect(getSeraPublicErrorCode(input)).toBeNull();
    expect(getSeraPublicErrorMessage(input)).toBe(SERA_SERVICE_UNAVAILABLE_MESSAGE);
  });

  it("keeps liquidity copy stable and bounds recursive error inspection", () => {
    expect(getSeraPublicErrorMessage("no_liquidity")).toBe(SERA_NO_LIQUIDITY_MESSAGE);
    const circular: { cause?: unknown } = {};
    circular.cause = circular;
    expect(getSeraPublicErrorCode(circular)).toBeNull();
  });
});
