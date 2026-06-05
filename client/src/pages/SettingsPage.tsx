import React, { useState, useEffect, useRef } from "react";
import { AppLayout } from "@/components/AppLayout";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, Label, Input, Button, Skeleton } from "@/components/dashboard-ui";
import { useMerchantProfile, useUpdateProfile } from "@/hooks/use-merchant";
import { useToast } from "@/components/toast-system";
import { Save, ImageIcon, Upload, X, QrCode, Coins, Search, Check, CheckCircle2, ChevronDown, ChevronUp } from "lucide-react";
import { QRStyled, QR_STYLES, type QrMode, type QrStyle } from "@/components/QRStyled";
import { prepareImageForUpload } from "@/lib/imageUpload";
import { groupCurrenciesByRegion, loadSeraCurrencies, type SeraCurrency } from "@/lib/currencyCalculator";
import { buildClientAppUrl } from "@/lib/app-url";
import { resolvePaymentChainId, TEST_PAYMENT_CHAIN_ID } from "@/lib/payment";
import { useSeraApiConfig } from "@/hooks/use-gateway";
import { useChainId } from "wagmi";

const LS_LOGO = "serapay_store_logo";
type CurrencyGroup = { region: string; coins: SeraCurrency[] };
const SETTINGS_QR_STYLES = QR_STYLES.filter((styleOption) => styleOption.id !== "classy");
const SETTINGS_QR_STYLE_IDS = new Set(QR_STYLES.map((styleOption) => styleOption.id));

function normalizeSettingsQrStyle(value: string | null | undefined, fallback: QrStyle = "rounded"): QrStyle {
  if (value === "classy") return "classy-rounded";
  return SETTINGS_QR_STYLE_IDS.has(value as QrStyle) ? (value as QrStyle) : fallback;
}

function normalizeSettingsQrMode(value: string | null | undefined): QrMode {
  return value === "advanced" ? "advanced" : "standard";
}

function CurrencyMark({ coin, fallbackSymbol, className = "w-7 h-7" }: { coin?: Pick<SeraCurrency, "symbol" | "icon" | "logoUri">; fallbackSymbol?: string; className?: string }) {
  const label = (coin?.symbol || fallbackSymbol || "?").slice(0, 4).toUpperCase();
  if (coin?.logoUri) {
    return <img src={coin.logoUri} alt={`${coin.symbol} logo`} className={`${className} rounded-full object-contain bg-white border border-border/40`} />;
  }
  return (
    <span className={`${className} rounded-full bg-muted border border-border/40 flex items-center justify-center text-[10px] font-bold text-muted-foreground leading-none`}>
      {coin?.icon || label.slice(0, 2)}
    </span>
  );
}

function toCurrencyGroups(currencies: SeraCurrency[]): CurrencyGroup[] {
  const grouped = groupCurrenciesByRegion(currencies);
  return Object.entries(grouped).map(([region, coins]) => ({ region, coins }));
}

/* ── Thermal receipt preview (matches actual jsPDF output) ── */
function ReceiptPreview({
  storeName,
  storeAddress,
  logoUrl,
  receiveCoin,
  walletAddress,
  networkName,
}: {
  storeName: string;
  storeAddress: string;
  logoUrl: string;
  receiveCoin: string;
  walletAddress?: string;
  networkName: string;
}) {
  const now = new Date();
  const invoiceId = `SP-${now.toISOString().slice(0,10).replace(/-/g,"")}-AB56C7`;
  const dateStr = now.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const timeStr = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const coin = receiveCoin || "USDT";
  const fakeTx = "0xdd220ba4c3cf0e0cf565f861abb4d8ce38ad9a1b595c49c385a21df42f1bce52";
  const addrDisplay = walletAddress
    ? `${walletAddress.slice(0,6)}...${walletAddress.slice(-4)}`
    : "0x1A2B...cd3E";

  const mono: React.CSSProperties = { fontFamily: "'Courier New', Courier, monospace" };
  const sans: React.CSSProperties = { fontFamily: "Helvetica, Arial, sans-serif" };
  const row = (label: string, value: string, valueColor = "#1C1C1E", bold = false): React.ReactNode => (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 3 }}>
      <span style={{ ...sans, fontSize: 8, color: "#374151" }}>{label}</span>
      <span style={{ ...sans, fontSize: 8, fontWeight: bold ? "bold" : "normal", color: valueColor }}>{value}</span>
    </div>
  );

  return (
    <div style={{ width: 252, background: "#fff", border: "1px solid #E5E7EB", borderRadius: 8, overflow: "hidden", boxShadow: "0 2px 8px rgba(0,0,0,0.08)" }}>

      {/* ── Green header bar ── */}
      <div style={{ background: "#00D1A0", padding: "7px 0", textAlign: "center" }}>
        <span style={{ ...sans, color: "#fff", fontSize: 7.5, fontWeight: "bold", letterSpacing: 1.5 }}>
          SERAPAY · PAYMENT RECEIPT
        </span>
      </div>

      {/* ── Logo + Merchant info ── */}
      <div style={{ textAlign: "center", padding: "12px 14px 8px" }}>
        {logoUrl
          ? <img src={logoUrl} alt="logo" style={{ width: 38, height: 38, borderRadius: 6, margin: "0 auto 7px", display: "block", objectFit: "contain" }} />
          : <div style={{ width: 38, height: 38, borderRadius: 6, background: "linear-gradient(135deg,#00D1A0,#00B88A)", margin: "0 auto 7px", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <span style={{ ...sans, color: "#fff", fontSize: 16, fontWeight: "bold" }}>{(storeName || "S").slice(0,1).toUpperCase()}</span>
            </div>
        }
        <div style={{ ...sans, fontSize: 12, fontWeight: "bold", color: "#0A1F1A" }}>{storeName || "Your Store Name"}</div>
        {storeAddress && <div style={{ ...sans, fontSize: 8, color: "#6B7280", marginTop: 2 }}>{storeAddress}</div>}
        <div style={{ ...mono, fontSize: 7, color: "#9CA3AF", marginTop: 3 }}>Wallet: {addrDisplay}</div>
      </div>

      {/* ── Dashed divider ── */}
      <div style={{ borderTop: "1px dashed #D1D5DB", margin: "0 10px" }} />

      {/* ── Invoice meta ── */}
      <div style={{ textAlign: "center", padding: "6px 14px" }}>
        <div style={{ ...sans, fontSize: 7, color: "#9CA3AF", letterSpacing: 1, textTransform: "uppercase", fontWeight: "bold" }}>
          INVOICE {invoiceId}
        </div>
        <div style={{ ...sans, fontSize: 8.5, color: "#374151", marginTop: 3 }}>{dateStr}</div>
        <div style={{ ...sans, fontSize: 7.5, color: "#6B7280", marginTop: 1 }}>{timeStr}</div>
      </div>

      {/* ── Solid divider ── */}
      <div style={{ borderTop: "1px solid #E5E7EB", margin: "0 10px" }} />

      {/* ── Currency Conversion box ── */}
      <div style={{ margin: "8px 10px 0", background: "#F0FAF6", border: "1px solid #00795C", borderRadius: 4, padding: "6px 8px" }}>
        <div style={{ ...sans, fontSize: 7.5, fontWeight: "bold", color: "#00795C", marginBottom: 5 }}>Currency Conversion</div>
        {row("Customer Paid:", `16.25 QCAD`, "#1C1C1E", true)}
        {row("Merchant Receives:", `10.00 ${coin}`, "#1C1C1E", true)}
        {row("Rate:", `1 ${coin} = 1.625 QCAD`, "#6B7280")}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span style={{ ...sans, fontSize: 8, color: "#374151" }}>Conversion Fee:</span>
          <span style={{ ...sans, fontSize: 8, fontWeight: "bold", color: "#00795C" }}>$0.00 (0%)</span>
        </div>
      </div>

      {/* ── Network info ── */}
      <div style={{ ...sans, textAlign: "center", padding: "6px 14px 4px", fontSize: 7, color: "#9CA3AF" }}>
        Network: {networkName} · SeraPay Fee: $0.00
      </div>

      {/* ── TX hash ── */}
      <div style={{ margin: "0 10px 8px" }}>
        <div style={{ ...sans, fontSize: 6.5, fontWeight: "bold", color: "#828C96", marginBottom: 3 }}>Transaction Hash</div>
        <div style={{ ...mono, fontSize: 5.8, color: "#323C46", wordBreak: "break-all", lineHeight: 1.4 }}>{fakeTx}</div>
        <div style={{ ...sans, fontSize: 7, fontWeight: "bold", color: "#00A37D", marginTop: 4, textAlign: "right" }}>View on Etherscan »</div>
      </div>

      {/* ── Dashed divider ── */}
      <div style={{ borderTop: "1px dashed #D1D5DB", margin: "0 10px" }} />

      {/* ── Footer ── */}
      <div style={{ textAlign: "center", padding: "9px 14px 11px" }}>
        <div style={{ ...sans, fontSize: 8.5, color: "#374151" }}>Thank you for your purchase!</div>
        <div style={{ ...sans, fontSize: 8.5, fontWeight: "bold", color: "#00795C", marginTop: 3 }}>Powered by SeraPay · Sera Protocol</div>
        <div style={{ ...sans, fontSize: 7.5, color: "#9CA3AF", marginTop: 2 }}>Zero fees · Instant settlement · Self-custody</div>
      </div>
    </div>
  );
}

/* ── IP Allowlist Editor ── */
function IpAllowlistEditor() {
  const { data: profile } = useMerchantProfile();
  const updateProfile = useUpdateProfile();
  const { toast } = useToast();
  const [ips, setIps] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    const stored = (profile as any)?.ipAllowlist;
    if (stored) {
      try {
        const parsed = typeof stored === "string" ? JSON.parse(stored) : stored;
        if (Array.isArray(parsed)) setIps(parsed);
      } catch {}
    }
  }, [profile]);

  const addIp = () => {
    const trimmed = input.trim();
    if (!trimmed) return;
    // Basic IPv4/IPv6/CIDR validation
    const ipv4 = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/;
    const ipv6 = /^[0-9a-fA-F:]+(\/\d{1,3})?$/;
    if (!ipv4.test(trimmed) && !ipv6.test(trimmed)) {
      toast({ title: "Invalid IP address", description: "Enter a valid IPv4, IPv6, or CIDR range", type: "error" });
      return;
    }
    if (ips.includes(trimmed)) {
      toast({ title: "Already added", type: "error" }); return;
    }
    setIps(prev => [...prev, trimmed]);
    setInput("");
    setDirty(true);
  };

  const removeIp = (ip: string) => {
    setIps(prev => prev.filter(x => x !== ip));
    setDirty(true);
  };

  const save = () => {
    updateProfile.mutate({ ipAllowlist: JSON.stringify(ips) } as any, {
      onSuccess: () => { toast({ title: "IP allowlist saved", type: "success" }); setDirty(false); },
      onError: (err: any) => toast({ title: "Save failed", description: err.message, type: "error" }),
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === "Enter" && addIp()}
          placeholder="e.g. 203.0.113.0/24 or 2001:db8::1"
          className="flex-1 text-sm"
        />
        <Button type="button" onClick={addIp} size="sm" className="bg-gradient-to-r from-[#00D1A0] to-[#00B88A] text-white border-0">
          Add
        </Button>
      </div>
      {ips.length === 0 ? (
        <p className="text-xs text-muted-foreground">No IPs added — all IPs are allowed.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {ips.map(ip => (
            <span key={ip} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-muted text-xs font-mono">
              {ip}
              <button onClick={() => removeIp(ip)} className="w-6 h-6 -m-1 flex items-center justify-center text-muted-foreground hover:text-destructive transition-colors" aria-label={`Remove ${ip}`}>
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      {dirty && (
        <Button type="button" onClick={save} disabled={updateProfile.isPending} size="sm" className="bg-gradient-to-r from-[#00D1A0] to-[#00B88A] text-white border-0">
          <Save className="w-3.5 h-3.5 mr-1.5" />
          {updateProfile.isPending ? "Saving..." : "Save Allowlist"}
        </Button>
      )}
    </div>
  );
}

export function Settings() {
  const { data: profile, isLoading } = useMerchantProfile();
  const walletChainId = useChainId();
  const { data: seraConfig } = useSeraApiConfig();
  const paymentChainId = resolvePaymentChainId(walletChainId, seraConfig?.mode);
  const paymentNetworkName = paymentChainId === TEST_PAYMENT_CHAIN_ID ? "Ethereum Sepolia" : "Ethereum";
  const updateProfile = useUpdateProfile();
  const { toast } = useToast();

  const [storeName, setStoreName] = useState("");
  const [storeDescription, setStoreDescription] = useState("");
  const [storeAddress, setStoreAddress] = useState("");
  const [logoUrl, setLogoUrl] = useState(() => localStorage.getItem(LS_LOGO) || "");
  const [qrStyle, setQrStyle] = useState<QrStyle>("rounded");
  const [qrFgColor, setQrFgColor] = useState("#000000");
  const [qrBgColor, setQrBgColor] = useState("#ffffff");
  const [qrMode, setQrMode] = useState<QrMode>("standard");
  const [receiveCoin, setReceiveCoin] = useState("");
  const [coinSearch, setCoinSearch] = useState("");
  const [coinExpanded, setCoinExpanded] = useState(false);
  const [currencies, setCurrencies] = useState<SeraCurrency[]>([]);
  const [currencyGroups, setCurrencyGroups] = useState<CurrencyGroup[]>([]);
  const [currencyLoading, setCurrencyLoading] = useState(true);
  const [previewTab, setPreviewTab] = useState<"qr" | "receipt">("qr");
  const [receiptZoomOpen, setReceiptZoomOpen] = useState(false);
  const [receiptZoom, setReceiptZoom] = useState(1);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    setCurrencyLoading(true);
    loadSeraCurrencies(paymentChainId)
      .then((loaded) => {
        if (!active) return;
        setCurrencies(loaded);
        setCurrencyGroups(toCurrencyGroups(loaded));
        setReceiveCoin((current) => current || loaded.find((coin) => coin.symbol === "USDT")?.symbol || loaded[0]?.symbol || "");
      })
      .catch(() => {
        if (!active) return;
        setCurrencies([]);
        setCurrencyGroups([]);
      })
      .finally(() => {
        if (active) setCurrencyLoading(false);
      });
    return () => { active = false; };
  }, [paymentChainId]);

  useEffect(() => {
    if (profile) {
      setStoreName(profile.name || "");
      setStoreDescription((profile as any).description || "");
      if ((profile as any).qrStyle) setQrStyle(normalizeSettingsQrStyle((profile as any).qrStyle));
      if ((profile as any).qrFgColor) setQrFgColor((profile as any).qrFgColor);
      if ((profile as any).qrBgColor) setQrBgColor((profile as any).qrBgColor);
      if ((profile as any).qrMode) setQrMode(normalizeSettingsQrMode((profile as any).qrMode));
      const profileLogo = typeof (profile as any).logoData === "string" ? (profile as any).logoData : "";
      if (profileLogo) {
        setLogoUrl(profileLogo);
        try { localStorage.setItem(LS_LOGO, profileLogo); } catch {}
      }
      if ((profile as any).receiveCoin) setReceiveCoin((profile as any).receiveCoin);
      if ((profile as any).storeAddress) setStoreAddress((profile as any).storeAddress);
    }
  }, [profile]);

  const handleStyleChange = (s: QrStyle) => {
    setQrStyle(s);
    updateProfile.mutate({ qrStyle: s } as any);
  };

  const handleFgColorChange = (c: string) => {
    setQrFgColor(c);
    updateProfile.mutate({ qrFgColor: c } as any);
  };

  const handleBgColorChange = (c: string) => {
    setQrBgColor(c);
    updateProfile.mutate({ qrBgColor: c } as any);
  };

  const handleQrModeChange = (mode: QrMode) => {
    setQrMode(mode);
    updateProfile.mutate({ qrMode: mode } as any);
  };

  const handleSaveStoreInfo = (e: React.FormEvent) => {
    e.preventDefault();
    const nextName = storeName.trim();
    const nextAddress = storeAddress.trim();
    if (!nextName) {
      toast({ title: "Store name is required", description: "Enter the name shown to customers.", type: "error" });
      return;
    }
    updateProfile.mutate({ name: nextName, description: storeDescription.trim(), storeAddress: nextAddress } as any, {
      onSuccess: () => toast({ title: "Store info updated", type: "success" }),
      onError: (err: any) => toast({ title: "Update failed", description: err.message, type: "error" }),
    });
  };

  const handleSaveReceiveCoin = () => {
    updateProfile.mutate({ receiveCoin } as any, {
      onSuccess: () => toast({ title: "Preferred coin saved", type: "success" }),
      onError: (err: any) => toast({ title: "Update failed", description: err.message, type: "error" }),
    });
  };

  const handleLogoFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const prepared = await prepareImageForUpload(file, { maxDimension: 1024, quality: 0.88 });
      setLogoUrl(prepared.dataUrl);
      try { localStorage.setItem(LS_LOGO, prepared.dataUrl); } catch {}
      updateProfile.mutate({ logoData: prepared.dataUrl });
      toast({ title: "Logo saved", description: `Optimised to ${prepared.width}×${prepared.height}`, type: "success" });
    } catch (error: any) {
      toast({ title: "Logo upload failed", description: error.message || "Use a PNG, JPG, or WebP up to 10 MB", type: "error" });
    } finally {
      e.target.value = "";
    }
  };

  const removeLogo = () => {
    setLogoUrl("");
    localStorage.removeItem(LS_LOGO);
    updateProfile.mutate({ logoData: null });
  };

  const normalizedCoinSearch = coinSearch.trim().toLowerCase();
  const filteredGroups = normalizedCoinSearch
    ? [{ region: "Results", coins: currencies.filter(c =>
        c.symbol.toLowerCase().includes(normalizedCoinSearch) ||
        c.name.toLowerCase().includes(normalizedCoinSearch) ||
        c.currency.toLowerCase().includes(normalizedCoinSearch)
      ) }]
    : currencyGroups;

  const selectedCoinInfo = currencies.find(c => c.symbol === receiveCoin);

  return (
    <AppLayout noPadding>
      {/* Two-column layout: left = form cards, right = live preview */}
      <div className="h-full min-h-0 overflow-y-auto overscroll-contain p-4 md:p-6">
      <div className="flex w-full max-w-5xl mx-auto flex-col lg:flex-row gap-6 items-start">

        {/* ── Left column: form cards ── */}
        <div className="flex-1 min-w-0 space-y-5">
          <div>
            <h1 className="text-xl font-semibold tracking-tight mb-0.5">Settings</h1>
            <p className="text-muted-foreground text-sm">Customise your store identity and payment QR</p>
          </div>

          {/* ── 1. Store Identity ── */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Store Identity</CardTitle>
              <CardDescription>Your branding shown to customers on the payment page and receipt.</CardDescription>
            </CardHeader>
            <CardContent>
              {isLoading ? <Skeleton className="h-28 w-full" /> : (
                <form onSubmit={handleSaveStoreInfo} className="space-y-4">
                  <div className="flex flex-col sm:flex-row gap-4 items-start">
                    <div className="relative shrink-0 group">
                      <div className="w-20 h-20 rounded-2xl border-2 border-dashed border-border overflow-hidden bg-muted/20 flex items-center justify-center">
                        {logoUrl
                          ? <img src={logoUrl} alt="Store logo" className="w-full h-full object-contain" />
                          : <ImageIcon className="w-6 h-6 text-muted-foreground/40" />
                        }
                      </div>
                      <button
                        type="button"
                        onClick={() => fileRef.current?.click()}
                        className="absolute inset-0 rounded-2xl bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity"
                      >
                        <Upload className="w-5 h-5 text-white" />
                      </button>
                      {logoUrl && (
                        <button
                          type="button"
                          onClick={removeLogo}
                          className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-red-500 text-white flex items-center justify-center hover:bg-red-600 transition-colors"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      )}
                      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={handleLogoFile} />
                    </div>

                    <div className="flex-1 space-y-3 min-w-0">
                      <div className="space-y-1">
                        <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Store Name</Label>
                        <Input
                          value={storeName}
                          onChange={e => setStoreName(e.target.value)}
                          placeholder="My Awesome Store"
                          required
                          maxLength={120}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Store Address</Label>
                        <Input
                          value={storeAddress}
                          onChange={e => setStoreAddress(e.target.value)}
                          placeholder="123 Main St, City, Country"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Merchant Description</Label>
                        <textarea
                          value={storeDescription}
                          onChange={e => setStoreDescription(e.target.value.slice(0, 500))}
                          placeholder="Short intro shown before customers start ordering"
                          rows={3}
                          className="min-h-[76px] w-full resize-none rounded-xl border border-border bg-background px-3 py-2 text-sm transition-all duration-200 ease-in-out placeholder:text-muted-foreground focus-visible:border-[#00C853] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C853]/20"
                        />
                      </div>
                    </div>
                  </div>

                  <Button
                    type="submit"
                    disabled={updateProfile.isPending}
                    size="sm"
                    className="bg-gradient-to-r from-[#00D1A0] to-[#00B88A] hover:from-[#00C196] hover:to-[#00A87E] text-white border-0"
                  >
                    <Save className="w-3.5 h-3.5 mr-1.5" />
                    {updateProfile.isPending ? "Saving..." : "Save Changes"}
                  </Button>
                </form>
              )}
            </CardContent>
          </Card>

          {/* ── 2. Preferred Receive Coin ── */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Coins className="w-4 h-4 text-[#00D1A0]" />
                    Preferred Receive Coin
                  </CardTitle>
                  <CardDescription className="mt-0.5">The stablecoin you want to receive. Pre-selected for your customers.</CardDescription>
                </div>
                {receiveCoin && (
                  <div className="flex items-center gap-1.5 bg-[#F0FAF6] border border-[#00D1A0]/30 rounded-lg px-2.5 py-1.5 shrink-0">
                    <CurrencyMark coin={selectedCoinInfo} fallbackSymbol={receiveCoin} className="w-5 h-5" />
                    <span className="text-sm font-bold text-[#00795C]">{receiveCoin}</span>
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {isLoading || currencyLoading ? <Skeleton className="h-20 w-full" /> : (
                <div className="space-y-3">
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                    <Input
                      value={coinSearch}
                      onChange={e => setCoinSearch(e.target.value)}
                      placeholder="Search currency..."
                      className="pl-8 h-8 text-sm"
                    />
                  </div>

                  <div className={`space-y-3 overflow-y-auto transition-[max-height] duration-200 ${coinExpanded ? "max-h-[26rem]" : "max-h-40"} pr-0.5`}>
                    {filteredGroups.map(group => (
                      <div key={group.region}>
                        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 px-0.5">{group.region}</p>
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                          {group.coins.map(coin => (
                            <button
                              key={coin.symbol}
                              type="button"
                              onClick={() => setReceiveCoin(coin.symbol)}
                              className={`min-h-[56px] flex items-center gap-2 px-2.5 py-2 rounded-xl border-2 text-left transition-colors duration-150 ${
                                receiveCoin === coin.symbol
                                  ? "border-[#00D1A0] bg-[#F0FAF6]"
                                  : "border-border/40 hover:border-[#00D1A0]/50 bg-background"
                              }`}
                            >
                              <CurrencyMark coin={coin} />
                              <div className="min-w-0 flex-1">
                                <p className="text-[12px] font-semibold leading-tight text-foreground flex items-center gap-1">
                                  {coin.symbol}
                                  {receiveCoin === coin.symbol && <CheckCircle2 className="w-3 h-3 text-[#00D1A0]" />}
                                </p>
                                <p className="text-[9px] text-muted-foreground leading-tight truncate">{coin.name}</p>
                              </div>
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                    {filteredGroups.every(group => group.coins.length === 0) && (
                      <div className="rounded-xl border border-dashed border-border/70 bg-muted/20 px-3 py-5 text-center text-xs text-muted-foreground">
                        No currencies match your search.
                      </div>
                    )}
                  </div>

                  {!coinSearch && currencies.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setCoinExpanded(v => !v)}
                      className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors w-full justify-center pt-1"
                    >
                      {coinExpanded ? <><ChevronUp className="w-3 h-3" /> Show less</> : <><ChevronDown className="w-3 h-3" /> Show all {currencies.length} currencies</>}
                    </button>
                  )}

                  <Button
                    type="button"
                    onClick={handleSaveReceiveCoin}
                    disabled={updateProfile.isPending || !receiveCoin}
                    size="sm"
                    className="bg-gradient-to-r from-[#00D1A0] to-[#00B88A] hover:from-[#00C196] hover:to-[#00A87E] text-white border-0"
                  >
                    <Save className="w-3.5 h-3.5 mr-1.5" />
                    {updateProfile.isPending ? "Saving..." : "Save Coin"}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          {/* ── 3. QR Style picker ── */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <QrCode className="w-4 h-4 text-[#00D1A0]" />
                Style
              </CardTitle>
              <CardDescription>Choose how the QR code dots look on your payment page.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-1 rounded-2xl bg-muted/50 p-1 mb-4">
                {([
                  { id: "advanced" as QrMode, label: "Advanced QR", desc: "Auto coloring based on logo" },
                  { id: "standard" as QrMode, label: "Standard QR", desc: "Classic QR colors" },
                ]).map((modeOption) => {
                  const active = qrMode === modeOption.id;
                  return (
                    <button
                      key={modeOption.id}
                      type="button"
                      onClick={() => handleQrModeChange(modeOption.id)}
                      className={`flex min-h-[46px] items-center justify-center gap-2 rounded-xl px-3 text-center transition-all ${active ? "bg-white text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                    >
                      <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md ${active ? "bg-[#00D1A0] text-white" : "border border-border/60 bg-white"}`}>
                        {active ? <Check className="h-3.5 w-3.5" /> : null}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-xs font-extrabold text-foreground">{modeOption.label}</span>
                        <span className="hidden sm:block text-[11px] text-muted-foreground">{modeOption.desc}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
              <label className="text-sm font-semibold text-foreground block mb-2">QR Design</label>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {SETTINGS_QR_STYLES.map(s => (
                  <button
                    key={s.id}
                    onClick={() => handleStyleChange(s.id)}
                    className={`flex flex-col items-center gap-2 p-2.5 rounded-xl border-2 transition-all ${
                      qrStyle === s.id
                        ? "border-[#00D1A0] bg-[#F0FAF6] shadow-sm"
                        : "border-border/40 hover:border-[#00D1A0]/50"
                    }`}
                  >
                    <div className="rounded-lg overflow-hidden" style={{ background: qrBgColor || "#fff" }}>
                      <QRStyled
                        value="https://serapay.io"
                        size={68}
                        fgColor={qrFgColor}
                        bgColor={qrBgColor}
                        style={s.id}
                        logo={logoUrl || undefined}
                        mode={qrMode}
                      />
                    </div>
                    <span className="text-[9px] font-medium text-center leading-tight whitespace-nowrap">{s.label}</span>
                  </button>
                ))}
              </div>

              {/* Color pickers */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4">
                <div>
                  <label className={`text-xs font-semibold uppercase tracking-wide block mb-1.5 ${qrMode === "advanced" ? "text-muted-foreground/50" : "text-muted-foreground"}`}>QR Color</label>
                  <div className={`flex items-center gap-2 border rounded-xl px-3 py-2.5 ${qrMode === "advanced" ? "bg-muted/40 border-border/30 opacity-60 cursor-default" : "bg-background border-border/60 cursor-pointer"}`} onClick={() => { if (qrMode !== "advanced") document.getElementById('settings-fg-picker')?.click(); }}>
                    <span className="w-5 h-5 rounded-md border border-border/40 shrink-0" style={{ background: qrFgColor }} />
                    <span className={`text-sm font-mono ${qrMode === "advanced" ? "text-muted-foreground" : "text-foreground"}`}>{qrFgColor.toUpperCase()}</span>
                    <input id="settings-fg-picker" type="color" value={qrFgColor} onChange={e => handleFgColorChange(e.target.value)} disabled={qrMode === "advanced"} className="sr-only" />
                  </div>
                </div>
                <div>
                  <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide block mb-1.5">Background</label>
                  <div className="flex items-center gap-2 bg-background border border-border/60 rounded-xl px-3 py-2.5 cursor-pointer" onClick={() => document.getElementById('settings-bg-picker')?.click()}>
                    <span className="w-5 h-5 rounded-md border border-border/40 shrink-0" style={{ background: qrBgColor }} />
                    <span className="text-sm font-mono text-foreground">{qrBgColor.toUpperCase()}</span>
                    <input id="settings-bg-picker" type="color" value={qrBgColor} onChange={e => handleBgColorChange(e.target.value)} className="sr-only" />
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* ── 4. Webhook IP Allowlist ── */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <svg className="w-4 h-4 text-[#00D1A0]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>
                Webhook IP Allowlist
              </CardTitle>
              <CardDescription>Restrict webhook delivery to specific IP addresses. Leave empty to allow all IPs.</CardDescription>
            </CardHeader>
            <CardContent>
              <IpAllowlistEditor />
            </CardContent>
          </Card>
        </div>

        {/* ── Right column: sticky live preview ── */}
        <div className="w-full lg:w-72 lg:shrink-0 lg:sticky lg:top-6 lg:max-h-[calc(100dvh-7rem)] lg:overflow-y-auto lg:pr-1">
          <div className="space-y-3">
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Live Preview</p>

              {/* Tab switcher */}
              <div className="flex items-center gap-1 bg-muted/40 rounded-lg p-1 w-fit mb-3">
                <button
                  onClick={() => setPreviewTab("qr")}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                    previewTab === "qr"
                      ? "bg-white shadow-sm text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  QR
                </button>
                <button
                  onClick={() => setPreviewTab("receipt")}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                    previewTab === "receipt"
                      ? "bg-white shadow-sm text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Receipt
                </button>
              </div>
            </div>

            {/* QR Preview */}
            {previewTab === "qr" && (
              <div className="bg-white rounded-3xl overflow-hidden mx-auto w-full max-w-[18rem]" style={{ boxShadow: "0 2px 20px rgba(0,0,0,0.08)" }}>
                <div className="p-6">
                  <div className="text-center mb-4">
                    <p className="text-[11px] font-semibold text-[#3C3C43]/40 uppercase tracking-wider mb-2">Customer Pays</p>
                    <div className="flex items-center justify-center gap-2">
                      <span className="text-[28px] font-bold tracking-tight text-[#1C1C1E] leading-none">10.00</span>
                      <span className="text-[16px] font-bold text-[#00795C] leading-tight">{receiveCoin || "USDT"}</span>
                    </div>
                    {storeName && <p className="text-[12px] text-[#3C3C43]/40 mt-1.5">to {storeName}</p>}
                  </div>

                  <div className="flex justify-center mb-4">
                    <QRStyled
                      value={profile?.walletAddress
                        ? buildClientAppUrl(`/?addr=${profile.walletAddress}&chainId=${paymentChainId}`)
                        : "https://serapay.io"
                      }
                      size={240}
                      fgColor={qrFgColor}
                      bgColor={qrBgColor}
                      style={qrStyle}
                      logo={logoUrl || undefined}
                      mode={qrMode}
                    />
                  </div>

                  <p className="text-[10px] font-mono break-all leading-relaxed text-center">
                    {profile?.walletAddress
                      ? <><span className="font-bold text-[#1C1C1E]">{profile.walletAddress.slice(0, 6)}</span><span className="text-[#3C3C43]/35">{profile.walletAddress.slice(6, -6)}</span><span className="font-bold text-[#1C1C1E]">{profile.walletAddress.slice(-6)}</span></>
                      : <span className="text-[#3C3C43]/35">Connect wallet to see address</span>
                    }
                  </p>

                  <div className="mt-3 pt-3 border-t border-black/5">
                    <p className="text-[11px] text-center text-[#3C3C43]/35">Scan with any wallet · Opens SeraPay payment page</p>
                  </div>
                </div>
              </div>
            )}

            {/* Receipt Preview */}
            {previewTab === "receipt" && (
              <button
                type="button"
                onClick={() => setReceiptZoomOpen(true)}
                className="mx-auto block w-fit max-w-full overflow-x-auto rounded-2xl border-0 bg-transparent p-0 text-left transition-transform duration-150 hover:scale-[1.01] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00D1A0]/30"
                aria-label="Open receipt preview"
              >
                <ReceiptPreview
                  storeName={storeName}
                  storeAddress={storeAddress}
                  logoUrl={logoUrl}
                  receiveCoin={receiveCoin}
                  walletAddress={profile?.walletAddress}
                  networkName={paymentNetworkName}
                />
              </button>
            )}

            <p className="text-[10px] text-muted-foreground text-center">Updates live as you edit</p>
          </div>
        </div>

      </div>
      </div>
      {receiptZoomOpen && (
        <>
          <div
            className="fixed inset-0 z-50 bg-black/35 backdrop-blur-sm"
            onClick={() => setReceiptZoomOpen(false)}
          />
          <div className="fixed inset-0 z-[51] flex items-center justify-center p-4 pointer-events-none">
            <div className="relative max-h-[calc(100dvh-2rem)] w-full max-w-[min(96vw,720px)] overflow-auto rounded-3xl bg-white p-4 shadow-2xl pointer-events-auto">
              <button
                type="button"
                onClick={() => setReceiptZoomOpen(false)}
                className="absolute right-3 top-3 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-muted text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground"
                aria-label="Close receipt preview"
              >
                <X className="h-4 w-4" />
              </button>
              <div className="mb-3 flex items-center gap-2 pr-12">
                <p className="flex-1 text-sm font-semibold text-foreground">Receipt Preview</p>
                <button
                  type="button"
                  onClick={() => setReceiptZoom((current) => Math.max(0.8, Number((current - 0.1).toFixed(1))))}
                  className="flex h-8 w-8 items-center justify-center rounded-full border border-border bg-white text-sm font-bold text-muted-foreground hover:border-[#00D1A0]/50 hover:text-foreground"
                  aria-label="Zoom out"
                >
                  -
                </button>
                <span className="w-12 text-center text-xs font-semibold text-muted-foreground">{Math.round(receiptZoom * 100)}%</span>
                <button
                  type="button"
                  onClick={() => setReceiptZoom((current) => Math.min(1.6, Number((current + 0.1).toFixed(1))))}
                  className="flex h-8 w-8 items-center justify-center rounded-full border border-border bg-white text-sm font-bold text-muted-foreground hover:border-[#00D1A0]/50 hover:text-foreground"
                  aria-label="Zoom in"
                >
                  +
                </button>
              </div>
              <div className="flex min-h-[520px] items-start justify-center overflow-auto rounded-2xl bg-muted/20 p-5">
                <div style={{ transform: `scale(${receiptZoom})`, transformOrigin: "top center" }}>
                  <ReceiptPreview
                    storeName={storeName}
                    storeAddress={storeAddress}
                    logoUrl={logoUrl}
                    receiveCoin={receiveCoin}
                    walletAddress={profile?.walletAddress}
                    networkName={paymentNetworkName}
                  />
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </AppLayout>
  );
}
