import { getStablecoinBySymbol, getStablecoinLogoUrl, type Stablecoin } from "./stablecoins";

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
    source: "sera",
  };
}

export async function loadSeraCurrencies(chainId?: number): Promise<SeraCurrency[]> {
  const params = new URLSearchParams();
  if (chainId) params.set("chainId", String(chainId));
  const response = await fetch(`/api/sera/tokens${params.size ? `?${params.toString()}` : ""}`);
  const data = await response.json().catch(() => ({})) as { tokens?: SeraTokenPayload[]; error?: string };
  if (!response.ok) throw new Error(data.error || "Unable to load Sera currencies");
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
  return Array.from(bySymbol.values()).sort((a, b) => a.region.localeCompare(b.region) || a.symbol.localeCompare(b.symbol));
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
    throw new Error(data.detail || data.error || `Unable to convert ${source} to ${target}`);
  }
  return { from: source, to: target, rate: Number(data.rate), source: String(data.source || "sera") };
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
