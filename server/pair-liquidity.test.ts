import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The module under test keeps its map in module scope and reads SERA_PAIR_SWEEP
// once, at import. Every test therefore loads a fresh copy through
// `loadPairLiquidity` rather than importing at the top, or state from one case
// would decide the next one.
//
// `./sera-api` is replaced wholesale: the real one performs network calls, and
// the sweep is the only thing here that would make them. The stand-in error
// class is a real subclass because the module branches on `instanceof`.
const seraApi = vi.hoisted(() => {
  class SeraApiError extends Error {
    status: number;
    detail: unknown;
    errorCode: string | null;
    constructor(status: number, message: string, detail?: unknown, errorCode?: string | null) {
      super(message);
      this.name = "SeraApiError";
      this.status = status;
      this.detail = detail;
      this.errorCode = errorCode ?? null;
    }
  }
  return { callSeraApi: vi.fn(), getSeraMarkets: vi.fn(), SeraApiError };
});

vi.mock("./sera-api", () => ({
  callSeraApi: seraApi.callSeraApi,
  getSeraMarkets: seraApi.getSeraMarkets,
  SeraApiError: seraApi.SeraApiError,
}));

type PairLiquidity = typeof import("./pair-liquidity");

async function loadPairLiquidity(sweep?: string): Promise<PairLiquidity> {
  if (sweep === undefined) vi.stubEnv("SERA_PAIR_SWEEP", "");
  else vi.stubEnv("SERA_PAIR_SWEEP", sweep);
  vi.resetModules();
  return import("./pair-liquidity");
}

function market(base: string, quote: string, overrides: Record<string, unknown> = {}) {
  return {
    symbol: `${base}/${quote}`,
    base_address: `0x${base.toLowerCase().padEnd(40, "0")}`,
    quote_address: `0x${quote.toLowerCase().padEnd(40, "1")}`,
    base_symbol: base,
    quote_symbol: quote,
    tick_precision: 6,
    quantity_precision: 6,
    base_decimals: 6,
    quote_decimals: 6,
    min_ask_amount_raw: "1000000",
    min_ask_amount: "1",
    min_bid_quote_amount_raw: "1000000",
    min_bid_quote_amount: "1",
    ...overrides,
  };
}

/** Routes the two endpoints the sweep touches; quotes answer via `onQuote`. */
function wireSera(markets: unknown[], onQuote: () => unknown) {
  seraApi.getSeraMarkets.mockResolvedValue({ markets });
  seraApi.callSeraApi.mockImplementation(async (options: any) => {
    if (options.path === "/system/time") return { timestamp: Math.floor(Date.now() / 1000) };
    if (options.path === "/swap/quote") return onQuote();
    throw new Error(`unexpected path ${options.path}`);
  });
}

const priceable = () => ({ quote: { route_params: { minOutputAmount: "990000" } } });

beforeEach(() => {
  seraApi.callSeraApi.mockReset();
  seraApi.getSeraMarkets.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("getPairSnapshot before anything has been recorded", () => {
  it("reports an empty, incomplete map rather than claiming knowledge", async () => {
    const { getPairSnapshot } = await loadPairLiquidity();

    expect(getPairSnapshot()).toEqual({ pairs: {}, checkedAt: null, complete: false });
  });
});

describe("notePairResult", () => {
  it("records a priceable pair in both directions", async () => {
    const { notePairResult, getPairSnapshot } = await loadPairLiquidity();

    notePairResult("XSGD", "MYRT", true);

    expect(getPairSnapshot().pairs).toEqual({ XSGD: ["MYRT"], MYRT: ["XSGD"] });
  });

  it("normalises case and surrounding whitespace on both symbols", async () => {
    const { notePairResult, getPairSnapshot } = await loadPairLiquidity();

    notePairResult("  xsgd ", "myrt", true);

    expect(getPairSnapshot().pairs).toEqual({ XSGD: ["MYRT"], MYRT: ["XSGD"] });
  });

  it("treats differently-cased spellings of one pair as the same pair", async () => {
    const { notePairResult, getPairSnapshot } = await loadPairLiquidity();

    notePairResult("xsgd", "myrt", true);
    notePairResult("XSGD", "MyRt", true);

    expect(getPairSnapshot().pairs.XSGD).toEqual(["MYRT"]);
  });

  it("ignores a result whose symbols are blank", async () => {
    const { notePairResult, getPairSnapshot } = await loadPairLiquidity();

    notePairResult("", "MYRT", true);
    notePairResult("XSGD", "   ", true);

    expect(getPairSnapshot().pairs).toEqual({});
  });

  it("drops a pair from the snapshot once it stops pricing", async () => {
    const { notePairResult, getPairSnapshot } = await loadPairLiquidity();

    notePairResult("XSGD", "MYRT", true);
    notePairResult("XSGD", "MYRT", false);

    expect(getPairSnapshot().pairs).toEqual({});
  });

  it("restores a pair that prices again after previously failing", async () => {
    const { notePairResult, getPairSnapshot } = await loadPairLiquidity();

    notePairResult("XSGD", "MYRT", false);
    notePairResult("XSGD", "MYRT", true);

    expect(getPairSnapshot().pairs).toEqual({ XSGD: ["MYRT"], MYRT: ["XSGD"] });
  });

  it("keeps a symbol's other counterparts when one of them stops pricing", async () => {
    const { notePairResult, getPairSnapshot } = await loadPairLiquidity();

    notePairResult("USDC", "MYRT", true);
    notePairResult("USDC", "XSGD", true);
    notePairResult("USDC", "MYRT", false);

    expect(getPairSnapshot().pairs.USDC).toEqual(["XSGD"]);
    expect(getPairSnapshot().pairs.MYRT).toBeUndefined();
  });

  it("sorts each symbol's counterparts so the snapshot is stable to compare", async () => {
    const { notePairResult, getPairSnapshot } = await loadPairLiquidity();

    notePairResult("USDC", "XSGD", true);
    notePairResult("USDC", "EURC", true);
    notePairResult("USDC", "MYRT", true);

    expect(getPairSnapshot().pairs.USDC).toEqual(["EURC", "MYRT", "XSGD"]);
  });

  it("lets the most recent result decide, across an interleaved sequence", async () => {
    const { notePairResult, getPairSnapshot } = await loadPairLiquidity();

    notePairResult("USDC", "MYRT", true);
    notePairResult("USDC", "XSGD", true);
    notePairResult("USDC", "MYRT", false);
    notePairResult("USDC", "EURC", true);
    notePairResult("USDC", "XSGD", false);
    notePairResult("USDC", "MYRT", true);

    expect(getPairSnapshot().pairs.USDC).toEqual(["EURC", "MYRT"]);
  });

  it("returns a fresh snapshot each call, so a caller cannot mutate the map", async () => {
    const { notePairResult, getPairSnapshot } = await loadPairLiquidity();
    notePairResult("USDC", "MYRT", true);

    const first = getPairSnapshot();
    first.pairs.USDC.push("INJECTED");
    first.pairs.SPOOF = ["NOPE"];

    expect(getPairSnapshot().pairs).toEqual({ USDC: ["MYRT"], MYRT: ["USDC"] });
  });

  it("leaves checkedAt and complete alone, which only a sweep sets", async () => {
    const { notePairResult, getPairSnapshot } = await loadPairLiquidity();

    notePairResult("XSGD", "MYRT", true);

    expect(getPairSnapshot().checkedAt).toBeNull();
    expect(getPairSnapshot().complete).toBe(false);
  });
});

describe("refreshPairLiquidity is gated by SERA_PAIR_SWEEP", () => {
  it("does no work at all when the flag is unset", async () => {
    const { refreshPairLiquidity, getPairSnapshot } = await loadPairLiquidity();

    refreshPairLiquidity();
    await vi.waitFor(() => expect(seraApi.getSeraMarkets).not.toHaveBeenCalled());
    expect(getPairSnapshot().complete).toBe(false);
  });

  it.each(["false", "1", "TRUE", "yes", ""])(
    "stays off for SERA_PAIR_SWEEP=%j, which is not the literal string true",
    async (value) => {
      const { refreshPairLiquidity } = await loadPairLiquidity(value);

      refreshPairLiquidity();

      expect(seraApi.getSeraMarkets).not.toHaveBeenCalled();
    },
  );

  it("runs the sweep when the flag is exactly true", async () => {
    wireSera([market("XSGD", "MYRT")], priceable);
    const { refreshPairLiquidity, getPairSnapshot } = await loadPairLiquidity("true");

    refreshPairLiquidity();

    await vi.waitFor(() => expect(getPairSnapshot().complete).toBe(true));
    expect(getPairSnapshot().pairs).toEqual({ XSGD: ["MYRT"], MYRT: ["XSGD"] });
  });
});

describe("the sweep", () => {
  it("marks a market dead when neither direction returns an output amount", async () => {
    wireSera([market("AUDD", "USDT")], () => ({ quote: { route_params: {} } }));
    const { refreshPairLiquidity, getPairSnapshot } = await loadPairLiquidity("true");

    refreshPairLiquidity();

    await vi.waitFor(() => expect(getPairSnapshot().complete).toBe(true));
    expect(getPairSnapshot().pairs).toEqual({});
  });

  it("marks a market dead when the output amount is zero", async () => {
    wireSera([market("AUDD", "USDT")], () => ({ quote: { route_params: { minOutputAmount: "0" } } }));
    const { refreshPairLiquidity, getPairSnapshot } = await loadPairLiquidity("true");

    refreshPairLiquidity();

    await vi.waitFor(() => expect(getPairSnapshot().complete).toBe(true));
    expect(getPairSnapshot().pairs).toEqual({});
  });

  it("reads a quote returned without the outer quote wrapper", async () => {
    wireSera([market("XSGD", "MYRT")], () => ({ route_params: { minOutputAmount: "990000" } }));
    const { refreshPairLiquidity, getPairSnapshot } = await loadPairLiquidity("true");

    refreshPairLiquidity();

    await vi.waitFor(() => expect(getPairSnapshot().complete).toBe(true));
    expect(getPairSnapshot().pairs.XSGD).toEqual(["MYRT"]);
  });

  it("reads the camelCase spelling of route params", async () => {
    wireSera([market("XSGD", "MYRT")], () => ({ quote: { routeParams: { minOutputAmount: "990000" } } }));
    const { refreshPairLiquidity, getPairSnapshot } = await loadPairLiquidity("true");

    refreshPairLiquidity();

    await vi.waitFor(() => expect(getPairSnapshot().complete).toBe(true));
    expect(getPairSnapshot().pairs.XSGD).toEqual(["MYRT"]);
  });

  it("skips markets that are missing a symbol", async () => {
    wireSera([market("XSGD", "MYRT", { base_symbol: "" }), market("USDC", "EURC")], priceable);
    const { refreshPairLiquidity, getPairSnapshot } = await loadPairLiquidity("true");

    refreshPairLiquidity();

    await vi.waitFor(() => expect(getPairSnapshot().complete).toBe(true));
    expect(getPairSnapshot().pairs.XSGD).toBeUndefined();
    expect(getPairSnapshot().pairs.USDC).toEqual(["EURC"]);
  });

  it("sends the unauthenticated quote with a deadline ahead of Sera's own clock", async () => {
    wireSera([market("XSGD", "MYRT")], priceable);
    const { refreshPairLiquidity, getPairSnapshot } = await loadPairLiquidity("true");

    refreshPairLiquidity();
    await vi.waitFor(() => expect(getPairSnapshot().complete).toBe(true));

    const quoteCall = seraApi.callSeraApi.mock.calls
      .map(([options]: any[]) => options)
      .find((options: any) => options.path === "/swap/quote");
    expect(quoteCall).toMatchObject({ method: "POST", authMode: "none" });
    expect(quoteCall.body.expiration).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(quoteCall.body.gas_mode).toBe("pay_more");
  });

  it("does not start a second sweep while the refresh interval is still current", async () => {
    wireSera([market("XSGD", "MYRT")], priceable);
    const { refreshPairLiquidity, getPairSnapshot } = await loadPairLiquidity("true");

    refreshPairLiquidity();
    await vi.waitFor(() => expect(getPairSnapshot().complete).toBe(true));
    const callsAfterFirst = seraApi.getSeraMarkets.mock.calls.length;

    refreshPairLiquidity();

    expect(seraApi.getSeraMarkets.mock.calls.length).toBe(callsAfterFirst);
  });

  it("leaves the previous map in place when the markets call fails", async () => {
    seraApi.getSeraMarkets.mockRejectedValue(new Error("upstream down"));
    seraApi.callSeraApi.mockResolvedValue({ timestamp: Math.floor(Date.now() / 1000) });
    const { notePairResult, refreshPairLiquidity, getPairSnapshot } = await loadPairLiquidity("true");
    notePairResult("XSGD", "MYRT", true);

    refreshPairLiquidity();
    await vi.waitFor(() => expect(seraApi.getSeraMarkets).toHaveBeenCalled());

    expect(getPairSnapshot().pairs).toEqual({ XSGD: ["MYRT"], MYRT: ["XSGD"] });
  });

  it("leaves the previous map in place when the clock reading is not an integer", async () => {
    seraApi.getSeraMarkets.mockResolvedValue({ markets: [market("USDC", "EURC")] });
    seraApi.callSeraApi.mockResolvedValue({ timestamp: "not-a-number" });
    const { notePairResult, refreshPairLiquidity, getPairSnapshot } = await loadPairLiquidity("true");
    notePairResult("XSGD", "MYRT", true);

    refreshPairLiquidity();
    await vi.waitFor(() => expect(seraApi.getSeraMarkets).toHaveBeenCalled());

    expect(getPairSnapshot().pairs).toEqual({ XSGD: ["MYRT"], MYRT: ["XSGD"] });
    expect(getPairSnapshot().complete).toBe(false);
  });

  // A refusal to serve says nothing about any individual pair, so it must not
  // be recorded as one. These two cases are the reason the sweep unwinds
  // instead of continuing.
  it.each([429, 403])("abandons the sweep on HTTP %i without marking anything dead", async (status) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    wireSera([market("USDC", "EURC"), market("USDC", "MYRT")], () => {
      throw new seraApi.SeraApiError(status, `refused with ${status}`);
    });
    const { notePairResult, refreshPairLiquidity, getPairSnapshot } = await loadPairLiquidity("true");
    notePairResult("XSGD", "MYRT", true);

    refreshPairLiquidity();
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());

    expect(getPairSnapshot().pairs).toEqual({ XSGD: ["MYRT"], MYRT: ["XSGD"] });
    expect(getPairSnapshot().complete).toBe(false);
  });

  it("records an ordinary error against the pair rather than abandoning the sweep", async () => {
    wireSera([market("AUDD", "USDT")], () => {
      throw new seraApi.SeraApiError(500, "server error");
    });
    const { refreshPairLiquidity, getPairSnapshot } = await loadPairLiquidity("true");

    refreshPairLiquidity();

    await vi.waitFor(() => expect(getPairSnapshot().complete).toBe(true));
    expect(getPairSnapshot().pairs).toEqual({});
  });

  it("holds off the next sweep after a refusal instead of retrying straight into it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    wireSera([market("USDC", "EURC")], () => {
      throw new seraApi.SeraApiError(429, "refused");
    });
    const { refreshPairLiquidity, getPairSnapshot } = await loadPairLiquidity("true");

    refreshPairLiquidity();
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    const callsAfterFirst = seraApi.getSeraMarkets.mock.calls.length;

    refreshPairLiquidity();

    expect(seraApi.getSeraMarkets.mock.calls.length).toBe(callsAfterFirst);
    // The backoff is expressed by dating checkedAt into the past, so the
    // snapshot still reports itself incomplete while the hold is in force.
    expect(getPairSnapshot().checkedAt).not.toBeNull();
    expect(getPairSnapshot().complete).toBe(false);
  });

  it("skips a direction whose minimum amount is zero", async () => {
    wireSera(
      [market("XSGD", "MYRT", { min_ask_amount_raw: "0" })],
      () => ({ quote: { route_params: { minOutputAmount: "990000" } } }),
    );
    const { refreshPairLiquidity, getPairSnapshot } = await loadPairLiquidity("true");

    refreshPairLiquidity();
    await vi.waitFor(() => expect(getPairSnapshot().complete).toBe(true));

    const quoteCalls = seraApi.callSeraApi.mock.calls
      .map(([options]: any[]) => options)
      .filter((options: any) => options.path === "/swap/quote");
    expect(quoteCalls).toHaveLength(1);
    expect(quoteCalls[0].body.from_token).toBe(market("XSGD", "MYRT").quote_address);
  });

  it("records nothing and stays incomplete when both minimums are zero", async () => {
    wireSera(
      [market("XSGD", "MYRT", { min_ask_amount_raw: "0", min_bid_quote_amount_raw: "0" })],
      priceable,
    );
    const { refreshPairLiquidity, getPairSnapshot } = await loadPairLiquidity("true");

    refreshPairLiquidity();
    await vi.waitFor(() => expect(getPairSnapshot().complete).toBe(true));

    const quoteCalls = seraApi.callSeraApi.mock.calls
      .map(([options]: any[]) => options)
      .filter((options: any) => options.path === "/swap/quote");
    expect(quoteCalls).toHaveLength(0);
    expect(getPairSnapshot().pairs).toEqual({});
  });
});

describe("importing the module", () => {
  it("schedules no background work under the test runner", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

    await loadPairLiquidity("true");

    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  it("makes no network call merely by being imported", async () => {
    await loadPairLiquidity("true");

    expect(seraApi.getSeraMarkets).not.toHaveBeenCalled();
    expect(seraApi.callSeraApi).not.toHaveBeenCalled();
  });
});
