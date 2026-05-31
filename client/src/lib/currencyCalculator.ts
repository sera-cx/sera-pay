import { STABLECOINS, getStablecoinBySymbol, getStablecoinLogoUrl, type Stablecoin } from "./stablecoins";

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
};

function buildCurrency(token: SeraTokenPayload): SeraCurrency {
  const symbol = String(token.symbol || "").toUpperCase();
  const currency = String(token.currency || symbol).toUpperCase();
  const existing = getStablecoinBySymbol(symbol);
  const logoUri = token.logoUri || token.logo_uri || token.logo || token.image || (/^https?:\/\//.test(token.icon || "") ? token.icon : undefined) || getStablecoinLogoUrl(symbol);
  const icon = token.icon && !/^https?:\/\//.test(token.icon) ? token.icon : existing?.icon || ICON_BY_CURRENCY[currency] || currency.slice(0, 2);
  if (existing) {
    return {
      ...existing,
      name: token.name || existing.name,
      currency,
      contractAddress: token.address || existing.contractAddress,
      decimals: Number(token.decimals) || existing.decimals,
      icon,
      logoUri,
      source: "sera",
    };
  }
  return {
    symbol,
    name: token.name || `${currency} Stablecoin`,
    currency,
    contractAddress: token.address || "",
    decimals: Number(token.decimals) || 6,
    icon,
    logoUri,
    region: REGION_BY_CURRENCY[currency] || "Other",
    source: "sera",
  };
}

export async function loadSeraCurrencies(): Promise<SeraCurrency[]> {
  try {
    const response = await fetch("/api/sera/tokens");
    if (!response.ok) throw new Error("Unable to load Sera currencies");
    const data = await response.json() as { tokens?: SeraTokenPayload[] };
    const tokens = Array.isArray(data.tokens) ? data.tokens : [];
    const bySymbol = new Map<string, SeraCurrency>();
    for (const token of tokens) {
      const symbol = String(token.symbol || "").toUpperCase();
      if (!symbol) continue;
      bySymbol.set(symbol, buildCurrency(token));
    }
    if (bySymbol.size === 0) throw new Error("No Sera currencies returned");
    return Array.from(bySymbol.values()).sort((a, b) => a.region.localeCompare(b.region) || a.symbol.localeCompare(b.symbol));
  } catch {
    return STABLECOINS.map((coin) => ({ ...coin, source: "fallback" as const }));
  }
}

export async function getCurrencyRate(from: string, to: string): Promise<RateResult> {
  const source = from.toUpperCase();
  const target = to.toUpperCase();
  if (source === target) return { from: source, to: target, rate: 1, source: "identity" };
  const response = await fetch(`/api/rates?from=${encodeURIComponent(source)}&to=${encodeURIComponent(target)}`);
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

export async function convertPrice(amount: string | number, from: string, to: string): Promise<{ amount: string; rate: number }> {
  const { rate } = await getCurrencyRate(from, to);
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