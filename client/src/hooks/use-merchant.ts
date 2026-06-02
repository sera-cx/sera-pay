import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchApi } from "@/lib/api";
import { useAuth } from "@/hooks/use-auth";

export interface MerchantProfile {
  id: string;
  walletAddress: string;
  name: string | null;
  description: string | null;
  webhookUrl: string | null;
  logoData: string | null;
  qrFgColor: string | null;
  qrBgColor: string | null;
  qrStyle: string | null;
  qrMode: string | null;
  receiveCoin: string | null;
  storeAddress: string | null;
  createdAt: string;
  updatedAt: string;
}

export function useMerchantProfile(apiKey?: string) {
  const auth = useAuth();
  const resolvedApiKey = apiKey ?? auth.apiKey ?? "";
  return useQuery<MerchantProfile>({
    // Include apiKey in queryKey so the query re-fires once the key becomes available.
    // Without this, the query fires on mount before the key is loaded from localStorage,
    // gets a 401, and never retries — causing the logo (and other profile data) to disappear on reload.
    queryKey: ["/merchant/profile", resolvedApiKey],
    queryFn: () => fetchApi("/merchant/profile", {
      headers: resolvedApiKey ? { "x-api-key": resolvedApiKey } : undefined,
    }),
    enabled: auth.isAuthenticated && !!resolvedApiKey,
    retry: false,
  });
}

export function useRegisterMerchant() {
  return useMutation({
    mutationFn: (data: { walletAddress: string; name?: string; webhookUrl?: string }) => 
      fetchApi<{ apiKey: string; id: string }>("/merchant/register", {
        method: "POST",
        body: JSON.stringify(data),
      }),
  });
}

export function useUpdateProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      name?: string;
      description?: string | null;
      webhookUrl?: string;
      logoData?: string | null;
      qrFgColor?: string | null;
      qrBgColor?: string | null;
      qrStyle?: string | null;
      qrMode?: string | null;
      receiveCoin?: string | null;
      storeAddress?: string | null;
    }) =>
      fetchApi<MerchantProfile>("/merchant/profile", {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/merchant/profile"] });
    },
  });
}

export function useUpdateWebhook() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { webhookUrl: string }) =>
      fetchApi<{ success: boolean; webhookUrl: string }>("/merchant/webhook", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/merchant/profile"] });
    },
  });
}
