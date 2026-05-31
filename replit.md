# Project Notes

SeraPay is a merchant payment app for stablecoin QR payments, payment links, receipts, dashboard tracking, and merchant settings.

## Useful Commands

```bash
pnpm run dev
pnpm run check
pnpm test
pnpm run build
```

## Main Pages

- `/` is the merchant entry page. It explains the product, opens wallet login, and lets a connected merchant generate a branded QR payment request.
- `/pay/:encoded` is the customer checkout page. It reads the encoded payment request, shows merchant/payment details, lets the customer connect a wallet, and guides the payment flow. `/wallet/pay/:encoded` remains available for older QR links.
- `/wallet/receipt/:txId` is the customer receipt page. It shows the completed payment record and can export the receipt as a PDF.
- `/dashboard` is the merchant overview. It summarizes payment activity, recent transactions, network status, and quick actions.
- `/payments` is for creating and listing payment links or checkout sessions, including invoice-style descriptions.
- `/transactions` is the merchant transaction history. It supports filtering, inspecting QR/payment details, adding notes, copying links, and exporting CSV.
- `/settings` controls merchant profile, receive currency, branding, QR styling, receipt preview, webhook settings, and saved appearance.
- `/wallets` and `/sub-wallets` manage merchant receiving wallets for different storefronts or use cases.
- `/developer` contains API/webhook tools, integration examples, credential status, and webhook delivery logs for merchants who want deeper integration.
- `/menu-manager/pos`, `/menu-manager/new`, and `/menu-manager/create` support menu-based checkout flows for restaurants, counters, or simple storefronts.
- `/menu/:slug` is the public customer menu page where customers can choose items and proceed to payment.
- `/wallet/history/:address` shows public payer history for a wallet address.
- SEO routes such as `/crypto-invoice-payments`, `/stablecoin-payment-gateway`, and `/stablecoin-qr-code-generator` explain use cases and lead users back into the main product flow.

## Current Architecture

- Frontend: React, Vite, Wouter, wagmi/viem.
- Backend: Express API routes under `/api`.
- Database: Drizzle schema and migrations.
- Storage: optional Cloudflare R2, with backend proxy fallback for private buckets.
- Payments: merchant QR/link creation, checkout flow, transaction tracking, and dashboard views.