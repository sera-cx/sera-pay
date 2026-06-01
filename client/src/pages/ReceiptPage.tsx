import { useEffect, useRef, useState } from "react";
import { useParams } from "wouter";
import { Download, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SeraLogo } from "@/components/SeraPayHeader";

type TxData = {
  txId: string;
  status: string;
  verified: boolean;
  txHash: string | null;
  coin: string;
  amount: string;
  toAddress: string;
  fromAddress: string | null;
  createdAt: string;
  chainId?: number;
  merchantName?: string | null;
  merchantLogo?: string | null;
  merchantDescription?: string | null;
};

const CHAIN_EXPLORERS: Record<number, string> = {
  1: "https://etherscan.io/tx/",
  137: "https://polygonscan.com/tx/",
  8453: "https://basescan.org/tx/",
  42161: "https://arbiscan.io/tx/",
  10: "https://optimistic.etherscan.io/tx/",
  56: "https://bscscan.com/tx/",
  11155111: "https://sepolia.etherscan.io/tx/",
};

const CHAIN_NAMES: Record<number, string> = {
  1: "Ethereum",
  137: "Polygon",
  8453: "Base",
  42161: "Arbitrum",
  10: "Optimism",
  56: "BNB Chain",
  11155111: "Ethereum Sepolia",
};

function shortAddress(address?: string | null) {
  if (!address) return "-";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export default function ReceiptPage() {
  const { txId } = useParams<{ txId: string }>();
  const [tx, setTx] = useState<TxData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const receiptRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!txId) return;
    fetch(`/api/payment/status/${txId}`)
      .then(r => {
        if (!r.ok) throw new Error("Receipt not found");
        return r.json();
      })
      .then(d => { setTx(d); setLoading(false); })
      .catch(() => { setError("Could not load receipt"); setLoading(false); });
  }, [txId]);

  const downloadPdf = async () => {
    if (!receiptRef.current || !tx) return;
    const { default: jsPDF } = await import("jspdf");
    const { default: html2canvas } = await import("html2canvas");
    const canvas = await html2canvas(receiptRef.current, {
      backgroundColor: "#ffffff",
      scale: 2,
      useCORS: true,
    });
    const imgData = canvas.toDataURL("image/png");
    const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
    const pdfWidth = pdf.internal.pageSize.getWidth();
    const pdfHeight = (canvas.height * pdfWidth) / canvas.width;
    pdf.addImage(imgData, "PNG", 0, 0, pdfWidth, pdfHeight);
    pdf.save(`serapay-receipt-${tx.txId.slice(0, 8)}.pdf`);
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#F2FAF6]">
        <div className="relative flex h-16 w-16 items-center justify-center">
          <div className="absolute inset-0 animate-spin rounded-full border-[3px] border-[#00D1A0]/15 border-t-[#00D1A0]" />
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-white shadow-[0_10px_30px_rgba(0,209,160,0.16)]">
            <SeraLogo size={36} />
          </div>
        </div>
      </div>
    );
  }

  if (error || !tx) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#F2FAF6] px-4">
        <div className="w-full max-w-sm rounded-2xl bg-white p-6 text-center shadow-sm">
          <p className="text-sm text-gray-500">{error || "Receipt not found"}</p>
        </div>
      </div>
    );
  }

  const date = new Date(tx.createdAt);
  const invoiceId = `SP-${date.toISOString().slice(0, 10).replace(/-/g, "")}-${tx.txId.slice(0, 6).toUpperCase()}`;
  const dateStr = date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const timeStr = date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const chainId = tx.chainId ?? 11155111;
  const explorer = tx.txHash ? `${CHAIN_EXPLORERS[chainId] ?? CHAIN_EXPLORERS[11155111]}${tx.txHash}` : "";
  const merchantName = tx.merchantName || "SeraPay Merchant";

  return (
    <div className="min-h-screen bg-[#F2FAF6] px-4 py-10">
      <div className="mx-auto w-full max-w-sm space-y-5">
        <div className="flex justify-center">
          <SeraLogo size={36} />
        </div>

        <div ref={receiptRef} className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-[0_2px_16px_rgba(10,31,26,0.08)]">
          <div className="bg-[#00D1A0] py-3 text-center text-[11px] font-bold uppercase tracking-[0.18em] text-white">
            SeraPay - Payment Receipt
          </div>
          <div className="px-5 py-4 text-center">
            {tx.merchantLogo ? (
              <img src={tx.merchantLogo} alt={merchantName} className="mx-auto mb-2 h-12 w-12 rounded-lg object-contain" />
            ) : (
              <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-lg bg-gradient-to-br from-[#00D1A0] to-[#00B88A] text-lg font-bold text-white">
                {merchantName.slice(0, 1).toUpperCase()}
              </div>
            )}
            <h1 className="text-base font-bold text-[#0A1F1A]">{merchantName}</h1>
            {tx.merchantDescription ? <p className="mt-1 text-xs text-gray-500">{tx.merchantDescription}</p> : null}
            <p className="mt-1 font-mono text-[10px] text-gray-400">Wallet: {shortAddress(tx.toAddress)}</p>
          </div>

          <div className="mx-4 border-t border-dashed border-gray-300" />
          <div className="px-5 py-3 text-center">
            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-gray-400">Invoice {invoiceId}</p>
            <p className="mt-1 text-xs text-gray-700">{dateStr}</p>
            <p className="mt-0.5 text-[11px] text-gray-500">{timeStr}</p>
          </div>

          <div className="mx-4 border-t border-gray-200" />
          <div className="mx-4 my-3 rounded border border-[#00795C] bg-[#F0FAF6] px-3 py-2">
            <p className="mb-2 text-[11px] font-bold text-[#00795C]">Payment Summary</p>
            <div className="space-y-1.5 text-xs">
              <div className="flex justify-between gap-3"><span className="text-gray-600">Customer Paid:</span><strong>{tx.amount} {tx.coin}</strong></div>
              <div className="flex justify-between gap-3"><span className="text-gray-600">Merchant Receives:</span><strong>{tx.amount} {tx.coin}</strong></div>
              <div className="flex justify-between gap-3"><span className="text-gray-600">SeraPay Fee:</span><strong className="text-[#00795C]">$0.00 (0%)</strong></div>
            </div>
          </div>

          <p className="px-5 text-center text-[10px] text-gray-400">Network: {CHAIN_NAMES[chainId] || "Ethereum"} - Self-custody settlement</p>

          {tx.txHash ? (
            <div className="px-4 py-3">
              <p className="mb-1 text-[10px] font-bold text-gray-400">Transaction Hash</p>
              <p className="break-all font-mono text-[9px] leading-relaxed text-gray-700">{tx.txHash}</p>
              <a href={explorer} target="_blank" rel="noreferrer" className="mt-2 flex items-center justify-end gap-1 text-[11px] font-bold text-[#00A37D]">
                View on Explorer <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          ) : null}

          <div className="mx-4 border-t border-dashed border-gray-300" />
          <div className="px-5 py-4 text-center">
            <p className="text-xs text-gray-700">Thank you for your purchase!</p>
            <p className="mt-1 text-xs font-bold text-[#00795C]">Powered by SeraPay - Sera Protocol</p>
            <p className="mt-1 text-[11px] text-gray-400">Zero fees - Instant settlement - Self-custody</p>
          </div>
        </div>

        <Button onClick={downloadPdf} className="serapay-green-button h-12 w-full bg-gradient-to-r from-[#00D1A0] to-[#00B88A] text-white">
          <Download className="h-4 w-4" />
          Download Receipt as PDF
        </Button>
      </div>
    </div>
  );
}
