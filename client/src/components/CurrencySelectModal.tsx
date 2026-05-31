import { Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { groupCurrenciesByRegion, type SeraCurrency } from "@/lib/currencyCalculator";

function CurrencyMark({ coin }: { coin: SeraCurrency }) {
  const logo = coin.logoUri || (/^https?:\/\//.test(coin.icon) ? coin.icon : undefined);
  if (logo) {
    return <img src={logo} alt={`${coin.symbol} logo`} className="h-7 w-7 rounded-full object-cover" />;
  }
  return <span className="flex h-7 w-7 items-center justify-center text-lg leading-none">{coin.icon}</span>;
}

export function CurrencySelectModal({
  title,
  subtitle,
  currencies,
  selectedSymbol,
  onSelect,
  onClose,
  onConfirm,
  confirmLabel,
  confirming = false,
}: {
  title: string;
  subtitle?: string;
  currencies: SeraCurrency[];
  selectedSymbol: string;
  onSelect: (symbol: string) => void;
  onClose: () => void;
  onConfirm?: () => void;
  confirmLabel?: string;
  confirming?: boolean;
}) {
  const groups = groupCurrenciesByRegion(currencies);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3 sm:p-4">
      <div className="flex max-h-[88dvh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-gray-100 px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-base font-bold text-gray-900">{title}</h2>
            {subtitle ? <p className="mt-0.5 text-xs text-gray-500">{subtitle}</p> : null}
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600" aria-label="Close currency selector">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4 pb-5">
          {Object.entries(groups).map(([region, coins]) => (
            <div key={region}>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">{region}</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {coins.map((coin) => {
                  const selected = selectedSymbol === coin.symbol;
                  return (
                    <button
                      key={coin.symbol}
                      onClick={() => onSelect(coin.symbol)}
                      className={`flex min-w-0 items-center gap-2 rounded-xl border-2 px-3 py-2 text-left transition-all ${
                        selected ? "border-[#00C853] bg-[#F0FFF6]" : "border-gray-200 hover:border-gray-300"
                      }`}
                    >
                      <CurrencyMark coin={coin} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-semibold text-gray-900">{coin.symbol}</div>
                        <div className="truncate text-xs text-gray-400">{coin.name}</div>
                      </div>
                      {selected ? <Check className="h-3.5 w-3.5 flex-shrink-0 text-[#00C853]" /> : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {onConfirm ? (
          <div className="grid grid-cols-2 gap-3 border-t border-gray-100 bg-white px-5 py-4">
            <Button variant="outline" onClick={onClose} className="h-11 bg-white">Cancel</Button>
            <Button onClick={onConfirm} disabled={confirming} className="h-11 gap-2 bg-[#00C853] text-white hover:bg-[#00B847]">
              {confirming ? <span className="h-4 w-4 rounded-full border-2 border-white border-t-transparent animate-spin" /> : <Check className="h-4 w-4" />}
              <span className="truncate">{confirmLabel || `Use ${selectedSymbol}`}</span>
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}