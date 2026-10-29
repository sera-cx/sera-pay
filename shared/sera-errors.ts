/** Public Sera errors use fixed copy; provider messages and payloads stay private. */
export const SERA_SERVICE_UNAVAILABLE_MESSAGE =
  "We couldn't complete this conversion right now. Please try again shortly.";

export const SERA_NO_LIQUIDITY_MESSAGE =
  "No liquidity for this pair — try another currency.";

const PUBLIC_ERROR_MESSAGES = {
  invalid_request: "Please check the payment details and try again.",
  unsupported_token: "This currency is unavailable. Please choose another currency.",
  unsupported_chain: "This network is unavailable. Please choose a supported network.",
  invalid_config: SERA_SERVICE_UNAVAILABLE_MESSAGE,
  invalid_quote: SERA_SERVICE_UNAVAILABLE_MESSAGE,
  invalid_signature: "We couldn't verify the wallet authorization. Please try again.",
  amount_below_min: "This amount is below the minimum for this conversion. Please increase the amount.",
  no_liquidity: SERA_NO_LIQUIDITY_MESSAGE,
  output_below_target: "We couldn't get a quote for this amount. Try a smaller amount or another currency.",
  fee_too_high: "The conversion fee is too high right now. Please try again later.",
  price_deviation: "The exchange rate changed. Please request a new quote.",
  sera_rate_limited: "Too many conversion requests right now. Please wait a moment and try again.",
  sera_unavailable: SERA_SERVICE_UNAVAILABLE_MESSAGE,
  sera_fx_unavailable: SERA_SERVICE_UNAVAILABLE_MESSAGE,
  allowance_insufficient: "Please approve the currency in your wallet and try again.",
  insufficient_equity: "There isn't enough available balance for this conversion. Please check your balance.",
  intent_deadline_expired: "This quote expired. Please request a new quote.",
  slippage_exceeded: "The exchange rate changed. Please request a new quote.",
  stp_blocked: "This conversion couldn't be completed. Please try another amount or currency.",
  quote_stale: "This quote expired. Please request a new quote.",
  transient_settlement_failure: SERA_SERVICE_UNAVAILABLE_MESSAGE,
  settlement_failed: "We couldn't confirm this payment. Please check its status before trying again.",
  payment_attempt_in_progress: "A payment for this checkout is already in progress. Please wait for its status.",
  previous_payment_pending: "A previous payment is still pending. Please wait for its status.",
  payment_already_submitted: "This payment was already submitted. Please check its status.",
  payment_attempt_stale: "This payment attempt has expired. Please start again.",
  canceled: "This payment was canceled.",
} as const;

export type SeraPublicErrorCode = keyof typeof PUBLIC_ERROR_MESSAGES;

const CODE_ALIASES: Readonly<Record<string, SeraPublicErrorCode>> = {
  pair_inactive: "no_liquidity",
  rate_limited: "sera_rate_limited",
  too_many_requests: "sera_rate_limited",
  sera_connection_error: "sera_unavailable",
  upstream_unavailable: "sera_unavailable",
  quote_timeout: "sera_unavailable",
  internal_error: "sera_unavailable",
  network_error: "sera_unavailable",
  networkerror: "sera_unavailable",
  aborterror: "sera_unavailable",
  timeouterror: "sera_unavailable",
  econnreset: "sera_unavailable",
  econnrefused: "sera_unavailable",
  econnaborted: "sera_unavailable",
  etimedout: "sera_unavailable",
  enotfound: "sera_unavailable",
  eai_again: "sera_unavailable",
  ehostunreach: "sera_unavailable",
  enetunreach: "sera_unavailable",
  epipe: "sera_unavailable",
  und_err_connect_timeout: "sera_unavailable",
  und_err_headers_timeout: "sera_unavailable",
  und_err_body_timeout: "sera_unavailable",
  und_err_socket: "sera_unavailable",
  und_err_aborted: "sera_unavailable",
};

function knownCode(value: unknown): SeraPublicErrorCode | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(PUBLIC_ERROR_MESSAGES, code)) return code as SeraPublicErrorCode;
  return Object.prototype.hasOwnProperty.call(CODE_ALIASES, code) ? CODE_ALIASES[code] : null;
}

/**
 * Recognizes only exact machine codes, never arbitrary provider message text.
 * HTTP statuses belong to callers: in particular, a generic 409 is not stale.
 */
export function getSeraPublicErrorCode(value: unknown): SeraPublicErrorCode | null {
  const visit = (candidate: unknown, depth: number): SeraPublicErrorCode | null => {
    const direct = knownCode(candidate);
    if (direct) return direct;
    if (!candidate || typeof candidate !== "object" || depth >= 5) return null;
    const record = candidate as Record<string, unknown>;
    for (const key of ["errorCode", "error_code", "code", "error", "rejectionCategory", "name"]) {
      const code = knownCode(record[key]);
      if (code) return code;
    }
    for (const key of ["detail", "cause"]) {
      const code = visit(record[key], depth + 1);
      if (code) return code;
    }
    return null;
  };
  return visit(value, 0);
}

/** Unknown/internal failures always receive the same safe general prompt. */
export function getSeraPublicErrorMessage(code: unknown): string {
  const normalized = getSeraPublicErrorCode(code);
  return normalized ? PUBLIC_ERROR_MESSAGES[normalized] : SERA_SERVICE_UNAVAILABLE_MESSAGE;
}
