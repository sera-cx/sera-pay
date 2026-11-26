import type { WidgetFlow } from "@shared/integration-widget";

export const typedDataSigningGuidance = "Use the connected wallet’s viem signTypedData method. If calling MetaMask’s eth_signTypedData_v4 directly, pass [owner, serializedTypedData]. The JSON string must include types.EIP712Domain matching the fields in the signing domain. Encode large integers as decimal strings.";

export const apiOriginGuidance = "Have the browser call your own backend on the same origin. For public signing settings, expose a read-only handler that fetches GET /config and GET /system/time from the selected Sera host without a credential. Allowlist the network and upstream paths. Keep private CLOB calls on your backend.";

export const keyConflictGuidance = "A wallet can have 10 active API keys. If key creation reports that limit, use a browser already enabled for this wallet and network, or let the owner review their active keys and revoke one they no longer use. Never revoke a key automatically. If Sera specifically says the signature was already used, fetch a new server timestamp and offer a fresh signature. An unexplained HTTP 409 should keep access off without another automatic signing request.";

export const flowAccess = {
  swap: {
    public: "Get a live estimate with POST /swap/quote. For guests, use a disposable preview address as owner_address and recipient and show only the estimate. After login, request a fresh quote for the connected wallet and actual recipient before signing.",
    wallet: "Sign the reviewed swap in the wallet. POST /swap accepts the signed intent without an API key.",
    key: "Use the payer’s key for balances, an on-chain approval through Sera when needed, and order and fill status.",
  },
  transfer: {
    public: "Select a token, enter the recipient and review the amount. The network fee is available after Sera builds the transfer.",
    wallet: "Log in with the sender’s wallet. Review the network fee and sign the exact transfer.",
    key: "The sender’s key is required for balances, POST /transfer and POST /transfer/send. A broadcast hash means submitted.",
  },
  "set-rate": {
    public: "Choose a market and preview a price. On Sepolia, a guest can call POST /orders/preview with a disposable preview address as owner_address. Mainnet also supports an exact local order review. After login, rebuild the order for the connected wallet and review it before signing.",
    wallet: "The owner signs to place or cancel an order. POST /orders and POST /orders/cancel accept those signatures without an API key.",
    key: "Use the owner’s key to check or fund the vault and to read order status and fills.",
  },
  accept: {
    public: "Preview the payment terms. Anyone with an issued link can see its token and network. The merchant can set an amount or let the customer enter one at checkout.",
    wallet: "The merchant signs in to issue a link to their own wallet. Link creation uses the app’s verified login and does not require a merchant CLOB key.",
    key: "At checkout, the payer’s key is used for direct transfers and for checking conversion settlement. The merchant’s receiving address comes from the signed link.",
  },
} satisfies Record<WidgetFlow, { public: string; wallet: string; key: string }>;
