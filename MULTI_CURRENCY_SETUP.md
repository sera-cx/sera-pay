# Multi-Currency SeraPay Enhancement

This document describes the multi-currency payment enhancement for SeraPay, which enables merchants to accept payments in customer's local currency automatically using Sera's FX infrastructure.

## Features

- **Automatic Currency Detection**: Detects customer's local currency based on IP geolocation
- **Real-time FX Rates**: Live FX rates from Sera's multi-source pricing
- **Auto-Conversion**: Automatically converts payments to merchant's preferred settlement currency
- **40+ Supported Currencies**: USD, EUR, GBP, JPY, SGD, MYR, IDR, BRL, MXN, and more
- **Stablecoin Support**: Automatic selection of optimal stablecoin for each currency
- **Transparent Pricing**: Real-time FX rate display during checkout

## Architecture

### Backend Components

1. **Sera FX Service** (`server/sera-fx-service.ts`)
   - Interfaces with Sera MCP for FX operations
   - Currency detection and validation
   - FX rate fetching and conversion calculations

2. **Location Detection Service** (`server/location-detection.ts`)
   - IP-based geolocation
   - Country to currency mapping
   - Caching for performance

3. **FX API Routes** (`server/fx-routes.ts`)
   - `/api/fx/rate` - Get FX rate between currencies
   - `/api/fx/quote` - Get conversion quote
   - `/api/fx/currencies` - List supported currencies
   - `/api/fx/location` - Detect customer location
   - `/api/fx/detect-currency` - Detect customer currency

4. **Multi-Currency Payment Endpoint** (`server/payment-routes.ts`)
   - `/api/payment/create-multi-currency` - Create payment with auto FX conversion

### Database Schema Changes

**Merchants Table:**
- `preferredSettlementCurrency` - Merchant's preferred settlement currency (default: USD)
- `autoConvertEnabled` - Enable/disable auto-conversion (default: 0)

**Transactions Table:**
- `customerCurrency` - Customer's original currency
- `customerAmount` - Original amount in customer's currency
- `fxRate` - FX rate used for conversion
- `fxConverted` - Whether FX conversion was performed
- `settlementCurrency` - Final settlement currency

### Frontend Components

1. **FX API Client** (`client/src/lib/fx-api.ts`)
   - Client-side functions for FX API calls
   - Currency formatting utilities

2. **FX Rate Display Component** (`client/src/components/FxRateDisplay.tsx`)
   - Real-time FX rate display
   - Conversion preview
   - Auto-refresh functionality

## Setup Instructions

### 1. Environment Configuration

Add the following to your `.env` file:

```bash
# Sera MCP Configuration
SERA_NETWORK=mainnet  # or 'testnet' for testing
POLICY_PRESET=standard
```

### 2. Database Migration

Run the database migration to add new fields:

```bash
pnpm db:generate
pnpm db:migrate
```

### 3. Sera MCP Setup

The Sera MCP server is included in `lib/sera-mcp/`. It's already built and ready to use.

### 4. Start the Development Server

```bash
pnpm install
pnpm run dev
```

## API Usage

### Create Multi-Currency Payment

```bash
POST /api/payment/create-multi-currency
Content-Type: application/json

{
  "merchantAddress": "0x...",
  "amount": "100.00",
  "customerCurrency": "MYR",  // Optional - auto-detected if not provided
  "chainId": 1
}
```

Response:
```json
{
  "txId": "uuid",
  "toAddress": "0x...",
  "coin": "USDC",
  "amount": "21.50",
  "chainId": 1,
  "customerCurrency": "MYR",
  "customerAmount": "100.00",
  "settlementCurrency": "USD",
  "fxRate": "0.21500000",
  "fxConverted": 1
}
```

### Get FX Rate

```bash
GET /api/fx/rate?base=MYR&quote=USD
```

Response:
```json
{
  "pair": "MYR/USD",
  "rate": "0.21500000",
  "as_of": 1234567890,
  "rate_24h_ago": "0.21450000",
  "as_of_24h_ago": 1234567890,
  "change_pct": "0.23"
}
```

### Detect Customer Currency

```bash
GET /api/fx/detect-currency
```

Response:
```json
{
  "currency": "MYR"
}
```

## Supported Currencies

- USD (US Dollar)
- EUR (Euro)
- GBP (British Pound)
- JPY (Japanese Yen)
- SGD (Singapore Dollar)
- MYR (Malaysian Ringgit)
- IDR (Indonesian Rupiah)
- BRL (Brazilian Real)
- MXN (Mexican Peso)
- CAD (Canadian Dollar)
- AUD (Australian Dollar)
- INR (Indian Rupee)
- CNY (Chinese Yuan)
- KRW (South Korean Won)
- PHP (Philippine Peso)
- THB (Thai Baht)
- VND (Vietnamese Dong)
- ZAR (South African Rand)
- NGN (Nigerian Naira)
- EGP (Egyptian Pound)
- AED (UAE Dirham)
- SAR (Saudi Riyal)

## Merchant Configuration

Merchants can configure their multi-currency preferences:

1. **Preferred Settlement Currency**: Choose which currency to receive payments in
2. **Auto-Convert Enabled**: Enable/disable automatic FX conversion

If auto-convert is disabled, customers pay in their local currency and merchants receive that currency.

## Testing

### Test FX Rate Endpoint

```bash
curl http://localhost:3000/api/fx/rate?base=USD&quote=MYR
```

### Test Currency Detection

```bash
curl http://localhost:3000/api/fx/detect-currency
```

### Test Multi-Currency Payment

```bash
curl -X POST http://localhost:3000/api/payment/create-multi-currency \
  -H "Content-Type: application/json" \
  -d '{
    "merchantAddress": "0x...",
    "amount": "100.00"
  }'
```

## Benefits

- **Reduced FX Friction**: Customers pay in their local currency
- **Transparent Pricing**: Real-time FX rates shown during checkout
- **Automatic Conversion**: No manual currency conversion needed
- **Cost Savings**: Sera's optimized routing reduces conversion costs
- **Global Reach**: Accept payments from customers in 40+ currencies

## Troubleshooting

### Sera MCP Not Responding

Ensure the Sera MCP server is built:
```bash
cd lib/sera-mcp
npm run build
```

### Location Detection Failing

Check that the server can access external APIs (ipapi.co) for geolocation.

### FX Rates Not Loading

Verify SERA_NETWORK is set correctly in `.env` file.

## Future Enhancements

- [ ] Merchant FX rate preferences
- [ ] Historical FX rate analytics
- [ ] FX rate alerts
- [ ] Multi-currency reporting dashboard
- [ ] Advanced FX routing strategies
