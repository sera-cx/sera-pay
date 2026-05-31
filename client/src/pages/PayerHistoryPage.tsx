/**
 * PayerHistoryPage — public page for a payer to view their payment history
 * Route: /wallet/history/:address
 */
import { useState, useEffect } from "react";
import { useParams, Link } from "wouter";
import { getTransactionStatusLabel } from "@/lib/dashboard-utils";

const font = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Inter', sans-serif";

type TxRecord = {
  id: string;
  txHash: string | null;
  coin: string;
  amount: string;
  amountUsd: string | null;
  status: "pending" | "confirming" | "confirmed" | "failed";
  merchantId: string;
  merchantName: string;
  toAddress: string;
  memo: string | null;
  createdAt: number;
};

const STATUS_COLORS: Record<string, string> = {
  confirmed: "#34C759",
  confirming: "#FF9500",
  pending: "#FF9500",
  failed: "#FF3B30",
};

function truncate(s: string, head = 6, tail = 4) {
  if (!s || s.length <= head + tail + 3) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

export default function PayerHistoryPage() {
  const { address } = useParams<{ address: string }>();
  const [txs, setTxs] = useState<TxRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    if (!address || !/^0x[0-9a-fA-F]{40}$/i.test(address)) {
      setError("Invalid wallet address.");
      setLoading(false);
      return;
    }
    setLoading(true);
    fetch(`/api/payer/history?address=${address.toLowerCase()}`)
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data)) setTxs(data);
        else setError(data.error || "Failed to load history.");
      })
      .catch(() => setError("Network error."))
      .finally(() => setLoading(false));
  }, [address]);

  const copyToClipboard = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {}
  };

  const totalConfirmed = txs
    .filter(t => t.status === "confirmed")
    .reduce((sum, t) => sum + parseFloat(t.amount || "0"), 0);

  return (
    <div style={{ minHeight: "100dvh", background: "#F2F2F7", fontFamily: font }}>
      {/* Header */}
      <div style={{ background: "rgba(255,255,255,0.95)", backdropFilter: "blur(12px)", borderBottom: "1px solid rgba(0,0,0,0.06)", padding: "14px 20px", position: "sticky", top: 0, zIndex: 10 }}>
        <div style={{ maxWidth: 600, margin: "0 auto", display: "flex", alignItems: "center", gap: 12 }}>
          <Link href="/">
            <img
              src="/icon-512.png"
              alt="SeraPay"
              style={{ height: 26, objectFit: "contain", cursor: "pointer" }}
            />
          </Link>
          <span style={{ fontSize: 14, fontWeight: 600, color: "#1C1C1E" }}>Payment History</span>
        </div>
      </div>

      <div style={{ maxWidth: 600, margin: "0 auto", padding: "20px 16px 40px" }}>
        {/* Wallet address card */}
        <div style={{ background: "#fff", borderRadius: 16, padding: "16px 20px", marginBottom: 16, boxShadow: "0 1px 8px rgba(0,0,0,0.06)" }}>
          <p style={{ fontSize: 11, fontWeight: 600, color: "rgba(60,60,67,0.4)", textTransform: "uppercase", letterSpacing: "0.08em", margin: "0 0 6px" }}>Wallet</p>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13, fontFamily: "monospace", color: "#1C1C1E", wordBreak: "break-all", flex: 1 }}>{address}</span>
            <button
              onClick={() => address && copyToClipboard(address, "addr")}
              aria-label="Copy address"
              style={{ background: "none", border: "none", cursor: "pointer", padding: 4, color: copiedId === "addr" ? "#34C759" : "rgba(60,60,67,0.3)", flexShrink: 0 }}
            >
              <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
            </button>
          </div>
        </div>

        {/* Stats */}
        {!loading && !error && txs.length > 0 && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 16 }}>
            {[
              { label: "Total Payments", value: txs.length.toString() },
              { label: "Successful", value: txs.filter(t => t.status === "confirmed").length.toString() },
              { label: "Total Sent", value: `${totalConfirmed.toFixed(2)}` },
            ].map(stat => (
              <div key={stat.label} style={{ background: "#fff", borderRadius: 14, padding: "14px 12px", textAlign: "center", boxShadow: "0 1px 6px rgba(0,0,0,0.05)" }}>
                <p style={{ fontSize: 18, fontWeight: 800, color: "#0A1F1A", margin: "0 0 4px", letterSpacing: "-0.5px" }}>{stat.value}</p>
                <p style={{ fontSize: 10, fontWeight: 500, color: "rgba(60,60,67,0.4)", margin: 0, textTransform: "uppercase", letterSpacing: "0.06em" }}>{stat.label}</p>
              </div>
            ))}
          </div>
        )}

        {/* Content */}
        {loading && (
          <div style={{ textAlign: "center", padding: "48px 0" }}>
            <div style={{ width: 32, height: 32, border: "3px solid rgba(0,209,160,0.2)", borderTopColor: "#00D1A0", borderRadius: "50%", animation: "spin 0.8s linear infinite", margin: "0 auto" }} />
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          </div>
        )}

        {error && (
          <div style={{ background: "#fff", borderRadius: 16, padding: "32px 24px", textAlign: "center", boxShadow: "0 1px 8px rgba(0,0,0,0.06)" }}>
            <div style={{ width: 48, height: 48, borderRadius: "50%", background: "#FFF0F0", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 12px" }}>
              <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="#FF3B30" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01" /></svg>
            </div>
            <p style={{ fontSize: 14, color: "#FF3B30", margin: 0 }}>{error}</p>
          </div>
        )}

        {!loading && !error && txs.length === 0 && (
          <div style={{ background: "#fff", borderRadius: 16, padding: "48px 24px", textAlign: "center", boxShadow: "0 1px 8px rgba(0,0,0,0.06)" }}>
            <div style={{ width: 56, height: 56, borderRadius: "50%", background: "#F2F2F7", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
              <svg width="24" height="24" fill="none" viewBox="0 0 24 24" stroke="rgba(60,60,67,0.3)" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
            </div>
            <p style={{ fontSize: 15, fontWeight: 600, color: "#1C1C1E", margin: "0 0 6px" }}>No payments yet</p>
            <p style={{ fontSize: 13, color: "rgba(60,60,67,0.5)", margin: 0 }}>Payments made from this wallet will appear here.</p>
          </div>
        )}

        {!loading && !error && txs.length > 0 && (
          <div style={{ background: "#fff", borderRadius: 16, boxShadow: "0 1px 8px rgba(0,0,0,0.06)", overflow: "hidden" }}>
            {txs.map((tx, i) => (
              <div
                key={tx.id}
                style={{
                  padding: "16px 20px",
                  borderTop: i > 0 ? "1px solid rgba(60,60,67,0.06)" : "none",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}
              >
                {/* Row 1: merchant + status + amount */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontSize: 14, fontWeight: 700, color: "#1C1C1E", margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tx.merchantName}</p>
                    <p style={{ fontSize: 11, color: "rgba(60,60,67,0.4)", margin: "2px 0 0", fontFamily: "monospace" }}>{truncate(tx.toAddress, 6, 4)}</p>
                  </div>
                  <div style={{ textAlign: "right", flexShrink: 0, marginLeft: 12 }}>
                    <p style={{ fontSize: 15, fontWeight: 800, color: "#0A1F1A", margin: 0, letterSpacing: "-0.3px" }}>
                      {parseFloat(tx.amount).toFixed(4)} <span style={{ color: "#00D1A0", fontSize: 12 }}>{tx.coin}</span>
                    </p>
                    {tx.amountUsd && (
                      <p style={{ fontSize: 11, color: "rgba(60,60,67,0.4)", margin: "2px 0 0" }}>≈ ${parseFloat(tx.amountUsd).toFixed(2)} USD</p>
                    )}
                  </div>
                </div>

                {/* Row 2: date + status badge */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 11, color: "rgba(60,60,67,0.4)" }}>
                    {new Date(tx.createdAt).toLocaleString()}
                  </span>
                  <span style={{
                    fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 20,
                    background: `${STATUS_COLORS[tx.status]}15`,
                    color: STATUS_COLORS[tx.status],
                    textTransform: "uppercase", letterSpacing: "0.06em",
                  }}>
                    {getTransactionStatusLabel(tx.status)}
                  </span>
                </div>

                {/* Row 3: memo */}
                {tx.memo && (
                  <p style={{ fontSize: 12, color: "rgba(60,60,67,0.6)", margin: 0, fontStyle: "italic" }}>"{tx.memo}"</p>
                )}

                {/* Row 4: tx hash */}
                {tx.txHash && (
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 11, fontFamily: "monospace", color: "rgba(60,60,67,0.4)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {truncate(tx.txHash, 10, 8)}
                    </span>
                    <button
                      onClick={() => tx.txHash && copyToClipboard(tx.txHash, tx.id)}
                      aria-label="Copy transaction hash"
                      style={{ background: "none", border: "none", cursor: "pointer", padding: 2, color: copiedId === tx.id ? "#34C759" : "rgba(60,60,67,0.3)", flexShrink: 0 }}
                    >
                      <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                    </button>
                    <a
                      href={`https://sepolia.etherscan.io/tx/${tx.txHash}`}
                      target="_blank"
                      rel="noreferrer"
                      aria-label="View on Etherscan"
                      style={{ color: "#00B88A", fontSize: 11, textDecoration: "none", fontWeight: 500, flexShrink: 0 }}
                    >
                      ↗
                    </a>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
