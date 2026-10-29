import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, fetchApi } from "../client/src/lib/api";
import { getSeraPublicErrorMessage, SERA_NO_LIQUIDITY_MESSAGE, SERA_SERVICE_UNAVAILABLE_MESSAGE } from "../shared/sera-errors";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dashboard API error responses", () => {
  it.each([
    ["plain text", "Upstream service unavailable"],
    ["HTML", "<html><svg></svg>Bad gateway</html>"],
    ["malformed JSON", '{"error":'],
    ["empty body", ""],
    ["JSON error", '{"error":"Sera API unavailable"}'],
    ["JSON without an error", '{"status":"failed"}'],
    ["JSON null", "null"],
    ["provider details", JSON.stringify({ error: "quote.permit.owner is invalid", detail: { signature: "private", payload: "<svg>" } })],
  ])("hides %s and reads the response only once", async (_label, body) => {
    const response = new Response(body, { status: 502, statusText: "Bad Gateway" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    const error = await fetchApi("/merchant/sera-config/test", { method: "POST" }).catch((cause) => cause);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 502, message: SERA_SERVICE_UNAVAILABLE_MESSAGE, errorCode: "sera_unavailable" });
    expect(error).not.toHaveProperty("detail");
    expect(response.bodyUsed).toBe(true);
  });

  it.each(["/payment/swap/preflight", "/sera/tokens?chainId=1", "/merchant/sera-config/test"])("preserves known liquidity errors for %s", async (path) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "private provider details", errorCode: "NO_LIQUIDITY" }, { status: 409 })));

    await expect(fetchApi(path)).rejects.toMatchObject({ message: SERA_NO_LIQUIDITY_MESSAGE, errorCode: "no_liquidity", status: 409 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["quote_stale", "amount_below_min", "invalid_quote", "payment_attempt_in_progress"])("keeps %s as a machine code with safe copy", async (errorCode) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ errorCode, error: "quote.permit.owner: internal schema", detail: { signature: "private" } }, { status: 400 })));

    await expect(fetchApi("/payment/swap/preflight")).rejects.toMatchObject({ errorCode, message: getSeraPublicErrorMessage(errorCode) });
  });

  it("hides a consumed stream error", async () => {
    const response = new Response("<svg>proxy failure</svg>", { status: 502 });
    await response.text();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    await expect(fetchApi("/sera/tokens")).rejects.toMatchObject({ status: 502, message: SERA_SERVICE_UNAVAILABLE_MESSAGE });
  });

  it("hides fetch failures and invalid successful JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("Failed to execute 'text' on 'Response': body stream already read"))
      .mockResolvedValueOnce(new Response("<svg>proxy failure</svg>")));

    await expect(fetchApi("/sera/tokens")).rejects.toMatchObject({ message: SERA_SERVICE_UNAVAILABLE_MESSAGE });
    await expect(fetchApi("/sera/tokens")).rejects.toMatchObject({ message: SERA_SERVICE_UNAVAILABLE_MESSAGE });
  });

  it("preserves ordinary local validation messages and auth guidance", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ error: "Name is required" }, { status: 400 }))
      .mockResolvedValueOnce(Response.json({ error: "Invalid API key" }, { status: 401 })));

    await expect(fetchApi("/merchant/profile")).rejects.toMatchObject({ message: "Name is required" });
    await expect(fetchApi("/merchant/sera-config")).rejects.toMatchObject({ message: "Dashboard session expired. Reconnecting your wallet workspace." });
  });

  it("continues to parse successful JSON responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ healthy: true })));

    await expect(fetchApi("/sera/system")).resolves.toEqual({ healthy: true });
  });
});
