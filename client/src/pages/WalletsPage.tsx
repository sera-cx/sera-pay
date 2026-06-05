import React, { useState } from "react";
import { AppLayout } from "@/components/AppLayout";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Skeleton } from "@/components/dashboard-ui";
import { useCreateSubWallet, useDeleteSubWallet, useSetDefaultWallet, useSeraApiConfig, useWallets } from "@/hooks/use-gateway";
import { useMerchantStats } from "@/hooks/use-stats";
import { cn, formatAmount } from "@/lib/dashboard-utils";
import { useToast } from "@/components/toast-system";
import { resolvePaymentChainId } from "@/lib/payment";
import { AlertTriangle, CheckCircle2, Copy, Landmark, Plus, Trash2, Wallet, X } from "lucide-react";
import { useChainId } from "wagmi";

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function HighlightedWalletAddress({ address, className }: { address: string; className?: string }) {
  const value = String(address || "");
  if (value.length <= 12) {
    return <span className={cn("font-mono text-[#0A1F1A]", className)}>{value}</span>;
  }
  const start = value.slice(0, 6);
  const middle = value.slice(6, -6);
  const end = value.slice(-6);
  return (
    <span className={cn("font-mono break-all", className)}>
      <span className="font-semibold text-[#0A1F1A]">{start}</span>
      <span className="text-muted-foreground">{middle}</span>
      <span className="font-semibold text-[#0A1F1A]">{end}</span>
    </span>
  );
}

export function Wallets() {
  const { data, isLoading, error } = useWallets();
  const { data: stats } = useMerchantStats();
  const { data: seraConfig } = useSeraApiConfig();
  const createSubWallet = useCreateSubWallet();
  const deleteSubWallet = useDeleteSubWallet();
  const setDefaultWallet = useSetDefaultWallet();
  const { toast } = useToast();
  const walletChainId = useChainId();
  const paymentChainId = resolvePaymentChainId(walletChainId, seraConfig?.mode);
  const [label, setLabel] = useState("");
  const [address, setAddress] = useState("");
  const [showAddWallet, setShowAddWallet] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; label: string } | null>(null);

  const copy = async (value: string) => {
    await navigator.clipboard.writeText(value);
    toast({ title: "Copied", type: "success" });
  };

  const handleCreate = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmedLabel = label.trim();
    const trimmedAddress = address.trim();
    const inheritedCoin = (data?.masterWallet?.receiveCoin || "USDC").trim().toUpperCase();
    if (!trimmedLabel) {
      toast({ title: "Label is required", description: "Add a clear name for this wallet.", type: "error" });
      return;
    }
    if (!trimmedAddress) {
      toast({ title: "Address is required", description: "Enter the wallet address you control.", type: "error" });
      return;
    }
    if (!EVM_ADDRESS.test(trimmedAddress)) {
      toast({ title: "Invalid address", description: "Enter a controlled EVM address.", type: "error" });
      return;
    }
    createSubWallet.mutate(
      { label: trimmedLabel, address: trimmedAddress, receiveCoin: inheritedCoin, chainId: paymentChainId },
      {
        onSuccess: () => {
          setLabel("");
          setAddress("");
          setShowAddWallet(false);
          toast({ title: "Sub-wallet added", type: "success" });
        },
        onError: (err: any) => toast({ title: "Could not add sub-wallet", description: err.message, type: "error" }),
      }
    );
  };

  const handleSetDefault = (walletId: string) => {
    setDefaultWallet.mutate(walletId, {
      onSuccess: () => toast({ title: "Default wallet updated", type: "success" }),
      onError: (err: any) => toast({ title: "Could not set default wallet", description: err.message, type: "error" }),
    });
  };

  const handleDelete = () => {
    if (!deleteTarget) return;
    deleteSubWallet.mutate(deleteTarget.id, {
      onSuccess: () => {
        toast({ title: "Sub-wallet deleted", type: "success" });
        setDeleteTarget(null);
      },
      onError: (err: any) => toast({ title: "Could not delete sub-wallet", description: err.message, type: "error" }),
    });
  };

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-xl font-semibold mb-0.5">Wallets</h1>
            <p className="text-muted-foreground text-sm">Master settlement wallet and merchant-controlled receiving addresses</p>
          </div>
          <Button type="button" size="sm" onClick={() => setShowAddWallet(true)} className="gap-1.5 bg-[#00D1A0] text-white hover:bg-[#00B88A] sm:self-start">
            <Plus className="w-3.5 h-3.5" />
            Add Wallet+
          </Button>
        </div>

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            Failed to load wallets.
          </div>
        )}

        <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Landmark className="w-4 h-4 text-[#00D1A0]" />
                <CardTitle>Master Wallet</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <Skeleton className="h-28 w-full" />
              ) : data?.masterWallet ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <Metric label="Successful volume" value={`$${formatAmount(stats?.totalVolume || "0")}`} />
                    <Metric label="Transactions" value={(stats?.totalCount || 0).toString()} />
                  </div>
                  <div className="rounded-xl border border-border p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="mb-1 flex flex-wrap items-center gap-2">
                          <p className="text-xs text-muted-foreground">Master address</p>
                          {data.masterWallet.isDefault ? <Badge variant="success">Default</Badge> : null}
                        </div>
                        <p className="text-sm">
                          <HighlightedWalletAddress address={data.masterWallet.settlementAddress} />
                        </p>
                        {data.masterWallet.settlementAddress.toLowerCase() !== data.masterWallet.address.toLowerCase() ? (
                          <p className="mt-1 text-xs text-muted-foreground">Receiving through selected default wallet.</p>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {!data.masterWallet.isDefault ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={setDefaultWallet.isPending}
                            onClick={() => handleSetDefault("master")}
                            className="hidden bg-white sm:inline-flex"
                          >
                            Set as Default
                          </Button>
                        ) : null}
                        <button
                          onClick={() => copy(data.masterWallet.settlementAddress)}
                          className="w-9 h-9 rounded-lg border border-border flex items-center justify-center hover:bg-muted"
                          title="Copy settlement address"
                        >
                          <Copy className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                    {!data.masterWallet.isDefault ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={setDefaultWallet.isPending}
                        onClick={() => handleSetDefault("master")}
                        className="mt-3 w-full bg-white sm:hidden"
                      >
                        Set as Default
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Wallet className="w-4 h-4 text-[#00D1A0]" />
                <CardTitle>Sub-wallets</CardTitle>
              </div>
              <Button type="button" size="sm" variant="outline" onClick={() => setShowAddWallet(true)} className="gap-1.5 bg-white">
                <Plus className="w-3.5 h-3.5" />
                Add Wallet+
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
            ) : data?.subWallets.length ? (
              <div className="divide-y divide-border rounded-xl border border-border">
                {data.subWallets.map((wallet) => (
                  <div key={wallet.id} className="group flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0 self-stretch sm:self-auto">
                      <div className="flex items-center gap-2 mb-1">
                        <p className="font-medium text-sm">{wallet.label}</p>
                        <Badge variant={wallet.status === "active" ? "success" : "secondary"}>{wallet.status}</Badge>
                        {wallet.isDefault ? <Badge variant="warning">Default</Badge> : null}
                      </div>
                      <p className="text-xs">
                        <HighlightedWalletAddress address={wallet.address} />
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2 self-end sm:self-auto">
                      {!wallet.isDefault ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={setDefaultWallet.isPending}
                          onClick={() => handleSetDefault(wallet.id)}
                          className="hidden bg-white sm:inline-flex"
                        >
                          Set as Default
                        </Button>
                      ) : (
                        <CheckCircle2 className="hidden h-4 w-4 text-[#00B88A] sm:block" />
                      )}
                      <button
                        type="button"
                        onClick={() => copy(wallet.address)}
                        className="w-9 h-9 rounded-lg border border-border flex items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground"
                        title="Copy address"
                      >
                        <Copy className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteTarget({ id: wallet.id, label: wallet.label })}
                        className="w-9 h-9 rounded-lg border border-red-200 bg-red-50 flex items-center justify-center text-red-600 opacity-100 transition-all hover:bg-red-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
                        title="Delete sub-wallet"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    {!wallet.isDefault ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={setDefaultWallet.isPending}
                        onClick={() => handleSetDefault(wallet.id)}
                        className="mt-2 w-full bg-white sm:hidden"
                      >
                        Set as Default
                      </Button>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <div className="h-32 flex items-center justify-center text-sm text-muted-foreground">
                No sub-wallets yet. Add one to route checkout sessions to a dedicated receiving address.
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {showAddWallet && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setShowAddWallet(false)} aria-label="Close add wallet" />
          <div className="relative w-full max-w-md rounded-2xl border border-border bg-card shadow-2xl">
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <div>
                <h2 className="text-base font-semibold">Add Sub-wallet</h2>
                <p className="text-xs text-muted-foreground mt-0.5">Add an address you control for checkout routing.</p>
              </div>
              <button onClick={() => setShowAddWallet(false)} className="w-9 h-9 rounded-full flex items-center justify-center hover:bg-muted" aria-label="Close">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form className="space-y-3 p-5" onSubmit={handleCreate}>
              <div className="space-y-1.5">
                <Label>Label</Label>
                <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Storefront A" required maxLength={120} />
              </div>
              <div className="space-y-1.5">
                <Label>Address</Label>
                <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="0x..." className="font-mono text-xs" required />
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                SeraPay never generates or stores private keys. Only add addresses controlled by your business.
              </p>
              <div className="flex items-center justify-end gap-2 pt-1">
                <Button type="button" variant="outline" size="sm" onClick={() => setShowAddWallet(false)} className="bg-white">Cancel</Button>
                <Button type="submit" size="sm" disabled={createSubWallet.isPending} className="gap-1.5 bg-[#00D1A0] hover:bg-[#00B88A] text-white">
                  <Plus className="w-3.5 h-3.5" />
                  {createSubWallet.isPending ? "Adding..." : "Add Wallet"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setDeleteTarget(null)} aria-label="Close delete confirmation" />
          <div className="relative w-full max-w-sm rounded-2xl border border-border bg-card p-5 shadow-2xl">
            <div className="w-10 h-10 rounded-full bg-red-50 text-red-600 flex items-center justify-center mb-3">
              <AlertTriangle className="w-5 h-5" />
            </div>
            <h3 className="text-base font-semibold text-foreground">Delete sub-wallet?</h3>
            <p className="mt-1 text-sm text-muted-foreground">{deleteTarget.label} will be removed from checkout routing.</p>
            <div className="mt-5 flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setDeleteTarget(null)} className="bg-white">Cancel</Button>
              <Button type="button" size="sm" variant="destructive" disabled={deleteSubWallet.isPending} onClick={handleDelete} className="bg-red-600 text-white hover:bg-red-700">
                {deleteSubWallet.isPending ? "Deleting..." : "Delete"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </AppLayout>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border p-3">
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p className="font-mono text-lg font-semibold truncate" title={value}>{value}</p>
    </div>
  );
}
