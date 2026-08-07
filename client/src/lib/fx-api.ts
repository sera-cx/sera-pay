/**
 * FX API Client
 * Client-side functions to interact with FX rate endpoints
 */

const API_BASE = '/api/fx';

export interface FxRate {
  pair: string;
  rate: string;
  as_of: number;
  rate_24h_ago: string | null;
  as_of_24h_ago: number | null;
  change_pct: string | null;
}

export interface FxQuote {
  from_currency: string;
  to_currency: string;
  amount: string;
  estimated_amount: string;
  rate: string;
  path: string[];
  fee_bps: number;
}

export interface CurrencyInfo {
  code: string;
  name: string;
  symbol: string;
  stablecoins: string[];
}

export interface LocationInfo {
  country: string;
  countryCode: string;
  currency: string;
  city?: string;
  region?: string;
  ip: string;
}

/**
 * Get FX rate between two currencies
 */
export async function getFxRate(base: string, quote: string): Promise<FxRate | null> {
  try {
    const response = await fetch(`${API_BASE}/rate?base=${base}&quote=${quote}`);
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    console.error('[FX API] Failed to get FX rate:', error);
    return null;
  }
}

/**
 * Get quote for currency conversion
 */
export async function getFxQuote(from: string, to: string, amount: string): Promise<FxQuote | null> {
  try {
    const response = await fetch(`${API_BASE}/quote?from=${from}&to=${to}&amount=${amount}`);
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    console.error('[FX API] Failed to get FX quote:', error);
    return null;
  }
}

/**
 * Get list of supported currencies
 */
export async function getSupportedCurrencies(): Promise<CurrencyInfo[]> {
  try {
    const response = await fetch(`${API_BASE}/currencies`);
    if (!response.ok) return [];
    const data = await response.json();
    return data.currencies || [];
  } catch (error) {
    console.error('[FX API] Failed to get currencies:', error);
    return [];
  }
}

/**
 * Get information about a specific currency
 */
export async function getCurrencyInfo(code: string): Promise<CurrencyInfo | null> {
  try {
    const response = await fetch(`${API_BASE}/currency/${code}`);
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    console.error('[FX API] Failed to get currency info:', error);
    return null;
  }
}

/**
 * Detect customer location and currency from IP
 */
export async function detectLocation(): Promise<LocationInfo> {
  try {
    const response = await fetch(`${API_BASE}/location`);
    if (!response.ok) {
      return {
        country: 'United States',
        countryCode: 'US',
        currency: 'USD',
        ip: '127.0.0.1',
      };
    }
    return await response.json();
  } catch (error) {
    console.error('[FX API] Failed to detect location:', error);
    return {
      country: 'United States',
      countryCode: 'US',
      currency: 'USD',
      ip: '127.0.0.1',
    };
  }
}

/**
 * Detect customer currency from IP
 */
export async function detectCurrency(): Promise<string> {
  try {
    const response = await fetch(`${API_BASE}/detect-currency`);
    if (!response.ok) return 'USD';
    const data = await response.json();
    return data.currency || 'USD';
  } catch (error) {
    console.error('[FX API] Failed to detect currency:', error);
    return 'USD';
  }
}

/**
 * Get stablecoins available for a currency
 */
export async function getStablecoinsForCurrency(currency: string): Promise<string[]> {
  try {
    const response = await fetch(`${API_BASE}/stablecoins/${currency}`);
    if (!response.ok) return [];
    const data = await response.json();
    return data.stablecoins || [];
  } catch (error) {
    console.error('[FX API] Failed to get stablecoins:', error);
    return [];
  }
}

/**
 * Format currency amount with symbol
 */
export function formatCurrencyAmount(amount: number, currencyCode: string): string {
  const currencyMap: Record<string, string> = {
    USD: '$',
    EUR: '€',
    GBP: '£',
    JPY: '¥',
    SGD: 'S$',
    MYR: 'RM',
    IDR: 'Rp',
    BRL: 'R$',
    MXN: 'MX$',
    CAD: 'C$',
    AUD: 'A$',
    INR: '₹',
    CNY: '¥',
    KRW: '₩',
    PHP: '₱',
    THB: '฿',
    VND: '₫',
    ZAR: 'R',
    NGN: '₦',
    EGP: '£',
    AED: 'د.إ',
    SAR: '﷼',
  };

  const symbol = currencyMap[currencyCode] || currencyCode;
  return `${symbol}${amount.toFixed(2)}`;
}

/**
 * Calculate converted amount
 */
export function calculateConversion(amount: number, rate: number): number {
  return amount * rate;
}
