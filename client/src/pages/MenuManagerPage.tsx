import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { AppLayout } from "@/components/AppLayout";
import { fetchApi } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Plus, Trash2, Edit2, ExternalLink, Copy, Check, X,
  ShoppingCart, QrCode, Download, Camera, Minus, Image as ImageIcon,
  ChevronDown, UtensilsCrossed, Search, WalletCards,
} from "lucide-react";
import { toast } from "sonner";
import { buildPaymentUrl, buildWalletPaymentUri, resolvePaymentChainId, OrderItem } from "@/lib/payment";
import { buildClientAppUrl } from "@/lib/app-url";
import { useMerchantProfile } from "@/hooks/use-merchant";
import { useAuth } from "@/hooks/use-auth";
import { useSeraApiConfig, useSetDefaultWallet, useWallets } from "@/hooks/use-gateway";
import { useLocation, useSearch } from "wouter";
import { useChainId } from "wagmi";
import { MENU_TEMPLATES } from "@/lib/menuTemplates";
import { STABLECOINS } from "@/lib/stablecoins";
import { getCurrencyRate, loadSeraCurrencies, type SeraCurrency } from "@/lib/currencyCalculator";
import { CurrencySelectModal } from "@/components/CurrencySelectModal";
import { QRStyled, type QrMode, type QrStyle } from "@/components/QRStyled";
import { MAX_IMAGE_UPLOAD_BYTES, loadImage, readFileAsDataUrl, renderCroppedImageForUpload } from "@/lib/imageUpload";
import { formatDecimalAmount, limitDecimalPlaces, normalizeDecimalAmountText } from "@/lib/decimalInput";
import { downloadPaymentQrCard } from "@/lib/qrDownload";

// Build a name→category lookup from all templates for backfill
const TEMPLATE_CATEGORY_MAP: Record<string, string> = {};
for (const t of MENU_TEMPLATES) {
  for (const item of t.items) {
    const cat = (item as any).category;
    if (cat && item.name) TEMPLATE_CATEGORY_MAP[item.name.toLowerCase()] = cat;
  }
}

function inferCategory(item: MenuItem): string | null {
  if (item.category) return item.category;
  return TEMPLATE_CATEGORY_MAP[item.name.toLowerCase()] || null;
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface Menu {
  id: string;
  name: string;
  description: string | null;
  slug: string;
  isActive: number;
  createdAt: string;
}

interface MenuItem {
  id: string;
  menuId: string;
  name: string;
  description: string | null;
  itemCode: string | null;
  price: string;
  coin: string;
  imageUrl: string | null;
  sortOrder: number;
  isActive: number;
  soldOutUntil: string | null;
  category: string | null;
}

interface CartEntry {
  item: MenuItem;
  qty: number;
}

function DeleteConfirmDialog({
  title,
  description,
  confirming,
  onCancel,
  onConfirm,
}: {
  title: string;
  description: string;
  confirming?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <>
      <div className="fixed inset-0 z-[70] bg-black/40 backdrop-blur-sm" onClick={onCancel} />
      <div className="fixed inset-0 z-[71] flex items-center justify-center p-4">
        <div className="w-full max-w-sm rounded-2xl border border-gray-100 bg-white p-5 shadow-[0_24px_70px_rgba(10,31,26,0.18)]">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-red-50 text-red-500">
              <Trash2 className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-base font-semibold text-gray-950">{title}</h3>
              <p className="mt-1 text-sm leading-relaxed text-gray-500">{description}</p>
            </div>
          </div>
          <div className="mt-5 grid grid-cols-2 gap-2">
            <Button type="button" variant="outline" onClick={onCancel} disabled={confirming} className="bg-white">
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={onConfirm} disabled={confirming} className="bg-red-500 text-white hover:bg-red-600">
              {confirming ? "Deleting..." : "Delete"}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}

function RenameMenuDialog({
  name,
  saving,
  onNameChange,
  onCancel,
  onConfirm,
}: {
  name: string;
  saving?: boolean;
  onNameChange: (name: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <>
      <div className="fixed inset-0 z-[70] bg-black/40 backdrop-blur-sm" onClick={onCancel} />
      <div className="fixed inset-0 z-[71] flex items-center justify-center p-4">
        <form
          onSubmit={(event) => { event.preventDefault(); onConfirm(); }}
          className="w-full max-w-sm rounded-2xl border border-gray-100 bg-white p-5 shadow-[0_24px_70px_rgba(10,31,26,0.18)]"
        >
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#E6FAF5] text-[#00A87A]">
              <Edit2 className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-base font-semibold text-gray-950">Rename menu</h3>
              <p className="mt-1 text-sm leading-relaxed text-gray-500">Update the display name shown in your menu selector.</p>
            </div>
          </div>
          <div className="mt-5">
            <label className="mb-2 block text-xs font-bold uppercase tracking-[0.08em] text-gray-400">Menu name</label>
            <Input
              autoFocus
              value={name}
              onChange={(event) => onNameChange(event.target.value)}
              maxLength={80}
              className="h-12 rounded-2xl border-gray-200 bg-white text-base font-semibold focus-visible:border-[#00A87A] focus-visible:ring-[#00A87A]/20"
            />
          </div>
          <div className="mt-5 grid grid-cols-2 gap-2">
            <Button type="button" variant="outline" onClick={onCancel} disabled={saving} className="bg-white">
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !name.trim()} className="serapay-green-button bg-gradient-to-r from-[#00C896] via-[#00A87A] to-[#008A64] text-white">
              {saving ? "Saving..." : "Save"}
            </Button>
          </div>
        </form>
      </div>
    </>
  );
}

const CART_STORAGE_KEY = "serapay_pos_cart";
const CART_TTL_MS = 24 * 60 * 60 * 1000;

type StoredCart = {
  savedAt: number;
  cart: CartEntry[];
};

function readStoredCart(): CartEntry[] {
  const saved = localStorage.getItem(CART_STORAGE_KEY);
  if (!saved) return [];
  const parsed = JSON.parse(saved) as StoredCart | CartEntry[];
  if (Array.isArray(parsed)) {
    localStorage.setItem(CART_STORAGE_KEY, JSON.stringify({ savedAt: Date.now(), cart: parsed }));
    return parsed;
  }
  if (!parsed || !Array.isArray(parsed.cart)) {
    localStorage.removeItem(CART_STORAGE_KEY);
    return [];
  }
  if (!Number.isFinite(parsed.savedAt) || Date.now() - parsed.savedAt > CART_TTL_MS) {
    localStorage.removeItem(CART_STORAGE_KEY);
    return [];
  }
  return parsed.cart;
}

function writeStoredCart(cart: CartEntry[]) {
  if (cart.length === 0) {
    localStorage.removeItem(CART_STORAGE_KEY);
    return;
  }
  localStorage.setItem(CART_STORAGE_KEY, JSON.stringify({ savedAt: Date.now(), cart }));
}

// ── Coin options — derived from the canonical STABLECOINS list ───────────────

const COIN_OPTIONS = STABLECOINS.map(s => s.symbol);

// ── Helpers ──────────────────────────────────────────────────────────────────

function menuPublicUrl(slug: string, chainId?: number) {
  const query = chainId ? `?chainId=${chainId}` : "";
  return buildClientAppUrl(`/menu/${slug}${query}`);
}

function nextLocalMidnightIso() {
  const next = new Date();
  next.setHours(24, 0, 0, 0);
  return next.toISOString();
}

function isItemSoldOutToday(item: { soldOutUntil?: string | null }) {
  if (!item.soldOutUntil) return false;
  const until = new Date(item.soldOutUntil).getTime();
  return Number.isFinite(until) && until > Date.now();
}

type CropSource = {
  dataUrl: string;
  width: number;
  height: number;
  fileName: string;
};

function validateItemForm(data: { name: string; price: string; coin: string; category?: string }) {
  if (!data.name.trim()) return "Item name is required";
  if (!data.category?.trim()) return "Category is required";
  const price = normalizeDecimalAmountText(data.price);
  if (!price) return "Price must be greater than 0";
  if (!data.coin.trim()) return "Coin is required";
  return "";
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function PhotoCropModal({
  source,
  uploading,
  onCancel,
  onConfirm,
}: {
  source: CropSource;
  uploading: boolean;
  onCancel: () => void;
  onConfirm: (prepared: { dataUrl: string }) => void;
}) {
  const frameW = 320;
  const frameH = 240;
  const baseScale = Math.max(frameW / source.width, frameH / source.height);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ pointerId: number; x: number; y: number; startX: number; startY: number } | null>(null);
  const displayW = source.width * baseScale * zoom;
  const displayH = source.height * baseScale * zoom;
  const maxOffsetX = Math.max(0, (displayW - frameW) / 2);
  const maxOffsetY = Math.max(0, (displayH - frameH) / 2);
  const safeOffset = { x: clamp(offset.x, -maxOffsetX, maxOffsetX), y: clamp(offset.y, -maxOffsetY, maxOffsetY) };

  useEffect(() => {
    setOffset((current) => ({
      x: clamp(current.x, -maxOffsetX, maxOffsetX),
      y: clamp(current.y, -maxOffsetY, maxOffsetY),
    }));
  }, [maxOffsetX, maxOffsetY]);

  const handleConfirm = async () => {
    const scale = baseScale * zoom;
    const drawnX = (frameW - displayW) / 2 + safeOffset.x;
    const drawnY = (frameH - displayH) / 2 + safeOffset.y;
    const prepared = await renderCroppedImageForUpload({
      source: source.dataUrl,
      crop: {
        x: clamp(-drawnX / scale, 0, source.width),
        y: clamp(-drawnY / scale, 0, source.height),
        width: Math.min(frameW / scale, source.width),
        height: Math.min(frameH / scale, source.height),
      },
      outputWidth: 1600,
      outputHeight: 1200,
      quality: 0.88,
    });
    onConfirm({ dataUrl: prepared.dataUrl });
  };

  return (
    <>
      <div className="fixed inset-0 z-[60] bg-black/45 backdrop-blur-sm" />
      <div className="fixed inset-0 z-[61] flex items-center justify-center p-4">
        <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl">
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <h3 className="text-base font-semibold text-gray-900">Crop Photo</h3>
              <p className="mt-1 text-sm text-gray-500">Drag to reposition, then adjust the scale.</p>
            </div>
            <button onClick={onCancel} className="flex h-10 w-10 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700" aria-label="Cancel crop">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div
            className="relative mx-auto aspect-[4/3] w-full max-w-[320px] touch-none overflow-hidden rounded-2xl border-2 border-[#00D1A0] bg-[#E6FAF5] shadow-inner"
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, startX: safeOffset.x, startY: safeOffset.y };
            }}
            onPointerMove={(event) => {
              const drag = dragRef.current;
              if (!drag || drag.pointerId !== event.pointerId) return;
              setOffset({
                x: clamp(drag.startX + event.clientX - drag.x, -maxOffsetX, maxOffsetX),
                y: clamp(drag.startY + event.clientY - drag.y, -maxOffsetY, maxOffsetY),
              });
            }}
            onPointerUp={() => { dragRef.current = null; }}
            onPointerCancel={() => { dragRef.current = null; }}
          >
            <img
              src={source.dataUrl}
              alt=""
              draggable={false}
              className="absolute left-1/2 top-1/2 max-w-none select-none"
              style={{ width: displayW, height: displayH, transform: `translate(calc(-50% + ${safeOffset.x}px), calc(-50% + ${safeOffset.y}px))` }}
            />
            <div className="pointer-events-none absolute inset-0 rounded-2xl ring-1 ring-inset ring-white/70" />
          </div>
          <div className="mt-5">
            <div className="mb-2 flex items-center justify-between text-xs font-semibold text-gray-500">
              <span>Scale</span>
              <span>{Math.round(zoom * 100)}%</span>
            </div>
            <input type="range" min="1" max="3" step="0.01" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} className="w-full accent-[#00C853]" />
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onCancel} disabled={uploading}>Cancel</Button>
            <Button type="button" onClick={() => void handleConfirm()} disabled={uploading} className="serapay-green-button bg-gradient-to-r from-[#00D1A0] to-[#00B88A] text-white">
              {uploading ? "Uploading..." : "Confirm"}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Item Edit Dialog ──────────────────────────────────────────────────────────

function ItemEditDialog({
  item,
  menuId,
  onSave,
  onCancel,
  loading,
}: {
  item: MenuItem;
  menuId: string;
  onSave: (data: { name: string; description: string; itemCode?: string | null; price: string; coin: string; imageUrl?: string; category?: string; soldOutUntil?: string | null }) => void;
  onCancel: () => void;
  loading: boolean;
}) {
  const [name, setName] = useState(item.name);
  const [description, setDescription] = useState(item.description || "");
  const [itemCode, setItemCode] = useState(item.itemCode || "");
  const [price, setPrice] = useState(item.price);
  const [coin, setCoin] = useState(item.coin);
  const [category, setCategory] = useState(item.category || "");
  const [imageUrl, setImageUrl] = useState(item.imageUrl || "");
  const [soldOutToday, setSoldOutToday] = useState(isItemSoldOutToday(item));
  const [uploadingImage, setUploadingImage] = useState(false);
  const [cropSource, setCropSource] = useState<CropSource | null>(null);
  const [error, setError] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(Boolean(item.itemCode));
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      toast.error("Use a JPEG, PNG, or WebP image");
      return;
    }
    if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
      toast.error("Image must be 10 MB or smaller");
      return;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const image = await loadImage(dataUrl);
      setCropSource({
        dataUrl,
        width: image.naturalWidth || image.width,
        height: image.naturalHeight || image.height,
        fileName: file.name,
      });
    } catch (err: any) {
      toast.error(err.message || "Unable to open image");
    }
  };

  const uploadPreparedImage = async (prepared: { dataUrl: string }) => {
    setUploadingImage(true);
    try {
      const result = await fetchApi<{ imageUrl: string }>(`/menus/${menuId}/items/${item.id}/image`, {
        method: "POST",
        body: JSON.stringify({ imageData: prepared.dataUrl }),
      });
      setImageUrl(result.imageUrl);
      setCropSource(null);
      toast.success("Photo uploaded");
    } catch (err: any) {
      toast.error(err.message || "Upload failed");
    } finally {
      setUploadingImage(false);
    }
  };

  const handleSubmit = () => {
    const validation = validateItemForm({ name, price, coin, category });
    if (validation) {
      setError(validation);
      return;
    }
    onSave({
      name: name.trim(),
      description: description.trim(),
      itemCode: itemCode.trim() || null,
      price: normalizeDecimalAmountText(price),
      coin,
      imageUrl: imageUrl || undefined,
      category: category.trim(),
      soldOutUntil: soldOutToday ? nextLocalMidnightIso() : null,
    });
  };

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" onClick={onCancel} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm max-h-[calc(100vh-2rem)] overflow-y-auto p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-gray-900">Edit Item</h3>
            <button onClick={onCancel} className="text-gray-400 hover:text-gray-600"><X className="w-4 h-4" /></button>
          </div>

          {/* Photo */}
          <div>
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">Photo (optional)</label>
            <div className="flex items-center gap-3">
              <div
                onClick={() => fileInputRef.current?.click()}
                className="w-16 h-16 rounded-xl overflow-hidden border-2 border-dashed border-[#00D1A0]/55 bg-[#F0FAF6] flex items-center justify-center cursor-pointer hover:border-[#00C853] transition-colors shrink-0 relative"
              >
                {imageUrl ? (
                  <img src={imageUrl} alt={name} className="w-full h-full object-cover" />
                ) : uploadingImage ? (
                  <div className="w-5 h-5 border-2 border-[#00C853] border-t-transparent rounded-full animate-spin" />
                ) : (
                  <Camera className="w-5 h-5 text-gray-400" />
                )}
              </div>
              <div className="text-xs text-gray-500">
                <p>JPEG, PNG, WebP · max 10MB</p>
                {imageUrl && (
                  <button onClick={() => setImageUrl("")} className="text-red-400 hover:text-red-600 mt-1">Remove photo</button>
                )}
              </div>
              <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={handleImageUpload} />
            </div>
          </div>

          <div>
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">Item Name</label>
            <Input value={name} onChange={e => { setName(e.target.value); setError(""); }} placeholder="e.g. Kopi O" />
          </div>
          <div>
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">Description (optional)</label>
            <Input value={description} onChange={e => setDescription(e.target.value)} placeholder="e.g. Traditional black coffee" />
          </div>
          <div>
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">Category</label>
            <Input value={category} onChange={e => { setCategory(e.target.value); setError(""); }} placeholder="e.g. Mains, Drinks, Services" maxLength={60} />
          </div>
          <button
            type="button"
            onClick={() => setAdvancedOpen((open) => !open)}
            className="flex w-full items-center justify-between rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-semibold text-gray-700 transition-colors hover:border-[#00C853]/50"
          >
            Advanced
            <ChevronDown className={`h-4 w-4 transition-transform ${advancedOpen ? "rotate-180" : ""}`} />
          </button>
          {advancedOpen ? (
            <div>
              <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">Menu Item ID</label>
              <Input value={itemCode} onChange={e => setItemCode(e.target.value.slice(0, 64))} placeholder="e.g. DRINK-KOPI-O" maxLength={64} />
            </div>
          ) : null}
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">Price</label>
              <Input className="h-10" value={price} onChange={e => { setPrice(limitDecimalPlaces(e.target.value)); setError(""); }} placeholder="0.00" type="text" inputMode="decimal" />
            </div>
            <div className="w-32">
              <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">Coin</label>
              <Select value={coin} onValueChange={(value) => { setCoin(value); setError(""); }}>
                <SelectTrigger className="h-10"><SelectValue /></SelectTrigger>
                <SelectContent>{COIN_OPTIONS.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 transition-colors hover:border-[#00C853]/50">
            <input
              type="checkbox"
              checked={soldOutToday}
              onChange={e => setSoldOutToday(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-gray-300 accent-[#00C853]"
            />
            <span className="min-w-0 text-sm leading-snug text-gray-700">
              <span className="block font-semibold text-gray-900">Item sold out for today</span>
              <span className="block text-xs text-gray-500">Resets automatically at 00:00.</span>
            </span>
          </label>
          {error ? <p className="text-sm font-medium text-red-500">{error}</p> : null}
          <div className="flex gap-2 pt-1">
            <Button
              className="serapay-green-button flex-1 bg-gradient-to-r from-[#00D1A0] to-[#00B88A] text-white"
              onClick={handleSubmit}
              disabled={loading}
            >
              {loading ? "Saving…" : "Save Item"}
            </Button>
            <Button variant="outline" onClick={onCancel} disabled={loading}>Cancel</Button>
          </div>
        </div>
      </div>
      {cropSource && (
        <PhotoCropModal
          source={cropSource}
          uploading={uploadingImage}
          onCancel={() => setCropSource(null)}
          onConfirm={(prepared) => void uploadPreparedImage(prepared)}
        />
      )}
    </>
  );
}

// ── Add Item Dialog ───────────────────────────────────────────────────────────

function AddItemDialog({
  menuId,
  onSave,
  onCancel,
  loading,
}: {
  menuId: string;
  onSave: (data: { name: string; description: string; itemCode?: string | null; price: string; coin: string; category?: string }) => void;
  onCancel: () => void;
  loading: boolean;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [itemCode, setItemCode] = useState("");
  const [price, setPrice] = useState("");
  const [coin, setCoin] = useState("USDC");
  const [category, setCategory] = useState("");
  const [error, setError] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const handleSubmit = () => {
    const validation = validateItemForm({ name, price, coin, category });
    if (validation) {
      setError(validation);
      return;
    }
    onSave({ name: name.trim(), description: description.trim(), itemCode: itemCode.trim() || null, price: normalizeDecimalAmountText(price), coin, category: category.trim() });
  };

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" onClick={onCancel} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-gray-900">Add Item</h3>
            <button onClick={onCancel} className="text-gray-400 hover:text-gray-600"><X className="w-4 h-4" /></button>
          </div>
          <div>
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">Item Name</label>
            <Input value={name} onChange={e => { setName(e.target.value); setError(""); }} placeholder="e.g. Kopi O" autoFocus />
          </div>
          <div>
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">Description (optional)</label>
            <Input value={description} onChange={e => setDescription(e.target.value)} placeholder="e.g. Traditional black coffee" />
          </div>
          <div>
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">Category</label>
            <Input value={category} onChange={e => { setCategory(e.target.value); setError(""); }} placeholder="e.g. Drinks, Mains, Add-ons" maxLength={60} />
          </div>
          <button
            type="button"
            onClick={() => setAdvancedOpen((open) => !open)}
            className="flex w-full items-center justify-between rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-semibold text-gray-700 transition-colors hover:border-[#00C853]/50"
          >
            Advanced
            <ChevronDown className={`h-4 w-4 transition-transform ${advancedOpen ? "rotate-180" : ""}`} />
          </button>
          {advancedOpen ? (
            <div>
              <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">Menu Item ID</label>
              <Input value={itemCode} onChange={e => setItemCode(e.target.value.slice(0, 64))} placeholder="e.g. ADDON-COOKIE" maxLength={64} />
            </div>
          ) : null}
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">Price</label>
              <Input className="h-10" value={price} onChange={e => { setPrice(limitDecimalPlaces(e.target.value)); setError(""); }} placeholder="0.00" type="text" inputMode="decimal" />
            </div>
            <div className="w-32">
              <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">Coin</label>
              <Select value={coin} onValueChange={(value) => { setCoin(value); setError(""); }}>
                <SelectTrigger className="h-10"><SelectValue /></SelectTrigger>
                <SelectContent>{COIN_OPTIONS.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          {error ? <p className="text-sm font-medium text-red-500">{error}</p> : null}
          <div className="flex gap-2 pt-1">
            <Button
              className="serapay-green-button flex-1 bg-gradient-to-r from-[#00D1A0] to-[#00B88A] text-white"
              onClick={handleSubmit}
              disabled={loading}
            >
              {loading ? "Adding…" : "Add Item"}
            </Button>
            <Button variant="outline" onClick={onCancel} disabled={loading}>Cancel</Button>
          </div>
        </div>
      </div>
    </>
  );
}

// ── QR Save Modal ─────────────────────────────────────────────────────────────

function QRSaveModal({ url, menuName, merchantProfile, onClose }: { url: string; menuName: string; merchantProfile: any; onClose: () => void }) {
  const code = url.split("/").filter(Boolean).pop() || "menu";
  const fgColor = merchantProfile?.qrFgColor || "#000000";
  const bgColor = merchantProfile?.qrBgColor || "#ffffff";
  const qrStyle = (merchantProfile?.qrStyle as QrStyle) || "rounded";
  const logo = merchantProfile?.logoData || undefined;

  const handleDownload = async () => {
    await downloadPaymentQrCard({
      qrValue: url,
      receiverAddress: merchantProfile?.storeAddress || merchantProfile?.walletAddress || code,
      merchantName: menuName || merchantProfile?.name || "SeraPay Menu",
      merchantLogo: logo || null,
      fgColor,
      bgColor,
      qrStyle,
      qrMode: merchantProfile?.qrMode || "standard",
      filename: `${menuName.replace(/\s+/g, "-").toLowerCase()}-qr.png`,
    });
  };

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xs overflow-hidden text-center">
          <div className="bg-[#00C853] px-6 py-4 text-white">
            <p className="text-[10px] font-bold uppercase tracking-wider opacity-80">SeraPay Order</p>
            <h3 className="font-semibold truncate">{merchantProfile?.name || "Your Store"}</h3>
          </div>
          <div className="p-6">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center overflow-hidden rounded-xl bg-[#E6FAF5]">
            {merchantProfile?.logoData ? (
              <img src={merchantProfile.logoData} alt="Store logo" className="h-full w-full object-cover" />
            ) : (
              <span className="text-sm font-bold text-[#00A87A]">SP</span>
            )}
          </div>
          <h3 className="font-semibold text-gray-900 mb-1 truncate">{menuName}</h3>
          <p className="text-xs text-gray-500 mb-4">Scan, enter pax, and order</p>
          <div className="mx-auto mb-4 flex aspect-square w-full max-w-[240px] items-center justify-center overflow-hidden rounded-xl p-2" style={{ background: bgColor }}>
            <QRStyled value={url} size={224} fgColor={fgColor} bgColor={bgColor} style={qrStyle} logo={logo} />
          </div>
          <p className="mb-4 rounded-lg bg-gray-50 px-3 py-2 text-[11px] font-mono text-gray-500 break-all">{code}</p>
          <div className="flex gap-2">
            <Button onClick={handleDownload} className="serapay-green-button flex-1 gap-1.5 bg-gradient-to-r from-[#00D1A0] to-[#00B88A] text-white">
              <Download className="w-4 h-4" /> Save QR
            </Button>
            <Button variant="outline" onClick={onClose}>Close</Button>
          </div>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Cart Sidebar ──────────────────────────────────────────────────────────────

function shortAddress(address: string) {
  return address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "";
}

function MenuWalletSelector() {
  const { data, isLoading } = useWallets();
  const setDefaultWallet = useSetDefaultWallet();
  const [open, setOpen] = useState(false);
  const [, navigate] = useLocation();
  const ref = useRef<HTMLDivElement>(null);
  const defaultWallet = data?.defaultWallet;

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const handleSetDefault = (walletId: string) => {
    setDefaultWallet.mutate(walletId, {
      onSuccess: () => {
        toast.success("Default wallet updated");
        setOpen(false);
      },
      onError: (error: any) => toast.error(error.message || "Unable to set default wallet"),
    });
  };

  const walletRows = data ? [
    {
      id: "master",
      label: "Master Wallet",
      address: data.masterWallet.address,
      coin: data.masterWallet.receiveCoin || "USDC",
      isDefault: data.defaultWalletId === "master",
    },
    ...data.subWallets.map((wallet) => ({
      id: wallet.id,
      label: wallet.label,
      address: wallet.address,
      coin: wallet.receiveCoin || "USDC",
      isDefault: Boolean(wallet.isDefault),
    })),
  ] : [];

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="flex min-h-10 items-center gap-2 rounded-2xl border border-gray-200 bg-white px-3.5 py-2 text-sm font-semibold text-gray-900 shadow-none transition-all hover:border-[#00C853] hover:bg-[#F9FFFC] focus:outline-none focus:ring-2 focus:ring-[#00C853]/25"
        title={defaultWallet ? `Receiving to ${defaultWallet.label}` : "Choose receiving wallet"}
      >
        <WalletCards className="h-4 w-4 text-[#00A87A]" />
        <span className="hidden max-w-[110px] truncate sm:inline">{defaultWallet?.label || (isLoading ? "Wallets" : "Wallet")}</span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-gray-400 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-30 mt-2 w-[min(22rem,calc(100vw-2rem))] rounded-2xl border border-gray-200 bg-white p-2 shadow-[0_18px_50px_rgba(10,31,26,0.14)]">
          <div className="px-2 pb-2 pt-1">
            <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Receiving Wallet</p>
            <p className="mt-1 truncate text-xs text-gray-500">{defaultWallet ? shortAddress(defaultWallet.address) : "No wallet loaded"}</p>
          </div>
          <div className="max-h-64 overflow-y-auto">
            {walletRows.map((wallet) => (
              <div key={wallet.id} className="flex items-center gap-2 rounded-xl px-2 py-2 transition-colors hover:bg-[#F4FFF9]">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#E6FAF5] text-[#00A87A]">
                  <WalletCards className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <p className="truncate text-sm font-semibold text-gray-900">{wallet.label}</p>
                    {wallet.isDefault ? <span className="rounded-full bg-[#E6FAF5] px-2 py-0.5 text-[10px] font-bold text-[#00A87A]">Default</span> : null}
                  </div>
                  <p className="truncate font-mono text-[11px] text-gray-400">{shortAddress(wallet.address)} - {wallet.coin}</p>
                </div>
                {wallet.isDefault ? (
                  <Check className="h-4 w-4 shrink-0 text-[#00C853]" />
                ) : (
                  <button
                    type="button"
                    onClick={() => handleSetDefault(wallet.id)}
                    disabled={setDefaultWallet.isPending}
                    className="shrink-0 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-gray-600 transition-colors hover:border-[#00C853] hover:text-[#00A87A] disabled:opacity-50"
                  >
                    Set
                  </button>
                )}
              </div>
            ))}
            {!isLoading && walletRows.length === 1 ? (
              <p className="px-2 py-3 text-xs text-gray-400">Add sub-wallets to route this merchant to another receiving address.</p>
            ) : null}
          </div>
          <div className="mt-1 border-t border-gray-100 pt-1">
            <button
              type="button"
              onClick={() => { setOpen(false); navigate("/wallets"); }}
              className="flex w-full items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-sm font-semibold text-[#00A87A] transition-colors hover:bg-[#F4FFF9]"
            >
              <WalletCards className="h-4 w-4" /> Manage wallets
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function CartPaymentModal({
  paymentUrl,
  amount,
  coin,
  merchantProfile,
  apiKey,
  chainId,
  startedAt,
  onCancel,
  onContinue,
}: {
  paymentUrl: string;
  amount: string;
  coin: string;
  merchantProfile: any;
  apiKey: string | null;
  chainId: number;
  startedAt: number;
  onCancel: () => void;
  onContinue: () => void;
}) {
  const [paidTx, setPaidTx] = useState<any | null>(null);
  const [copied, setCopied] = useState(false);
  const qrMode = (merchantProfile?.qrMode as QrMode) || "standard";
  const qrStyle = (merchantProfile?.qrStyle as QrStyle) || "rounded";
  const qrFg = merchantProfile?.qrFgColor || "#000000";
  const qrBg = merchantProfile?.qrBgColor || "#ffffff";
  const logo = merchantProfile?.logoData || undefined;
  const receiverAddress = merchantProfile?.storeAddress || merchantProfile?.walletAddress || "";
  const walletQrValue = buildWalletPaymentUri({ receiverAddress, coin, amount, chainId }) || paymentUrl;

  useEffect(() => {
    if (!apiKey || paidTx) return;
    let stopped = false;
    const expected = Number(amount);
    const poll = async () => {
      try {
        const res = await fetch(`/api/merchant/transactions?limit=50&chainId=${chainId}`, { headers: { "X-Api-Key": apiKey } });
        if (!res.ok) return;
        const data = await res.json();
        const txs: any[] = data.transactions ?? [];
        const matched = txs.find((tx) => {
          if (tx.status !== "confirmed") return false;
          if (String(tx.coin || "").toUpperCase() !== coin.toUpperCase()) return false;
          if (new Date(tx.createdAt).getTime() < startedAt - 30_000) return false;
          const received = Number(tx.amount);
          return Number.isFinite(received) && Number.isFinite(expected) && Math.abs(received - expected) < 0.000001;
        });
        if (matched && !stopped) setPaidTx(matched);
      } catch {}
    };
    void poll();
    const id = window.setInterval(poll, 5000);
    return () => { stopped = true; window.clearInterval(id); };
  }, [amount, apiKey, chainId, coin, paidTx, startedAt]);

  const shareInvoice = async () => {
    const txId = paidTx?.txId || paidTx?.id;
    const invoiceUrl = txId ? new URL(`/wallet/receipt/${txId}`, window.location.origin).toString() : paymentUrl;
    const text = `SeraPay receipt: ${amount} ${coin}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: "SeraPay E-Invoice", text, url: invoiceUrl });
        return;
      }
      await navigator.clipboard.writeText(invoiceUrl);
      toast.success("E-invoice link copied");
    } catch {}
  };

  const copyPaymentLink = async () => {
    try {
      await navigator.clipboard.writeText(paymentUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {}
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-3xl bg-white p-5 shadow-[0_30px_90px_rgba(10,31,26,0.22)]">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold text-gray-950">{paidTx ? "Payment received" : "Scan and pay"}</h3>
            <p className="mt-1 text-sm text-gray-500">{paidTx ? "The order payment has been confirmed." : "Keep this open while the customer scans the QR."}</p>
          </div>
          <button onClick={paidTx ? onContinue : onCancel} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-400 hover:text-gray-700">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-5 rounded-3xl border border-gray-100 bg-[#F8FAFB] p-5 text-center">
          {paidTx ? (
            <div className="flex min-h-[260px] flex-col items-center justify-center">
              <div className="flex h-20 w-20 items-center justify-center rounded-full bg-[#E6FAF5] text-[#00A87A]">
                <Check className="h-10 w-10" />
              </div>
              <p className="mt-4 text-xl font-extrabold text-gray-950">Successful</p>
              <p className="mt-1 text-sm font-semibold text-gray-500">Paid with {Number(paidTx.amount || amount).toLocaleString(undefined, { maximumFractionDigits: 6 })} {paidTx.coin || coin}</p>
            </div>
          ) : (
            <>
              <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-gray-400">Amount due</p>
              <p className="mt-1 text-2xl font-extrabold text-gray-950">{Number(amount).toLocaleString(undefined, { maximumFractionDigits: 6 })} <span className="text-[#00C896]">{coin}</span></p>
              <button id="pos-payment-qr" type="button" onClick={copyPaymentLink} className="mx-auto mt-4 block w-fit cursor-copy rounded-2xl bg-white p-2">
                <QRStyled value={walletQrValue} size={260} fgColor={qrFg} bgColor={qrBg} style={qrStyle} logo={logo} mode={qrMode} />
              </button>
              <p className={`mt-2 text-xs font-bold ${copied ? "text-[#00A87A]" : "text-gray-500"}`}>
                {copied ? "Link Copied!" : "Click QR to copy link"}
              </p>
            </>
          )}
        </div>

        {paidTx ? (
          <div className="mt-4 grid grid-cols-2 gap-2">
            <Button type="button" variant="outline" onClick={onContinue} className="h-11 bg-white">Continue Order</Button>
            <Button type="button" onClick={shareInvoice} className="serapay-green-button h-11 bg-gradient-to-r from-[#00D1A0] to-[#00B88A] text-white">Share E-Invoice</Button>
          </div>
        ) : (
          <div className="mt-4 grid grid-cols-2 gap-2">
            <Button type="button" variant="outline" onClick={onCancel} className="serapay-cancel-danger h-11 bg-white">Cancel Payment</Button>
            <Button type="button" onClick={() => window.open(paymentUrl, "_blank", "noopener,noreferrer")} className="serapay-green-button h-11 bg-gradient-to-r from-[#00D1A0] to-[#00B88A] text-white">Pay Now</Button>
          </div>
        )}
      </div>
    </div>
  );
}

function CartSidebar({
  cart,
  activeMenu,
  merchantProfile,
  onUpdateQty,
  onClear,
  variant = "sidebar",
  onClose,
}: {
  cart: CartEntry[];
  activeMenu: Menu | null;
  merchantProfile: any;
  onUpdateQty: (itemId: string, delta: number) => void;
  onClear: () => void;
  variant?: "sidebar" | "drawer";
  onClose?: () => void;
}) {
  const { apiKey } = useAuth();
  const walletChainId = useChainId();
  const { data: seraConfig } = useSeraApiConfig();
  const paymentChainId = resolvePaymentChainId(walletChainId, seraConfig?.mode);
  const [confirmClear, setConfirmClear] = useState(false);
  const [paymentModal, setPaymentModal] = useState<{ url: string; amount: string; coin: string; startedAt: number } | null>(null);
  const totalQty = cart.reduce((s, e) => s + e.qty, 0);

  // Per-currency totals for mixed-currency carts
  const coinTotals: Record<string, number> = {};
  for (const e of cart) {
    const c = e.item.coin || "USDC";
    coinTotals[c] = (coinTotals[c] || 0) + parseFloat(e.item.price) * e.qty;
  }
  const coinEntries = Object.entries(coinTotals); // [[coin, total], ...]
  // Dominant coin = the one with the highest total value (used as receiveCoin)
  const dominantCoin = coinEntries.reduce((a, b) => b[1] > a[1] ? b : a, ["", 0])[0]
    || merchantProfile?.receiveCoin || "USDC";
  const dominantTotal = coinTotals[dominantCoin] || 0;
  const receiverAddress = merchantProfile?.storeAddress || merchantProfile?.walletAddress;

  const handleGenerateQR = () => {
    if (!receiverAddress) { toast.error("Wallet address not found"); return; }
    const orderItems: OrderItem[] = cart.map(e => ({
      id: e.item.id,
      n: e.item.name,
      p: e.item.price,
      q: e.qty,
      c: e.item.coin || undefined,
    }));
    const paymentAmount = formatDecimalAmount(dominantTotal) || dominantTotal.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
    const url = buildPaymentUrl({
      receiverAddress,
      receiveCoin: dominantCoin,
      amount: paymentAmount,
      chainId: paymentChainId,
      merchantName: merchantProfile.name,
      merchantIcon: merchantProfile.logoData || undefined,
      orderItems,
      menuName: activeMenu?.name,
      menuSlug: activeMenu?.slug,
    });
    setPaymentModal({ url, amount: paymentAmount, coin: dominantCoin, startedAt: Date.now() });
  };

  const rootClass = variant === "drawer"
    ? "w-full bg-white rounded-t-2xl shadow-2xl flex flex-col max-h-[84vh]"
    : "hidden lg:flex w-80 shrink-0 bg-white border-l border-gray-100 flex-col h-full";

  return (
    <div className={rootClass}>
      {/* Header */}
      <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShoppingCart className="w-4 h-4 text-[#00C853]" />
          <span className="font-semibold text-gray-900">Order</span>
          {totalQty > 0 && (
            <span className="text-xs bg-[#E6FAF5] text-[#00A87A] px-2 py-0.5 rounded-full font-medium">{totalQty}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {cart.length > 0 && (
            <button onClick={() => setConfirmClear(true)} className="text-xs font-semibold text-red-500 transition-colors hover:text-red-600">Clear</button>
          )}
          {variant === "drawer" && (
            <button onClick={onClose} className="p-1 rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Items */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
        {cart.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center py-12">
            <ShoppingCart className="w-10 h-10 text-gray-200 mb-3" />
            <p className="text-sm text-gray-400 font-medium">Cart is empty</p>
            <p className="text-xs text-gray-300 mt-1">Tap items to add them</p>
          </div>
        ) : (
          cart.map(entry => (
            <div key={entry.item.id} className="flex items-center gap-3 py-2">
              {entry.item.imageUrl ? (
                <img src={entry.item.imageUrl} alt={entry.item.name} className="w-10 h-10 rounded-lg object-cover shrink-0" />
              ) : (
                <div className="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center shrink-0">
                  <ImageIcon className="w-4 h-4 text-gray-300" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">{entry.item.name}</p>
                <p className="text-xs text-gray-400">{parseFloat(entry.item.price).toFixed(2)} {entry.item.coin}</p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  onClick={() => onUpdateQty(entry.item.id, -1)}
                  className="w-6 h-6 rounded-full border border-gray-200 flex items-center justify-center hover:bg-gray-50 transition-colors"
                >
                  <Minus className="w-3 h-3" />
                </button>
                <span className="text-sm font-semibold w-5 text-center">{entry.qty}</span>
                <button
                  onClick={() => onUpdateQty(entry.item.id, 1)}
                  className="w-6 h-6 rounded-full bg-[#00C853] text-white flex items-center justify-center hover:bg-[#00B847] transition-colors"
                >
                  <Plus className="w-3 h-3" />
                </button>
              </div>
              <p className="text-sm font-semibold text-gray-900 w-14 text-right shrink-0">
                {(parseFloat(entry.item.price) * entry.qty).toFixed(2)}
              </p>
            </div>
          ))
        )}
      </div>

      {/* Footer */}
      <div className="px-5 py-4 border-t border-gray-100 space-y-3">
        <div className="space-y-1">
          {coinEntries.length === 0 ? (
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">Total</span>
              <span className="text-xl font-bold text-gray-900">0.00 <span className="text-sm font-normal text-gray-400">USDC</span></span>
            </div>
          ) : coinEntries.length === 1 ? (
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">Total</span>
              <span className="text-xl font-bold text-gray-900">{coinEntries[0][1].toFixed(2)} <span className="text-sm font-normal text-gray-400">{coinEntries[0][0]}</span></span>
            </div>
          ) : (
            <>
              {coinEntries.map(([c, amt]) => (
                <div key={c} className="flex items-center justify-between">
                  <span className="text-sm text-gray-500">{c === dominantCoin ? "Total" : ""}</span>
                  <span className={`font-bold text-gray-900 ${c === dominantCoin ? "text-xl" : "text-sm text-gray-500"}`}>
                    {amt.toFixed(2)} <span className="text-sm font-normal text-gray-400">{c}</span>
                  </span>
                </div>
              ))}
            </>
          )}
        </div>
        <Button
          onClick={handleGenerateQR}
          disabled={cart.length === 0}
          className="serapay-green-button w-full gap-2 bg-gradient-to-r from-[#00D1A0] to-[#00B88A] text-white font-semibold h-11"
        >
          <QrCode className="w-4 h-4" /> Generate Payment QR
        </Button>
      </div>
      {confirmClear && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-xs rounded-2xl bg-white p-5 shadow-2xl">
            <h3 className="text-base font-semibold text-gray-900">Clear this order?</h3>
            <p className="mt-1 text-sm text-gray-500">This removes every item from the current cart.</p>
            <div className="mt-5 grid grid-cols-2 gap-2">
              <Button variant="outline" onClick={() => setConfirmClear(false)} className="bg-white">Cancel</Button>
              <Button onClick={() => { onClear(); setConfirmClear(false); }} variant="destructive" className="bg-red-500 text-white hover:bg-red-600">Clear</Button>
            </div>
          </div>
        </div>
      )}
      {paymentModal && (
        <CartPaymentModal
          paymentUrl={paymentModal.url}
          amount={paymentModal.amount}
          coin={paymentModal.coin}
          merchantProfile={merchantProfile}
          apiKey={apiKey}
          chainId={paymentChainId}
          startedAt={paymentModal.startedAt}
          onCancel={() => setPaymentModal(null)}
          onContinue={() => { onClear(); setPaymentModal(null); onClose?.(); }}
        />
      )}
    </div>
  );
}

// ── Item Tile ─────────────────────────────────────────────────────────────────

function ItemTile({
  item,
  cartQty,
  onAdd,
  onRemove,
  onEdit,
  onDelete,
}: {
  item: MenuItem;
  cartQty: number;
  onAdd: () => void;
  onRemove: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const soldOut = isItemSoldOutToday(item);
  return (
    <div
      className={`relative rounded-2xl overflow-hidden border-2 transition-all duration-200 ease-in-out group
        ${cartQty > 0 ? "border-[#00C853] shadow-sm" : "border-gray-100 shadow-sm hover:border-[#00C853]/70 hover:shadow-sm"}
        ${soldOut ? "cursor-not-allowed" : "cursor-pointer"}`}
      onClick={soldOut ? undefined : onAdd}
      aria-disabled={soldOut}
    >
      {/* Photo or placeholder */}
      <div className="aspect-[4/3] bg-gray-50 relative">
        {item.imageUrl ? (
          <img src={item.imageUrl} alt={item.name} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center bg-gradient-to-br from-gray-50 to-gray-100">
            <UtensilsCrossed className="w-8 h-8 text-gray-200" />
          </div>
        )}
        {/* Cart qty badge */}
        {cartQty > 0 && (
          <div className="absolute top-2 right-2 w-6 h-6 bg-[#00C853] text-white text-xs font-bold rounded-full flex items-center justify-center shadow">
            {cartQty}
          </div>
        )}
        {/* Edit / delete overlay */}
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors" />
        <div className="absolute top-2 left-2 z-20 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={e => { e.stopPropagation(); onEdit(); }}
            className="w-7 h-7 bg-white/90 rounded-lg flex items-center justify-center text-gray-600 hover:text-[#00A87A] shadow-sm"
          >
            <Edit2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={e => { e.stopPropagation(); onDelete(); }}
            className="w-7 h-7 bg-white/90 rounded-lg flex items-center justify-center text-gray-600 hover:text-red-500 shadow-sm"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Info */}
      <div className="p-3 bg-white">
        <p className="text-sm font-semibold text-gray-900 truncate leading-tight">{item.name}</p>
        {item.description && (
          <p className="text-xs text-gray-400 truncate mt-0.5">{item.description}</p>
        )}
        <div className="flex items-center justify-between mt-2">
          <span className="text-sm font-bold text-[#00A87A]">
            {parseFloat(item.price).toFixed(2)} <span className="text-xs font-normal text-gray-400">{item.coin}</span>
          </span>
          {cartQty > 0 ? (
            <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
              <button
                onClick={onRemove}
                className="w-6 h-6 rounded-full border border-gray-200 flex items-center justify-center hover:bg-gray-50"
              >
                <Minus className="w-3 h-3" />
              </button>
              <span className="text-xs font-bold w-4 text-center">{cartQty}</span>
              <button
                onClick={onAdd}
                disabled={soldOut}
                className="w-6 h-6 rounded-full bg-[#00C853] text-white flex items-center justify-center hover:bg-[#00B847] disabled:bg-gray-200 disabled:text-gray-400"
              >
                <Plus className="w-3 h-3" />
              </button>
            </div>
          ) : (
            <div className={`w-7 h-7 rounded-full flex items-center justify-center transition-colors ${soldOut ? "bg-gray-100 text-gray-300" : "bg-[#E6FAF5] text-[#00A87A] group-hover:bg-[#00C853] group-hover:text-white"}`}>
              <Plus className="w-3.5 h-3.5" />
            </div>
          )}
        </div>
      </div>
      {soldOut && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-white/75 backdrop-blur-[1px]">
          <span className="rounded-full bg-gray-900 px-3 py-1 text-xs font-bold uppercase tracking-wide text-white shadow-sm">Out of stock</span>
        </div>
      )}
    </div>
  );
}

// ── POS View (main content) ───────────────────────────────────────────────────

function POSView({
  menu,
  allMenus,
  cart,
  merchantProfile,
  onSwitchMenu,
  onAddToCart,
  onRemoveFromCart,
  onUpdateCartQty,
  onClearCart,
  onDropFromCart,
  onNewMenu,
  onRenameMenu,
  onDeleteMenu,
}: {
  menu: Menu;
  allMenus: Menu[];
  cart: CartEntry[];
  merchantProfile: any;
  onSwitchMenu: (menuId: string) => void;
  onAddToCart: (item: MenuItem) => void;
  onRemoveFromCart: (itemId: string) => void;
  onUpdateCartQty: (itemId: string, delta: number) => void;
  onClearCart: () => void;
  onDropFromCart: (itemId: string) => void;
  onNewMenu: () => void;
  onRenameMenu: (menuId: string, menuName: string) => void;
  onDeleteMenu: (menuId: string, menuName: string) => void;
}) {
  const [items, setItems] = useState<MenuItem[]>([]);
  const [loadingItems, setLoadingItems] = useState(false);
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState<string>("All");
  const [editingItem, setEditingItem] = useState<MenuItem | null>(null);
  const [addingItem, setAddingItem] = useState(false);
  const [savingItem, setSavingItem] = useState(false);
  const [showQR, setShowQR] = useState(false);
  const [copied, setCopied] = useState(false);
  const [menuDropdownOpen, setMenuDropdownOpen] = useState(false);
  const [mobileCartOpen, setMobileCartOpen] = useState(false);
  const [bulkCoinOpen, setBulkCoinOpen] = useState(false);
  const [bulkCoin, setBulkCoin] = useState<string>("USDC");
  const [bulkCoinSaving, setBulkCoinSaving] = useState(false);
  const [deleteItemTarget, setDeleteItemTarget] = useState<MenuItem | null>(null);
  const [deletingItem, setDeletingItem] = useState(false);
  const [currencyOptions, setCurrencyOptions] = useState<SeraCurrency[]>([]);
  const walletChainId = useChainId();
  const { data: seraConfig } = useSeraApiConfig();
  const paymentChainId = resolvePaymentChainId(walletChainId, seraConfig?.mode);
  const publicUrl = menuPublicUrl(menu.slug, paymentChainId);
  const currencyList = useMemo(() => currencyOptions.length ? currencyOptions : STABLECOINS.map((coin) => ({ ...coin, source: "fallback" as const })), [currencyOptions]);

  const handleBulkCoinUpdate = async () => {
    const fromCoin = (items[0]?.coin || "USDC").toUpperCase();
    const toCoin = bulkCoin.toUpperCase();
    setBulkCoinSaving(true);
    try {
      const { rate } = await getCurrencyRate(fromCoin, toCoin, paymentChainId);
      await fetchApi(`/menus/${menu.id}/items/coin`, {
        method: "PATCH",
        body: JSON.stringify({ coin: toCoin, rate }),
      });
      setItems(prev => prev.map(i => ({ ...i, coin: toCoin, price: formatDecimalAmount(Number(i.price) * rate) || "0.000001" })));
      setBulkCoinOpen(false);
      toast.success(`Prices converted from ${fromCoin} to ${toCoin}`);
    } catch (e: any) {
      toast.error(e.message || "Failed to convert currency");
    } finally {
      setBulkCoinSaving(false);
    }
  };

  useEffect(() => {
    loadSeraCurrencies(paymentChainId).then(setCurrencyOptions).catch(() => setCurrencyOptions([]));
  }, [paymentChainId]);

  useEffect(() => {
    setLoadingItems(true);
    fetchApi<MenuItem[]>(`/menus/${menu.id}/items`)
      .then(data => {
        // Backfill categories for items that were created before the category column was added
        const enriched = data.map(item => ({
          ...item,
          category: inferCategory(item),
          soldOutUntil: isItemSoldOutToday(item) ? item.soldOutUntil : null,
        }));
        setItems(enriched);
        setActiveCategory("All");
      })
      .catch(e => toast.error(e.message || "Failed to load items"))
      .finally(() => setLoadingItems(false));
  }, [menu.id]);

  useEffect(() => {
    if (items.length === 0 || cart.length === 0) return;
    const soldOutIds = new Set(items.filter(isItemSoldOutToday).map(item => item.id));
    if (soldOutIds.size === 0) return;
    cart.forEach(entry => {
      if (soldOutIds.has(entry.item.id)) onDropFromCart(entry.item.id);
    });
  }, [items, cart, onDropFromCart]);

  // Derive unique categories from items
  const categories = useMemo(() => {
    const cats = Array.from(new Set(items.map(i => i.category).filter(Boolean))) as string[];
    return cats.length > 0 ? ["All", ...cats] : [];
  }, [items]);

  const handleAddItem = async (data: { name: string; description: string; itemCode?: string | null; price: string; coin: string; category?: string }) => {
    const validation = validateItemForm(data);
    if (validation) {
      toast.error(validation);
      return;
    }
    setSavingItem(true);
    try {
      const created = await fetchApi<MenuItem>(`/menus/${menu.id}/items`, {
        method: "POST",
        body: JSON.stringify({ ...data, sortOrder: items.length }),
      });
      setItems(prev => [...prev, created]);
      setAddingItem(false);
      toast.success("Item added");
    } catch (e: any) {
      toast.error(e.message || "Failed to add item");
    } finally {
      setSavingItem(false);
    }
  };

  const handleUpdateItem = async (item: MenuItem, data: { name: string; description: string; itemCode?: string | null; price: string; coin: string; imageUrl?: string; category?: string; soldOutUntil?: string | null }) => {
    const validation = validateItemForm(data);
    if (validation) {
      toast.error(validation);
      return;
    }
    setSavingItem(true);
    try {
      const updated = await fetchApi<MenuItem>(`/menus/${menu.id}/items/${item.id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      });
      setItems(prev => prev.map(i => i.id === item.id ? updated : i));
      if (isItemSoldOutToday(updated)) onDropFromCart(item.id);
      setEditingItem(null);
      toast.success("Item updated");
    } catch (e: any) {
      toast.error(e.message || "Failed to update item");
    } finally {
      setSavingItem(false);
    }
  };

  const handleDeleteItem = async (item: MenuItem) => {
    setDeleteItemTarget(item);
  };

  const confirmDeleteItem = async () => {
    if (!deleteItemTarget) return;
    setDeletingItem(true);
    try {
      await fetchApi(`/menus/${menu.id}/items/${deleteItemTarget.id}`, { method: "DELETE" });
      setItems(prev => prev.filter(i => i.id !== deleteItemTarget.id));
      onDropFromCart(deleteItemTarget.id);
      setDeleteItemTarget(null);
      toast.success("Item removed");
    } catch (e: any) {
      toast.error(e.message || "Failed to delete item");
    } finally {
      setDeletingItem(false);
    }
  };

  const handleCopyLink = async () => {
    await navigator.clipboard.writeText(publicUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const filtered = items.filter(i => {
    const matchesSearch = !search || i.name.toLowerCase().includes(search.toLowerCase()) || (i.description || "").toLowerCase().includes(search.toLowerCase());
    const matchesCategory = activeCategory === "All" || i.category === activeCategory;
    return matchesSearch && matchesCategory;
  });
  const mobileCartQty = cart.reduce((sum, entry) => sum + entry.qty, 0);
  const mobileCartCoin = cart[0]?.item.coin || merchantProfile?.receiveCoin || "USDC";
  const mobileCartTotal = cart.reduce((sum, entry) => sum + Number(entry.item.price) * entry.qty, 0);

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left: POS grid */}
      <div className="flex-1 flex flex-col overflow-hidden pb-24 lg:pb-0">
        {/* Top bar */}
        <div className="bg-white border-b border-gray-100 px-4 sm:px-5 py-3 flex flex-wrap items-center gap-3 shrink-0">
          {/* Menu selector */}
          <div className="relative">
            <button
              onClick={() => setMenuDropdownOpen(v => !v)}
              className="flex min-h-10 items-center gap-3 rounded-2xl border border-gray-200 bg-white px-3.5 py-2 text-sm font-semibold text-gray-900 shadow-none transition-all hover:border-[#00C853] hover:bg-[#F9FFFC] focus:outline-none focus:ring-2 focus:ring-[#00C853]/25"
            >
              <span className="max-w-[160px] truncate">{menu.name}</span>
              <ChevronDown className="w-3.5 h-3.5 text-gray-400 shrink-0" />
            </button>
            {menuDropdownOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMenuDropdownOpen(false)} />
                <div className="absolute top-full left-0 z-20 mt-2 max-h-[22rem] min-w-[260px] overflow-y-auto rounded-2xl border border-gray-200 bg-white p-1.5 shadow-[0_18px_50px_rgba(10,31,26,0.14)]">
                  {allMenus.map(m => (
                    <div key={m.id} className="group flex items-center rounded-xl transition-colors hover:bg-[#F4FFF9]">
                      <button
                        onClick={() => { onSwitchMenu(m.id); setMenuDropdownOpen(false); }}
                        className={`min-w-0 flex-1 rounded-xl px-3 py-2.5 text-left text-sm transition-colors ${m.id === menu.id ? "font-semibold text-[#00A87A]" : "font-medium text-gray-700"}`}
                      >
                        <span className="block truncate">{m.name}</span>
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); onRenameMenu(m.id, m.name); setMenuDropdownOpen(false); }}
                        className="mr-0.5 flex h-8 w-8 items-center justify-center rounded-lg text-gray-300 opacity-100 transition-all hover:bg-white hover:text-[#00A87A] sm:opacity-0 sm:group-hover:opacity-100"
                        title="Rename menu"
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); onDeleteMenu(m.id, m.name); setMenuDropdownOpen(false); }}
                        className="mr-1 flex h-8 w-8 items-center justify-center rounded-lg text-gray-300 opacity-100 transition-all hover:bg-white hover:text-red-400 sm:opacity-0 sm:group-hover:opacity-100"
                        title="Delete menu"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                  <div className="mt-1 border-t border-gray-100 pt-1">
                    <button
                      onClick={() => { onNewMenu(); setMenuDropdownOpen(false); }}
                      className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm font-semibold text-[#00A87A] transition-colors hover:bg-[#F4FFF9]"
                    >
                      <Plus className="w-3.5 h-3.5" /> New Menu
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>

          <MenuWalletSelector />

          {/* Search */}
          <div className="flex-1 relative min-w-[180px] max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search items…"
              className="w-full pl-8 pr-3 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-[#00C853]/30 focus:border-[#00C853]"
            />
          </div>

          <div className="flex items-center gap-2 ml-auto overflow-x-auto max-w-full pb-0.5">
            {/* Share buttons */}
            <a href={publicUrl} target="_blank" rel="noopener noreferrer"
              className="p-2 rounded-xl text-gray-400 hover:text-[#00A87A] hover:bg-gray-50 transition-colors" title="Open public menu">
              <ExternalLink className="w-4 h-4" />
            </a>
            <button
              onClick={handleCopyLink}
              className="flex shrink-0 items-center gap-1.5 px-3 py-2 text-xs font-medium border border-gray-200 rounded-xl hover:border-[#00C853] hover:text-[#00A87A] transition-colors"
              title={copied ? "Copied" : "Copy link"}
            >
              {copied ? <Check className="w-3.5 h-3.5 text-[#00C853]" /> : <Copy className="w-3.5 h-3.5" />}
              <span className="hidden sm:inline">{copied ? "Copied!" : "Copy Link"}</span>
            </button>
            <button
              onClick={() => setShowQR(true)}
              className="flex shrink-0 items-center gap-1.5 px-3 py-2 text-xs font-medium border border-gray-200 rounded-xl hover:border-[#00C853] hover:text-[#00A87A] transition-colors"
              title="Save QR"
            >
              <Download className="w-3.5 h-3.5" /> <span className="hidden sm:inline">Save QR</span>
            </button>
            <Button
              onClick={() => { setBulkCoin(items[0]?.coin || "USDC"); setBulkCoinOpen(true); }}
              size="sm"
              variant="outline"
              className="gap-1.5 text-gray-600 border-gray-200 hover:border-[#00C853] hover:text-[#00A87A] bg-white shrink-0"
              title="Change currency for all items"
            >
              <span className="text-xs font-mono">{items[0]?.coin || "USDC"}</span>
              <ChevronDown className="w-3 h-3" />
            </Button>
            <Button
              onClick={() => setAddingItem(true)}
              size="sm"
              className="serapay-green-button serapay-no-lift bg-gradient-to-r from-[#00D1A0] to-[#00B88A] text-white gap-1.5 shrink-0 shadow-none"
            >
              <Plus className="w-3.5 h-3.5" /> Add Item
            </Button>
          </div>
        </div>

        {/* Bulk coin update modal */}
        {bulkCoinOpen && (
          <CurrencySelectModal
            title="Change Menu Currency"
            subtitle={`Updates and converts all ${items.length} items in this menu.`}
            currencies={currencyList}
            selectedSymbol={bulkCoin}
            onSelect={setBulkCoin}
            onClose={() => setBulkCoinOpen(false)}
            onConfirm={handleBulkCoinUpdate}
            confirmLabel="Update"
            confirming={bulkCoinSaving}
          />
        )}

        {/* Category tabs */}
        {categories.length > 1 && (
          <div className="bg-white border-b border-gray-100 px-5 py-2 flex items-center gap-2 overflow-x-auto shrink-0 scrollbar-hide">
            {categories.map(cat => (
              <button
                key={cat}
                onClick={() => setActiveCategory(cat)}
                className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors ${
                  activeCategory === cat
                    ? "bg-[#00C853] text-white"
                    : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        )}

        {/* Item grid */}
        <div className="flex-1 overflow-y-auto p-3 sm:p-5">
          {loadingItems ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 sm:gap-4">
              {[1,2,3,4,5,6].map(i => (
                <div key={i} className="rounded-2xl overflow-hidden border border-gray-100 animate-pulse">
                  <div className="aspect-[4/3] bg-gray-100" />
                  <div className="p-3 space-y-2">
                    <div className="h-3 bg-gray-100 rounded w-3/4" />
                    <div className="h-3 bg-gray-100 rounded w-1/2" />
                  </div>
                </div>
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-center">
              {search ? (
                <>
                  <Search className="w-10 h-10 text-gray-200 mb-3" />
                  <p className="text-sm text-gray-400">No items match "{search}"</p>
                </>
              ) : (
                <>
                  <UtensilsCrossed className="w-10 h-10 text-gray-200 mb-3" />
                  <p className="font-medium text-gray-500">No items yet</p>
                  <p className="text-sm text-gray-400 mt-1 mb-4">Add your first item to start taking orders</p>
                  <Button onClick={() => setAddingItem(true)} className="serapay-green-button serapay-no-lift bg-gradient-to-r from-[#00D1A0] to-[#00B88A] text-white gap-1.5 shadow-none">
                    <Plus className="w-4 h-4" /> Add Item
                  </Button>
                </>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
              {filtered.map(item => {
                const cartEntry = cart.find(e => e.item.id === item.id);
                return (
                  <ItemTile
                    key={item.id}
                    item={item}
                    cartQty={cartEntry?.qty || 0}
                    onAdd={() => onAddToCart(item)}
                    onRemove={() => onRemoveFromCart(item.id)}
                    onEdit={() => setEditingItem(item)}
                    onDelete={() => handleDeleteItem(item)}
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Right: Cart sidebar */}
      <CartSidebar
        cart={cart}
        activeMenu={menu}
        merchantProfile={merchantProfile}
        onUpdateQty={onUpdateCartQty}
        onClear={onClearCart}
      />

      {mobileCartQty > 0 && (
        <div className="fixed bottom-0 left-0 right-0 z-30 lg:hidden px-4 pb-4 pt-2 bg-gradient-to-t from-[#F5F7FA] to-transparent">
          <button
            onClick={() => setMobileCartOpen(true)}
            className="serapay-green-button mx-auto flex w-full max-w-lg items-center justify-between rounded-2xl bg-gradient-to-r from-[#00D1A0] to-[#00B88A] px-5 py-3.5 text-sm font-semibold text-white shadow-lg"
          >
            <span className="flex items-center gap-2"><ShoppingCart className="w-4 h-4" /> {mobileCartQty} item{mobileCartQty === 1 ? "" : "s"}</span>
            <span>{mobileCartTotal.toFixed(2)} {mobileCartCoin}</span>
          </button>
        </div>
      )}

      {mobileCartOpen && (
        <>
          <div className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm lg:hidden" onClick={() => setMobileCartOpen(false)} />
          <div className="fixed inset-x-0 bottom-0 z-50 lg:hidden">
            <CartSidebar
              cart={cart}
              activeMenu={menu}
              merchantProfile={merchantProfile}
              onUpdateQty={onUpdateCartQty}
              onClear={onClearCart}
              variant="drawer"
              onClose={() => setMobileCartOpen(false)}
            />
          </div>
        </>
      )}

      {/* Dialogs */}
      {editingItem && (
        <ItemEditDialog
          item={editingItem}
          menuId={menu.id}
          onSave={(data) => handleUpdateItem(editingItem, data)}
          onCancel={() => setEditingItem(null)}
          loading={savingItem}
        />
      )}
      {addingItem && (
        <AddItemDialog
          menuId={menu.id}
          onSave={handleAddItem}
          onCancel={() => setAddingItem(false)}
          loading={savingItem}
        />
      )}
      {showQR && <QRSaveModal url={publicUrl} menuName={menu.name} merchantProfile={merchantProfile} onClose={() => setShowQR(false)} />}
      {deleteItemTarget && (
        <DeleteConfirmDialog
          title="Delete menu item?"
          description={`"${deleteItemTarget.name}" will be removed from this menu and any active cart.`}
          confirming={deletingItem}
          onCancel={() => setDeleteItemTarget(null)}
          onConfirm={confirmDeleteItem}
        />
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export function MenuManager() {
  const [menus, setMenus] = useState<Menu[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const [deleteMenuTarget, setDeleteMenuTarget] = useState<Menu | null>(null);
  const [deletingMenu, setDeletingMenu] = useState(false);
  const [renameMenuTarget, setRenameMenuTarget] = useState<Menu | null>(null);
  const [renameMenuName, setRenameMenuName] = useState("");
  const [renamingMenu, setRenamingMenu] = useState(false);
  const [cart, setCart] = useState<CartEntry[]>([]);
  const { apiKey: dashboardApiKey, isAuthenticated } = useAuth();
  const { data: merchantProfile } = useMerchantProfile(dashboardApiKey || undefined);
  const [, navigate] = useLocation();
  const search = useSearch();

  // Restore cart from localStorage
  useEffect(() => {
    try { setCart(readStoredCart()); } catch { localStorage.removeItem(CART_STORAGE_KEY); }
  }, []);

  const persistCart = useCallback((updater: CartEntry[] | ((prev: CartEntry[]) => CartEntry[])) => {
    setCart(prev => {
      const newCart = typeof updater === "function" ? updater(prev) : updater;
      try { writeStoredCart(newCart); } catch {}
      return newCart;
    });
  }, []);

  useEffect(() => {
    if (!isAuthenticated || !dashboardApiKey) {
      setLoading(false);
      return;
    }
    setLoading(true);
    // Read ?menuId= from URL — URL param always wins over the default first-menu selection
    const urlMenuId = new URLSearchParams(search).get("menuId");
    fetchApi<Menu[]>("/menus")
      .then(data => {
        setMenus(data);
        if (urlMenuId && data.some(m => m.id === urlMenuId)) {
          setActiveMenuId(urlMenuId);
        } else if (data.length > 0) {
          setActiveMenuId(data[0].id);
        }
      })
      .catch(e => toast.error(e.message || "Failed to load menus"))
      .finally(() => setLoading(false));
  }, [dashboardApiKey, isAuthenticated, search]);

  const handleAddToCart = (item: MenuItem) => {
    if (isItemSoldOutToday(item)) {
      toast.error("This item is sold out for today");
      return;
    }
    persistCart((prev: CartEntry[]) => {
      const existing = prev.find((e: CartEntry) => e.item.id === item.id);
      if (existing) return prev.map((e: CartEntry) => e.item.id === item.id ? { ...e, qty: e.qty + 1 } : e);
      return [...prev, { item, qty: 1 }];
    });
  };

  const handleRemoveFromCart = (itemId: string) => {
    persistCart((prev: CartEntry[]) => {
      const existing = prev.find((e: CartEntry) => e.item.id === itemId);
      if (!existing) return prev;
      if (existing.qty <= 1) return prev.filter((e: CartEntry) => e.item.id !== itemId);
      return prev.map((e: CartEntry) => e.item.id === itemId ? { ...e, qty: e.qty - 1 } : e);
    });
  };

  const handleUpdateCartQty = (itemId: string, delta: number) => {
    if (delta > 0) {
      const entry = cart.find(e => e.item.id === itemId);
      if (entry && isItemSoldOutToday(entry.item)) {
        toast.error("This item is sold out for today");
        return;
      }
      persistCart((prev: CartEntry[]) => prev.map((e: CartEntry) => e.item.id === itemId ? { ...e, qty: e.qty + 1 } : e));
    } else {
      handleRemoveFromCart(itemId);
    }
  };

  const handleDropFromCart = useCallback((itemId: string) => {
    persistCart((prev: CartEntry[]) => prev.filter((e: CartEntry) => e.item.id !== itemId));
  }, [persistCart]);

  const handleDeleteMenu = async (menuId: string) => {
    const target = menus.find(m => m.id === menuId);
    if (target) setDeleteMenuTarget(target);
  };

  const confirmDeleteMenu = async () => {
    if (!deleteMenuTarget) return;
    setDeletingMenu(true);
    try {
      await fetchApi(`/menus/${deleteMenuTarget.id}`, { method: "DELETE" });
      const updated = menus.filter(m => m.id !== deleteMenuTarget.id);
      setMenus(updated);
      if (activeMenuId === deleteMenuTarget.id) {
        if (updated.length > 0) setActiveMenuId(updated[0].id);
        else navigate("/menu-manager/new");
      }
      toast.success(`"${deleteMenuTarget.name}" deleted`);
      setDeleteMenuTarget(null);
    } catch (e: any) {
      toast.error(e.message || "Failed to delete menu");
    } finally {
      setDeletingMenu(false);
    }
  };

  const handleRenameMenu = async (menuId: string, menuName: string) => {
    const target = menus.find(m => m.id === menuId) || null;
    setRenameMenuTarget(target || { id: menuId, name: menuName, description: null, slug: "", isActive: 1, createdAt: "" });
    setRenameMenuName(menuName);
  };

  const confirmRenameMenu = async () => {
    if (!renameMenuTarget) return;
    const nextName = renameMenuName.trim();
    if (!nextName || nextName === renameMenuTarget.name) {
      setRenameMenuTarget(null);
      return;
    }
    setRenamingMenu(true);
    try {
      const updated = await fetchApi<Menu>(`/menus/${renameMenuTarget.id}`, {
        method: "PUT",
        body: JSON.stringify({ name: nextName }),
      });
      setMenus(prev => prev.map(m => m.id === renameMenuTarget.id ? { ...m, ...updated } : m));
      toast.success(`Renamed to "${nextName}"`);
    } catch (e: any) {
      toast.error(e.message || "Failed to rename menu");
    } finally {
      setRenamingMenu(false);
      setRenameMenuTarget(null);
    }
  };

  const activeMenu = menus.find(m => m.id === activeMenuId) || menus[0] || null;

  // Empty state — no menus yet → redirect to template picker
  useEffect(() => {
    if (!loading && menus.length === 0) navigate("/menu-manager/new");
  }, [loading, menus.length]);

  return (
    <AppLayout noPadding>
      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="w-6 h-6 border-2 border-[#00C853] border-t-transparent rounded-full animate-spin" />
        </div>
      ) : activeMenu ? (
        <POSView
          menu={activeMenu}
          allMenus={menus}
          cart={cart}
          merchantProfile={merchantProfile}
          onSwitchMenu={setActiveMenuId}
          onAddToCart={handleAddToCart}
          onRemoveFromCart={handleRemoveFromCart}
          onUpdateCartQty={handleUpdateCartQty}
          onClearCart={() => persistCart([])}
          onDropFromCart={handleDropFromCart}
          onNewMenu={() => navigate("/menu-manager/new")}
          onRenameMenu={handleRenameMenu}
          onDeleteMenu={handleDeleteMenu}
        />
      ) : null}
      {deleteMenuTarget && (
        <DeleteConfirmDialog
          title="Delete menu?"
          description={`"${deleteMenuTarget.name}" and all items inside it will be removed permanently.`}
          confirming={deletingMenu}
          onCancel={() => setDeleteMenuTarget(null)}
          onConfirm={confirmDeleteMenu}
        />
      )}
      {renameMenuTarget && (
        <RenameMenuDialog
          name={renameMenuName}
          saving={renamingMenu}
          onNameChange={setRenameMenuName}
          onCancel={() => setRenameMenuTarget(null)}
          onConfirm={confirmRenameMenu}
        />
      )}
    </AppLayout>
  );
}
