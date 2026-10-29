import { afterEach, describe, expect, it, vi } from "vitest";
import { getSeraPublicErrorMessage, SERA_SERVICE_UNAVAILABLE_MESSAGE } from "../shared/sera-errors";

vi.mock("./db", () => ({ createSeraApiRequestLog: vi.fn().mockResolvedValue(undefined) }));

import { callSeraApi, SeraApiError } from "./sera-api";
import { SeraQuoteValidationError } from "./sera-swap-quote";
import { publicSeraFailure, publicSeraSubmissionResult, seraErrorDiagnostic, seraRouteErrorResponse } from "./sera-error-response";

afterEach(() => vi.unstubAllGlobals());

describe("public Sera route failures", () => {
  it.each(["NO_LIQUIDITY", "AMOUNT_BELOW_MIN", "ALLOWANCE_INSUFFICIENT", "INTENT_DEADLINE_EXPIRED", "SLIPPAGE_EXCEEDED", "STP_BLOCKED", "INSUFFICIENT_EQUITY", "TRANSIENT_SETTLEMENT_FAILURE"])(
    "uses safe copy for %s without changing conflict semantics", (code) => {
      const result = seraRouteErrorResponse(new SeraApiError(409, "private provider traceback", { secret: "signature" }, code));
      expect(result.status).toBe(409);
      expect(result.body.error).toBe(getSeraPublicErrorMessage(code));
      expect(result.body.errorCode).not.toBe("quote_stale");
      expect(JSON.stringify(result)).not.toMatch(/private|traceback|signature/);
    },
  );

  it.each([400, 409, 422, 500, 502, 503, 504])("hides unknown provider codes and bodies at HTTP %s", (status) => {
    const result = seraRouteErrorResponse(new SeraApiError(status, "<svg>internal panic</svg>", { host: "private", signature: "secret" }, "EXECUTOR_PRIVATE_PANIC"));
    expect(result.body).toEqual({ error: SERA_SERVICE_UNAVAILABLE_MESSAGE, errorCode: "sera_unavailable" });
    expect(result.status).toBe(status < 500 ? status : 503);
  });

  it("uses explicit stale and rate-limit responses while generic409 is never stale", () => {
    expect(seraRouteErrorResponse(new SeraApiError(409, "internal", null, "QUOTE_STALE")).body.errorCode).toBe("quote_stale");
    expect(seraRouteErrorResponse(new SeraApiError(410, "internal")).body.errorCode).toBe("quote_stale");
    expect(seraRouteErrorResponse(new SeraApiError(429, "internal")).body.errorCode).toBe("sera_rate_limited");
    expect(seraRouteErrorResponse(new SeraApiError(409, "quote expired")).body.errorCode).toBe("sera_unavailable");
  });

  it("keeps field and code diagnostics on the server only", () => {
    const error = new SeraQuoteValidationError("invalid_quote", "private message", { field: "quote.permit.owner", detail: { signature: "secret" } });
    expect(seraRouteErrorResponse(error).body).toEqual({ error: SERA_SERVICE_UNAVAILABLE_MESSAGE, errorCode: "invalid_quote" });
    expect(seraErrorDiagnostic(error)).toEqual({ type: "SeraQuoteValidationError", code: "invalid_quote", status: 502, field: "quote.permit.owner" });
    expect(seraErrorDiagnostic({ name: "<svg>secret</svg>", code: "private signature value", field: "private host/path", message: "secret" }))
      .toEqual({ type: "unknown_error", code: "unknown_error" });
  });

  it("generalizes unexpected programming and transport failures", () => {
    for (const error of [new Error("database private host"), new TypeError("body stream already read"), null]) {
      expect(seraRouteErrorResponse(error).body.error).toBe(SERA_SERVICE_UNAVAILABLE_MESSAGE);
    }
  });
});

describe("saved failures and submission responses", () => {
  it("keeps unknown historical failure codes private", () => {
    expect(publicSeraFailure("provider_rejected:PRIVATE_PANIC", "failed"))
      .toEqual({ errorCode: "settlement_failed", reason: getSeraPublicErrorMessage("settlement_failed") });
    expect(publicSeraFailure("NO_LIQUIDITY", "failed").reason).toBe(getSeraPublicErrorMessage("no_liquidity"));
  });

  it("preserves documented payment metadata and omits arbitrary provider diagnostics", () => {
    const result = publicSeraSubmissionResult({ success: false, status: "rejected", trade_id: "trade-123", tx_hash: `0x${"a".repeat(64)}`,
      fee_breakdown: { gas_cost_usd: "1.00", gas_cost_from_token: "1.27", debug: "private" },
      error: "private traceback", error_code: "EXECUTOR_PRIVATE_PANIC", message: "private host", debug: { signature: "secret" } });
    expect(result).toMatchObject({ success: false, status: "rejected", trade_id: "trade-123", error_code: "sera_unavailable", error: SERA_SERVICE_UNAVAILABLE_MESSAGE });
    expect(result.fee_breakdown).toEqual({ gas_cost_usd: "1.00", gas_cost_from_token: "1.27" });
    expect(JSON.stringify(result)).not.toMatch(/private|signature|secret|EXECUTOR/);
  });
});

describe("Sera provider code extraction", () => {
  it.each([
    [{ detail: { error: "private trace", code: "NO_LIQUIDITY" } }, "NO_LIQUIDITY"],
    [{ detail: "no_liquidity" }, "no_liquidity"],
    [{ error_code: "SLIPPAGE_EXCEEDED", detail: "private trace" }, "SLIPPAGE_EXCEEDED"],
  ])("retains machine codes separately from provider text", async (body, expectedCode) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body, { status: 400 })));
    await expect(callSeraApi({ path: "/swap/quote" })).rejects.toMatchObject({ errorCode: expectedCode });
  });
});
