import { usePrivy } from "@privy-io/react-auth";
import { useState, useRef, useCallback, useEffect } from "react";
import jsQR from "jsqr";
import { useLocation } from "wouter";
import { useChainId } from "wagmi";
import { STABLECOINS, getStablecoinBySymbol, getStablecoinLogoUrl, type Stablecoin } from "@/lib/stablecoins";
import { buildPaymentUrl, buildWalletPaymentUri, LIVE_PAYMENT_CHAIN_ID, resolvePaymentChainId } from "@/lib/payment";
import { buildClientAppUrl, getClientAppPath } from "@/lib/app-url";
import { QRStyled, QR_STYLES, type QrMode, type QrStyle } from "@/components/QRStyled";
import { useMerchantProfile } from "@/hooks/use-merchant";
import { useAuth } from "@/hooks/use-auth";
import { useSeraApiConfig } from "@/hooks/use-gateway";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, ArrowUpDown, ChevronDown, Copy, Download, QrCode, Wallet } from "lucide-react";
import { SeoFooter } from "./SeoPages";
import { SeraLogo, SeraPayHeader } from "@/components/SeraPayHeader";
import { NetworkModeButton, NetworkSwitcherModal } from "@/components/NetworkSwitcher";
import { MAX_IMAGE_UPLOAD_BYTES, loadImage, readFileAsDataUrl, renderCroppedImageForUpload } from "@/lib/imageUpload";
import { formatDecimalAmount, limitDecimalPlaces, normalizeDecimalAmountText } from "@/lib/decimalInput";
import { downloadPaymentQrCard } from "@/lib/qrDownload";

const font = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Inter', sans-serif";
const SERAPAY_LOGO_URL = "/icon-512.png";
const QR_PREVIEW_URL = buildClientAppUrl("/pay/preview");
const EDITABLE_QR_STYLES = QR_STYLES.filter((styleOption) => styleOption.id !== "classy");
const QR_STYLE_IDS = new Set(EDITABLE_QR_STYLES.map((styleOption) => styleOption.id));
type PaymentMode = "test" | "live";

function normalizeQrStyleValue(value: string | null | undefined, fallback: QrStyle = "rounded"): QrStyle {
  if (value === "classy") return "classy-rounded";
  return QR_STYLE_IDS.has(value as QrStyle) ? (value as QrStyle) : fallback;
}

function PaymentModeSwitch({ activeMode }: { activeMode: PaymentMode }) {
  const [showNetworkModal, setShowNetworkModal] = useState(false);

  return (
    <>
      <NetworkModeButton
        activeMode={activeMode}
        onClick={() => setShowNetworkModal(true)}
        style={{ height: 36, boxShadow: "0 1px 0 rgba(255,255,255,0.8) inset", flexShrink: 0 }}
      />
      {showNetworkModal ? <NetworkSwitcherModal onClose={() => setShowNetworkModal(false)} /> : null}
    </>
  );
}

function AccountSetupScreen({
  walletAddress,
  loading,
  error,
  onRetry,
  onDisconnect,
}: {
  walletAddress: string;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onDisconnect: () => void;
}) {
  return (
    <div style={{ minHeight: "100dvh", background: "#F2F2F7", fontFamily: font }}>
      <SeraPayHeader
        maxWidth={520}
        walletAddress={walletAddress}
        disconnectAction={{ label: "Disconnect", onClick: onDisconnect }}
      />
      <main style={{ minHeight: "calc(100dvh - 58px)", display: "flex", alignItems: "center", justifyContent: "center", padding: "24px 16px 40px", boxSizing: "border-box" }}>
        <div style={{ width: "100%", maxWidth: 420, borderRadius: 24, background: "#fff", border: "1px solid rgba(10,31,26,0.08)", boxShadow: "0 18px 55px rgba(10,31,26,0.08)", padding: "28px 22px", textAlign: "center", overflow: "hidden", boxSizing: "border-box" }}>
          <div style={{ display: "flex", justifyContent: "center" }}>
            <SeraLogo size={34} />
          </div>
          {loading && !error ? <div style={{ width: 28, height: 28, margin: "22px auto 0", borderRadius: "50%", border: "2.5px solid rgba(0,200,83,0.2)", borderTopColor: "#00C853", animation: "spin 0.8s linear infinite" }} /> : null}
          <h1 style={{ margin: "18px 0 8px", fontSize: 20, lineHeight: 1.2, fontWeight: 800, color: "#0A1F1A" }}>
            {error ? "Finish Account Setup" : "Preparing Your Payment Page"}
          </h1>
          <p style={{ margin: 0, color: "rgba(60,60,67,0.68)", fontSize: 14, lineHeight: 1.55, overflowWrap: "anywhere", wordBreak: "break-word" }}>
            {error || "SeraPay is opening your merchant workspace and loading your payment settings."}
          </p>
          {walletAddress ? (
            <p style={{ margin: "18px 0 0", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, color: "rgba(60,60,67,0.55)", overflowWrap: "anywhere", wordBreak: "break-word" }}>
              {walletAddress}
            </p>
          ) : null}
          <button
            type="button"
            onClick={onRetry}
            className="serapay-action-primary"
            style={{ marginTop: 22, width: "100%", minHeight: 52, borderRadius: 16, border: "none", background: "linear-gradient(135deg, #00A855, #007A30)", color: "#fff", fontSize: 15, fontWeight: 800, cursor: "pointer" }}
          >
            Retry Account Setup
          </button>
          <button
            type="button"
            onClick={onDisconnect}
            style={{ marginTop: 12, minHeight: 44, padding: "0 18px", borderRadius: 14, border: "1px solid rgba(10,31,26,0.10)", background: "#fff", color: "rgba(60,60,67,0.68)", fontSize: 14, fontWeight: 750, cursor: "pointer" }}
          >
            Disconnect
          </button>
        </div>
      </main>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function isSupportedLogoValue(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return (
    /^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,/i.test(trimmed) ||
    /^https?:\/\//i.test(trimmed) ||
    trimmed.startsWith("/")
  );
}

function normalizeQrColor(value: string | null | undefined, fallback: string) {
  const color = (value || fallback).trim();
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(color) ? color.toUpperCase() : fallback;
}

// ── Token Icon ─────────────────────────────────────────────────────────────
function splitAddressHighlight(address: string) {
  const trimmed = address.trim();
  if (trimmed.length <= 12) return { start: trimmed, middle: "", end: "" };
  return {
    start: trimmed.slice(0, 6),
    middle: trimmed.slice(6, -6),
    end: trimmed.slice(-6),
  };
}

function HighlightedAddress({ address }: { address: string }) {
  const parts = splitAddressHighlight(address);
  return (
    <span>
      <span style={{ color: "rgba(10,31,26,0.92)", fontWeight: 800 }}>{parts.start}</span>
      <span>{parts.middle}</span>
      <span style={{ color: "rgba(10,31,26,0.92)", fontWeight: 800 }}>{parts.end}</span>
    </span>
  );
}

function drawHighlightedAddress(ctx: CanvasRenderingContext2D, address: string, x: number, y: number, maxWidth: number, preferredFontSize = 14) {
  const parts = splitAddressHighlight(address);
  ctx.textBaseline = "middle";
  let fontSize = preferredFontSize;
  const getPartWidth = (part: string, weight: number) => {
    ctx.font = `${weight} ${fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    return ctx.measureText(part).width;
  };
  const getTotalWidth = () => (
    getPartWidth(parts.start, 800) +
    getPartWidth(parts.middle, 600) +
    getPartWidth(parts.end, 800)
  );
  while (getTotalWidth() > maxWidth && fontSize > 8) {
    fontSize -= 0.5;
  }
  const measured = getTotalWidth();
  let cursor = x - measured / 2;
  const drawPart = (part: string, color: string, weight: number) => {
    if (!part) return;
    ctx.font = `${weight} ${fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.fillStyle = color;
    ctx.fillText(part, cursor, y);
    cursor += ctx.measureText(part).width;
  };
  drawPart(parts.start, "rgba(10,31,26,0.92)", 800);
  drawPart(parts.middle, "rgba(60,60,67,0.26)", 600);
  drawPart(parts.end, "rgba(10,31,26,0.92)", 800);
}

type BarcodeDetectorResultLike = { rawValue?: string };
type BarcodeDetectorLike = {
  detect(source: HTMLVideoElement): Promise<BarcodeDetectorResultLike[]>;
};
type BarcodeDetectorConstructorLike = new (options?: { formats?: string[] }) => BarcodeDetectorLike;

declare global {
  interface Window {
    BarcodeDetector?: BarcodeDetectorConstructorLike;
  }
}

function isValidEvmAddress(value: string) {
  return /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}

function extractWalletAddressFromQr(value: string) {
  return value.match(/0x[0-9a-fA-F]{40}/)?.[0] ?? "";
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

const TOKEN_COLORS: Record<string, string> = {
  USDT: "#26A17B", USDC: "#2775CA", XSGD: "#EF3E42", MYRT: "#CC0001",
  IDRX: "#E4002B", IDRT: "#E4002B", EURC: "#003399", AUDD: "#00843D",
  JPYC: "#BC002D", THBT: "#A51931", CADC: "#FF0000", BRZ: "#009C3B",
  VGBP: "#012169", MXNT: "#006847", ZARP: "#007A4D", CNGN: "#008751",
};
function TokenIcon({ symbol, size = 28 }: { symbol: string; size?: number }) {
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
    <div style={{
      width: size, height: size, borderRadius: "50%",
      background: color, display: "flex", alignItems: "center", justifyContent: "center",
      flexShrink: 0,
    }}>
      <span style={{ fontSize: size * 0.38, fontWeight: 700, color: "#fff", letterSpacing: "-0.5px" }}>
        {symbol.slice(0, 2)}
      </span>
    </div>
  );
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[char] ?? char));
}

// ── Status Badge ───────────────────────────────────────────────────────────
function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, { bg: string; text: string; label: string }> = {
    confirmed: { bg: "#E8F8F0", text: "#00A855", label: "Successful" },
    confirming: { bg: "#FFF8E6", text: "#D4820A", label: "Processing" },
    pending:    { bg: "#F2F2F7", text: "#8E8E93", label: "Pending" },
    canceled:   { bg: "#F2F2F7", text: "#8E8E93", label: "Canceled" },
    failed:     { bg: "#FFF0F0", text: "#FF3B30", label: "Failed" },
  };
  const s = colors[status] ?? colors.pending;
  return (
    <span style={{
      fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 20,
      background: s.bg, color: s.text,
    }}>{s.label}</span>
  );
}

// ── Coin Sheet Modal ───────────────────────────────────────────────────────
function CoinSheet({
  title, onClose, onSelect, selectedSymbol,
}: {
  title: string;
  onClose: () => void;
  onSelect: (c: Stablecoin) => void;
  selectedSymbol?: string;
}) {
  const [query, setQuery] = useState("");
  const filtered = query
    ? STABLECOINS.filter(c =>
        c.symbol.toLowerCase().includes(query.toLowerCase()) ||
        c.name.toLowerCase().includes(query.toLowerCase()) ||
        c.currency.toLowerCase().includes(query.toLowerCase())
      )
    : STABLECOINS;

  return (
    <>
      <style>{`@keyframes coinModalIn { from { opacity:0; transform:translate(-50%,calc(-50% + 10px)) scale(0.95); } to { opacity:1; transform:translate(-50%,-50%) scale(1); } }`}</style>
      <div
        style={{ position: "fixed", inset: 0, zIndex: 40, background: "rgba(0,0,0,0.28)", backdropFilter: "blur(6px)" }}
        onClick={onClose}
      />
      <div style={{
        position: "fixed", zIndex: 50, background: "#fff",
        top: "50%", left: "50%",
        transform: "translate(-50%,-50%)",
        width: "min(440px, calc(100vw - 32px))",
        maxHeight: "min(560px, 80dvh)",
        borderRadius: 20,
        display: "flex", flexDirection: "column",
        animation: "coinModalIn 0.22s cubic-bezier(0.34,1.2,0.64,1) both",
        boxShadow: "0 8px 48px rgba(0,0,0,0.18), 0 2px 12px rgba(0,0,0,0.08)",
      }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "18px 20px 12px" }}>
          <h3 style={{ fontSize: 17, fontWeight: 700, color: "#1C1C1E", letterSpacing: "-0.3px", margin: 0 }}>{title}</h3>
          <button onClick={onClose} style={{
            width: 28, height: 28, borderRadius: "50%", background: "#F2F2F7",
            border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
            color: "rgba(60,60,67,0.5)",
          }}>
            <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        {/* Search */}
        <div style={{ padding: "0 16px 12px" }}>
          <div style={{ position: "relative" }}>
            <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
              style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "rgba(60,60,67,0.3)", pointerEvents: "none" }}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text" placeholder="Search stablecoins…" value={query}
              onChange={e => setQuery(e.target.value)}
              style={{
                width: "100%", height: 38, paddingLeft: 34, paddingRight: 14,
                fontSize: 14, background: "#F2F2F7", border: "none",
                borderRadius: 12, outline: "none", boxSizing: "border-box",
                color: "#1C1C1E", fontFamily: font,
              }}
            />
          </div>
        </div>
        {/* List */}
        <div style={{ flex: 1, overflowY: "auto", paddingBottom: 16 }}>
          <div style={{ margin: "0 12px" }}>
            <div style={{ background: "#F9F9FB", borderRadius: 14, overflow: "hidden" }}>
              {filtered.map((c, i) => (
                <button key={c.symbol} onClick={() => { onSelect(c); onClose(); }} style={{
                  width: "100%", display: "flex", alignItems: "center", gap: 12,
                  padding: "12px 14px", background: "none", border: "none", cursor: "pointer",
                  borderTop: i > 0 ? "1px solid rgba(60,60,67,0.06)" : "none",
                  transition: "background 0.12s",
                }}>
                  <TokenIcon symbol={c.symbol} size={34} />
                  <div style={{ flex: 1, textAlign: "left" }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "#1C1C1E" }}>{c.symbol}</div>
                    <div style={{ fontSize: 12, color: "rgba(60,60,67,0.5)" }}>{c.name}</div>
                  </div>
                  {selectedSymbol === c.symbol && (
                    <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="#00D1A0" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Logo Avatar ───────────────────────────────────────────────────────────
function LogoAvatar({
  logoData,
  merchantName,
  apiKey,
  onLogoSaved,
}: {
  logoData: string;
  merchantName: string;
  apiKey: string;
  onLogoSaved: (newLogo: string) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [avatarError, setAvatarError] = useState("");
  const [avatarSuccess, setAvatarSuccess] = useState(false);
  const [logoCropSource, setLogoCropSource] = useState<LogoCropSource | null>(null);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setAvatarError("");
    setAvatarSuccess(false);
    if (!apiKey) {
      setAvatarError("Account syncing");
      e.target.value = "";
      return;
    }
    try {
      if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error("Use a PNG, JPG, or WebP image.");
      if (file.size > MAX_IMAGE_UPLOAD_BYTES) throw new Error("Image must be 10 MB or smaller.");
      const dataUrl = await readFileAsDataUrl(file);
      const image = await loadImage(dataUrl);
      setLogoCropSource({
        dataUrl,
        width: image.naturalWidth || image.width,
        height: image.naturalHeight || image.height,
        fileName: file.name,
      });
    } catch (err) {
      setAvatarError(err instanceof Error ? err.message : "Upload failed");
    }
    // Reset input so same file can be re-selected
    e.target.value = "";
  };

  const uploadLogoData = async (dataUrl: string) => {
    if (!apiKey) {
      setAvatarError("Account syncing");
      return;
    }
    setUploading(true);
    setAvatarError("");
    setAvatarSuccess(false);
    try {
      // Use a non-empty name: fall back to wallet-derived placeholder if merchantName is empty
      const safeName = merchantName.trim() || "My Store";
      const res = await fetch("/api/merchant/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
        body: JSON.stringify({ name: safeName, logoData: dataUrl }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setAvatarError((d as any).error || "Upload failed");
        return;
      }
      const saved = await res.json().catch(() => null);
      const savedLogo = typeof saved?.logoData === "string" ? saved.logoData : dataUrl;
      setAvatarSuccess(true);
      setTimeout(() => setAvatarSuccess(false), 2000);
      onLogoSaved(savedLogo);
      setLogoCropSource(null);
    } catch (err) {
      setAvatarError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const initials = merchantName
    ? merchantName.split(" ").map(w => w[0]).slice(0, 2).join("").toUpperCase()
    : "?";

  return (
    <div style={{ position: "relative", flexShrink: 0 }}>
      <button
        className="logo-avatar-btn"
        onClick={() => fileInputRef.current?.click()}
        title="Tap to upload logo"
        style={{
          width: 48, height: 48, borderRadius: "50%",
          border: "2px solid rgba(78,206,154,0.5)",
          background: logoData ? "transparent" : "#E8F8F0",
          display: "flex", alignItems: "center", justifyContent: "center",
          cursor: "pointer", overflow: "visible", flexShrink: 0, padding: 0,
          position: "relative",
          animation: "avatarRing 2.5s ease-in-out infinite",
        }}
      >
        {uploading ? (
          <div style={{ width: 16, height: 16, borderRadius: "50%", border: "2px solid rgba(0,200,83,0.2)", borderTopColor: "#00C853", animation: "spin 0.7s linear infinite" }} />
        ) : logoData ? (
          <img src={logoData} alt="Logo" style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "50%" }} />
        ) : (
          <span style={{ fontSize: 13, fontWeight: 700, color: "#3EBE8A" }}>{initials}</span>
        )}
        {/* Camera overlay hint */}
        {!uploading && (
          <div style={{
            position: "absolute", bottom: -2, right: -2,
            width: 17, height: 17, borderRadius: "50%",
            background: "#00C853", border: "2px solid #F2F2F7",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <svg width="9" height="9" fill="none" viewBox="0 0 24 24" stroke="#fff" strokeWidth={2.7}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
          </div>
        )}
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        style={{ display: "none" }}
        onChange={handleFileChange}
      />
      {/* Inline error/success tooltip */}
      {(avatarError || avatarSuccess) && (
        <span style={{
          position: "absolute", top: 52, left: 0,
          fontSize: 10, fontWeight: 600, whiteSpace: "nowrap",
          color: avatarError ? "#FF3B30" : "#00A855",
          background: avatarError ? "#FFF0F0" : "#E8F8F0",
          padding: "2px 6px", borderRadius: 6,
          pointerEvents: "none",
        }}>
          {avatarError || "✓ Saved"}
        </span>
      )}
      {logoCropSource ? (
        <LogoCropModal
          source={logoCropSource}
          uploading={uploading}
          onCancel={() => {
            if (!uploading) setLogoCropSource(null);
          }}
          onConfirm={(dataUrl) => {
            void uploadLogoData(dataUrl);
          }}
        />
      ) : null}
    </div>
  );
}

type LogoCropSource = {
  dataUrl: string;
  width: number;
  height: number;
  fileName: string;
};

function LogoCropModal({
  source,
  uploading,
  onCancel,
  onConfirm,
}: {
  source: LogoCropSource;
  uploading: boolean;
  onCancel: () => void;
  onConfirm: (dataUrl: string) => void;
}) {
  const frameSize = 300;
  const baseScale = Math.max(frameSize / source.width, frameSize / source.height);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ pointerId: number; x: number; y: number; startX: number; startY: number } | null>(null);
  const displayW = source.width * baseScale * zoom;
  const displayH = source.height * baseScale * zoom;
  const maxOffsetX = Math.max(0, (displayW - frameSize) / 2);
  const maxOffsetY = Math.max(0, (displayH - frameSize) / 2);
  const safeOffset = { x: clampNumber(offset.x, -maxOffsetX, maxOffsetX), y: clampNumber(offset.y, -maxOffsetY, maxOffsetY) };

  useEffect(() => {
    setOffset((current) => ({
      x: clampNumber(current.x, -maxOffsetX, maxOffsetX),
      y: clampNumber(current.y, -maxOffsetY, maxOffsetY),
    }));
  }, [maxOffsetX, maxOffsetY]);

  const handleConfirm = async () => {
    const scale = baseScale * zoom;
    const drawnX = (frameSize - displayW) / 2 + safeOffset.x;
    const drawnY = (frameSize - displayH) / 2 + safeOffset.y;
    const prepared = await renderCroppedImageForUpload({
      source: source.dataUrl,
      crop: {
        x: clampNumber(-drawnX / scale, 0, source.width),
        y: clampNumber(-drawnY / scale, 0, source.height),
        width: Math.min(frameSize / scale, source.width),
        height: Math.min(frameSize / scale, source.height),
      },
      outputWidth: 1024,
      outputHeight: 1024,
      quality: 0.9,
    });
    onConfirm(prepared.dataUrl);
  };

  return (
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 80, background: "rgba(0,0,0,0.45)", backdropFilter: "blur(6px)" }} />
      <div style={{ position: "fixed", inset: 0, zIndex: 81, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
        <div style={{ width: "min(420px, calc(100vw - 32px))", borderRadius: 22, background: "#fff", boxShadow: "0 24px 70px rgba(10,31,26,0.22)", padding: 20, boxSizing: "border-box" }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 16 }}>
            <div>
              <h3 style={{ margin: 0, color: "#0A1F1A", fontSize: 18, fontWeight: 800 }}>Crop logo</h3>
              <p style={{ margin: "6px 0 0", color: "rgba(60,60,67,0.58)", fontSize: 13, lineHeight: 1.45 }}>Drag to reposition, then adjust the scale.</p>
            </div>
            <button
              type="button"
              onClick={onCancel}
              disabled={uploading}
              aria-label="Cancel crop"
              style={{ width: 36, height: 36, borderRadius: "50%", border: "none", background: "#F2F2F7", color: "rgba(60,60,67,0.55)", cursor: uploading ? "default" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
            >
              <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>
          <div
            style={{ position: "relative", width: "min(300px, 100%)", aspectRatio: "1 / 1", margin: "0 auto", overflow: "hidden", borderRadius: 22, border: "2px solid #00C896", background: "#E6FAF5", touchAction: "none", boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.72)" }}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, startX: safeOffset.x, startY: safeOffset.y };
            }}
            onPointerMove={(event) => {
              const drag = dragRef.current;
              if (!drag || drag.pointerId !== event.pointerId) return;
              setOffset({
                x: clampNumber(drag.startX + event.clientX - drag.x, -maxOffsetX, maxOffsetX),
                y: clampNumber(drag.startY + event.clientY - drag.y, -maxOffsetY, maxOffsetY),
              });
            }}
            onPointerUp={() => { dragRef.current = null; }}
            onPointerCancel={() => { dragRef.current = null; }}
          >
            <img
              src={source.dataUrl}
              alt=""
              draggable={false}
              style={{ position: "absolute", left: "50%", top: "50%", width: displayW, height: displayH, maxWidth: "none", userSelect: "none", transform: `translate(calc(-50% + ${safeOffset.x}px), calc(-50% + ${safeOffset.y}px))` }}
            />
          </div>
          <div style={{ marginTop: 18 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8, color: "rgba(60,60,67,0.55)", fontSize: 12, fontWeight: 700 }}>
              <span>Scale</span>
              <span>{Math.round(zoom * 100)}%</span>
            </div>
            <input type="range" min="1" max="3" step="0.01" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} style={{ width: "100%", accentColor: "#00C853" }} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1.35fr", gap: 10, marginTop: 18 }}>
            <button
              type="button"
              onClick={onCancel}
              disabled={uploading}
              style={{ height: 50, borderRadius: 14, border: "1px solid rgba(10,31,26,0.10)", background: "#fff", color: "#1C1C1E", fontSize: 14, fontWeight: 750, cursor: uploading ? "default" : "pointer" }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleConfirm()}
              disabled={uploading}
              className="serapay-action-primary"
              style={{ height: 50, borderRadius: 14, border: "none", background: "linear-gradient(135deg, #00C896, #00A87A, #008A64)", color: "#fff", fontSize: 14, fontWeight: 800, cursor: uploading ? "default" : "pointer" }}
            >
              {uploading ? "Saving..." : "Confirm"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function QRStylePicker({
  value,
  onChange,
  disabled = false,
}: {
  value: QrStyle;
  onChange: (style: QrStyle) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const selected = EDITABLE_QR_STYLES.find((styleOption) => styleOption.id === value) ?? EDITABLE_QR_STYLES[1];

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [open]);

  return (
    <div ref={pickerRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => { if (!disabled) setOpen((current) => !current); }}
        disabled={disabled}
        style={{
          width: "100%",
          minHeight: 54,
          borderRadius: 16,
          border: disabled ? "1.5px solid rgba(60,60,67,0.08)" : open ? "1.5px solid rgba(62,190,138,0.55)" : "1.5px solid rgba(60,60,67,0.1)",
          background: disabled ? "#F2F2F4" : "linear-gradient(180deg, #FFFFFF 0%, #F8FBFA 100%)",
          boxShadow: open ? "0 0 0 4px rgba(78,206,154,0.12)" : "0 1px 4px rgba(10,31,26,0.04)",
          padding: "9px 12px",
          cursor: disabled ? "default" : "pointer",
          opacity: disabled ? 0.66 : 1,
          display: "flex",
          alignItems: "center",
          gap: 10,
          textAlign: "left",
          fontFamily: font,
          transition: "border 0.15s, box-shadow 0.15s, background 0.15s",
        }}
      >
        <span style={{
          width: 34,
          height: 34,
          borderRadius: 12,
          background: "#ECFFF7",
          border: "1px solid rgba(78,206,154,0.22)",
          display: "grid",
          gridTemplateColumns: "repeat(2, 5px)",
          gridTemplateRows: "repeat(2, 5px)",
          justifyContent: "center",
          alignContent: "center",
          gap: 4,
          flexShrink: 0,
        }}>
          {[0, 1, 2, 3].map((dot) => (
            <span key={dot} style={{ width: 5, height: 5, borderRadius: value === "classic" ? 1 : 999, background: "#31B985" }} />
          ))}
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: "block", fontSize: 13, fontWeight: 750, color: "#1C1C1E", lineHeight: 1.25 }}>{selected.label}</span>
          <span style={{ display: "block", fontSize: 11, fontWeight: 500, color: "rgba(60,60,67,0.48)", lineHeight: 1.3, marginTop: 1 }}>{selected.desc}</span>
        </span>
        <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="rgba(60,60,67,0.45)" strokeWidth={2.5} style={{ flexShrink: 0, transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && !disabled && (
        <div style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: "calc(100% + 8px)",
          zIndex: 80,
          borderRadius: 18,
          border: "1px solid rgba(60,60,67,0.1)",
          background: "rgba(255,255,255,0.98)",
          boxShadow: "0 18px 44px rgba(10,31,26,0.16), 0 2px 10px rgba(10,31,26,0.06)",
          padding: 6,
          backdropFilter: "blur(14px)",
        }}>
          {EDITABLE_QR_STYLES.map((styleOption) => {
            const active = styleOption.id === value;
            return (
              <button
                key={styleOption.id}
                type="button"
                onClick={() => { onChange(styleOption.id); setOpen(false); }}
                style={{
                  width: "100%",
                  border: "none",
                  borderRadius: 12,
                  background: active ? "#ECFFF7" : "transparent",
                  color: active ? "#087A5B" : "#1C1C1E",
                  padding: "10px 11px",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  cursor: "pointer",
                  textAlign: "left",
                  fontFamily: font,
                }}
              >
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 13, fontWeight: 700 }}>{styleOption.label}</span>
                  <span style={{ display: "block", marginTop: 1, fontSize: 11, color: active ? "rgba(8,122,91,0.7)" : "rgba(60,60,67,0.48)" }}>{styleOption.desc}</span>
                </span>
                {active && (
                  <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="#20B982" strokeWidth={2.6} style={{ flexShrink: 0 }}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Settings Modal ─────────────────────────────────────────────────────────
function QRDesignFrame({
  mode,
  style,
  dotColor,
  bgColor,
  logo,
  onModeChange,
  onStyleChange,
  onDotColorChange,
  onBgColorChange,
}: {
  mode: QrMode;
  style: QrStyle;
  dotColor: string;
  bgColor: string;
  logo?: string;
  onModeChange: (mode: QrMode) => void;
  onStyleChange: (style: QrStyle) => void;
  onDotColorChange: (color: string) => void;
  onBgColorChange: (color: string) => void;
}) {
  const previewLogo = logo || SERAPAY_LOGO_URL;
  const updateHexColor = (value: string, onChange: (color: string) => void) => {
    const normalized = value.startsWith("#") ? value : `#${value}`;
    onChange(normalized.slice(0, 9).toUpperCase());
  };

  return (
    <section style={{
      border: "1.5px solid rgba(60,60,67,0.10)",
      borderRadius: 20,
      padding: 12,
      background: "linear-gradient(180deg, #FFFFFF 0%, #FBFEFC 100%)",
      boxShadow: "0 1px 4px rgba(10,31,26,0.04)",
    }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, padding: 4, borderRadius: 14, background: "#F3F5F6", marginBottom: 12 }}>
        {([
          { id: "advanced" as QrMode, label: "Advanced QR" },
          { id: "standard" as QrMode, label: "Standard QR" },
        ]).map((option) => {
          const active = mode === option.id;
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => onModeChange(option.id)}
              style={{
                minHeight: 38,
                borderRadius: 11,
                border: "none",
                background: active ? "#fff" : "transparent",
                color: active ? "#0A1F1A" : "rgba(60,60,67,0.58)",
                fontSize: 13,
                fontWeight: 850,
                cursor: "pointer",
                boxShadow: active ? "0 6px 18px rgba(10,31,26,0.08), 0 1px 0 rgba(255,255,255,0.8) inset" : "none",
                transition: "background 0.16s, color 0.16s, box-shadow 0.16s",
                fontFamily: font,
              }}
            >
              {option.label}
            </button>
          );
        })}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(86px, 1fr))", gap: 8, overflowX: "hidden", paddingBottom: 2 }}>
        {EDITABLE_QR_STYLES.map((styleOption) => {
          const active = style === styleOption.id;
          return (
            <button
              key={styleOption.id}
              type="button"
              onClick={() => onStyleChange(styleOption.id)}
              style={{
                minWidth: 86,
                borderRadius: 14,
                border: active ? "1.5px solid #3EBE8A" : "1px solid rgba(60,60,67,0.10)",
                background: active ? "#F0FAF6" : "#fff",
                padding: "9px 7px 8px",
                cursor: "pointer",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 6,
                boxShadow: active ? "0 5px 14px rgba(62,190,138,0.14)" : "0 1px 3px rgba(10,31,26,0.04)",
                transition: "border 0.16s, background 0.16s, box-shadow 0.16s",
                fontFamily: font,
              }}
            >
              <QRStyled value={QR_PREVIEW_URL} size={52} fgColor={dotColor} bgColor={bgColor} style={styleOption.id} logo={previewLogo} mode={mode} />
              <span style={{ fontSize: 10, fontWeight: 750, color: active ? "#087A5B" : "rgba(60,60,67,0.58)", whiteSpace: "nowrap" }}>
                {styleOption.label}
              </span>
            </button>
          );
        })}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(132px, 180px)", gap: 14, alignItems: "stretch", marginTop: 14 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {([
            { label: "QR Color", value: dotColor, onChange: onDotColorChange, fallback: "#000000", disabled: mode === "advanced" },
            { label: "Background", value: bgColor, onChange: onBgColorChange, fallback: "#ffffff", disabled: false },
          ] as const).map((field) => (
            <label key={field.label} style={{ display: "block", opacity: field.disabled ? 0.48 : 1 }}>
              <span style={{ display: "block", marginBottom: 5, fontSize: 11, fontWeight: 800, color: field.disabled ? "rgba(60,60,67,0.32)" : "rgba(60,60,67,0.48)" }}>{field.label}</span>
              <span style={{
                minHeight: 48,
                borderRadius: 14,
                border: field.disabled ? "1px solid rgba(60,60,67,0.06)" : "1px solid rgba(60,60,67,0.10)",
                background: field.disabled ? "#F4F5F6" : "#fff",
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "7px 10px",
                boxShadow: field.disabled ? "none" : "0 2px 8px rgba(10,31,26,0.04)",
                cursor: field.disabled ? "not-allowed" : "default",
              }}>
                <input
                  type="color"
                  value={normalizeQrColor(field.value, field.fallback)}
                  onChange={(event) => field.onChange(event.target.value.toUpperCase())}
                  disabled={field.disabled}
                  style={{ width: 34, height: 34, border: "none", padding: 0, background: "transparent", flexShrink: 0, cursor: field.disabled ? "not-allowed" : "pointer" }}
                  aria-label={field.label}
                />
                <input
                  type="text"
                  value={field.value}
                  onChange={(event) => updateHexColor(event.target.value, field.onChange)}
                  disabled={field.disabled}
                  style={{ width: "100%", minWidth: 0, border: "none", outline: "none", background: "transparent", fontSize: 12, fontWeight: 800, color: field.disabled ? "rgba(60,60,67,0.45)" : "#1C1C1E", fontFamily: font }}
                />
              </span>
            </label>
          ))}
        </div>
        <div style={{
          minHeight: 180,
          borderRadius: 18,
          border: "1px solid rgba(60,60,67,0.08)",
          background: "#fff",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          padding: 10,
          boxShadow: "0 8px 24px rgba(10,31,26,0.06)",
        }}>
          <span style={{ fontSize: 10, fontWeight: 850, color: "rgba(60,60,67,0.42)", letterSpacing: "0.08em", textTransform: "uppercase" }}>Preview</span>
          <QRStyled value={QR_PREVIEW_URL} size={136} fgColor={dotColor} bgColor={bgColor} style={style} logo={previewLogo} mode={mode} />
        </div>
      </div>
    </section>
  );
}

function SettingsModal({
  onClose,
  walletAddress,
  apiKey,
  initialName,
  onNameSaved,
  initialLogo,
  onLogoSaved,
  qrFgColor,
  qrBgColor,
  qrStyle,
  qrMode,
  onQrPrefsSaved,
  accountError,
  accountLoading,
  onRetryAccount,
}: {
  onClose: () => void;
  walletAddress: string;
  apiKey: string;
  initialName: string;
  onNameSaved: (name: string) => void;
  initialLogo?: string;
  onLogoSaved?: (logo: string) => void;
  qrFgColor?: string;
  qrBgColor?: string;
  qrStyle?: string;
  qrMode?: string;
  onQrPrefsSaved?: (fgColor: string, bgColor: string, style: QrStyle, mode: QrMode) => void;
  accountError?: string | null;
  accountLoading?: boolean;
  onRetryAccount?: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [logoPreview, setLogoPreview] = useState(isSupportedLogoValue(initialLogo) ? initialLogo : "");
  const [dotColor, setDotColor] = useState(qrFgColor || "#000000");
  const [bgColor, setBgColor] = useState(qrBgColor || "#ffffff");
  const [selectedStyle, setSelectedStyle] = useState<QrStyle>(normalizeQrStyleValue(qrStyle));
  const [selectedQrMode, setSelectedQrMode] = useState<QrMode>((qrMode as QrMode) || "standard");
  const [saving, setSaving] = useState(false);
  const [logoSaving, setLogoSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [logoCropSource, setLogoCropSource] = useState<LogoCropSource | null>(null);
  const logoInputRef = useRef<HTMLInputElement>(null);
  const accountReady = Boolean(apiKey);
  const hasNameOrQrChanges = name.trim() !== initialName.trim()
    || normalizeQrColor(dotColor, "#000000") !== normalizeQrColor(qrFgColor, "#000000")
    || normalizeQrColor(bgColor, "#ffffff") !== normalizeQrColor(qrBgColor, "#ffffff")
    || selectedStyle !== normalizeQrStyleValue(qrStyle)
    || selectedQrMode !== ((qrMode as QrMode) || "standard");
  const isRetryAccountAction = !accountReady && Boolean(accountError && onRetryAccount);
  const saveDisabled = isRetryAccountAction
    ? saving || logoSaving
    : saving || logoSaving || saved || !accountReady || !hasNameOrQrChanges;
  const saveLooksActive = accountReady && hasNameOrQrChanges && !saved;

  useEffect(() => {
    setName(initialName);
  }, [initialName]);

  useEffect(() => {
    setLogoPreview(isSupportedLogoValue(initialLogo) ? initialLogo : "");
  }, [initialLogo]);

  useEffect(() => {
    setDotColor(qrFgColor || "#000000");
  }, [qrFgColor]);

  useEffect(() => {
    setBgColor(qrBgColor || "#ffffff");
  }, [qrBgColor]);

  useEffect(() => {
    setSelectedStyle(normalizeQrStyleValue(qrStyle));
  }, [qrStyle]);

  useEffect(() => {
    setSelectedQrMode((qrMode as QrMode) || "standard");
  }, [qrMode]);

  const handleLogoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error("Use a PNG, JPG, or WebP image.");
      if (file.size > MAX_IMAGE_UPLOAD_BYTES) throw new Error("Image must be 10 MB or smaller.");
      const dataUrl = await readFileAsDataUrl(file);
      const image = await loadImage(dataUrl);
      setLogoCropSource({
        dataUrl,
        width: image.naturalWidth || image.width,
        height: image.naturalHeight || image.height,
        fileName: file.name,
      });
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid image file");
    } finally {
      e.target.value = "";
    }
  };

  const saveLogoData = async (logoData: string | null) => {
    if (!accountReady) { setError("Merchant account is still syncing. Please try again shortly."); return; }
    setLogoSaving(true);
    setError("");
    try {
      const res = await fetch("/api/merchant/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
        body: JSON.stringify({ logoData }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error || "Logo update failed");
        return;
      }
      const savedProfile = await res.json().catch(() => null);
      const savedLogo = logoData && isSupportedLogoValue(savedProfile?.logoData) ? savedProfile.logoData : (logoData || "");
      setLogoPreview(savedLogo);
      if (onLogoSaved) onLogoSaved(savedLogo);
    } catch {
      setError("Network error - please try again");
    } finally {
      setLogoSaving(false);
    }
  };

  const handleSave = async () => {
    if (!accountReady) { setError("Merchant account is still syncing. Please try again shortly."); return; }
    if (!hasNameOrQrChanges) return;
    if (!name.trim()) { setError("Business name cannot be empty"); return; }
    if (name.trim().length > 80) { setError("Business name must be 80 characters or fewer"); return; }
    setSaving(true);
    setError("");
    try {
      // Use /api/merchant/profile which supports all fields including qrStyle
      const body: Record<string, string | null> = {
        name: name.trim(),
        qrFgColor: dotColor,
        qrBgColor: bgColor,
        qrStyle: selectedStyle,
        qrMode: selectedQrMode,
      };
      const res = await fetch("/api/merchant/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
        body: JSON.stringify(body),
      });
      if (!res.ok) { const d = await res.json(); setError(d.error || "Failed to save"); return; }
      await res.json().catch(() => null);
      onNameSaved(name.trim());
      // Persist QR prefs locally (wallet-scoped) so they survive page reload without a profile fetch
      try {
        localStorage.setItem(`serapay_qr_fgColor_${walletAddress}`, dotColor);
        localStorage.setItem(`serapay_qr_bgColor_${walletAddress}`, bgColor);
        localStorage.setItem(`serapay_qr_style_${walletAddress}`, selectedStyle);
        localStorage.setItem(`serapay_qr_mode_${walletAddress}`, selectedQrMode);
      } catch {}
      if (onQrPrefsSaved) onQrPrefsSaved(dotColor, bgColor, selectedStyle, selectedQrMode);
      setSaved(true);
      setTimeout(() => { setSaved(false); onClose(); }, 1200);
    } catch {
      setError("Network error — please try again");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <style>{`@keyframes settingsIn { from { opacity:0; transform:translate(-50%,calc(-50% + 10px)) scale(0.95); } to { opacity:1; transform:translate(-50%,-50%) scale(1); } }`}</style>
      <div
        style={{ position: "fixed", inset: 0, zIndex: 40, background: "rgba(0,0,0,0.28)", backdropFilter: "blur(6px)" }}
        onClick={onClose}
      />
      <div style={{
        position: "fixed", zIndex: 50, background: "#fff",
        top: "50%", left: "50%",
        transform: "translate(-50%,-50%)",
        width: "min(760px, calc(100vw - 36px))",
        maxHeight: "calc(100dvh - 32px)",
        borderRadius: 20,
        display: "flex", flexDirection: "column",
        animation: "settingsIn 0.22s cubic-bezier(0.34,1.2,0.64,1) both",
        boxShadow: "0 8px 48px rgba(0,0,0,0.18), 0 2px 12px rgba(0,0,0,0.08)",
        overflow: "hidden",
        overscrollBehavior: "contain",
        boxSizing: "border-box",
      }}>
        <div className="serapay-hidden-scrollbar" style={{
          display: "flex",
          flexDirection: "column",
          gap: 16,
          padding: "24px 20px max(20px, env(safe-area-inset-bottom))",
          overflowY: "auto",
          scrollbarGutter: "stable",
          boxSizing: "border-box",
        }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h3 style={{ fontSize: 17, fontWeight: 700, color: "#1C1C1E", margin: 0 }}>Merchant Settings</h3>
          <button onClick={onClose} style={{
            width: 28, height: 28, borderRadius: "50%", background: "#F2F2F7",
            border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
            color: "rgba(60,60,67,0.5)",
          }}>
            <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Store identity */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div
              onClick={() => logoInputRef.current?.click()}
              style={{
                position: "relative",
                width: 82, height: 82, borderRadius: 18,
                border: "2px dashed rgba(78,206,154,0.4)",
                background: logoPreview ? "transparent" : "#F9F9FB",
                display: "flex", alignItems: "center", justifyContent: "center",
                cursor: logoSaving ? "default" : "pointer", overflow: "hidden", flexShrink: 0,
              }}
            >
              {logoPreview ? (
                <img src={logoPreview} alt="Logo" style={{ width: "100%", height: "100%", objectFit: "contain", borderRadius: 16 }} />
              ) : (
                <svg width="24" height="24" fill="none" viewBox="0 0 24 24" stroke="rgba(78,206,154,0.7)" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
              )}
              {logoPreview ? (
                <button
                  type="button"
                  onClick={(event) => { event.stopPropagation(); void saveLogoData(null); }}
                  disabled={logoSaving}
                  aria-label="Remove logo"
                  style={{
                    position: "absolute",
                    right: 4,
                    top: 4,
                    width: 20,
                    height: 20,
                    borderRadius: "50%",
                    border: "2px solid #fff",
                    background: "#FF3B30",
                    color: "#fff",
                    cursor: logoSaving ? "default" : "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    boxShadow: "0 4px 12px rgba(255,59,48,0.25)",
                  }}
                >
                  <svg width="9" height="9" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3.4}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              ) : null}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <label style={{ display: "block", marginBottom: 6, fontSize: 11, fontWeight: 800, color: "rgba(60,60,67,0.5)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                Business Display Name
              </label>
              <input
                type="text"
                value={name}
                onChange={e => { setName(e.target.value); setError(""); setSaved(false); }}
                placeholder="e.g. Doug's Coffee Shop"
                maxLength={80}
                className="serapay-settings-name-input"
                style={{
                  width: "100%", height: 46, padding: "0 14px",
                  fontSize: 15, fontWeight: 600, color: "#1C1C1E",
                  background: "#F9F9FB", border: "1.5px solid rgba(60,60,67,0.12)",
                  borderRadius: 12, outline: "none", boxSizing: "border-box",
                  fontFamily: font,
                }}
              />
            </div>
          </div>
          <input
            ref={logoInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            style={{ display: "none" }}
            onChange={handleLogoChange}
            disabled={logoSaving}
          />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <label style={{ fontSize: 16, fontWeight: 750, color: "#111", letterSpacing: 0 }}>QR Design</label>
          <QRDesignFrame
            mode={selectedQrMode}
            style={selectedStyle}
            dotColor={dotColor}
            bgColor={bgColor}
            logo={logoPreview || undefined}
            onModeChange={(mode) => { setSelectedQrMode(mode); setError(""); setSaved(false); }}
            onStyleChange={(nextStyle) => { setSelectedStyle(nextStyle); setError(""); setSaved(false); }}
            onDotColorChange={(color) => { setDotColor(color); setError(""); setSaved(false); }}
            onBgColorChange={(color) => { setBgColor(color); setError(""); setSaved(false); }}
          />
          <p style={{ fontSize: 10, color: "rgba(60,60,67,0.35)", textAlign: "center", margin: 0 }}>Live preview updates as you change mode, design, and colors</p>
        </div>
        {(error || (!accountReady && accountError)) ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {error ? <p style={{ fontSize: 12, color: "#FF3B30", margin: 0 }}>{error}</p> : null}
            {!accountReady && accountError ? (
              <p style={{ fontSize: 12, color: "#FF3B30", margin: 0, lineHeight: 1.45 }}>
                {accountError}
              </p>
            ) : null}
          </div>
        ) : null}

        {/* Save button */}
        <button
          onClick={() => { if (isRetryAccountAction) onRetryAccount?.(); else void handleSave(); }}
          disabled={saveDisabled}
          className={isRetryAccountAction ? "serapay-action-danger" : "serapay-action-primary"}
          style={{
            width: "100%", minHeight: 56, borderRadius: 18,
            background: isRetryAccountAction ? "#FFF5F5" : !accountReady ? "#E8ECEA" : saved ? "#E8F8F0" : saveLooksActive ? "linear-gradient(135deg, #4ECE9A, #2FAA7D)" : "#E8ECEA",
            border: saved ? "1px solid rgba(0,168,85,0.3)" : isRetryAccountAction ? "1px solid rgba(255,59,48,0.3)" : "none",
            color: isRetryAccountAction ? "#FF3B30" : !accountReady || (!saveLooksActive && !saved) ? "rgba(60,60,67,0.45)" : saved ? "#00A855" : "#fff",
            fontSize: 16, fontWeight: 800, cursor: saveDisabled ? "default" : "pointer",
            boxShadow: saveLooksActive ? "0 8px 22px rgba(78,206,154,0.32)" : "none",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            transition: "all 0.2s",
            flexShrink: 0,
          }}
        >
          {isRetryAccountAction ? "Retry Account Setup" : null}
          <span style={{ display: isRetryAccountAction ? "none" : "contents" }}>
          {!accountReady ? "Preparing Account…" : saved ? (
            <>
              <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
              Saved!
            </>
          ) : saving ? "Saving..." : "Save Changes"}
          </span>
        </button>
        </div>
      </div>
      {logoCropSource ? (
        <LogoCropModal
          source={logoCropSource}
          uploading={logoSaving}
          onCancel={() => setLogoCropSource(null)}
          onConfirm={(dataUrl) => {
            void saveLogoData(dataUrl).then(() => setLogoCropSource(null));
          }}
        />
      ) : null}
    </>
  );
}

// ── Payment Toast Banner ──────────────────────────────────────────────
type HomeLoginMethod = "wallet" | "email" | "google" | "twitter";

function WalletQrScannerModal({
  onClose,
  onDetected,
}: {
  onClose: () => void;
  onDetected: (address: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [message, setMessage] = useState("Point the camera at a wallet QR.");

  useEffect(() => {
    let stopped = false;
    let raf = 0;
    let stream: MediaStream | null = null;
    let detector: BarcodeDetectorLike | null = null;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    async function startScanner() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setMessage("Camera access is not available in this browser.");
        return;
      }

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();

        if (window.BarcodeDetector) {
          detector = new window.BarcodeDetector({ formats: ["qr_code"] });
        }
        setMessage("Point the camera at a wallet QR.");

        const scan = async () => {
          if (stopped || !videoRef.current) return;
          let rawValue = "";
          try {
            if (detector) {
              const codes = await detector.detect(videoRef.current);
              rawValue = codes[0]?.rawValue || "";
            }
          } catch {
            // Some browsers throw while the video element is still warming up.
          }

          if (!rawValue && ctx && videoRef.current.readyState >= 2 && videoRef.current.videoWidth > 0) {
            try {
              canvas.width = videoRef.current.videoWidth;
              canvas.height = videoRef.current.videoHeight;
              ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
              const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
              rawValue = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: "attemptBoth" })?.data || "";
            } catch {
              // Keep scanning; the next animation frame usually has a usable video frame.
            }
          }

          if (rawValue) {
            const address = extractWalletAddressFromQr(rawValue);
            if (address) {
              onDetected(address);
              return;
            }
            setMessage("QR found, but it does not contain an EVM wallet address.");
          }
          raf = requestAnimationFrame(scan);
        };
        raf = requestAnimationFrame(scan);
      } catch (error: any) {
        setMessage(error?.message || "Unable to open the camera. Paste the wallet address instead.");
      }
    }

    void startScanner();

    return () => {
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [onDetected]);

  return (
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 82, background: "rgba(0,0,0,0.38)", backdropFilter: "blur(6px)" }} onClick={onClose} />
      <div style={{ position: "fixed", inset: 0, zIndex: 83, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, pointerEvents: "none" }}>
        <div style={{ width: "min(420px, calc(100vw - 32px))", borderRadius: 22, background: "#fff", boxShadow: "0 24px 70px rgba(10,31,26,0.2)", padding: 18, boxSizing: "border-box", pointerEvents: "auto" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <div>
              <h3 style={{ margin: 0, color: "#0A1F1A", fontSize: 18, fontWeight: 850 }}>Scan with wallet</h3>
              <p style={{ margin: "4px 0 0", color: "rgba(60,60,67,0.58)", fontSize: 12 }}>{message}</p>
            </div>
            <button type="button" onClick={onClose} aria-label="Close" style={{ width: 34, height: 34, borderRadius: "50%", border: "none", background: "#F2F2F7", color: "rgba(60,60,67,0.55)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>
          <div style={{ position: "relative", overflow: "hidden", borderRadius: 18, background: "#0A1F1A", aspectRatio: "1 / 1" }}>
            <video ref={videoRef} muted playsInline style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
            <div style={{ position: "absolute", inset: 36, borderRadius: 18, border: "2px solid rgba(255,255,255,0.78)", boxShadow: "0 0 0 999px rgba(10,31,26,0.28)" }} />
          </div>
        </div>
      </div>
    </>
  );
}

function HeaderNetworkBadge({ activeMode }: { activeMode: PaymentMode }) {
  const isLive = activeMode === "live";
  return (
    <span style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      height: 30,
      padding: "0 10px",
      borderRadius: 999,
      border: "1px solid rgba(10,31,26,0.08)",
      background: "#fff",
      color: "rgba(10,31,26,0.72)",
      fontSize: 11,
      fontWeight: 750,
      whiteSpace: "nowrap",
      flexShrink: 0,
      boxShadow: "0 1px 8px rgba(10,31,26,0.04)",
    }}>
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: isLive ? "#00C896" : "#FFB020" }} />
      Network: {isLive ? "Live" : "Testnet"}
    </span>
  );
}

function GuestReceiverModal({
  onClose,
  onSubmitAddress,
  onConnect,
  onSeraLogin,
}: {
  onClose: () => void;
  onSubmitAddress: (address: string) => void;
  onConnect: (methods: HomeLoginMethod[]) => void;
  onSeraLogin: () => void;
}) {
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const [showScanner, setShowScanner] = useState(false);

  const submit = () => {
    const nextAddress = address.trim();
    if (!isValidEvmAddress(nextAddress)) {
      setError("Enter a valid EVM wallet address.");
      return;
    }
    onSubmitAddress(nextAddress);
  };

  const optionStyle: React.CSSProperties = {
    width: "100%",
    minHeight: 54,
    borderRadius: 15,
    border: "1px solid rgba(10,31,26,0.08)",
    background: "#fff",
    color: "#0A1F1A",
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "10px 12px",
    cursor: "pointer",
    textAlign: "left",
    fontFamily: font,
  };

  return (
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 70, background: "rgba(0,0,0,0.32)", backdropFilter: "blur(6px)" }} onClick={onClose} />
      <div style={{ position: "fixed", inset: 0, zIndex: 71, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, pointerEvents: "none" }}>
        <div style={{ width: "min(460px, calc(100vw - 32px))", borderRadius: 24, background: "#fff", boxShadow: "0 24px 70px rgba(10,31,26,0.18)", padding: 22, boxSizing: "border-box", pointerEvents: "auto" }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 18 }}>
            <div>
              <h3 style={{ margin: 0, color: "#0A1F1A", fontSize: 20, fontWeight: 850 }}>Receive to wallet</h3>
              <p style={{ margin: "6px 0 0", color: "rgba(60,60,67,0.6)", fontSize: 13, lineHeight: 1.45 }}>Add the wallet that should receive this QR payment.</p>
            </div>
            <button type="button" onClick={onClose} aria-label="Close" style={{ width: 36, height: 36, borderRadius: "50%", border: "none", background: "#F2F2F7", color: "rgba(60,60,67,0.55)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>

          <label style={{ display: "block", marginBottom: 8, color: "rgba(60,60,67,0.5)", fontSize: 11, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase" }}>Enter your wallet</label>
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ position: "relative", minWidth: 0, flex: 1 }}>
              <input
                value={address}
                onChange={(event) => { setAddress(event.target.value); setError(""); }}
                onKeyDown={(event) => { if (event.key === "Enter") submit(); }}
                placeholder="0x..."
                spellCheck={false}
                style={{ width: "100%", height: 50, borderRadius: 15, border: `1.5px solid ${error ? "rgba(255,59,48,0.45)" : "rgba(10,31,26,0.10)"}`, background: "#F9F9FB", color: "#0A1F1A", fontSize: 14, fontWeight: 600, padding: "0 48px 0 14px", outline: "none", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", boxSizing: "border-box" }}
              />
              <button
                type="button"
                onClick={() => setShowScanner(true)}
                aria-label="Scan with wallet"
                style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", width: 34, height: 34, borderRadius: 12, border: "1px solid rgba(10,31,26,0.08)", background: "#fff", color: "#00A87A", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
              >
                <QrCode size={17} />
              </button>
            </div>
            <button type="button" onClick={submit} className="serapay-action-primary" aria-label="Use wallet address" style={{ width: 54, height: 50, borderRadius: 15, border: "none", background: "linear-gradient(135deg, #00C896, #00A87A, #008A64)", color: "#fff", cursor: "pointer", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <ArrowRight size={20} strokeWidth={2.8} />
            </button>
          </div>
          {error ? <p style={{ margin: "8px 0 0", color: "#FF3B30", fontSize: 12, fontWeight: 650 }}>{error}</p> : null}

          <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "18px 0 14px" }}>
            <div style={{ height: 1, background: "rgba(10,31,26,0.08)", flex: 1 }} />
            <span style={{ color: "rgba(60,60,67,0.42)", fontSize: 11, fontWeight: 750, letterSpacing: "0.08em", textTransform: "uppercase" }}>Or connect with</span>
            <div style={{ height: 1, background: "rgba(10,31,26,0.08)", flex: 1 }} />
          </div>

          <div style={{ display: "grid", gap: 10 }}>
            <button type="button" onClick={onSeraLogin} style={{ ...optionStyle, background: "#F4FBF8", borderColor: "rgba(0,168,122,0.22)" }}>
              <span style={{ width: 36, height: 36, borderRadius: 12, background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, overflow: "hidden" }}><img src="/apple-icon-180x180.png" alt="" style={{ width: 28, height: 28, borderRadius: "50%", display: "block" }} /></span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <img src="/sera-logo.svg" alt="Sera.cx" style={{ display: "block", height: 14, width: 82, objectFit: "contain", objectPosition: "left center" }} />
                <span style={{ display: "block", marginTop: 2, color: "rgba(60,60,67,0.52)", fontSize: 12 }}>Sign in with Sera</span>
              </span>
            </button>
            <button type="button" onClick={() => onConnect(["wallet"])} style={optionStyle}>
              <span style={{ width: 36, height: 36, borderRadius: 12, background: "#E6FAF5", color: "#00A87A", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><Wallet size={18} /></span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 14, fontWeight: 800 }}>Connect existing wallet</span>
                <span style={{ display: "block", marginTop: 2, color: "rgba(60,60,67,0.52)", fontSize: 12 }}>MetaMask, OKX, Trust Wallet and more</span>
              </span>
            </button>
          </div>
        </div>
      </div>
      {showScanner ? (
        <WalletQrScannerModal
          onClose={() => setShowScanner(false)}
          onDetected={(nextAddress) => {
            setAddress(nextAddress);
            setError("");
            setShowScanner(false);
          }}
        />
      ) : null}
    </>
  );
}

function PaymentToast({ amount, coin, onDismiss }: { amount: string; coin: string; onDismiss: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 5000);
    return () => clearTimeout(t);
  }, [onDismiss]);
  return (
    <div style={{
      position: "fixed", top: 0, left: 0, right: 0, zIndex: 9999,
      background: "linear-gradient(135deg, #00C853, #00A855)",
      color: "#fff", padding: "14px 20px",
      display: "flex", alignItems: "center", justifyContent: "space-between",
      boxShadow: "0 4px 20px rgba(0,200,83,0.35)",
      animation: "slideDown 0.35s cubic-bezier(0.34,1.56,0.64,1)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 22 }}>&#x2713;</span>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: "-0.01em" }}>Payment Received</div>
          <div style={{ fontSize: 13, opacity: 0.9 }}>{amount} {coin}</div>
        </div>
      </div>
      <button onClick={onDismiss} style={{ background: "none", border: "none", color: "#fff", fontSize: 20, cursor: "pointer", opacity: 0.8, padding: "0 4px" }}>×</button>
    </div>
  );
}

// ── Transaction History Panel ──────────────────────────────────────────────
function TransactionHistory({ apiKey, chainId }: { apiKey: string; chainId: number }) {
  const [txs, setTxs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [muted, setMuted] = useState(false);
  const [toast, setToast] = useState<{ amount: string; coin: string } | null>(null);
  // Track known confirmed tx IDs to detect new arrivals
  const knownConfirmedIds = useRef<Set<string>>(new Set());
  const isFirstLoad = useRef(true);

  const notifyPayment = useCallback((amount: string, coin: string) => {
    // Show toast banner
    setToast({ amount, coin });
    // Speak if not muted
    if (!muted && window.speechSynthesis) {
      const msg = new SpeechSynthesisUtterance(`Payment received. ${amount} ${coin}.`);
      msg.rate = 0.95; msg.pitch = 1.0; msg.volume = 1.0;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(msg);
    }
  }, [muted]);

  const fetchTxs = useCallback(async () => {
    if (!apiKey) return;
    try {
      const res = await fetch(`/api/merchant/transactions?chainId=${chainId}`, {
        headers: { "X-Api-Key": apiKey },
      });
      if (!res.ok) { setError("Failed to load transactions"); return; }
      const data = await res.json();
      const newTxs: any[] = Array.isArray(data) ? data : (data.transactions ?? []);

      // On subsequent fetches, detect newly confirmed transactions
      if (!isFirstLoad.current) {
        for (const tx of newTxs) {
          if (tx.status === "confirmed" && !knownConfirmedIds.current.has(tx.id)) {
            notifyPayment(parseFloat(tx.amount).toFixed(2), tx.coin);
          }
        }
      }

      // Update known confirmed IDs
      for (const tx of newTxs) {
        if (tx.status === "confirmed") knownConfirmedIds.current.add(tx.id);
      }
      isFirstLoad.current = false;

      setTxs(newTxs);
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }, [apiKey, chainId, notifyPayment]);

  const openPendingPayment = (tx: any) => {
    if (tx.status !== "pending" && tx.status !== "confirming") return;
    const url = tx.paymentUrl || (tx.toAddress ? buildPaymentUrl({
      receiverAddress: tx.toAddress,
      receiveCoin: tx.coin,
      amount: tx.amount,
      chainId: tx.chainId || chainId,
    }) : "");
    if (url) window.location.href = url;
  };

  useEffect(() => { fetchTxs(); }, [fetchTxs]);

  // Auto-refresh every 10s
  useEffect(() => {
    const interval = setInterval(fetchTxs, 10000);
    return () => clearInterval(interval);
  }, [fetchTxs]);

  return (
    <div style={{ marginTop: 24 }}>
      {/* Toast banner */}
      {toast && <PaymentToast amount={toast.amount} coin={toast.coin} onDismiss={() => setToast(null)} />}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, paddingLeft: 4 }}>
        <p style={{ fontSize: 10, fontWeight: 600, color: "rgba(60,60,67,0.35)", textTransform: "uppercase", letterSpacing: "0.1em", margin: 0 }}>
          Recent Transactions
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {/* Mute toggle */}
          <button
            onClick={() => setMuted(m => !m)}
            title={muted ? "Unmute notifications" : "Mute notifications"}
            style={{ background: "none", border: "none", cursor: "pointer", padding: "2px 4px", fontSize: 16, opacity: muted ? 0.35 : 0.7, lineHeight: 1 }}
          >
            {muted ? "\uD83D\uDD07" : "\uD83D\uDD0A"}
          </button>
          <button onClick={fetchTxs} style={{
            background: "none", border: "none", cursor: "pointer", padding: "2px 6px",
            fontSize: 11, color: "#00C853", fontWeight: 600,
          }}>Refresh</button>
        </div>
      </div>

      {loading ? (
        <div style={{ background: "#fff", borderRadius: 16, padding: "20px", textAlign: "center", boxShadow: "0 1px 8px rgba(0,0,0,0.06)" }}>
          <p style={{ fontSize: 13, color: "rgba(60,60,67,0.4)", margin: 0 }}>Loading…</p>
        </div>
      ) : error ? (
        <div style={{ background: "#fff", borderRadius: 16, padding: "20px", textAlign: "center", boxShadow: "0 1px 8px rgba(0,0,0,0.06)" }}>
          <p style={{ fontSize: 13, color: "#FF3B30", margin: 0 }}>{error}</p>
        </div>
      ) : txs.length === 0 ? (
        <div style={{ background: "#fff", borderRadius: 16, padding: "24px 20px", textAlign: "center", boxShadow: "0 1px 8px rgba(0,0,0,0.06)" }}>
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="rgba(60,60,67,0.2)" strokeWidth="1.5" style={{ marginBottom: 8 }}>
            <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
          </svg>
          <p style={{ fontSize: 13, color: "rgba(60,60,67,0.4)", margin: 0 }}>No transactions yet</p>
          <p style={{ fontSize: 11, color: "rgba(60,60,67,0.3)", margin: "4px 0 0" }}>Share your QR code or payment link to receive your first payment</p>
        </div>
      ) : (
        <div style={{ background: "#fff", borderRadius: 16, overflow: "hidden", boxShadow: "0 1px 8px rgba(0,0,0,0.06)" }}>
          {txs.slice(0, 20).map((tx, i) => {
            const date = new Date(tx.createdAt);
            const timeStr = date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
            const amountNum = parseFloat(tx.amount);
            const amountStr = isNaN(amountNum) ? tx.amount : amountNum.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
            return (
              <div key={tx.id} onClick={() => openPendingPayment(tx)} style={{
                display: "flex", alignItems: "center", gap: 12, padding: "12px 16px",
                borderTop: i > 0 ? "1px solid rgba(60,60,67,0.06)" : "none",
                cursor: tx.status === "pending" || tx.status === "confirming" ? "pointer" : "default",
              }}>
                <TokenIcon symbol={tx.coin} size={32} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                    <span style={{ fontSize: 14, fontWeight: 700, color: "#1C1C1E" }}>{amountStr}</span>
                    <span style={{ fontSize: 12, fontWeight: 500, color: "rgba(60,60,67,0.5)" }}>{tx.coin}</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 11, color: "rgba(60,60,67,0.4)" }}>{timeStr}</span>
                    {tx.fromAddress && (
                      <span style={{ fontSize: 11, color: "rgba(60,60,67,0.3)", fontFamily: "monospace" }}>
                        {tx.fromAddress.slice(0, 6)}…{tx.fromAddress.slice(-4)}
                      </span>
                    )}
                  </div>
                </div>
                <StatusBadge status={tx.status} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Main Home Page ─────────────────────────────────────────────────────────
export default function Home() {
  const { login, authenticated, ready, user } = usePrivy();
  const { apiKey: dashboardApiKey, walletAddress: authWalletAddress, logout: authLogout, retry: retryAccountSetup, error: accountSetupError, isLoading: accountSetupLoading } = useAuth();
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const walletChainId = useChainId();
  const { data: seraConfig } = useSeraApiConfig();
  const paymentChainId = resolvePaymentChainId(walletChainId, seraConfig?.mode);
  const paymentMode: PaymentMode = paymentChainId === LIVE_PAYMENT_CHAIN_ID ? "live" : "test";
  const [privyTimedOut, setPrivyTimedOut] = useState(false);
  useEffect(() => {
    if (ready) return;
    const timer = setTimeout(() => setPrivyTimedOut(true), 8000);
    return () => clearTimeout(timer);
  }, [ready]);

  const [step, setStep] = useState<1 | 2>(1); // 1 = form, 2 = QR display
  const [selectedCoin, setSelectedCoin] = useState<Stablecoin | null>(null);
  const [amount, setAmount] = useState("");
  const [customerCoin, setCustomerCoin] = useState<Stablecoin | null>(null);
  const [customerAmount, setCustomerAmount] = useState("");
  // 'receive' = merchant edited top field; 'pay' = customer edited bottom field
  const [lastEdited, setLastEdited] = useState<"receive" | "pay">("receive");
  const [exchangeRate, setExchangeRate] = useState<number | null>(null);
  const [rateLoading, setRateLoading] = useState(false);
  const rateAbortRef = useRef<AbortController | null>(null);
  const [paymentUrl, setPaymentUrl] = useState("");
  const [guestReceiverAddress, setGuestReceiverAddress] = useState("");
  const [showGuestReceiverModal, setShowGuestReceiverModal] = useState(false);
  const [showCoinSheet, setShowCoinSheet] = useState(false);
  const [showCustomerCoinSheet, setShowCustomerCoinSheet] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [copied, setCopied] = useState(false);
  const [qrDownloading, setQrDownloading] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [merchantApiKey, setMerchantApiKey] = useState("");
  const [merchantName, setMerchantName] = useState("");
  // Pass merchantApiKey so the query only fires once the key is loaded from localStorage.
  // This prevents the race condition where the query fires on mount before the key is available,
  // gets a 401, and never retries — causing logo and profile data to disappear on reload.
  const { data: merchantProfile } = useMerchantProfile(merchantApiKey || undefined);
  const [localLogoData, setLocalLogoData] = useState(""); // optimistic local logo after upload
  // Local QR prefs — wallet-scoped keys, restored lazily after walletAddress is known
  const [localQrFgColor, setLocalQrFgColor] = useState("");
  const [localQrBgColor, setLocalQrBgColor] = useState("");
  const [localQrStyle, setLocalQrStyle] = useState<QrStyle>("" as QrStyle);
  const [localQrMode, setLocalQrMode] = useState<QrMode>("" as QrMode);
  // QR generation options
  const [description, setDescription] = useState("");
  const [expiryOption, setExpiryOption] = useState<"none" | "15m" | "1h" | "24h" | "7d">("none");
  const [singleUse, setSingleUse] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  // QR step local state (must be declared here to satisfy Rules of Hooks)
  const [qrEditMode, setQrEditMode] = useState(false);
  const [qrEditAmount, setQrEditAmount] = useState("");
  const [showQrCoinSheet, setShowQrCoinSheet] = useState(false);
  const [showQrReceiveCoinSheet, setShowQrReceiveCoinSheet] = useState(false);
  const [qrRateLoading, setQrRateLoading] = useState(false);
  const directQrScanFromBlockRef = useRef<string | null>(null);
  const directQrScanKeyRef = useRef("");
  const [directQrPayment, setDirectQrPayment] = useState<{ amount: string; coin: string } | null>(null);

  const walletAddress = authWalletAddress ||
    user?.wallet?.address ||
    (user?.linkedAccounts as any[])?.find((a: any) => a.type === "wallet")?.address ||
    "";
  const receiverAddress = merchantProfile?.storeAddress || merchantProfile?.walletAddress || walletAddress || guestReceiverAddress;
  const qrDisplayCoin = customerCoin ?? selectedCoin;
  const qrDisplayAmount = normalizeDecimalAmountText(customerAmount || amount);
  const isConnected = authenticated;
  const merchantWorkspaceReady = Boolean(dashboardApiKey && walletAddress);

  // AuthProvider owns Privy token verification and merchant registration.
  // Home only mirrors the verified dashboard key into QR/profile state.
  useEffect(() => {
    if (!isConnected || !walletAddress) {
      setMerchantApiKey("");
      setMerchantName("");
      return;
    }

    const storedName = localStorage.getItem(`serapay_name_${walletAddress}`);
    if (dashboardApiKey) {
      setMerchantApiKey(dashboardApiKey);
      if (storedName) setMerchantName(storedName);
      return;
    }

    setMerchantApiKey("");
  }, [isConnected, walletAddress, dashboardApiKey]);

  useEffect(() => {
    if (!merchantProfile?.name) return;
    setMerchantName(merchantProfile.name);
    if (walletAddress) localStorage.setItem(`serapay_name_${walletAddress}`, merchantProfile.name);
  }, [merchantProfile?.name, walletAddress]);

  const handleConnectWallet = useCallback(async () => {
    if (isConnected) {
      setLocation("/dashboard");
      return;
    }
    try {
      await login();
    } catch {}
  }, [isConnected, login, setLocation]);

  const openLoginMethods = useCallback((methods: HomeLoginMethod[]) => {
    try {
      (login as any)({ loginMethods: methods });
      setShowGuestReceiverModal(false);
    } catch {}
  }, [login]);

  const openSeraLogin = useCallback(() => openLoginMethods(["email", "google", "twitter"]), [openLoginMethods]);

  // ── Fetch exchange rate whenever coins change ──────────────────────────
  useEffect(() => {
    if (!selectedCoin || !customerCoin) { setExchangeRate(null); return; }
    if (selectedCoin.symbol === customerCoin.symbol) { setExchangeRate(1); return; }
    // Abort previous in-flight request
    rateAbortRef.current?.abort();
    const ctrl = new AbortController();
    rateAbortRef.current = ctrl;
    setRateLoading(true);
    fetch(`/api/rates?from=${selectedCoin.symbol}&to=${customerCoin.symbol}&chainId=${paymentChainId}`, { signal: ctrl.signal })
      .then(r => r.json())
      .then(data => {
        if (data.rate) {
          setExchangeRate(data.rate);
          // Recalculate the dependent field
          if (lastEdited === "receive" && amount) {
            const calc = (parseFloat(amount) * data.rate);
            setCustomerAmount(isNaN(calc) ? "" : formatDecimalAmount(calc));
          } else if (lastEdited === "pay" && customerAmount) {
            const calc = (parseFloat(customerAmount) / data.rate);
            setAmount(isNaN(calc) ? "" : formatDecimalAmount(calc));
          }
        }
      })
      .catch(e => { if (e.name !== "AbortError") setExchangeRate(null); })
      .finally(() => setRateLoading(false));
    return () => ctrl.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCoin?.symbol, customerCoin?.symbol, paymentChainId]);

  // Persist selected coin (wallet-scoped key)
  useEffect(() => {
    if (selectedCoin && walletAddress) {
      try { localStorage.setItem(`serapay_coin_${walletAddress}`, selectedCoin.symbol); } catch {}
    }
  }, [selectedCoin, walletAddress]);
  // Restore coin + QR prefs once walletAddress is known
  useEffect(() => {
    if (!isConnected || !walletAddress) return;
    try {
      // Coin
      const savedCoin = localStorage.getItem(`serapay_coin_${walletAddress}`) ||
        localStorage.getItem("serapay_receive_coin"); // migrate legacy key
      if (savedCoin) {
        const coin = STABLECOINS.find(c => c.symbol === savedCoin);
        if (coin) setSelectedCoin(coin);
      }
      // QR prefs
      const fg = localStorage.getItem(`serapay_qr_fgColor_${walletAddress}`);
      const bg = localStorage.getItem(`serapay_qr_bgColor_${walletAddress}`);
      const st = localStorage.getItem(`serapay_qr_style_${walletAddress}`) as QrStyle;
      const mode = localStorage.getItem(`serapay_qr_mode_${walletAddress}`) as QrMode;
      if (fg) setLocalQrFgColor(fg);
      if (bg) setLocalQrBgColor(bg);
      if (st) setLocalQrStyle(normalizeQrStyleValue(st));
      if (mode === "standard" || mode === "advanced") setLocalQrMode(mode);
    } catch {}
  }, [isConnected, walletAddress]);
  // Hydrate localLogoData from profile once it loads (so logo shows in QR after page refresh)
  useEffect(() => {
    setLocalLogoData(isSupportedLogoValue(merchantProfile?.logoData) ? merchantProfile.logoData : "");
  }, [merchantProfile?.logoData]);

  useEffect(() => {
    if (!merchantProfile) return;
    if (merchantProfile.qrFgColor) setLocalQrFgColor(merchantProfile.qrFgColor);
    if (merchantProfile.qrBgColor) setLocalQrBgColor(merchantProfile.qrBgColor);
    if (merchantProfile.qrStyle) setLocalQrStyle(normalizeQrStyleValue(merchantProfile.qrStyle));
    if (merchantProfile.qrMode === "advanced" || merchantProfile.qrMode === "standard") setLocalQrMode(merchantProfile.qrMode);
  }, [merchantProfile]);

  const getExpiresAt = useCallback((): number | undefined => {
    const now = Date.now();
    if (expiryOption === "15m") return now + 15 * 60 * 1000;
    if (expiryOption === "1h") return now + 60 * 60 * 1000;
    if (expiryOption === "24h") return now + 24 * 60 * 60 * 1000;
    if (expiryOption === "7d") return now + 7 * 24 * 60 * 60 * 1000;
    return undefined;
  }, [expiryOption]);

  const createPaymentUrl = useCallback((overrides: {
    receiveCoin?: Stablecoin | null;
    receiveAmount?: string;
    payCoin?: Stablecoin | null;
    payAmount?: string;
    receiverAddress?: string;
    includeExpiry?: boolean;
  } = {}) => {
    const receiveCoin = overrides.receiveCoin ?? selectedCoin;
    const receiveAddress = overrides.receiverAddress ?? receiverAddress;
    if (!receiveCoin || !receiveAddress) return "";
    const receiveAmount = overrides.receiveAmount ?? amount;
    const payCoin = overrides.payCoin ?? customerCoin;
    const payAmount = overrides.payAmount ?? customerAmount;
    const includeExpiry = overrides.includeExpiry ?? true;

    return buildPaymentUrl({
      receiverAddress: receiveAddress,
      receiveCoin: receiveCoin.symbol,
      chainId: paymentChainId,
      amount: receiveAmount || undefined,
      payCoin: payCoin?.symbol || undefined,
      payAmount: payAmount || undefined,
      merchantName: merchantName || undefined,
      description: description.trim() || undefined,
      expiresAt: includeExpiry ? getExpiresAt() : undefined,
      singleUse: includeExpiry ? singleUse || undefined : undefined,
    });
  }, [selectedCoin, receiverAddress, amount, customerCoin, customerAmount, merchantName, description, getExpiresAt, singleUse, paymentChainId]);

  const handleSwapCoins = useCallback(() => {
    if (!selectedCoin || !customerCoin) return;
    const receiveCoin = selectedCoin;
    const receiveAmount = normalizeDecimalAmountText(amount);
    const payAmount = normalizeDecimalAmountText(customerAmount);
    setSelectedCoin(customerCoin);
    setCustomerCoin(receiveCoin);
    setAmount(payAmount || receiveAmount);
    setCustomerAmount(receiveAmount || payAmount);
    setLastEdited("receive");
  }, [selectedCoin, customerCoin, amount, customerAmount]);

  const handleGenerateQR = useCallback(() => {
    if (!selectedCoin) return;
    if (!receiverAddress) {
      setShowGuestReceiverModal(true);
      return;
    }
    const url = createPaymentUrl();
    if (!url) return;
    setPaymentUrl(url);
    setStep(2);
  }, [createPaymentUrl, receiverAddress, selectedCoin]);

  const handleGuestReceiverSubmit = useCallback((address: string) => {
    if (!selectedCoin) return;
    const nextAddress = address.trim();
    setGuestReceiverAddress(nextAddress);
    setShowGuestReceiverModal(false);
    const url = createPaymentUrl({ receiverAddress: nextAddress });
    if (!url) return;
    setPaymentUrl(url);
    setStep(2);
  }, [createPaymentUrl, selectedCoin]);

  const handleCopyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(paymentUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 5000);
    } catch {}
  }, [paymentUrl]);

  const handleDownloadQR = useCallback(async () => {
    if (!paymentUrl || !receiverAddress) return;
    setQrDownloading(true);
    try {
      const displayCoin = customerCoin ?? selectedCoin;
      const displayAmount = customerAmount || amount;
      const walletQrValue = buildWalletPaymentUri({
        receiverAddress,
        coin: displayCoin?.symbol,
        amount: displayAmount || undefined,
        chainId: paymentChainId,
      }) || paymentUrl;
      await downloadPaymentQrCard({
        qrValue: walletQrValue,
        receiverAddress,
        amount: displayAmount,
        coin: displayCoin?.symbol,
        merchantName,
        merchantLogo: localLogoData || merchantProfile?.logoData || null,
        fgColor: normalizeQrColor(localQrFgColor || merchantProfile?.qrFgColor, "#000000"),
        bgColor: normalizeQrColor(localQrBgColor || merchantProfile?.qrBgColor, "#ffffff"),
        qrStyle: normalizeQrStyleValue(localQrStyle || merchantProfile?.qrStyle),
        qrMode: localQrMode || merchantProfile?.qrMode || "standard",
      });
    } catch (e) {
      console.error("QR card download failed:", e);
    } finally {
      setQrDownloading(false);
    }
  }, [amount, customerAmount, customerCoin, localLogoData, localQrBgColor, localQrFgColor, localQrMode, localQrStyle, merchantName, merchantProfile, paymentChainId, paymentUrl, receiverAddress, selectedCoin]);

  const handleReset = useCallback(() => {
    setStep(1);
    setPaymentUrl("");
    setCopied(false);
    setDirectQrPayment(null);
    directQrScanFromBlockRef.current = null;
    directQrScanKeyRef.current = "";
    // If description is pre-filled, auto-open advanced options so user knows it's there
    if (description.trim()) setShowAdvanced(true);
  }, [description]);

  useEffect(() => {
    const coin = qrDisplayCoin?.symbol;
    const scanAmount = qrDisplayAmount;
    if (step !== 2 || !paymentUrl || !receiverAddress || !coin || !scanAmount || Number(scanAmount) <= 0) return;
    if (directQrPayment) return;

    const scanKey = `${receiverAddress.toLowerCase()}:${coin}:${scanAmount}:${paymentChainId}:${paymentUrl}`;
    if (directQrScanKeyRef.current !== scanKey) {
      directQrScanKeyRef.current = scanKey;
      directQrScanFromBlockRef.current = null;
      setDirectQrPayment(null);
    }

    let stopped = false;
    let inflight = false;

    const pollDirectPayment = async () => {
      if (stopped || inflight || directQrPayment) return;
      inflight = true;
      try {
        const body: Record<string, unknown> = {
          toAddress: receiverAddress,
          coin,
          amount: scanAmount,
          chainId: paymentChainId,
          paymentUrl,
        };
        if (directQrScanFromBlockRef.current) body.fromBlock = directQrScanFromBlockRef.current;
        const res = await fetch("/api/payment/direct/scan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) return;
        const data = await res.json();
        if (data.fromBlock && !directQrScanFromBlockRef.current) {
          directQrScanFromBlockRef.current = String(data.fromBlock);
        }
        if (data.status === "confirmed") {
          setDirectQrPayment({ amount: scanAmount, coin });
          queryClient.invalidateQueries({ queryKey: ["/merchant/transactions"] });
          queryClient.invalidateQueries({ queryKey: ["/merchant/stats"] });
          stopped = true;
        }
      } catch {
        // Keep polling; RPC can be briefly slow right after a wallet submits.
      } finally {
        inflight = false;
      }
    };

    void pollDirectPayment();
    const interval = window.setInterval(pollDirectPayment, 5000);
    return () => {
      stopped = true;
      window.clearInterval(interval);
    };
  }, [directQrPayment, paymentChainId, paymentUrl, qrDisplayAmount, qrDisplayCoin?.symbol, queryClient, receiverAddress, step]);

  const handleNameSaved = useCallback((newName: string) => {
    setMerchantName(newName);
    if (walletAddress) localStorage.setItem(`serapay_name_${walletAddress}`, newName);
  }, [walletAddress]);

  // ── Loading splash ─────────────────────────────────────────────────────
  if (!ready && !privyTimedOut) {
    return (
      <div style={{
        minHeight: "100dvh", background: "#F2FAF6", display: "flex",
        alignItems: "center", justifyContent: "center", fontFamily: font,
      }}>
        {/* Visually-hidden headings for SEO crawlers that index the loading state */}
        <h1 style={{ position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0,0,0,0)", whiteSpace: "nowrap", border: 0 }}>
          SeraPay — Accept Stablecoin Payments Instantly
        </h1>
        <h2 style={{ position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0,0,0,0)", whiteSpace: "nowrap", border: 0 }}>
          Accept USDC, USDT &amp; more via QR code — no bank account needed.
        </h2>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
          <div style={{ position: "relative", width: 64, height: 64, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div style={{ position: "absolute", inset: 0, borderRadius: "50%", border: "3px solid rgba(0,209,160,0.15)", borderTopColor: "#00D1A0", animation: "spin 0.8s linear infinite" }} />
            <div style={{ width: 48, height: 48, borderRadius: "50%", background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 10px 30px rgba(0,209,160,0.16)" }}>
              <SeraLogo size={36} />
            </div>
          </div>
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  // ── Unauthenticated landing page ───────────────────────────────────────
  if (false && !isConnected) {
    return (
      <>
      <div style={{
        minHeight: "100dvh", background: "#F2FAF6", fontFamily: font,
        display: "flex", flexDirection: "column", overflow: "hidden",
      }}>
        <SeraPayHeader maxWidth={1240} homeHeader primaryAction={{ label: "Dashboard", onClick: handleConnectWallet }} />
        <main style={{
          flex: "1 1 auto",
          minHeight: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "28px 16px 36px",
          overflowY: "auto",
        }}>
        <div style={{ width: "100%", maxWidth: 420 }}>
          <div style={{
            background: "linear-gradient(180deg, #FFFFFF 0%, #FBFFFD 100%)", borderRadius: 24, padding: "30px 24px",
            border: "1px solid rgba(78,206,154,0.18)",
            boxShadow: "0 18px 55px rgba(10,31,26,0.08)", display: "flex", flexDirection: "column", gap: 20,
          }}>
            <div style={{ textAlign: "center" }}>
              <h1 style={{ fontSize: 22, fontWeight: 800, color: "#0A1F1A", margin: "0 0 6px", letterSpacing: "-0.5px" }}>
                Receive Stablecoins in Any Currency
              </h1>
              <h2 style={{ fontSize: 13, fontWeight: 400, color: "#4A6B5E", margin: 0 }}>
                Accept USDC, USDT &amp; more via QR code — no bank account needed.
              </h2>
            </div>
            <div style={{ background: "#F4FBF8", borderRadius: 14, padding: "14px 16px", border: "1px solid rgba(78,206,154,0.22)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#3EBE8A" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
                  <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
                </svg>
                <span style={{ fontSize: 13, fontWeight: 700, color: "#0A1F1A" }}>How SeraPay Works:</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                {[
                  "Accept any stablecoin from any customer",
                  "Auto-convert to your preferred currency",
                  "No bank account or KYC required",
                  "Works with MetaMask, OKX, Trust Wallet & more",
                ].map((b, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                    <div style={{ width: 5, height: 5, borderRadius: "50%", background: "#4ECE9A", marginTop: 6, flexShrink: 0 }} />
                    <span style={{ fontSize: 13, color: "#3A5A52", lineHeight: 1.5 }}>{b}</span>
                  </div>
                ))}
              </div>
            </div>
            <button onClick={handleConnectWallet} className="serapay-action-primary serapay-shine-button" style={{
              width: "100%", background: "linear-gradient(135deg, #00C896, #00A87A, #008A64)",
              border: "none", borderRadius: 14, padding: "15px 20px",
              fontSize: 15, fontWeight: 700, color: "#fff", cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
              transform: "translateZ(0)",
            }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
              </svg>
              Connect Wallet to Receive
            </button>
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, marginTop: 16 }}>
            <div style={{ width: 5, height: 5, borderRadius: "50%", background: "#4ECE9A" }} />
            <a href="https://sera.cx" target="_blank" rel="noopener noreferrer"
              style={{ fontSize: 11, color: "#4A6B5E", textDecoration: "none" }}>
              Powered by Sera Protocol
            </a>
          </div>
        </div>
        </main>
        <style>{`@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');`}</style>
      </div>
      {/* SEO footer — links to SEO landing pages for search engine discovery */}
      <SeoFooter />
      </>
    );
  }

  if (isConnected && !merchantWorkspaceReady) {
    return (
      <AccountSetupScreen
        walletAddress={walletAddress}
        loading={accountSetupLoading}
        error={accountSetupError}
        onRetry={retryAccountSetup}
        onDisconnect={authLogout}
      />
    );
  }

  // ── Authenticated — QR display (step 2) ───────────────────────────────
  if (step === 2 && paymentUrl) {
    // Determine display values: show what customer pays
    const displayCoin = customerCoin ?? selectedCoin;
    const displayAmount = customerAmount || amount;
    const activeQrValue = buildWalletPaymentUri({
      receiverAddress,
      coin: displayCoin?.symbol,
      amount: displayAmount || undefined,
      chainId: paymentChainId,
    }) || paymentUrl;
    const activeQrRenderMode = localQrMode || (merchantProfile?.qrMode as QrMode) || "standard";
    const activeQrLogo = localLogoData || merchantProfile?.logoData || undefined;
    const activeQrFgColor = normalizeQrColor(localQrFgColor || merchantProfile?.qrFgColor, "#000000");
    const activeQrBgColor = normalizeQrColor(localQrBgColor || merchantProfile?.qrBgColor, "#ffffff");

    const handleQrEditSave = () => {
      if (!qrEditAmount || isNaN(parseFloat(qrEditAmount))) { setQrEditMode(false); return; }
      const safeAmount = normalizeDecimalAmountText(qrEditAmount);
      if (!safeAmount) { setQrEditMode(false); return; }
      setAmount(safeAmount);
      // Recalculate customer amount
      let nextPayAmount = customerCoin?.symbol === selectedCoin?.symbol ? safeAmount : normalizeDecimalAmountText(customerAmount);
      if (exchangeRate && customerCoin && selectedCoin?.symbol !== customerCoin?.symbol) {
        const calc = parseFloat(safeAmount) * exchangeRate;
        nextPayAmount = isNaN(calc) ? "" : formatDecimalAmount(calc);
        setCustomerAmount(nextPayAmount);
      }
      // Rebuild payment URL
      const newUrl = createPaymentUrl({ receiveAmount: safeAmount, payAmount: nextPayAmount });
      setPaymentUrl(newUrl);
      setQrEditMode(false);
    };

    const handleQrCoinSelect = (coin: Stablecoin) => {
      setCustomerCoin(coin);
      setShowQrCoinSheet(false);
      // Fetch new rate and rebuild URL
      if (!selectedCoin) return;
      if (coin.symbol === selectedCoin.symbol) {
        const sameAmount = normalizeDecimalAmountText(amount);
        setCustomerAmount(sameAmount);
        const newUrl = createPaymentUrl({ payCoin: coin, payAmount: sameAmount });
        setPaymentUrl(newUrl);
        return;
      }
      setQrRateLoading(true);
      fetch(`/api/rates?from=${selectedCoin.symbol}&to=${coin.symbol}&chainId=${paymentChainId}`)
        .then(r => r.json())
        .then(data => {
          if (data.rate) {
            const calc = parseFloat(amount) * data.rate;
            const newPayAmount = isNaN(calc) ? "" : formatDecimalAmount(calc);
            setExchangeRate(data.rate);
            setCustomerAmount(newPayAmount);
            const newUrl = createPaymentUrl({ payCoin: coin, payAmount: newPayAmount });
            setPaymentUrl(newUrl);
          }
        })
        .catch(() => {})
        .finally(() => setQrRateLoading(false));
    };

    return (
      <div style={{ minHeight: "100dvh", background: "#F2F2F7", fontFamily: font }}>
        {directQrPayment && (
          <PaymentToast
            amount={directQrPayment.amount}
            coin={directQrPayment.coin}
            onDismiss={() => setDirectQrPayment(null)}
          />
        )}
        <SeraPayHeader
          maxWidth={1240}
          compact
          afterLogoContent={<HeaderNetworkBadge activeMode={paymentMode} />}
          walletAddress={isConnected ? walletAddress : ""}
          primaryAction={!isConnected ? { label: "Dashboard", onClick: handleConnectWallet } : undefined}
          dashboardAction={isConnected ? { label: "Dashboard", onClick: () => setLocation("/dashboard") } : undefined}
          disconnectAction={isConnected ? { label: "Disconnect", onClick: authLogout } : undefined}
        />

        <div style={{ maxWidth: 520, margin: "0 auto", padding: "18px 16px 40px", minHeight: "calc(100dvh - 58px)", display: "grid", alignContent: "center", boxSizing: "border-box" }}>
          <button
            onClick={handleReset}
            className="serapay-back-link"
            style={{
              width: "fit-content",
              margin: "0 0 12px",
              border: "none",
              background: "transparent",
              color: "rgba(60,60,67,0.48)",
              fontSize: 12,
              fontWeight: 650,
              cursor: "pointer",
              padding: "6px 4px",
            }}
          >
            ← Back
          </button>
          {/* QR Card */}
          <div style={{
            background: "#fff", borderRadius: 24, padding: "24px 16px",
            boxShadow: "0 2px 24px rgba(0,0,0,0.07)", textAlign: "center", marginBottom: 16,
            overflow: "visible",
          }}>
            {/* Customer pays label */}
            <p style={{ fontSize: 12, fontWeight: 600, color: "rgba(60,60,67,0.4)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>
              Customer Pays
            </p>
            {qrRateLoading ? (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 44, gap: 8 }}>
                <div style={{ width: 18, height: 18, borderRadius: "50%", border: "2.5px solid rgba(0,200,83,0.2)", borderTopColor: "#00C853", animation: "spin 0.7s linear infinite" }} />
                <span style={{ fontSize: 14, color: "rgba(60,60,67,0.4)", fontWeight: 500 }}>Calculating…</span>
              </div>
            ) : displayAmount ? (
              <div style={{ display: "flex", width: "100%", alignItems: "baseline", justifyContent: "center", gap: 8, margin: "0 0 12px", flexWrap: "wrap" }}>
                <span style={{ fontSize: 28, fontWeight: 800, color: "#0A1F1A", letterSpacing: "-0.5px" }}>
                  {parseFloat(displayAmount).toLocaleString(undefined, { maximumFractionDigits: 6 })}
                </span>
                <button
                  type="button"
                  onClick={() => setShowQrCoinSheet(true)}
                  aria-label="Change customer pay currency"
                  style={{
                    border: "none",
                    background: "transparent",
                    color: "#00D1A0",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                    padding: 0,
                    fontSize: 28,
                    fontWeight: 800,
                    cursor: "pointer",
                    fontFamily: font,
                  }}
                >
                  {displayCoin?.symbol}
                  <ChevronDown size={16} strokeWidth={2.6} />
                </button>
              </div>
            ) : (
              // No amount set (open-amount QR) — still show the coin so merchant knows what's configured
              <div style={{ display: "flex", width: "100%", alignItems: "center", justifyContent: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
                <button
                  type="button"
                  onClick={() => setShowQrCoinSheet(true)}
                  aria-label="Change customer pay currency"
                  style={{ border: "none", background: "transparent", color: "#00D1A0", display: "inline-flex", alignItems: "center", gap: 6, padding: 0, fontSize: 28, fontWeight: 800, cursor: "pointer", fontFamily: font, letterSpacing: "-0.5px" }}
                >
                  {displayCoin?.symbol ?? selectedCoin?.symbol}
                  <ChevronDown size={16} strokeWidth={2.6} />
                </button>
              </div>
            )}
            {/* Spacer — receiveLabel moved below QR */}
            {/* QR Code */}
            <div style={{ display: "block", position: "relative", width: "fit-content", maxWidth: "100%", margin: "0 auto" }}>
              <div id="serapay-qr-wrapper" onClick={handleCopyLink} title="Click to copy payment link" style={{
                display: "block",
                background: activeQrBgColor,
                borderRadius: 16,
                overflow: "hidden",
                maxWidth: "100%", boxSizing: "border-box" as const,
                cursor: "copy",
              }}>
                <QRStyled
                  value={activeQrValue}
                  size={Math.min(320, typeof window !== "undefined" ? window.innerWidth - 96 : 320)}
                  fgColor={activeQrFgColor}
                  bgColor={activeQrBgColor}
                  style={normalizeQrStyleValue(localQrStyle || merchantProfile?.qrStyle)}
                  logo={activeQrLogo}
                  mode={activeQrRenderMode}
                  className="qr-step2-container"
                />
              </div>
            </div>
            <button
              type="button"
              onClick={handleCopyLink}
              aria-label="Copy payment link"
              style={{
                display: "block",
                width: "fit-content",
                margin: "0 auto",
                border: "none",
                background: "transparent",
                color: copied ? "#00A87A" : "rgba(10,31,26,0.56)",
                fontSize: 12,
                lineHeight: 1.1,
                fontWeight: 800,
                cursor: "pointer",
              }}
            >
              {copied ? "Link Copied!" : "Click QR to copy link"}
            </button>
            {/* Wallet address — subtle */}
            <div style={{ width: "min(380px, calc(100vw - 64px))", margin: "9px auto 0", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 10.5, color: "rgba(60,60,67,0.32)", lineHeight: 1.2, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", whiteSpace: "nowrap", overflow: "hidden" }}>
              <span style={{ minWidth: 0, flex: "0 1 auto", overflow: "hidden", textOverflow: "clip", whiteSpace: "nowrap" }}>
                <HighlightedAddress address={receiverAddress} />
              </span>
              <button
                type="button"
                aria-label="Copy wallet address"
                onClick={async () => { try { await navigator.clipboard.writeText(receiverAddress); } catch {} }}
                style={{ width: 26, height: 26, borderRadius: 8, border: "none", background: "#fff", color: "#0A1F1A", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0 }}
              >
                <Copy size={14} strokeWidth={2.2} />
              </button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 14 }}>
              <button
                type="button"
                onClick={handleDownloadQR}
                disabled={qrDownloading}
                className="serapay-action-secondary serapay-hover-green"
                style={{
                  minHeight: 40,
                  borderRadius: 13,
                  border: "1px solid rgba(10,31,26,0.08)",
                  background: "#fff",
                  color: "#0A1F1A",
                  fontSize: 12,
                  fontWeight: 800,
                  cursor: qrDownloading ? "default" : "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                }}
              >
                <Download size={14} />
                {qrDownloading ? "Downloading..." : "Download QR"}
              </button>
              <button
                type="button"
                onClick={() => { window.location.href = getClientAppPath(paymentUrl); }}
                className="serapay-action-secondary serapay-hover-green"
                style={{
                  minHeight: 40,
                  borderRadius: 13,
                  border: "1px solid rgba(10,31,26,0.08)",
                  background: "#fff",
                  color: "#0A1F1A",
                  fontSize: 12,
                  fontWeight: 800,
                  cursor: "pointer",
                }}
              >
                Pay now
              </button>
            </div>
          </div>
          {/* Merchant receives line — directly above action buttons */}
          {/* {amount && selectedCoin && (
            <p style={{ fontSize: 12, color: "rgba(60,60,67,0.5)", textAlign: "center", margin: "0 0 12px", fontWeight: 500 }}>
              {merchantName ? `${merchantName} receives` : "Merchant receives"} <strong style={{ color: "#1C1C1E" }}>{parseFloat(amount).toLocaleString(undefined, { maximumFractionDigits: 6 })} {selectedCoin.symbol}</strong>
            </p>
          )} */}
          <button
            onClick={handleReset}
            className="serapay-back-to-form"
            style={{
              width: "100%",
              height: 42,
              marginTop: 10,
              borderRadius: 14,
              background: "transparent",
              border: "1px solid rgba(60,60,67,0.12)",
              color: "rgba(60,60,67,0.48)",
              fontSize: 12,
              fontWeight: 650,
              cursor: "pointer",
              transition: "background 0.16s, color 0.16s, border-color 0.16s, transform 0.16s",
            }}
          >
            Back
          </button>
        </div>
        {/* Edit Amount Modal */}
        {qrEditMode && (
          <>
            <div style={{ position: "fixed", inset: 0, zIndex: 40, background: "rgba(0,0,0,0.3)", backdropFilter: "blur(4px)" }}
              onClick={() => setQrEditMode(false)} />
            <div style={{
              position: "fixed", zIndex: 50, background: "#fff",
              top: "50%", left: "50%", transform: "translate(-50%, -50%)",
              width: "min(480px, calc(100vw - 32px))", borderRadius: 20,
              padding: "24px 20px 32px", boxShadow: "0 8px 48px rgba(0,0,0,0.18)",
            }}>
              <p style={{ fontSize: 16, fontWeight: 700, color: "#1C1C1E", margin: "0 0 16px" }}>Edit Receive Amount</p>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
                <input
                  type="text"
                  inputMode="decimal"
                  value={qrEditAmount}
                  onChange={e => {
                    const nextAmount = limitDecimalPlaces(e.target.value);
                    setQrEditAmount(nextAmount);
                    if (!nextAmount || isNaN(parseFloat(nextAmount))) return;
                    const nextPayAmount = exchangeRate && customerCoin && selectedCoin?.symbol !== customerCoin?.symbol
                      ? formatDecimalAmount(parseFloat(nextAmount) * exchangeRate)
                      : nextAmount;
                    const nextUrl = createPaymentUrl({ receiveAmount: nextAmount, payAmount: nextPayAmount });
                    if (nextUrl) setPaymentUrl(nextUrl);
                  }}
                  placeholder="0.00"
                  autoFocus
                  style={{
                    flex: 1, height: 52, padding: "0 16px",
                    fontSize: 20, fontWeight: 700, color: "#1C1C1E",
                    background: "#F9F9FB", border: "1.5px solid rgba(0,209,160,0.4)",
                    borderRadius: 14, outline: "none", fontFamily: font,
                  }}
                />
                <button onClick={() => { setShowQrReceiveCoinSheet(true); }} style={{
                  height: 52, padding: "0 14px", background: "#F2F2F7", borderRadius: 14,
                  display: "flex", alignItems: "center", gap: 6, border: "none", cursor: "pointer",
                  flexShrink: 0,
                }}>
                  <TokenIcon symbol={selectedCoin?.symbol ?? ""} size={22} />
                  <span style={{ fontSize: 15, fontWeight: 700, color: "#1C1C1E" }}>{selectedCoin?.symbol}</span>
                  <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="rgba(60,60,67,0.5)" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
                </button>
              </div>
              {exchangeRate && customerCoin && selectedCoin?.symbol !== customerCoin?.symbol && qrEditAmount && (
                <p style={{ fontSize: 12, color: "rgba(60,60,67,0.5)", margin: "0 0 16px" }}>
                  Customer pays ≈ {(parseFloat(qrEditAmount) * exchangeRate).toLocaleString(undefined, { maximumFractionDigits: 2 })} {customerCoin.symbol}
                </p>
              )}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <button onClick={() => setQrEditMode(false)} style={{
                  height: 50, borderRadius: 14, background: "#F2F2F7", border: "none",
                  fontSize: 15, fontWeight: 600, color: "rgba(60,60,67,0.6)", cursor: "pointer",
                }}>Cancel</button>
                <button onClick={handleQrEditSave} style={{
                  height: 50, borderRadius: 14,
                  background: "linear-gradient(135deg, #4ECE9A, #3AB882)", border: "none",
                  fontSize: 15, fontWeight: 700, color: "#fff", cursor: "pointer",
                  boxShadow: "0 4px 16px rgba(78,206,154,0.28)",
                }}>Done</button>
              </div>
            </div>
          </>
        )}

        {/* Change Pay Coin Sheet */}
        {showQrCoinSheet && (
          <CoinSheet
            title="Customer Pays With"
            onClose={() => setShowQrCoinSheet(false)}
            onSelect={handleQrCoinSelect}
            selectedSymbol={displayCoin?.symbol}
          />
        )}

        {/* Change Receive Coin Sheet (from Edit Amount modal) */}
        {showQrReceiveCoinSheet && (
          <CoinSheet
            title="Receive In"
            onClose={() => setShowQrReceiveCoinSheet(false)}
            onSelect={(coin) => {
              setSelectedCoin(coin);
              setShowQrReceiveCoinSheet(false);
              // Recalculate customer amount with new receive coin
              if (customerCoin && customerCoin.symbol !== coin.symbol) {
                fetch(`/api/rates?from=${coin.symbol}&to=${customerCoin.symbol}&chainId=${paymentChainId}`)
                  .then(r => r.json())
                  .then(data => {
                    if (data.rate) {
                      const receiveAmount = normalizeDecimalAmountText(qrEditAmount || amount);
                      const calc = parseFloat(receiveAmount) * data.rate;
                      const newPayAmount = isNaN(calc) ? "" : formatDecimalAmount(calc);
                      setExchangeRate(data.rate);
                      setCustomerAmount(newPayAmount);
                      const newUrl = createPaymentUrl({
                        receiveCoin: coin,
                        receiveAmount,
                        payCoin: customerCoin,
                        payAmount: newPayAmount,
                      });
                      setPaymentUrl(newUrl);
                    }
                  })
                  .catch(() => {});
              } else {
                // Same coin — rebuild URL with new receive coin
                const newUrl = createPaymentUrl({
                  receiveCoin: coin,
                  receiveAmount: normalizeDecimalAmountText(qrEditAmount || amount),
                  payCoin: coin,
                  payAmount: normalizeDecimalAmountText(qrEditAmount || amount),
                });
                setPaymentUrl(newUrl);
              }
            }}
            selectedSymbol={selectedCoin?.symbol}
          />
        )}
      </div>
    );
  }

  // ── Authenticated — main form (step 1) ────────────────────────────────
  return (
    <div style={{ minHeight: "100dvh", background: "#F2F2F7", fontFamily: font }}>
      <SeraPayHeader
        maxWidth={1240}
        walletAddress={isConnected ? walletAddress : ""}
        afterLogoContent={<PaymentModeSwitch activeMode={paymentMode} />}
        primaryAction={!isConnected ? { label: "Dashboard", onClick: handleConnectWallet } : undefined}
        dashboardAction={isConnected ? { label: "Dashboard", onClick: () => setLocation("/dashboard") } : undefined}
        disconnectAction={isConnected ? { label: "Disconnect", onClick: authLogout } : undefined}
      />

      <div style={{ maxWidth: 520, margin: "0 auto", padding: "24px 16px 40px", minHeight: "calc(100dvh - 58px)", display: "grid", alignContent: "center", boxSizing: "border-box" }}>
        {/* Business name display with circular logo avatar */}
        {isConnected ? (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, paddingLeft: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {/* Circular logo avatar — tap to upload */}
            <LogoAvatar
              logoData={localLogoData || merchantProfile?.logoData || ""}
              merchantName={merchantName}
              apiKey={merchantApiKey}
              onLogoSaved={(newLogo) => {
                setLocalLogoData(newLogo);
                queryClient.invalidateQueries({ queryKey: ["/merchant/profile"] });
              }}
            />
            {merchantName && (
              <p style={{ fontSize: 16, fontWeight: 700, color: "#0A1F1A", margin: 0 }}>{merchantName}</p>
            )}
          </div>
          <button onClick={() => setShowSettings(true)} style={{
            background: "none", border: "none", cursor: "pointer", padding: "2px 6px",
            fontSize: 11, color: "rgba(60,60,67,0.4)", fontWeight: 500,
            display: "flex", alignItems: "center", gap: 4,
          }}>
            <svg width="11" height="11" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
            </svg>
            Edit
          </button>
        </div>
        ) : null}

        {/* Section label */}
        <p style={{ fontSize: 10, fontWeight: 600, color: "rgba(60,60,67,0.35)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6, paddingLeft: 4 }}>
          I Receive
        </p>

        {/* Receive coin card */}
        <div className="serapay-payment-field" style={{ background: "#fff", borderRadius: 20, marginBottom: 2, overflow: "hidden", boxShadow: "0 1px 8px rgba(0,0,0,0.07)" }}>
          <div style={{ display: "flex", alignItems: "center", height: 62 }}>
            <button onClick={() => setShowCoinSheet(true)} style={{
              display: "flex", alignItems: "center", gap: 8,
              padding: "0 16px", height: "100%", background: "rgba(0,209,160,0.05)",
              border: "none", borderRight: "1px solid rgba(60,60,67,0.07)",
              cursor: "pointer", flexShrink: 0, minWidth: 140,
            }}>
              {selectedCoin ? (
                <>
                  <TokenIcon symbol={selectedCoin.symbol} size={24} />
                  <span style={{ fontSize: 14, fontWeight: 600, color: "#1C1C1E" }}>{selectedCoin.symbol}</span>
                  <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="rgba(60,60,67,0.3)" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </>
              ) : (
                <span style={{ fontSize: 13, fontWeight: 500, color: "rgba(60,60,67,0.4)" }}>Select coin</span>
              )}
            </button>
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6, padding: "0 16px" }}>
              <input
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={e => {
                  const val = limitDecimalPlaces(e.target.value);
                  setAmount(val);
                  setLastEdited("receive");
                  if (exchangeRate && val) {
                    const calc = parseFloat(val) * exchangeRate;
                    setCustomerAmount(isNaN(calc) ? "" : formatDecimalAmount(calc));
                  } else if (!val) {
                    setCustomerAmount("");
                  }
                }}
                placeholder="0.00"
                style={{
                  width: "100%", textAlign: "right", fontSize: 20, fontWeight: 600,
                  color: "#1C1C1E", background: "transparent", border: "none",
                  outline: "none", fontFamily: font,
                }}
              />
              {selectedCoin && (
                <span style={{ fontSize: 12, fontWeight: 500, color: "rgba(60,60,67,0.3)", flexShrink: 0 }}>{selectedCoin.symbol}</span>
              )}
            </div>
          </div>
        </div>

        {/* Divider arrow + rate indicator */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", margin: "6px 0", gap: 8 }}>
          <button
            type="button"
            onClick={handleSwapCoins}
            disabled={!selectedCoin || !customerCoin}
            aria-label="Swap receive and pay currencies"
            title="Swap currencies"
            style={{
              width: 30,
              height: 30,
              borderRadius: "50%",
              background: selectedCoin && customerCoin ? "#FFFFFF" : "#F2F2F7",
              border: selectedCoin && customerCoin ? "1px solid rgba(0,209,160,0.28)" : "1px solid transparent",
              boxShadow: selectedCoin && customerCoin ? "0 2px 8px rgba(0,0,0,0.06)" : "none",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              cursor: selectedCoin && customerCoin ? "pointer" : "default",
              color: selectedCoin && customerCoin ? "#00A77F" : "rgba(60,60,67,0.45)",
            }}
          >
            {rateLoading ? (
              <div style={{ width: 12, height: 12, borderRadius: "50%", border: "2px solid rgba(0,200,83,0.2)", borderTopColor: "#00C853", animation: "spin 0.7s linear infinite" }} />
            ) : (
              <ArrowUpDown size={14} strokeWidth={2.4} />
            )}
          </button>
          {exchangeRate !== null && selectedCoin && customerCoin && selectedCoin.symbol !== customerCoin.symbol && (
            <span style={{ fontSize: 11, color: "rgba(60,60,67,0.4)", fontWeight: 500 }}>
              1 {selectedCoin.symbol} = {exchangeRate >= 1
                ? exchangeRate.toLocaleString(undefined, { maximumFractionDigits: 2 })
                : exchangeRate.toFixed(6)
              } {customerCoin.symbol}
            </span>
          )}
        </div>

        {/* Customer pays label */}
        <p style={{ fontSize: 10, fontWeight: 600, color: "rgba(60,60,67,0.35)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6, paddingLeft: 4 }}>
          Customer Pays{customerCoin ? ` · ${customerCoin.symbol}` : ""}
        </p>

        {/* Customer pays card */}
        <div className="serapay-payment-field" style={{ background: "#fff", borderRadius: 20, marginBottom: 20, overflow: "hidden", boxShadow: "0 1px 8px rgba(0,0,0,0.07)" }}>
          <div style={{ display: "flex", alignItems: "center", height: 62 }}>
            <button onClick={() => setShowCustomerCoinSheet(true)} style={{
              display: "flex", alignItems: "center", gap: 8,
              padding: "0 16px", height: "100%", background: "rgba(0,209,160,0.05)",
              border: "none", borderRight: "1px solid rgba(60,60,67,0.07)",
              cursor: "pointer", flexShrink: 0, minWidth: 140,
            }}>
              {customerCoin ? (
                <>
                  <TokenIcon symbol={customerCoin.symbol} size={24} />
                  <span style={{ fontSize: 14, fontWeight: 600, color: "#1C1C1E" }}>{customerCoin.symbol}</span>
                  <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="rgba(60,60,67,0.3)" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </>
              ) : (
                <span style={{ fontSize: 13, fontWeight: 500, color: "#1C1C1E" }}>Any coin</span>
              )}
            </button>
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6, padding: "0 16px" }}>
              {rateLoading ? (
                <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, justifyContent: "flex-end" }}>
                  <div style={{ width: 14, height: 14, borderRadius: "50%", border: "2px solid rgba(0,200,83,0.2)", borderTopColor: "#00C853", animation: "spin 0.7s linear infinite", flexShrink: 0 }} />
                  <span style={{ fontSize: 13, color: "rgba(60,60,67,0.35)", fontWeight: 500 }}>Calculating…</span>
                </div>
              ) : (
                <input
                  type="text"
                  inputMode="decimal"
                  value={customerAmount}
                  onChange={e => {
                    const val = limitDecimalPlaces(e.target.value);
                    setCustomerAmount(val);
                    setLastEdited("pay");
                    if (exchangeRate && val) {
                      const calc = parseFloat(val) / exchangeRate;
                      setAmount(isNaN(calc) ? "" : formatDecimalAmount(calc));
                    } else if (!val) {
                      setAmount("");
                    }
                  }}
                  placeholder="0.00"
                  style={{
                    width: "100%", textAlign: "right", fontSize: 20, fontWeight: 600,
                    color: "#1C1C1E", background: "transparent", border: "none",
                    outline: "none", fontFamily: font,
                  }}
                />
              )}
              {customerCoin && !rateLoading && (
                <span style={{ fontSize: 12, fontWeight: 500, color: "rgba(60,60,67,0.3)", flexShrink: 0 }}>{customerCoin.symbol}</span>
              )}
            </div>
          </div>
        </div>

        {/* Advanced Options */}
        <div style={{ marginBottom: 16 }}>
          <button
            onClick={() => setShowAdvanced(v => !v)}
            style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", cursor: "pointer", padding: "0 4px", marginBottom: showAdvanced ? 10 : 0 }}
          >
            <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="rgba(60,60,67,0.4)" strokeWidth={2.5} style={{ transform: showAdvanced ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
            <span style={{ fontSize: 11, fontWeight: 600, color: "rgba(60,60,67,0.4)", textTransform: "uppercase", letterSpacing: "0.1em" }}>Advanced Options</span>
          </button>
          {showAdvanced && (
            <div style={{ background: "#fff", borderRadius: 16, boxShadow: "0 1px 8px rgba(0,0,0,0.07)", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 14 }}>
              {/* Description */}
              <div>
                <p style={{ fontSize: 11, fontWeight: 600, color: "rgba(60,60,67,0.5)", textTransform: "uppercase", letterSpacing: "0.08em", margin: "0 0 8px" }}>Description (optional)</p>
                <div style={{ background: "rgba(0,0,0,0.04)", borderRadius: 10, overflow: "hidden" }}>
                  <input
                    type="text"
                    value={description}
                    onChange={e => setDescription(e.target.value.slice(0, 120))}
                    placeholder="e.g. Table 5 order, Invoice #1234…"
                    maxLength={120}
                    style={{ width: "100%", height: 40, padding: "0 12px", fontSize: 13, color: "#1C1C1E", background: "transparent", border: "none", outline: "none", boxSizing: "border-box" }}
                  />
                </div>
              </div>
              {/* Expiry */}
              <div>
                <p style={{ fontSize: 11, fontWeight: 600, color: "rgba(60,60,67,0.5)", textTransform: "uppercase", letterSpacing: "0.08em", margin: "0 0 8px" }}>Link Expiry</p>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {(["none", "15m", "1h", "24h", "7d"] as const).map(opt => (
                    <button
                      key={opt}
                      onClick={() => setExpiryOption(opt)}
                      style={{
                        height: 32, padding: "0 12px", borderRadius: 20, fontSize: 12, fontWeight: 600,
                        border: expiryOption === opt ? "none" : "1px solid rgba(0,0,0,0.1)",
                        background: expiryOption === opt ? "#00D1A0" : "transparent",
                        color: expiryOption === opt ? "#fff" : "rgba(60,60,67,0.6)",
                        cursor: "pointer", transition: "all 0.15s",
                      }}
                    >
                      {opt === "none" ? "No expiry" : opt === "15m" ? "15 min" : opt === "1h" ? "1 hour" : opt === "24h" ? "24 hours" : "7 days"}
                    </button>
                  ))}
                </div>
              </div>
              {/* Single-use */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div>
                  <p style={{ fontSize: 13, fontWeight: 600, color: "#1C1C1E", margin: 0 }}>Single-use link</p>
                  <p style={{ fontSize: 11, color: "rgba(60,60,67,0.5)", margin: "2px 0 0" }}>Link becomes invalid after one payment</p>
                </div>
                <button
                  onClick={() => setSingleUse(v => !v)}
                  style={{
                    width: 44, height: 26, borderRadius: 13, border: "none", cursor: "pointer",
                    background: singleUse ? "#00D1A0" : "rgba(0,0,0,0.12)",
                    position: "relative", transition: "background 0.2s", flexShrink: 0,
                  }}
                  aria-label={singleUse ? "Disable single-use" : "Enable single-use"}
                  role="switch"
                  aria-checked={singleUse}
                >
                  <span style={{
                    position: "absolute", top: 3, left: singleUse ? 21 : 3,
                    width: 20, height: 20, borderRadius: "50%", background: "#fff",
                    boxShadow: "0 1px 4px rgba(0,0,0,0.2)", transition: "left 0.2s",
                  }} />
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Generate QR button */}
        <button
          onClick={handleGenerateQR}
          disabled={!selectedCoin}
          className="serapay-action-primary serapay-shine-button"
          style={{
            width: "100%", height: 54, borderRadius: 16,
            background: selectedCoin
              ? "linear-gradient(135deg, #4ECE9A, #3AB882)"
              : "rgba(0,0,0,0.08)",
            border: "none",
            color: selectedCoin ? "#fff" : "rgba(60,60,67,0.3)",
            fontSize: 16, fontWeight: 700, cursor: selectedCoin ? "pointer" : "not-allowed",
            boxShadow: selectedCoin ? "0 4px 12px rgba(78,206,154,0.18)" : "none",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            transition: "all 0.2s",
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
          </svg>
          {!selectedCoin ? "Select a coin first" : "Generate QR"}
        </button>

        {/* Info strip */}
        <div style={{ marginTop: 20, background: "#F4FBF8", borderRadius: 14, padding: "12px 14px", border: "1px solid rgba(78,206,154,0.2)" }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3EBE8A" strokeWidth="2.5" style={{ marginTop: 1, flexShrink: 0 }}>
              <circle cx="12" cy="12" r="10" /><path strokeLinecap="round" d="M12 8v4m0 4h.01" />
            </svg>
            <p style={{ fontSize: 12, color: "#3A5A52", margin: 0, lineHeight: 1.5 }}>
              Share the QR code or payment link with your customer. They can pay with any stablecoin — you receive your chosen currency.
            </p>
          </div>
        </div>

        {/* Transaction History */}
        {merchantApiKey && <TransactionHistory apiKey={merchantApiKey} chainId={paymentChainId} />}
      </div>

      {/* Coin sheet */}
      {showCoinSheet && (
        <CoinSheet
          title="Receive In"
          onClose={() => setShowCoinSheet(false)}
          onSelect={setSelectedCoin}
          selectedSymbol={selectedCoin?.symbol}
        />
      )}

      {/* Customer coin sheet */}
      {showCustomerCoinSheet && (
        <CoinSheet
          title="Customer Pays In"
          onClose={() => setShowCustomerCoinSheet(false)}
          onSelect={setCustomerCoin}
          selectedSymbol={customerCoin?.symbol}
        />
      )}

      {/* Settings modal */}
      {showSettings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          walletAddress={walletAddress}
          apiKey={merchantApiKey}
          initialName={merchantName}
          onNameSaved={handleNameSaved}
          initialLogo={localLogoData || merchantProfile?.logoData || ""}
          onLogoSaved={(logo) => { setLocalLogoData(logo); queryClient.invalidateQueries({ queryKey: ["/merchant/profile"] }); }}
          qrFgColor={localQrFgColor || merchantProfile?.qrFgColor || "#000000"}
          qrBgColor={localQrBgColor || merchantProfile?.qrBgColor || "#ffffff"}
          qrStyle={localQrStyle || merchantProfile?.qrStyle || "rounded"}
          qrMode={localQrMode || merchantProfile?.qrMode || "standard"}
          onQrPrefsSaved={(fg, bg, style, mode) => { setLocalQrFgColor(fg); setLocalQrBgColor(bg); setLocalQrStyle(style); setLocalQrMode(mode); }}
          accountError={accountSetupError}
          accountLoading={accountSetupLoading}
          onRetryAccount={retryAccountSetup}
        />
      )}

      {showGuestReceiverModal ? (
        <GuestReceiverModal
          onClose={() => setShowGuestReceiverModal(false)}
          onSubmitAddress={handleGuestReceiverSubmit}
          onConnect={openLoginMethods}
          onSeraLogin={openSeraLogin}
        />
      ) : null}

      <style>{`@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');`}</style>
    </div>
  );
}
