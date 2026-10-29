import { describe, expect, it, vi } from "vitest";
import { SERA_NO_LIQUIDITY_MESSAGE, SERA_SERVICE_UNAVAILABLE_MESSAGE } from "../shared/sera-errors";
import {
  SeraQuoteValidationError,
  assertSeraMinimumInput,
  calculateFixedOutputRetryInputRaw,
  mapSeraQuoteProviderError,
  serializeSeraQuoteError,
  solveSeraFixedOutputQuote,
  toSeraPreflightSummary,
  validateSeraDeploymentConfig,
  validateSeraSwapQuote,
  validateSeraSwapQuoteRequest,
  type SeraSwapQuoteRequest,
} from "./sera-swap-quote";

const NOW = 2_000_000_000;
const OWNER = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x2222222222222222222222222222222222222222";
const INPUT_TOKEN = "0x3333333333333333333333333333333333333333";
const OUTPUT_TOKEN = "0x4444444444444444444444444444444444444444";
const SERA = "0x5555555555555555555555555555555555555555";
const VAULT = "0x6666666666666666666666666666666666666666";
const SOR = "0x7777777777777777777777777777777777777777";

const rawConfig = {
  chain_id: 1,
  sera_address: SERA,
  vault_address: VAULT,
  sor_address: SOR,
  domain_separator: `0x${"8".repeat(64)}`,
  eip712_domain: {
    name: "Sera",
    version: "1",
    chainId: 1,
    verifyingContract: SERA,
  },
};

const rawRequest = (fromAmount = "1000") => ({
  from_token: INPUT_TOKEN,
  to_token: OUTPUT_TOKEN,
  from_amount: fromAmount,
  owner_address: OWNER,
  recipient: RECIPIENT,
  expiration: NOW + 300,
  gas_mode: "pay_more",
});

const permitTypes = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

function rawQuote(
  request: SeraSwapQuoteRequest,
  options: {
    outputRaw?: string;
    maxInputRaw?: string;
    permitSupported?: boolean;
    permitRequired?: boolean;
    currentAllowanceRaw?: string;
    uuid?: string;
    gasCostUsd?: string;
    gasCostFromToken?: string;
  } = {},
) {
  const maxInputRaw = options.maxInputRaw ?? request.from_amount;
  const permitSupported = options.permitSupported ?? true;
  const currentAllowanceRaw = options.currentAllowanceRaw ?? "0";
  const permitRequired = options.permitRequired ?? (permitSupported && BigInt(currentAllowanceRaw) < BigInt(maxInputRaw));
  return {
    uuid: options.uuid ?? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    route_params: {
      taker: request.owner_address,
      inputToken: request.from_token,
      outputToken: request.to_token,
      maxInputAmount: maxInputRaw,
      minOutputAmount: options.outputRaw ?? "1000",
      recipient: request.recipient,
      initialDepositAmount: maxInputRaw,
      uuid: "123456789",
      deadline: request.expiration,
    },
    fee_breakdown: {
      gas_cost_usd: options.gasCostUsd ?? "1.00",
      gas_cost_from_token: options.gasCostFromToken ?? "1.00",
    },
    expires_at: NOW + 30,
    permit: {
      permit_supported: permitSupported,
      permit_required: permitRequired,
      token: request.from_token,
      spender: SOR,
      owner: request.owner_address,
      value_raw: maxInputRaw,
      current_allowance_raw: currentAllowanceRaw,
      ...(permitRequired ? {
        nonce: 7,
        suggested_deadline: request.expiration,
        domain: {
          name: "Input Token",
          version: "1",
          chainId: 1,
          verifyingContract: request.from_token,
        },
        eip712: {
          domain: {
            name: "Input Token",
            version: "1",
            chainId: 1,
            verifyingContract: request.from_token,
          },
          primaryType: "Permit",
          types: permitTypes,
          message: {
            owner: request.owner_address,
            spender: SOR,
            value: maxInputRaw,
            nonce: 7,
            deadline: request.expiration,
          },
        },
      } : {}),
    },
  };
}

function expectCode(run: () => unknown, code: string) {
  try {
    run();
    throw new Error("Expected operation to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(SeraQuoteValidationError);
    expect(error).toMatchObject({ code });
  }
}

describe("Sera deployment and quote request validation", () => {
  it("pins the EIP-712 domain to the live Sera contract and expected chain", () => {
    const config = validateSeraDeploymentConfig(rawConfig, 1);
    expect(config).toMatchObject({
      chainId: 1,
      seraAddress: SERA,
      sorAddress: SOR,
      eip712Domain: { chainId: 1, verifyingContract: SERA },
    });

    expectCode(() => validateSeraDeploymentConfig({
      ...rawConfig,
      eip712_domain: { ...rawConfig.eip712_domain, verifyingContract: VAULT },
    }, 1), "invalid_config");
    expectCode(() => validateSeraDeploymentConfig(rawConfig, 11155111), "unsupported_chain");
  });

  it("requires a future, positive, fixed-output pay_more request", () => {
    const request = validateSeraSwapQuoteRequest(rawRequest(), { serverTime: NOW, expectedGasMode: "pay_more" });
    expect(request).toMatchObject({ from_amount: "1000", gas_mode: "pay_more" });

    expectCode(() => validateSeraSwapQuoteRequest({ ...rawRequest(), expiration: NOW }, { serverTime: NOW }), "invalid_request");
    expectCode(() => validateSeraSwapQuoteRequest({ ...rawRequest(), from_amount: "-1" }, { serverTime: NOW }), "invalid_request");
    expectCode(() => validateSeraSwapQuoteRequest({ ...rawRequest(), gas_mode: "receive_less" }, {
      serverTime: NOW,
      expectedGasMode: "pay_more",
    }), "invalid_request");
  });
});

describe("strict Sera quote and authorization validation", () => {
  const config = validateSeraDeploymentConfig(rawConfig, 1);
  const request = validateSeraSwapQuoteRequest(rawRequest(), { serverTime: NOW, expectedGasMode: "pay_more" });

  it("accepts a fully bound EIP-2612 quote", () => {
    const quote = validateSeraSwapQuote(rawQuote(request), { request, config, serverTime: NOW });
    expect(quote).toMatchObject({
      uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      routeParams: {
        taker: OWNER,
        inputToken: INPUT_TOKEN,
        outputToken: OUTPUT_TOKEN,
        recipient: RECIPIENT,
        maxInputAmount: "1000",
      },
      permit: {
        permitSupported: true,
        permitRequired: true,
        authorizationKind: "permit",
        spender: SOR,
      },
    });
  });

  it.each([
    ["recipient", (quote: any) => { quote.route_params.recipient = OWNER; }],
    ["permit token", (quote: any) => { quote.permit.token = OUTPUT_TOKEN; }],
    ["permit owner", (quote: any) => { quote.permit.owner = RECIPIENT; }],
    ["permit spender", (quote: any) => { quote.permit.spender = VAULT; }],
    ["permit value", (quote: any) => { quote.permit.eip712.message.value = "999"; }],
    ["permit deadline", (quote: any) => { quote.permit.eip712.message.deadline = NOW + 301; }],
    ["permit domain", (quote: any) => { quote.permit.eip712.domain.verifyingContract = OUTPUT_TOKEN; }],
  ])("rejects mismatched %s metadata", (_label, mutate) => {
    const quote = rawQuote(request);
    mutate(quote);
    expectCode(() => validateSeraSwapQuote(quote, { request, config, serverTime: NOW }), "invalid_quote");
  });

  it("models the non-Permit approval fallback and existing-allowance path", () => {
    const approval = validateSeraSwapQuote(rawQuote(request, {
      permitSupported: false,
      permitRequired: false,
    }), { request, config, serverTime: NOW });
    expect(approval.permit?.authorizationKind).toBe("approval");
    expect(approval.permit?.typedData).toBeNull();

    const existingAllowance = validateSeraSwapQuote(rawQuote(request, {
      permitSupported: false,
      permitRequired: false,
      currentAllowanceRaw: "1000",
    }), { request, config, serverTime: NOW });
    expect(existingAllowance.permit?.authorizationKind).toBe("none");
  });

  const approvalOnlyQuote = () => ({
    ...rawQuote(request),
    // Live XSGD quotes carry these six fields. permit_required means an
    // approval is needed here; this token cannot produce an EIP-2612 Permit.
    permit: {
      permit_supported: false,
      permit_required: true,
      token: INPUT_TOKEN,
      spender: SOR,
      value_raw: request.from_amount,
      current_allowance_raw: "0",
    },
  });

  it("accepts approval-only quotes without inventing a signable Permit", () => {
    const quote = validateSeraSwapQuote(approvalOnlyQuote(), { request, config, serverTime: NOW });
    expect(quote.permit).toMatchObject({
      permitSupported: false,
      permitRequired: false,
      authorizationKind: "approval",
      owner: OWNER,
      token: INPUT_TOKEN,
      spender: SOR,
      valueRaw: request.from_amount,
      typedData: null,
    });
  });

  it("retains the approval check when an unsupported token requests authorization despite reported allowance", () => {
    const raw = approvalOnlyQuote();
    raw.permit.current_allowance_raw = request.from_amount;
    const quote = validateSeraSwapQuote(raw, { request, config, serverTime: NOW });
    expect(quote.permit?.authorizationKind).toBe("approval");

    raw.permit.permit_required = false;
    expect(validateSeraSwapQuote(raw, { request, config, serverTime: NOW }).permit?.authorizationKind).toBe("none");
  });

  it.each([
    ["owner", (quote: any) => { quote.permit.owner = RECIPIENT; }],
    ["malformed owner", (quote: any) => { quote.permit.owner = null; }],
    ["empty owner", (quote: any) => { quote.permit.owner = ""; }],
    ["zero owner", (quote: any) => { quote.permit.owner = "0x0000000000000000000000000000000000000000"; }],
    ["token", (quote: any) => { quote.permit.token = OUTPUT_TOKEN; }],
    ["spender", (quote: any) => { quote.permit.spender = VAULT; }],
    ["value", (quote: any) => { quote.permit.value_raw = "999"; }],
    ["unexpected Permit", (quote: any) => { quote.permit.eip712 = rawQuote(request).permit.eip712; }],
  ])("rejects invalid approval-only %s metadata", (_label, mutate) => {
    const raw = approvalOnlyQuote();
    mutate(raw);
    expectCode(() => validateSeraSwapQuote(raw, { request, config, serverTime: NOW }), "invalid_quote");
  });

  it("still requires the explicit owner on a signable Permit", () => {
    const raw = rawQuote(request);
    delete (raw.permit as Partial<typeof raw.permit>).owner;
    expectCode(() => validateSeraSwapQuote(raw, { request, config, serverTime: NOW }), "invalid_quote");
  });

  it("classifies a zero-output response as definitive no liquidity", () => {
    expectCode(
      () => validateSeraSwapQuote(rawQuote(request, { outputRaw: "0" }), { request, config, serverTime: NOW }),
      "no_liquidity",
    );
  });
});

describe("fixed-output Sera quote solving", () => {
  it("performs one validated quote when an open-amount checkout omits a target", async () => {
    const requestQuote = vi.fn(async (request: Readonly<SeraSwapQuoteRequest>) => rawQuote(
      request as SeraSwapQuoteRequest,
      { outputRaw: "777" },
    ));
    const result = await solveSeraFixedOutputQuote({
      initialRequest: rawRequest(),
      config: rawConfig,
      expectedChainId: 1,
      serverTime: NOW,
      requestQuote,
    });
    expect(requestQuote).toHaveBeenCalledTimes(1);
    expect(result.targetOutputRaw).toBe("777");
    expect(result.attempts).toHaveLength(1);
  });

  it("enforces the token minimum without a quote call", async () => {
    const requestQuote = vi.fn();
    await expect(solveSeraFixedOutputQuote({
      initialRequest: rawRequest("999"),
      targetOutputRaw: "500",
      minimumInputRaw: "1000",
      minimumInputSymbol: "IDRT",
      config: rawConfig,
      expectedChainId: 1,
      serverTime: NOW,
      requestQuote,
    })).rejects.toMatchObject({ code: "amount_below_min" });
    expect(requestQuote).not.toHaveBeenCalled();
    expectCode(() => assertSeraMinimumInput("999", "1000", { symbol: "IDRT" }), "amount_below_min");
  });

  it("uses deterministic integer math for the one allowed proportional retry", async () => {
    expect(calculateFixedOutputRetryInputRaw("1000", "1000", "500")).toBe("2002");
    const requestQuote = vi.fn(async (request: Readonly<SeraSwapQuoteRequest>, attempt: 1 | 2) => rawQuote(
      request as SeraSwapQuoteRequest,
      {
        outputRaw: attempt === 1 ? "500" : "1000",
        uuid: attempt === 1
          ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
          : "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      },
    ));

    const result = await solveSeraFixedOutputQuote({
      initialRequest: rawRequest(),
      targetOutputRaw: "1000",
      config: rawConfig,
      expectedChainId: 1,
      serverTime: NOW,
      requestQuote,
    });
    expect(requestQuote).toHaveBeenCalledTimes(2);
    expect(result.finalRequest.from_amount).toBe("2002");
    expect(result.attempts).toHaveLength(2);
    expect(result.quote.routeParams.minOutputAmount).toBe("1000");
  });

  it("stops after two quotes and returns output_below_target", async () => {
    const requestQuote = vi.fn(async (request: Readonly<SeraSwapQuoteRequest>, attempt: 1 | 2) => rawQuote(
      request as SeraSwapQuoteRequest,
      {
        outputRaw: attempt === 1 ? "500" : "999",
        uuid: attempt === 1
          ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
          : "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      },
    ));
    await expect(solveSeraFixedOutputQuote({
      initialRequest: rawRequest(),
      targetOutputRaw: "1000",
      config: rawConfig,
      expectedChainId: 1,
      serverTime: NOW,
      requestQuote,
    })).rejects.toMatchObject({ code: "output_below_target" });
    expect(requestQuote).toHaveBeenCalledTimes(2);
  });

  it("applies optional fee and input-deviation caps", async () => {
    const base = {
      initialRequest: rawRequest(),
      targetOutputRaw: "1000",
      config: rawConfig,
      expectedChainId: 1,
      serverTime: NOW,
    };
    await expect(solveSeraFixedOutputQuote({
      ...base,
      policy: { maxGasCostUsd: "0.50" },
      requestQuote: async (request) => rawQuote(request as SeraSwapQuoteRequest),
    })).rejects.toMatchObject({ code: "fee_too_high" });

    await expect(solveSeraFixedOutputQuote({
      ...base,
      policy: { maxInputIncreaseBps: 500 },
      requestQuote: async (request) => rawQuote(request as SeraSwapQuoteRequest, { maxInputRaw: "1100" }),
    })).rejects.toMatchObject({ code: "price_deviation" });
  });

  it("returns a preflight-safe summary without reusable authorization data", async () => {
    const result = await solveSeraFixedOutputQuote({
      initialRequest: rawRequest(),
      targetOutputRaw: "1000",
      config: rawConfig,
      expectedChainId: 1,
      serverTime: NOW,
      requestQuote: async (request) => rawQuote(request as SeraSwapQuoteRequest),
    });
    const summary = toSeraPreflightSummary(result, NOW);
    expect(summary).toMatchObject({
      executable: true,
      advisory: true,
      requiresCustomerRequote: true,
      attemptCount: 1,
    });
    expect(JSON.stringify(summary)).not.toContain(result.quote.uuid);
    expect(summary).not.toHaveProperty("permit");
    expect(summary).not.toHaveProperty("routeParams");
  });
});

describe("stable Sera quote error mapping", () => {
  it("maps provider liquidity and infrastructure failures without mapping arbitrary bugs", () => {
    expect(mapSeraQuoteProviderError({ status: 400, errorCode: "NO_LIQUIDITY" })).toMatchObject({ code: "no_liquidity" });
    expect(mapSeraQuoteProviderError({ status: 429 })).toMatchObject({ code: "sera_rate_limited" });
    expect(mapSeraQuoteProviderError({ status: 503 })).toMatchObject({ code: "sera_unavailable" });
    expect(mapSeraQuoteProviderError(new Error("programming bug"))).toBeNull();

    const response = serializeSeraQuoteError(new SeraQuoteValidationError("no_liquidity", "No route"));
    expect(response).toEqual({
      status: 409,
      body: { error: SERA_NO_LIQUIDITY_MESSAGE, errorCode: "no_liquidity" },
    });
  });

  it.each([500, 502, 503, 504, 599])("maps HTTP %i to an unavailable quote service", (status) => {
    expect(mapSeraQuoteProviderError({ status })).toMatchObject({ code: "sera_unavailable", status: 503 });
  });

  it("recognizes nested infrastructure failures and inactive pairs", () => {
    expect(mapSeraQuoteProviderError({ cause: { code: "UND_ERR_HEADERS_TIMEOUT" } })).toMatchObject({ code: "sera_unavailable" });
    expect(mapSeraQuoteProviderError({ name: "TimeoutError" })).toMatchObject({ code: "sera_unavailable" });
    expect(mapSeraQuoteProviderError({ status: 400, detail: { code: "PAIR_INACTIVE" } })).toMatchObject({ code: "no_liquidity" });
  });

  it.each(["ALLOWANCE_INSUFFICIENT", "INTENT_DEADLINE_EXPIRED", "SLIPPAGE_EXCEEDED", "QUOTE_STALE", "STP_BLOCKED"])(
    "leaves submit lifecycle code %s for its caller",
    (errorCode) => {
      expect(mapSeraQuoteProviderError({ status: 409, errorCode })).toBeNull();
    },
  );

  it("keeps validation diagnostics private while preserving the public code and status", () => {
    const error = new SeraQuoteValidationError("invalid_quote", "Internal quote.permit.owner was malformed", {
      field: "quote.permit.owner",
      detail: { privatePayload: "do not expose", minimumInputRaw: "123456" },
    });
    expect(serializeSeraQuoteError(error)).toEqual({
      status: 502,
      body: { error: SERA_SERVICE_UNAVAILABLE_MESSAGE, errorCode: "invalid_quote" },
    });
    expect(error.field).toBe("quote.permit.owner");
    expect(error.detail).toHaveProperty("privatePayload");
    expect(error.message).toContain("quote.permit.owner");
  });
});
