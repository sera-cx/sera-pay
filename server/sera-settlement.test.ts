import { describe, expect, it } from "vitest";
import {
  SeraSettlementValidationError,
  validateSeraSettledOrder,
  type ExpectedSeraSettlement,
} from "./sera-settlement";

const PAYER = "0x1111111111111111111111111111111111111111";
const INPUT = "0x2222222222222222222222222222222222222222";
const OUTPUT = "0x3333333333333333333333333333333333333333";
const FEE_TOKEN = "0x4444444444444444444444444444444444444444";
const TRADE_ID = "trade_01K4A9SERA";
const TX_HASH = `0x${"ab".repeat(32)}`;

const expectation: ExpectedSeraSettlement = {
  tradeId: TRADE_ID,
  payerAddress: PAYER,
  inputTokenAddress: INPUT,
  outputTokenAddress: OUTPUT,
  targetOutputAmountRaw: "200000",
};

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    trade_id: TRADE_ID,
    owner_address: PAYER,
    order_type: "swap",
    from_token: INPUT,
    to_token: OUTPUT,
    status: "settled",
    settlement_summary: {
      latest_tx_hash: TX_HASH,
    },
    settlement_economics: {
      perspective_order_id: TRADE_ID,
      balance_debits: [{ token_address: INPUT, amount_raw: "113334" }],
      balance_credits: [{ token_address: OUTPUT, amount_raw: "200000" }],
      fees_paid: [{ token_address: INPUT, amount_raw: "123" }],
    },
    ...overrides,
  };
}

function expectValidationCode(fn: () => unknown, code: SeraSettlementValidationError["code"]) {
  let error: unknown;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(SeraSettlementValidationError);
  expect((error as SeraSettlementValidationError).code).toBe(code);
  return error as SeraSettlementValidationError;
}

describe("validateSeraSettledOrder", () => {
  it("returns normalized identity, economics, fees, and transaction hash", () => {
    const result = validateSeraSettledOrder(makeOrder({
      owner_address: PAYER.toUpperCase().replace("0X", "0x"),
      from_token: INPUT.toUpperCase().replace("0X", "0x"),
      to_token: OUTPUT.toUpperCase().replace("0X", "0x"),
      settlement_summary: { latest_tx_hash: TX_HASH.toUpperCase().replace("0X", "0x") },
    }), expectation);

    expect(result).toEqual({
      tradeId: TRADE_ID,
      status: "settled",
      payerAddress: PAYER,
      inputTokenAddress: INPUT,
      outputTokenAddress: OUTPUT,
      actualPayRaw: "113334",
      actualReceiveRaw: "200000",
      fees: [{ tokenAddress: INPUT, amountRaw: "123" }],
      txHash: TX_HASH,
    });
  });

  it.each([
    ["trade ID", { trade_id: "another-trade" }, "TRADE_ID_MISMATCH"],
    ["payer", { owner_address: "0x9999999999999999999999999999999999999999" }, "PAYER_MISMATCH"],
    ["order type", { order_type: "limit" }, "ORDER_TYPE_MISMATCH"],
    ["input token", { from_token: FEE_TOKEN }, "INPUT_TOKEN_MISMATCH"],
    ["output token", { to_token: FEE_TOKEN }, "OUTPUT_TOKEN_MISMATCH"],
  ] as const)("rejects a mismatched %s", (_label, overrides, code) => {
    expectValidationCode(() => validateSeraSettledOrder(makeOrder(overrides), expectation), code);
  });

  it("treats a pending order as retryable instead of accepting it as paid", () => {
    const pending = makeOrder({
      status: "pending",
      settlement_summary: null,
      settlement_economics: null,
    });
    const error = expectValidationCode(
      () => validateSeraSettledOrder(pending, expectation),
      "ORDER_NOT_SETTLED",
    );
    expect(error.retryable).toBe(true);
    expect(error.actual).toBe("pending");
  });

  it("rejects a merchant output credit below the required raw target", () => {
    const order = makeOrder({
      settlement_economics: {
        perspective_order_id: TRADE_ID,
        balance_debits: [{ token_address: INPUT, amount_raw: "113334" }],
        balance_credits: [{ token_address: OUTPUT, amount_raw: "199999" }],
        fees_paid: [],
      },
    });
    const error = expectValidationCode(
      () => validateSeraSettledOrder(order, expectation),
      "OUTPUT_UNDERPAID",
    );
    expect(error.expected).toBe("200000");
    expect(error.actual).toBe("199999");
  });

  it("rejects settlement economics debited in the wrong token", () => {
    const order = makeOrder({
      settlement_economics: {
        perspective_order_id: TRADE_ID,
        balance_debits: [{ token_address: FEE_TOKEN, amount_raw: "113334" }],
        balance_credits: [{ token_address: OUTPUT, amount_raw: "200000" }],
        fees_paid: [],
      },
    });
    expectValidationCode(
      () => validateSeraSettledOrder(order, expectation),
      "DEBIT_TOKEN_MISMATCH",
    );
  });

  it.each([
    "0x1234",
    `0x${"0".repeat(64)}`,
    `0x${"zz".repeat(32)}`,
  ])("rejects an invalid settlement transaction hash (%s)", (latestTxHash) => {
    expectValidationCode(
      () => validateSeraSettledOrder(makeOrder({ settlement_summary: { latest_tx_hash: latestTxHash } }), expectation),
      "INVALID_SETTLEMENT_TX_HASH",
    );
  });

  it("safely aggregates duplicate debit, credit, and fee entries with bigint", () => {
    const order = makeOrder({
      settlement_economics: {
        perspective_order_id: TRADE_ID,
        balance_debits: [
          { token_address: INPUT, amount_raw: "9007199254740993" },
          { token_address: INPUT.toUpperCase().replace("0X", "0x"), amount_raw: "7" },
        ],
        balance_credits: [
          { token_address: OUTPUT, amount_raw: "120000" },
          { token_address: OUTPUT, amount_raw: "80000" },
        ],
        fees_paid: [
          { token_address: FEE_TOKEN, amount_raw: "9" },
          { token_address: INPUT, amount_raw: "10" },
          { token_address: INPUT.toUpperCase().replace("0X", "0x"), amount_raw: "15" },
        ],
      },
    });

    const result = validateSeraSettledOrder(order, expectation);
    expect(result.actualPayRaw).toBe("9007199254741000");
    expect(result.actualReceiveRaw).toBe("200000");
    expect(result.fees).toEqual([
      { tokenAddress: INPUT, amountRaw: "25" },
      { tokenAddress: FEE_TOKEN, amountRaw: "9" },
    ]);
  });

  it.each(["0", "-1", "1.5", "not-a-number"])("rejects non-positive or malformed raw amounts (%s)", (amountRaw) => {
    const order = makeOrder({
      settlement_economics: {
        perspective_order_id: TRADE_ID,
        balance_debits: [{ token_address: INPUT, amount_raw: amountRaw }],
        balance_credits: [{ token_address: OUTPUT, amount_raw: "200000" }],
        fees_paid: [],
      },
    });
    expectValidationCode(() => validateSeraSettledOrder(order, expectation), "MALFORMED_ORDER");
  });

  it("rejects economics linked to a different perspective order", () => {
    const order = makeOrder({
      settlement_economics: {
        perspective_order_id: "another-trade",
        balance_debits: [{ token_address: INPUT, amount_raw: "113334" }],
        balance_credits: [{ token_address: OUTPUT, amount_raw: "200000" }],
        fees_paid: [],
      },
    });
    expectValidationCode(
      () => validateSeraSettledOrder(order, expectation),
      "PERSPECTIVE_ORDER_ID_MISMATCH",
    );
  });

  it("rejects missing perspective order identity as malformed", () => {
    const order = makeOrder({
      settlement_economics: {
        balance_debits: [{ token_address: INPUT, amount_raw: "113334" }],
        balance_credits: [{ token_address: OUTPUT, amount_raw: "200000" }],
        fees_paid: [],
      },
    });
    const error = expectValidationCode(
      () => validateSeraSettledOrder(order, expectation),
      "MALFORMED_ORDER",
    );
    expect(error.field).toBe("order.settlement_economics.perspective_order_id");
  });
});
