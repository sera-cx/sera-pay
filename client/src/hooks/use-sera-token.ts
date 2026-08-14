import { useEffect, useState } from "react";
import { loadSeraCurrencies, type SeraCurrency } from "@/lib/currencyCalculator";

/**
 * Resolves one coin's contract address and decimals from the live Sera registry.
 *
 * buildWalletPaymentUri refuses to emit a URI without them — deliberately, since
 * a guessed decimals value silently scales the on-chain amount — so any caller
 * that omitted them fell through to the http payment link instead. That link is
 * a web page, not a payment request: a wallet scanner cannot act on it, which is
 * the opposite of scan-and-pay.
 */

const cache = new Map<number, Promise<SeraCurrency[]>>();

function registryFor(chainId: number): Promise<SeraCurrency[]> {
  const cached = cache.get(chainId);
  if (cached) return cached;
  const pending = loadSeraCurrencies(chainId).catch((error) => {
    // Don't cache a failure — the next render should be able to retry.
    cache.delete(chainId);
    throw error;
  });
  cache.set(chainId, pending);
  return pending;
}

export function useSeraToken(symbol?: string | null, chainId?: number | null): SeraCurrency | null {
  const [token, setToken] = useState<SeraCurrency | null>(null);
  const wanted = String(symbol || "").toUpperCase();

  useEffect(() => {
    if (!wanted || !chainId) {
      setToken(null);
      return;
    }
    let cancelled = false;
    registryFor(chainId)
      .then((currencies) => {
        if (cancelled) return;
        setToken(currencies.find((currency) => currency.symbol.toUpperCase() === wanted) ?? null);
      })
      .catch(() => {
        if (!cancelled) setToken(null);
      });
    return () => { cancelled = true; };
  }, [wanted, chainId]);

  return token;
}
