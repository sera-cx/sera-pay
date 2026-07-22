import React, { useMemo, useState, useEffect, useRef } from "react";
import { useParams, useLocation } from "wouter";
import { ShoppingCart, X, Plus, Minus, Image as ImageIcon, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { buildPaymentUrl, OrderItem } from "@/lib/payment";
import { getClientAppPath } from "@/lib/app-url";
import { SeraPayHeader } from "@/components/SeraPayHeader";
import { SeraPayFooter } from "@/components/SeraPayFooter";
import { CurrencySelectModal } from "@/components/CurrencySelectModal";
import { getCurrencyRate, loadSeraCurrencies, type SeraCurrency } from "@/lib/currencyCalculator";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Menu {
  id: string;
  name: string;
  description: string | null;
  slug: string;
  businessCategory?: string | null;
}

interface MenuItem {
  id: string;
  name: string;
  description: string | null;
  price: string;
  coin: string;
  imageUrl: string | null;
  category: string | null;
  soldOutUntil: string | null;
}

interface Merchant {
  name: string;
  description: string | null;
  logoData: string | null;
  walletAddress: string;
  receiveCoin: string;
}

interface MenuData {
  menu: Menu;
  merchant: Merchant;
  items: MenuItem[];
}

interface CartEntry {
  item: MenuItem;
  qty: number;
}

// ── Coin badge colors ─────────────────────────────────────────────────────────

const COIN_COLORS: Record<string, { bg: string; text: string }> = {
  XSGD: { bg: "#FFF3E0", text: "#E65100" },
  IDRX: { bg: "#E8F5E9", text: "#2E7D32" },
  MYRT: { bg: "#E3F2FD", text: "#1565C0" },
  EURC: { bg: "#EDE7F6", text: "#4527A0" },
  AUDD: { bg: "#FFF8E1", text: "#F57F17" },
  USDC: { bg: "#E3F2FD", text: "#1565C0" },
  USDT: { bg: "#E8F5E9", text: "#2E7D32" },
  PYUSD: { bg: "#FCE4EC", text: "#880E4F" },
  DAI: { bg: "#FFF3E0", text: "#E65100" },
};

function coinStyle(coin: string) {
  return COIN_COLORS[coin] || { bg: "#F5F5F5", text: "#424242" };
}

function formatTokenAmount(value: number) {
  if (!Number.isFinite(value)) return "0.00";
  if (value >= 1) return value.toFixed(2);
  return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, ".00");
}

function isItemSoldOutToday(item: { soldOutUntil?: string | null }) {
  if (!item.soldOutUntil) return false;
  const until = new Date(item.soldOutUntil).getTime();
  return Number.isFinite(until) && until > Date.now();
}

async function totalItemsInCoin(items: Array<{ price: string; coin?: string; qty: number }>, targetCoin: string, fallbackCoin: string, chainId?: number) {
  let total = 0;
  const rateCache = new Map<string, number>();
  for (const item of items) {
    const sourceCoin = (item.coin || fallbackCoin).toUpperCase();
    const lineTotal = Number(item.price) * item.qty;
    if (!Number.isFinite(lineTotal)) continue;
    if (sourceCoin === targetCoin) {
      total += lineTotal;
      continue;
    }
    const pair = `${sourceCoin}:${targetCoin}`;
    let rate = rateCache.get(pair);
    if (!rate) {
      rate = (await getCurrencyRate(sourceCoin, targetCoin, chainId)).rate;
      rateCache.set(pair, rate);
    }
    total += lineTotal * rate;
  }
  return formatTokenAmount(total);
}

// ── Item Card ─────────────────────────────────────────────────────────────────

function ItemCard({
  item,
  cartEntry,
  displayPrice,
  displayCoin,
  onAdd,
  onRemove,
}: {
  item: MenuItem;
  cartEntry?: CartEntry;
  displayPrice?: string;
  displayCoin?: string;
  onAdd: (item: MenuItem) => void;
  onRemove: (itemId: string) => void;
}) {
  const shownCoin = displayCoin || item.coin;
  const cs = coinStyle(shownCoin);
  const price = Number(displayPrice ?? item.price);
  const soldOut = isItemSoldOutToday(item);

  return (
    <div className="relative bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden flex flex-col">
      {item.imageUrl ? (
        <div className="aspect-[4/3] overflow-hidden bg-gray-50">
          <img src={item.imageUrl} alt={item.name} className="w-full h-full object-cover" />
        </div>
      ) : (
        <div className="aspect-[4/3] bg-gray-50 flex items-center justify-center">
          <ImageIcon className="w-8 h-8 text-gray-200" />
        </div>
      )}
      <div className="p-3 flex flex-col flex-1">
        <div className="flex-1 min-w-0 mb-2">
          <h3 className="font-semibold text-gray-900 text-sm leading-tight">{item.name}</h3>
          {item.description && (
            <p className="text-xs text-gray-500 mt-0.5 leading-relaxed line-clamp-2">{item.description}</p>
          )}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span
            className="text-xs font-bold px-2 py-0.5 rounded-full shrink-0"
            style={{ background: cs.bg, color: cs.text }}
          >
            {Number.isFinite(price) ? (price % 1 === 0 ? price.toFixed(0) : price.toFixed(2)) : item.price} {shownCoin}
          </span>
          {cartEntry ? (
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => onRemove(item.id)}
                className="w-6 h-6 rounded-full border border-gray-200 flex items-center justify-center hover:bg-gray-100 transition-colors"
              >
                <Minus className="w-3 h-3 text-gray-600" />
              </button>
              <span className="text-sm font-bold text-gray-900 w-4 text-center">{cartEntry.qty}</span>
              <button
                onClick={() => onAdd(item)}
                disabled={soldOut}
                className="w-6 h-6 rounded-full bg-[#00C853] text-white flex items-center justify-center hover:bg-[#00B847] transition-colors disabled:bg-gray-200 disabled:text-gray-400"
              >
                <Plus className="w-3 h-3" />
              </button>
            </div>
          ) : (
            <button
              onClick={() => onAdd(item)}
              disabled={soldOut}
              className="w-7 h-7 rounded-full bg-[#E6FAF5] text-[#00A87A] flex items-center justify-center hover:bg-[#00C853] hover:text-white transition-colors shrink-0 disabled:bg-gray-100 disabled:text-gray-300"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
      {soldOut && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-white/75 backdrop-blur-[1px]">
          <span className="rounded-full bg-gray-900 px-3 py-1 text-xs font-bold uppercase tracking-wide text-white shadow-sm">Out of stock</span>
        </div>
      )}
    </div>
  );
}

// ── Cart Drawer ───────────────────────────────────────────────────────────────

function CartDrawer({
  cart,
  merchant,
  menu,
  onUpdateQty,
  onClear,
  onClose,
  onPay,
  creatingOrder,
  displayTotal,
  displayCoin,
  checkoutDisabled,
}: {
  cart: CartEntry[];
  merchant: Merchant;
  menu: Menu;
  onUpdateQty: (itemId: string, delta: number) => void;
  onClear: () => void;
  onClose: () => void;
  onPay: () => void;
  creatingOrder: boolean;
  displayTotal: string;
  displayCoin: string;
  checkoutDisabled?: boolean;
}) {
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" onClick={() => setConfirmClose(true)} />
      <div className="pointer-events-none fixed inset-0 z-[51] flex items-end justify-center">
        <div className="pointer-events-auto bg-white rounded-t-2xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col">
          <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-gray-100">
            <div className="flex items-center gap-2">
              <ShoppingCart className="w-4 h-4 text-[#00C853]" />
              <h3 className="font-semibold text-gray-900">Your Order</h3>
              <span className="text-xs bg-[#E6FAF5] text-[#00A87A] px-2 py-0.5 rounded-full font-medium">
                {cart.reduce((s, e) => s + e.qty, 0)} item{cart.reduce((s, e) => s + e.qty, 0) === 1 ? "" : "s"}
              </span>
            </div>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-3 space-y-3">
            {cart.map(entry => (
              <div key={entry.item.id} className="flex items-center gap-3">
                {entry.item.imageUrl ? (
                  <img src={entry.item.imageUrl} alt={entry.item.name} className="w-10 h-10 rounded-xl object-cover shrink-0" />
                ) : (
                  <div className="w-10 h-10 rounded-xl bg-gray-100 flex items-center justify-center shrink-0">
                    <ImageIcon className="w-4 h-4 text-gray-300" />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{entry.item.name}</p>
                  <p className="text-xs text-gray-500">{parseFloat(entry.item.price).toFixed(2)} {entry.item.coin}</p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={() => onUpdateQty(entry.item.id, -1)}
                    className="w-6 h-6 rounded-full border border-gray-200 flex items-center justify-center hover:bg-gray-100 transition-colors"
                  >
                    <Minus className="w-3 h-3" />
                  </button>
                  <span className="text-sm font-bold w-5 text-center">{entry.qty}</span>
                  <button
                    onClick={() => onUpdateQty(entry.item.id, 1)}
                    className="w-6 h-6 rounded-full border border-gray-200 flex items-center justify-center hover:bg-gray-100 transition-colors"
                  >
                    <Plus className="w-3 h-3" />
                  </button>
                </div>
                <p className="text-sm font-semibold text-gray-900 w-16 text-right shrink-0">
                  {(parseFloat(entry.item.price) * entry.qty).toFixed(2)}
                </p>
              </div>
            ))}
          </div>

          <div className="px-5 pb-6 pt-3 border-t border-gray-100 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">Total</span>
              <span className="text-xl font-bold text-gray-900">
                {displayTotal} <span className="text-sm font-normal text-gray-500">{displayCoin}</span>
              </span>
            </div>
            <Button
              onClick={onPay}
              disabled={creatingOrder || checkoutDisabled}
              className="serapay-green-button serapay-shine-button w-full bg-gradient-to-r from-[#00C896] via-[#00A87A] to-[#008A64] font-semibold text-white"
            >
              {creatingOrder ? "Preparing order..." : checkoutDisabled ? "Updating prices..." : `Pay Now — ${displayTotal} ${displayCoin}`}
            </Button>
            <button
              onClick={() => setConfirmClear(true)}
              className="w-full text-xs font-semibold text-red-500 hover:text-red-600 transition-colors text-center"
            >
              Clear order
            </button>
          </div>
        </div>
      </div>
      {confirmClear && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-xs rounded-2xl bg-white p-5 shadow-2xl">
            <h3 className="text-base font-semibold text-gray-900">Clear your order?</h3>
            <p className="mt-1 text-sm text-gray-500">This removes every item before checkout.</p>
            <div className="mt-5 grid grid-cols-2 gap-2">
              <Button variant="outline" onClick={() => setConfirmClear(false)} className="bg-white">Cancel</Button>
              <Button onClick={() => { onClear(); setConfirmClear(false); }} variant="destructive" className="bg-red-500 text-white hover:bg-red-600">Clear</Button>
            </div>
          </div>
        </div>
      )}
      {confirmClose && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-2xl">
            <h3 className="text-base font-semibold text-gray-950">Forgotten to add on something?</h3>
            <p className="mt-1 text-sm text-gray-500">Close your order and go back to the menu?</p>
            <div className="mt-5 grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                onClick={() => { setConfirmClose(false); onClose(); }}
                className="border-[#00A87A] bg-white text-[#00A87A] hover:border-[#008A64] hover:bg-white hover:text-[#008A64]"
              >
                Yes
              </Button>
              <Button
                onClick={() => setConfirmClose(false)}
                className="serapay-green-button bg-gradient-to-r from-[#00C896] via-[#00A87A] to-[#008A64] text-white"
                autoFocus
              >
                No
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

function PaxStartModal({
  pax,
  onChange,
  onCancel,
  onConfirm,
}: {
  pax: number;
  onChange: (value: number) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [manualEntry, setManualEntry] = useState(false);
  const lastTapRef = useRef(0);
  const clampPax = (value: number) => Math.max(1, Math.min(99, value || 1));
  const setPax = (value: number) => onChange(clampPax(value));
  const wheelOffsets = [-2, -1, 0, 1, 2];
  const revealManualEntry = () => setManualEntry(true);
  const handleTouchEnd = () => {
    const now = Date.now();
    if (now - lastTapRef.current < 320) {
      revealManualEntry();
      lastTapRef.current = 0;
      return;
    }
    lastTapRef.current = now;
  };

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/35 backdrop-blur-sm" onClick={onCancel} />
      <div className="fixed inset-0 z-[51] flex items-center justify-center p-4">
        <div className="w-full max-w-sm rounded-3xl bg-white p-5 shadow-[0_24px_70px_rgba(10,31,26,0.18)]">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold text-gray-950">How many pax?</h3>
              <p className="mt-1 text-sm text-gray-500">Choose the table size before ordering.</p>
            </div>
            <button onClick={onCancel} className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-100 text-gray-400 hover:text-gray-600">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="mt-5 rounded-3xl border border-[#00A87A]/10 bg-gradient-to-b from-[#F4FFFB] to-white p-4">
            <div className="mx-auto flex max-w-[210px] flex-col items-center">
              <button
                type="button"
                onClick={() => setPax(pax - 1)}
                className="flex h-9 w-14 items-center justify-center rounded-full border border-[#00A87A]/15 bg-white text-[#00A87A] shadow-sm transition-colors hover:border-[#00A87A]/40"
              >
                <ChevronUp className="h-4 w-4" />
              </button>

              <div
                className="relative my-2 flex h-44 w-full items-center justify-center overflow-hidden rounded-[28px] bg-white shadow-inner"
                onWheel={(event) => {
                  event.preventDefault();
                  setPax(pax + (event.deltaY > 0 ? 1 : -1));
                }}
              >
                <div className="pointer-events-none absolute inset-x-4 top-1/2 h-16 -translate-y-1/2 rounded-2xl border border-[#00A87A]/20 bg-[#E6FAF5]/70" />
                <div className="pointer-events-none absolute inset-x-0 top-0 h-12 bg-gradient-to-b from-white to-white/0" />
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-white to-white/0" />
                <div className="relative z-10 flex w-full flex-col items-center gap-1">
                  {wheelOffsets.map(offset => {
                    const value = pax + offset;
                    const distance = Math.abs(offset);
                    const selected = offset === 0;
                    if (value < 1 || value > 99) return <div key={offset} className="h-10 w-28" />;
                    if (selected && manualEntry) {
                      return (
                        <div key={offset} className="flex h-10 w-28 scale-110 items-center justify-center rounded-2xl text-center transition-all">
                          <input
                            autoFocus
                            value={pax}
                            onChange={event => setPax(Number(event.target.value))}
                            onBlur={() => setManualEntry(false)}
                            type="number"
                            min={1}
                            max={99}
                            inputMode="numeric"
                            className="h-12 w-24 rounded-2xl border border-[#00A87A]/25 bg-white text-center text-3xl font-black text-[#008A64] outline-none ring-4 ring-[#00A87A]/10"
                          />
                        </div>
                      );
                    }
                    return (
                      <button
                        key={offset}
                        type="button"
                        onClick={() => setPax(value)}
                        onDoubleClick={selected ? revealManualEntry : undefined}
                        onTouchEnd={selected ? handleTouchEnd : undefined}
                        className={`flex h-10 w-28 items-center justify-center rounded-2xl text-center transition-all ${
                          selected
                            ? "scale-110 bg-transparent text-4xl font-black text-[#008A64]"
                            : distance === 1
                              ? "text-lg font-bold text-gray-400"
                              : "text-sm font-semibold text-gray-300"
                        }`}
                      >
                        {value}
                      </button>
                    );
                  })}
                </div>
              </div>

              <button
                type="button"
                onClick={() => setPax(pax + 1)}
                className="flex h-9 w-14 items-center justify-center rounded-full border border-[#00A87A]/15 bg-white text-[#00A87A] shadow-sm transition-colors hover:border-[#00A87A]/40"
              >
                <ChevronDown className="h-4 w-4" />
              </button>
            </div>
          </div>
          <Button onClick={onConfirm} className="serapay-green-button serapay-shine-button mt-5 h-12 w-full bg-gradient-to-r from-[#00C896] via-[#00A87A] to-[#008A64] text-white">
            Start ordering
          </Button>
        </div>
      </div>
    </>
  );
}

export default function MenuPublicPage() {
  const params = useParams<{ slug: string }>();
  const [, navigate] = useLocation();
  const [data, setData] = useState<MenuData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cart, setCart] = useState<CartEntry[]>([]);
  const [showCart, setShowCart] = useState(false);
  const [pax, setPax] = useState(1);
  const [paxDraft, setPaxDraft] = useState(1);
  const [started, setStarted] = useState(false);
  const [showPaxPrompt, setShowPaxPrompt] = useState(false);
  const [creatingOrder, setCreatingOrder] = useState(false);
  const [displayCoin, setDisplayCoin] = useState("");
  const [showCurrencySelect, setShowCurrencySelect] = useState(false);
  const [currencyOptions, setCurrencyOptions] = useState<SeraCurrency[]>([]);
  const [convertedPrices, setConvertedPrices] = useState<Record<string, string>>({});
  const [convertingPrices, setConvertingPrices] = useState(false);
  const paymentChainId = useMemo(() => {
    if (typeof window === "undefined") return 1;
    const value = Number(new URLSearchParams(window.location.search).get("chainId") || 1);
    return Number.isInteger(value) && value > 0 ? value : 1;
  }, []);
  const currencyList = currencyOptions;
  const startSessionKey = params.slug ? `serapay_menu_started_${params.slug}` : "";

  useEffect(() => {
    if (!params.slug) return;
    try {
      setStarted(sessionStorage.getItem(`serapay_menu_started_${params.slug}`) === "1");
    } catch {
      setStarted(false);
    }
    fetch(`/api/public/menu/${params.slug}`)
      .then(r => {
        if (!r.ok) throw new Error(r.status === 404 ? "Menu not found" : "Failed to load menu");
        return r.json();
      })
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [params.slug]);

  const confirmStartOrdering = () => {
    const nextPax = Math.max(1, Math.min(99, paxDraft || 1));
    setPax(nextPax);
    setStarted(true);
    setShowPaxPrompt(false);
    try {
      if (startSessionKey) sessionStorage.setItem(startSessionKey, "1");
    } catch {}
  };

  useEffect(() => {
    loadSeraCurrencies(paymentChainId).then(setCurrencyOptions).catch(() => setCurrencyOptions([]));
  }, [paymentChainId]);

  useEffect(() => {
    if (!data || currencyOptions.length === 0) return;
    const preferred = String(data.merchant.receiveCoin || data.items[0]?.coin || "").toUpperCase();
    setDisplayCoin((current) => {
      if (current && currencyOptions.some((coin) => coin.symbol === current)) return current;
      return currencyOptions.find((coin) => coin.symbol === preferred)?.symbol || currencyOptions[0].symbol;
    });
  }, [currencyOptions, data]);

  useEffect(() => {
    if (!data) return;
    const soldOutIds = new Set(data.items.filter(isItemSoldOutToday).map(item => item.id));
    if (soldOutIds.size === 0) return;
    setCart(prev => prev.filter(entry => !soldOutIds.has(entry.item.id)));
  }, [data]);

  useEffect(() => {
    if (!data || !displayCoin) return;
    let cancelled = false;
    setConvertingPrices(true);
    (async () => {
      try {
        const rateCache = new Map<string, number>();
        const next: Record<string, string> = {};
        for (const item of data.items) {
          const sourceCoin = item.coin.toUpperCase();
          if (sourceCoin === displayCoin) {
            next[item.id] = formatTokenAmount(Number(item.price));
            continue;
          }
          const pair = `${sourceCoin}:${displayCoin}`;
          let rate = rateCache.get(pair);
          if (!rate) {
            rate = (await getCurrencyRate(sourceCoin, displayCoin, paymentChainId)).rate;
            rateCache.set(pair, rate);
          }
          next[item.id] = formatTokenAmount(Number(item.price) * rate);
        }
        if (!cancelled) setConvertedPrices(next);
      } catch {
        if (!cancelled) setConvertedPrices({});
      } finally {
        if (!cancelled) setConvertingPrices(false);
      }
    })();
    return () => { cancelled = true; };
  }, [data, displayCoin, paymentChainId]);

  const handleAdd = (item: MenuItem) => {
    if (isItemSoldOutToday(item)) return;
    setCart(prev => {
      const existing = prev.find(e => e.item.id === item.id);
      if (existing) return prev.map(e => e.item.id === item.id ? { ...e, qty: e.qty + 1 } : e);
      return [...prev, { item, qty: 1 }];
    });
  };

  const handleRemove = (itemId: string) => {
    setCart(prev => {
      const existing = prev.find(e => e.item.id === itemId);
      if (!existing) return prev;
      if (existing.qty <= 1) return prev.filter(e => e.item.id !== itemId);
      return prev.map(e => e.item.id === itemId ? { ...e, qty: e.qty - 1 } : e);
    });
  };

  const handleUpdateQty = (itemId: string, delta: number) => {
    if (delta > 0) handleAdd(data!.items.find(i => i.id === itemId)!);
    else handleRemove(itemId);
  };

  const handlePay = async () => {
    if (!data) return;
    const { merchant, menu } = data;
    setCreatingOrder(true);
    try {
      if (currencyOptions.length === 0) throw new Error("The Sera currency registry is unavailable. Please try again.");
      const requestedReceiveCoin = String(merchant.receiveCoin || cart[0]?.item.coin || "").toUpperCase();
      if (!currencyOptions.some((coin) => coin.symbol === requestedReceiveCoin)) {
        throw new Error(`${requestedReceiveCoin || "The merchant currency"} is not supported by Sera on this network.`);
      }
      if (!currencyOptions.some((coin) => coin.symbol === displayCoin)) {
        throw new Error(`${displayCoin || "The payment currency"} is not supported by Sera on this network.`);
      }
      const response = await fetch(`/api/public/menu/${menu.slug}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pax, items: cart.map(e => ({ id: e.item.id, qty: e.qty })) }),
      });
      const order = await response.json();
      if (!response.ok) throw new Error(order.error || "Unable to create order");
      const orderItems: OrderItem[] = (order.items || []).map((item: any) => ({
        id: item.id,
        n: item.name,
        p: item.price,
        q: item.qty,
        c: item.coin,
      }));
      const receiveCoin = (merchant.receiveCoin || order.coin || cart[0]?.item.coin || "USDC").toUpperCase();
      const receiveAmount = await totalItemsInCoin(
        orderItems.map((item) => ({ price: item.p, coin: item.c, qty: item.q })),
        receiveCoin,
        receiveCoin,
        paymentChainId,
      );
      const url = buildPaymentUrl({
        receiverAddress: merchant.walletAddress,
        receiveCoin,
        amount: receiveAmount,
        chainId: paymentChainId,
        payCoin: displayCoin || receiveCoin,
        merchantName: merchant.name,
        merchantIcon: merchant.logoData || undefined,
        orderItems,
        menuName: menu.name,
        menuSlug: menu.slug,
        orderId: order.id,
        description: `Order: ${cart.map(e => `${e.qty}× ${e.item.name}`).join(", ")}`,
      });
      navigate(getClientAppPath(url));
    } catch (e: any) {
      alert(e.message || "Unable to create order");
    } finally {
      setCreatingOrder(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#F5F7FA] flex items-center justify-center">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-[#00C853] border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm text-gray-500">Loading menu…</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-[#F5F7FA] flex items-center justify-center p-4">
        <div className="text-center">
          <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <X className="w-8 h-8 text-gray-400" />
          </div>
          <h2 className="font-semibold text-gray-900 mb-1">Menu not found</h2>
          <p className="text-sm text-gray-500">{error || "This menu doesn't exist or has been removed."}</p>
        </div>
      </div>
    );
  }

  const { menu, merchant, items } = data;
  const totalCount = cart.reduce((s, e) => s + e.qty, 0);
  const activeDisplayCoin = (displayCoin || merchant.receiveCoin || cart[0]?.item.coin || "USDC").toUpperCase();
  const missingConvertedCartPrice = cart.some((entry) => entry.item.coin.toUpperCase() !== activeDisplayCoin && !convertedPrices[entry.item.id]);
  const displayTotalNumber = cart.reduce((sum, entry) => {
    const price = entry.item.coin.toUpperCase() === activeDisplayCoin ? entry.item.price : convertedPrices[entry.item.id];
    return sum + Number(price || 0) * entry.qty;
  }, 0);
  const totalPending = convertingPrices || missingConvertedCartPrice;
  const displayTotal = totalPending ? "Updating..." : formatTokenAmount(displayTotalNumber);
  const merchantDescription = merchant.description || menu.description || "Browse the menu and place your order with stablecoin checkout.";

  if (!started) {
    return (
      <div className="flex min-h-screen flex-col bg-[#F5F7FA]">
        <SeraPayHeader maxWidth={1240} compact />
        <main className="mx-auto flex w-full max-w-[1240px] flex-1 items-center justify-center px-4 py-8">
          <section className="w-full max-w-md rounded-3xl border border-gray-100 bg-white p-6 text-center shadow-[0_18px_50px_rgba(10,31,26,0.08)]">
            <div className="mx-auto mb-4 flex h-20 w-20 items-center justify-center overflow-hidden rounded-2xl border border-[#00D1A0]/20 bg-[#E6FAF5]">
              {merchant.logoData ? (
                <img src={merchant.logoData} alt={merchant.name} className="h-full w-full object-cover" />
              ) : (
                <span className="text-xl font-bold text-[#00A87A]">{merchant.name.slice(0, 2).toUpperCase()}</span>
              )}
            </div>
            <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-[#00A87A]">{menu.name}</p>
            <h1 className="mt-1 text-2xl font-bold text-gray-950">{merchant.name}</h1>
            <p className="mt-3 text-sm leading-relaxed text-gray-500">{merchantDescription}</p>
            <Button
              onClick={() => { setPaxDraft(pax); setShowPaxPrompt(true); }}
              className="serapay-green-button serapay-shine-button mt-6 h-12 w-full bg-gradient-to-r from-[#00C896] via-[#00A87A] to-[#008A64] text-white"
            >
              Start ordering
            </Button>
          </section>
        </main>
        <SeraPayFooter compact />
        {showPaxPrompt && (
          <PaxStartModal
            pax={paxDraft}
            onChange={setPaxDraft}
            onCancel={() => setShowPaxPrompt(false)}
            onConfirm={confirmStartOrdering}
          />
        )}
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-[#F5F7FA]" style={{ paddingBottom: totalCount > 0 && !showCart ? "180px" : "0" }}>
      <SeraPayHeader
        maxWidth={1240}
        compact
        centerContent={(
          <div className="flex min-w-0 items-center gap-2.5">
            {merchant.logoData ? (
              <img src={merchant.logoData} alt={merchant.name} className="w-8 h-8 rounded-full object-cover shrink-0" />
            ) : (
              <div className="w-8 h-8 rounded-full bg-[#E6FAF5] flex items-center justify-center shrink-0">
                <span className="text-xs font-bold text-[#00A87A]">{merchant.name.slice(0, 2).toUpperCase()}</span>
              </div>
            )}
            <div className="min-w-0">
              <p className="font-semibold text-gray-900 text-sm truncate">{merchant.name}</p>
              <p className="text-xs text-gray-500 truncate">{menu.name}</p>
            </div>
          </div>
        )}
        rightContent={(
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowCurrencySelect(true)}
              className="flex h-9 items-center gap-1 rounded-full border border-gray-200 bg-white px-3 text-xs font-bold text-gray-700 shadow-sm transition-colors hover:border-[#00C853] hover:text-[#00A87A]"
            >
              {convertingPrices ? "..." : activeDisplayCoin}
              <ChevronDown className="h-3 w-3" />
            </button>
            {totalCount > 0 && (
              <button
                onClick={() => setShowCart(true)}
                className="relative rounded-xl bg-[#E6FAF5] p-2 text-[#00A87A] transition-colors hover:bg-[#00C853]/20"
              >
                <ShoppingCart className="w-4 h-4" />
                <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-[#00C853] text-[9px] font-bold text-white">
                  {totalCount > 9 ? "9+" : totalCount}
                </span>
              </button>
            )}
          </div>
        )}
      />

      <main className="mx-auto w-full max-w-[1240px] flex-1 px-4 py-6">
      <div className="mx-auto max-w-2xl lg:max-w-none">
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#00C853] text-white flex items-center justify-center font-bold text-sm shrink-0 overflow-hidden">
              {merchant.logoData ? <img src={merchant.logoData} alt={merchant.name} className="h-full w-full object-cover" /> : merchant.name.slice(0, 2).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-[#00A87A]">SeraPay Menu</p>
              <p className="text-sm font-semibold text-gray-900 truncate">{merchant.name}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-xs text-gray-500">Pax</span>
              <input
                value={pax}
                onChange={e => setPax(Math.max(1, Math.min(99, Number(e.target.value) || 1)))}
                type="number"
                min={1}
                max={99}
                inputMode="numeric"
                className="w-16 h-9 rounded-xl border border-gray-200 text-center text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-[#00C853]/30"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Menu description */}
      {menu.description && (
        <div className="mx-auto max-w-2xl pt-4 lg:max-w-none">
          <p className="text-sm text-gray-600 bg-white rounded-xl px-4 py-3 border border-gray-100">{menu.description}</p>
        </div>
      )}

      {/* Items grid */}
      <div className="mx-auto max-w-2xl py-4 lg:max-w-none">
        {items.length === 0 ? (
          <div className="text-center py-16">
            <ShoppingCart className="w-10 h-10 text-gray-300 mx-auto mb-3" />
            <p className="text-gray-500 text-sm">No items in this menu yet.</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {items.map(item => {
              const itemDisplayPrice = item.coin.toUpperCase() === activeDisplayCoin ? item.price : convertedPrices[item.id];
              return (
                <ItemCard
                  key={item.id}
                  item={item}
                  cartEntry={cart.find(e => e.item.id === item.id)}
                  displayPrice={itemDisplayPrice}
                  displayCoin={itemDisplayPrice ? activeDisplayCoin : item.coin}
                  onAdd={handleAdd}
                  onRemove={handleRemove}
                />
              );
            })}
          </div>
        )}
      </div>
      </main>

      <SeraPayFooter compact />

      {/* Sticky cart bar */}
      {totalCount > 0 && !showCart && (
        <div
          className="pointer-events-none fixed inset-x-0 z-40 px-4 pt-3"
          style={{ bottom: "max(10vh, calc(env(safe-area-inset-bottom) + 72px))" }}
        >
          <div className="pointer-events-auto mx-auto max-w-2xl lg:max-w-[720px]">
            <button
              onClick={() => setShowCart(true)}
              className="serapay-green-button w-full flex items-center justify-between px-5 py-3.5 rounded-2xl bg-gradient-to-r from-[#00C896] via-[#00A87A] to-[#008A64] shadow-[0_16px_34px_rgba(0,138,100,0.25)] text-white font-semibold"
            >
              <div className="flex items-center gap-2">
                <ShoppingCart className="w-4 h-4" />
                <span className="text-sm">{totalCount} item{totalCount !== 1 ? "s" : ""}</span>
              </div>
              <span className="text-sm">View Order · {totalPending ? "Updating prices" : `${displayTotal} ${activeDisplayCoin}`}</span>
            </button>
          </div>
        </div>
      )}

      {/* Cart drawer */}
      {showCart && (
        <CartDrawer
          cart={cart}
          merchant={merchant}
          menu={menu}
          onUpdateQty={handleUpdateQty}
          onClear={() => { setCart([]); setShowCart(false); }}
          onClose={() => setShowCart(false)}
          onPay={handlePay}
          creatingOrder={creatingOrder}
          displayTotal={displayTotal}
          displayCoin={activeDisplayCoin}
          checkoutDisabled={totalPending}
        />
      )}

      {showCurrencySelect && (
        <CurrencySelectModal
          title="Display Currency"
          subtitle="Menu prices and order total update with live rates."
          currencies={currencyList}
          selectedSymbol={activeDisplayCoin}
          onSelect={(symbol) => { setDisplayCoin(symbol); setShowCurrencySelect(false); }}
          onClose={() => setShowCurrencySelect(false)}
        />
      )}
    </div>
  );
}
