import React, { useState } from "react";
import { Link, useLocation } from "wouter";
import { LayoutDashboard, Receipt, Settings, LogOut, Menu, X, Code2, ChevronLeft, ChevronRight, QrCode, UtensilsCrossed, ChevronDown, Copy, Check, WalletCards } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { cn, shortenAddress } from "@/lib/dashboard-utils";
import { useMerchantProfile } from "@/hooks/use-merchant";
import { useEvents } from "@/hooks/use-events";
import { motion, AnimatePresence } from "framer-motion";
import { SeraLogo } from "@/components/SeraPayHeader";
import { NetworkModeButton, NetworkSwitcherModal, useActiveNetworkMode } from "@/components/NetworkSwitcher";

const navItems = [
  { name: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { name: "Wallets", href: "/wallets", icon: WalletCards },
  { name: "Transactions", href: "/transactions", icon: Receipt },
  { name: "Menu", href: "/menu-manager/pos", icon: UtensilsCrossed },
  { name: "Settings", href: "/settings", icon: Settings },
  { name: "Developer", href: "/developer", icon: Code2 },
];

const LS_SIDEBAR = "serapay_sidebar_collapsed";

// ── Wallet Dropdown ──────────────────────────────────────────────────────────
function WalletDropdown({ address, onLogout }: { address: string; onLogout: () => void }) {
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
              <Link
                href="/"
                onClick={() => setOpen(false)}
                className="flex min-h-[52px] w-full items-center justify-center gap-2.5 border-b border-border px-4 text-sm font-medium text-foreground transition-colors hover:bg-[#F4FFFA]"
              >
                <QrCode className="w-4 h-4 text-muted-foreground" />
                Generate Payment QR
              </Link>
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
export function AppLayout({ children, pendingCount = 0, noPadding = false }: { children: React.ReactNode; pendingCount?: number; noPadding?: boolean }) {
  const { logout, walletAddress, apiKey, isAuthenticated, isLoading, login, retry, error } = useAuth();
  const [location] = useLocation();
  const { data: profile } = useMerchantProfile();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = React.useState(false);
  const [collapsed, setCollapsed] = React.useState(() => {
    try { return localStorage.getItem(LS_SIDEBAR) === "1"; } catch { return false; }
  });
  const [showNetworkModal, setShowNetworkModal] = useState(false);

  const { activeMode, networkInfo } = useActiveNetworkMode();

  useEvents();

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
          <Link
            href="/"
            className={cn(
              "flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-semibold transition-colors overflow-hidden mb-1",
              collapsed ? "justify-center px-2" : "",
              "serapay-green-button bg-gradient-to-r from-[#00D1A0] to-[#00B88A] text-white shadow-sm"
            )}
            title={collapsed ? "New Payment" : undefined}
          >
            <QrCode className="w-4 h-4 shrink-0" />
            {!collapsed && <span className="whitespace-nowrap">New Payment</span>}
          </Link>
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
                <Link
                  href="/"
                  onClick={() => setIsMobileMenuOpen(false)}
                  className="serapay-green-button flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-semibold bg-gradient-to-r from-[#00D1A0] to-[#00B88A] text-white mb-1"
                >
                  <QrCode className="w-4 h-4" />
                  New Payment
                </Link>
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
          <WalletDropdown address={displayAddress} onLogout={logout} />
        </header>
        <div className={noPadding ? "flex-1 min-h-0 flex flex-col overflow-hidden" : "p-4 md:p-6 flex-1 min-h-0 overflow-y-auto w-full max-w-6xl mx-auto"}>
          {children}
        </div>
      </main>

      {/* Network switcher modal */}
      {showNetworkModal && <NetworkSwitcherModal onClose={() => setShowNetworkModal(false)} />}
    </div>
  );
}
