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

Call `POST /api/payment/qr` from your backend using the owner's SeraPay API key
(available in the dashboard's developer tools). Do not expose this key in a
customer-facing application.

```bash
curl -X POST https://pay.sera.cx/api/payment/qr \
  -H "X-Api-Key: $SERAPAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "baseAmount": "100",
    "baseCurrency": "USDC",
    "targetCurrency": "XSGD",
    "singleUse": true
  }'
```

| Field | Meaning |
| --- | --- |
| `baseAmount` | Required positive **decimal string** the owner must receive. Up to six decimal places, further limited by the base token's decimals. Maximum `9007199254.740991`, matching checkout's exact micro-unit limit. |
| `baseCurrency` | Required receiving stablecoin symbol, such as `USDC`. |
| `targetCurrency` | Required customer payment stablecoin symbol, such as `XSGD`. Symbols are case-insensitive and must exist in the active Sera token registry; fiat codes such as `USD` are not substitutes for token symbols. |
| `singleUse` | Optional boolean, default `false`. Set `true` to save a single-use payment intent; `false` creates a reusable link. Neither has an expiry. |

In this example, the requested owner receipt is **100 USDC**, and the customer
pays the equivalent in **XSGD**. The endpoint uses the owner's saved receiving
wallet (or account wallet when none is saved) and saved network mode. Live is
the default; Sepolia requires both a saved test mode and server-side
`SERA_ENABLE_TESTNET=true`. Callers cannot override the owner, wallet, network,
or branding through the request body. Unknown fields are rejected.

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

`targetAmount` above is illustrative, not a live rate. Cross-currency generation
uses the existing Sera fixed-output liquidity preflight and reports an indicative
customer amount, rounded up to the supported token/payment precision. It does
not lock a rate, reserve liquidity, or submit a payment. Checkout obtains a fresh
quote to cover the owner's requested base amount. The target token is preselected
in checkout, matching the dashboard QR flow; the customer can choose another
supported payment token. Equal base/target symbols create a direct payment and
do not require exchange liquidity.

The PNG is the **full payment card from the web interface's Download button**,
including the customer amount/currency, merchant details, and styled QR. It reuses
the same card renderer and the owner's saved logo, colors, QR style, and
standard/advanced QR mode. Rendering or logo-loading failures return an error
instead of an unbranded replacement.

`qrValue` is the exact content encoded in the card:

- **Reusable, same-currency:** the web interface's direct EIP-681 wallet URI,
  prefilled with the receiving wallet, token, network, and amount.
- **Cross-currency or single-use:** the signed `checkoutUrl`. Single-use codes
  must pass through checkout to enforce payment reservation; a raw wallet transfer
  cannot enforce single use.

`checkoutUrl` is always returned as a separate shareable link, including when
the card uses a direct wallet URI. Direct wallet scans bypass the checkout recorder
and rely on the existing on-chain direct-transfer reconciliation for tracking.

For single-use QRs, `paymentIntentId` can be read through the existing authenticated
`GET /api/payments/:id` endpoint, and the intent appears in `GET /api/payments`.
Checkout's existing payment reservation and paid-state checks enforce single use.
Reusable QRs return `paymentIntentId: null` and do not create a payment intent.
Each successful API call generates a new link; POST retries are not idempotent.

Errors return JSON with `error` and, for generation errors, `errorCode`:

- **400:** Invalid input, unsupported token, excessive precision, or amount below
  Sera's swap minimum.
- **401:** Missing or invalid `X-Api-Key`.
- **403:** Receiving wallet failed compliance screening.
- **409:** No executable liquidity or the quote cannot cover the base amount.
- **422:** The saved branding or logo cannot be rendered.
- **429:** Rate limited (up to 20 generation requests per minute per IP).
- **5xx:** Signing, Sera, image rendering/storage, or persistence unavailable.

No single-use intent is created if quoting or rendering fails. Configure
`PAYMENT_BASE_URL` for the externally accessible checkout origin when self-hosting.

The API calls `renderPaymentQrCard`, also used by the web Download button, with
a native Node canvas. QR styles, card layout, and drawing functions are shared
with the webpage. Fonts and the canvas runtime are installed through pnpm;
the existing Alpine Docker image needs no additional setup.

`pnpm test` includes real image generation and decoding checks for both QR modes
and all saved styles. Run `pnpm test:qr-image` for the QR API and image tests alone.
The optional live Alchemy check requires `ALCHEMY_API_KEY`.

## Open Source Hygiene

Before publishing, run:

```bash
pnpm run check
pnpm test
pnpm run build
```

Also verify that `.env`, generated build output, local logs, and private deployment files are not included in git.

For a deeper release pass, use [docs/open-source-sanitization-prompt.md](docs/open-source-sanitization-prompt.md).
