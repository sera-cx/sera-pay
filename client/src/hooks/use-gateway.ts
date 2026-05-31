import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchApi } from "@/lib/api";
import { useAuth } from "@/hooks/use-auth";
import type { SeraApiMode } from "@shared/gateway";

export interface GatewayMasterWallet {
  id: string;
  merchantId: string;
  type: "master";
  address: string;
  settlementAddress: string;
  receiveCoin: string | null;
  chainId: number;
  createdAt: string;
}

export interface GatewaySubWallet {
  id: string;
  merchantId: string;
  label: string;
  address: string;
  chainId: number;
  receiveCoin: string | null;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
}

export interface GatewayPaymentIntent {
  id: string;
  merchantId: string;
  subWalletId: string | null;
  amount: string;
  coin: string;
  receiverAddress: string;
  chainId: number;
  customerEmail: string | null;
  customerName: string | null;
  description: string | null;
  metadata: Record<string, unknown> | null;
  checkoutUrl: string;
  status: "created" | "open" | "paid" | "expired" | "canceled" | "failed";
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SeraApiConfigView {
  merchantId: string | null;
  seraApiBaseUrl: string;
  hasSeraApiKey: boolean;
  seraApiKeyLast4: string | null;
  hasWebhookSecret: boolean;
  webhookSecretLast4: string | null;
  mode: SeraApiMode;
  encryptionReady: boolean;
  updatedAt?: string;
}

export function useWallets() {
  const { apiKey, isAuthenticated } = useAuth();
  return useQuery<{ masterWallet: GatewayMasterWallet; subWallets: GatewaySubWallet[] }>({
    queryKey: ["/wallets", apiKey || ""],
    queryFn: () => fetchApi("/wallets"),
    enabled: isAuthenticated && !!apiKey,
    retry: false,
  });
}

export function useCreateSubWallet() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { label: string; address: string; chainId?: number; receiveCoin?: string }) =>
      fetchApi<GatewaySubWallet>("/sub-wallets", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/wallets"] });
    },
  });
}

export function useDeleteSubWallet() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => fetchApi(`/sub-wallets/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/wallets"] });
    },
  });
}

export function usePaymentIntents(limit = 50) {
  const { apiKey, isAuthenticated } = useAuth();
  return useQuery<{ paymentIntents: GatewayPaymentIntent[] }>({
    queryKey: ["/payments", limit, apiKey || ""],
    queryFn: () => fetchApi(`/payments?limit=${limit}`),
    enabled: isAuthenticated && !!apiKey,
    retry: false,
    refetchInterval: isAuthenticated && apiKey ? 15000 : false,
  });
}

export function useCreatePaymentIntent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      amount: string;
      coin: string;
      chainId?: number;
      subWalletId?: string;
      customerEmail?: string;
      customerName?: string;
      description?: string;
    }) =>
      fetchApi<{ paymentIntent: GatewayPaymentIntent; checkoutUrl: string }>("/payments", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/payments"] });
    },
  });
}

export function useSeraApiConfig() {
  const { apiKey, isAuthenticated } = useAuth();
  return useQuery<SeraApiConfigView>({
    queryKey: ["/merchant/sera-config", apiKey || ""],
    queryFn: () => fetchApi("/merchant/sera-config"),
    enabled: isAuthenticated && !!apiKey,
    retry: false,
  });
}

export function useUpdateSeraApiConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      seraApiKey?: string;
      seraApiBaseUrl: string;
      seraWebhookSecret?: string;
      mode: SeraApiMode;
    }) =>
      fetchApi<SeraApiConfigView>("/merchant/sera-config", {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/merchant/sera-config"] });
    },
  });
}

export function useGenerateSeraApiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      owner: string;
      action: "create";
      timestamp: number;
      signature: string;
      label?: string;
      seraApiBaseUrl: string;
    }) =>
      fetchApi<{
        config: SeraApiConfigView;
        ownerAddress: string;
        apiKeyLast4: string | null;
        message: string;
      }>("/merchant/sera-config/generate-api-key", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/merchant/sera-config"] });
    },
  });
}

export function useTestSeraApiConfig() {
  return useMutation({
    mutationFn: () =>
      fetchApi<{
        snapshot: {
          healthy: boolean;
          mode: SeraApiMode;
          baseUrl: string;
          chainId: number | null;
          seraAddress: string | null;
          vaultAddress: string | null;
          sorAddress: string | null;
          message: string;
        };
        verification: { ok: boolean; ownerAddress?: string; message: string };
      }>("/merchant/sera-config/test", { method: "POST" }),
  });
}
