import React, { useState, useEffect, useRef, useCallback } from "react";
import { useParams } from "wouter";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { parseUnits } from "viem";
import { ChevronRight, Chrome, MoreHorizontal, Network, Wallet } from "lucide-react";
import { STABLECOINS, getStablecoinBySymbol, getStablecoinLogoUrl, type Stablecoin } from "@/lib/stablecoins";
import { decodePaymentRequest } from "@/lib/payment";
import { buildClientAppUrl } from "@/lib/app-url";
import { getCurrencyRate } from "@/lib/currencyCalculator";
import { SeraPayHeader } from "@/components/SeraPayHeader";
import { detectLocale, getTranslations, RTL_LOCALES } from "@/lib/i18n";
import jsPDF from "jspdf";

const font = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Inter', sans-serif";

const TOKEN_COLORS: Record<string, string> = {
  USDT: "#26A17B", USDC: "#2775CA", XSGD: "#EF3E42", MYRT: "#CC0001",
  IDRX: "#E4002B", IDRT: "#E4002B", EURC: "#003399", AUDD: "#00843D",
  JPYC: "#BC002D", THBT: "#A51931", CADC: "#FF0000", BRZ: "#009C3B",
  VGBP: "#012169", MXNT: "#006847", ZARP: "#007A4D", CNGN: "#008751",
  DAI: "#F5AC37", PYUSD: "#003087", FRAX: "#6B6B6B",
  GYEN: "#BC002D", XSGD2: "#EF3E42", TNSGD: "#EF3E42",
  GBPA: "#012169", TGBP: "#012169", VEUR: "#003399",
  AUDF: "#00843D", CADC2: "#FF0000", QCAD: "#FF0000",
  BRLA: "#009C3B", KRW1: "#C60C30", KRWO: "#C60C30", KRWIN: "#C60C30",
  XIDR: "#E4002B", CCHF: "#D52B1E", VCHF: "#D52B1E",
  MXNB: "#006847", NZDD: "#00247D", NZDS: "#00247D",
  THBK: "#A51931", ZARU: "#007A4D", ARC: "#FF9933",
  TRYB: "#E30A17", PHPC: "#0038A8", HKDR: "#DE2910",
  CNHT: "#DE2910", ARZ: "#74ACDF",
};

// ERC-20 contract addresses per chain
// Sepolia (11155111) addresses sourced from https://docs.sera.cx/tokens
const COIN_ADDRESSES: Record<string, Record<number, `0x${string}`>> = {
  // USD
  USDC: {
    1: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    137: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    42161: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    11155111: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  },
  USDT: {
    1: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    137: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
    42161: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
    11155111: "0x1920bf0643ae49B4fB334586dAd6Bed29fF30F88",
  },
  // EUR
  EURC: {
    1: "0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c",
    8453: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42",
    11155111: "0xd3BdB2CE9cD98566EFc2e2977448c40578371779",
  },
  EURT: {
    11155111: "0x47230df72231f594C5c598635dD92849C11532D0",
  },
  TNEUR: {
    11155111: "0xe4AF44eF7ce074F8FA94131035108201A5ac2F3a",
  },
  VEUR: {
    11155111: "0x4AbcbC7C307baCF5AdbFc57E822658F5D917Ca1E",
  },
  // GBP
  GBPA: {
    11155111: "0xD685BC15a53bbb624B98Ebf97B357DB8e0DA4A23",
  },
  TGBP: {
    11155111: "0xA26f1088f41714B696d0e7b117FA9cbd810bbE8B",
  },
  VGBP: {
    1: "0x39C2a0af4a9c797b4d4f3e2a0a3e8e5c6e9e2e2e",
    11155111: "0x01d8b6E34a57573Ff48d49fA047b45054f939eDa",
  },
  // SGD
  XSGD: {
    1: "0x70e8dE73cE538DA2bEEd35d14187F6959a8ecA96",
    137: "0xDC3326e71D45186F113a2F448984CA0e8D201995",
    11155111: "0x1Fe69B1171d8aA5e6d432F14A9E4129ED96E40C0",
  },
  TNSGD: {
    11155111: "0x4638F8eB9F2047Ab18d70E12539E0B16fF2998A2",
  },
  // JPY
  GYEN: {
    11155111: "0xA39c3648Cd2b5a183Af33Dcc30af6799A13aD7ae",
  },
  JPYC: {
    11155111: "0x2C9e4Db557af394f1F21d1E1E6754a7CB1eC1D01",
  },
  // AUD
  AUDD: {
    11155111: "0x03A8D551Bf1d708471064aA97FeA004a45Ed8CF3",
  },
  AUDF: {
    11155111: "0x06dCE1A62f5D3188d016e640F3a9dd3bB26f9431",
  },
  // CAD
  CADC: {
    11155111: "0xaE64cEB804292F737C28e0Bd552d929041662970",
  },
  QCAD: {
    11155111: "0x3BDB8BE37Ad586852ad005C5a0885211CD803250",
  },
  // BRL
  BRLA: {
    11155111: "0x6B5256523aCD840aE97AeDE492cB31a5D500Fdf9",
  },
  BRZ: {
    11155111: "0x1B7fA411238bf745138a59Cbd90Fb8480D85c130",
  },
  // KRW
  KRW1: {
    11155111: "0x01943628c3E70A4F39CE905e8fea56E7A8a357F8",
  },
  KRWO: {
    11155111: "0x4C16AF20C7f8a841397273955c6451F4fEB6a576",
  },
  KRWIN: {
    11155111: "0xCE2dDC28068b3929ECF9787ec47284A9e3a62B3a",
  },
  // IDR
  IDRX: {
    11155111: "0x258f1E146b8Bd0dEcf54bAD8f1f01fE69025601c",
  },
  IDRT: {
    11155111: "0x26db12e7cB7Be8Ab22a97B7e4c3d33C0bfE89e82",
  },
  XIDR: {
    11155111: "0xe02bbf861736147e1506d07239d7f2D291FB39fC",
  },
  // CHF
  CCHF: {
    11155111: "0xA6B42B17219C854E4a44F40ed93d15A5FD88676E",
  },
  VCHF: {
    11155111: "0x1e7Fd8256Cff4C61519e9E7E5E9d0496a14b0D5B",
  },
  // MXN
  MXNT: {
    11155111: "0x6750EEC6a189BCBc4a9A52EE285b525c8D1940F3",
  },
  MXNB: {
    11155111: "0x510139cC0B118711ACCf9ec476b3093dF0BBb1FC",
  },
  // NZD
  NZDD: {
    11155111: "0x2cDc20d7eFEe786d28529ecC8a0A491Bee84b207",
  },
  NZDS: {
    11155111: "0xA6DA6F948F6C95D4D6525856208B1A267a37c905",
  },
  // THB
  THBT: {
    11155111: "0x5e875193255BfE0557701DceB01831C7bDFa910b",
  },
  THBK: {
    11155111: "0x696451A335EB929934a1020Db4ED655f33765802",
  },
  // ZAR
  ZARP: {
    11155111: "0x409667Ce4E4674E9fB8272774AAbFfBB7c8956a4",
  },
  ZARU: {
    11155111: "0x721CB3e2B0BA43b0a51f2179b7D260DD98d4BAF1",
  },
  // Other
  MYRT: {
    1: "0x3fc98a885e99420d0ce43bcb81bf21a4e3f45e5f",
    11155111: "0x68077f53a6562D42051C86b09160EA577f3C7476",
  },
  TRYB: {
    11155111: "0x0d2968Dc1b9EC131bEcaB8e28193e81Bcd63040c",
  },
  PHPC: {
    11155111: "0x9aA087afD8C3EadA4f52Dfe61aaC507Bf845BC29",
  },
  HKDR: {
    11155111: "0x40ad01c5ade2a9202D110C621919D0a2b147EB97",
  },
  CNHT: {
    11155111: "0x8f3F6bE3f2545d5d90275f0dA98980264F6a8913",
  },
  ARZ: {
    11155111: "0x3A2498C86Db0e4a2E8766649f368cBD37Fe6D52a",
  },
  ARC: {
    11155111: "0xDbb492152eBd689ceF184C17e6F65AB18DCDe627",
  },
  CNGN: {
    11155111: "0x82167feCbB10C496F75afcD933DC0E23891E1CF3",
  },
  A7A5: {
    11155111: "0xEf6182c0DB1466b4B24608360bEf8376A6A0578d",
  },
};

const CHAIN_NAMES: Record<number, string> = {
  1: "Ethereum", 137: "Polygon", 8453: "Base", 42161: "Arbitrum", 11155111: "Sepolia",
};

const RATE_TTL_SECONDS = 60; // 1 minute before rate expires

function formatTokenAmount(value: number) {
  if (!Number.isFinite(value)) return "0.00";
  if (value >= 1) return value.toFixed(2);
  return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, ".00");
}

async function totalOrderItemsInCoin(
  items: Array<{ p: string; q: number; c?: string }>,
  fallbackCoin: string,
  targetCoin: string,
  chainId?: number,
) {
  let total = 0;
  const convertedCoins = new Set<string>();
  const rateCache = new Map<string, number>();
  for (const item of items) {
    const sourceCoin = (item.c || fallbackCoin).toUpperCase();
    const lineTotal = Number(item.p) * item.q;
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
    convertedCoins.add(sourceCoin);
  }
  return { amount: formatTokenAmount(total), convertedCoins: Array.from(convertedCoins) };
}

/** Returns coins that have a contract address on the given chain */
function getSupportedCoins(chainId: number): Stablecoin[] {
  if (chainId === 1) return STABLECOINS;
  return STABLECOINS.filter(c => !!COIN_ADDRESSES[c.symbol]?.[chainId]);
}

function TokenIcon({ symbol, size = 36 }: { symbol: string; size?: number }) {
  const [imageFailed, setImageFailed] = useState(false);
  const logoUrl = !imageFailed ? getStablecoinLogoUrl(symbol) : undefined;
  if (logoUrl) {
    return (
      <img
        src={logoUrl}
        alt={`${symbol} logo`}
        onError={() => setImageFailed(true)}
        style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", background: "rgba(0,0,0,0.05)", flexShrink: 0 }}
      />
    );
  }
  const coin = getStablecoinBySymbol(symbol);
  const flagEmoji = coin?.icon;
  if (flagEmoji) {
    return (
      <div style={{ width: size, height: size, borderRadius: "50%", background: "rgba(0,0,0,0.05)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontSize: size * 0.55 }}>
        <span role="img" aria-label={symbol}>{flagEmoji}</span>
      </div>
    );
  }
  const color = TOKEN_COLORS[symbol] ?? "#888";
  return (
    <div style={{ width: size, height: size, borderRadius: "50%", background: color, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
      <span style={{ fontSize: size * 0.38, fontWeight: 700, color: "#fff", letterSpacing: "-0.5px" }}>{symbol.slice(0, 2)}</span>
    </div>
  );
}

function Spinner({ size = 32, color = "#00D1A0" }: { size?: number; color?: string }) {
  return <div style={{ width: size, height: size, border: `3px solid ${color}22`, borderTop: `3px solid ${color}`, borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />;
}

function CoinSheet({ onClose, onSelect, selectedSymbol, receiveCoin, supportedCoins, searchPlaceholder }: {
  onClose: () => void; onSelect: (c: Stablecoin) => void; selectedSymbol?: string; receiveCoin?: string; supportedCoins: Stablecoin[]; searchPlaceholder?: string;
}) {
  const [query, setQuery] = useState("");
  const [focusIdx, setFocusIdx] = useState(-1);
  const listRef = React.useRef<HTMLDivElement>(null);
  const filtered = query
    ? supportedCoins.filter(c => c.symbol.toLowerCase().includes(query.toLowerCase()) || c.name.toLowerCase().includes(query.toLowerCase()))
    : supportedCoins;

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { onClose(); return; }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocusIdx(prev => Math.min(prev + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusIdx(prev => Math.max(prev - 1, 0));
    } else if (e.key === "Enter" && focusIdx >= 0 && filtered[focusIdx]) {
      onSelect(filtered[focusIdx]); onClose();
    }
  };

  // Scroll focused item into view
  React.useEffect(() => {
    if (focusIdx >= 0 && listRef.current) {
      const btn = listRef.current.querySelectorAll<HTMLButtonElement>("button[data-coin]")[focusIdx];
      btn?.scrollIntoView({ block: "nearest" });
    }
  }, [focusIdx]);

  return (
    <>
      <style>{`
        @keyframes slideUp { from { transform: translate(-50%, 100%); } to { transform: translate(-50%, 0); } }
      `}</style>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Select payment coin"
        style={{ position: "fixed", inset: 0, zIndex: 40, background: "rgba(0,0,0,0.4)", backdropFilter: "blur(4px)" }}
        onClick={onClose}
        onKeyDown={handleKeyDown}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Select payment coin"
        style={{ position: "fixed", bottom: 0, left: "50%", transform: "translate(-50%, 0)", width: "100%", maxWidth: 480, zIndex: 50, background: "#fff", borderRadius: "20px 20px 0 0", maxHeight: "70dvh", display: "flex", flexDirection: "column", animation: "slideUp 0.3s ease-out", boxShadow: "0 -4px 32px rgba(0,0,0,0.12)" }}
        onKeyDown={handleKeyDown}
      >
        <div style={{ padding: "16px 20px 12px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h3 id="coin-sheet-title" style={{ fontSize: 17, fontWeight: 700, color: "#1C1C1E", margin: 0 }}>Pay With</h3>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {receiveCoin && <span style={{ fontSize: 12, color: "rgba(60,60,67,0.5)", background: "#F2F2F7", padding: "4px 10px", borderRadius: 20 }}>Merchant receives {receiveCoin}</span>}
            <button onClick={onClose} aria-label="Close coin selector" style={{ background: "none", border: "none", cursor: "pointer", padding: 4, color: "rgba(60,60,67,0.4)", display: "flex", alignItems: "center" }}>
              <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>
        </div>
        <div style={{ padding: "0 16px 12px" }}>
          <input
            type="text"
            placeholder={searchPlaceholder || "Search coins…"}
            value={query}
            onChange={e => { setQuery(e.target.value); setFocusIdx(-1); }}
            aria-label="Search coins"
            autoFocus
            style={{ width: "100%", height: 38, padding: "0 14px", fontSize: 14, background: "#F2F2F7", border: "none", borderRadius: 12, outline: "none", boxSizing: "border-box", color: "#1C1C1E", fontFamily: font }}
          />
        </div>
        <div ref={listRef} role="listbox" aria-labelledby="coin-sheet-title" style={{ flex: 1, overflowY: "auto", paddingBottom: 32 }}>
          {filtered.length === 0 && (
            <p style={{ textAlign: "center", padding: "24px 20px", fontSize: 13, color: "rgba(60,60,67,0.4)" }}>No supported coins found for this network.</p>
          )}
          {filtered.map((c, i) => (
            <button
              key={c.symbol}
              data-coin={c.symbol}
              role="option"
              aria-selected={selectedSymbol === c.symbol}
              onClick={() => { onSelect(c); onClose(); }}
              style={{
                width: "100%", display: "flex", alignItems: "center", gap: 12, padding: "12px 20px",
                background: focusIdx === i ? "rgba(0,209,160,0.06)" : "none",
                border: "none", borderTop: i > 0 ? "1px solid rgba(60,60,67,0.06)" : "none", cursor: "pointer",
                outline: focusIdx === i ? "2px solid #00D1A0" : "none", outlineOffset: -2,
              }}
            >
              <TokenIcon symbol={c.symbol} size={36} />
              <div style={{ flex: 1, textAlign: "left" }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#1C1C1E" }}>{c.symbol}</div>
                <div style={{ fontSize: 12, color: "rgba(60,60,67,0.5)" }}>{c.name}</div>
              </div>
              {selectedSymbol === c.symbol && <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="#00D1A0" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

/** Rate-changed confirmation modal */
function RateChangedModal({ oldAmount, newAmount, coin, onAccept, onCancel }: {
  oldAmount: string; newAmount: string; coin: string; onAccept: () => void; onCancel: () => void;
}) {
  return (
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 60, background: "rgba(0,0,0,0.5)", backdropFilter: "blur(4px)" }} />
      <div style={{ position: "fixed", inset: 0, zIndex: 70, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <div style={{ background: "#fff", borderRadius: 20, padding: "28px 24px", maxWidth: 360, width: "100%", boxShadow: "0 8px 40px rgba(0,0,0,0.15)" }}>
          <div style={{ width: 52, height: 52, borderRadius: "50%", background: "#FFF8E6", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
            <svg width="24" height="24" fill="none" viewBox="0 0 24 24" stroke="#F59E0B" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /></svg>
          </div>
          <h3 style={{ fontSize: 17, fontWeight: 700, color: "#1C1C1E", margin: "0 0 8px", textAlign: "center" }}>Exchange Rate Updated</h3>
          <p style={{ fontSize: 13, color: "rgba(60,60,67,0.6)", margin: "0 0 20px", textAlign: "center", lineHeight: 1.5 }}>
            The rate has changed since you last saw it.
          </p>
          <div style={{ background: "#F9F9FB", borderRadius: 12, padding: "12px 16px", marginBottom: 20 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
              <span style={{ fontSize: 12, color: "rgba(60,60,67,0.5)" }}>Previous amount</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: "rgba(60,60,67,0.5)", textDecoration: "line-through" }}>{oldAmount} {coin}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontSize: 12, color: "rgba(60,60,67,0.5)" }}>New amount</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: "#1C1C1E" }}>{newAmount} {coin}</span>
            </div>
          </div>
          <button onClick={onAccept} className="serapay-action-primary serapay-shine-button" style={{ width: "100%", height: 50, borderRadius: 14, background: "linear-gradient(135deg, #4ECE9A, #3AB882)", border: "none", color: "#fff", fontSize: 15, fontWeight: 700, cursor: "pointer", marginBottom: 10 }}>
            Accept & Pay {newAmount} {coin}
          </button>
          <button onClick={onCancel} style={{ width: "100%", height: 44, borderRadius: 14, background: "none", border: "none", color: "rgba(60,60,67,0.5)", fontSize: 14, cursor: "pointer" }}>
            Cancel
          </button>
        </div>
      </div>
    </>
  );
}

type Phase = "loading" | "connect" | "select-coin" | "paying" | "success" | "failed" | "invalid";
type PaymentLoginMethod = "wallet" | "google" | "email" | "telegram";

export default function PayPage() {
  const { encoded } = useParams<{ encoded: string }>();
  const { ready, authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const isConnected = authenticated;

  const [phase, setPhase] = useState<Phase>("loading");
  const [req, setReq] = useState<ReturnType<typeof decodePaymentRequest> | null>(null);
  const [selectedCoin, setSelectedCoin] = useState<Stablecoin | null>(null);
  const [showCoinSheet, setShowCoinSheet] = useState(false);
  const [txHash, setTxHash] = useState("");
  const [txId, setTxId] = useState("");
  const [txError, setTxError] = useState("");
  const [merchantName, setMerchantName] = useState("");
  const [merchantLogo, setMerchantLogo] = useState("");
  const [copied, setCopied] = useState(false);
  const [addrCopied, setAddrCopied] = useState(false);

  // Live FX state
  const [payAmount, setPayAmount] = useState<string | null>(null);
  const [receiveAmount, setReceiveAmount] = useState<string | null>(null);
  const [displayRate, setDisplayRate] = useState<string | null>(null); // e.g. "1 XSGD ≈ 3.52 MYRT"
  const [rateLoading, setRateLoading] = useState(false);
  const [rateExpiry, setRateExpiry] = useState<number | null>(null); // timestamp ms when rate expires
  const [countdown, setCountdown] = useState(RATE_TTL_SECONDS);
  const rateRef = useRef<number | null>(null); // raw rate number for comparison

  // Rate-changed confirmation
  const [showRateChanged, setShowRateChanged] = useState(false);
  const [pendingNewAmount, setPendingNewAmount] = useState<string | null>(null);

  // i18n
  const [locale] = useState(() => detectLocale());
  const t = getTranslations(locale);
  const isRTL = RTL_LOCALES.has(locale);
  // Memo / reference
  const [memo, setMemo] = useState("");
  // Order items collapsible
  const [orderItemsExpanded, setOrderItemsExpanded] = useState(false);

  // Open-amount validation
  const [amountError, setAmountError] = useState("");

  // Itemised order conversion
  const [unifiedAmount, setUnifiedAmount] = useState<string | null>(null); // e.g. "~104.00"
  const [unifiedCoin, setUnifiedCoin] = useState<string | null>(null);     // e.g. "USDC"
  const [unifiedNote, setUnifiedNote] = useState<string | null>(null);     // e.g. "Includes EURT items converted at live rate"
  const [unifiedLoading, setUnifiedLoading] = useState(false);
  const [rateRefreshKey, setRateRefreshKey] = useState(0);
  const chainId = req?.chainId ?? 1;

  // Compute itemised order total in the currently selected payment coin.
  useEffect(() => {
    if (!req?.orderItems || req.orderItems.length === 0 || !selectedCoin) {
      setUnifiedAmount(null); setUnifiedCoin(null); setUnifiedNote(null); setReceiveAmount(null);
      return;
    }
    const orderItems = req.orderItems;
    setUnifiedLoading(true);
    let cancelled = false;
    (async () => {
      try {
        const targetCoin = selectedCoin.symbol;
        const [payTotal, receiveTotal] = await Promise.all([
          totalOrderItemsInCoin(orderItems, req.receiveCoin, targetCoin, chainId),
          totalOrderItemsInCoin(orderItems, req.receiveCoin, req.receiveCoin, chainId),
        ]);
        if (cancelled) return;
        setPayAmount(payTotal.amount);
        setReceiveAmount(receiveTotal.amount);
        setUnifiedAmount(`${payTotal.convertedCoins.length ? "~" : ""}${payTotal.amount}`);
        setUnifiedCoin(targetCoin);
        setUnifiedNote(payTotal.convertedCoins.length ? `Includes ${payTotal.convertedCoins.join(", ")} converted at live rate` : null);
        setDisplayRate(null);
        setRateExpiry(Date.now() + RATE_TTL_SECONDS * 1000);
        setCountdown(RATE_TTL_SECONDS);
      } catch {
        setUnifiedAmount(null); setUnifiedCoin(null); setUnifiedNote(null); setReceiveAmount(req.amount || null);
      } finally {
        if (!cancelled) setUnifiedLoading(false);
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req, selectedCoin?.symbol, rateRefreshKey, chainId]);

  const supportedCoins = getSupportedCoins(chainId);
  const requiresSeraSwap = Boolean(req && selectedCoin && selectedCoin.symbol !== req.receiveCoin);
  const selectedCoinSupported = Boolean(selectedCoin && (requiresSeraSwap || COIN_ADDRESSES[selectedCoin.symbol]?.[chainId]));
  // True when the payment request has no fixed amount — customer types their own amount
  const isOpenAmount = !req?.amount;

  // Gas fee estimation
  const [gasUsd, setGasUsd] = useState<string | null>(null);
  useEffect(() => {
    if (!selectedCoin) { setGasUsd(null); return; }
    const ERC20_GAS = 65000n;
    const chainRpc: Record<number, string> = {
      11155111: import.meta.env.VITE_SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
      1: import.meta.env.VITE_MAINNET_RPC_URL || "https://ethereum-rpc.publicnode.com",
      137: import.meta.env.VITE_POLYGON_RPC_URL || "https://polygon-bor-rpc.publicnode.com",
      8453: import.meta.env.VITE_BASE_RPC_URL || "https://base-rpc.publicnode.com",
      42161: import.meta.env.VITE_ARBITRUM_RPC_URL || "https://arbitrum-one-rpc.publicnode.com",
    };
    const rpc = chainRpc[chainId] || chainRpc[11155111];
    let cancelled = false;
    (async () => {
      try {
        const [gasRes, priceRes] = await Promise.all([
          fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "eth_gasPrice", params: [], id: 1 }) }),
          fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd"),
        ]);
        if (cancelled) return;
        const gasData = await gasRes.json();
        const priceData = await priceRes.json();
        const gasPriceWei = BigInt(gasData.result || "0x0");
        const ethUsd: number = priceData?.ethereum?.usd || 0;
        if (!gasPriceWei || !ethUsd) { setGasUsd(null); return; }
        const gasCostWei = gasPriceWei * ERC20_GAS;
        const gasCostEth = Number(gasCostWei) / 1e18;
        const gasCostUsd = gasCostEth * ethUsd;
        if (!cancelled) setGasUsd(gasCostUsd < 0.01 ? "<$0.01" : `~$${gasCostUsd.toFixed(2)}`);
      } catch { if (!cancelled) setGasUsd(null); }
    })();
    return () => { cancelled = true; };
  }, [selectedCoin, chainId]);

  useEffect(() => {
    if (!encoded) { setPhase("invalid"); return; }
    try {
      const decoded = decodePaymentRequest(encoded);
      if (!decoded?.receiverAddress) { setPhase("invalid"); return; }
      setReq(decoded);
      const preferredSymbol = decoded.payCoin || decoded.receiveCoin;
      if (preferredSymbol) {
        const coin = STABLECOINS.find(c => c.symbol.toUpperCase() === preferredSymbol.toUpperCase());
        if (coin) setSelectedCoin(coin);
      }
      // Check expiry
      if (decoded.expiresAt && Date.now() > decoded.expiresAt) {
        setPhase("invalid"); return;
      }
      if (decoded.merchantName) setMerchantName(decoded.merchantName);
      fetch(`/api/merchant/public/${decoded.receiverAddress}`)
        .then(r => r.json())
        .then(d => {
          if (d.name && !decoded.merchantName) setMerchantName(d.name);
          if (d.logoData) setMerchantLogo(d.logoData);
        })
        .catch(() => {});
      setPhase((ready && isConnected) ? "select-coin" : "connect");
    } catch { setPhase("invalid"); }
  }, [encoded, ready, isConnected]);

  useEffect(() => {
    if (phase === "connect" && ready && isConnected) setPhase("select-coin");
  }, [ready, isConnected, phase]);

  // Fetch FX rate
  const fetchRate = useCallback(async (receiveCoin: string, payCoin: string, amount: string, rateChainId: number) => {
    if (payCoin === receiveCoin) {
      setPayAmount(amount);
      setDisplayRate(null);
      rateRef.current = 1;
      setRateExpiry(Date.now() + RATE_TTL_SECONDS * 1000);
      setCountdown(RATE_TTL_SECONDS);
      return;
    }
    setRateLoading(true);
    try {
      const res = await fetch(`/api/rates?from=${receiveCoin}&to=${payCoin}&chainId=${rateChainId}`);
      const data = await res.json();
      if (data.rate) {
        const converted = parseFloat(amount) * data.rate;
        const formatted = converted >= 1
          ? converted.toLocaleString(undefined, { maximumFractionDigits: 2 })
          : converted.toFixed(6);
        setPayAmount(formatted);
        rateRef.current = data.rate;
        setDisplayRate(`1 ${receiveCoin} ≈ ${data.rate >= 1 ? data.rate.toLocaleString(undefined, { maximumFractionDigits: 4 }) : data.rate.toFixed(6)} ${payCoin}`);
        setRateExpiry(Date.now() + RATE_TTL_SECONDS * 1000);
        setCountdown(RATE_TTL_SECONDS);
      } else {
        setPayAmount(null);
        setDisplayRate(null);
      }
    } catch {
      setPayAmount(null);
      setDisplayRate(null);
    } finally {
      setRateLoading(false);
    }
  }, []);

  // Fetch rate when coin/req changes
  useEffect(() => {
    if (!req?.receiveCoin || !selectedCoin) { setPayAmount(null); setDisplayRate(null); return; }
    if (req.orderItems?.length) return;
    if (req.payAmount && req.payCoin === selectedCoin.symbol) {
      setPayAmount(req.payAmount);
      setDisplayRate(null);
      return;
    }
    if (!req.amount) { setPayAmount(null); setDisplayRate(null); return; }
    fetchRate(req.receiveCoin, selectedCoin.symbol, req.amount, chainId);
  }, [selectedCoin, req, fetchRate, chainId]);

  // Countdown timer
  useEffect(() => {
    if (!rateExpiry) return;
    const interval = setInterval(() => {
      const remaining = Math.max(0, Math.round((rateExpiry - Date.now()) / 1000));
      setCountdown(remaining);
      if (remaining === 0 && req?.orderItems?.length && selectedCoin) {
        setRateRefreshKey(value => value + 1);
      } else if (remaining === 0 && req?.receiveCoin && selectedCoin && req.amount) {
        // Auto-refresh
        fetchRate(req.receiveCoin, selectedCoin.symbol, req.amount, chainId);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [rateExpiry, req, selectedCoin, fetchRate, chainId]);

  // SSE listener + polling fallback for payment confirmation
  useEffect(() => {
    if (!txId) return;
    let closed = false;
    let pollInterval: ReturnType<typeof setInterval> | null = null;

    const handleConfirmed = () => {
      if (closed) return;
      closed = true;
      setPhase("success");
      if (pollInterval) clearInterval(pollInterval);
    };

    // SSE stream
    const es = new EventSource(`/api/payment/events/${txId}`);
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.status === "confirmed") { es.close(); handleConfirmed(); }
      } catch {}
    };
    // Don't close on error — let browser auto-reconnect
    es.onerror = () => { /* let browser retry */ };

    // Polling fallback every 5s (handles SSE blocked by browser/network)
    pollInterval = setInterval(async () => {
      if (closed) { clearInterval(pollInterval!); return; }
      try {
        const res = await fetch(`/api/payment/status/${txId}`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.status === "confirmed") { es.close(); handleConfirmed(); }
        if (data.status === "failed") {
          closed = true;
          clearInterval(pollInterval!);
          setPhase("failed");
          setTxError("Payment verification failed. Please contact the merchant.");
        }
      } catch { /* ignore poll errors */ }
    }, 5000);

    return () => {
      closed = true;
      es.close();
      if (pollInterval) clearInterval(pollInterval);
    };
  }, [txId]);

  const executePay = useCallback(async (finalPayAmount: string, finalReceiveAmount?: string) => {
    if (!req || !selectedCoin) return;
    setPhase("paying");
    setTxError("");
    try {
      const wallet = wallets?.[0];
      if (!wallet) throw new Error("No wallet connected");
      const provider = await wallet.getEthereumProvider();
      const cid = req.chainId ?? 1;

      try {
        await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: `0x${cid.toString(16)}` }] });
      } catch (switchErr: any) {
        if (switchErr.code === 4902) throw new Error("Please add this network to your wallet first.");
      }

      const sendAmount = finalPayAmount.replace(/,/g, "");
      const receiveAmountForQuote = (finalReceiveAmount || receiveAmount || req.amount || finalPayAmount).replace(/,/g, "");

      if (requiresSeraSwap) {
        const quoteRes = await fetch("/api/payment/swap/quote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            merchantAddress: req.receiverAddress,
            payerAddress: wallet.address,
            payCoin: selectedCoin.symbol,
            receiveCoin: req.receiveCoin,
            payAmount: sendAmount,
            receiveAmount: receiveAmountForQuote,
            chainId: cid,
            paymentIntentId: (req as any).paymentIntentId,
            orderId: (req as any).orderId,
          }),
        });
        const quoteData = await quoteRes.json();
        if (!quoteRes.ok) throw new Error(quoteData.error || "Failed to create Sera swap quote");
        setTxId(quoteData.txId);

        let permitSignature: string | undefined;
        if (quoteData.permitTypedData) {
          permitSignature = await provider.request({
            method: "eth_signTypedData_v4",
            params: [wallet.address, JSON.stringify(quoteData.permitTypedData)],
          }) as string;
        }

        const signature = await provider.request({
          method: "eth_signTypedData_v4",
          params: [wallet.address, JSON.stringify(quoteData.intentTypedData)],
        }) as string;

        const submitRes = await fetch("/api/payment/swap/submit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            txId: quoteData.txId,
            quoteUuid: quoteData.quoteUuid,
            signature,
            permitSignature,
            permitDeadline: quoteData.permitDeadline,
          }),
        });
        const submitData = await submitRes.json();
        if (!submitRes.ok) throw new Error(submitData.error || "Failed to submit Sera swap");
        if (submitData.txHash) setTxHash(submitData.txHash);
        if (submitData.status === "confirmed") setPhase("success");
        return;
      }

      const coinAddress = COIN_ADDRESSES[selectedCoin.symbol]?.[cid];
      if (!coinAddress) throw new Error(`${selectedCoin.symbol} not supported on ${CHAIN_NAMES[cid] || "this network"}`);

      const createRes = await fetch("/api/payment/create", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ merchantAddress: req.receiverAddress, coin: selectedCoin.symbol, amount: sendAmount, chainId: cid, orderId: (req as any).orderId, paymentUrl: window.location.href }),
      });
      const createData = await createRes.json();
      if (!createRes.ok) throw new Error(createData.error || "Failed to create payment");
      setTxId(createData.txId);

      const decimals = 6; // All Sera testnet tokens use 6 decimals
      const amountWei = parseUnits(sendAmount, decimals);
      const selector = "0xa9059cbb";
      const paddedTo = createData.toAddress.slice(2).padStart(64, "0");
      const paddedAmount = amountWei.toString(16).padStart(64, "0");
      const transferData = selector + paddedTo + paddedAmount;

      const hash = await provider.request({
        method: "eth_sendTransaction",
        params: [{ from: wallet.address, to: coinAddress, data: transferData, chainId: `0x${cid.toString(16)}` }],
      });

      setTxHash(hash as string);

      await fetch("/api/payment/notify", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ txId: createData.txId, txHash: hash, fromAddress: wallet.address }),
      });

    } catch (e: any) {
      setTxError(e?.code === 4001 || e?.message?.includes("rejected") ? "Transaction cancelled." : (e?.message || "Transaction failed"));
      setPhase("failed");
    }
  }, [req, selectedCoin, wallets, requiresSeraSwap, receiveAmount]);

  const openPrivyLogin = useCallback((loginMethods?: PaymentLoginMethod[]) => {
    try {
      if (loginMethods?.length) {
        login({ loginMethods });
        return;
      }
      login();
    } catch {}
  }, [login]);

  const handleConnectWallet = useCallback(() => openPrivyLogin(["wallet"]), [openPrivyLogin]);
  const handleGoogleLogin = useCallback(() => openPrivyLogin(["google"]), [openPrivyLogin]);
  const handleOtherLogin = useCallback(() => openPrivyLogin(["wallet", "email", "google", "telegram"]), [openPrivyLogin]);

  const handlePay = useCallback(async () => {
    if (!req || !selectedCoin || !payAmount) return;
    if (req.orderItems?.length) {
      setRateLoading(true);
      try {
        const [payTotal, receiveTotal] = await Promise.all([
          totalOrderItemsInCoin(req.orderItems, req.receiveCoin, selectedCoin.symbol, chainId),
          totalOrderItemsInCoin(req.orderItems, req.receiveCoin, req.receiveCoin, chainId),
        ]);
        setPayAmount(payTotal.amount);
        setReceiveAmount(receiveTotal.amount);
        setUnifiedAmount(`${payTotal.convertedCoins.length ? "~" : ""}${payTotal.amount}`);
        setUnifiedCoin(selectedCoin.symbol);
        setUnifiedNote(payTotal.convertedCoins.length ? `Includes ${payTotal.convertedCoins.join(", ")} converted at live rate` : null);
        await executePay(payTotal.amount, receiveTotal.amount);
      } catch {
        setTxError("Unable to refresh the currency conversion. Please try again.");
        setPhase("failed");
      } finally {
        setRateLoading(false);
      }
      return;
    }
    // If same coin, no rate check needed
    if (selectedCoin.symbol === req.receiveCoin || !req.amount) {
      await executePay(payAmount);
      return;
    }
    // Re-fetch rate to check for changes
    setRateLoading(true);
    try {
      const res = await fetch(`/api/rates?from=${req.receiveCoin}&to=${selectedCoin.symbol}&chainId=${chainId}`);
      const data = await res.json();
      if (data.rate) {
        const newConverted = parseFloat(req.amount) * data.rate;
        const newFormatted = newConverted >= 1
          ? newConverted.toLocaleString(undefined, { maximumFractionDigits: 2 })
          : newConverted.toFixed(6);
        const oldNum = parseFloat(payAmount.replace(/,/g, ""));
        const newNum = newConverted;
        const changePct = Math.abs((newNum - oldNum) / oldNum) * 100;
        if (changePct > 0.5) {
          // Rate changed more than 0.5% — ask user
          setPendingNewAmount(newFormatted);
          setPayAmount(newFormatted);
          rateRef.current = data.rate;
          setDisplayRate(`1 ${req.receiveCoin} ≈ ${data.rate >= 1 ? data.rate.toLocaleString(undefined, { maximumFractionDigits: 4 }) : data.rate.toFixed(6)} ${selectedCoin.symbol}`);
          setRateExpiry(Date.now() + RATE_TTL_SECONDS * 1000);
          setCountdown(RATE_TTL_SECONDS);
          setShowRateChanged(true);
          setRateLoading(false);
          return;
        }
        // Rate within tolerance — proceed
        await executePay(newFormatted);
      } else {
        // Can't get rate — proceed with existing amount
        await executePay(payAmount);
      }
    } catch {
      // Network error — proceed with existing amount
      await executePay(payAmount);
    } finally {
      setRateLoading(false);
    }
  }, [req, selectedCoin, payAmount, executePay]);

  const handleDownloadReceipt = useCallback(async () => {
    const W = 80;
    const now = new Date();
    const dateStr = now.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    const timeStr = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const invoiceId = `SP-${now.toISOString().slice(0,10).replace(/-/g,"")}${Math.random().toString(36).slice(2,8).toUpperCase()}`;
    const paidAmount = payAmount || req?.amount || "—";
    const paidCoin = selectedCoin?.symbol || req?.payCoin || req?.receiveCoin || "";
    const receivedAmount = req?.amount || paidAmount;
    const receivedCoin = req?.receiveCoin || paidCoin;
    const chainName = CHAIN_NAMES[req?.chainId ?? 1] || "Ethereum";
    const addrShort = req?.receiverAddress ? `${req.receiverAddress.slice(0,6)}...${req.receiverAddress.slice(-4)}` : "";
    const isCrossToken = paidCoin !== receivedCoin;

    // Pre-load merchant logo as base64 if available
    let logoBase64 = "";
    let logoFormat: "JPEG" | "PNG" = "JPEG";
    if (merchantLogo) {
      try {
        const resp = await fetch(merchantLogo);
        const blob = await resp.blob();
        logoFormat = blob.type.includes("png") ? "PNG" : "JPEG";
        logoBase64 = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve((reader.result as string).split(",")[1]);
          reader.readAsDataURL(blob);
        });
      } catch { logoBase64 = ""; }
    }

    // Calculate dynamic height
    // Header(11) + logo(18) + merchant name(5) + addr(5) + divider(8) + invoice meta(18) + divider(8)
    // + conversion box(8 + boxRows*5.5 + 2) + network(10) + txHash(txHash ? 18 : 0) + divider(10) + footer(20)
    const boxRows = isCrossToken ? 4 : 3;
    const boxH = 8 + boxRows * 5.5;
    const estimatedH = 11 + 18 + (addrShort ? 10 : 5) + 8 + 18 + 8 + boxH + 2 + 10 + (txHash ? 20 : 0) + 10 + 20;
    const doc = new jsPDF({ unit: "mm", format: [W, Math.max(estimatedH, 140)] });

    // ── Green header bar ──
    doc.setFillColor(0, 200, 83);
    doc.rect(0, 0, W, 11, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(7); doc.setTextColor(255, 255, 255);
    doc.text("SERAPAY · PAYMENT RECEIPT", W / 2, 7, { align: "center" });

    // ── Merchant logo or initials avatar ──
    let y = 18;
    const logoSize = 14;
    const logoX = W / 2 - logoSize / 2;
    if (logoBase64) {
      // Circular clip via ellipse mask
      doc.addImage(logoBase64, logoFormat, logoX, y - logoSize / 2, logoSize, logoSize);
    } else {
      doc.setFillColor(0, 200, 83);
      doc.roundedRect(logoX, y - logoSize / 2, logoSize, logoSize, 3, 3, "F");
      doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.setTextColor(255, 255, 255);
      const initials = (merchantName || "S").split(" ").map((w: string) => w[0]).join("").slice(0,2).toUpperCase();
      doc.text(initials, W / 2, y + 2.5, { align: "center" });
    }
    y += logoSize / 2 + 4;

    doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.setTextColor(10, 31, 26);
    doc.text(merchantName || "Merchant", W / 2, y, { align: "center" });
    y += 5;
    if (addrShort) {
      doc.setFont("helvetica", "normal"); doc.setFontSize(7); doc.setTextColor(130, 130, 150);
      doc.text(`Wallet: ${addrShort}`, W / 2, y, { align: "center" });
      y += 5;
    }

    // ── Dashed divider ──
    doc.setDrawColor(210, 210, 220); doc.setLineDashPattern([1.2, 1.2], 0); doc.setLineWidth(0.25);
    doc.line(6, y, W - 6, y);
    doc.setLineDashPattern([], 0);
    y += 5;

    // ── Invoice meta (centered block) ──
    doc.setFont("helvetica", "bold"); doc.setFontSize(6.5); doc.setTextColor(160, 160, 180);
    doc.text(`INVOICE ${invoiceId}`, W / 2, y, { align: "center" });
    y += 4.5;
    doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor(40, 40, 55);
    doc.text(dateStr, W / 2, y, { align: "center" });
    y += 4.5;
    doc.setFontSize(7); doc.setTextColor(130, 130, 150);
    doc.text(timeStr, W / 2, y, { align: "center" });
    y += 6;

    // ── Solid divider ──
    doc.setDrawColor(230, 230, 235); doc.setLineDashPattern([], 0); doc.setLineWidth(0.25);
    doc.line(6, y, W - 6, y);
    y += 5;

    // ── Currency Conversion box ──
    doc.setFillColor(242, 252, 247); doc.setDrawColor(0, 180, 100); doc.setLineWidth(0.3);
    doc.roundedRect(5, y, W - 10, boxH, 2, 2, "FD");
    y += 5;
    doc.setFont("helvetica", "bold"); doc.setFontSize(7); doc.setTextColor(0, 140, 80);
    doc.text("Currency Conversion", 9, y);
    y += 5.5;
    const row = (label: string, value: string, bold = false, accent = false) => {
      doc.setFont("helvetica", bold ? "bold" : "normal");
      doc.setFontSize(8);
      doc.setTextColor(accent ? 0 : 28, accent ? 140 : 28, accent ? 80 : 30);
      doc.text(label, 9, y);
      doc.text(value, W - 9, y, { align: "right" });
      y += 5.5;
    };
    row("Customer Paid:", `${paidAmount} ${paidCoin}`, true);
    row("Merchant Receives:", `${receivedAmount} ${receivedCoin}`, true);
    if (isCrossToken) {
      const rateNum = parseFloat(paidAmount) / parseFloat(receivedAmount);
      row("Rate:", `1 ${receivedCoin} = ${isNaN(rateNum) ? "—" : rateNum.toFixed(4)} ${paidCoin}`);
    }
    row("Conversion Fee:", "$0.00 (0%)", true, true);
    y += 2;

    // ── Network info ──
    doc.setFont("helvetica", "normal"); doc.setFontSize(7); doc.setTextColor(160, 160, 180);
    doc.text(`Network: ${chainName}  ·  SeraPay Fee: $0.00`, W / 2, y, { align: "center" });
    y += 7;

    // ── TX hash ──
    if (txHash) {
      doc.setFont("helvetica", "bold"); doc.setFontSize(6.5); doc.setTextColor(160, 165, 175);
      doc.text("Transaction Hash", 6, y);
      y += 4;
      doc.setFont("courier", "normal"); doc.setFontSize(5.5); doc.setTextColor(60, 65, 80);
      const lines = doc.splitTextToSize(txHash, W - 12);
      doc.text(lines, 6, y);
      y += lines.length * 3.8 + 3;
      doc.setFont("helvetica", "bold"); doc.setFontSize(7); doc.setTextColor(0, 163, 125);
      doc.text("View on Etherscan »", W - 6, y, { align: "right" });
      y += 6;
    }

    // ── Order Items (if present) ──
    const orderItems = req?.orderItems;
    if (orderItems && orderItems.length > 0) {
      doc.setDrawColor(210, 210, 220); doc.setLineDashPattern([1.2, 1.2], 0); doc.setLineWidth(0.25);
      doc.line(6, y, W - 6, y);
      doc.setLineDashPattern([], 0);
      y += 5;

      doc.setFont("helvetica", "bold"); doc.setFontSize(7); doc.setTextColor(0, 140, 80);
      doc.text(req?.menuName ? `ORDER · ${req.menuName.toUpperCase()}` : "ORDER ITEMS", 9, y);
      y += 5;

      orderItems.forEach((oi) => {
        const lineTotal = (parseFloat(oi.p) * oi.q).toFixed(2);
        const label = oi.q > 1 ? `${oi.q}× ${oi.n}` : oi.n;
        doc.setFont("helvetica", "normal"); doc.setFontSize(7.5); doc.setTextColor(28, 28, 30);
        const labelLines = doc.splitTextToSize(label, W - 28);
        doc.text(labelLines, 9, y);
        doc.setFont("helvetica", "bold"); doc.setFontSize(7.5); doc.setTextColor(28, 28, 30);
        doc.text(`${lineTotal} ${receivedCoin}`, W - 9, y, { align: "right" });
        y += labelLines.length * 4.5;
      });

      // Subtotal line
      doc.setDrawColor(220, 220, 225); doc.setLineWidth(0.2);
      doc.line(6, y, W - 6, y);
      y += 4;
      doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor(0, 140, 80);
      doc.text("Total", 9, y);
      doc.text(`${receivedAmount} ${receivedCoin}`, W - 9, y, { align: "right" });
      y += 6;
    }

    // ── Dashed divider ──
    doc.setDrawColor(210, 210, 220); doc.setLineDashPattern([1.2, 1.2], 0); doc.setLineWidth(0.25);
    doc.line(6, y, W - 6, y);
    doc.setLineDashPattern([], 0);
    y += 6;

    // ── Footer ──
    doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(80, 85, 100);
    doc.text("Thank you for your purchase!", W / 2, y, { align: "center" });
    y += 5;
    doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor(0, 140, 80);
    doc.text("Powered by SeraPay · Sera Protocol", W / 2, y, { align: "center" });
    y += 4.5;
    doc.setFont("helvetica", "normal"); doc.setFontSize(7); doc.setTextColor(160, 160, 180);
    doc.text("Zero fees · Instant settlement · Self-custody", W / 2, y, { align: "center" });

    doc.save(`serapay-receipt-${invoiceId}.pdf`);
  }, [req, txHash, payAmount, selectedCoin, merchantName, merchantLogo]);

  const centredWrap: React.CSSProperties = {
    maxWidth: 480, margin: "0 auto", width: "100%",
  };

  // Countdown colour
  const countdownColor = countdown <= 10 ? "#FF3B30" : countdown <= 20 ? "#F59E0B" : "rgba(60,60,67,0.4)";

  // ── Invalid ──────────────────────────────────────────────────────────
  if (phase === "invalid") {
    return (
      <div style={{ minHeight: "100dvh", background: "#F2F2F7", fontFamily: font, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <div style={{ background: "#fff", borderRadius: 20, padding: "32px 24px", textAlign: "center", maxWidth: 360, boxShadow: "0 2px 24px rgba(0,0,0,0.07)" }}>
          <div style={{ width: 56, height: 56, borderRadius: "50%", background: "#FFF0F0", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
            <svg width="24" height="24" fill="none" viewBox="0 0 24 24" stroke="#FF3B30" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /></svg>
          </div>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: "#1C1C1E", margin: "0 0 8px" }}>{t.invalidLink}</h2>
          <p style={{ fontSize: 14, color: "rgba(60,60,67,0.6)", margin: 0 }}>{t.invalidLinkDesc}</p>
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  // ── Loading ──────────────────────────────────────────────────────────
  if (phase === "loading") {
    return (
      <div style={{ minHeight: "100dvh", background: "#F2F2F7", fontFamily: font, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Spinner size={36} />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  // ── Success ──────────────────────────────────────────────────────────
  if (phase === "success") {
    return (
      <div style={{ minHeight: "100dvh", background: "#F2FAF6", fontFamily: font, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <div style={{ background: "#fff", borderRadius: 24, padding: "36px 28px", textAlign: "center", maxWidth: 420, width: "100%", boxShadow: "0 4px 32px rgba(0,0,0,0.08)" }}>
          <div style={{ position: "relative", width: 80, height: 80, margin: "0 auto 20px" }}>
            {merchantLogo ? (
              <img src={merchantLogo} alt={merchantName || "Merchant"} style={{ width: 80, height: 80, borderRadius: "50%", objectFit: "cover", border: "3px solid rgba(0,209,160,0.25)", boxShadow: "0 8px 24px rgba(78,206,154,0.25)" }} />
            ) : (
              <div style={{ width: 80, height: 80, borderRadius: "50%", background: "linear-gradient(135deg, #4ECE9A22, #3AB88222)", border: "3px solid rgba(0,209,160,0.25)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 26, fontWeight: 700, color: "#00B88A" }}>
                {(merchantName || "S").split(" ").map((w: string) => w[0]).join("").slice(0, 2).toUpperCase()}
              </div>
            )}
            <div style={{ position: "absolute", bottom: 0, right: 0, width: 26, height: 26, borderRadius: "50%", background: "linear-gradient(135deg, #4ECE9A, #3AB882)", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 2px 8px rgba(78,206,154,0.5)", border: "2px solid #fff" }}>
              <svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="#fff" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
            </div>
          </div>
          <h2 style={{ fontSize: 22, fontWeight: 800, color: "#0A1F1A", margin: "0 0 6px", letterSpacing: "-0.5px" }}>{t.paymentSuccess}</h2>
          <p style={{ fontSize: 14, color: "rgba(60,60,67,0.6)", margin: "0 0 24px" }}>{merchantName ? `Payment to ${merchantName}` : "Your payment has been submitted on-chain."}</p>
          <div style={{ background: "#F4FBF8", borderRadius: 16, padding: "16px 20px", marginBottom: 16, border: "1px solid rgba(78,206,154,0.2)" }}>
            <p style={{ fontSize: 12, color: "rgba(60,60,67,0.4)", margin: "0 0 4px", fontWeight: 500 }}>AMOUNT SENT</p>
            <p style={{ fontSize: 26, fontWeight: 800, color: "#0A1F1A", margin: 0 }}>
              {payAmount || req?.amount || "—"} <span style={{ color: "#00D1A0" }}>{selectedCoin?.symbol || req?.receiveCoin}</span>
            </p>
          </div>
          {/* Itemised order */}
          {req?.orderItems && req.orderItems.length > 0 && (
            <div style={{ background: "#F9F9FB", borderRadius: 14, padding: "12px 16px", marginBottom: 16, border: "1px solid rgba(0,0,0,0.05)", textAlign: "left" }}>
              <p style={{ fontSize: 11, color: "rgba(60,60,67,0.4)", margin: "0 0 8px", fontWeight: 600, letterSpacing: "0.05em" }}>{req.menuName ? `ORDER · ${req.menuName.toUpperCase()}` : "ORDER ITEMS"}</p>
              {req.orderItems.map((oi, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
                  <span style={{ fontSize: 13, color: "#1C1C1E", flex: 1, paddingRight: 8 }}>{oi.q > 1 ? `${oi.q}× ` : ""}{oi.n}</span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "#1C1C1E", whiteSpace: "nowrap" }}>{(parseFloat(oi.p) * oi.q).toFixed(2)} {oi.c || req.receiveCoin}</span>
                </div>
              ))}
              <div style={{ borderTop: "1px solid rgba(0,0,0,0.06)", marginTop: 8, paddingTop: 8, display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: "#1C1C1E" }}>Total</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: "#00B88A" }}>{req.amount} {req.receiveCoin}</span>
              </div>
            </div>
          )}
          {txHash && (
            <button onClick={async () => { await navigator.clipboard.writeText(txHash); setCopied(true); setTimeout(() => setCopied(false), 2000); }} style={{ width: "100%", background: "#F9F9FB", border: "1px solid rgba(0,0,0,0.06)", borderRadius: 12, padding: "10px 14px", cursor: "pointer", display: "flex", alignItems: "center", gap: 8, marginBottom: 20 }}>
              <span style={{ fontSize: 11, color: "rgba(60,60,67,0.5)", fontFamily: "monospace", flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{txHash}</span>
              <svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke={copied ? "#00D1A0" : "rgba(60,60,67,0.3)"} strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
            </button>
          )}
          <button onClick={handleDownloadReceipt} className="serapay-action-primary serapay-shine-button" style={{ width: "100%", height: 52, borderRadius: 14, background: "linear-gradient(135deg, #4ECE9A, #3AB882)", border: "none", color: "#fff", fontSize: 15, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, boxShadow: "0 6px 20px rgba(78,206,154,0.28)" }}>
            <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
            Download Receipt (PDF)
          </button>
          <button onClick={() => { window.location.assign(buildClientAppUrl("/")); }} style={{ width: "100%", height: 48, borderRadius: 14, background: "#fff", border: "1px solid rgba(0,0,0,0.08)", color: "#0A1F1A", fontSize: 14, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, marginTop: 10 }}>
            Return to SeraPay
          </button>
          {txHash && <a href={`https://sepolia.etherscan.io/tx/${txHash}`} target="_blank" rel="noreferrer" style={{ display: "block", marginTop: 12, fontSize: 12, color: "#00B88A", textDecoration: "none", fontWeight: 500 }}>View on Etherscan →</a>}
          {wallets[0]?.address && (
            <a href={`/wallet/history/${wallets[0].address}`} style={{ display: "block", marginTop: 8, fontSize: 12, color: "rgba(60,60,67,0.4)", textDecoration: "none", fontWeight: 500 }}>View all my payments →</a>
          )}
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  // ── Failed ───────────────────────────────────────────────────────────
  if (phase === "failed") {
    return (
      <div style={{ minHeight: "100dvh", background: "#F2F2F7", fontFamily: font, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <div style={{ background: "#fff", borderRadius: 24, padding: "32px 24px", textAlign: "center", maxWidth: 360, width: "100%", boxShadow: "0 2px 24px rgba(0,0,0,0.07)" }}>
          <div style={{ width: 64, height: 64, borderRadius: "50%", background: "#FFF0F0", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
            <svg width="28" height="28" fill="none" viewBox="0 0 24 24" stroke="#FF3B30" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </div>
          <h2 style={{ fontSize: 20, fontWeight: 700, color: "#1C1C1E", margin: "0 0 8px" }}>{t.paymentFailed}</h2>
          <p style={{ fontSize: 13, color: "rgba(60,60,67,0.6)", margin: "0 0 20px", lineHeight: 1.5 }}>{txError || "Something went wrong."}</p>
          <button onClick={() => { setPhase("select-coin"); setTxError(""); }} style={{ width: "100%", height: 50, borderRadius: 14, background: "#FF3B30", border: "none", color: "#fff", fontSize: 15, fontWeight: 700, cursor: "pointer" }}>{t.tryAgain}</button>
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  const isSameCoin = selectedCoin?.symbol === req?.receiveCoin;
  const hasOrderItems = !!req?.orderItems?.length;
  const showCountdown = !!rateExpiry && !!selectedCoin && (hasOrderItems || (!isSameCoin && !!req?.amount));
  const paymentNetworkName = CHAIN_NAMES[chainId] || "Ethereum";
  const isPaymentTestnet = chainId === 11155111;
  const payOptionStyle: React.CSSProperties = {
    width: "100%",
    minHeight: 58,
    borderRadius: 14,
    border: "1px solid rgba(0,0,0,0.07)",
    background: "#fff",
    color: "#1C1C1E",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "10px 12px",
    textAlign: "left",
  };
  return (
    <div dir={isRTL ? "rtl" : "ltr"} lang={locale} style={{ minHeight: "100dvh", background: "#F2F2F7", fontFamily: font }}>
      {/* Header */}
      <SeraPayHeader
        maxWidth={480}
        compact
        walletAddress={wallets[0]?.address || ""}
      />

      <div style={{ ...centredWrap, padding: "16px 16px 40px" }}>
        {/* Merchant info */}
        {req && (
          <div style={{ textAlign: "center", marginBottom: 16, padding: "4px 0 8px" }}>
            <div style={{ display: "flex", justifyContent: "center", marginBottom: 10 }}>
              {merchantLogo ? (
                <img src={merchantLogo} alt={merchantName || "Merchant"} style={{ width: 64, height: 64, borderRadius: "50%", objectFit: "cover", border: "2px solid rgba(0,209,160,0.2)", boxShadow: "0 2px 12px rgba(0,0,0,0.08)" }} />
              ) : merchantName ? (
                <div style={{ width: 64, height: 64, borderRadius: "50%", background: "linear-gradient(135deg, #4ECE9A22, #3AB88222)", border: "2px solid rgba(0,209,160,0.25)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, fontWeight: 700, color: "#00B88A" }}>
                  {merchantName.split(" ").map((w: string) => w[0]).join("").slice(0, 2).toUpperCase()}
                </div>
              ) : null}
            </div>
            {merchantName && (
              <div style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 7 }}>
                <p style={{ fontSize: 16, fontWeight: 700, color: "#1C1C1E", margin: 0 }}>{merchantName}</p>
                <button
                  onClick={async () => { if (!req?.receiverAddress) return; await navigator.clipboard.writeText(req.receiverAddress); setAddrCopied(true); setTimeout(() => setAddrCopied(false), 2200); }}
                  aria-label="Copy merchant wallet address"
                  style={{ width: 28, height: 28, borderRadius: 10, border: "1px solid rgba(0,0,0,0.06)", background: addrCopied ? "#E6FAF5" : "#fff", color: addrCopied ? "#00A87A" : "#8A9E98", display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
                >
                  {addrCopied
                    ? <svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                    : <svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                  }
                </button>
              </div>
            )}
            {addrCopied && <p style={{ fontSize: 11, color: "#00A87A", margin: "4px 0 0", fontWeight: 650 }}>Copied merchant wallet address</p>}
          </div>
        )}

        {/* Description from payment request — only show if no structured order items */}
        {req?.description && !(req?.orderItems && req.orderItems.length > 0) && (
          <div style={{ background: "rgba(0,209,160,0.06)", borderRadius: 12, padding: "10px 14px", marginBottom: 12, border: "1px solid rgba(0,209,160,0.15)", textAlign: "center" }}>
            <p style={{ fontSize: 13, color: "#1C1C1E", margin: 0, lineHeight: 1.5 }}>{req.description}</p>
          </div>
        )}

        {/* Amount card */}
        {req && (
          <div style={{ background: "#fff", borderRadius: 20, padding: "20px", marginBottom: 12, boxShadow: "0 1px 8px rgba(0,0,0,0.07)", textAlign: "center" }}>
            {(rateLoading || unifiedLoading) ? (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, padding: "8px 0" }}>
                <Spinner size={20} />
                <span style={{ fontSize: 13, color: "rgba(60,60,67,0.4)" }}>{t.calculating}</span>
              </div>
            ) : (
              <>
                <p style={{ fontSize: 11, fontWeight: 600, color: "rgba(60,60,67,0.4)", textTransform: "uppercase", letterSpacing: "0.08em", margin: "0 0 8px" }}>
                  {payAmount || req.amount || unifiedAmount ? "Amount Due" : "Open Amount"}
                </p>
                {isOpenAmount ? (
                  // Open-amount: always show the editable input — never replace it with static display
                  <>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                      <input
                        type="text"
                        inputMode="decimal"
                        placeholder="0.00"
                        value={payAmount ?? ""}
                        autoFocus
                        onChange={e => {
                          const v = e.target.value.replace(/[^0-9.]/g, "");
                          const parts = v.split(".");
                          const clean = parts.length > 2 ? parts[0] + "." + parts.slice(1).join("") : v;
                          setPayAmount(clean || null);
                          const num = parseFloat(clean);
                          if (clean && (isNaN(num) || num < 0.01)) {
                            setAmountError("Minimum amount is 0.01");
                          } else {
                            setAmountError("");
                          }
                        }}
                        onKeyDown={e => {
                          // Prevent Enter from bubbling to any parent handler
                          if (e.key === "Enter") e.preventDefault();
                        }}
                        aria-label="Enter payment amount"
                        style={{ fontSize: 36, fontWeight: 800, color: amountError ? "#FF3B30" : "#0A1F1A", border: "none", borderBottom: `2px solid ${amountError ? "#FF3B30" : "rgba(0,209,160,0.4)"}`, outline: "none", background: "transparent", width: 160, textAlign: "right", fontFamily: font, letterSpacing: "-0.5px" }}
                      />
                      <button onClick={() => phase === "select-coin" && setShowCoinSheet(true)} aria-label="Select payment coin" style={{ background: "none", border: "none", padding: 0, cursor: phase === "select-coin" ? "pointer" : "default", color: "#00D1A0", fontSize: 32, fontWeight: 800, letterSpacing: "-0.5px", display: "inline-flex", alignItems: "center", gap: 4 }}>
                        {selectedCoin?.symbol ?? req.payCoin ?? req.receiveCoin ?? "USDT"}
                        {phase === "select-coin" && <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="#00D1A0" strokeWidth={2.5} style={{ verticalAlign: "middle", marginTop: -2 }}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>}
                      </button>
                    </div>
                    {amountError && <p style={{ fontSize: 11, color: "#FF3B30", margin: "6px 0 0", fontWeight: 500 }}>{amountError}</p>}
                  </>
                ) : unifiedAmount && unifiedCoin ? (
                  // Itemised order: show the recalculated amount in the selected payment coin.
                  <>
                    <p style={{ fontSize: 32, fontWeight: 800, color: "#0A1F1A", margin: "0 0 4px", letterSpacing: "-0.5px" }}>
                      {unifiedAmount}{" "}
                      <button onClick={() => phase === "select-coin" && setShowCoinSheet(true)} style={{ background: "none", border: "none", padding: 0, cursor: phase === "select-coin" ? "pointer" : "default", color: "#00D1A0", fontSize: 32, fontWeight: 800, letterSpacing: "-0.5px", display: "inline-flex", alignItems: "center", gap: 4 }}>
                        {selectedCoin?.symbol ?? unifiedCoin}
                        {phase === "select-coin" && <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="#00D1A0" strokeWidth={2.5} style={{ verticalAlign: "middle", marginTop: -2 }}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>}
                      </button>
                    </p>
                    {unifiedNote && (
                      <p style={{ fontSize: 11, color: "rgba(60,60,67,0.45)", margin: "0 0 2px", lineHeight: 1.4 }}>{unifiedNote}</p>
                    )}
                    {displayRate && (
                      <p style={{ fontSize: 11, color: "rgba(60,60,67,0.35)", margin: 0 }}>{displayRate}</p>
                    )}
                  </>
                ) : payAmount ? (
                  // Fixed-amount with calculated pay amount
                  <>
                    <p style={{ fontSize: 32, fontWeight: 800, color: "#0A1F1A", margin: "0 0 4px", letterSpacing: "-0.5px" }}>
                      {payAmount}{" "}
                      <button onClick={() => phase === "select-coin" && setShowCoinSheet(true)} style={{ background: "none", border: "none", padding: 0, cursor: phase === "select-coin" ? "pointer" : "default", color: "#00D1A0", fontSize: 32, fontWeight: 800, letterSpacing: "-0.5px", display: "inline-flex", alignItems: "center", gap: 4 }}>
                        {selectedCoin?.symbol ?? req.payCoin ?? req.receiveCoin}
                        {phase === "select-coin" && <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="#00D1A0" strokeWidth={2.5} style={{ verticalAlign: "middle", marginTop: -2 }}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>}
                      </button>
                    </p>
                    {!isSameCoin && req.amount && req.receiveCoin && (
                      <p style={{ fontSize: 12, color: "rgba(60,60,67,0.4)", margin: "0 0 4px" }}>
                        Merchant receives {req.amount} {req.receiveCoin}
                      </p>
                    )}
                    {displayRate && (
                      <p style={{ fontSize: 11, color: "rgba(60,60,67,0.35)", margin: 0 }}>{displayRate}</p>
                    )}
                  </>
                ) : req.amount ? (
                  // Fixed-amount, no pay coin selected yet — show receive amount
                  <p style={{ fontSize: 32, fontWeight: 800, color: "#0A1F1A", margin: 0, letterSpacing: "-0.5px" }}>
                    {req.amount}{" "}
                    <button onClick={() => phase === "select-coin" && setShowCoinSheet(true)} style={{ background: "none", border: "none", padding: 0, cursor: phase === "select-coin" ? "pointer" : "default", color: "#00D1A0", fontSize: 32, fontWeight: 800, letterSpacing: "-0.5px", display: "inline-flex", alignItems: "center", gap: 4 }}>
                      {selectedCoin?.symbol ?? req.payCoin ?? req.receiveCoin}
                      {phase === "select-coin" && <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="#00D1A0" strokeWidth={2.5} style={{ verticalAlign: "middle", marginTop: -2 }}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>}
                    </button>
                  </p>
                ) : null}
                {/* Countdown timer */}
                {showCountdown && (
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 4, marginTop: 10 }}>
                    <svg width="11" height="11" fill="none" viewBox="0 0 24 24" stroke={countdownColor} strokeWidth={2}><circle cx="12" cy="12" r="10" /><path strokeLinecap="round" d="M12 6v6l4 2" /></svg>
                    <span style={{ fontSize: 11, color: countdownColor, fontVariantNumeric: "tabular-nums" }}>
                      Rate refreshes in {countdown}s
                    </span>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Collapsible order items — shown below amount card when order has items */}
        {req?.orderItems && req.orderItems.length > 0 && (
          <div style={{ background: "#fff", borderRadius: 16, marginBottom: 12, boxShadow: "0 1px 6px rgba(0,0,0,0.06)", overflow: "hidden" }}>
            <button
              onClick={() => setOrderItemsExpanded(v => !v)}
              style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", background: "none", border: "none", cursor: "pointer" }}
            >
              <span style={{ fontSize: 13, fontWeight: 600, color: "#1C1C1E" }}>
                {req.menuName ? `${req.menuName} · ` : ""}{req.orderItems.length} item{req.orderItems.length !== 1 ? "s" : ""}
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: "#00B88A" }}>
                  {unifiedAmount && unifiedCoin ? `${unifiedAmount} ${unifiedCoin}` : `${req.amount} ${req.receiveCoin}`}
                </span>
                <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="rgba(60,60,67,0.4)" strokeWidth={2.5} style={{ transform: orderItemsExpanded ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
              </div>
            </button>
            {orderItemsExpanded && (() => {
              // Compute per-currency totals for the expanded view
              const itemCoinTotals: Record<string, number> = {};
              for (const oi of req.orderItems!) {
                const c = oi.c || req.receiveCoin;
                itemCoinTotals[c] = (itemCoinTotals[c] || 0) + parseFloat(oi.p) * oi.q;
              }
              const itemCoinEntries = Object.entries(itemCoinTotals);
              return (
                <div style={{ padding: "0 16px 12px", borderTop: "1px solid rgba(0,0,0,0.05)" }}>
                  {req.orderItems!.map((oi, i) => (
                    <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "6px 0", borderBottom: i < req.orderItems!.length - 1 ? "1px solid rgba(0,0,0,0.04)" : "none" }}>
                      <span style={{ fontSize: 13, color: "#1C1C1E", flex: 1, paddingRight: 8 }}>{oi.q > 1 ? `${oi.q}× ` : ""}{oi.n}</span>
                      <span style={{ fontSize: 13, fontWeight: 600, color: "#1C1C1E", whiteSpace: "nowrap" }}>{(parseFloat(oi.p) * oi.q).toFixed(2)} {oi.c || req.receiveCoin}</span>
                    </div>
                  ))}
                  {itemCoinEntries.map(([c, amt]) => (
                    <div key={c} style={{ display: "flex", justifyContent: "space-between", paddingTop: 8, marginTop: 4, borderTop: "1px solid rgba(0,0,0,0.08)" }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: "#1C1C1E" }}>{itemCoinEntries.length > 1 ? `Total ${c}` : "Total"}</span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: "#00B88A" }}>{amt.toFixed(2)} {c}</span>
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>
        )}

        {/* Connect wallet */}
        {phase === "connect" && (
          <div style={{ background: "#fff", borderRadius: 20, padding: "24px", boxShadow: "0 1px 8px rgba(0,0,0,0.07)" }}>
            <h3 style={{ fontSize: 16, fontWeight: 700, color: "#1C1C1E", margin: "0 0 8px" }}>Pay with</h3>
            <div style={{ display: "flex", alignItems: "center", gap: 10, borderRadius: 14, background: isPaymentTestnet ? "#FFF8E6" : "#F4FBF8", border: `1px solid ${isPaymentTestnet ? "#F3D88B" : "rgba(78,206,154,0.22)"}`, padding: "10px 12px", marginBottom: 14 }}>
              <Network size={18} color={isPaymentTestnet ? "#B7791F" : "#00A87A"} />
              <div style={{ flex: 1 }}>
                <p style={{ fontSize: 12, color: "rgba(60,60,67,0.5)", margin: "0 0 2px", fontWeight: 600 }}>Network</p>
                <p style={{ fontSize: 14, color: "#1C1C1E", margin: 0, fontWeight: 750 }}>{paymentNetworkName}</p>
              </div>
              <span style={{ borderRadius: 999, background: "#fff", color: isPaymentTestnet ? "#B7791F" : "#00A87A", padding: "4px 8px", fontSize: 11, fontWeight: 750 }}>{isPaymentTestnet ? "Test" : "Live"}</span>
            </div>
            <div style={{ display: "grid", gap: 10 }}>
              <button onClick={handleConnectWallet} style={{ ...payOptionStyle, borderColor: "rgba(0,168,122,0.28)", background: "#F4FBF8" }}>
                <span style={{ width: 36, height: 36, borderRadius: 12, background: "#E6FAF5", color: "#00A87A", display: "flex", alignItems: "center", justifyContent: "center", flex: "0 0 auto" }}><Wallet size={18} /></span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 14, fontWeight: 750 }}>Continue with wallet address</span>
                  <span style={{ display: "block", fontSize: 12, color: "rgba(60,60,67,0.5)", marginTop: 2 }}>Use an EVM wallet to sign and pay</span>
                </span>
                <ChevronRight size={18} color="rgba(60,60,67,0.35)" />
              </button>
              <button onClick={handleGoogleLogin} style={payOptionStyle}>
                <span style={{ width: 36, height: 36, borderRadius: 12, background: "#F8FAFC", color: "#4285F4", display: "flex", alignItems: "center", justifyContent: "center", flex: "0 0 auto" }}><Chrome size={18} /></span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 14, fontWeight: 750 }}>Login using Google</span>
                  <span style={{ display: "block", fontSize: 12, color: "rgba(60,60,67,0.5)", marginTop: 2 }}>Privy creates a payment wallet when needed</span>
                </span>
                <ChevronRight size={18} color="rgba(60,60,67,0.35)" />
              </button>
              <button onClick={handleOtherLogin} style={payOptionStyle}>
                <span style={{ width: 36, height: 36, borderRadius: 12, background: "#F9F9FB", color: "#667085", display: "flex", alignItems: "center", justifyContent: "center", flex: "0 0 auto" }}><MoreHorizontal size={18} /></span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 14, fontWeight: 750 }}>Choose other wallet</span>
                  <span style={{ display: "block", fontSize: 12, color: "rgba(60,60,67,0.5)", marginTop: 2 }}>MetaMask, OKX, Trust Wallet, email, Telegram</span>
                </span>
                <ChevronRight size={18} color="rgba(60,60,67,0.35)" />
              </button>
            </div>
            <button onClick={handleOtherLogin} style={{ width: "100%", marginTop: 12, height: 44, borderRadius: 14, border: "none", background: "transparent", color: "rgba(60,60,67,0.48)", fontSize: 12, fontWeight: 650, cursor: "pointer" }}>
              More login options
            </button>
            {req?.menuSlug ? (
              <a href={`/menu/${req.menuSlug}?chainId=${chainId}`} style={{ display: "block", marginTop: 12, textAlign: "center", color: "#FF3B30", fontSize: 13, fontWeight: 700, textDecoration: "none" }}>
                Back to menu
              </a>
            ) : null}
          </div>
        )}

        {/* Pay action — single card: shows Confirm & Pay once coin selected, or prompt to tap coin */}
        {phase === "select-coin" && req && (
          <div style={{ background: "#fff", borderRadius: 20, padding: "20px", boxShadow: "0 1px 8px rgba(0,0,0,0.07)" }}>
            {/* Fee / network info */}
            {selectedCoin && (
              <div style={{ background: "#F9F9FB", borderRadius: 14, padding: "12px 16px", marginBottom: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                  <span style={{ fontSize: 12, color: "rgba(60,60,67,0.5)" }}>SeraPay Fee</span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "#00B88A" }}>0%</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 12, color: "rgba(60,60,67,0.5)" }}>Network</span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "#1C1C1E" }}>{CHAIN_NAMES[req.chainId ?? 1] || "Ethereum"}</span>
                </div>
              </div>
            )}
            {!selectedCoin && (
              <button onClick={() => setShowCoinSheet(true)} style={{ width: "100%", display: "flex", alignItems: "center", gap: 12, background: "#F9F9FB", border: "1px solid rgba(0,0,0,0.06)", borderRadius: 14, padding: "14px 16px", cursor: "pointer", marginBottom: 16 }}>
                <span style={{ fontSize: 14, color: "rgba(60,60,67,0.4)", flex: 1, textAlign: "left" }}>Tap the coin above to choose</span>
                <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="rgba(60,60,67,0.3)" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
              </button>
            )}
            {/* Memo / reference field */}
            <div style={{ marginBottom: 12 }}>
              <input
                type="text"
                placeholder="Add a note or reference (optional)"
                value={memo}
                onChange={e => setMemo(e.target.value.slice(0, 100))}
                maxLength={100}
                aria-label="Payment memo or reference"
                style={{ width: "100%", height: 44, padding: "0 14px", fontSize: 13, color: "#1C1C1E", background: "#F9F9FB", border: "1px solid rgba(0,0,0,0.06)", borderRadius: 12, outline: "none", fontFamily: font, boxSizing: "border-box" }}
              />
            </div>
            {/* Warn if selected coin has no contract on this chain */}
            {selectedCoin && !selectedCoinSupported && (
              <p style={{ fontSize: 12, color: "#FF3B30", textAlign: "center", margin: "0 0 8px", fontWeight: 500 }}>
                {selectedCoin.symbol} is not supported on {CHAIN_NAMES[chainId] || "this network"}. Please choose a different coin.
              </p>
            )}
            <button
              onClick={handlePay}
              className="serapay-action-primary serapay-shine-button"
              disabled={!selectedCoin || rateLoading || (!req?.amount && !payAmount) || !!amountError || !selectedCoinSupported}
              style={{
                width: "100%", height: 54, borderRadius: 14, border: "none",
                background: (selectedCoin && !rateLoading && (req?.amount || payAmount) && !amountError && selectedCoinSupported) ? "linear-gradient(135deg, #4ECE9A, #3AB882)" : "rgba(0,0,0,0.08)",
                color: (selectedCoin && !rateLoading && (req?.amount || payAmount) && !amountError && selectedCoinSupported) ? "#fff" : "rgba(60,60,67,0.3)",
                fontSize: 15, fontWeight: 700,
                cursor: (selectedCoin && !rateLoading && (req?.amount || payAmount) && !amountError && selectedCoinSupported) ? "pointer" : "not-allowed",
              }}
            >
              {rateLoading ? t.calculating : t.confirmAndPay}
            </button>
            {req.menuSlug ? (
              <a href={`/menu/${req.menuSlug}`} style={{ display: "block", marginTop: 12, textAlign: "center", color: "#FF3B30", fontSize: 13, fontWeight: 700, textDecoration: "none" }}>
                Back to menu
              </a>
            ) : null}
          </div>
        )}

        {/* Paying */}
        {phase === "paying" && (
          <div style={{ background: "#fff", borderRadius: 20, padding: "40px 24px", boxShadow: "0 1px 8px rgba(0,0,0,0.07)", textAlign: "center" }}>
            <div style={{ display: "flex", justifyContent: "center", marginBottom: 20 }}><Spinner size={48} /></div>
            <h3 style={{ fontSize: 17, fontWeight: 700, color: "#1C1C1E", margin: "0 0 8px" }}>Processing Payment…</h3>
            <p style={{ fontSize: 13, color: "rgba(60,60,67,0.5)", margin: 0 }}>Please confirm in your wallet and wait for on-chain confirmation.</p>
          </div>
        )}
      </div>

      {showCoinSheet && (
        <CoinSheet
          onClose={() => setShowCoinSheet(false)}
          onSelect={setSelectedCoin}
          selectedSymbol={selectedCoin?.symbol}
          receiveCoin={req?.receiveCoin}
          supportedCoins={supportedCoins}
          searchPlaceholder={t.searchCoins}
        />
      )}

      {showRateChanged && selectedCoin && payAmount && pendingNewAmount && (
        <RateChangedModal
          oldAmount={payAmount}
          newAmount={pendingNewAmount}
          coin={selectedCoin.symbol}
          onAccept={async () => {
            setShowRateChanged(false);
            await executePay(pendingNewAmount);
          }}
          onCancel={() => {
            setShowRateChanged(false);
            setPhase("select-coin");
          }}
        />
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
