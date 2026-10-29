import { getStablecoinBySymbol, getStablecoinLogoUrl, type Stablecoin } from "./stablecoins";
import { formatDecimalAmount } from "./decimalInput";
import { getSeraPublicErrorCode, getSeraPublicErrorMessage } from "@shared/sera-errors";

export type SeraCurrency = Stablecoin & {
  source: "sera" | "fallback";
};

export interface RateResult {
  from: string;
  to: string;
  rate: number;
  source: string;
}

const REGION_BY_CURRENCY: Record<string, string> = {
  USD: "Americas",
  CAD: "Americas",
  BRL: "Americas",
  MXN: "Americas",
  ARS: "Americas",
  SGD: "Asia Pacific",
  MYR: "Asia Pacific",
  IDR: "Asia Pacific",
  JPY: "Asia Pacific",
  THB: "Asia Pacific",
  KRW: "Asia Pacific",
  CNY: "Asia Pacific",
  CNH: "Asia Pacific",
  HKD: "Asia Pacific",
  AUD: "Asia Pacific",
  NZD: "Asia Pacific",
  PHP: "Asia Pacific",
  EUR: "Europe",
  GBP: "Europe",
  CHF: "Europe",
  TRY: "Europe",
  RUB: "Europe",
  ZAR: "Africa & Middle East",
  NGN: "Africa & Middle East",
};

const ICON_BY_CURRENCY: Record<string, string> = {
  USD: "US",
  CAD: "CA",
  BRL: "BR",
  MXN: "MX",
  ARS: "AR",
  SGD: "SG",
  MYR: "MY",
  IDR: "ID",
  JPY: "JP",
  THB: "TH",
  KRW: "KR",
  CNY: "CN",
  CNH: "CN",
  HKD: "HK",
  AUD: "AU",
  NZD: "NZ",
  PHP: "PH",
  EUR: "EU",
  GBP: "GB",
  CHF: "CH",
  TRY: "TR",
  RUB: "RU",
  ZAR: "ZA",
  NGN: "NG",
};

type SeraTokenPayload = {
  symbol: string;
  currency?: string;
  decimals?: number;
  address?: string;
  name?: string;
  icon?: string;
  logo?: string;
  logoUri?: string;
  logo_uri?: string;
  image?: string;
  min_trade_amount?: string;
  walletRecognition?: "universal" | "detected" | "unlisted" | "unknown";
  walletScanPayable?: boolean;
  verified?: boolean;
  onChainSymbol?: string;
};

function buildCurrency(token: SeraTokenPayload): SeraCurrency {
  const symbol = String(token.symbol || "").toUpperCase();
  const currency = String(token.currency || symbol).toUpperCase();
  const existing = getStablecoinBySymbol(symbol);
  const logoUri = token.logoUri || token.logo_uri || token.logo || token.image || (/^https?:\/\//.test(token.icon || "") ? token.icon : undefined) || getStablecoinLogoUrl(symbol);
  const icon = token.icon && !/^https?:\/\//.test(token.icon) ? token.icon : existing?.icon || ICON_BY_CURRENCY[currency] || currency.slice(0, 2);
  // The contract address and decimals MUST come from the live Sera registry for
  // the active chain. The local stablecoins.ts table holds Sepolia addresses and
  // hardcodes `decimals: 6` for every entry, while mainnet carries 18-decimal
  // tokens (JPYC, BRZ, CADC, EURE, ZARP …) and 2-decimal tokens (EURS, IDRT).
  // Falling back to it would build a payment URI against the wrong chain's
  // contract, or off by a factor of 10^12. Only cosmetic fields may fall back.
  const contractAddress = String(token.address);
  const decimals = Number(token.decimals);
  const parsedMin = Number(token.min_trade_amount);
  const minTradeAmount = Number.isFinite(parsedMin) && parsedMin > 0 ? parsedMin : undefined;
  const walletRecognition = token.walletRecognition;
  const walletScanPayable = token.walletScanPayable;
  // Carried through so the QR screen can state plainly that this contract was
  // checked on-chain — the reassurance a customer needs when their wallet
  // cannot name the token itself.
  const verified = token.verified === true;
  const onChainSymbol = token.onChainSymbol;
  if (existing) {
    return {
      ...existing,
      name: token.name || existing.name,
      currency,
      contractAddress,
      decimals,
      icon,
      logoUri,
      minTradeAmount,
      walletRecognition,
      walletScanPayable,
      verified,
      onChainSymbol,
      source: "sera",
    };
  }
  return {
    symbol,
    name: token.name || `${currency} Stablecoin`,
    currency,
    contractAddress,
    decimals,
    icon,
    logoUri,
    region: REGION_BY_CURRENCY[currency] || "Other",
    minTradeAmount,
    walletRecognition,
    walletScanPayable,
    verified,
    onChainSymbol,
    source: "sera",
  };
}

/**
 * Currencies merchants actually reach for, pinned above the long tail.
 *
 * Sera's registry carries 40 tokens across 22 currencies, most of which a given
 * merchant will never touch. Sorting purely alphabetically (or by region) buried
 * the everyday ones behind cNGN, ZARP and BRLV. Everything not listed here still
 * appears, alphabetically, straight after.
 */
const COMMON_SYMBOLS = ["USDC", "USDT", "XSGD", "MYRT", "IDRT"];

function compareCurrencies(a: SeraCurrency, b: SeraCurrency): number {
  const aRank = COMMON_SYMBOLS.indexOf(a.symbol);
  const bRank = COMMON_SYMBOLS.indexOf(b.symbol);
  if (aRank !== -1 && bRank !== -1) return aRank - bRank;
  if (aRank !== -1) return -1;
  if (bRank !== -1) return 1;
  return a.symbol.localeCompare(b.symbol);
}

export async function loadSeraCurrencies(chainId?: number): Promise<SeraCurrency[]> {
  const params = new URLSearchParams();
  if (chainId) params.set("chainId", String(chainId));
  const response = await fetch(`/api/sera/tokens${params.size ? `?${params.toString()}` : ""}`);
  const data = await response.json().catch(() => ({})) as { tokens?: SeraTokenPayload[]; error?: string; errorCode?: string };
  if (!response.ok) {
    const errorCode = getSeraPublicErrorCode(data) ?? "sera_unavailable";
    throw Object.assign(new Error(getSeraPublicErrorMessage(errorCode)), { errorCode, status: response.status });
  }
  const tokens = Array.isArray(data.tokens) ? data.tokens : [];
  const bySymbol = new Map<string, SeraCurrency>();
  for (const token of tokens) {
    const symbol = String(token.symbol || "").toUpperCase();
    if (!symbol || !token.address || !/^0x[0-9a-fA-F]{40}$/.test(token.address)) continue;
    // Drop any token whose decimals Sera did not report. Guessing them would
    // silently scale the on-chain amount in a payment URI by orders of magnitude.
    const decimals = Number(token.decimals);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) continue;
    bySymbol.set(symbol, buildCurrency(token));
  }
  if (bySymbol.size === 0) throw new Error("Sera returned an empty token registry");
  return Array.from(bySymbol.values()).sort(compareCurrencies);
}

export async function getCurrencyRate(from: string, to: string, chainId?: number): Promise<RateResult> {
  const source = from.toUpperCase();
  const target = to.toUpperCase();
  if (source === target) return { from: source, to: target, rate: 1, source: "identity" };
  const params = new URLSearchParams({ from: source, to: target });
  if (chainId) params.set("chainId", String(chainId));
  const response = await fetch(`/api/rates?${params.toString()}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !Number.isFinite(Number(data.rate)) || Number(data.rate) <= 0) {
    const errorCode = getSeraPublicErrorCode(data) ?? "sera_unavailable";
    throw Object.assign(new Error(getSeraPublicErrorMessage(errorCode)), { errorCode, status: response.status });
  }
  return { from: source, to: target, rate: Number(data.rate), source: String(data.source || "sera") };
}

export interface ConversionMinimum {
  /** Smallest amount of this token Sera will accept as the input of a trade. */
  amount: number;
  symbol: string;
}

/**
 * Sera's floor for the token the customer sends, read from the live registry.
 *
 * A conversion is a Sera trade, and Sera publishes a per-token `min_trade_amount`
 * in GET /tokens that it refuses to trade below — the same figure the server
 * pre-flights before requesting a swap quote (the `amount_below_min` branch in
 * server/payment-routes.ts). It differs per token and moves with the registry,
 * so it is always read from there, never written down here.
 *
 * Returns null when the token carries no minimum, or when the registry entry
 * has not loaded yet. Callers must read that as "no minimum known" and let the
 * amount through rather than inventing a floor of their own.
 */
export function getConversionMinimum(coin: Stablecoin | null | undefined): ConversionMinimum | null {
  if (!coin) return null;
  const amount = Number(coin.minTradeAmount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return { amount, symbol: coin.symbol };
}

export function conversionMinimumMessage(minimum: ConversionMinimum): string {
  const figure = minimum.amount.toLocaleString(undefined, { maximumFractionDigits: 6 });
  return `Minimum amount for this conversion is ${figure} ${minimum.symbol}.`;
}

export function isBelowConversionMinimum(payAmount: string | number | null | undefined, minimum: ConversionMinimum | null): boolean {
  if (!minimum) return false;
  const value = Number(payAmount);
  return Number.isFinite(value) && value > 0 && value < minimum.amount;
}

/**
 * Lifts a pay amount to Sera's floor and re-prices the receive side from the
 * same rate.
 *
 * Both halves have to move together. Raising what the customer pays from
 * 15,000 to 200,000 IDRT while still telling the merchant they receive 1 USDT
 * would understate the settlement more than tenfold — the receive figure only
 * means anything as the rate-converted twin of the pay figure.
 *
 * Returns null when nothing needs to change, so callers can leave their own
 * state untouched.
 */
export function applyConversionMinimum(
  payAmount: string,
  rate: number | null | undefined,
  minimum: ConversionMinimum | null,
): { payAmount: string; receiveAmount: string } | null {
  if (!minimum || !Number.isFinite(Number(rate)) || Number(rate) <= 0) return null;
  if (!isBelowConversionMinimum(payAmount, minimum)) return null;
  return {
    payAmount: formatDecimalAmount(minimum.amount),
    receiveAmount: formatDecimalAmount(minimum.amount / Number(rate)),
  };
}

export function convertAmount(amount: string | number, rate: number): string {
  const value = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(value)) return "0.00";
  const converted = value * rate;
  if (converted >= 1000) return converted.toFixed(2);
  return converted.toFixed(6).replace(/0+$/, "").replace(/\.$/, ".00");
}

export async function convertPrice(amount: string | number, from: string, to: string, chainId?: number): Promise<{ amount: string; rate: number }> {
  const { rate } = await getCurrencyRate(from, to, chainId);
  return { amount: convertAmount(amount, rate), rate };
}

export function groupCurrenciesByRegion(currencies: SeraCurrency[]): Record<string, SeraCurrency[]> {
  return currencies.reduce<Record<string, SeraCurrency[]>>((groups, coin) => {
    const region = coin.region || "Other";
    groups[region] = groups[region] || [];
    groups[region].push(coin);
    return groups;
  }, {});
}
