import { useState, useEffect, useRef } from "react";
import { useParams } from "wouter";
import { Download, CheckCircle2, Zap, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

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

export default function ReceiptPage() {
  const { txId } = useParams<{ txId: string }>();
  const [tx, setTx] = useState<TxData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const receiptRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!txId) return;
    fetch(`/api/payment/status/${txId}`)
      .then(r => r.json())
      .then(d => { setTx(d); setLoading(false); })
      .catch(() => { setError("Could not load receipt"); setLoading(false); });
  }, [txId]);

  const downloadPdf = async () => {
    if (!receiptRef.current || !tx) return;
    try {
      const { default: jsPDF } = await import("jspdf");
      const { default: html2canvas } = await import("html2canvas");
      const canvas = await html2canvas(receiptRef.current, {
        backgroundColor: "#0a0a0f",
        scale: 2,
        useCORS: true,
      });
      const imgData = canvas.toDataURL("image/png");
      const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
      const pdfWidth = pdf.internal.pageSize.getWidth();
      const pdfHeight = (canvas.height * pdfWidth) / canvas.width;
      pdf.addImage(imgData, "PNG", 0, 0, pdfWidth, pdfHeight);
      pdf.save(`serapay-receipt-${txId?.slice(0, 8)}.pdf`);
    } catch (e) {
      console.error("PDF generation failed:", e);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0a0f] flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error || !tx) {
    return (
      <div className="min-h-screen bg-[#0a0a0f] flex items-center justify-center px-4 text-white">
        <Card className="bg-white/3 border-white/8 max-w-sm w-full">
          <CardContent className="p-8 text-center">
            <p className="text-white/40">{error || "Receipt not found"}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const date = new Date(tx.createdAt).toLocaleString();

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-white flex flex-col items-center justify-center px-4 py-12">
      {/* Background */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -right-40 w-96 h-96 bg-green-600/10 rounded-full blur-3xl" />
        <div className="absolute -bottom-40 -left-40 w-96 h-96 bg-indigo-600/10 rounded-full blur-3xl" />
      </div>

      <div className="relative z-10 w-full max-w-md space-y-6">
        {/* Header */}
        <div className="text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-white/5 rounded-full border border-white/10 mb-4">
            <div className="w-5 h-5 bg-gradient-to-br from-indigo-500 to-violet-600 rounded flex items-center justify-center">
              <Zap className="w-3 h-3 text-white" />
            </div>
            <span className="text-sm font-semibold">SeraPay</span>
          </div>
          <h1 className="text-2xl font-bold">Payment Receipt</h1>
        </div>

        {/* Receipt Card */}
        <div ref={receiptRef}>
          <Card className="bg-[#0f0f1a] border-white/10">
            <CardContent className="p-8 space-y-6">
              {/* Status */}
              <div className="flex flex-col items-center gap-3 py-4">
                <CheckCircle2 className="w-16 h-16 text-green-400" />
                <div className="text-xl font-bold text-green-400">Payment Successful</div>
                <div className="text-white/40 text-sm">{date}</div>
              </div>

              <div className="h-px bg-white/5" />

              {/* Amount */}
              <div className="text-center">
                <div className="text-4xl font-black text-white mb-1">
                  {tx.amount} {tx.coin}
                </div>
                <div className="text-white/40 text-sm">Amount Paid</div>
              </div>

              <div className="h-px bg-white/5" />

              {/* Details */}
              <div className="space-y-3">
                {[
                  { label: "Transaction ID", value: tx.txId.slice(0, 16) + "..." },
                  { label: "To Address", value: tx.toAddress.slice(0, 10) + "..." + tx.toAddress.slice(-6) },
                  { label: "From Address", value: tx.fromAddress ? tx.fromAddress.slice(0, 10) + "..." + tx.fromAddress.slice(-6) : "—" },
                  { label: "Status", value: tx.verified ? "Verified ✓" : tx.status },
                ].map(({ label, value }) => (
                  <div key={label} className="flex justify-between items-center">
                    <span className="text-white/40 text-sm">{label}</span>
                    <span className="text-white text-sm font-mono font-medium">{value}</span>
                  </div>
                ))}
              </div>

              {/* TX Hash link */}
              {tx.txHash && (
                <a
                  href={`${CHAIN_EXPLORERS[tx.chainId ?? 11155111] ?? CHAIN_EXPLORERS[11155111]}${tx.txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-center gap-2 text-indigo-400 text-xs hover:text-indigo-300 transition-colors"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  View on Explorer
                </a>
              )}

              {/* Branding */}
              <div className="text-center text-white/20 text-xs pt-2">
                Powered by SeraPay · pay.sera.cx
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Download button */}
        <Button
          onClick={downloadPdf}
          className="w-full h-12 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 font-semibold rounded-xl"
        >
          <Download className="w-5 h-5 mr-2" />
          Download Receipt as PDF
        </Button>

        <p className="text-center text-white/20 text-xs">
          Keep this receipt for your records.
        </p>
      </div>
    </div>
  );
}
