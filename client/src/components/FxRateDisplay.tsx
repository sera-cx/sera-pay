/**
 * FX Rate Display Component
 * Shows real-time FX rates and conversion information during checkout
 */

import React, { useState, useEffect } from 'react';
import { RefreshCw, Globe, ArrowRight } from 'lucide-react';
import { 
  getFxRate, 
  detectCurrency, 
  formatCurrencyAmount, 
  calculateConversion,
  type FxRate 
} from '@/lib/fx-api';

interface FxRateDisplayProps {
  amount: number;
  fromCurrency: string;
  toCurrency: string;
  onRateChange?: (rate: number | null) => void;
}

export function FxRateDisplay({ 
  amount, 
  fromCurrency, 
  toCurrency, 
  onRateChange 
}: FxRateDisplayProps) {
  const [fxRate, setFxRate] = useState<FxRate | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detectedCurrency, setDetectedCurrency] = useState<string | null>(null);

  const fetchFxRate = async () => {
    setLoading(true);
    setError(null);
    
    try {
      const rate = await getFxRate(fromCurrency, toCurrency);
      setFxRate(rate);
      onRateChange?.(rate ? parseFloat(rate.rate) : null);
    } catch (err) {
      setError('Failed to load FX rate');
      onRateChange?.(null);
    } finally {
      setLoading(false);
    }
  };

  const detectCustomerCurrency = async () => {
    try {
      const currency = await detectCurrency();
      setDetectedCurrency(currency);
    } catch (err) {
      console.error('Failed to detect currency:', err);
    }
  };

  useEffect(() => {
    fetchFxRate();
    detectCustomerCurrency();
  }, [fromCurrency, toCurrency]);

  const convertedAmount = fxRate ? calculateConversion(amount, parseFloat(fxRate.rate)) : null;
  const showConversion = fromCurrency !== toCurrency && convertedAmount !== null;

  return (
    <div className="bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-blue-950 dark:to-indigo-950 rounded-lg p-4 border border-blue-200 dark:border-blue-800">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Globe className="w-4 h-4 text-blue-600 dark:text-blue-400" />
          <span className="text-sm font-medium text-blue-900 dark:text-blue-100">
            Multi-Currency Payment
          </span>
        </div>
        <button
          onClick={fetchFxRate}
          disabled={loading}
          className="p-1 hover:bg-blue-100 dark:hover:bg-blue-900 rounded transition-colors"
          title="Refresh rate"
        >
          <RefreshCw className={`w-4 h-4 text-blue-600 dark:text-blue-400 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Detected Currency */}
      {detectedCurrency && (
        <div className="mb-3 text-xs text-blue-700 dark:text-blue-300">
          <span className="font-medium">Detected currency:</span> {detectedCurrency}
        </div>
      )}

      {/* Error State */}
      {error && (
        <div className="text-sm text-red-600 dark:text-red-400 mb-2">
          {error}
        </div>
      )}

      {/* Loading State */}
      {loading && !fxRate && (
        <div className="text-sm text-blue-600 dark:text-blue-400">
          Loading FX rate...
        </div>
      )}

      {/* FX Rate Display */}
      {fxRate && !loading && (
        <div className="space-y-2">
          {/* Rate Information */}
          <div className="flex items-center justify-between text-sm">
            <span className="text-blue-700 dark:text-blue-300">
              1 {fromCurrency} = {parseFloat(fxRate.rate).toFixed(4)} {toCurrency}
            </span>
            {fxRate.change_pct && (
              <span className={`text-xs font-medium ${
                parseFloat(fxRate.change_pct) >= 0 
                  ? 'text-green-600 dark:text-green-400' 
                  : 'text-red-600 dark:text-red-400'
              }`}>
                {parseFloat(fxRate.change_pct) >= 0 ? '+' : ''}{parseFloat(fxRate.change_pct).toFixed(2)}%
              </span>
            )}
          </div>

          {/* Conversion Preview */}
          {showConversion && (
            <div className="bg-white dark:bg-gray-800 rounded-md p-3 border border-blue-200 dark:border-blue-800">
              <div className="flex items-center justify-between">
                <div className="text-center">
                  <div className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                    {formatCurrencyAmount(amount, fromCurrency)}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">{fromCurrency}</div>
                </div>
                
                <ArrowRight className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                
                <div className="text-center">
                  <div className="text-lg font-semibold text-green-600 dark:text-green-400">
                    {formatCurrencyAmount(convertedAmount, toCurrency)}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">{toCurrency}</div>
                </div>
              </div>
              
              <div className="mt-2 text-xs text-center text-gray-500 dark:text-gray-400">
                Auto-convert enabled
              </div>
            </div>
          )}

          {/* Rate Timestamp */}
          <div className="text-xs text-gray-500 dark:text-gray-400 text-right">
            Updated: {new Date(fxRate.as_of).toLocaleTimeString()}
          </div>
        </div>
      )}

      {/* No Conversion Needed */}
      {!showConversion && fxRate && !loading && (
        <div className="text-sm text-gray-600 dark:text-gray-400">
          No conversion needed - same currency
        </div>
      )}
    </div>
  );
}
