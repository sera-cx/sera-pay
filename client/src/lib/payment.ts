import { buildClientAppUrl } from "@/lib/app-url";
import { normalizeDecimalAmountText } from "@/lib/decimalInput";
import type { SeraApiMode } from "@shared/gateway";

export const LIVE_PAYMENT_CHAIN_ID = 1;
export const TEST_PAYMENT_CHAIN_ID = 11155111;
export const SERA_NO_LIQUIDITY_MESSAGE = "No liquidity for this pair — try another currency.";

/** Sera's own rate feed is unreachable — nothing the merchant or payer can fix. */
export const SERA_RATE_UNAVAILABLE_MESSAGE = "Live rates unavailable for this pair — try another currency.";

/**
 * Turns any exchange-rate failure into one short, friendly sentence.
 *
 * Three underlying causes need three different messages, and the raw upstream
 * text ("Sera API 503: Service temporarily unavailable") is not something to
 * show a merchant standing at a till:
 *   - no_liquidity        — nobody is quoting this pair
 *   - sera_fx_unavailable — Sera's FX service is down for this pair
 *   - anything else       — surface it, since it may be actionable
 */
export function seraRateErrorMessage(error: unknown, errorCode?: string | null): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const code = String(errorCode ?? (error as any)?.errorCode ?? "");

  // Sera enforces a per-token minimum on swaps. The server pre-flights it and
  // sends back the exact figure, so pass that straight through.
  if (code === "amount_below_min" || /AMOUNT_BELOW_MIN|minimum .* is required/i.test(message)) {
    return message || "Amount is below Sera's minimum for this currency.";
  }
  if (code === "no_liquidity" || /no[_ ]liquidity|no executable liquidity/i.test(message)) {
    return SERA_NO_LIQUIDITY_MESSAGE;
  }
  if (
    code === "sera_fx_unavailable"
    || /fx rate service|service temporarily unavailable|temporarily unavailable/i.test(message)
  ) {
    return SERA_RATE_UNAVAILABLE_MESSAGE;
  }
  return message || SERA_RATE_UNAVAILABLE_MESSAGE;
}
const LEGACY_LIVE_PAYMENT_CHAIN_IDS = new Set([10, 56, 137, 8453, 42161]);

/**
 * Ethereum mainnet is the only production payment chain. Sepolia is reachable
 * only when the merchant's saved Sera config explicitly says `mode: "test"`.
 *
 * Everything else — an unsaved config (which the database defaults to "mock"),
 * a config request that has not resolved yet, or a stale chain id persisted by
 * wagmi in the browser — resolves to mainnet. The previous default sent all of
 * those cases to Sepolia, so merchants silently minted testnet QR codes while
 * their wallet was on Ethereum.
 */
export function resolvePaymentChainId(_chainId: number | null | undefined, mode?: SeraApiMode | null): number {
  return mode === "test" ? TEST_PAYMENT_CHAIN_ID : LIVE_PAYMENT_CHAIN_ID;
}

function normalizeCheckoutChainId(value: unknown): number | undefined | null {
  if (value === undefined || value === null || value === "") return undefined;
  const chainId = Number(value);
  if (!Number.isInteger(chainId) || chainId <= 0) return null;
  if (chainId === LIVE_PAYMENT_CHAIN_ID || chainId === TEST_PAYMENT_CHAIN_ID) return chainId;
  // Older live SeraPay links used Polygon/Base/Arbitrum/Optimism/BNB. Sera's
  // current live registry and contracts are on Ethereum mainnet, so migrate
  // those links before resolving token addresses or asking the wallet to pay.
  if (LEGACY_LIVE_PAYMENT_CHAIN_IDS.has(chainId)) return LIVE_PAYMENT_CHAIN_ID;
  return null;
}

export interface OrderItem {
  id: string;    // menu item id
  n: string;     // name
  p: string;     // price (per unit)
  q: number;     // quantity
  c?: string;    // coin/currency symbol (optional, falls back to req.receiveCoin)
}

export interface PaymentRequest {
  receiverAddress: string;
  receiveCoin: string;
  amount?: string;
  chainId?: number;
  merchantName?: string;
  merchantIcon?: string;
  payCoin?: string;
  payAmount?: string;
  swap?: boolean;
  description?: string;
  expiresAt?: number; // Unix timestamp ms
  singleUse?: boolean;
  paymentIntentId?: string;
  orderId?: string;
  orderItems?: OrderItem[]; // itemised order from menu
  menuName?: string;        // menu name for receipt display
  menuSlug?: string;
  _n?: string;
}

function toBase64Url(b64: string): string {
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(b64url: string): string {
  let b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  return b64;
}

/** UTF-8-safe base64 encode (handles CJK, emoji, etc.) */
function utf8ToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** UTF-8-safe base64 decode */
function base64ToUtf8(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function encodePaymentRequest(req: PaymentRequest): string {
  const normalizedReq: PaymentRequest = {
    ...req,
    amount: req.amount ? normalizeDecimalAmountText(req.amount) || undefined : undefined,
    payAmount: req.payAmount ? normalizeDecimalAmountText(req.payAmount) || undefined : undefined,
    orderItems: req.orderItems?.map((item) => ({
      ...item,
      p: normalizeDecimalAmountText(item.p) || item.p,
    })),
  };
  const data = JSON.stringify(normalizedReq);
  return toBase64Url(utf8ToBase64(data));
}

export function decodePaymentRequest(encoded: string): PaymentRequest | null {
  try {
    // Try UTF-8-safe decode first, fall back to legacy raw atob for old links
    let data: string;
    try {
      data = base64ToUtf8(fromBase64Url(encoded));
    } catch {
      data = atob(fromBase64Url(encoded));
    }
    const parsed = JSON.parse(data);
    if (!parsed.receiverAddress || !parsed.receiveCoin) return null;
    const chainId = normalizeCheckoutChainId(parsed.chainId);
    if (chainId === null) return null;
    return {
      ...parsed,
      chainId,
      amount: parsed.amount ? normalizeDecimalAmountText(parsed.amount) || undefined : undefined,
      payAmount: parsed.payAmount ? normalizeDecimalAmountText(parsed.payAmount) || undefined : undefined,
      orderItems: Array.isArray(parsed.orderItems)
        ? parsed.orderItems.map((item: OrderItem) => ({ ...item, p: normalizeDecimalAmountText(item.p) || item.p }))
        : parsed.orderItems,
    };
  } catch {
    return null;
  }
}

export function buildPaymentUrl(req: PaymentRequest): string {
  const reqWithNonce = { ...req, _n: Math.random().toString(36).slice(2, 10) };
  const encoded = encodePaymentRequest(reqWithNonce);
  return buildClientAppUrl(`/pay/${encoded}`);
}

/**
 * Describes what the merchant actually ends up holding.
 *
 * Only a Sera swap converts the currency, and a swap needs the payer's signed
 * intent. A direct ERC-20 transfer moves the payer's own coin, so the merchant
 * receives THAT coin — the receive coin is merely the currency the price was
 * quoted in. Claiming "Received in 100 MYRT" for a direct transfer would tell
 * the merchant they are getting a currency that never arrives.
 */
export function getCrossCurrencyReceiveLabel(
  payCoin: string | null | undefined,
  receiveCoin: string | null | undefined,
  receiveAmount?: string | null,
  settlesViaSwap = false,
): string | null {
  const normalizedPayCoin = String(payCoin || "").trim().toUpperCase();
  const normalizedReceiveCoin = String(receiveCoin || "").trim().toUpperCase();
  if (!normalizedPayCoin || !normalizedReceiveCoin || normalizedPayCoin === normalizedReceiveCoin) return null;

  const normalizedAmount = normalizeDecimalAmountText(String(receiveAmount || ""));
  const pricedAs = `${normalizedAmount ? `${normalizedAmount} ` : ""}${normalizedReceiveCoin}`;
  return settlesViaSwap
    ? `Received in ${pricedAs}`
    : `Priced at ${pricedAs} · merchant receives ${normalizedPayCoin}`;
}

export function parseAmountToRaw(amount: string, decimals: number): bigint {
  const normalized = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(normalized) || parseFloat(normalized) <= 0) return 0n;
  const parts = normalized.split(".");
  const intPart = parts[0] || "0";
  const meaningfulFraction = (parts[1] || "").replace(/0+$/, "");
  if (meaningfulFraction.length > decimals) {
    throw new Error(`Amount exceeds the token's ${decimals}-decimal precision.`);
  }
  const fracPart = meaningfulFraction.padEnd(decimals, "0");
  const scale = 10n ** BigInt(decimals);
  return BigInt(intPart) * scale + BigInt(fracPart);
}

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export interface WalletPaymentUriRequest {
  receiverAddress: string;
  coin?: string | null;
  amount?: string | null;
  chainId?: number | null;
  /** Exact address returned by the active Sera /tokens registry. */
  tokenAddress?: string | null;
  /** Decimals returned beside tokenAddress by the same registry response. */
  tokenDecimals?: number | null;
}

export interface PaymentQrValueRequest extends WalletPaymentUriRequest {
  receiveCoin?: string | null;
  paymentUrl: string;
}

/**
 * Builds a raw EIP-681 wallet URI so wallet scanners can prefill token + amount.
 * Merchant QR history relies on backend direct-transfer reconciliation because
 * raw wallet URIs do not call the /pay checkout recorder.
 */
export function buildWalletPaymentUri({
  receiverAddress,
  coin,
  amount,
  chainId,
  tokenAddress,
  tokenDecimals,
}: WalletPaymentUriRequest): string {
  const receiver = receiverAddress.trim();
  // Callers such as TransactionsPage and MenuManagerPage pass a nullable
  // chainId straight from a stored row. Mainnet is the only safe default:
  // falling back to Sepolia minted QR codes that asked a customer's wallet to
  // send real payments on a test network.
  const resolvedChainId = chainId || LIVE_PAYMENT_CHAIN_ID;
  if (!EVM_ADDRESS_RE.test(receiver)) return "";

  const symbol = String(coin || "").trim().toUpperCase();
  const normalizedAmount = normalizeDecimalAmountText(String(amount || "")) || "";

  if (symbol === "ETH") {
    const rawNative = normalizedAmount ? parseAmountToRaw(normalizedAmount, 18) : 0n;
    const params = rawNative > 0n ? `?value=${rawNative.toString()}&gas=21000` : "";
    return `ethereum:${receiver}@${resolvedChainId}${params}`;
  }

  const decimals = Number(tokenDecimals);
  if (tokenAddress && EVM_ADDRESS_RE.test(tokenAddress) && Number.isInteger(decimals) && decimals >= 0 && decimals <= 255) {
    let rawAmount = 0n;
    try {
      rawAmount = normalizedAmount ? parseAmountToRaw(normalizedAmount, decimals) : 0n;
    } catch {
      return "";
    }
    const params = new URLSearchParams({ address: receiver });
    if (rawAmount > 0n) params.set("uint256", rawAmount.toString());
    return `ethereum:${tokenAddress}@${resolvedChainId}/transfer?${params.toString()}`;
  }

  // Never degrade an ERC-20 request to a native/plain-address URI. That loses
  // the selected token and wallets may display it as ETH, USDC, or "Unknown".
  return "";
}

/**
 * QR codes default to a direct ERC-20 transfer for the selected customer coin.
 * Wallet-scanner amounts are still user-editable in many wallets, so the
 * backend must confirm the exact token, recipient, chain, and amount on-chain.
 */
export function buildPaymentQrValue(request: PaymentQrValueRequest): string {
  return buildWalletPaymentUri(request) || request.paymentUrl;
}

const CURRENCY_FORMATS: Record<string, { symbol: string; prefix: boolean; decimals: number }> = {
  USD: { symbol: "$", prefix: true, decimals: 2 },
  SGD: { symbol: "S$", prefix: true, decimals: 2 },
  MYR: { symbol: "RM", prefix: true, decimals: 2 },
  IDR: { symbol: "Rp", prefix: true, decimals: 0 },
  JPY: { symbol: "¥", prefix: true, decimals: 0 },
  THB: { symbol: "฿", prefix: true, decimals: 2 },
  KRW: { symbol: "₩", prefix: true, decimals: 0 },
  CNY: { symbol: "¥", prefix: true, decimals: 2 },
  HKD: { symbol: "HK$", prefix: true, decimals: 2 },
  AUD: { symbol: "A$", prefix: true, decimals: 2 },
  NZD: { symbol: "NZ$", prefix: true, decimals: 2 },
  EUR: { symbol: "€", prefix: true, decimals: 2 },
  GBP: { symbol: "£", prefix: true, decimals: 2 },
  CHF: { symbol: "CHF", prefix: true, decimals: 2 },
  TRY: { symbol: "₺", prefix: true, decimals: 2 },
  CAD: { symbol: "C$", prefix: true, decimals: 2 },
  BRL: { symbol: "R$", prefix: true, decimals: 2 },
  MXN: { symbol: "MX$", prefix: true, decimals: 2 },
  ARS: { symbol: "AR$", prefix: true, decimals: 2 },
  ZAR: { symbol: "R", prefix: true, decimals: 2 },
  NGN: { symbol: "₦", prefix: true, decimals: 2 },
};

export function formatCurrencyAmount(amount: string, currency: string): string {
  const fmt = CURRENCY_FORMATS[currency];
  if (!fmt) return amount;
  const num = parseFloat(amount);
  if (isNaN(num)) return amount;
  const formatted = num.toLocaleString("en-US", {
    minimumFractionDigits: fmt.decimals,
    maximumFractionDigits: fmt.decimals,
  });
  return fmt.prefix ? `${fmt.symbol}${formatted}` : `${formatted} ${fmt.symbol}`;
}
