/**
 * Server-side binding between a payment request and what it pays for.
 *
 * /api/payment/create and /api/payment/swap/quote both accept the amount and
 * the paymentIntentId / orderId from the payer's browser. Nothing used to
 * check one against the other: a checkout link for a 1,000 XSGD intent could
 * be re-encoded (the payload is unsigned) with amount 0.01, paid, and the
 * intent would still be marked paid. These helpers make the stored intent or
 * menu order authoritative: existence, ownership, life-cycle state, currency
 * and amount are all re-verified on the server before a payable transaction
 * is recorded.
 */

import type { MenuOrder, PaymentIntent } from "../drizzle/schema";

export class PaymentBindingError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "PaymentBindingError";
  }
}

/** Menu orders that mix item currencies are totalled into one amount paid in the merchant's receive coin. */
const MIXED_COIN_MARKER = "MIXED";

/** Statuses from which a fresh payment attempt is legitimate (retry after a failed attempt, re-opened checkout). */
const PAYABLE_INTENT_STATUSES = new Set(["created", "open", "failed"]);
const PAYABLE_ORDER_STATUSES = new Set(["created", "payment_pending", "failed"]);

/**
 * Decimal equality at the 6dp scale every payment amount is stored at.
 * "10", "10.0" and "10.000000" are the same money; float parsing is exact
 * here because micro-unit magnitudes stay far inside Number's safe range.
 */
export function sameMicroAmount(a: string, b: string): boolean {
  const aMicro = toMicroAmount(a);
  return aMicro !== null && aMicro === toMicroAmount(b);
}

/** Whether `amount` covers `required`, compared at the 6dp storage scale. */
export function amountAtLeast(amount: string, required: string): boolean {
  const amountMicro = toMicroAmount(amount);
  const requiredMicro = toMicroAmount(required);
  return amountMicro !== null && requiredMicro !== null && amountMicro >= requiredMicro;
}

function toMicroAmount(value: string): number | null {
  const normalized = String(value ?? "").replace(/,/g, "").trim();
  /*
    Accept any number of fractional digits, then compare at the 6dp scale.

    The old form capped the fraction at six digits, which quietly broke every
    payment-intent binding: payment_intents.amount is numeric(36,18), and
    node-postgres returns numeric as the text Postgres emits — so a stored
    "100.50" reads back as "100.500000000000000000". Eighteen digits failed the
    cap, this returned null, and both comparators short-circuited to false, so
    assertAmountMatchesReference rejected the payment it was meant to authorise.
    Menu orders escaped only because that column is numeric(20,6).

    Digits past the sixth are still not allowed to change the value: anything
    non-zero beyond 6dp is a genuinely different amount and must not silently
    round into a match.
  */
  const match = /^(\d+)(?:\.(\d*))?$/.exec(normalized);
  if (!match) return null;
  const fraction = match[2] ?? "";
  const micros = fraction.slice(0, 6).padEnd(6, "0");
  if (/[^0]/.test(fraction.slice(6))) return null;
  const whole = Number(match[1]);
  const value6 = whole * 1_000_000 + Number(micros);
  return Number.isSafeInteger(value6) ? value6 : null;
}

/**
 * Verifies a payment intent can back the payment being created and returns
 * the amount the merchant must receive. Throws PaymentBindingError on any
 * mismatch; the caller turns that into the right HTTP status.
 */
export function assertPaymentIntentBindable(
  intent: PaymentIntent | undefined | null,
  {
    merchantId,
    receiveCoin,
    receiverAddress,
    chainId,
  }: {
    merchantId: string;
    receiveCoin: string;
    receiverAddress: string;
    chainId: number;
  }
): string {
  if (!intent) throw new PaymentBindingError("Payment intent not found", 404);
  if (intent.merchantId !== merchantId) throw new PaymentBindingError("Payment intent does not belong to this merchant", 403);
  if (!PAYABLE_INTENT_STATUSES.has(intent.status)) {
    if (intent.status === "paid") throw new PaymentBindingError("Payment intent has already been paid", 409);
    throw new PaymentBindingError(`Payment intent is ${intent.status} and can no longer be paid`, 409);
  }
  if (intent.expiresAt && new Date(intent.expiresAt).getTime() < Date.now()) {
    throw new PaymentBindingError("Payment intent has expired", 410);
  }
  if (intent.coin.toUpperCase() !== receiveCoin.toUpperCase()) {
    throw new PaymentBindingError("Payment currency does not match the payment intent", 400);
  }
  if (intent.receiverAddress.toLowerCase() !== receiverAddress.toLowerCase()) {
    throw new PaymentBindingError("Payment receiver does not match the payment intent", 400);
  }
  if (intent.chainId !== chainId) {
    throw new PaymentBindingError("Payment network does not match the payment intent", 400);
  }
  return String(intent.amount);
}

/**
 * Same check for a menu order. Returns the order total the payment must
 * cover. A MIXED order's stored coin is a marker, not a currency — those
 * totals are paid in the merchant's receive coin, passed separately.
 */
export function assertMenuOrderBindable(
  order: MenuOrder | undefined | null,
  { merchantId, receiveCoin, merchantReceiveCoin }: { merchantId: string; receiveCoin: string; merchantReceiveCoin?: string | null }
): string {
  if (!order) throw new PaymentBindingError("Menu order not found", 404);
  if (order.merchantId !== merchantId) throw new PaymentBindingError("Menu order does not belong to this merchant", 403);
  if (!PAYABLE_ORDER_STATUSES.has(order.status)) {
    if (order.status === "paid") throw new PaymentBindingError("This order has already been paid", 409);
    if (order.status === "payment_submitted") throw new PaymentBindingError("A payment for this order is already being confirmed", 409);
    throw new PaymentBindingError(`This order is ${order.status} and can no longer be paid`, 409);
  }
  const expectedCoin = order.coin.toUpperCase() === MIXED_COIN_MARKER
    ? String(merchantReceiveCoin || "").toUpperCase()
    : order.coin.toUpperCase();
  if (expectedCoin && expectedCoin !== receiveCoin.toUpperCase()) {
    throw new PaymentBindingError("Payment currency does not match this order", 400);
  }
  return String(order.amount);
}

/**
 * Amount comparison against the reference returned by the bindable checks.
 * Direct transfers must match exactly — the QR names one amount. Swap
 * settlements must cover at least the reference: quote refreshes can round
 * the customer's input up, never down.
 */
export function assertAmountMatchesReference(
  expected: string,
  required: string,
  { exact, label }: { exact: boolean; label: string }
): void {
  if (exact ? sameMicroAmount(expected, required) : amountAtLeast(expected, required)) return;
  throw new PaymentBindingError(
    exact
      ? `Amount does not match the ${label}`
      : `Amount is less than the ${label}`,
    400,
  );
}
