import { getSeraPublicErrorCode, getSeraPublicErrorMessage } from "../shared/sera-errors";
import { SeraApiError } from "./sera-api";
import { serializeSeraQuoteError } from "./sera-swap-quote";

/** Public responses never include provider messages, validation fields or payloads. */
export function seraRouteErrorResponse(error: unknown) {
  const validation = serializeSeraQuoteError(error);
  if (validation) return validation;
  const provider = error instanceof SeraApiError;
  const status = provider ? error.status : 502;
  const code = getSeraPublicErrorCode(error)
    ?? (status === 410 ? "quote_stale" : status === 429 ? "sera_rate_limited" : "sera_unavailable");
  return {
    status: provider && status >= 400 && status < 500 ? status : provider ? 503 : 502,
    body: { error: getSeraPublicErrorMessage(code), errorCode: code },
  };
}

/** Historical provider errors stay in storage, with fixed public copy on reads/events. */
export function publicSeraFailure(failureCode: unknown, status: string) {
  const code = getSeraPublicErrorCode(failureCode)
    ?? (status === "canceled" ? "canceled" : "settlement_failed");
  return { errorCode: code, reason: getSeraPublicErrorMessage(code) };
}

function diagnosticToken(value: unknown, field = false): string | undefined {
  return typeof value === "string" && value.length <= 100
    && (field ? /^[A-Za-z][A-Za-z0-9_.\[\]]*$/ : /^[A-Za-z][A-Za-z0-9_.:-]*$/).test(value)
    ? value : undefined;
}

/** Structured server diagnostics omit addresses, credentials, signatures and bodies. */
export function seraErrorDiagnostic(error: unknown) {
  const value = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const status = typeof value.status === "number" && Number.isInteger(value.status)
    && value.status >= 100 && value.status <= 599 ? value.status : undefined;
  return {
    type: diagnosticToken(value.name) ?? "unknown_error",
    code: diagnosticToken(value.errorCode) ?? diagnosticToken(value.code) ?? "unknown_error",
    ...(status ? { status } : {}),
    ...(diagnosticToken(value.field, true) ? { field: diagnosticToken(value.field, true) } : {}),
  };
}

/** Keep documented submission metadata without forwarding arbitrary provider fields. */
export function publicSeraSubmissionResult(result: Record<string, unknown>) {
  const identifier = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value)
    ? value : null;
  const status = typeof result.status === "string" ? result.status.toLowerCase() : "pending";
  const publicStatus = ["pending", "submitted", "processing", "settled", "failed", "rejected", "cancelled", "canceled"]
    .includes(status) ? status : "pending";
  const fee = result.fee_breakdown && typeof result.fee_breakdown === "object"
    ? result.fee_breakdown as Record<string, unknown> : {};
  const decimal = (value: unknown) => typeof value === "string" && value.length <= 100
    && /^\d+(?:\.\d+)?$/.test(value) ? value : undefined;
  const gasUsd = decimal(fee.gas_cost_usd);
  const gasToken = decimal(fee.gas_cost_from_token);
  return {
    ...(typeof result.success === "boolean" ? { success: result.success } : {}),
    status: publicStatus,
    trade_id: identifier(result.trade_id),
    tx_hash: typeof result.tx_hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(result.tx_hash)
      ? result.tx_hash : null,
    ...(gasUsd !== undefined || gasToken !== undefined ? { fee_breakdown: {
      ...(gasUsd !== undefined ? { gas_cost_usd: gasUsd } : {}),
      ...(gasToken !== undefined ? { gas_cost_from_token: gasToken } : {}),
    } } : {}),
    ...(result.error || result.error_code ? {
      error: getSeraPublicErrorMessage(result.error_code),
      error_code: getSeraPublicErrorCode(result.error_code) ?? "sera_unavailable",
    } : {}),
  };
}
