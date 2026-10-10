# SeraPay

SeraPay is a stablecoin payment application for merchants who want to create payment links, generate branded QR codes, and track payment activity from a web dashboard.

## Features

- Wallet-based merchant sign-in.
- Merchant dashboard for payment history, settings, menus, and developer tools.
- Branded QR payment links with saved logo, color, and style preferences.
- Stablecoin checkout flow with rate display and payment status tracking.
- Optional Cloudflare R2 storage for merchant logos and menu item images.
- Server-side integrations are kept behind API routes so secrets stay out of the browser bundle.

## Project Structure

```txt
client/        React/Vite frontend
server/        Express API server
drizzle/       Database schema and migrations
shared/        Shared types/constants
lib/           Internal packages and generated API helpers
scripts/       Development/build/start scripts
```

## Getting Started

```bash
pnpm install
cp .env.example .env
pnpm run dev
```

The development script starts the app on the first available local port, beginning at `3000`.

## Environment

Use `.env.example` as the template. Keep real values in `.env`, which is ignored by git.

Important groups:

- Database: `DATABASE_URL`
- Session/encryption: `SESSION_SECRET`, `SERA_CONFIG_ENCRYPTION_KEY`
- Wallet authentication: public app/client identifiers plus server-side verification values
- Sera API: `SERA_API_BASE_URL`, `SERA_API_TESTNET_BASE_URL`, optional platform API credentials
- Optional exchange graph: `GOLDSKY_GRAPHQL_URL`
- Cloudflare R2: `CLOUDFLARE_R2_*` server-side values

Do not commit real API keys, access tokens, private URLs, JWT keys, database URLs, or webhook secrets.
Keep local notes and audit logs under `logs/`; the folder is ignored by git and should stay local-only.

For production, `SESSION_SECRET` and `SERA_CONFIG_ENCRYPTION_KEY` must each be stable random values of at least 32 bytes. Generate each value separately:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## Scripts

```bash
pnpm run dev      # start local development server
pnpm run check    # TypeScript validation
pnpm test         # Vitest test suite
pnpm run build    # production build
pnpm start        # start built app
```

## Storage

Merchant logos and menu images can be stored in Cloudflare R2 when configured. If a public R2 URL is not set, the app serves stored images through a backend proxy route so the bucket can remain private.

Each merchant stores one current logo reference in the merchant profile. QR style/color preferences are saved on the same merchant profile and reused on later sessions.

## Generate a payment QR through the API

Call `POST /api/payment/qr` from your backend with the owner's dashboard API key.
Keep this key out of customer-facing applications.

```bash
curl https://pay.sera.cx/api/payment/qr \
  -H "X-Api-Key: $SERAPAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"baseAmount":"100","baseCurrency":"USDC","targetCurrency":"XSGD","singleUse":true}'
```

| Field | Meaning |
| --- | --- |
| `baseAmount` | Positive decimal **string** the merchant must receive; up to six decimal places, limited by token precision, and at most `9007199254.740991`. |
| `baseCurrency` | Merchant's receiving token, e.g. `USDC`. |
| `targetCurrency` | Customer's payment token, e.g. `XSGD`. Symbols are case-insensitive and must exist in Sera's token registry; fiat codes such as `USD` are not substitutes. |
| `singleUse` | Optional boolean, default `false`. Single-use and reusable links have no expiry. |

The example requests **100 USDC** for the merchant, paid in **XSGD**. Wallet,
network, and branding come from the owner's saved settings; unknown input fields
are rejected. The account wallet is used when no receiving wallet is saved.
Live mode is the default; Sepolia requires saved test mode and `SERA_ENABLE_TESTNET=true`.

Successful responses use HTTP **201** and `Cache-Control: no-store`:

```json
{
  "checkoutUrl": "https://pay.sera.cx/pay/<signed-payload>",
  "qrValue": "https://pay.sera.cx/pay/<signed-payload>",
  "qrCodeDataUrl": "data:image/png;base64,...",
  "baseAmount": "100",
  "baseCurrency": "USDC",
  "targetCurrency": "XSGD",
  "targetAmount": "130",
  "receiverAddress": "0x...",
  "chainId": 1,
  "singleUse": true,
  "paymentIntentId": "<uuid>",
  "requiresCustomerRequote": true
}
```

`targetAmount` is illustrative. Conversions check executable liquidity and round
the indicative customer amount up to supported precision. They do not lock a rate,
reserve liquidity, or submit payment. Checkout obtains a fresh quote and allows
another supported payment token; same-token payments need no conversion quote.

`qrCodeDataUrl` is the full payment card, using the webpage's shared drawing
functions and saved logo, colors, style, and standard/advanced mode. Node renders
it natively using pnpm-installed canvas/fonts; the Alpine Dockerfile is unchanged.
Branding failures return an error. `qrValue` encodes a direct EIP-681 wallet URI
for reusable same-token payments, or the signed `checkoutUrl` for conversion and
single-use payments. `checkoutUrl` is always returned; direct scans use existing
on-chain reconciliation instead of checkout recording.

Single-use intents are created only after quoting and rendering succeed, appear
in `GET /api/payments` and `GET /api/payments/:id`, and use checkout's reservation
and paid-state checks. Reusable responses have `paymentIntentId: null`.
Each request creates a new link; retries are **not idempotent**.

Errors include `error` and, for generation failures, `errorCode`: **400** invalid
input/token/precision/minimum amount; **401** invalid key; **403** blocked recipient;
**409** unavailable liquidity; **422** branding failure; **429** rate limited
(20 requests/minute/IP); **5xx** service or persistence failure.

Set `PAYMENT_BASE_URL` to the public checkout origin when self-hosting.
`pnpm test` includes real QR generation/decoding; `pnpm test:qr-image` runs just
the QR tests. The optional live Alchemy test requires `ALCHEMY_API_KEY`.

## Open Source Hygiene

Before publishing, run:

```bash
pnpm run check
pnpm test
pnpm run build
```

Also verify that `.env`, generated build output, local logs, and private deployment files are not included in git.

For a deeper release pass, use [docs/open-source-sanitization-prompt.md](docs/open-source-sanitization-prompt.md).
