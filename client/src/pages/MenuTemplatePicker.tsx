import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { MENU_TEMPLATES, SCRATCH_TEMPLATE } from "@/lib/menuTemplates";
import { AppLayout } from "@/components/AppLayout";
import { fetchApi } from "@/lib/api";
import { toast } from "sonner";
import { X, ArrowLeft, Check } from "lucide-react";
import { convertAmount, getCurrencyRate, groupCurrenciesByRegion, loadSeraCurrencies, type SeraCurrency } from "@/lib/currencyCalculator";
import { AdvancedSelect } from "@/components/AdvancedSelect";
import { BUSINESS_CATEGORY_GROUPS, businessCategoryLabel } from "@/lib/businessCategories";

type Step = "template" | "details" | "currency";

const TEMPLATE_BUSINESS_CATEGORY: Record<string, string> = {
  restaurant: "Restaurant",
  cafe: "Cafe",
  hawker: "Hawker / Street Food",
  bubble_tea: "Cafe",
  electronics: "Electronics",
  retail: "Retail",
  fashion: "Fashion",
};

export default function MenuTemplatePicker() {
  const [, navigate] = useLocation();
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [hasMenus, setHasMenus] = useState(false);
  const [currencies, setCurrencies] = useState<SeraCurrency[]>([]);

  // Two-step state
  const [step, setStep] = useState<Step>("template");
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [scratchMenuName, setScratchMenuName] = useState("");
  const [businessCategory, setBusinessCategory] = useState("Restaurant");
  const [businessCategoryOther, setBusinessCategoryOther] = useState("");
  const [selectedCoin, setSelectedCoin] = useState<string>(() => {
    // Default to merchant's saved receive coin
    try {
      const wallet = localStorage.getItem("serapay_dashboard_wallet");
      if (wallet) {
        const saved = localStorage.getItem(`serapay_coin_${wallet}`);
        if (saved) return saved;
      }
    } catch {}
    return "USDC";
  });
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    fetchApi<{ id: string }[]>("/menus")
      .then(menus => setHasMenus(menus.length > 0))
      .catch(() => {});
    loadSeraCurrencies().then(setCurrencies).catch(() => setCurrencies([]));
  }, []);
  const currencyGroups = groupCurrenciesByRegion(currencies);

  const handleSelectTemplate = (templateId: string) => {
    if (creating) return;
    setSelectedTemplateId(templateId);
    if (templateId === "scratch") {
      setStep("details");
      return;
    }
    setBusinessCategory(TEMPLATE_BUSINESS_CATEGORY[templateId] || "Others");
    setStep("currency");
  };

  const createMenu = async (templateId: string, coin: string) => {
    if (creating) return;
    const template = templateId === "scratch" ? SCRATCH_TEMPLATE : MENU_TEMPLATES.find(t => t.id === templateId);
    if (!template) return;

    setCreating(true);
    try {
      const customCategory = businessCategory === "Others" ? businessCategoryOther.trim() : "";
      const fallbackName = customCategory || businessCategoryLabel(businessCategory) || "Menu";
      const menuName = templateId === "scratch" ? scratchMenuName.trim() || fallbackName : template.defaultMenuName;
      const resolvedCategory = businessCategory === "Others" ? "Others" : businessCategory;
      const menu = await fetchApi<{ id: string; name: string }>("/menus", {
        method: "POST",
        body: JSON.stringify({
          name: menuName,
          businessCategory: resolvedCategory,
          businessCategoryOther: businessCategory === "Others" ? businessCategoryOther.trim() : undefined,
        }),
      });

      if (template.items.length > 0) {
        const sourceCoin = template.items[0]?.coin || "USDC";
        const rate = sourceCoin === coin ? 1 : (await getCurrencyRate(sourceCoin, coin)).rate;
        const convertedItems = template.items.map((item) => ({ ...item, price: convertAmount(item.price, rate), coin }));
        await Promise.all(
          convertedItems.map((item, idx) =>
            fetchApi(`/menus/${menu.id}/items`, {
              method: "POST",
              body: JSON.stringify({
                name: item.name,
                description: item.description || null,
                price: item.price,
                coin,
                category: (item as any).category || null,
                sortOrder: idx,
              }),
            })
          )
        );
      }

      navigate(`/menu-manager/pos?menuId=${menu.id}`);
    } catch (e: any) {
      toast.error(e.message || "Failed to create menu");
      setCreating(false);
    }
  };

  const handleConfirmCurrency = () => {
    if (selectedTemplateId) createMenu(selectedTemplateId, selectedCoin);
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[#F5F7FA]">
        {/* Header */}
        <div className="bg-white border-b border-gray-100 sticky top-0 z-10">
          <div className="max-w-5xl mx-auto px-6 py-4 flex items-center gap-3">
            {step !== "template" && (
              <button
                onClick={() => setStep("template")}
                disabled={creating}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium text-gray-500 hover:text-gray-700 hover:bg-gray-100 transition-colors disabled:opacity-50"
              >
                <ArrowLeft className="w-4 h-4" />
                Back
              </button>
            )}
            <div className="flex-1">
              {step === "template" ? (
                <>
                  <h1 className="text-xl font-bold text-gray-900">Choose a Template</h1>
                  <p className="text-sm text-gray-500">Pick a category to get started instantly, or build from scratch.</p>
                </>
              ) : step === "details" ? (
                <>
                  <h1 className="text-xl font-bold text-gray-900">Start from Scratch</h1>
                  <p className="text-sm text-gray-500">Create an empty menu with your business category.</p>
                </>
              ) : (
                <>
                  <h1 className="text-xl font-bold text-gray-900">Choose Currency</h1>
                  <p className="text-sm text-gray-500">
                    Template prices are converted from USDC into <span className="font-semibold text-gray-700">{selectedCoin}</span> using Sera rates.
                  </p>
                </>
              )}
            </div>
            {step === "template" && (
              <>
                {hasMenus && (
                  <button
                    onClick={() => navigate("/menu-manager/pos")}
                    disabled={creating}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium text-gray-500 hover:text-gray-700 hover:bg-gray-100 transition-colors disabled:opacity-50"
                  >
                    <X className="w-4 h-4" />
                    Cancel
                  </button>
                )}
                <button
                  onClick={() => handleSelectTemplate("scratch")}
                  disabled={creating}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl border-2 border-dashed border-gray-300 text-sm font-medium text-gray-600 hover:border-[#00C853] hover:text-[#00A87A] hover:bg-[#F0FFF6] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {creating && selectedTemplateId === "scratch" ? (
                    <span className="w-4 h-4 border-2 border-[#00C853] border-t-transparent rounded-full animate-spin" />
                  ) : (
                    <span className="text-lg leading-none">✏️</span>
                  )}
                  Start from Scratch
                </button>
              </>
            )}
            {step === "currency" && (
              <button
                onClick={handleConfirmCurrency}
                disabled={creating}
                className="flex items-center gap-2 px-5 py-2 rounded-xl bg-[#00C853] text-white text-sm font-semibold hover:bg-[#00A844] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {creating ? (
                  <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                ) : (
                  <Check className="w-4 h-4" />
                )}
                Create Menu
              </button>
            )}
            {step === "details" && (
              <button
                onClick={() => createMenu("scratch", selectedCoin)}
                disabled={creating || (businessCategory === "Others" && !businessCategoryOther.trim())}
                className="flex items-center gap-2 px-5 py-2 rounded-xl bg-[#00C853] text-white text-sm font-semibold hover:bg-[#00A844] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {creating ? <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <Check className="w-4 h-4" />}
                Create
              </button>
            )}
          </div>
        </div>

        {/* Step 1: Template Grid */}
        {step === "template" && (
          <div className="max-w-5xl mx-auto px-6 py-8">
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
              {MENU_TEMPLATES.filter(t => t.id !== "scratch").map(template => {
                const isHovered = hoveredId === template.id;
                return (
                  <button
                    key={template.id}
                    onClick={() => handleSelectTemplate(template.id)}
                    onMouseEnter={() => setHoveredId(template.id)}
                    onMouseLeave={() => setHoveredId(null)}
                    disabled={creating}
                    className={`
                      relative flex flex-col items-center text-center p-6 rounded-2xl border-2 transition-all duration-150
                      ${isHovered && !creating
                        ? "border-[#00C853] bg-[#F0FFF6] shadow-md scale-[1.02]"
                        : "border-gray-200 bg-white hover:border-gray-300 shadow-sm"
                      }
                      ${creating ? "opacity-50 cursor-not-allowed" : ""}
                    `}
                  >
                    <div className="text-5xl mb-3 leading-none">{template.emoji}</div>
                    <h3 className="font-bold text-gray-900 text-sm leading-tight mb-1">{template.label} (Template)</h3>
                    <p className="text-xs text-gray-500 mb-2 leading-relaxed">{template.description}</p>
                    <span className="text-xs text-gray-400 font-medium">
                      {template.items.length} preset items
                    </span>
                    {isHovered && !creating && (
                      <div className="absolute inset-0 rounded-2xl flex items-center justify-center bg-[#00C853]/10">
                        <span className="bg-[#00C853] text-white text-xs font-bold px-3 py-1.5 rounded-full shadow">
                          Use Template
                        </span>
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Step 2: Scratch Details */}
        {step === "details" && (
          <div className="max-w-2xl mx-auto px-6 py-8">
            <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-6 space-y-5">
              <div>
                <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">Menu Name</label>
                <input
                  value={scratchMenuName}
                  onChange={e => setScratchMenuName(e.target.value)}
                  placeholder="Leave blank to use the business category"
                  maxLength={120}
                  className="w-full h-11 rounded-xl border border-gray-200 px-3 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-[#00C853]/30 focus:border-[#00C853]"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">Business Category</label>
                <AdvancedSelect
                  value={businessCategory}
                  onValueChange={setBusinessCategory}
                  groups={BUSINESS_CATEGORY_GROUPS}
                  placeholder="Select business category"
                />
              </div>
              {businessCategory === "Others" && (
                <div>
                  <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">Other Category</label>
                  <input
                    value={businessCategoryOther}
                    onChange={e => setBusinessCategoryOther(e.target.value)}
                    placeholder="e.g. Salon, clinic, workshop"
                    maxLength={120}
                    className="w-full h-11 rounded-xl border border-gray-200 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#00C853]/30 focus:border-[#00C853]"
                  />
                </div>
              )}
            </div>
          </div>
        )}

        {/* Step 3: Currency Picker */}
        {step === "currency" && (
          <div className="max-w-3xl mx-auto px-6 py-8">
            {Object.entries(currencyGroups).map(([region, coins]) => (
                <div key={region} className="mb-6">
                  <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">{region}</h3>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                    {coins.map(coin => {
                      const isSelected = selectedCoin === coin.symbol;
                      return (
                        <button
                          key={coin.symbol}
                          onClick={() => setSelectedCoin(coin.symbol)}
                          disabled={creating}
                          className={`
                            flex items-center gap-2.5 px-3 py-2.5 rounded-xl border-2 text-left transition-all
                            ${isSelected
                              ? "border-[#00C853] bg-[#F0FFF6] shadow-sm"
                              : "border-gray-200 bg-white hover:border-gray-300"
                            }
                            disabled:opacity-50 disabled:cursor-not-allowed
                          `}
                        >
                          <span className="text-xl leading-none">{coin.icon}</span>
                          <div className="min-w-0">
                            <div className="font-semibold text-gray-900 text-sm leading-tight">{coin.symbol}</div>
                            <div className="text-xs text-gray-400 truncate">{coin.name}</div>
                          </div>
                          {isSelected && (
                            <Check className="w-4 h-4 text-[#00C853] ml-auto flex-shrink-0" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
            ))}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
