import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screenWalletAddress } from "./compliance";
import { createComplianceScreeningLog } from "./db";

// `./db` reaches for a Postgres pool the moment it is imported, so the suite
// swaps the whole module for a spy. Every assertion about the audit trail reads
// off this mock rather than a database.
vi.mock("./db", () => ({
  createComplianceScreeningLog: vi.fn(async () => {}),
}));

const ADDRESS = "0xAbC1230000000000000000000000000000000001";
const NORMALIZED = ADDRESS.toLowerCase();

const logScreening = vi.mocked(createComplianceScreeningLog);
let fetchSpy: ReturnType<typeof vi.spyOn<typeof globalThis, "fetch">>;

beforeEach(() => {
  vi.stubEnv("CHAINALYSIS_ENABLED", "true");
  vi.stubEnv("CHAINALYSIS_API_KEY", "test-key");
  vi.stubEnv("CHAINALYSIS_BLOCK_ON_UNAVAILABLE", "false");
  logScreening.mockClear();
  // The suite must never reach the real provider. An unmocked call fails loudly
  // rather than silently going out to the network.
  fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("unexpected network call in test"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function respondWith(status: number, body: string | null, headers: Record<string, string> = {}) {
  fetchSpy.mockResolvedValue(new Response(body, { status, headers }));
}

function respondWithJson(status: number, payload: unknown) {
  respondWith(status, JSON.stringify(payload), { "Content-Type": "application/json" });
}

function lastLog() {
  expect(logScreening).toHaveBeenCalled();
  return logScreening.mock.calls.at(-1)![0];
}

describe("screenWalletAddress — well-formed provider answers", () => {
  it("reports clear when the provider returns an empty identifications array", async () => {
    respondWithJson(200, { identifications: [] });

    const result = await screenWalletAddress(ADDRESS, "payer_wallet", "merchant-1");

    expect(result.status).toBe("clear");
    expect(result.blocked).toBe(false);
    expect(result.identifications).toEqual([]);
    expect(lastLog()).toMatchObject({
      status: "clear",
      address: NORMALIZED,
      merchantId: "merchant-1",
      responseStatus: 200,
      errorMessage: null,
    });
  });

  it("reports blocked and passes the identifications through on a sanctions hit", async () => {
    const identification = { category: "sanctions", name: "OFAC SDN", url: "https://example.test/sdn" };
    respondWithJson(200, { identifications: [identification] });

    const result = await screenWalletAddress(ADDRESS, "recipient_wallet");

    expect(result.status).toBe("blocked");
    expect(result.blocked).toBe(true);
    expect(result.identifications).toEqual([identification]);
    expect(lastLog()).toMatchObject({ status: "blocked", responseStatus: 200 });
  });

  it("lowercases the address for the audit trail but queries the address as given", async () => {
    respondWithJson(200, { identifications: [] });

    const result = await screenWalletAddress(ADDRESS, "merchant_wallet");

    expect(result.address).toBe(NORMALIZED);
    expect(lastLog().address).toBe(NORMALIZED);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining(encodeURIComponent(ADDRESS)),
      expect.objectContaining({ headers: expect.objectContaining({ "X-API-Key": "test-key" }) }),
    );
  });
});

// The regression this module exists to prevent: a 2xx whose body carries no
// usable screening must never be recorded as "clear". Each case below is a
// response the provider can legitimately emit during a partial outage.
describe("screenWalletAddress — malformed 2xx bodies", () => {
  const malformed: Array<[string, () => void]> = [
    ["204 with no body", () => respondWith(204, null)],
    ["200 with an empty body", () => respondWith(200, "")],
    ["200 with an empty object", () => respondWithJson(200, {})],
    ["200 with an unrelated message", () => respondWithJson(200, { message: "upstream degraded" })],
    ["200 with a null identifications field", () => respondWithJson(200, { identifications: null })],
    ["200 with identifications as an object", () => respondWithJson(200, { identifications: {} })],
    ["200 with a top-level array", () => respondWithJson(200, [])],
    ["200 with a JSON string body", () => respondWithJson(200, "ok")],
    ["200 with a non-JSON body", () => respondWith(200, "<html>degraded</html>")],
  ];

  it.each(malformed)("never reports clear for a %s", async (_label, arrange) => {
    arrange();

    const result = await screenWalletAddress(ADDRESS, "payer_wallet");

    expect(result.status).not.toBe("clear");
    expect(result.blocked).toBe(false);
    expect(result.identifications).toEqual([]);
    expect(lastLog().status).not.toBe("clear");
  });

  it.each(malformed)("marks a %s unavailable when blocking is off", async (_label, arrange) => {
    vi.stubEnv("CHAINALYSIS_BLOCK_ON_UNAVAILABLE", "false");
    arrange();

    const result = await screenWalletAddress(ADDRESS, "payer_wallet");

    expect(result.status).toBe("unavailable");
    expect(result.blocked).toBe(false);
    expect(lastLog()).toMatchObject({ status: "unavailable" });
    expect(lastLog().errorMessage).toBeTruthy();
  });

  it.each(malformed)("marks a %s blocked when blocking is on", async (_label, arrange) => {
    vi.stubEnv("CHAINALYSIS_BLOCK_ON_UNAVAILABLE", "true");
    arrange();

    const result = await screenWalletAddress(ADDRESS, "payer_wallet");

    expect(result.status).toBe("blocked");
    expect(result.blocked).toBe(true);
    expect(lastLog()).toMatchObject({ status: "blocked" });
  });

  it("preserves the status and the parsed body of a readable but unusable 200", async () => {
    respondWithJson(200, { message: "upstream degraded" });

    await screenWalletAddress(ADDRESS, "payer_wallet");

    const log = lastLog();
    expect(log.responseStatus).toBe(200);
    expect(JSON.parse(log.responseBody as string)).toEqual({ message: "upstream degraded" });
    expect(log.errorMessage).toContain("without an identifications array");
  });

  it("preserves the status and the raw body of a 200 that is not JSON", async () => {
    respondWith(200, "<html>degraded</html>");

    await screenWalletAddress(ADDRESS, "payer_wallet");

    const log = lastLog();
    expect(log.responseStatus).toBe(200);
    expect(JSON.parse(log.responseBody as string)).toBe("<html>degraded</html>");
    expect(log.errorMessage).toContain("not valid JSON");
  });
});

describe("screenWalletAddress — provider error responses", () => {
  const errorStatuses = [400, 401, 403, 429, 500, 502, 503];

  it.each(errorStatuses)("marks HTTP %i unavailable when blocking is off", async (status) => {
    respondWithJson(status, { message: "nope" });

    const result = await screenWalletAddress(ADDRESS, "sub_wallet");

    expect(result.status).toBe("unavailable");
    expect(result.blocked).toBe(false);
    expect(result.message).toBe(`Chainalysis returned ${status}.`);
    expect(lastLog()).toMatchObject({ status: "unavailable", responseStatus: status });
  });

  it.each(errorStatuses)("marks HTTP %i blocked when blocking is on", async (status) => {
    vi.stubEnv("CHAINALYSIS_BLOCK_ON_UNAVAILABLE", "true");
    respondWithJson(status, { message: "nope" });

    const result = await screenWalletAddress(ADDRESS, "sub_wallet");

    expect(result.status).toBe("blocked");
    expect(result.blocked).toBe(true);
    expect(lastLog()).toMatchObject({ status: "blocked", responseStatus: status });
  });

  it("keeps the status and the raw body when an error response is not JSON", async () => {
    respondWith(502, "<html><body>Bad Gateway</body></html>", { "Content-Type": "text/html" });

    const result = await screenWalletAddress(ADDRESS, "sub_wallet");

    expect(result.status).toBe("unavailable");
    const log = lastLog();
    expect(log.responseStatus).toBe(502);
    expect(JSON.parse(log.responseBody as string)).toContain("Bad Gateway");
    expect(log.errorMessage).toBe("Chainalysis returned 502.");
  });

  it("truncates an oversized unparsable body instead of logging it whole", async () => {
    respondWith(502, "x".repeat(10_000));

    await screenWalletAddress(ADDRESS, "sub_wallet");

    expect((JSON.parse(lastLog().responseBody as string) as string).length).toBe(2_000);
  });

  it("never reports an error response as clear, at any status", async () => {
    for (const status of errorStatuses) {
      logScreening.mockClear();
      respondWithJson(status, { identifications: [] });

      const result = await screenWalletAddress(ADDRESS, "sub_wallet");

      expect(result.status).not.toBe("clear");
      expect(lastLog().status).not.toBe("clear");
    }
  });
});

describe("screenWalletAddress — transport failures", () => {
  it("reports a timeout as unavailable and keeps the error message", async () => {
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), {
      name: "TimeoutError",
    });
    fetchSpy.mockRejectedValue(timeout);

    const result = await screenWalletAddress(ADDRESS, "payer_wallet");

    expect(result.status).toBe("unavailable");
    expect(result.blocked).toBe(false);
    expect(result.message).toBe("The operation was aborted due to timeout");
    expect(lastLog()).toMatchObject({
      status: "unavailable",
      errorMessage: "The operation was aborted due to timeout",
    });
  });

  it("reports a timeout as blocked when blocking is on", async () => {
    vi.stubEnv("CHAINALYSIS_BLOCK_ON_UNAVAILABLE", "true");
    fetchSpy.mockRejectedValue(new Error("The operation was aborted due to timeout"));

    const result = await screenWalletAddress(ADDRESS, "payer_wallet");

    expect(result.status).toBe("blocked");
    expect(result.blocked).toBe(true);
  });

  it("reports a network failure as unavailable", async () => {
    fetchSpy.mockRejectedValue(new TypeError("fetch failed"));

    const result = await screenWalletAddress(ADDRESS, "payer_wallet");

    expect(result.status).toBe("unavailable");
    expect(result.message).toBe("fetch failed");
  });

  it("survives a rejection that is not an Error", async () => {
    fetchSpy.mockRejectedValue("boom");

    const result = await screenWalletAddress(ADDRESS, "payer_wallet");

    expect(result.status).toBe("unavailable");
    expect(result.message).toBe("Chainalysis screening failed.");
  });
});

describe("screenWalletAddress — configuration gates", () => {
  it("skips screening and does not call the provider when disabled", async () => {
    vi.stubEnv("CHAINALYSIS_ENABLED", "false");

    const result = await screenWalletAddress(ADDRESS, "merchant_wallet");

    expect(result.status).toBe("skipped");
    expect(result.blocked).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lastLog()).toMatchObject({ status: "skipped" });
  });

  it("stays skipped when disabled even if blocking on unavailable is on", async () => {
    vi.stubEnv("CHAINALYSIS_ENABLED", "false");
    vi.stubEnv("CHAINALYSIS_BLOCK_ON_UNAVAILABLE", "true");

    const result = await screenWalletAddress(ADDRESS, "merchant_wallet");

    expect(result.status).toBe("skipped");
    expect(result.blocked).toBe(false);
  });

  it("reports a missing API key as unavailable when blocking is off", async () => {
    vi.stubEnv("CHAINALYSIS_API_KEY", "");

    const result = await screenWalletAddress(ADDRESS, "merchant_wallet");

    expect(result.status).toBe("unavailable");
    expect(result.blocked).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lastLog()).toMatchObject({
      status: "unavailable",
      errorMessage: "CHAINALYSIS_API_KEY is not configured.",
    });
  });

  it("reports a missing API key as blocked when blocking is on", async () => {
    vi.stubEnv("CHAINALYSIS_API_KEY", "");
    vi.stubEnv("CHAINALYSIS_BLOCK_ON_UNAVAILABLE", "true");

    const result = await screenWalletAddress(ADDRESS, "merchant_wallet");

    expect(result.status).toBe("blocked");
    expect(result.blocked).toBe(true);
  });
});
