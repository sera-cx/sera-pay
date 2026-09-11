/**
 * Strict validation for the documented Sera `GET /orders/{trade_id}`
 * settlement fields.
 *
 * The tracked-order response does not contain the swap recipient. This module
 * therefore proves the order identity and economics that Sera exposes, but it
 * deliberately does not claim that the merchant recipient was verified. The
 * caller must retain the existing on-chain recipient/transfer verification
 * before marking a payment paid.
 */

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const TRANSACTION_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const ZERO_TRANSACTION_HASH = `0x${"0".repeat(64)}`;
const MAX_UINT256 = (1n << 256n) - 1n;

export type SeraSettlementValidationErrorCode =
  | "INVALID_EXPECTATION"
  | "MALFORMED_ORDER"
  | "ORDER_NOT_SETTLED"
  | "TRADE_ID_MISMATCH"
  | "PAYER_MISMATCH"
  | "ORDER_TYPE_MISMATCH"
  | "INPUT_TOKEN_MISMATCH"
  | "OUTPUT_TOKEN_MISMATCH"
  | "PERSPECTIVE_ORDER_ID_MISMATCH"
  | "DEBIT_TOKEN_MISMATCH"
  | "MISSING_INPUT_DEBIT"
  | "MISSING_OUTPUT_CREDIT"
  | "OUTPUT_UNDERPAID"
  | "INVALID_SETTLEMENT_TX_HASH";

export type SeraSettlementValidationErrorDetails = {
  field?: string;
  expected?: string;
  actual?: string;
  /** True only while Sera reports a non-terminal order state. */
  retryable?: boolean;
};

/** A stable, machine-readable failure returned by strict settlement checks. */
export class SeraSettlementValidationError extends Error {
  readonly name = "SeraSettlementValidationError";
  readonly retryable: boolean;
  readonly field?: string;
  readonly expected?: string;
  readonly actual?: string;

  constructor(
    readonly code: SeraSettlementValidationErrorCode,
    message: string,
    details: SeraSettlementValidationErrorDetails = {},
  ) {
    super(message);
    this.retryable = details.retryable ?? false;
    this.field = details.field;
    this.expected = details.expected;
    this.actual = details.actual;
  }
}

export type ExpectedSeraSettlement = {
  tradeId: string;
  payerAddress: string;
  inputTokenAddress: string;
  outputTokenAddress: string;
  targetOutputAmountRaw: string;
};

export type AggregatedSeraFee = {
  tokenAddress: `0x${string}`;
  amountRaw: string;
};

export type ValidatedSeraSettlement = {
  tradeId: string;
  status: "settled";
  payerAddress: `0x${string}`;
  inputTokenAddress: `0x${string}`;
  outputTokenAddress: `0x${string}`;
  /** Total documented payer debit in the input token. */
  actualPayRaw: string;
  /** Total documented credit in the output token. */
  actualReceiveRaw: string;
  /** Fee entries aggregated by token address in deterministic address order. */
  fees: AggregatedSeraFee[];
  txHash: `0x${string}`;
};

type UnknownRecord = Record<string, unknown>;

function fail(
  code: SeraSettlementValidationErrorCode,
  message: string,
  details: SeraSettlementValidationErrorDetails = {},
): never {
  throw new SeraSettlementValidationError(code, message, details);
}

function asRecord(value: unknown, field: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail("MALFORMED_ORDER", `${field} must be an object`, { field });
  }
  return value as UnknownRecord;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    return fail("MALFORMED_ORDER", `${field} must be a non-empty string`, { field });
  }
  return value.trim();
}

function expectedString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    return fail("INVALID_EXPECTATION", `${field} must be a non-empty string`, { field });
  }
  return value.trim();
}

function normalizedAddress(
  value: unknown,
  field: string,
  source: "expectation" | "order",
): `0x${string}` {
  const code = source === "expectation" ? "INVALID_EXPECTATION" : "MALFORMED_ORDER";
  if (typeof value !== "string" || !ADDRESS_PATTERN.test(value.trim())) {
    return fail(code, `${field} must be a 20-byte hex address`, { field });
  }
  return value.trim().toLowerCase() as `0x${string}`;
}

function positiveUint256(
  value: unknown,
  field: string,
  source: "expectation" | "order",
): bigint {
  const code = source === "expectation" ? "INVALID_EXPECTATION" : "MALFORMED_ORDER";
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    return fail(code, `${field} must be a positive uint256 decimal string`, { field });
  }

  const parsed = BigInt(value);
  if (parsed <= 0n || parsed > MAX_UINT256) {
    return fail(code, `${field} must be between 1 and uint256 max`, { field });
  }
  return parsed;
}

function aggregateTokenAmounts(value: unknown, field: string): Map<`0x${string}`, bigint> {
  if (!Array.isArray(value)) {
    return fail("MALFORMED_ORDER", `${field} must be an array`, { field });
  }

  const totals = new Map<`0x${string}`, bigint>();
  for (let index = 0; index < value.length; index += 1) {
    const itemField = `${field}[${index}]`;
    const item = asRecord(value[index], itemField);
    const tokenAddress = normalizedAddress(item.token_address, `${itemField}.token_address`, "order");
    const amountRaw = positiveUint256(item.amount_raw, `${itemField}.amount_raw`, "order");
    const total = (totals.get(tokenAddress) ?? 0n) + amountRaw;
    if (total > MAX_UINT256) {
      return fail("MALFORMED_ORDER", `${field} contains an aggregated amount above uint256 max`, {
        field,
      });
    }
    totals.set(tokenAddress, total);
  }
  return totals;
}

function assertEqual(
  actual: string,
  expected: string,
  code: SeraSettlementValidationErrorCode,
  field: string,
  message: string,
): void {
  if (actual !== expected) {
    fail(code, message, { field, expected, actual });
  }
}

/**
 * Validate and normalize a settled Sera tracked-order response.
 *
 * All identity comparisons are exact except Ethereum addresses, which are
 * compared case-insensitively. Raw amounts are parsed with bigint and returned
 * as canonical decimal strings, avoiding JavaScript number precision loss.
 */
export function validateSeraSettledOrder(
  response: unknown,
  expectation: ExpectedSeraSettlement,
): ValidatedSeraSettlement {
  const expectedTradeId = expectedString(expectation.tradeId, "expectation.tradeId");
  const expectedPayer = normalizedAddress(expectation.payerAddress, "expectation.payerAddress", "expectation");
  const expectedInput = normalizedAddress(
    expectation.inputTokenAddress,
    "expectation.inputTokenAddress",
    "expectation",
  );
  const expectedOutput = normalizedAddress(
    expectation.outputTokenAddress,
    "expectation.outputTokenAddress",
    "expectation",
  );
  const targetOutput = positiveUint256(
    expectation.targetOutputAmountRaw,
    "expectation.targetOutputAmountRaw",
    "expectation",
  );

  const order = asRecord(response, "order");
  const tradeId = nonEmptyString(order.trade_id, "order.trade_id");
  assertEqual(tradeId, expectedTradeId, "TRADE_ID_MISMATCH", "order.trade_id", "Sera trade ID does not match the submitted order");

  const payer = normalizedAddress(order.owner_address, "order.owner_address", "order");
  assertEqual(payer, expectedPayer, "PAYER_MISMATCH", "order.owner_address", "Sera order owner does not match the payer");

  const orderType = nonEmptyString(order.order_type, "order.order_type").toLowerCase();
  assertEqual(orderType, "swap", "ORDER_TYPE_MISMATCH", "order.order_type", "Sera order is not a swap");

  const inputToken = normalizedAddress(order.from_token, "order.from_token", "order");
  assertEqual(inputToken, expectedInput, "INPUT_TOKEN_MISMATCH", "order.from_token", "Sera input token does not match the payment");

  const outputToken = normalizedAddress(order.to_token, "order.to_token", "order");
  assertEqual(outputToken, expectedOutput, "OUTPUT_TOKEN_MISMATCH", "order.to_token", "Sera output token does not match the payment");

  const status = nonEmptyString(order.status, "order.status").toLowerCase();
  if (status !== "settled") {
    fail("ORDER_NOT_SETTLED", `Sera order is ${status}, not settled`, {
      field: "order.status",
      expected: "settled",
      actual: status,
      retryable: status === "pending" || status === "matched",
    });
  }

  const settlementSummary = asRecord(order.settlement_summary, "order.settlement_summary");
  const hashValue = nonEmptyString(settlementSummary.latest_tx_hash, "order.settlement_summary.latest_tx_hash");
  if (!TRANSACTION_HASH_PATTERN.test(hashValue) || hashValue.toLowerCase() === ZERO_TRANSACTION_HASH) {
    fail("INVALID_SETTLEMENT_TX_HASH", "Sera settlement transaction hash is missing or invalid", {
      field: "order.settlement_summary.latest_tx_hash",
      actual: hashValue,
    });
  }
  const txHash = hashValue.toLowerCase() as `0x${string}`;

  const economics = asRecord(order.settlement_economics, "order.settlement_economics");
  const perspectiveOrderId = nonEmptyString(
    economics.perspective_order_id,
    "order.settlement_economics.perspective_order_id",
  );
  assertEqual(
    perspectiveOrderId,
    expectedTradeId,
    "PERSPECTIVE_ORDER_ID_MISMATCH",
    "order.settlement_economics.perspective_order_id",
    "Sera settlement economics do not belong to the submitted order",
  );
  const debits = aggregateTokenAmounts(economics.balance_debits, "order.settlement_economics.balance_debits");
  const credits = aggregateTokenAmounts(economics.balance_credits, "order.settlement_economics.balance_credits");
  const feeTotals = aggregateTokenAmounts(economics.fees_paid, "order.settlement_economics.fees_paid");

  if (debits.size === 0) {
    fail("MISSING_INPUT_DEBIT", "Sera settlement has no payer debit", {
      field: "order.settlement_economics.balance_debits",
      expected: expectedInput,
    });
  }
  const unexpectedDebitTokens = [...debits.keys()].filter((address) => address !== expectedInput);
  if (unexpectedDebitTokens.length > 0) {
    fail("DEBIT_TOKEN_MISMATCH", "Sera payer debit contains a token other than the expected input token", {
      field: "order.settlement_economics.balance_debits",
      expected: expectedInput,
      actual: unexpectedDebitTokens.join(","),
    });
  }
  const actualPay = debits.get(expectedInput);
  if (!actualPay) {
    fail("MISSING_INPUT_DEBIT", "Sera settlement has no debit in the expected input token", {
      field: "order.settlement_economics.balance_debits",
      expected: expectedInput,
    });
  }

  const actualReceive = credits.get(expectedOutput);
  if (!actualReceive) {
    fail("MISSING_OUTPUT_CREDIT", "Sera settlement has no credit in the expected output token", {
      field: "order.settlement_economics.balance_credits",
      expected: expectedOutput,
    });
  }
  if (actualReceive < targetOutput) {
    fail("OUTPUT_UNDERPAID", "Sera settlement output is below the merchant target", {
      field: "order.settlement_economics.balance_credits",
      expected: targetOutput.toString(),
      actual: actualReceive.toString(),
    });
  }

  const fees: AggregatedSeraFee[] = [...feeTotals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([tokenAddress, amountRaw]) => ({ tokenAddress, amountRaw: amountRaw.toString() }));

  return {
    tradeId,
    status: "settled",
    payerAddress: payer,
    inputTokenAddress: inputToken,
    outputTokenAddress: outputToken,
    actualPayRaw: actualPay.toString(),
    actualReceiveRaw: actualReceive.toString(),
    fees,
    txHash,
  };
}
