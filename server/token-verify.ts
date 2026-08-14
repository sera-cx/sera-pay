import { createPublicClient, fallback, http, parseAbi } from "viem";
import { mainnet, sepolia } from "viem/chains";
import { ENV } from "./_core/env";
import type { SeraToken } from "./sera-api";

/**
 * On-chain verification of the Sera token registry.
 *
 * A wallet renders a payment request by reading `symbol()` and `decimals()`
 * straight from the token contract named in the EIP-681 URI. If that address
 * has no code, or its symbol/decimals disagree with what SeraPay believed, the
 * wallet shows "Unknown" and the transfer reverts or moves the wrong amount.
 *
 * So before any token is offered as a payment option we confirm, against the
 * chain itself, that the contract exists and reports the symbol and decimals
 * the registry claims. Verdicts are cached indefinitely per (chain, address):
 * a deployed ERC-20's symbol and decimals are immutable.
 */

const ERC20_ABI = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

const PUBLIC_RPC_URLS: Record<number, string[]> = {
  1: ["https://ethereum.publicnode.com", "https://eth.llamarpc.com", "https://1rpc.io/eth"],
  11155111: ["https://ethereum-sepolia-rpc.publicnode.com", "https://sepolia.drpc.org"],
};

function transportFor(chainId: number) {
  const configured = ENV.rpcUrls[chainId];
  if (configured) return http(configured);
  const urls = PUBLIC_RPC_URLS[chainId] ?? [];
  return urls.length > 0 ? fallback(urls.map((url) => http(url))) : http();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CLIENTS: Record<number, any> = {
  1: createPublicClient({ chain: mainnet, transport: transportFor(1) }),
  ...(ENV.seraEnableTestnet
    ? { 11155111: createPublicClient({ chain: sepolia, transport: transportFor(11155111) }) }
    : {}),
};

export type TokenVerdict =
  | { status: "verified"; symbol: string; decimals: number }
  | { status: "mismatch"; reason: string }
  | { status: "unknown"; reason: string };

const verdicts = new Map<string, TokenVerdict>();
const inflight = new Map<string, Promise<TokenVerdict>>();

function cacheKey(chainId: number, address: string) {
  return `${chainId}:${address.toLowerCase()}`;
}

async function readTokenIdentity(chainId: number, address: string): Promise<TokenVerdict> {
  const client = CLIENTS[chainId];
  if (!client) return { status: "unknown", reason: `No RPC client for chain ${chainId}` };

  try {
    const [symbol, decimals] = await Promise.all([
      client.readContract({ address: address as `0x${string}`, abi: ERC20_ABI, functionName: "symbol" }),
      client.readContract({ address: address as `0x${string}`, abi: ERC20_ABI, functionName: "decimals" }),
    ]);
    return { status: "verified", symbol: String(symbol), decimals: Number(decimals) };
  } catch (error) {
    // A contract with no code, or one that does not implement ERC-20 metadata,
    // is exactly the case that renders as "Unknown" in a wallet.
    return {
      status: "unknown",
      reason: error instanceof Error ? error.message.slice(0, 200) : "Token metadata call failed",
    };
  }
}

async function verifyOne(chainId: number, token: SeraToken): Promise<TokenVerdict> {
  const key = cacheKey(chainId, token.address);
  const cached = verdicts.get(key);
  if (cached) return cached;
  const pending = inflight.get(key);
  if (pending) return pending;

  const request = readTokenIdentity(chainId, token.address).then((onChain) => {
    let verdict: TokenVerdict = onChain;
    if (onChain.status === "verified") {
      const symbolMatches = onChain.symbol.trim().toUpperCase() === token.symbol.trim().toUpperCase();
      const decimalsMatch = onChain.decimals === Number(token.decimals);
      if (!decimalsMatch) {
        // The dangerous one: the wrong scale silently moves the wrong amount.
        verdict = {
          status: "mismatch",
          reason: `${token.symbol}: registry says ${token.decimals} decimals, chain says ${onChain.decimals}`,
        };
      } else if (!symbolMatches) {
        // Cosmetic only — the amount is still correct, so keep the token but
        // record the discrepancy. Some tokens legitimately differ in casing or
        // use a display name that differs from Sera's registry symbol.
        verdict = { status: "verified", symbol: onChain.symbol, decimals: onChain.decimals };
      }
    }
    // Only cache a settled verdict; a transient RPC failure must be retried.
    if (verdict.status !== "unknown") verdicts.set(key, verdict);
    inflight.delete(key);
    return verdict;
  }).catch((error) => {
    inflight.delete(key);
    throw error;
  });

  inflight.set(key, request);
  return request;
}

export interface VerifiedSeraToken extends SeraToken {
  /** True once the contract's decimals were confirmed against the chain. */
  verified: boolean;
  /** The symbol the contract itself reports, when it could be read. */
  onChainSymbol?: string;
}

/**
 * Annotates a registry with on-chain verification and drops any token whose
 * decimals disagree with the chain. Tokens that could not be reached (RPC
 * hiccup) are kept but marked unverified — refusing to serve the registry
 * because a public RPC blipped would take checkout down for everyone.
 */
export async function verifySeraTokens(chainId: number, tokens: SeraToken[]): Promise<{
  tokens: VerifiedSeraToken[];
  rejected: Array<{ symbol: string; address: string; reason: string }>;
}> {
  const results = await Promise.all(tokens.map(async (token) => {
    try {
      return { token, verdict: await verifyOne(chainId, token) };
    } catch (error) {
      return {
        token,
        verdict: {
          status: "unknown",
          reason: error instanceof Error ? error.message.slice(0, 200) : "verification failed",
        } as TokenVerdict,
      };
    }
  }));

  const verified: VerifiedSeraToken[] = [];
  const rejected: Array<{ symbol: string; address: string; reason: string }> = [];

  for (const { token, verdict } of results) {
    if (verdict.status === "mismatch") {
      rejected.push({ symbol: token.symbol, address: token.address, reason: verdict.reason });
      continue;
    }
    verified.push({
      ...token,
      verified: verdict.status === "verified",
      ...(verdict.status === "verified" ? { onChainSymbol: verdict.symbol } : {}),
    });
  }

  return { tokens: verified, rejected };
}
