/**
 * Standalone Demo Script for Multi-Currency SeraPay
 * Run this script to demonstrate the multi-currency features without starting the full server
 */

// Set mock mode for demo
process.env.SERA_MOCK_MODE = 'true';

import { seraFxService } from './server/sera-fx-service';
import { locationDetectionService } from './server/location-detection';

// Use the singleton instance
const fxService = seraFxService;

async function runDemo() {
  console.log('🌍 Multi-Currency SeraPay Demo');
  console.log('================================\n');

  // Demo 1: Supported Currencies
  console.log('📊 Supported Currencies (40+):');
  console.log('--------------------------------');
  const currencies = fxService.getSupportedCurrencies();
  currencies.slice(0, 10).forEach((c: any) => {
    console.log(`  ${c.code} - ${c.name} (${c.symbol})`);
  });
  console.log(`  ... and ${currencies.length - 10} more\n`);

  // Demo 2: FX Rate
  console.log('💱 FX Rate (USD → MYR):');
  console.log('-------------------------');
  const rate = await fxService.getFxRate('USD', 'MYR');
  if (rate) {
    console.log(`  Pair: ${rate.pair}`);
    console.log(`  Rate: ${rate.rate}`);
    console.log(`  24h Change: ${rate.change_pct}%`);
    console.log(`  Updated: ${new Date(rate.as_of).toLocaleString()}\n`);
  } else {
    console.log('  No rate data available\n');
  }

  // Demo 3: FX Quote
  console.log('💰 FX Quote (100 USD → MYR):');
  console.log('------------------------------');
  const quote = await fxService.getFxQuote('USD', 'MYR', '100');
  if (quote) {
    console.log(`  From: ${quote.amount} ${quote.from_currency}`);
    console.log(`  To: ${quote.estimated_amount} ${quote.to_currency}`);
    console.log(`  Rate: ${quote.rate}`);
    console.log(`  Fee: ${quote.fee_bps} bps\n`);
  } else {
    console.log('  No quote data available\n');
  }

  // Demo 4: Best Deals
  console.log('🔥 Best FX Deals (25+ bps):');
  console.log('-----------------------------');
  const deals = await fxService.findDeals(25);
  deals.forEach((deal: any) => {
    console.log(`  ${deal.pair}: ${deal.spread_bps} bps (mid: ${deal.mid})`);
  });
  console.log();

  // Demo 5: Spread Radar
  console.log('📡 Spread Radar (USD, SGD, MYR):');
  console.log('----------------------------------');
  const radar = await fxService.getSpreadRadar(['USD', 'SGD', 'MYR']);
  radar.forEach((item: any) => {
    console.log(`  ${item.currency}: ${item.spread_bps} bps spread`);
  });
  console.log();

  // Demo 6: Currency Detection
  console.log('🌐 Currency Detection (Malaysia):');
  console.log('-----------------------------------');
  const myrCurrency = fxService.detectCurrencyFromCountry('MY');
  console.log(`  Country: MY (Malaysia)`);
  console.log(`  Detected Currency: ${myrCurrency}\n`);

  // Demo 7: Currency Detection (Singapore)
  console.log('🌐 Currency Detection (Singapore):');
  console.log('-----------------------------------');
  const sgdCurrency = fxService.detectCurrencyFromCountry('SG');
  console.log(`  Country: SG (Singapore)`);
  console.log(`  Detected Currency: ${sgdCurrency}\n`);

  // Demo 8: Stablecoins for Currency
  console.log('💎 Stablecoins for MYR:');
  console.log('------------------------');
  const myrStablecoins = fxService.getStablecoinsForCurrency('MYR');
  console.log(`  ${myrStablecoins.join(', ')}\n`);

  // Demo 9: Currency Formatting
  console.log('💵 Currency Formatting:');
  console.log('------------------------');
  console.log(`  ${fxService.formatCurrencyAmount(100, 'USD')}`);
  console.log(`  ${fxService.formatCurrencyAmount(100, 'MYR')}`);
  console.log(`  ${fxService.formatCurrencyAmount(100, 'EUR')}`);
  console.log(`  ${fxService.formatCurrencyAmount(100, 'SGD')}\n`);

  // Demo 10: Conversion Calculation
  console.log('🔄 Conversion Calculation:');
  console.log('---------------------------');
  const converted = fxService.calculateConversion(100, 'USD', 'MYR', 4.65);
  console.log(`  100 USD × 4.65 = ${converted} MYR\n`);

  console.log('✅ Demo Complete!');
  console.log('\nKey Features Demonstrated:');
  console.log('  ✓ 40+ supported currencies');
  console.log('  ✓ Real-time FX rates');
  console.log('  ✓ Currency conversion quotes');
  console.log('  ✓ Best deal detection');
  console.log('  ✓ Spread radar');
  console.log('  ✓ Location-based currency detection');
  console.log('  ✓ Stablecoin selection');
  console.log('  ✓ Currency formatting');
  console.log('  ✓ Conversion calculations');
}

runDemo().catch(console.error);
