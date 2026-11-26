import type { WidgetNetwork } from "@shared/integration-widget";
import { historyPrompt } from "../../integrations/guides/history";
import { apiOriginGuidance, flowAccess, keyConflictGuidance, typedDataSigningGuidance } from "../../integrations/guides/access";

export const COMPACT_RULES = `1. Start on Ethereum Sepolia, chain 11155111, https://api.testnet.sera.cx/api/v1. Read GET /config, /tokens and /system/time. Require the expected chain/domain and selected account and chain immediately before and after each wallet signature. Key credentials, caches and attempts by chain and owner. Reset stale reviews when either changes. Mainnet is chain 1 at https://api.sera.cx/api/v1 with separate credentials.
2. Allow guest browsing. For balances, reuse the signed-in wallet’s credential. To create one, sign EIP-712 ManageApiKey(owner, action="create", timestamp) with config.eip712_domain and Sera time; exchange it via POST /api-keys within five minutes. The app backend verifies wallet ownership and seals api_key:api_secret in an encrypted HttpOnly, SameSite cookie bound to owner, chain and expiry, Secure on HTTPS. Name each cookie by wallet and network. Keep Sepolia and Live credentials concurrently. On a switch or reload, reuse only the matching cookie and CLOB host. Clear these cookies on logout. Expose only status to the browser. Send the bearer only to Sera; keep it out of source, environment files, logs and browser storage. GET /balances?owner_address=…&include_zero=true distinguishes vault_available from wallet_balance; show wallet funds only when wallet_balance_available.
3. Collect distinct registry tokens, exact positive input and nonzero recipient (default owner). Check decimals, uint256 bounds and min_trade_amount_raw. POST /swap/quote with from_token, to_token, from_amount (raw string), owner_address, recipient, expiration (Sera time + 300) and gas_mode (receive_less for fixed input or pay_more with an input estimate for a target output). Review payer, recipient, pair, fees, maxInputAmount and minOutputAmount. Require the returned route_params to match; reject invalid amounts and deadlines. Refresh after 25s or with 5s left. Recheck after wallet prompts; require approval for worse terms beyond the accepted tolerance (default 1 bp). Validate permission again on every fresh quote.
4. Equity-only routes with zero initialDepositAmount may omit permission. Positive deposits require metadata. For a required EIP-2612 permit, validate token domain/chain, owner, spender=config.sor_address, exact value, nonce and deadline before signing. For a token without permit, compare current_allowance_raw with the required deposit. If short, POST /approve with owner, token, spender and exact amount; verify chain, token target, zero ETH value, decoded spender/amount and gas. If a zero reset is required, confirm Sera can build it or ask the owner to clear it in their wallet. Require raw signing and send the reviewed approval via POST /tx/send. Requote and recheck allowance before the swap.
5. Sign the canonical nine-field Intent using the reviewed route_params and config.eip712_domain. Persist chain, owner, recipient, signed route and quote identity before POST /swap. Send the quote record uuid and signature plus permit_signature and permit_deadline when required. route_params.uuid is the numeric ID inside the intent. Save trade_id on response. Serialize clicks. A decline before sending cancels the attempt. On a lost response or an ambiguously consumed quote, reconcile the original attempt via GET /orders?owner_address=…&type=swap&created_after=… before allowing another. Requote and re-sign at most twice for definitive stale errors, respect Retry-After, and distinguish AMOUNT_BELOW_MIN and no_liquidity.
6. With the payer’s bearer, read GET /orders/{trade_id} and all GET /fills/{trade_id} pages. Match the saved trade, required signed route UUID, owner and tokens. Require settled order/summary and all settled fills with the correct order perspective; compare complete fill counts, hashes, net debits/credits, aggregate totals and signed bounds. Preserve matched, partial, failed, cancelled, reverted and unknown states. A hash alone does not settle. Restore pending attempts after reload. Only the public Sera CLOB provides settlement evidence.`;

function networkContext(network: WidgetNetwork) {
  return network === "live"
    ? "The guide selection is Live (Ethereum mainnet). Implement and verify on Sepolia first. Provide verified mainnet configuration as a separate rollout step for the owner."
    : "The guide selection is Sepolia testnet. Implement and verify here first. Keep production activation separate.";
}

export function buildSwapPrompt(network: WidgetNetwork) {
  return [
    "Implement stablecoin swaps in my existing application using the external Sera CLOB API. Deliver a usable integration covering price, wallet permission, signing, execution and settlement.",
    networkContext(network),
    [flowAccess.swap.public, flowAccess.swap.wallet, flowAccess.swap.key].join(" "),
    COMPACT_RULES,
    apiOriginGuidance,
    typedDataSigningGuidance,
    keyConflictGuidance,
    historyPrompt("swap"),
    "Test success and rejection for both connected external wallets and social embedded wallets. Test insufficient vault balance, permit and allowance branches, wallet or chain change during signing, stale quotes, lost submissions and incomplete fills.",
    "Run the project’s checks and quote on Sepolia. Report fixture results separately from actual API calls and any steps still needing a funded wallet. Mainnet execution requires explicit approval.",
    "Official references\nhttps://docs.testnet.sera.cx/api-reference/endpoints/swaps/\nhttps://docs.testnet.sera.cx/api-reference/endpoints/account/\nhttps://docs.testnet.sera.cx/api-reference/endpoints/orders/\nhttps://docs.testnet.sera.cx/api-reference/authentication/\nhttps://docs.sera.cx/api-reference/endpoints/swaps/",
  ].join("\n\n");
}

export function auditSwapPrompt(network: WidgetNetwork) {
  return [
    "Audit the Sera swap integration in my project. Trace the normal user and API paths through price, permission, signature, submission, recovery and settlement. Check each rule below with a source file and test evidence. Report pass, gap or unverified for each requirement. Prioritize incorrect signing terms, duplicate submissions and false settlement. Give concrete fixes for gaps.",
    networkContext(network),
    COMPACT_RULES,
    apiOriginGuidance,
    typedDataSigningGuidance,
    keyConflictGuidance,
    historyPrompt("swap"),
  ].join("\n\n");
}
