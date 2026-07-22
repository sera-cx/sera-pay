import { buildClientAppUrl } from "@/lib/app-url";
import { normalizeDecimalAmountText } from "@/lib/decimalInput";
import type { SeraApiMode } from "@shared/gateway";

export const LIVE_PAYMENT_CHAIN_ID = 1;
export const TEST_PAYMENT_CHAIN_ID = 11155111;
export const SERA_NO_LIQUIDITY_MESSAGE = "Currently there's no liquidity on this exchange in Sera.cx. Please try another option.";
const LEGACY_LIVE_PAYMENT_CHAIN_IDS = new Set([10, 56, 137, 8453, 42161]);

export function resolvePaymentChainId(chainId: number | null | undefined, mode?: SeraApiMode | null): number {
  if (mode === "test") return TEST_PAYMENT_CHAIN_ID;
  if (mode === "live") return LIVE_PAYMENT_CHAIN_ID;
  return chainId === LIVE_PAYMENT_CHAIN_ID ? LIVE_PAYMENT_CHAIN_ID : TEST_PAYMENT_CHAIN_ID;
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
  const resolvedChainId = chainId || TEST_PAYMENT_CHAIN_ID;
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
    params.set("gas", "65000");
    return `ethereum:${tokenAddress}@${resolvedChainId}/transfer?${params.toString()}`;
  }

  // Never degrade an ERC-20 request to a native/plain-address URI. That loses
  // the selected token and wallets may display it as ETH, USDC, or "Unknown".
  return "";
}

/**
 * Same-coin QR codes may safely open a wallet's exact ERC-20 transfer screen.
 * Cross-currency payments must open SeraPay checkout so Sera can quote and
 * execute the swap; a raw transfer would bypass conversion entirely.
 */
export function buildPaymentQrValue(request: PaymentQrValueRequest): string {
  const payCoin = String(request.coin || "").trim().toUpperCase();
  const receiveCoin = String(request.receiveCoin || "").trim().toUpperCase();
  if (payCoin && receiveCoin && payCoin !== receiveCoin) return request.paymentUrl;
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
