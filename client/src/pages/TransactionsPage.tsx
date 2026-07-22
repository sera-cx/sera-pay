import React, { useState, useMemo, useRef, useEffect } from "react";
import { AppLayout } from "@/components/AppLayout";
import { Card, Table, TableHeader, TableBody, TableRow, TableHead, TableCell, Badge, Skeleton } from "@/components/dashboard-ui";
import { useCancelTransaction, useTransactions } from "@/hooks/use-transactions";
import type { Transaction } from "@/hooks/use-transactions";
import { useMerchantProfile } from "@/hooks/use-merchant";
import { formatAmount, getTransactionStatusLabel, shortenAddress } from "@/lib/dashboard-utils";
import { format, parseISO, startOfDay, endOfDay, startOfMonth, subDays } from "date-fns";
import { Ban, ExternalLink, Search, X, QrCode, Download, Calendar, ChevronDown, FileText, ChevronRight } from "lucide-react";
import { buildPaymentUrl, buildWalletPaymentUri } from "@/lib/payment";
import { QRStyled } from "@/components/QRStyled";
import type { QrStyle } from "@/components/QRStyled";
import { cn } from "@/lib/dashboard-utils";
import { fetchApi } from "@/lib/api";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

// ── Date Range Types ──────────────────────────────────────────────────────────
type DatePreset = "all" | "today" | "7d" | "30d" | "month" | "custom";
type StatusFilter = "all" | "paid" | "pending" | "cancelled";

interface DateRange {
  preset: DatePreset;
  from: Date | null;
  to: Date | null;
}

const CHAIN_EXPLORERS: Record<number, string> = {
  1: "https://etherscan.io",
  137: "https://polygonscan.com",
  8453: "https://basescan.org",
  42161: "https://arbiscan.io",
  10: "https://optimistic.etherscan.io",
  56: "https://bscscan.com",
  11155111: "https://sepolia.etherscan.io",
};

const CHAIN_NAMES: Record<number, string> = {
  1: "Ethereum",
  137: "Polygon",
  8453: "Base",
  42161: "Arbitrum",
  10: "Optimism",
  56: "BNB Chain",
  11155111: "Sepolia",
};

function networkModeLabel(chainId?: number) {
  return chainId === 1 ? "Live" : "Test";
}

const PRESETS: { key: DatePreset; label: string }[] = [
  { key: "all", label: "All time" },
  { key: "today", label: "Today" },
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
  { key: "month", label: "This month" },
  { key: "custom", label: "Custom range" },
];

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "paid", label: "Paid" },
  { key: "pending", label: "Pending" },
  { key: "cancelled", label: "Cancelled" },
];

function matchesStatusFilter(tx: Transaction, filter: StatusFilter) {
  if (filter === "all") return true;
  if (filter === "paid") return tx.status === "confirmed";
  if (filter === "pending") return tx.status === "pending" || tx.status === "confirming";
  return tx.status === "canceled" || tx.status === "failed" || tx.status === "unverified";
}

function getPresetRange(preset: DatePreset): { from: Date | null; to: Date | null } {
  const now = new Date();
  switch (preset) {
    case "today": return { from: startOfDay(now), to: endOfDay(now) };
    case "7d": return { from: startOfDay(subDays(now, 6)), to: endOfDay(now) };
    case "30d": return { from: startOfDay(subDays(now, 29)), to: endOfDay(now) };
    case "month": return { from: startOfMonth(now), to: endOfDay(now) };
    default: return { from: null, to: null };
  }
}

function inRange(tx: Transaction, from: Date | null, to: Date | null): boolean {
  if (!from && !to) return true;
  const d = parseISO(tx.createdAt);
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

// ── Date Range Picker ─────────────────────────────────────────────────────────
function DateRangePicker({ range, onChange }: { range: DateRange; onChange: (r: DateRange) => void }) {
  const [open, setOpen] = useState(false);
  const [customFrom, setCustomFrom] = useState(range.from ? format(range.from, "yyyy-MM-dd") : "");
  const [customTo, setCustomTo] = useState(range.to ? format(range.to, "yyyy-MM-dd") : "");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const label = useMemo(() => {
    if (range.preset === "custom" && range.from && range.to) {
      return `${format(range.from, "MMM d")} – ${format(range.to, "MMM d, yyyy")}`;
    }
    return PRESETS.find(p => p.key === range.preset)?.label ?? "All time";
  }, [range]);

  const selectPreset = (preset: string) => {
    const p = preset as DatePreset;
    if (p === "custom") {
      onChange({ preset: "custom", from: range.from, to: range.to });
    } else {
      const { from, to } = getPresetRange(p);
      onChange({ preset: p, from, to });
      setOpen(false);
    }
  };

  const applyCustom = () => {
    const from = customFrom ? startOfDay(new Date(customFrom)) : null;
    const to = customTo ? endOfDay(new Date(customTo)) : null;
    onChange({ preset: "custom", from, to });
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(v => !v)}
        className="h-9 px-3 flex items-center gap-1.5 rounded-lg border border-border bg-background text-sm font-medium text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-all shrink-0"
      >
        <Calendar className="w-3.5 h-3.5" />
        <span className="hidden sm:inline max-w-[140px] truncate">{label}</span>
        <ChevronDown className={cn("w-3 h-3 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="absolute right-0 top-11 z-50 w-56 bg-popover border border-border rounded-xl shadow-lg p-1.5 space-y-0.5">
          {PRESETS.map(p => (
            <button
              key={p.key}
              onClick={() => selectPreset(p.key)}
              className={cn(
                "w-full text-left px-3 py-2 rounded-lg text-sm transition-colors",
                range.preset === p.key
                  ? "bg-[#E6FAF5] text-[#00A87A] font-medium"
                  : "text-foreground hover:bg-muted"
              )}
            >
              {p.label}
            </button>
          ))}

          {range.preset === "custom" && (
            <div className="px-2 pt-2 pb-1 border-t border-border mt-1 space-y-2">
              <div>
                <label className="text-[11px] text-muted-foreground font-medium block mb-1">From</label>
                <input
                  type="date"
                  value={customFrom}
                  onChange={e => setCustomFrom(e.target.value)}
                  className="w-full h-8 px-2 rounded-lg border border-border bg-background text-xs focus:outline-none focus:ring-1 focus:ring-ring/20"
                />
              </div>
              <div>
                <label className="text-[11px] text-muted-foreground font-medium block mb-1">To</label>
                <input
                  type="date"
                  value={customTo}
                  onChange={e => setCustomTo(e.target.value)}
                  className="w-full h-8 px-2 rounded-lg border border-border bg-background text-xs focus:outline-none focus:ring-1 focus:ring-ring/20"
                />
              </div>
              <button
                onClick={applyCustom}
                className="w-full h-8 rounded-lg bg-[#00D1A0] text-white text-xs font-semibold hover:opacity-90 transition-opacity"
              >
                Apply
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── CSV Export ────────────────────────────────────────────────────────────────
function exportToCSV(transactions: Transaction[], merchantName?: string | null, range?: DateRange) {
  const headers = ["Date", "Status", "Amount", "Coin", "Pay Amount", "Pay Coin", "From", "Tx Hash", "Memo", "Notes"];
  const rows = transactions.map(tx => [
    format(parseISO(tx.createdAt), "yyyy-MM-dd HH:mm:ss"),
    getTransactionStatusLabel(tx.status),
    tx.status === "confirmed" ? tx.amount : "",
    tx.coin,
    tx.payAmount ?? "",
    tx.payCoin ?? "",
    tx.fromAddress ?? tx.from ?? "",
    tx.txHash ?? "",
    tx.memo ?? "",
    tx.notes ?? "",
  ]);

  const csvContent = [
    headers.join(","),
    ...rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(",")),
  ].join("\n");

  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const safeName = (merchantName || "serapay").replace(/[^a-z0-9]/gi, "_").toLowerCase();
  const rangeLabel = range?.preset === "custom" && range.from && range.to
    ? `_${format(range.from, "yyyyMMdd")}_${format(range.to, "yyyyMMdd")}`
    : range?.preset !== "all" ? `_${range?.preset ?? ""}` : "";
  a.download = `${safeName}_transactions${rangeLabel}_${format(new Date(), "yyyy-MM-dd")}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── QR Modal ─────────────────────────────────────────────────────────────────
function QRModal({
  paymentUrl, amount, coin, receiverAddress, chainId, merchantName, logo, fgColor, bgColor, qrStyle, onClose,
}: {
  paymentUrl: string; amount: string; coin: string; merchantName?: string;
  receiverAddress?: string; chainId?: number | null;
  logo?: string; fgColor?: string; bgColor?: string; qrStyle?: string; onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const walletQrValue = buildWalletPaymentUri({ receiverAddress: receiverAddress || "", coin, amount, chainId }) || paymentUrl;
  const handleCopy = async () => {
    try { await navigator.clipboard.writeText(paymentUrl); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch {}
  };
  return (
    <>
      <div onClick={onClose} className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm" />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-xs p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-sm font-semibold text-foreground">Payment QR</p>
              {amount && parseFloat(amount) > 0 && (
                <p className="text-xs text-muted-foreground">{formatAmount(amount)} {coin}</p>
              )}
            </div>
            <button onClick={onClose} className="w-11 h-11 rounded-full flex items-center justify-center hover:bg-muted transition-colors" aria-label="Close">
              <X className="w-3.5 h-3.5 text-muted-foreground" />
            </button>
          </div>
          <div className="flex justify-center mb-4">
            <QRStyled value={walletQrValue} size={200} fgColor={fgColor || "#1a1a1a"} bgColor={bgColor || "#ffffff"} style={(qrStyle as QrStyle) || "rounded"} logo={logo} />
          </div>
          <button onClick={handleCopy} className="w-full h-9 rounded-xl bg-[#00D1A0] text-white text-sm font-semibold hover:opacity-90 transition-opacity">
            {copied ? "Copied!" : "Copy Payment Link"}
          </button>
        </div>
      </div>
    </>
  );
}

// ── Status Badge ──────────────────────────────────────────────────────────────
function StatusBadge({ status }: { status: string }) {
  const variant =
    status === "confirmed" ? "success" :
    status === "pending" || status === "confirming" ? "warning" :
    status === "canceled" ? "default" :
    "destructive";
  return <Badge variant={variant}>{getTransactionStatusLabel(status)}</Badge>;
}

function canCancelTransaction(tx: Transaction) {
  return tx.status === "pending" || tx.status === "confirming";
}

function parseTransactionMeta(notes: string | null | undefined): Record<string, any> | null {
  if (!notes || !notes.trim().startsWith("{")) return null;
  try {
    const parsed = JSON.parse(notes);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function getEditableTransactionNotes(notes: string | null | undefined) {
  const meta = parseTransactionMeta(notes);
  if (meta) return typeof meta.internalNote === "string" ? meta.internalNote : "";
  return notes ?? "";
}

function buildTransactionNotesPayload(existingNotes: string | null | undefined, internalNote: string) {
  const meta = parseTransactionMeta(existingNotes);
  const trimmed = internalNote.trim();
  if (!meta) return internalNote;
  const nextMeta = { ...meta };
  if (trimmed) nextMeta.internalNote = internalNote;
  else delete nextMeta.internalNote;
  return JSON.stringify(nextMeta);
}

function prettifySource(value: string | null | undefined) {
  if (!value) return null;
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function statusReceiptTone(status: Transaction["status"]) {
  if (status === "confirmed") return { label: "Paid", cls: "bg-[#E6FAF5] text-[#00795C]" };
  if (status === "pending" || status === "confirming") return { label: getTransactionStatusLabel(status), cls: "bg-amber-50 text-amber-700" };
  return { label: getTransactionStatusLabel(status), cls: "bg-muted text-muted-foreground" };
}

// ── Transaction Detail Drawer ─────────────────────────────────────────────────
function TransactionDrawer({
  tx,
  merchantName,
  merchantLogo,
  onClose,
  onNotesUpdated,
  onCanceled,
}: {
  tx: Transaction;
  merchantName?: string | null;
  merchantLogo?: string | null;
  onClose: () => void;
  onNotesUpdated: (id: string, notes: string) => void;
  onCanceled: (id: string) => void;
}) {
  const initialNotes = useMemo(() => getEditableTransactionNotes(tx.notes), [tx.notes]);
  const [notes, setNotes] = useState(initialNotes);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const cancelTransaction = useCancelTransaction();

  const handleSaveNotes = async () => {
    const payloadNotes = buildTransactionNotesPayload(tx.notes, notes);
    setSaving(true);
    try {
      await fetchApi(`/merchant/transactions/${tx.id}/notes`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: payloadNotes }),
      });
      onNotesUpdated(tx.id, payloadNotes);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      if (import.meta.env.DEV) console.error(e);
    } finally {
      setSaving(false);
    }
  };

  const fromAddr = tx.fromAddress ?? tx.from ?? null;
  const explorerBase = CHAIN_EXPLORERS[tx.chainId ?? 11155111] ?? CHAIN_EXPLORERS[11155111];
  const cancelable = canCancelTransaction(tx);
  const meta = parseTransactionMeta(tx.notes);
  const txDate = parseISO(tx.createdAt);
  const receiptId = `SP-${format(txDate, "yyyyMMdd")}-${tx.id.slice(0, 6).toUpperCase()}`;
  const storeName = merchantName || "SeraPay Merchant";
  const displaySource = prettifySource(tx.paymentSource || meta?.source || meta?.type);
  const paidAmount = tx.payAmount || tx.amount;
  const paidCoin = tx.payCoin || tx.coin;
  const statusTone = statusReceiptTone(tx.status);
  const orderId = tx.orderId || (typeof meta?.orderId === "string" ? meta.orderId : null);
  const paymentIntentId = tx.paymentIntentId || (typeof meta?.paymentIntentId === "string" ? meta.paymentIntentId : null);
  const quoteUuid = tx.quoteUuid || (typeof meta?.quoteUuid === "string" ? meta.quoteUuid : null);
  const cancellationReason = typeof meta?.cancellationReason === "string"
    ? meta.cancellationReason
    : typeof meta?.failureReason === "string"
      ? meta.failureReason
      : null;

  const handleCancel = () => {
    cancelTransaction.mutate(tx.id, {
      onSuccess: () => {
        toast.success("Transaction canceled");
        setConfirmCancel(false);
        onCanceled(tx.id);
      },
      onError: (error: any) => toast.error(error?.message || "Unable to cancel transaction"),
    });
  };

  return (
    <>
      <div onClick={onClose} className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm" />
      <div className="fixed right-0 top-0 bottom-0 z-50 w-full max-w-md bg-card border-l border-border shadow-2xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-muted-foreground" />
            <span className="font-semibold text-sm">Transaction Details</span>
          </div>
          <button onClick={onClose} className="w-11 h-11 rounded-full flex items-center justify-center hover:bg-muted transition-colors" aria-label="Close details">
            <X className="w-3.5 h-3.5 text-muted-foreground" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto bg-[#F7F8FA] px-4 py-5">
          <div className="mx-auto w-full max-w-[360px] overflow-hidden rounded-2xl border border-border bg-white shadow-[0_14px_34px_rgba(10,31,26,0.08)]">
            <div className="bg-gradient-to-r from-[#00D1A0] to-[#00A87A] px-4 py-3 text-center">
              <p className="text-[10px] font-extrabold uppercase tracking-[0.22em] text-white">SeraPay · Transaction Receipt</p>
            </div>
            <div className="px-4 pb-5 pt-4 text-center">
              <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center overflow-hidden rounded-xl bg-[#E6FAF5]">
                {merchantLogo ? (
                  <img src={merchantLogo} alt="" className="h-full w-full object-cover" />
                ) : (
                  <span className="text-lg font-extrabold text-[#00A87A]">{storeName.slice(0, 1).toUpperCase()}</span>
                )}
              </div>
              <h3 className="text-base font-extrabold text-[#0A1F1A]">{storeName}</h3>
              <p className="mt-1 font-mono text-[10px] text-muted-foreground">Wallet: {shortenAddress(tx.toAddress || "")}</p>
              <div className="my-4 border-t border-dashed border-border" />
              <span className={cn("inline-flex rounded-full px-2.5 py-1 text-xs font-bold", statusTone.cls)}>
                {statusTone.label}
              </span>
              <p className="mt-3 text-3xl font-extrabold tracking-tight text-[#0A1F1A]">
                {formatAmount(tx.amount)} <span className="text-[#00795C]">{tx.coin}</span>
              </p>
              <div className="mt-4 text-center">
                <p className="text-[10px] font-extrabold uppercase tracking-[0.16em] text-muted-foreground">Invoice {receiptId}</p>
                <p className="mt-1 text-sm font-semibold text-foreground">{format(txDate, "MMMM d, yyyy")}</p>
                <p className="text-xs text-muted-foreground">{format(txDate, "hh:mm:ss a")}</p>
              </div>
              <div className="my-4 border-t border-border" />
              <div className="rounded-lg border border-[#00795C] bg-[#F0FAF6] p-3 text-left">
                <p className="mb-2 text-xs font-extrabold text-[#00795C]">Payment Summary</p>
                <ReceiptRow label="Customer Paid:" value={`${formatAmount(paidAmount)} ${paidCoin}`} bold />
                <ReceiptRow label="Merchant Receives:" value={`${formatAmount(tx.amount)} ${tx.coin}`} bold />
                <ReceiptRow label="Network:" value={CHAIN_NAMES[tx.chainId ?? 11155111] ?? `Chain ${tx.chainId ?? 11155111}`} />
                <ReceiptRow label="SeraPay Fee:" value="$0.00 (0%)" valueClassName="font-bold text-[#00795C]" />
              </div>
              <div className="mt-4 space-y-2 text-left">
                {orderId ? <ReceiptDetail label="Order ID" value={orderId} mono /> : null}
                {paymentIntentId ? <ReceiptDetail label="Payment Intent" value={paymentIntentId} mono /> : null}
                {quoteUuid ? <ReceiptDetail label="Quote ID" value={quoteUuid} mono /> : null}
                <ReceiptDetail label="Transaction ID" value={tx.id} mono />
                {displaySource ? <ReceiptDetail label="Source" value={displaySource} /> : null}
                {fromAddr ? <ReceiptDetail label="From" value={fromAddr} mono /> : null}
                {tx.toAddress ? <ReceiptDetail label="To" value={tx.toAddress} mono /> : null}
                {tx.memo ? <ReceiptDetail label="Memo" value={tx.memo} /> : null}
                {cancellationReason ? <ReceiptDetail label="Reason" value={cancellationReason} /> : null}
                {tx.txHash ? (
                  <div className="rounded-lg bg-muted/30 p-2.5">
                    <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Transaction Hash</p>
                    <p className="mt-1 break-all font-mono text-[10px] leading-relaxed text-foreground">{tx.txHash}</p>
                    <a
                      href={`${explorerBase}/tx/${tx.txHash}`}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-2 inline-flex items-center gap-1 text-xs font-bold text-[#00A87A] hover:underline"
                    >
                      View on Etherscan
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                ) : null}
              </div>
              <div className="my-4 border-t border-dashed border-border" />
              <p className="text-xs text-muted-foreground">Thank you for using SeraPay.</p>
              <p className="mt-1 text-xs font-extrabold text-[#00795C]">Powered by SeraPay · Sera Protocol</p>
            </div>
          </div>

          <div className="mx-auto mt-4 w-full max-w-[360px] space-y-4">
            {cancelable && (
              <button
                type="button"
                onClick={() => setConfirmCancel(true)}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 text-xs font-semibold text-red-600 transition-colors hover:bg-red-100"
              >
                <Ban className="w-3.5 h-3.5" />
                Cancel request
              </button>
            )}

          {/* Notes / dispute */}
          <div>
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide block mb-2">
              Internal Notes / Dispute
            </label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Add notes, refund reason, or dispute details…"
              rows={4}
              className="w-full resize-none rounded-xl border border-border bg-background px-3 py-2.5 text-sm transition-all placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/10"
            />
            <button
              onClick={handleSaveNotes}
              disabled={saving || notes === initialNotes}
              className="mt-2 h-8 px-4 rounded-lg bg-[#00D1A0] text-white text-xs font-semibold hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {saving ? "Saving…" : saved ? "Saved!" : "Save Notes"}
            </button>
          </div>
          </div>
        </div>
      </div>

      {confirmCancel && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <button className="absolute inset-0 bg-black/40" onClick={() => setConfirmCancel(false)} aria-label="Close cancel confirmation" />
          <div className="relative w-full max-w-sm rounded-2xl border border-border bg-card p-5 shadow-2xl">
            <div className="w-10 h-10 rounded-full bg-red-50 text-red-600 flex items-center justify-center mb-3">
              <Ban className="w-5 h-5" />
            </div>
            <h3 className="text-base font-semibold text-foreground">Cancel this request?</h3>
            <p className="mt-1 text-sm text-muted-foreground">This marks the pending payment as canceled and removes it from the queue.</p>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmCancel(false)}
                className="h-9 rounded-lg border border-border bg-background px-4 text-sm font-semibold text-foreground hover:bg-muted"
              >
                Keep
              </button>
              <button
                type="button"
                onClick={handleCancel}
                disabled={cancelTransaction.isPending}
                className="h-9 rounded-lg bg-red-600 px-4 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-60"
              >
                {cancelTransaction.isPending ? "Canceling..." : "Cancel request"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function ReceiptRow({ label, value, bold, valueClassName }: { label: string; value: string; bold?: boolean; valueClassName?: string }) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between gap-3 text-xs last:mb-0">
      <span className="text-[#374151]">{label}</span>
      <span className={cn("text-right text-[#1C1C1E]", bold && "font-bold", valueClassName)}>{value}</span>
    </div>
  );
}

function ReceiptDetail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg bg-muted/30 p-2.5">
      <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("mt-1 break-all text-xs leading-relaxed text-foreground", mono && "font-mono text-[10px]")}>{value}</p>
    </div>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className={cn("ml-4 truncate text-right", mono ? "font-mono text-xs" : "text-sm font-medium")}>{value}</span>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export function Transactions() {
  const { data, isLoading } = useTransactions(500, 0);
  const { data: profile } = useMerchantProfile();
  const [query, setQuery] = useState("");
  const [qrTx, setQrTx] = useState<{ amount: string; coin: string; url: string; receiverAddress: string; chainId?: number | null } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [dateRange, setDateRange] = useState<DateRange>({ preset: "all", from: null, to: null });
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [selectedTx, setSelectedTx] = useState<Transaction | null>(null);
  const [localNotes, setLocalNotes] = useState<Record<string, string>>({});
  const queryClient = useQueryClient();

  const handleExportCSV = () => {
    if (!filtered.length) return;
    setExporting(true);
    try {
      exportToCSV(filtered, profile?.name, dateRange);
    } finally {
      setTimeout(() => setExporting(false), 1500);
    }
  };

  // Apply date filter first, then text search
  const filteredByDate = useMemo(() => {
    const txs = data?.transactions ?? [];
    if (dateRange.preset === "all") return txs;
    return txs.filter(tx => inRange(tx, dateRange.from, dateRange.to));
  }, [data?.transactions, dateRange]);

  const filteredByStatus = useMemo(() => {
    return filteredByDate.filter((tx) => matchesStatusFilter(tx, statusFilter));
  }, [filteredByDate, statusFilter]);

  const statusCounts = useMemo(() => {
    return STATUS_FILTERS.reduce<Record<StatusFilter, number>>((acc, filter) => {
      acc[filter.key] = filteredByDate.filter((tx) => matchesStatusFilter(tx, filter.key)).length;
      return acc;
    }, { all: 0, paid: 0, pending: 0, cancelled: 0 });
  }, [filteredByDate]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return filteredByStatus;
    return filteredByStatus.filter((tx) =>
      tx.txHash?.toLowerCase().includes(q) ||
      (tx.fromAddress ?? tx.from ?? "").toLowerCase().includes(q) ||
      tx.coin?.toLowerCase().includes(q) ||
      tx.status?.toLowerCase().includes(q) ||
      tx.memo?.toLowerCase().includes(q)
    );
  }, [filteredByStatus, query]);

  const pendingCount = useMemo(() => (data?.transactions ?? []).filter(t => t.status === "pending" || t.status === "confirming").length, [data?.transactions]);

  const getPaymentUrl = (tx: Transaction) => {
    if (tx.paymentUrl) return tx.paymentUrl;
    const receiverAddress = profile?.storeAddress || profile?.walletAddress;
    if (!receiverAddress) return "";
    return buildPaymentUrl({
      receiverAddress,
      receiveCoin: tx.coin,
      amount: tx.amount && parseFloat(tx.amount) > 0 ? tx.amount : undefined,
      chainId: tx.chainId,
      merchantName: profile?.name || undefined,
    });
  };

  const handleShowQR = (tx: Transaction, e: React.MouseEvent) => {
    e.stopPropagation();
    const url = getPaymentUrl(tx);
    if (!url) return;
    setQrTx({
      amount: tx.amount,
      coin: tx.coin,
      url,
      receiverAddress: tx.toAddress || profile?.walletAddress || "",
      chainId: tx.chainId,
    });
  };

  const handleOpenTransaction = (tx: Transaction) => {
    if (tx.status === "pending" || tx.status === "confirming") {
      const url = getPaymentUrl(tx);
      if (url) {
        window.location.href = url;
        return;
      }
    }
    setSelectedTx(getTxWithLocalNotes(tx));
  };

  const handleNotesUpdated = (id: string, notes: string) => {
    setLocalNotes(prev => ({ ...prev, [id]: notes }));
    queryClient.invalidateQueries({ queryKey: ["/merchant/transactions"] });
  };

  const handleTransactionCanceled = (id: string) => {
    setSelectedTx(prev => prev?.id === id ? { ...prev, status: "canceled" } : prev);
    queryClient.invalidateQueries({ queryKey: ["/merchant/transactions"] });
    queryClient.invalidateQueries({ queryKey: ["/merchant/stats"] });
  };

  const getTxWithLocalNotes = (tx: Transaction): Transaction => ({
    ...tx,
    notes: localNotes[tx.id] !== undefined ? localNotes[tx.id] : tx.notes,
  });

  return (
    <AppLayout pendingCount={pendingCount}>
      <div className="space-y-6">
        {/* Header row */}
        <div>
          <h1 className="text-xl font-semibold tracking-tight mb-0.5">Transactions</h1>
          <p className="text-muted-foreground text-sm">
            {filtered.length} transaction{filtered.length !== 1 ? "s" : ""}
            {dateRange.preset !== "all" && <span className="ml-1 text-[#00A87A]">- filtered</span>}
            {statusFilter !== "all" && <span className="ml-1 text-[#00A87A]">- {STATUS_FILTERS.find((item) => item.key === statusFilter)?.label}</span>}
            {pendingCount > 0 && <span className="ml-1 text-amber-500">- {pendingCount} pending</span>}
          </p>
        </div>

        <div className="rounded-2xl border border-border/70 bg-white/95 p-2.5 shadow-[0_12px_32px_rgba(10,31,26,0.05)]">
          <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              {STATUS_FILTERS.map((filter) => {
                const active = statusFilter === filter.key;
                return (
                  <button
                    key={filter.key}
                    type="button"
                    onClick={() => setStatusFilter(filter.key)}
                    className={cn(
                      "inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition-all",
                      active
                        ? "border-[#00D1A0] bg-[#E6FAF5] text-[#00795C] shadow-[0_6px_16px_rgba(0,209,160,0.12)]"
                        : "border-border bg-background text-muted-foreground hover:border-[#00D1A0]/45 hover:bg-[#F7FFFC] hover:text-foreground"
                    )}
                  >
                    {filter.label}
                    <span className={cn(
                      "rounded-full px-1.5 py-0.5 text-[10px]",
                      active ? "bg-white/85 text-[#00795C]" : "bg-muted text-muted-foreground"
                    )}>
                      {statusCounts[filter.key]}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <DateRangePicker range={dateRange} onChange={setDateRange} />
              <button
                onClick={handleExportCSV}
                disabled={exporting || isLoading || !filtered.length}
                className="h-9 px-3 flex items-center justify-center gap-1.5 rounded-lg border border-border bg-background text-sm font-medium text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-all disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                title="Export filtered transactions as CSV"
              >
                <Download className="w-3.5 h-3.5" />
                <span>{exporting ? "Exporting..." : "Export CSV"}</span>
              </button>
              <div className="relative w-full sm:w-72">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search tx hash, address, coin..."
                  className="w-full h-9 pl-9 pr-8 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[#00D1A0]/15 focus:border-[#00D1A0]/60 transition-all placeholder:text-muted-foreground font-mono"
                />
                {query && (
                  <button onClick={() => setQuery("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors">
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>


        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Status</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>From</TableHead>
                <TableHead>Tx Hash</TableHead>
                <TableHead>Date</TableHead>
                <TableHead className="w-16"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 10 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 6 }).map((_, j) => (
                      <TableCell key={j}><Skeleton className="h-5 w-20" /></TableCell>
                    ))}
                  </TableRow>
                ))
              ) : filtered.map((tx) => {
                const fromAddr = tx.fromAddress ?? tx.from ?? null;
                return (
                  <TableRow
                    key={tx.id}
                    className="group cursor-pointer hover:bg-muted/40 transition-colors"
                    onClick={() => handleOpenTransaction(tx)}
                  >
                    <TableCell>
                      <StatusBadge status={tx.status} />
                    </TableCell>
                    <TableCell>
                      <span className="font-mono font-medium text-sm">
                        {tx.status === "confirmed" ? `+${formatAmount(tx.amount)} ${tx.coin}` : `${formatAmount(tx.amount)} ${tx.coin}`}
                      </span>
                      <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">{networkModeLabel(tx.chainId)}</span>
                    </TableCell>
                    <TableCell>
                      <span className="font-mono text-muted-foreground text-xs">
                        {shortenAddress(fromAddr ?? "")}
                      </span>
                    </TableCell>
                    <TableCell>
                      {tx.txHash ? (
                        <a
                          href={`${CHAIN_EXPLORERS[tx.chainId ?? 11155111] ?? CHAIN_EXPLORERS[11155111]}/tx/${tx.txHash}`}
                          target="_blank"
                          rel="noreferrer"
                          onClick={e => e.stopPropagation()}
                          className="inline-flex items-center gap-1.5 font-mono text-xs text-foreground hover:underline"
                        >
                          {shortenAddress(tx.txHash)}
                          <ExternalLink className="w-3 h-3 opacity-30 group-hover:opacity-100 transition-opacity" />
                        </a>
                      ) : <span className="text-muted-foreground text-xs">—</span>}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {format(parseISO(tx.createdAt), "MMM dd, yyyy HH:mm")}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={(e) => handleShowQR(tx, e)}
                          title="Show QR for this amount"
                          className="w-7 h-7 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-all"
                          aria-label="Show payment QR"
                        >
                          <QrCode className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); setSelectedTx(getTxWithLocalNotes(tx)); }}
                          title="View details"
                          className="w-7 h-7 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-all"
                          aria-label="View transaction details"
                        >
                          <ChevronRight className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}

              {!isLoading && filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="h-40 text-center text-muted-foreground">
                    {query
                      ? `No transactions matching "${query}"`
                      : statusFilter !== "all"
                        ? `No ${STATUS_FILTERS.find((item) => item.key === statusFilter)?.label.toLowerCase()} transactions found.`
                      : dateRange.preset !== "all"
                        ? "No transactions in this date range."
                        : "No transactions found."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Card>
      </div>

      {/* QR Modal */}
      {qrTx && (
        <QRModal
          paymentUrl={qrTx.url}
          amount={qrTx.amount}
          coin={qrTx.coin}
          receiverAddress={qrTx.receiverAddress}
          chainId={qrTx.chainId}
          merchantName={profile?.name || undefined}
          logo={profile?.logoData || undefined}
          fgColor={profile?.qrFgColor || undefined}
          bgColor={profile?.qrBgColor || undefined}
          qrStyle={profile?.qrStyle || undefined}
          onClose={() => setQrTx(null)}
        />
      )}

      {/* Transaction Detail Drawer */}
      {selectedTx && (
        <TransactionDrawer
          tx={selectedTx}
          merchantName={profile?.name}
          merchantLogo={profile?.logoData}
          onClose={() => setSelectedTx(null)}
          onNotesUpdated={handleNotesUpdated}
          onCanceled={handleTransactionCanceled}
        />
      )}
    </AppLayout>
  );
}
