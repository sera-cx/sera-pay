export const MAX_PAYMENT_DECIMALS = 6;

export function limitDecimalPlaces(value: string, maxDecimals = MAX_PAYMENT_DECIMALS): string {
  const raw = value.replace(/,/g, "").trim();
  if (!raw) return "";

  let next = "";
  let hasDot = false;
  for (const char of raw) {
    if (char >= "0" && char <= "9") {
      next += char;
    } else if (char === "." && !hasDot) {
      next += ".";
      hasDot = true;
    }
  }

  if (!next) return "";
  if (next.startsWith(".")) next = `0${next}`;
  const [wholeRaw, fractionRaw] = next.split(".");
  const whole = wholeRaw.replace(/^0+(?=\d)/, "") || "0";
  if (fractionRaw === undefined) return whole;
  return `${whole}.${fractionRaw.slice(0, maxDecimals)}`;
}

export function normalizeDecimalAmountText(value: string | number | null | undefined, maxDecimals = MAX_PAYMENT_DECIMALS): string {
  const limited = limitDecimalPlaces(String(value ?? ""), maxDecimals).replace(/\.$/, "");
  if (!limited || Number(limited) <= 0 || !Number.isFinite(Number(limited))) return "";
  return limited;
}

export function formatDecimalAmount(value: string | number, maxDecimals = MAX_PAYMENT_DECIMALS): string {
  const num = typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
  if (!Number.isFinite(num)) return "";
  return num.toFixed(maxDecimals).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

/** Group a payment amount without losing decimal precision through Number. */
export function formatDecimalAmountForDisplay(value: string, locales?: Intl.LocalesArgument): string {
  if (!/^\d+(\.\d+)?$/.test(value)) return value;
  return new Intl.NumberFormat(locales, { maximumFractionDigits: MAX_PAYMENT_DECIMALS })
    .format(value as `${number}`);
}
