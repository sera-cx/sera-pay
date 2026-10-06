import { useState } from "react";
import { getReceiptInitial } from "@/lib/receipt-branding";

export function ReceiptMerchantLogo({ name, logo, size = 48 }: { name: string; logo?: string | null; size?: number }) {
  const [failedLogo, setFailedLogo] = useState<string | null>(null);
  const showLogo = !!logo && failedLogo !== logo;
  return (
    <div style={{
      width: size, height: size, margin: "0 auto 7px", boxSizing: "border-box",
      display: "flex", alignItems: "center", justifyContent: "center", background: "#fff",
      borderRadius: showLogo ? 6 : "50%", border: showLogo ? "none" : "2px solid #00D1A0",
      color: "#00D1A0", fontFamily: "Helvetica, Arial, sans-serif", fontSize: size * 0.42,
      fontWeight: "bold", lineHeight: 1,
    }}>
      {showLogo ? (
        <img src={logo} alt={`${name || "Merchant"} logo`} onError={() => setFailedLogo(logo)}
          style={{ width: "100%", height: "100%", borderRadius: 6, display: "block", objectFit: "contain" }} />
      ) : getReceiptInitial(name)}
    </div>
  );
}
