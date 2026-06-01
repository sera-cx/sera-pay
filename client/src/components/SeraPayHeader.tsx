import React, { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { Check, ChevronDown, Copy, LayoutDashboard, LogOut, QrCode, ArrowLeft } from "lucide-react";

export const SERAPAY_LOGO_URL = "/icon-512.png";
const font = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Inter', sans-serif";

export function SeraLogo({ size = 32 }: { size?: number }) {
  const logoHeight = size;
  const logoWidth = size;
  return (
    <img
      src={SERAPAY_LOGO_URL}
      alt="SeraPay"
      style={{ height: logoHeight, width: logoWidth, objectFit: "contain", display: "block", flexShrink: 0 }}
    />
  );
}

function shortenAddress(address: string) {
  if (!address) return "";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

type HeaderAction = {
  label: string;
  onClick: () => void;
};

type SeraPayHeaderProps = {
  walletAddress?: string;
  maxWidth?: number;
  dashboardAction?: HeaderAction;
  disconnectAction?: HeaderAction;
  primaryAction?: HeaderAction;
  backAction?: HeaderAction;
  centerContent?: React.ReactNode;
  rightContent?: React.ReactNode;
  beforeWalletContent?: React.ReactNode;
  afterLogoContent?: React.ReactNode;
  compact?: boolean;
  homeHeader?: boolean;
};

export function SeraPayHeader({
  walletAddress = "",
  maxWidth = 520,
  dashboardAction,
  disconnectAction,
  primaryAction,
  backAction,
  centerContent,
  rightContent,
  beforeWalletContent,
  afterLogoContent,
  compact = false,
  homeHeader = false,
}: SeraPayHeaderProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      if (!dropdownRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown, { passive: true });
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const copyAddress = async () => {
    if (!walletAddress) return;
    try {
      await navigator.clipboard.writeText(walletAddress);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {}
  };

  return (
    <header
      style={{
        position: "sticky",
        top: 0,
        zIndex: 30,
        background: homeHeader ? "#F2FAF6" : "rgba(255,255,255,0.82)",
        backdropFilter: homeHeader ? "none" : "blur(18px)",
        borderBottom: homeHeader ? "1px solid rgba(242,250,246,0)" : "1px solid rgba(10,31,26,0.06)",
        fontFamily: font,
      }}
    >
      <div
        style={{
          maxWidth,
          margin: "0 auto",
          padding: homeHeader ? "8px 16px" : compact ? "10px 16px" : "12px 18px",
          minHeight: homeHeader ? 48 : compact ? 52 : 58,
          display: centerContent ? "grid" : "flex",
          gridTemplateColumns: centerContent ? "minmax(0, 1fr) auto minmax(0, 1fr)" : undefined,
          alignItems: "center",
          justifyContent: centerContent ? undefined : "space-between",
          gap: 12,
          boxSizing: "border-box",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          {backAction ? (
            <button
              onClick={backAction.onClick}
              aria-label={backAction.label}
              style={{
                width: 36,
                height: 36,
                borderRadius: "50%",
                border: "1px solid rgba(10,31,26,0.08)",
                background: "#fff",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                color: "#14342B",
                boxShadow: "0 4px 14px rgba(10,31,26,0.05)",
              }}
            >
              <ArrowLeft size={16} />
            </button>
          ) : null}
          <Link href="/" style={{ display: "flex", alignItems: "center", textDecoration: "none" }}>
            <SeraLogo size={homeHeader ? 25 : compact ? 28 : 32} />
          </Link>
          {afterLogoContent ? <div style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>{afterLogoContent}</div> : null}
        </div>

        {centerContent ? <div style={{ minWidth: 0, justifySelf: "center" }}>{centerContent}</div> : null}

        <div style={{ justifySelf: centerContent ? "end" : undefined, display: "flex", alignItems: "center", justifyContent: "flex-end", gap: beforeWalletContent ? 8 : 0, minWidth: 0 }}>
        {beforeWalletContent ? beforeWalletContent : null}
        {rightContent ? (
          rightContent
        ) : walletAddress ? (
          <div ref={dropdownRef} style={{ position: "relative", flexShrink: 0 }}>
            <button
              onClick={() => setOpen(value => !value)}
              aria-expanded={open}
              style={{
                height: 36,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 7,
                border: "1px solid rgba(10,31,26,0.06)",
                borderRadius: 999,
                background: "#F4F5F8",
                color: "#0A1F1A",
                padding: "0 12px",
                cursor: "pointer",
                boxShadow: "0 1px 0 rgba(255,255,255,0.8) inset",
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#00D1A0", flexShrink: 0 }} />
              <span style={{ fontSize: 13, fontWeight: 700, lineHeight: 1 }}>{shortenAddress(walletAddress)}</span>
              <ChevronDown size={13} style={{ color: "rgba(60,60,67,0.5)", transform: open ? "rotate(180deg)" : "none", transition: "transform 160ms" }} />
            </button>

            {open ? (
              <div
                style={{
                  position: "absolute",
                  right: 0,
                  top: "calc(100% + 10px)",
                  width: "min(270px, calc(100vw - 24px))",
                  borderRadius: 18,
                  background: "#fff",
                  border: "1px solid rgba(10,31,26,0.08)",
                  boxShadow: "0 18px 48px rgba(10,31,26,0.16)",
                  overflow: "hidden",
                }}
              >
                <div style={{ padding: "14px 16px", borderBottom: "1px solid rgba(10,31,26,0.06)" }}>
                  <p style={{ margin: "0 0 6px", fontSize: 11, fontWeight: 700, color: "rgba(60,60,67,0.45)", letterSpacing: "0.06em", textTransform: "uppercase" }}>Connected wallet</p>
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                    <p style={{ margin: 0, flex: 1, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, lineHeight: 1.55, color: "#14342B", wordBreak: "break-all" }}>{walletAddress}</p>
                    <button
                      onClick={copyAddress}
                      aria-label="Copy wallet address"
                      style={{
                        width: 30,
                        height: 30,
                        borderRadius: 10,
                        border: "none",
                        background: "#F4F5F8",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        cursor: "pointer",
                        color: copied ? "#00A87A" : "rgba(60,60,67,0.55)",
                        flexShrink: 0,
                      }}
                    >
                      {copied ? <Check size={14} /> : <Copy size={14} />}
                    </button>
                  </div>
                </div>

                {dashboardAction ? (
                  <button
                    onClick={() => { setOpen(false); dashboardAction.onClick(); }}
                    style={{
                      width: "100%",
                      minHeight: 52,
                      padding: "0 16px",
                      border: "none",
                      borderBottom: "1px solid rgba(10,31,26,0.06)",
                      background: "#fff",
                      color: "#0A1F1A",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 9,
                      fontSize: 15,
                      fontWeight: 650,
                      cursor: "pointer",
                    }}
                  >
                    <LayoutDashboard size={16} />
                    {dashboardAction.label}
                  </button>
                ) : null}

                {disconnectAction ? (
                  <button
                    onClick={() => { setOpen(false); disconnectAction.onClick(); }}
                    style={{
                      width: "100%",
                      minHeight: 52,
                      padding: "0 16px",
                      border: "none",
                      background: "#fff",
                      color: "#FF3B30",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 9,
                      fontSize: 15,
                      fontWeight: 700,
                      cursor: "pointer",
                    }}
                  >
                    <LogOut size={16} />
                    {disconnectAction.label}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : primaryAction ? (
          <button
            onClick={primaryAction.onClick}
            className="serapay-green-button"
            style={{
              height: homeHeader ? 32 : 38,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: homeHeader ? 6 : 8,
              border: "none",
              borderRadius: 999,
              padding: homeHeader ? "0 13px" : "0 16px",
              background: "linear-gradient(135deg, #00C896, #00A87A, #008A64)",
              color: "#fff",
              fontSize: homeHeader ? 12 : 13,
              fontWeight: 750,
              cursor: "pointer",
              boxShadow: homeHeader ? "0 8px 18px rgba(0,168,85,0.18)" : "0 10px 24px rgba(0,168,85,0.22)",
            }}
          >
            <QrCode size={homeHeader ? 13 : 15} />
            {primaryAction.label}
          </button>
        ) : null}
        </div>
      </div>
    </header>
  );
}
