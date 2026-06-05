import React, { useState, useMemo } from "react";
import { AppLayout } from "@/components/AppLayout";
import { NetworkSwitcherModal, useActiveNetworkMode } from "@/components/NetworkSwitcher";
import { Card, Skeleton, Badge } from "@/components/dashboard-ui";
import { useTransactions } from "@/hooks/use-transactions";
import { useMerchantStats } from "@/hooks/use-stats";
import { formatAmount, getTransactionStatusLabel, shortenAddress } from "@/lib/dashboard-utils";
import { ArrowDownRight, Activity, Clock, CheckCircle2, TrendingUp, QrCode, AlertTriangle, Rocket } from "lucide-react";
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import { format, parseISO, subDays, startOfDay } from "date-fns";

function openPendingPayment(tx: any) {
  if ((tx.status === "pending" || tx.status === "confirming") && tx.paymentUrl) {
    window.location.href = tx.paymentUrl;
  }
}

type ChartRange = "7d" | "30d" | "90d";

export function Dashboard() {
  const { activeMode } = useActiveNetworkMode();
  const activeChainId = activeMode === "live" ? 1 : 11155111;
  const { data: txData, isLoading: txLoading } = useTransactions(500, 0, activeChainId);
  const { data: stats, isLoading: statsLoading } = useMerchantStats(activeChainId);
  const [chartRange, setChartRange] = useState<ChartRange>("7d");
  const [showNetworkModal, setShowNetworkModal] = useState(false);

  const isTestnet = activeMode === "test";

  const isLoading = txLoading || statsLoading;
  const recentTransactions = txData?.transactions ?? [];
  const pendingQueue = recentTransactions.filter((tx) => tx.status === "pending" || tx.status === "confirming");
  const confirmedTransactions = useMemo(() => recentTransactions.filter((tx) => tx.status === "confirmed"), [recentTransactions]);
  const localTotalVolume = useMemo(() => confirmedTransactions.reduce((sum, tx) => {
    const parsed = Number(tx.amountUsd ?? tx.amount ?? 0);
    return Number.isFinite(parsed) && parsed > 0 ? sum + parsed : sum;
  }, 0), [confirmedTransactions]);
  const localDailyVolume = useMemo(() => {
    const dailyMap = new Map<string, number>();
    const now = new Date();
    for (let i = 13; i >= 0; i--) {
      const d = subDays(now, i);
      dailyMap.set(format(d, "yyyy-MM-dd"), 0);
    }
    for (const tx of confirmedTransactions) {
      const day = format(parseISO(tx.createdAt), "yyyy-MM-dd");
      if (dailyMap.has(day)) {
        const parsed = Number(tx.amountUsd ?? tx.amount ?? 0);
        dailyMap.set(day, (dailyMap.get(day) || 0) + (Number.isFinite(parsed) && parsed > 0 ? parsed : 0));
      }
    }
    return Array.from(dailyMap.entries()).map(([date, volume]) => ({ date, volume: volume.toFixed(6) }));
  }, [confirmedTransactions]);
  const backendVolume = Number(stats?.totalVolume ?? 0);
  const displayTotalVolume = (Number.isFinite(backendVolume) && backendVolume > 0 ? stats?.totalVolume : localTotalVolume.toFixed(6)) || "0";
  const displayTotalCount = stats?.totalCount ?? recentTransactions.length;
  const displayConfirmedCount = Math.max(stats?.confirmedCount ?? 0, confirmedTransactions.length);
  const displayPendingCount = Math.max(stats?.pendingCount ?? 0, pendingQueue.length);
  const pendingQueueCount = displayPendingCount;
  const displayDailyVolume = (stats?.dailyVolume || []).some((day) => Number(day.volume) > 0) ? (stats?.dailyVolume || []) : localDailyVolume;

  // Build chart data from all daily volume, filtered by selected range
  const chartData = useMemo(() => {
    const allDaily = displayDailyVolume.map((d) => ({
      date: format(parseISO(d.date), "MMM dd"),
      isoDate: d.date,
      amount: parseFloat(d.volume),
    }));

    const days = chartRange === "7d" ? 7 : chartRange === "30d" ? 30 : 90;
    const cutoff = startOfDay(subDays(new Date(), days - 1));

    const filtered = allDaily.filter((d) => new Date(d.isoDate) >= cutoff);

    // If we have fewer data points than the range, pad with zeros from the cutoff
    if (filtered.length < days) {
      const existingDates = new Set(filtered.map((d) => d.isoDate));
      const padded: typeof filtered = [];
      for (let i = days - 1; i >= 0; i--) {
        const d = subDays(new Date(), i);
        const iso = format(d, "yyyy-MM-dd");
        if (!existingDates.has(iso)) {
          padded.push({ date: format(d, "MMM dd"), isoDate: iso, amount: 0 });
        }
      }
      return [...padded, ...filtered].sort((a, b) => a.isoDate.localeCompare(b.isoDate));
    }

    return filtered;
  }, [displayDailyVolume, chartRange]);

  return (
    <AppLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight mb-0.5">Overview</h1>
          <p className="text-muted-foreground text-sm">Real-time peer-to-peer payment monitoring</p>
        </div>

        {/* Go Live banner — shown only on Sepolia */}
        {isTestnet && (
          <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-9 h-9 rounded-lg bg-amber-100 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-4.5 h-4.5 text-amber-600" />
              </div>
              <div className="min-w-0">
                <p className="font-semibold text-sm text-amber-900">You're on Sepolia Testnet</p>
                <p className="text-xs text-amber-700 mt-0.5 leading-relaxed">
                  Transactions have no real value. Switch to Ethereum Mainnet to accept real payments from customers.
                </p>
              </div>
            </div>
            <button
              onClick={() => setShowNetworkModal(true)}
              className="shrink-0 flex items-center gap-1.5 bg-amber-500 hover:bg-amber-600 text-white text-xs font-semibold px-3.5 py-2 rounded-lg transition-colors whitespace-nowrap"
            >
              <Rocket className="w-3.5 h-3.5" />
              Go Live
            </button>
          </div>
        )}

        {/* SeraPay QR Guide */}
        <div className="rounded-xl border border-[#00D1A0]/30 bg-gradient-to-r from-[#00D1A0]/8 to-[#00B88A]/5 p-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-lg bg-[#00D1A0]/15 flex items-center justify-center shrink-0">
              <QrCode className="w-5 h-5 text-[#00B88A]" />
            </div>
            <div className="min-w-0">
              <p className="font-semibold text-sm text-foreground">Generate QR code</p>
              <p className="text-xs text-muted-foreground mt-0.5 truncate">Use SeraPay to create a QR code and start accepting stablecoin payments</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => window.dispatchEvent(new Event("serapay:new-payment"))}
            className="shrink-0 flex items-center gap-1.5 bg-[#00D1A0] hover:bg-[#00B88A] text-white text-xs font-semibold px-3.5 py-2 rounded-lg transition-colors whitespace-nowrap"
          >
            Generate QR code
          </button>
        </div>

        {/* Stat cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard title="Volume" value={`$${formatAmount(displayTotalVolume)}`} icon={TrendingUp} loading={isLoading} />
          <StatCard title="Transactions" value={displayTotalCount.toString()} icon={Activity} loading={isLoading} />
          <StatCard title="Successful" value={displayConfirmedCount.toString()} icon={CheckCircle2} loading={isLoading} valueColor="text-[#00D1A0]" />
          <StatCard title="Pending" value={displayPendingCount.toString()} icon={Clock} loading={isLoading} valueColor="text-amber-600" />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Volume chart with range switcher */}
          <Card className="col-span-1 lg:col-span-2 p-5 flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-medium text-sm">Volume</h3>
              {/* Range tabs */}
              <div className="flex items-center bg-muted rounded-lg p-0.5 gap-0.5">
                {(["7d", "30d", "90d"] as ChartRange[]).map((r) => (
                  <button
                    key={r}
                    onClick={() => setChartRange(r)}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                      chartRange === r
                        ? "bg-white text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {r === "7d" ? "7D" : r === "30d" ? "30D" : "90D"}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex-1 min-h-[280px] w-full">
              {isLoading ? (
                <Skeleton className="w-full h-full rounded-xl" />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                    <defs>
                      <linearGradient id="colorAmount" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#00D1A0" stopOpacity={0.15}/>
                        <stop offset="95%" stopColor="#00D1A0" stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                    <XAxis
                      dataKey="date"
                      axisLine={false}
                      tickLine={false}
                      tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                      dy={10}
                      interval={chartRange === "7d" ? 0 : chartRange === "30d" ? 4 : 9}
                    />
                    <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} tickFormatter={(val) => `$${val}`} />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#fff', borderColor: 'hsl(var(--border))', borderRadius: '8px', fontSize: '13px' }}
                      formatter={(val: number) => [`$${formatAmount(val)}`, 'Volume']}
                    />
                    <Area type="monotone" dataKey="amount" stroke="#00D1A0" strokeWidth={2} fillOpacity={1} fill="url(#colorAmount)" />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
          </Card>

          {/* Live feed */}
          <Card className="col-span-1 p-5 flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-medium text-sm">Live Feed</h3>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#00D1A0] opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-[#00D1A0]"></span>
                </span>
                Live
              </div>
            </div>

            <div className="flex-1 overflow-auto space-y-2">
              {txLoading ? (
                Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-14 w-full rounded-lg" />)
              ) : (
                <>
                  {pendingQueueCount > 0 && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                          <Clock className="w-4 h-4 text-amber-600" />
                          <p className="text-sm font-semibold text-amber-900">Processing transactions</p>
                        </div>
                        <Badge variant="warning" className="text-[10px]">{pendingQueueCount} in queue</Badge>
                      </div>
                      <p className="mt-1 text-[11px] text-amber-700">Requests cancel automatically after 5 minutes without completion.</p>
                    </div>
                  )}
                  {recentTransactions.slice(0, 10).map((tx) => {
                    const isConfirmed = tx.status === "confirmed";
                    const isPending = tx.status === "pending" || tx.status === "confirming";
                    const fromAddress = tx.fromAddress ?? tx.from ?? "";
                    return (
                      <div
                        key={tx.id}
                        onClick={() => openPendingPayment(tx)}
                        className={`flex items-center justify-between p-3 rounded-lg border border-border transition-all duration-200 ease-in-out hover:border-[#00C853]/60 hover:bg-accent/50 hover:shadow-sm ${isPending && tx.paymentUrl ? "cursor-pointer" : ""}`}
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div className={`w-8 h-8 rounded-full flex items-center justify-center ${isConfirmed ? 'bg-[#E6FAF5] text-[#00D1A0]' : isPending ? 'bg-amber-50 text-amber-600' : tx.status === 'canceled' ? 'bg-gray-100 text-gray-500' : 'bg-red-50 text-red-600'}`}>
                            {isConfirmed ? <ArrowDownRight className="w-4 h-4" /> : <Clock className="w-4 h-4" />}
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm font-medium leading-none mb-0.5">
                              {isConfirmed ? `+${formatAmount(tx.amount)} ${tx.coin}` : `${formatAmount(tx.amount)} ${tx.coin}`}
                            </p>
                            <p className="text-[11px] text-muted-foreground truncate">
                              {tx.status === "confirming" ? "Processing payment" : tx.status === "pending" ? "Pending request" : fromAddress ? shortenAddress(fromAddress) : tx.status === "canceled" ? "Canceled request" : "Failed request"}
                            </p>
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <Badge variant={isConfirmed ? "success" : isPending ? "warning" : tx.status === "canceled" ? "default" : "destructive"} className="text-[10px] capitalize">
                            {getTransactionStatusLabel(tx.status)}
                          </Badge>
                          <p className="text-[10px] text-muted-foreground mt-0.5">
                            {format(parseISO(tx.createdAt), 'HH:mm')}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </>
              )}

              {!txLoading && recentTransactions.length === 0 && (
                <div className="h-full flex flex-col items-center justify-center text-muted-foreground py-10">
                  <Activity className="w-8 h-8 mb-2 opacity-20" />
                  <p className="text-sm">Waiting for payments...</p>
                </div>
              )}
            </div>
          </Card>
        </div>
      </div>

      {showNetworkModal && <NetworkSwitcherModal onClose={() => setShowNetworkModal(false)} />}
    </AppLayout>
  );
}

function StatCard({ title, value, icon: Icon, loading, valueColor = "text-foreground" }: { title: string, value: string, icon: any, loading: boolean, valueColor?: string }) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
        <Icon className="w-4 h-4 text-[#00D1A0]/50" />
      </div>
      {loading ? (
        <Skeleton className="h-7 w-20" />
      ) : (
        <div className={`text-2xl font-semibold tracking-tight font-mono ${valueColor}`}>{value}</div>
      )}
    </Card>
  );
}
