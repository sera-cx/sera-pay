import { useState, useEffect } from "react";
import { useLocation, useSearch } from "wouter";
import { ArrowLeft, Plus, X, GripVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AppLayout } from "@/components/AppLayout";
import { MENU_TEMPLATES, SCRATCH_TEMPLATE } from "@/lib/menuTemplates";
import { fetchApi } from "@/lib/api";
import { STABLECOINS } from "@/lib/stablecoins";
import { AdvancedSelect } from "@/components/AdvancedSelect";
import { limitDecimalPlaces, normalizeDecimalAmountText } from "@/lib/decimalInput";

interface EditableItem {
  name: string;
  description: string;
  category: string;
  price: string;
  coin: string;
}

const COINS = STABLECOINS.map(coin => coin.symbol);

export default function MenuCreatePage() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const params = new URLSearchParams(search);
  const templateId = params.get("template") || "scratch";

  const template = templateId === "scratch" ? SCRATCH_TEMPLATE : MENU_TEMPLATES.find(t => t.id === templateId) || MENU_TEMPLATES[0];

  const [menuName, setMenuName] = useState(template.id === "scratch" ? "" : template.defaultMenuName);
  const [description, setDescription] = useState("");
  const [items, setItems] = useState<EditableItem[]>(
    template.id === "scratch"
      ? [{ name: "", description: "", category: "", price: "", coin: "USDC" }]
      : template.items.map(i => ({ name: i.name, description: i.description || "", category: i.category || "", price: i.price, coin: i.coin }))
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const addItem = () => setItems(prev => [...prev, { name: "", description: "", category: "", price: "", coin: "USDC" }]);
  const removeItem = (idx: number) => setItems(prev => prev.filter((_, i) => i !== idx));
  const updateItem = (idx: number, field: keyof EditableItem, value: string) => {
    setItems(prev => prev.map((item, i) => i === idx ? { ...item, [field]: field === "price" ? limitDecimalPlaces(value) : value } : item));
  };

  const handleCreate = async () => {
    if (!menuName.trim()) { setError("Menu name is required"); return; }
    if (items.length === 0) { setError("Add at least one item"); return; }
    const invalidIndex = items.findIndex(i => !i.name.trim() || !i.category.trim() || !i.coin.trim() || !normalizeDecimalAmountText(i.price));
    if (invalidIndex >= 0) {
      setError(`Item ${invalidIndex + 1} needs a name, category, price greater than 0, and coin`);
      return;
    }
    const validItems = items.map(i => ({
      name: i.name.trim(),
      description: i.description.trim(),
      category: i.category.trim(),
      price: normalizeDecimalAmountText(i.price),
      coin: i.coin.trim(),
    }));
    setSaving(true);
    setError("");
    try {
      const menu = await fetchApi<{ id: string }>("/menus", {
        method: "POST",
        body: JSON.stringify({ name: menuName.trim(), description: description.trim() || undefined }),
      });
      if (validItems.length > 0) {
        await fetchApi(`/menus/${menu.id}/items/batch`, {
          method: "POST",
          body: JSON.stringify({ items: validItems }),
        });
      }
      navigate(`/menu-manager/pos?menuId=${menu.id}`);
    } catch (e: any) {
      setError(e.message || "Failed to create menu");
      setSaving(false);
    }
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[#F5F7FA]">
        {/* Header */}
        <div className="bg-white border-b border-gray-100 sticky top-0 z-10">
          <div className="max-w-3xl mx-auto px-6 py-4 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <button
                onClick={() => navigate("/menu-manager")}
                className="p-2 rounded-xl text-gray-500 hover:bg-gray-100 transition-colors"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
              <div className="flex items-center gap-2">
                <span className="text-2xl">{template.emoji}</span>
                <div>
                  <h1 className="text-lg font-bold text-gray-900">{template.label}</h1>
                  <p className="text-xs text-gray-500">{template.id === "scratch" ? "Build from scratch" : `${items.length} preset items — edit before creating`}</p>
                </div>
              </div>
            </div>
            <Button
              onClick={handleCreate}
              disabled={saving}
              className="serapay-green-button bg-gradient-to-r from-[#00D1A0] to-[#00B88A] text-white font-semibold px-5"
            >
              {saving ? "Creating…" : `Create Menu (${items.filter(i => i.name.trim()).length} items)`}
            </Button>
          </div>
        </div>

        <div className="max-w-3xl mx-auto px-6 py-6 space-y-6">
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3">
              {error}
            </div>
          )}

          {/* Menu name + description */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-4">
            <div>
              <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">Menu Name</label>
              <Input
                value={menuName}
                onChange={e => setMenuName(e.target.value)}
                placeholder="e.g. Lunch Menu, Event Day Menu"
                className="text-base font-medium"
                maxLength={120}
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">Description (optional)</label>
              <Input
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="Short description for your customers"
                maxLength={500}
              />
            </div>
          </div>

          {/* Items */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-50">
              <h2 className="font-semibold text-gray-900">Items <span className="text-gray-400 font-normal text-sm">({items.length})</span></h2>
              <button
                onClick={addItem}
                className="flex items-center gap-1.5 text-sm font-semibold text-[#00A87A] hover:text-[#00C853] transition-colors"
              >
                <Plus className="w-4 h-4" />
                Add item
              </button>
            </div>

            <div className="divide-y divide-gray-50">
              {items.map((item, idx) => (
                <div key={idx} className="px-6 py-4 flex gap-3 items-start group">
                  <div className="pt-2 text-gray-300 group-hover:text-gray-400 cursor-grab shrink-0">
                    <GripVertical className="w-4 h-4" />
                  </div>
                  <div className="flex-1 grid grid-cols-1 gap-2">
                    <Input
                      value={item.name}
                      onChange={e => updateItem(idx, "name", e.target.value)}
                      placeholder="Item name"
                      className="font-medium"
                    />
                    <Input
                      value={item.description}
                      onChange={e => updateItem(idx, "description", e.target.value)}
                      placeholder="Description (optional)"
                      className="text-sm text-gray-600"
                    />
                    <Input
                      value={item.category}
                      onChange={e => updateItem(idx, "category", e.target.value)}
                      placeholder="Category"
                      className="text-sm"
                      maxLength={60}
                    />
                    <div className="flex gap-2">
                      <Input
                        value={item.price}
                        onChange={e => updateItem(idx, "price", e.target.value)}
                        placeholder="0.00"
                        type="text"
                        min="0.01"
                        step="0.01"
                        className="w-28 font-mono"
                        inputMode="decimal"
                      />
                      <AdvancedSelect
                        value={item.coin}
                        onValueChange={value => updateItem(idx, "coin", value)}
                        options={COINS.map(c => ({ value: c, label: c }))}
                        className="flex-1"
                        triggerClassName="h-10 rounded-lg"
                      />
                    </div>
                  </div>
                  <button
                    onClick={() => removeItem(idx)}
                    className="pt-2 text-gray-300 hover:text-red-400 transition-colors shrink-0"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>

            <div className="px-6 py-4 border-t border-gray-50">
              <button
                onClick={addItem}
                className="w-full flex items-center justify-center gap-2 text-sm text-gray-500 hover:text-[#00A87A] transition-colors py-2 rounded-xl border-2 border-dashed border-gray-200 hover:border-[#00C853]/40"
              >
                <Plus className="w-4 h-4" />
                Add another item
              </button>
            </div>
          </div>

          <div className="flex justify-end pb-8">
            <Button
              onClick={handleCreate}
              disabled={saving}
              size="lg"
              className="serapay-green-button bg-gradient-to-r from-[#00D1A0] to-[#00B88A] text-white font-semibold px-8"
            >
              {saving ? "Creating…" : `Create Menu with ${items.filter(i => i.name.trim()).length} items`}
            </Button>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
