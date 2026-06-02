import { buildClientAppUrl } from "@/lib/app-url";
import { normalizeDecimalAmountText } from "@/lib/decimalInput";
import type { SeraApiMode } from "@shared/gateway";

export const LIVE_PAYMENT_CHAIN_ID = 1;
export const TEST_PAYMENT_CHAIN_ID = 11155111;

export function resolvePaymentChainId(chainId: number | null | undefined, mode?: SeraApiMode | null): number {
  if (mode === "test") return TEST_PAYMENT_CHAIN_ID;
  if (mode === "live") return LIVE_PAYMENT_CHAIN_ID;
  return chainId === LIVE_PAYMENT_CHAIN_ID ? LIVE_PAYMENT_CHAIN_ID : TEST_PAYMENT_CHAIN_ID;
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
    return {
      ...parsed,
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
  const fracPart = (parts[1] || "").padEnd(decimals, "0").slice(0, decimals);
  const scale = 10n ** BigInt(decimals);
  return BigInt(intPart) * scale + BigInt(fracPart);
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
