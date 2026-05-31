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

## Open Source Hygiene

Before publishing, run:

```bash
pnpm run check
pnpm test
pnpm run build
```

Also verify that `.env`, generated build output, local logs, and private deployment files are not included in git.

For a deeper release pass, use [docs/open-source-sanitization-prompt.md](docs/open-source-sanitization-prompt.md).
