import React, { useState } from "react";
import { Link, useLocation } from "wouter";
import { LayoutDashboard, Receipt, Settings, LogOut, Menu, X, Code2, ChevronLeft, ChevronRight, QrCode, UtensilsCrossed, ChevronDown, Copy, Check, WalletCards, ArrowUpDown, Download } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { cn, shortenAddress } from "@/lib/dashboard-utils";
import { useMerchantProfile } from "@/hooks/use-merchant";
import { useEvents } from "@/hooks/use-events";
import { motion, AnimatePresence } from "framer-motion";
import { SeraLogo } from "@/components/SeraPayHeader";
import { NetworkModeButton, NetworkSwitcherModal, useActiveNetworkMode } from "@/components/NetworkSwitcher";
import { buildPaymentQrValue, buildPaymentUrl, LIVE_PAYMENT_CHAIN_ID, TEST_PAYMENT_CHAIN_ID } from "@/lib/payment";
import { loadSeraCurrencies, type SeraCurrency } from "@/lib/currencyCalculator";
import { QRStyled, QR_STYLES, type QrMode, type QrStyle } from "@/components/QRStyled";
import { formatDecimalAmount, limitDecimalPlaces, normalizeDecimalAmountText } from "@/lib/decimalInput";
import { downloadPaymentQrCard } from "@/lib/qrDownload";

const navItems = [
  { name: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { name: "Wallets", href: "/wallets", icon: WalletCards },
  { name: "Transactions", href: "/transactions", icon: Receipt },
  { name: "Menu", href: "/menu-manager/pos", icon: UtensilsCrossed },
  { name: "Settings", href: "/settings", icon: Settings },
  { name: "Developer", href: "/developer", icon: Code2 },
];

const LS_SIDEBAR = "serapay_sidebar_collapsed";
const DASHBOARD_QR_STYLE_IDS = new Set(QR_STYLES.map((styleOption) => styleOption.id));
type DashboardExpiryOption = "none" | "15m" | "1h" | "24h" | "7d";
const DASHBOARD_EXPIRY_OPTIONS: Array<{ value: DashboardExpiryOption; label: string }> = [
  { value: "none", label: "No expiry" },
  { value: "15m", label: "15 min" },
  { value: "1h", label: "1 hour" },
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
];

function getDashboardExpiryMs(value: DashboardExpiryOption) {
  if (value === "15m") return 15 * 60 * 1000;
  if (value === "1h") return 60 * 60 * 1000;
  if (value === "24h") return 24 * 60 * 60 * 1000;
  if (value === "7d") return 7 * 24 * 60 * 60 * 1000;
  return 0;
}

function normalizeDashboardQrStyle(value: unknown, fallback: QrStyle = "rounded"): QrStyle {
  if (value === "classy") return "classy-rounded";
  return DASHBOARD_QR_STYLE_IDS.has(value as QrStyle) ? (value as QrStyle) : fallback;
}

function normalizeDashboardQrMode(value: unknown): QrMode {
  return value === "advanced" ? "advanced" : "standard";
}

function DashboardCoinDropdown({ value, onChange, currencies }: { value: string; onChange: (value: string) => void; currencies: SeraCurrency[] }) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement | null>(null);
  const options = React.useMemo(() => currencies.map((coin) => ({ symbol: coin.symbol, label: coin.symbol })), [currencies]);
  const selected = options.find((option) => option.symbol === value) || options[0] || { symbol: "", label: "Loading…" };

  React.useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div ref={ref} className="relative w-32 shrink-0">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex h-full min-h-12 w-full items-center justify-between gap-2 rounded-l-2xl border-r border-gray-100 bg-[#F0FCF8] px-3 text-left text-sm font-bold text-gray-950 outline-none transition-colors hover:bg-[#E8FAF4]"
      >
        <span className="min-w-0 truncate">{selected.label}</span>
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-gray-500 transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        <div className="serapay-hidden-scrollbar absolute left-0 top-[calc(100%+8px)] z-[90] max-h-64 w-44 overflow-y-auto rounded-2xl border border-gray-200 bg-white p-1.5 shadow-[0_18px_48px_rgba(10,31,26,0.16)]">
          {options.map((option) => {
            const active = option.symbol === value;
            return (
              <button
                key={option.symbol || "any"}
                type="button"
                onClick={() => { onChange(option.symbol); setOpen(false); }}
                className={cn(
                  "flex min-h-9 w-full items-center justify-between rounded-xl px-3 text-left text-sm font-semibold transition-colors",
                  active ? "bg-[#ECFFF7] text-[#00795C]" : "text-gray-800 hover:bg-gray-50",
                )}
              >
                <span>{option.label}</span>
                {active ? <Check className="h-3.5 w-3.5" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// ── Wallet Dropdown ──────────────────────────────────────────────────────────
function WalletDropdown({ address, onLogout, onNewPayment }: { address: string; onLogout: () => void; onNewPayment: () => void }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const dropdownRef = React.useRef<HTMLDivElement>(null);

  // Close on outside click
  React.useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const copyAddress = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  if (!address) return null;

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setOpen(v => !v)}
        className="flex h-9 items-center gap-1.5 rounded-full border border-border bg-muted px-3 text-xs font-mono text-foreground shadow-[0_1px_0_rgba(255,255,255,0.8)_inset] transition-colors hover:border-[#00D1A0]/35 hover:bg-white"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-[#00D1A0] shrink-0" />
        <span>{shortenAddress(address)}</span>
        <ChevronDown className={cn("w-3 h-3 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.97 }}
            transition={{ duration: 0.12 }}
            className="absolute right-0 top-11 z-50 w-[min(270px,calc(100vw-24px))] overflow-hidden rounded-[18px] border border-border bg-white shadow-[0_18px_48px_rgba(10,31,26,0.16)]"
          >
            {/* Connected wallet section */}
            <div className="border-b border-border px-4 py-3.5">
              <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.06em] text-muted-foreground">Connected Wallet</p>
              <div className="flex items-start gap-2">
                <p className="flex-1 break-all font-mono text-xs leading-relaxed text-[#14342B]">{address}</p>
                <button
                  onClick={copyAddress}
                  className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-muted text-muted-foreground transition-colors hover:text-foreground"
                  title="Copy address"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-[#00D1A0]" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>

            {/* Actions */}
            <div>
              <button
                type="button"
                onClick={() => { setOpen(false); onNewPayment(); }}
                className="flex min-h-[52px] w-full items-center justify-center gap-2.5 border-b border-border px-4 text-sm font-medium text-foreground transition-colors hover:bg-[#F4FFFA]"
              >
                <QrCode className="w-4 h-4 text-muted-foreground" />
                Generate Payment QR
              </button>
              <button
                onClick={() => { setOpen(false); onLogout(); }}
                className="flex min-h-[52px] w-full items-center justify-center gap-2.5 px-4 text-sm font-bold text-red-600 transition-colors hover:bg-red-50"
              >
                <LogOut className="w-4 h-4" />
                Disconnect
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Main Layout ───────────────────────────────────────────────────────────────
function DashboardPaymentModal({
  profile,
  walletAddress,
  chainId,
  onClose,
}: {
  profile: any;
  walletAddress: string;
  chainId: number;
  onClose: () => void;
}) {
  const [receiveCoin, setReceiveCoin] = useState("");
  const [payCoin, setPayCoin] = useState("");
  const [amount, setAmount] = useState("");
  const [payAmount, setPayAmount] = useState("");
  const [rateLoading, setRateLoading] = useState(false);
  const [rateError, setRateError] = useState("");
  const [currencies, setCurrencies] = useState<SeraCurrency[]>([]);
  const [registryError, setRegistryError] = useState("");
  const [copied, setCopied] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [description, setDescription] = useState("");
  const [expiryOption, setExpiryOption] = useState<DashboardExpiryOption>("none");
  const [singleUse, setSingleUse] = useState(false);
  const [expiryNow, setExpiryNow] = useState(() => Date.now());
  const receiverAddress = profile?.storeAddress || profile?.walletAddress || walletAddress;
  const merchantName = profile?.name || "SeraPay";
  const logo = profile?.logoData || undefined;
  const qrMode = normalizeDashboardQrMode(profile?.qrMode);
  const qrStyle = normalizeDashboardQrStyle(profile?.qrStyle);
  const qrFg = profile?.qrFgColor || "#000000";
  const qrBg = profile?.qrBgColor || "#ffffff";
  const receiveAmount = normalizeDecimalAmountText(amount);
  const displayPayAmount = normalizeDecimalAmountText(payAmount || amount);
  const resolvedReceiveCoin = receiveCoin;
  const resolvedPayCoin = payCoin || resolvedReceiveCoin;
  const payToken = currencies.find((coin) => coin.symbol === resolvedPayCoin) ?? null;
  const conversionReady = Boolean(resolvedReceiveCoin && resolvedPayCoin && (resolvedReceiveCoin === resolvedPayCoin || (displayPayAmount && !rateError)));
  const expiresAt = React.useMemo(() => {
    const duration = getDashboardExpiryMs(expiryOption);
    return duration > 0 ? expiryNow + duration : undefined;
  }, [expiryNow, expiryOption]);
  const paymentUrl = React.useMemo(() => receiverAddress && conversionReady ? buildPaymentUrl({
    receiverAddress,
    receiveCoin: resolvedReceiveCoin,
    amount: receiveAmount || undefined,
    payCoin: resolvedPayCoin,
    payAmount: displayPayAmount || undefined,
    chainId,
    merchantName,
    merchantIcon: logo,
    description: description.trim() || undefined,
    expiresAt,
    singleUse: singleUse || undefined,
  }) : "", [chainId, conversionReady, description, displayPayAmount, expiresAt, logo, merchantName, receiveAmount, receiverAddress, resolvedPayCoin, resolvedReceiveCoin, singleUse]);
  const paymentQrValue = React.useMemo(() => receiverAddress && paymentUrl ? buildPaymentQrValue({
    receiverAddress,
    coin: resolvedPayCoin,
    receiveCoin: resolvedReceiveCoin,
    amount: displayPayAmount || undefined,
    chainId,
    tokenAddress: payToken?.contractAddress,
    tokenDecimals: payToken?.decimals,
    paymentUrl,
  }) : "", [chainId, displayPayAmount, payToken, paymentUrl, receiverAddress, resolvedPayCoin, resolvedReceiveCoin]);

  React.useEffect(() => {
    let active = true;
    setRegistryError("");
    loadSeraCurrencies(chainId)
      .then((loaded) => {
        if (!active) return;
        setCurrencies(loaded);
        const configuredSymbol = String(profile?.receiveCoin || "").toUpperCase();
        const configured = configuredSymbol ? loaded.find((coin) => coin.symbol === configuredSymbol) : undefined;
        if (configuredSymbol && !configured) {
          setReceiveCoin("");
          setPayCoin("");
          setRegistryError(`${configuredSymbol} is not supported by Sera on this network`);
          return;
        }
        const preferred = configured || loaded.find((coin) => coin.symbol === "XSGD") || loaded[0];
        setReceiveCoin(preferred?.symbol || "");
        setPayCoin(preferred?.symbol || "");
      })
      .catch((error) => {
        if (!active) return;
        setCurrencies([]);
        setReceiveCoin("");
        setPayCoin("");
        setRegistryError(error instanceof Error ? error.message : "Unable to load Sera currencies");
      });
    return () => { active = false; };
  }, [chainId, profile?.receiveCoin]);

  React.useEffect(() => {
    if (!receiveAmount) {
      setPayAmount("");
      setRateError("");
      return;
    }
    if (resolvedReceiveCoin === resolvedPayCoin) {
      setPayAmount(receiveAmount);
      setRateError("");
      return;
    }
    let cancelled = false;
    setRateLoading(true);
    setPayAmount("");
    setRateError("");
    fetch(`/api/rates?from=${resolvedReceiveCoin}&to=${resolvedPayCoin}&chainId=${chainId}`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.detail || data.error || "Unable to fetch the Sera exchange rate");
        return data;
      })
      .then((data) => {
        if (cancelled) return;
        const rate = Number(data?.rate);
        if (Number.isFinite(rate) && rate > 0) setPayAmount(formatDecimalAmount(Number(receiveAmount) * rate));
        else throw new Error("Sera did not return an exchange rate");
      })
      .catch((error) => { if (!cancelled) setRateError(error instanceof Error ? error.message : "Unable to fetch the Sera exchange rate"); })
      .finally(() => { if (!cancelled) setRateLoading(false); });
    return () => { cancelled = true; };
  }, [amount, chainId, receiveAmount, resolvedPayCoin, resolvedReceiveCoin]);

  React.useEffect(() => {
    setExpiryNow(Date.now());
    if (expiryOption === "none") return;
    const id = window.setInterval(() => setExpiryNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [expiryOption, receiveAmount, displayPayAmount, resolvedPayCoin, resolvedReceiveCoin]);

  const copyLink = async () => {
    if (!paymentUrl) return;
    try {
      await navigator.clipboard.writeText(paymentUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {}
  };

  const downloadQr = async () => {
    if (!paymentUrl || !receiverAddress) return;
    await downloadPaymentQrCard({
      qrValue: paymentQrValue || paymentUrl,
      receiverAddress,
      amount: displayPayAmount,
      coin: resolvedPayCoin,
      merchantName,
      merchantLogo: logo || null,
      fgColor: qrFg,
      bgColor: qrBg,
      qrStyle,
      qrMode,
    });
  };

  return (
    <>
      <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm" onClick={onClose}>
        <div onClick={(event) => event.stopPropagation()} className="serapay-hidden-scrollbar max-h-[calc(100dvh-32px)] w-full max-w-[520px] overflow-y-auto rounded-3xl bg-white p-5 shadow-[0_30px_90px_rgba(10,31,26,0.22)]">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-gray-950">Generate QR code</h2>
              <p className="mt-1 text-sm text-gray-500">Create a payment QR without leaving the dashboard.</p>
            </div>
            <button onClick={onClose} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-400 hover:text-gray-700">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="mt-5 space-y-3">
            <div>
              <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.12em] text-gray-400">I receive</p>
              <div className="flex overflow-visible rounded-2xl border border-gray-200 bg-white shadow-sm focus-within:border-[#00C853] focus-within:ring-4 focus-within:ring-[#00C853]/10">
                <DashboardCoinDropdown value={receiveCoin} onChange={setReceiveCoin} currencies={currencies} />
                <input value={amount} onChange={(e) => setAmount(limitDecimalPlaces(e.target.value))} inputMode="decimal" placeholder="0.00" className="min-h-14 min-w-0 flex-1 px-4 text-right text-xl font-semibold outline-none" />
              </div>
            </div>

            <div className="flex items-center justify-center">
              <button type="button" onClick={() => { setReceiveCoin(payCoin); setPayCoin(receiveCoin); setAmount(displayPayAmount || amount); }} className="flex h-8 w-8 items-center justify-center rounded-full border border-[#00D1A0]/30 bg-white text-[#00A87A] shadow-sm">
                {rateLoading ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-[#00D1A0]/20 border-t-[#00D1A0]" /> : <ArrowUpDown className="h-4 w-4" />}
              </button>
            </div>

            <div>
              <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.12em] text-gray-400">Customer pays</p>
              <div className="flex overflow-visible rounded-2xl border border-gray-200 bg-white shadow-sm focus-within:border-[#00C853] focus-within:ring-4 focus-within:ring-[#00C853]/10">
                <DashboardCoinDropdown value={payCoin} onChange={setPayCoin} currencies={currencies} />
                <input value={payAmount} onChange={(e) => setPayAmount(limitDecimalPlaces(e.target.value))} inputMode="decimal" placeholder="0.00" className="min-h-14 min-w-0 flex-1 px-4 text-right text-xl font-semibold outline-none" />
              </div>
            </div>

            <div>
              <button
                type="button"
                onClick={() => setShowAdvanced((value) => !value)}
                className="flex items-center gap-1.5 px-1 text-[11px] font-bold uppercase tracking-[0.12em] text-gray-400 transition-colors hover:text-[#00A87A]"
              >
                <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", showAdvanced && "rotate-180")} />
                Advanced options
              </button>
              {showAdvanced ? (
                <div className="mt-2 rounded-2xl border border-gray-100 bg-white p-4 shadow-sm">
                  <div>
                    <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.1em] text-gray-400">Description (optional)</p>
                    <input
                      value={description}
                      onChange={(event) => setDescription(event.target.value.slice(0, 120))}
                      maxLength={120}
                      placeholder="e.g. Table 5 order, Invoice #1234..."
                      className="h-11 w-full rounded-xl border border-gray-100 bg-gray-50 px-3 text-sm font-medium text-gray-950 outline-none transition-all focus:border-[#00C853] focus:bg-white focus:ring-4 focus:ring-[#00C853]/10"
                    />
                  </div>
                  <div className="mt-4">
                    <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.1em] text-gray-400">Link expiry</p>
                    <div className="flex flex-wrap gap-2">
                      {DASHBOARD_EXPIRY_OPTIONS.map((option) => {
                        const active = expiryOption === option.value;
                        return (
                          <button
                            key={option.value}
                            type="button"
                            onClick={() => setExpiryOption(option.value)}
                            className={cn(
                              "min-h-8 rounded-full border px-3 text-xs font-bold transition-all",
                              active
                                ? "border-transparent bg-[#00D1A0] text-white"
                                : "border-gray-200 bg-white text-gray-500 hover:border-[#00D1A0]/45 hover:text-[#00A87A]",
                            )}
                          >
                            {option.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div className="mt-4 flex items-center justify-between gap-4">
                    <div>
                      <p className="text-sm font-bold text-gray-950">Single-use link</p>
                      <p className="mt-0.5 text-xs text-gray-500">Link becomes invalid after one payment</p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={singleUse}
                      onClick={() => setSingleUse((value) => !value)}
                      className={cn("relative h-7 w-12 rounded-full transition-colors", singleUse ? "bg-[#00D1A0]" : "bg-gray-200")}
                    >
                      <span className={cn("absolute top-1 h-5 w-5 rounded-full bg-white shadow-sm transition-all", singleUse ? "left-6" : "left-1")} />
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          {(registryError || rateError) ? (
            <p className="mt-3 rounded-xl border border-red-100 bg-red-50 px-3 py-2 text-xs font-semibold text-red-600">
              {registryError || rateError}
            </p>
          ) : null}

          {paymentUrl ? (
            <div className="mt-5 rounded-3xl border border-gray-100 bg-[#F8FAFB] p-4 text-center">
              <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-gray-400">Customer pays</p>
              <p className="mt-1 text-2xl font-extrabold text-gray-950">
                {(displayPayAmount || amount) ? `${displayPayAmount || amount} ` : ""}<span className="text-[#00C896]">{resolvedPayCoin}</span>
              </p>
              <div id="dashboard-payment-qr" onClick={copyLink} className="mx-auto mt-2 w-fit cursor-copy rounded-2xl bg-white p-2">
                <QRStyled value={paymentQrValue || paymentUrl} size={210} fgColor={qrFg} bgColor={qrBg} style={qrStyle} logo={logo} mode={qrMode} />
              </div>
              <button
                type="button"
                onClick={copyLink}
                className={cn(
                  "mt-0 text-xs font-bold leading-tight",
                  copied ? "text-[#00A87A]" : "text-gray-500 hover:text-[#00A87A]",
                )}
              >
                {copied ? "Link Copied!" : "Click QR to copy link"}
              </button>
              <div className="mt-4 grid grid-cols-2 gap-2">
                <button onClick={downloadQr} className="serapay-action-secondary serapay-hover-green flex min-h-11 items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white text-sm font-bold text-gray-950">
                  <Download className="h-4 w-4" /> Download QR
                </button>
                <button onClick={() => { window.open(paymentUrl, "_blank", "noopener,noreferrer"); }} className="serapay-action-secondary serapay-hover-green min-h-11 rounded-xl border border-gray-200 bg-white text-sm font-bold text-gray-950">
                  Pay now
                </button>
              </div>
            </div>
          ) : null}

        </div>
      </div>
    </>
  );
}

export function AppLayout({ children, pendingCount = 0, noPadding = false }: { children: React.ReactNode; pendingCount?: number; noPadding?: boolean }) {
  const { logout, walletAddress, apiKey, isAuthenticated, isLoading, login, retry, error } = useAuth();
  const [location] = useLocation();
  const { data: profile } = useMerchantProfile();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = React.useState(false);
  const [collapsed, setCollapsed] = React.useState(() => {
    try { return localStorage.getItem(LS_SIDEBAR) === "1"; } catch { return false; }
  });
  const [showNetworkModal, setShowNetworkModal] = useState(false);
  const [showPaymentModal, setShowPaymentModal] = useState(false);

  const { activeMode, networkInfo } = useActiveNetworkMode();

  useEvents();

  React.useEffect(() => {
    const open = () => setShowPaymentModal(true);
    window.addEventListener("serapay:new-payment", open);
    return () => window.removeEventListener("serapay:new-payment", open);
  }, []);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="relative flex h-16 w-16 items-center justify-center">
          <div className="absolute inset-0 rounded-full border-[3px] border-[#00D1A0]/15 border-t-[#00D1A0] animate-spin" />
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-white shadow-[0_10px_30px_rgba(0,209,160,0.16)]">
            <SeraLogo size={36} />
          </div>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-5 sm:p-6 text-center shadow-none">
          <div className="flex justify-center">
            <SeraLogo size={28} />
          </div>
          <h1 className="mt-4 text-xl font-semibold text-foreground">Sign in to continue</h1>
          {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}
          <button
            onClick={() => void login()}
            className="serapay-green-button mt-5 w-full rounded-xl bg-gradient-to-r from-[#00D1A0] to-[#00B88A] px-4 py-2.5 text-sm font-semibold text-white shadow-none transition-all duration-200"
          >
            Connect wallet
          </button>
        </div>
      </div>
    );
  }

  if (!apiKey) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <div className="w-full max-w-sm min-w-0 overflow-hidden rounded-2xl border border-border bg-card p-6 text-center shadow-sm">
          <div className="flex justify-center">
            <SeraLogo size={34} />
          </div>
          {error ? null : (
            <div className="relative mx-auto mt-6 flex h-14 w-14 items-center justify-center">
              <div className="absolute inset-0 rounded-full border-[3px] border-[#00D1A0]/15 border-t-[#00D1A0] animate-spin" />
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white shadow-[0_10px_30px_rgba(0,209,160,0.16)]">
                <SeraLogo size={30} />
              </div>
            </div>
          )}
          <h1 className="mt-5 text-lg font-semibold text-foreground">{error ? "Dashboard setup needs attention" : "Opening dashboard"}</h1>
          <p className="mt-2 text-sm text-muted-foreground leading-relaxed [overflow-wrap:anywhere]">
            {error || "We will continue automatically when your workspace is ready."}
          </p>
          {walletAddress ? <p className="mt-4 text-xs font-mono text-muted-foreground break-all [overflow-wrap:anywhere]">{walletAddress}</p> : null}
          {error ? (
            <button
              onClick={retry}
              className="serapay-green-button mt-5 w-full rounded-xl bg-gradient-to-r from-[#00D1A0] to-[#00B88A] px-4 py-2.5 text-sm font-semibold text-white transition-colors"
            >
              Retry account setup
            </button>
          ) : null}
          <button
            onClick={logout}
            className="mt-5 rounded-xl border border-border px-4 py-2.5 text-sm font-semibold text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            Disconnect
          </button>
        </div>
      </div>
    );
  }

  const toggleCollapsed = () => {
    setCollapsed(v => {
      const next = !v;
      try { localStorage.setItem(LS_SIDEBAR, next ? "1" : "0"); } catch {}
      return next;
    });
  };

  const displayAddress = profile?.walletAddress || walletAddress || "";
  const sidebarW = collapsed ? "w-[60px]" : "w-60";
  const mainPl = collapsed ? "md:pl-[60px]" : "md:pl-60";

  const paymentChainId = activeMode === "live" ? LIVE_PAYMENT_CHAIN_ID : TEST_PAYMENT_CHAIN_ID;

  return (
    <div className="h-dvh overflow-hidden bg-background flex w-full">
      {/* Desktop sidebar */}
      <aside className={cn("hidden md:flex flex-col border-r border-border bg-card fixed inset-y-0 z-10 transition-all duration-200", sidebarW)}>
        {/* Logo / header — clicking navigates to QR generator */}
        <div className={cn("h-14 flex items-center border-b border-border shrink-0 overflow-hidden", collapsed ? "justify-center px-0" : "justify-between gap-2 px-3")}>
          <Link href="/" className="flex items-center hover:opacity-80 transition-opacity cursor-pointer">
            {collapsed ? (
              <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-[#00D1A0] to-[#00B88A] flex items-center justify-center shrink-0 shadow-sm">
                <span className="text-white text-xs font-bold">S</span>
              </div>
            ) : (
              <SeraLogo size={36} />
            )}
          </Link>
          {!collapsed && (
            <NetworkModeButton
              activeMode={activeMode}
              onClick={() => setShowNetworkModal(true)}
              className="h-8 shrink-0"
              title={networkInfo.isTest ? "Test mode - click to switch to Live" : "Live mode - click to switch to Test"}
            />
          )}
        </div>

        {/* Nav */}
        <div className="p-2 flex-1 flex flex-col gap-0.5 overflow-hidden">
          {/* New Payment shortcut — always at top */}
          <button
            type="button"
            onClick={() => setShowPaymentModal(true)}
            className={cn(
              "flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-semibold transition-colors overflow-hidden mb-1",
              collapsed ? "justify-center px-2" : "",
              "serapay-green-button bg-gradient-to-r from-[#00D1A0] to-[#00B88A] text-white shadow-sm"
            )}
            title={collapsed ? "New Payment" : undefined}
          >
            <QrCode className="w-4 h-4 shrink-0" />
            {!collapsed && <span className="whitespace-nowrap">New Payment</span>}
          </button>
          {/* Divider */}
          <div className="border-t border-border my-1" />
          {navItems.map((item) => {
            const isActive = location === item.href;
            const showBadge = item.href === "/transactions" && pendingCount > 0;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors overflow-hidden",
                  collapsed ? "justify-center px-2" : "",
                  isActive
                    ? "bg-[#E6FAF5] text-[#00A87A] font-medium"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                )}
                title={collapsed ? item.name : undefined}
              >
                <div className="relative shrink-0">
                  <item.icon className="w-4 h-4" />
                  {showBadge && collapsed && (
                    <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-amber-500" />
                  )}
                </div>
                {!collapsed && <span className="whitespace-nowrap flex-1">{item.name}</span>}
                {!collapsed && showBadge && (
                  <span className="ml-auto shrink-0 min-w-[18px] h-[18px] rounded-full bg-amber-500 text-white text-[10px] font-bold flex items-center justify-center px-1">
                    {pendingCount > 99 ? "99+" : pendingCount}
                  </span>
                )}
              </Link>
            );
          })}
        </div>

        {/* Footer: address + logout + collapse toggle */}
        <div className={cn("p-2 border-t border-border space-y-1 shrink-0", collapsed && "flex flex-col items-center")}>
          {!collapsed && displayAddress && (
            <div className="px-3 py-1.5">
              <p className="text-[11px] text-muted-foreground font-mono truncate">{shortenAddress(displayAddress)}</p>
            </div>
          )}
          <button
            onClick={logout}
            className={cn(
              "flex w-full items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-muted-foreground hover:bg-red-50 hover:text-red-600 transition-colors",
              collapsed ? "justify-center px-2 w-auto" : ""
            )}
            title={collapsed ? "Disconnect" : undefined}
          >
            <LogOut className="w-4 h-4 shrink-0" />
            {!collapsed && "Disconnect"}
          </button>

          {/* Collapse toggle */}
          <button
            onClick={toggleCollapsed}
            className={cn(
              "flex w-full items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-muted-foreground hover:bg-accent hover:text-foreground transition-colors",
              collapsed ? "justify-center px-2 w-auto" : ""
            )}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed
              ? <ChevronRight className="w-4 h-4 shrink-0" />
              : <>
                  <ChevronLeft className="w-4 h-4 shrink-0" />
                  <span className="whitespace-nowrap text-xs">Collapse</span>
                </>
            }
          </button>
        </div>
      </aside>

      {/* Mobile slide-over */}
      <AnimatePresence>
        {isMobileMenuOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-40 bg-black/30 md:hidden"
            onClick={() => setIsMobileMenuOpen(false)}
          >
            <motion.div
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ type: "spring", damping: 25, stiffness: 200 }}
              className="w-60 h-full bg-card border-r border-border flex flex-col"
              onClick={e => e.stopPropagation()}
            >
              <div className="h-14 flex items-center px-5 border-b border-border">
                <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-[#00D1A0] to-[#00B88A] flex items-center justify-center mr-2.5">
                  <span className="text-white text-xs font-bold">S</span>
                </div>
                <span className="font-semibold text-sm">SeraPay</span>
                <button onClick={() => setIsMobileMenuOpen(false)} className="ml-auto text-muted-foreground">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="p-3 flex-1 flex flex-col gap-0.5">
                {/* New Payment shortcut */}
                <button
                  type="button"
                  onClick={() => { setIsMobileMenuOpen(false); setShowPaymentModal(true); }}
                  className="serapay-green-button flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-semibold bg-gradient-to-r from-[#00D1A0] to-[#00B88A] text-white mb-1"
                >
                  <QrCode className="w-4 h-4" />
                  New Payment
                </button>
                <div className="border-t border-border my-1" />
                {navItems.map((item) => {
                  const isActive = location === item.href;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={() => setIsMobileMenuOpen(false)}
                      className={cn(
                        "flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm transition-colors",
                        isActive ? "bg-[#E6FAF5] text-[#00A87A] font-medium" : "text-muted-foreground"
                      )}
                    >
                      <item.icon className="w-4 h-4" />
                      {item.name}
                    </Link>
                  );
                })}
              </div>
              <div className="p-3 border-t border-border">
                <button
                  onClick={logout}
                  className="flex w-full items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm text-red-600 bg-red-50"
                >
                  <LogOut className="w-4 h-4" />
                  Disconnect
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <main className={cn("flex-1 flex min-h-0 flex-col min-w-0 transition-all duration-200", mainPl)}>
        <header className="h-14 flex items-center justify-between px-4 md:px-6 border-b border-border bg-card sticky top-0 z-30">
          <div className="flex items-center gap-2">
            <button
              className="mr-1 md:hidden text-muted-foreground hover:text-foreground"
              onClick={() => setIsMobileMenuOpen(true)}
            >
              <Menu className="w-5 h-5" />
            </button>
            <NetworkModeButton
              activeMode={activeMode}
              onClick={() => setShowNetworkModal(true)}
              className={collapsed ? "md:flex" : "md:hidden"}
              title={networkInfo.isTest ? "Test mode - click to switch to Live" : "Live mode - click to switch to Test"}
            />
          </div>

          {/* Wallet address dropdown */}
          <WalletDropdown address={displayAddress} onLogout={logout} onNewPayment={() => setShowPaymentModal(true)} />
        </header>
        <div className={noPadding ? "flex-1 min-h-0 flex flex-col overflow-hidden" : "p-4 md:p-6 flex-1 min-h-0 overflow-y-auto w-full max-w-6xl mx-auto"}>
          {children}
        </div>
      </main>

      {/* Network switcher modal */}
      {showNetworkModal && <NetworkSwitcherModal onClose={() => setShowNetworkModal(false)} />}
      {showPaymentModal && (
        <DashboardPaymentModal
          profile={profile}
          walletAddress={displayAddress}
          chainId={paymentChainId}
          onClose={() => setShowPaymentModal(false)}
        />
      )}
    </div>
  );
}
