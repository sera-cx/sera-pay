import React from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { motion } from "framer-motion";
import { useChainId, useSwitchChain } from "wagmi";
import { mainnet, sepolia } from "wagmi/chains";
import { cn } from "@/lib/dashboard-utils";
import { useSeraApiConfig, useUpdateSeraApiConfig } from "@/hooks/use-gateway";
import { DEFAULT_SERA_API_BASE_URL, DEFAULT_SERA_API_TESTNET_BASE_URL } from "@shared/gateway";

export type NetworkMode = "test" | "live";

export const NETWORKS: Record<number, { label: string; color: string; bg: string; isTest: boolean }> = {
  [sepolia.id]: { label: "Sepolia", color: "#00A87A", bg: "#E6FAF5", isTest: true },
  [mainnet.id]: { label: "Ethereum", color: "#627EEA", bg: "#EEF1FD", isTest: false },
};

export function useActiveNetworkMode() {
  const chainId = useChainId();
  const { data: seraConfig } = useSeraApiConfig();
  const activeMode: NetworkMode = seraConfig?.mode === "live" ? "live" : seraConfig?.mode === "test" ? "test" : chainId === mainnet.id ? "live" : "test";
  const networkInfo = activeMode === "live" ? NETWORKS[mainnet.id] : NETWORKS[sepolia.id];
  return { activeMode, networkInfo, chainId };
}

export function NetworkModeButton({
  activeMode,
  onClick,
  className,
  style,
  title,
  ariaLabel = "Switch network",
}: {
  activeMode: NetworkMode;
  onClick: () => void;
  className?: string;
  style?: React.CSSProperties;
  title?: string;
  ariaLabel?: string;
}) {
  const isTest = activeMode === "test";
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn("flex items-center h-7 rounded-full border border-border bg-muted p-0.5 gap-0 transition-all hover:border-foreground/20 cursor-pointer", className)}
      style={style}
      title={title || (isTest ? "Test mode - click to switch to Live" : "Live mode - click to switch to Test")}
      aria-label={ariaLabel}
    >
      <span className={cn(
        "px-2.5 py-0.5 rounded-full text-[11px] font-semibold transition-all",
        isTest ? "bg-amber-100 text-amber-700" : "text-muted-foreground"
      )}>
        Test
      </span>
      <span className={cn(
        "px-2.5 py-0.5 rounded-full text-[11px] font-semibold transition-all",
        !isTest ? "bg-[#E6FAF5] text-[#00A87A]" : "text-muted-foreground"
      )}>
        Live
      </span>
    </button>
  );
}

export function NetworkSwitcherModal({ onClose }: { onClose: () => void }) {
  const { switchChain, isPending } = useSwitchChain();
  const { activeMode, networkInfo } = useActiveNetworkMode();
  const updateConfig = useUpdateSeraApiConfig();

  const handleSwitch = async (targetChainId: number) => {
    const targetMode: NetworkMode = targetChainId === mainnet.id ? "live" : "test";
    try {
      await updateConfig.mutateAsync({
        mode: targetMode,
        seraApiBaseUrl: targetMode === "test" ? DEFAULT_SERA_API_TESTNET_BASE_URL : DEFAULT_SERA_API_BASE_URL,
      });
      await switchChain({ chainId: targetChainId });
      onClose();
    } catch {
      try {
        const provider = (window as any).ethereum;
        if (!provider) return;
        if (targetChainId === sepolia.id) {
          await provider.request({
            method: "wallet_addEthereumChain",
            params: [{
              chainId: "0xaa36a7",
              chainName: "Sepolia",
              nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 },
              rpcUrls: [import.meta.env.VITE_SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com"],
              blockExplorerUrls: ["https://sepolia.etherscan.io"],
            }],
          });
        } else if (targetChainId === mainnet.id) {
          await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x1" }] });
        }
        onClose();
      } catch (addErr) {
        if (import.meta.env.DEV) console.error("[NetworkSwitch] Failed:", addErr);
      }
    }
  };

  const modal = (
    <>
      <div className="fixed inset-0 z-[1000] bg-black/45 backdrop-blur-sm" onClick={onClose} />
      <div className="fixed inset-0 z-[1001] flex items-center justify-center overflow-y-auto p-4 sm:p-6">
        <motion.div
          initial={{ opacity: 0, y: 12, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 12, scale: 0.97 }}
          transition={{ duration: 0.14 }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="network-switcher-title"
          className="my-auto w-full max-w-sm rounded-2xl border border-border bg-card p-5 shadow-2xl"
        >
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 id="network-switcher-title" className="text-sm font-semibold text-foreground">Switch Network</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Currently on <span className="font-medium" style={{ color: networkInfo.color }}>{networkInfo.label}</span>
              </p>
            </div>
            <button onClick={onClose} className="w-11 h-11 rounded-full flex items-center justify-center hover:bg-muted transition-colors" aria-label="Close">
              <X className="w-3.5 h-3.5 text-muted-foreground" />
            </button>
          </div>

          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 mb-4 flex gap-2.5">
            <span className="text-amber-500 text-base leading-none mt-0.5" aria-hidden="true">!</span>
            <p className="text-xs text-amber-800 leading-relaxed">
              <strong>Sepolia is a test network.</strong> Transactions use test ETH and have no real value.
              Switch to <strong>Ethereum Mainnet</strong> to accept real payments from customers.
            </p>
          </div>

          <div className="space-y-2">
            <button
              type="button"
              onClick={() => handleSwitch(sepolia.id)}
              disabled={isPending || updateConfig.isPending || activeMode === "test"}
              className={cn(
                "w-full flex items-center gap-3 p-3 rounded-xl border transition-all text-left",
                activeMode === "test"
                  ? "border-[#00D1A0] bg-[#E6FAF5]"
                  : "border-border hover:border-[#00D1A0]/50 hover:bg-muted/40"
              )}
            >
              <div className="w-8 h-8 rounded-full bg-[#E6FAF5] flex items-center justify-center shrink-0">
                <span className="text-xs font-bold text-[#00A87A]">T</span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-foreground">Sepolia Testnet</p>
                <p className="text-xs text-muted-foreground">For testing only - no real value</p>
              </div>
              {activeMode === "test" && (
                <span className="text-xs font-medium text-[#00A87A] bg-[#E6FAF5] px-2 py-0.5 rounded-full shrink-0">Active</span>
              )}
            </button>

            <button
              type="button"
              onClick={() => handleSwitch(mainnet.id)}
              disabled={isPending || updateConfig.isPending || activeMode === "live"}
              className={cn(
                "w-full flex items-center gap-3 p-3 rounded-xl border transition-all text-left",
                activeMode === "live"
                  ? "border-[#627EEA] bg-[#EEF1FD]"
                  : "border-border hover:border-[#627EEA]/50 hover:bg-muted/40"
              )}
            >
              <div className="w-8 h-8 rounded-full bg-[#EEF1FD] flex items-center justify-center shrink-0">
                <span className="text-xs font-bold text-[#627EEA]">L</span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-foreground">Ethereum Mainnet</p>
                <p className="text-xs text-muted-foreground">Live network - real payments</p>
              </div>
              {activeMode === "live" && (
                <span className="text-xs font-medium text-[#627EEA] bg-[#EEF1FD] px-2 py-0.5 rounded-full shrink-0">Active</span>
              )}
            </button>
          </div>

          {(isPending || updateConfig.isPending) && (
            <p className="text-xs text-center text-muted-foreground mt-3">Switching network in your wallet...</p>
          )}
        </motion.div>
      </div>
    </>
  );

  if (typeof document === "undefined") return modal;
  return createPortal(modal, document.body);
}
