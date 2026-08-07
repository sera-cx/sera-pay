/**
 * Sera FX Service - Multi-currency settlement integration
 * Interfaces with Sera MCP for FX rates, quotes, and conversions
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

// Currency code to country mapping for location detection
export const CURRENCY_COUNTRY_MAP: Record<string, string[]> = {
  'USD': ['US', 'UM', 'BQ', 'EC', 'SV', 'GU', 'MH', 'FM', 'MP', 'PW', 'PR', 'TL', 'AS', 'VI'],
  'EUR': ['AT', 'BE', 'CY', 'EE', 'FI', 'FR', 'DE', 'GR', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PT', 'SK', 'SI', 'ES', 'VA', 'ME', 'XK'],
  'GBP': ['GB', 'IM', 'GG', 'JE'],
  'JPY': ['JP'],
  'SGD': ['SG'],
  'MYR': ['MY'],
  'IDR': ['ID'],
  'BRL': ['BR'],
  'MXN': ['MX'],
  'CAD': ['CA'],
  'AUD': ['AU', 'NF', 'NR', 'CCK', 'CX', 'HM', 'KI', 'NR', 'NU', 'NZ', 'PN', 'TK', 'TO', 'TV', 'WF'],
  'INR': ['IN'],
  'CNY': ['CN', 'HK', 'MO'],
  'KRW': ['KR'],
  'PHP': ['PH'],
  'THB': ['TH'],
  'VND': ['VN'],
  'ZAR': ['ZA'],
  'NGN': ['NG'],
  'EGP': ['EG'],
  'AED': ['AE'],
  'SAR': ['SA'],
};

// Supported currencies with their stablecoins
export const SUPPORTED_CURRENCIES: Record<string, CurrencyInfo> = {
  'USD': { code: 'USD', name: 'US Dollar', symbol: '$', stablecoins: ['USDC', 'USDT', 'DAI', 'USDD'] },
  'EUR': { code: 'EUR', name: 'Euro', symbol: '€', stablecoins: ['EURC', 'EURT'] },
  'GBP': { code: 'GBP', name: 'British Pound', symbol: '£', stablecoins: ['GBPT'] },
  'JPY': { code: 'JPY', name: 'Japanese Yen', symbol: '¥', stablecoins: ['JPYC'] },
  'SGD': { code: 'SGD', name: 'Singapore Dollar', symbol: 'S$', stablecoins: ['XSGD', 'SGD'] },
  'MYR': { code: 'MYR', name: 'Malaysian Ringgit', symbol: 'RM', stablecoins: ['MYR'] },
  'IDR': { code: 'IDR', name: 'Indonesian Rupiah', symbol: 'Rp', stablecoins: ['IDRT', 'IDR'] },
  'BRL': { code: 'BRL', name: 'Brazilian Real', symbol: 'R$', stablecoins: ['BRLT', 'BRL'] },
  'MXN': { code: 'MXN', name: 'Mexican Peso', symbol: '$', stablecoins: ['MXNT', 'MXN'] },
  'CAD': { code: 'CAD', name: 'Canadian Dollar', symbol: 'C$', stablecoins: ['CADT', 'USDC'] },
  'AUD': { code: 'AUD', name: 'Australian Dollar', symbol: 'A$', stablecoins: ['AUDT', 'USDC'] },
  'INR': { code: 'INR', name: 'Indian Rupee', symbol: '₹', stablecoins: ['INRT'] },
  'CNY': { code: 'CNY', name: 'Chinese Yuan', symbol: '¥', stablecoins: ['CNHT'] },
  'KRW': { code: 'KRW', name: 'South Korean Won', symbol: '₩', stablecoins: ['KRWT'] },
  'PHP': { code: 'PHP', name: 'Philippine Peso', symbol: '₱', stablecoins: ['PHPT'] },
  'THB': { code: 'THB', name: 'Thai Baht', symbol: '฿', stablecoins: ['THBT'] },
  'VND': { code: 'VND', name: 'Vietnamese Dong', symbol: '₫', stablecoins: ['VNDT'] },
  'ZAR': { code: 'ZAR', name: 'South African Rand', symbol: 'R', stablecoins: ['ZART'] },
  'NGN': { code: 'NGN', name: 'Nigerian Naira', symbol: '₦', stablecoins: ['NGNT'] },
  'EGP': { code: 'EGP', name: 'Egyptian Pound', symbol: '£', stablecoins: ['EGPT'] },
  'AED': { code: 'AED', name: 'UAE Dirham', symbol: 'د.إ', stablecoins: ['AEDT'] },
  'SAR': { code: 'SAR', name: 'Saudi Riyal', symbol: '﷼', stablecoins: ['SART'] },
};

class SeraFxService {
  private mcpPath: string;

  constructor(mockMode: boolean = false) {
    this.mcpPath = join(__dirname, '../lib/sera-mcp/dist/index.js');
  }

  private isMockMode(): boolean {
    return process.env.SERA_MOCK_MODE === 'true';
  }

  /**
   * Execute a Sera MCP command
   */
  private async executeMcpCommand(args: string[]): Promise<any> {
    return new Promise((resolve, reject) => {
      const mcp = spawn('node', [this.mcpPath, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          SERA_NETWORK: process.env.SERA_NETWORK || 'mainnet',
          POLICY_PRESET: process.env.POLICY_PRESET || 'standard',
        },
      });

      let stdout = '';
      let stderr = '';

      mcp.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      mcp.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      mcp.on('close', (code) => {
        if (code === 0) {
          try {
            const output = stdout.trim();
            if (output) {
              resolve(JSON.parse(output));
            } else {
              resolve(null);
            }
          } catch (error) {
            // If not JSON, return raw output
            resolve(stdout.trim());
          }
        } else {
          reject(new Error(`Sera MCP command failed: ${stderr || stdout}`));
        }
      });

      mcp.on('error', (error) => {
        reject(new Error(`Failed to execute Sera MCP: ${error.message}`));
      });
    });
  }

  /**
   * Get FX rate between two currencies
   */
  async getFxRate(baseCurrency: string, quoteCurrency: string): Promise<FxRate | null> {
    if (this.isMockMode()) {
      return this.getMockFxRate(baseCurrency, quoteCurrency);
    }
    try {
      const result = await this.executeMcpCommand(['fx', baseCurrency.toUpperCase(), quoteCurrency.toUpperCase()]);
      return result;
    } catch (error) {
      console.error('[SeraFxService] Failed to get FX rate:', error);
      return this.getMockFxRate(baseCurrency, quoteCurrency); // Fallback to mock
    }
  }

  /**
   * Get mock FX rate for demo purposes
   */
  private getMockFxRate(baseCurrency: string, quoteCurrency: string): FxRate {
    const mockRates: Record<string, number> = {
      'USD/MYR': 4.65,
      'MYR/USD': 0.215,
      'USD/SGD': 1.34,
      'SGD/USD': 0.745,
      'USD/EUR': 0.92,
      'EUR/USD': 1.09,
      'USD/GBP': 0.79,
      'GBP/USD': 1.27,
      'USD/JPY': 157.5,
      'JPY/USD': 0.00635,
      'USD/IDR': 15800,
      'IDR/USD': 0.000063,
      'USD/BRL': 5.0,
      'BRL/USD': 0.20,
      'USD/MXN': 17.0,
      'MXN/USD': 0.059,
    };

    const pair = `${baseCurrency.toUpperCase()}/${quoteCurrency.toUpperCase()}`;
    const rate = mockRates[pair] || 1.0;

    return {
      pair,
      rate: rate.toString(),
      as_of: Date.now(),
      rate_24h_ago: (rate * 0.998).toString(),
      as_of_24h_ago: Date.now() - 86400000,
      change_pct: '0.20',
    };
  }

  /**
   * Get quote for currency conversion
   */
  async getFxQuote(fromCurrency: string, toCurrency: string, amount: string): Promise<FxQuote | null> {
    if (this.isMockMode()) {
      return this.getMockFxQuote(fromCurrency, toCurrency, amount);
    }
    try {
      const result = await this.executeMcpCommand([
        'quote',
        fromCurrency.toUpperCase(),
        toCurrency.toUpperCase(),
        amount
      ]);
      return result;
    } catch (error) {
      console.error('[SeraFxService] Failed to get FX quote:', error);
      return this.getMockFxQuote(fromCurrency, toCurrency, amount);
    }
  }

  /**
   * Get mock FX quote for demo purposes
   */
  private getMockFxQuote(fromCurrency: string, toCurrency: string, amount: string): FxQuote {
    const rate = this.getMockFxRate(fromCurrency, toCurrency);
    const amountNum = parseFloat(amount);
    const estimatedAmount = (amountNum * parseFloat(rate.rate)).toFixed(18);

    return {
      from_currency: fromCurrency.toUpperCase(),
      to_currency: toCurrency.toUpperCase(),
      amount,
      estimated_amount: estimatedAmount,
      rate: rate.rate,
      path: [fromCurrency.toUpperCase(), toCurrency.toUpperCase()],
      fee_bps: 5,
    };
  }

  /**
   * Find best deals across currency pairs
   */
  async findDeals(minBps: number = 25): Promise<any[]> {
    if (this.isMockMode()) {
      return this.getMockDeals(minBps);
    }
    try {
      const result = await this.executeMcpCommand(['deals', '--min-bps', String(minBps), '--json']);
      return Array.isArray(result) ? result : [];
    } catch (error) {
      console.error('[SeraFxService] Failed to find deals:', error);
      return this.getMockDeals(minBps);
    }
  }

  /**
   * Get mock deals for demo purposes
   */
  private getMockDeals(minBps: number): any[] {
    return [
      {
        pair: 'USD/MYR',
        spread_bps: 30,
        mid: 4.65,
        best_bid: 4.6485,
        best_ask: 4.6515,
      },
      {
        pair: 'USD/SGD',
        spread_bps: 25,
        mid: 1.34,
        best_bid: 1.3398,
        best_ask: 1.3402,
      },
      {
        pair: 'EUR/USD',
        spread_bps: 20,
        mid: 1.09,
        best_bid: 1.0898,
        best_ask: 1.0902,
      },
    ].filter(deal => deal.spread_bps >= minBps);
  }

  /**
   * Get multi-source mid price for a currency pair
   */
  async getMultiSourceMid(baseCurrency: string, quoteCurrency: string): Promise<number | null> {
    if (this.isMockMode()) {
      const rate = this.getMockFxRate(baseCurrency, quoteCurrency);
      return parseFloat(rate.rate);
    }
    try {
      const result = await this.executeMcpCommand([
        'multi-source-mid',
        baseCurrency.toUpperCase(),
        quoteCurrency.toUpperCase()
      ]);
      return result?.mid ? parseFloat(result.mid) : null;
    } catch (error) {
      console.error('[SeraFxService] Failed to get multi-source mid:', error);
      const rate = this.getMockFxRate(baseCurrency, quoteCurrency);
      return parseFloat(rate.rate);
    }
  }

  /**
   * Get spread radar for multiple currencies
   */
  async getSpreadRadar(currencies: string[]): Promise<any[]> {
    if (this.isMockMode()) {
      return this.getMockSpreadRadar(currencies);
    }
    try {
      const result = await this.executeMcpCommand([
        'spread-radar',
        currencies.join(',')
      ]);
      return Array.isArray(result) ? result : [];
    } catch (error) {
      console.error('[SeraFxService] Failed to get spread radar:', error);
      return this.getMockSpreadRadar(currencies);
    }
  }

  /**
   * Get mock spread radar for demo purposes
   */
  private getMockSpreadRadar(currencies: string[]): any[] {
    return currencies.map(currency => ({
      currency: currency.toUpperCase(),
      spread_bps: Math.floor(Math.random() * 50) + 10,
      mid: Math.random() * 10 + 1,
    }));
  }

  /**
   * Detect customer currency from country code
   */
  detectCurrencyFromCountry(countryCode: string): string | null {
    const upperCountry = countryCode.toUpperCase();
    for (const [currency, countries] of Object.entries(CURRENCY_COUNTRY_MAP)) {
      if (countries.includes(upperCountry)) {
        return currency;
      }
    }
    return null; // Default to USD if not found
  }

  /**
   * Get supported currencies list
   */
  getSupportedCurrencies(): CurrencyInfo[] {
    return Object.values(SUPPORTED_CURRENCIES);
  }

  /**
   * Get currency info by code
   */
  getCurrencyInfo(currencyCode: string): CurrencyInfo | null {
    return SUPPORTED_CURRENCIES[currencyCode.toUpperCase()] || null;
  }

  /**
   * Check if currency is supported
   */
  isCurrencySupported(currencyCode: string): boolean {
    return currencyCode.toUpperCase() in SUPPORTED_CURRENCIES;
  }

  /**
   * Get stablecoins for a currency
   */
  getStablecoinsForCurrency(currencyCode: string): string[] {
    const info = this.getCurrencyInfo(currencyCode);
    return info?.stablecoins || [];
  }

  /**
   * Calculate converted amount
   */
  calculateConversion(amount: number, fromCurrency: string, toCurrency: string, rate: number): number {
    return amount * rate;
  }

  /**
   * Format currency amount
   */
  formatCurrencyAmount(amount: number, currencyCode: string): string {
    const info = this.getCurrencyInfo(currencyCode);
    const symbol = info?.symbol || currencyCode;
    return `${symbol}${amount.toFixed(2)}`;
  }
}

// Export singleton instance
export const seraFxService = new SeraFxService();
