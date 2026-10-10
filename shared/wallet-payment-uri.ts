export interface WalletPaymentUriRequest {
  receiverAddress: string;
  coin?: string | null;
  amount?: string | null;
  chainId?: number | null;
  /** Exact address returned by the active Sera /tokens registry. */
  tokenAddress?: string | null;
  /** Decimals returned beside tokenAddress by the same registry response. */
  tokenDecimals?: number | null;
}

export function parseAmountToRaw(amount: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error("Invalid token decimal precision.");
  }
  const normalized = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) return 0n;
  const [whole, fraction = ""] = normalized.split(".");
  const meaningfulFraction = fraction.replace(/0+$/, "");
  if (meaningfulFraction.length > decimals) {
    throw new Error(`Amount exceeds the token's ${decimals}-decimal precision.`);
  }
  return BigInt(whole + meaningfulFraction.padEnd(decimals, "0"));
}

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Shared by web downloads and API cards. Raw EIP-681 scans bypass checkout;
 * single-use requests must use a hosted checkout URL instead.
 */
export function buildWalletPaymentUri({
  receiverAddress,
  coin,
  amount,
  chainId,
  tokenAddress,
  tokenDecimals,
}: WalletPaymentUriRequest): string {
  const receiver = receiverAddress.trim();
  const resolvedChainId = chainId == null || chainId === 0 ? 1 : chainId;
  if (!EVM_ADDRESS_RE.test(receiver) || !Number.isSafeInteger(resolvedChainId) || resolvedChainId <= 0) return "";

  const symbol = String(coin || "").trim().toUpperCase();
  const native = symbol === "ETH";
  const decimals = native ? 18 : tokenDecimals;
  if (decimals == null || (!native && (!tokenAddress || !EVM_ADDRESS_RE.test(tokenAddress)))) return "";
  const amountText = amount?.trim() || "";
  let rawAmount: bigint;
  try {
    rawAmount = parseAmountToRaw(amountText, decimals);
  } catch {
    return "";
  }
  // A supplied amount must survive unchanged; form sanitization could change
  // negatives, exponents, or excess precision into a different payment.
  if ((amountText && rawAmount <= 0n) || rawAmount >= (1n << 256n)) return "";

  if (native) {
    const params = rawAmount > 0n ? `?value=${rawAmount}&gas=21000` : "";
    return `ethereum:${receiver}@${resolvedChainId}${params}`;
  }

  const params = new URLSearchParams({ address: receiver });
  if (rawAmount > 0n) params.set("uint256", rawAmount.toString());
  return `ethereum:${tokenAddress}@${resolvedChainId}/transfer?${params}`;
}
