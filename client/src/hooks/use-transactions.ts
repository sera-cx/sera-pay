import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchApi } from "@/lib/api";
import { useAuth } from "@/hooks/use-auth";

export interface Transaction {
  id: string;
  txHash: string | null;
  fromAddress: string | null;
  from?: string;
  toAddress?: string;
  amount: string;
  amountUsd?: string | null;
  coin: string;
  payCoin: string | null;
  payAmount: string | null;
  memo: string | null;
  notes: string | null;
  status: "pending" | "confirming" | "confirmed" | "failed" | "canceled" | "unverified";
  verified: boolean | number;
  chainId?: number;
  paymentUrl?: string | null;
  merchantId?: string;
  webhookSent?: boolean;
  webhookSentAt?: string | null;
  createdAt: string;
  updatedAt?: string;
}

interface TransactionsResponse {
  transactions: Transaction[];
  pagination: { limit: number; offset: number };
}

export function useTransactions(limit = 50, offset = 0, chainId?: number) {
  const { apiKey, isAuthenticated } = useAuth();
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (chainId) params.set("chainId", String(chainId));
  return useQuery<TransactionsResponse>({
    queryKey: ["/merchant/transactions", limit, offset, chainId || "all", apiKey || ""],
    queryFn: () => fetchApi(`/merchant/transactions?${params.toString()}`),
    enabled: isAuthenticated && !!apiKey,
    retry: false,
    refetchInterval: isAuthenticated && apiKey ? 15000 : false, // Background polling as fallback to SSE
  });
}

export function useTransaction(txHash: string) {
  const { apiKey, isAuthenticated } = useAuth();
  return useQuery<Transaction>({
    queryKey: ["/merchant/transactions", txHash, apiKey || ""],
    queryFn: () => fetchApi(`/merchant/transactions/${txHash}`),
    enabled: isAuthenticated && !!txHash && !!apiKey,
    retry: false,
  });
}

export function useCancelTransaction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => fetchApi(`/merchant/transactions/${id}/cancel`, { method: "PATCH" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/merchant/transactions"] });
      queryClient.invalidateQueries({ queryKey: ["/merchant/stats"] });
    },
  });
}
