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

export function useMerchantStats() {
  const { apiKey, isAuthenticated } = useAuth();
  return useQuery<MerchantStats>({
    queryKey: ["/merchant/stats", apiKey || ""],
    queryFn: () => fetchApi("/merchant/stats"),
    enabled: isAuthenticated && !!apiKey,
    retry: false,
    refetchInterval: isAuthenticated && apiKey ? 15000 : false,
  });
}
