import { describe, expect, it } from "vitest";
import { ApiError } from "../client/src/lib/api";
import { isQuoteStaleError, PaymentApiError, paymentFailureMessage, readPaymentApiJson, seraRateErrorMessage } from "../client/src/lib/payment";
import { getSeraPublicErrorMessage, SERA_NO_LIQUIDITY_MESSAGE, SERA_SERVICE_UNAVAILABLE_MESSAGE } from "../shared/sera-errors";

describe("public conversion errors", () => {
  it.each([
    { errorCode: "NO_LIQUIDITY", expected: SERA_NO_LIQUIDITY_MESSAGE },
    { errorCode: "PAIR_INACTIVE", expected: SERA_NO_LIQUIDITY_MESSAGE },
    { errorCode: "amount_below_min", expected: getSeraPublicErrorMessage("amount_below_min") },
    { errorCode: "sera_fx_unavailable", expected: SERA_SERVICE_UNAVAILABLE_MESSAGE },
    { errorCode: "invalid_quote", expected: SERA_SERVICE_UNAVAILABLE_MESSAGE },
    { errorCode: "unknown_schema_error", expected: SERA_SERVICE_UNAVAILABLE_MESSAGE },
  ])("uses fixed copy for $errorCode", ({ errorCode, expected }) => {
    const error = { errorCode, message: "quote.permit.owner invalid; signature=private", detail: { html: "<svg>" } };
    expect(seraRateErrorMessage(error)).toBe(expected);
    expect(paymentFailureMessage(error)).toBe(expected);
  });

  it.each([
    new Error("Failed to execute 'text' on 'Response': body stream already read"),
    new Error("<svg>Internal gateway failure</svg>"),
    new Error("quote.permit.owner must be a valid address"),
    new Error("signature verification rejected by provider"),
    new Error("Sera API 400: no_liquidity"),
    { status: 409, detail: { schema: "route_params.uuid" } },
  ])("hides unknown provider text %#", (error) => {
    expect(seraRateErrorMessage(error)).toBe(SERA_SERVICE_UNAVAILABLE_MESSAGE);
    expect(paymentFailureMessage(error)).toBe(SERA_SERVICE_UNAVAILABLE_MESSAGE);
    expect(isQuoteStaleError(error)).toBe(false);
  });

  it.each([
    [4001, "User rejected request", "Transaction cancelled."],
    [4902, "private wallet details", "Please add or switch to the payment network in your wallet, then try again."],
    [undefined, "execution reverted: private chain payload", "Transaction simulation failed. Please check your token balance and network gas, then try again."],
    [undefined, "Invalid payment amount", "Enter a valid payment amount."],
    [undefined, "No wallet connected", "Connect your wallet to continue."],
  ])("retains safe wallet and local guidance %#", (code, message, expected) => {
    expect(paymentFailureMessage({ code, message })).toBe(expected);
  });

  it("retains safe dashboard authentication guidance", () => {
    const message = "Dashboard session expired. Please sign in again.";
    expect(paymentFailureMessage(new ApiError(401, message))).toBe(message);
  });
});

describe("payment response handling and retry boundaries", () => {
  it.each(["NO_LIQUIDITY", "payment_attempt_in_progress", "payment_already_submitted", "invalid_quote", "unknown_failure", undefined])("does not retry HTTP409 with code %s", async (errorCode) => {
    const response = Response.json({ errorCode, error: "quote stale and expired: private schema", detail: { signature: "private" } }, { status: 409 });
    const error = await readPaymentApiJson(response).catch((cause) => cause);

    expect(error).toBeInstanceOf(PaymentApiError);
    expect(isQuoteStaleError(error)).toBe(false);
    expect(error).not.toHaveProperty("detail");
    expect(error.message).toBe(getSeraPublicErrorMessage(errorCode));
  });

  it("retries only an explicit stale quote code", async () => {
    const error = await readPaymentApiJson(Response.json({ errorCode: "QUOTE_STALE", detail: "private" }, { status: 400 })).catch((cause) => cause);
    expect(error).toMatchObject({ errorCode: "quote_stale" });
    expect(isQuoteStaleError(error)).toBe(true);
    expect(isQuoteStaleError({ status: 410 })).toBe(false);
  });

  it("preserves only the transaction identifier needed to recover an in-progress payment", async () => {
    const txId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const error = await readPaymentApiJson(Response.json({ errorCode: "payment_attempt_in_progress", detail: { txId, signature: "private", payload: "<svg>" } }, { status: 409 })).catch((cause) => cause);
    expect(error).toMatchObject({ errorCode: "payment_attempt_in_progress", existingTransactionId: txId });
    expect(error).not.toHaveProperty("detail");
    expect(JSON.stringify(error)).not.toMatch(/private|<svg>/);
    expect(isQuoteStaleError(error)).toBe(false);
  });

  it.each(["<svg>gateway failure</svg>", '{"error":', "", "null"])("hides malformed bodies and never misclassifies a retry %#", async (body) => {
    const response = new Response(body, { status: 409 });
    const error = await readPaymentApiJson(response).catch((cause) => cause);
    expect(error).toMatchObject({ message: SERA_SERVICE_UNAVAILABLE_MESSAGE, errorCode: "sera_unavailable" });
    expect(isQuoteStaleError(error)).toBe(false);
    expect(response.bodyUsed).toBe(true);
  });

  it("hides a consumed response stream without suggesting a fresh submission", async () => {
    const response = Response.json({ error: "private" }, { status: 409 });
    await response.text();
    const error = await readPaymentApiJson(response).catch((cause) => cause);
    expect(error).toMatchObject({ message: SERA_SERVICE_UNAVAILABLE_MESSAGE });
    expect(isQuoteStaleError(error)).toBe(false);
  });

  it("continues to return successful response data unchanged", async () => {
    await expect(readPaymentApiJson(Response.json({ txId: "existing", quoteUuid: "quote" })))
      .resolves.toEqual({ txId: "existing", quoteUuid: "quote" });
  });
});
