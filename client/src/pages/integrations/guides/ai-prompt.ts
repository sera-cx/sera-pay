import type { WidgetNetwork } from "@shared/integration-widget";
import { catalog } from "../catalog";
import { guides } from "./index";
import { historyPrompt } from "./history";
import { apiOriginGuidance, flowAccess, keyConflictGuidance, typedDataSigningGuidance } from "./access";

type GuideFlow = keyof typeof guides;

const goal: Record<GuideFlow, string> = {
  transfer:
    "Let anyone draft a direct ERC-20 transfer. Let the signed-in sender build, review the network fee, sign and see the submission result.",
  "set-rate":
    "Let anyone preview what they send and receive at a chosen rate. Let the owner place the order, track fills and cancel the remainder.",
  accept:
    "Let anyone review payment terms, a signed-in merchant issue the link, and a customer open and pay it. Record conversions verified through Sera.",
};

const docs = "https://docs.testnet.sera.cx/api-reference";
const additionalReferences: Record<GuideFlow, string[]> = {
  transfer: [],
  "set-rate": [docs + "/endpoints/account/#deposit-helpers", "https://docs.sera.cx/api-reference/market-maker-guide/", "https://docs.sera.cx/api-reference/endpoints/orders/"],
  accept: [
    docs + "/endpoints/account/#erc-20-transfer",
    docs + "/endpoints/orders/#get-order",
  ],
};

export function buildIntegrationPrompt(
  flow: GuideFlow,
  network: WidgetNetwork = "sepolia",
): string {
  const guide = guides[flow];
  const access = flowAccess[flow];
  const references = [
    catalog[flow].docs,
    ...additionalReferences[flow],
    docs + "/authentication/",
  ];

  return [
    `Implement Sera ${catalog[flow].title} in my existing app. ${goal[flow]}`,
    "Inspect the existing wallet, session, server routes, storage and tests. Give a short plan naming the files to change, then implement the complete flow using the project’s existing stack.",
    [
      "Network and signing",
      access.public,
      access.wallet,
      access.key,
      "Start on Ethereum Sepolia (chain ID 11155111). Call the external Sera CLOB API at https://api.testnet.sera.cx/api/v1. The CLOB endpoints below use that base.",
      "Read GET /config, GET /tokens and GET /system/time. Match the connected chain to config.chain_id before signing. Resolve token contract and decimals from this chain’s registry. Keep user amounts as decimal strings and convert raw amounts with integer arithmetic.",
      "Recheck the connected account and chain before and after each signature. For authenticated CLOB calls, the backend must verify the session’s wallet and use that wallet’s chain-specific Authorization: Bearer api_key:api_secret. To provision it, sign ManageApiKey(owner, action=create, timestamp) with config.eip712_domain and Sera time, then have the backend POST /api-keys with owner_address, action, timestamp and signature. Seal the issued pair in an expiring HttpOnly, SameSite cookie, with Secure on HTTPS. Name the cookie by verified wallet and selected network. Keep Sepolia and Live keys concurrently. On a switch or reload, reuse only that network’s cookie and CLOB host. Bind the encrypted key to the verified wallet and chain, clamp its lifetime to Sera’s expiry and clear it on logout. Return only session status to JavaScript. Keep wallet secrets out of source, .env, databases, localStorage, logs and AI prompts.",
      "Keep guest previews available when a wallet is disconnected or its private data is unavailable. For protected actions, reuse the selected wallet’s network-specific key. If it is missing or expired, explain why this action needs the gas-free access signature and wait for the user. Read GET /balances with owner_address and include_zero=true. Show unavailable when wallet_balance_available is false. Use the wallet balance for spending and vault_available for orders. Refresh private data when the wallet or network changes.",
      apiOriginGuidance,
      typedDataSigningGuidance,
      keyConflictGuidance,
      network === "live"
        ? "The intended deployment is Ethereum mainnet (chain ID 1, https://api.sera.cx/api/v1). Complete and report the Sepolia tests first. Enable live operations only after explicit approval, with separately loaded config, token registry, credentials and records."
        : "Keep all implementation checks on Sepolia. Ask for explicit approval before enabling production.",
    ].join("\n"),
    [
      "Implementation",
      ...guide.promptRules.map((rule, i) => `${i + 1}. ${rule}`),
    ].join("\n"),
    historyPrompt(flow),
    [
      "Acceptance tests",
      "Test success and rejection for external and social/embedded wallets. Test account/network changes, expired credentials, duplicate submission, unavailable APIs and recovery after reload. Sign raw bytes only where the wallet supports it.",
      "Run the tests yourself. Report changed files, commands and outcomes. Identify which checks used fixtures, which reached Sepolia and which status Sera actually reported. If a test wallet, funds or credentials are missing, report the blocked check.",
    ].join("\n"),
    ["Official Sera API references", ...references].join("\n"),
  ].join("\n\n");
}
