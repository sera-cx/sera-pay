import { MAX_PAYMENT_DECIMALS } from "../shared/decimal-input";
import { MAX_CHECKOUT_MICRO_UNITS } from "../shared/payment-qr";
import { SeraQuoteValidationError } from "./sera-swap-quote";

export function assertQrTokenDecimals(tokenDecimals: number): void {
  if (!Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 255) {
    throw new SeraQuoteValidationError("invalid_config", "Sera returned invalid token decimals");
  }
}

/** Multiply without losing amount precision, rounding up to a payable unit. */
export function estimateQrPayAmount(amount: string, rate: number, tokenDecimals: number): string {
  assertQrTokenDecimals(tokenDecimals);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new SeraQuoteValidationError("invalid_quote", "Sera returned an invalid exchange rate");
  }
  const decimals = Math.min(MAX_PAYMENT_DECIMALS, tokenDecimals);
  const [whole, fraction = ""] = amount.split(".");
  const [rateSignificand, exponent = "0"] = String(rate).split("e");
  const [rateWhole, rateFraction = ""] = rateSignificand.split(".");
  const power = Number(exponent) - rateFraction.length - fraction.length + decimals;
  const product = BigInt(whole + fraction) * BigInt(rateWhole + rateFraction);
  const divisor = power < 0 ? 10n ** BigInt(-power) : 1n;
  const numerator = power > 0 ? product * 10n ** BigInt(power) : product;
  const raw = (numerator + divisor - 1n) / divisor;
  const scale = 10n ** BigInt(decimals);
  const integer = raw / scale;
  if (raw * 10n ** BigInt(MAX_PAYMENT_DECIMALS - decimals) > MAX_CHECKOUT_MICRO_UNITS) {
    throw new SeraQuoteValidationError("invalid_request", "Converted amount exceeds the supported payment amount");
  }
  const fractional = (raw % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fractional ? `${integer}.${fractional}` : integer.toString();
}
