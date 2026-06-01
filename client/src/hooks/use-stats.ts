import { useQuery } from "@tanstack/react-query";
import { fetchApi } from "@/lib/api";
import { useAuth } from "@/hooks/use-auth";

export interface MerchantStats {
  totalCount: number;
  confirmedCount: number;
  pendingCount: number;
  unverifiedCount: number;
  totalVolume: string;
  dailyVolume: { date: string; volume: string }[];
}

export function useMerchantStats(chainId?: number) {
  const { apiKey, isAuthenticated } = useAuth();
  const suffix = chainId ? `?chainId=${chainId}` : "";
  return useQuery<MerchantStats>({
    queryKey: ["/merchant/stats", chainId || "all", apiKey || ""],
    queryFn: () => fetchApi(`/merchant/stats${suffix}`),
    enabled: isAuthenticated && !!apiKey,
    retry: false,
    refetchInterval: isAuthenticated && apiKey ? 15000 : false,
  });
}
