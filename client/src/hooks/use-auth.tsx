import React, { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  DASHBOARD_API_KEY_STORAGE_KEY,
  DASHBOARD_SESSION_STORAGE_KEY,
  DASHBOARD_AUTH_INVALID_EVENT,
  DASHBOARD_SESSION_EXPIRED_EVENT,
  DASHBOARD_WALLET_STORAGE_KEY,
  clearStoredDashboardAuth,
  isDashboardSessionExpired,
  markDashboardSessionActive,
  startDashboardSession,
} from "@/lib/api";

interface AuthContextType {
  /** Dashboard credential: a short-lived session token, not the raw API key. */
  credential: string | null;
  /** The raw API key, present only right after creation or regeneration. */
  freshApiKey: string | null;
  walletAddress: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  login: () => Promise<void>;
  retry: () => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const SESSION_KEY = DASHBOARD_SESSION_STORAGE_KEY;
const LEGACY_KEY = DASHBOARD_API_KEY_STORAGE_KEY;
const WALLET_KEY = DASHBOARD_WALLET_STORAGE_KEY;

type WalletInfo = {
  address: string;
  walletType: string;
  kind: "external" | "privy";
};

function normalizeAddress(value: unknown): string | null {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)
    ? value.toLowerCase()
    : null;
}

function walletTypeFrom(value: any): string {
  const type = String(value?.walletClientType || value?.wallet_client_type || value?.connectorType || value?.connector_type || value?.type || "external");
  const normalized = type.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32);
  return normalized || "external";
}

function isPrivyWallet(value: any): boolean {
  const marker = `${value?.walletClientType || ""} ${value?.wallet_client_type || ""} ${value?.connectorType || ""} ${value?.connector_type || ""} ${value?.type || ""}`.toLowerCase();
  return marker.includes("privy") || marker.includes("embedded");
}

function isExternalWallet(value: any): boolean {
  return !isPrivyWallet(value);
}

function walletInfo(address: string, source: any, fallbackKind: WalletInfo["kind"]): WalletInfo {
  const kind = fallbackKind === "privy" || isPrivyWallet(source) ? "privy" : "external";
  return {
    address,
    walletType: kind === "privy" ? "privy" : walletTypeFrom(source),
    kind,
  };
}

function registrationMessage(walletAddress: string, privyUserId: string, timestamp: string) {
  return [
    "SeraPay wallet registration",
    `Wallet: ${walletAddress.toLowerCase()}`,
    `Privy user: ${privyUserId}`,
    `Timestamp: ${timestamp}`,
  ].join("\n");
}

function parseProviderError(value: unknown): { code?: number; message?: string } {
  if (value && typeof value === "object") {
    const err = value as any;
    if (typeof err.message === "string") {
      const parsed = parseProviderError(err.message);
      return { code: typeof err.code === "number" ? err.code : parsed.code, message: parsed.message || err.message };
    }
    return { code: typeof err.code === "number" ? err.code : undefined, message: typeof err.error === "string" ? err.error : undefined };
  }
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object") {
      return {
        code: typeof parsed.code === "number" ? parsed.code : undefined,
        message: typeof parsed.message === "string" ? parsed.message : value,
      };
    }
  } catch {}
  return { message: value };
}

function formatAccountSetupError(err: unknown): string {
  const parsed = parseProviderError(err);
  const message = parsed.message || (err instanceof Error ? err.message : "") || "Account setup failed. Please retry.";
  if (parsed.code === -32002 || /personal_sign.+already pending|request.+already pending/i.test(message)) {
    return "A wallet signature request is already open. Please approve it in your wallet, or close it and retry account setup.";
  }
  if (/user rejected|user denied|request rejected|signature rejected|denied transaction/i.test(message)) {
    return "Wallet signature was cancelled. Tap Retry account setup when you are ready.";
  }
  return message;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const { authenticated, user, login: privyLogin, logout: privyLogout, ready, getAccessToken } = usePrivy();
  const { wallets } = useWallets();
  const queryClient = useQueryClient();
  const [credential, setCredential] = useState<string | null>(null);
  const [freshApiKey, setFreshApiKey] = useState<string | null>(null);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [, setLocation] = useLocation();
  const abortRef = useRef<AbortController | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearDashboardQueryCache = useCallback(() => {
    queryClient.removeQueries({
      predicate: (query) => {
        const key = query.queryKey[0];
        return typeof key === "string" && (
          key.startsWith("/merchant") ||
          key.startsWith("/wallets") ||
          key.startsWith("/sub-wallets") ||
          key.startsWith("/payments") ||
          key.startsWith("/transactions") ||
          key.startsWith("/menus")
        );
      },
    });
  }, [queryClient]);

  useEffect(() => {
    const handleInvalidDashboardAuth = () => {
      if (abortRef.current) abortRef.current.abort();
      clearStoredDashboardAuth(walletAddress);
      clearDashboardQueryCache();
      setCredential(null);
      setFreshApiKey(null);
      setError(null);
      setRetryCount((count) => count + 1);
    };
    window.addEventListener(DASHBOARD_AUTH_INVALID_EVENT, handleInvalidDashboardAuth);
    return () => window.removeEventListener(DASHBOARD_AUTH_INVALID_EVENT, handleInvalidDashboardAuth);
  }, [clearDashboardQueryCache, walletAddress]);

  useEffect(() => {
    const handleExpiredDashboardSession = () => {
      if (abortRef.current) abortRef.current.abort();
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      clearStoredDashboardAuth(walletAddress);
      clearDashboardQueryCache();
      setCredential(null);
      setFreshApiKey(null);
      setWalletAddress(null);
      setError(null);
      if (authenticated) void privyLogout();
      setLocation("/");
    };
    window.addEventListener(DASHBOARD_SESSION_EXPIRED_EVENT, handleExpiredDashboardSession);
    return () => window.removeEventListener(DASHBOARD_SESSION_EXPIRED_EVENT, handleExpiredDashboardSession);
  }, [authenticated, clearDashboardQueryCache, privyLogout, setLocation, walletAddress]);

  useEffect(() => {
    if (!authenticated || !credential) return;

    const checkOrTouch = (touch: boolean) => {
      if (isDashboardSessionExpired()) {
        window.dispatchEvent(new CustomEvent(DASHBOARD_SESSION_EXPIRED_EVENT, { detail: { message: "Dashboard session expired. Please sign in again." } }));
        return;
      }
      if (touch) markDashboardSessionActive();
    };

    const handleActivity = () => checkOrTouch(true);
    const handleVisibility = () => { if (!document.hidden) checkOrTouch(false); };
    const sessionTimer = window.setInterval(() => checkOrTouch(false), 60_000);

    checkOrTouch(false);
    window.addEventListener("pointerdown", handleActivity, { passive: true });
    window.addEventListener("keydown", handleActivity);
    window.addEventListener("focus", handleVisibility);
    window.addEventListener("pageshow", handleVisibility);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.clearInterval(sessionTimer);
      window.removeEventListener("pointerdown", handleActivity);
      window.removeEventListener("keydown", handleActivity);
      window.removeEventListener("focus", handleVisibility);
      window.removeEventListener("pageshow", handleVisibility);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [authenticated, credential]);

  const extractWalletInfo = useCallback((): WalletInfo | null => {
    if (!user) return null;

    const linkedAccounts = ((user as any).linkedAccounts as any[] | undefined) || [];
    const linkedWallets = linkedAccounts
      .map((account) => ({ address: normalizeAddress(account?.address), account }))
      .filter((item): item is { address: string; account: any } => Boolean(item.address));
    const embeddedWallet = (user as any).wallet;
    const embeddedAddress = normalizeAddress(embeddedWallet?.address);

    /*
      Every address Privy says belongs to THIS signed-in account.

      useWallets() reports whatever the browser has connected, which is not the
      same question. A MetaMask extension auto-connects on page load regardless
      of who is signed in, so a merchant logging in with Google was handed their
      MetaMask address — an address that account never linked — and the server
      then correctly refused it with "Wallet address is not linked to the
      authenticated Privy user". Filter to what Privy actually vouches for.
    */
    const ownedAddresses = new Set(
      [...linkedWallets.map((item) => item.address), embeddedAddress].filter(Boolean) as string[],
    );

    const connectedWallets = (wallets as any[] || [])
      .map((wallet) => ({ address: normalizeAddress(wallet?.address), wallet }))
      .filter((item): item is { address: string; wallet: any } => Boolean(item.address))
      // If Privy exposed no linkage at all, trust the connection rather than
      // locking the merchant out of their own dashboard.
      .filter((item) => ownedAddresses.size === 0 || ownedAddresses.has(item.address));

    const connectedExternal = connectedWallets.find((item) => isExternalWallet(item.wallet));
    if (connectedExternal) return walletInfo(connectedExternal.address, connectedExternal.wallet, "external");
    const connected = connectedWallets[0];
    if (connected) return walletInfo(connected.address, connected.wallet, "privy");

    const linkedExternal = linkedWallets.find((item) => isExternalWallet(item.account));
    if (linkedExternal) return walletInfo(linkedExternal.address, linkedExternal.account, "external");

    if (embeddedAddress) return walletInfo(embeddedAddress, embeddedWallet, "privy");
    const linked = linkedWallets[0];
    return linked ? walletInfo(linked.address, linked.account, "privy") : null;
  }, [user, wallets]);

  const signWalletProof = useCallback(async (address: string, walletType: string) => {
    const privyUserId = String((user as any)?.id || (user as any)?.userId || "");
    if (!privyUserId) return null;
    const wallet = ((wallets as any[]) || []).find((item) => normalizeAddress(item?.address) === address && isExternalWallet(item));
    if (!wallet?.getEthereumProvider) return null;
    const provider = await wallet.getEthereumProvider();
    if (!provider?.request) return null;
    const timestamp = new Date().toISOString();
    const message = registrationMessage(address, privyUserId, timestamp);
    const signature = await provider.request({
      method: "personal_sign",
      params: [message, address],
    });
    return { message, signature, timestamp, walletType };
  }, [user, wallets]);

  // Privy hands back a fresh `wallets` array on many renders, so the two
  // callbacks above change identity constantly. Account setup reads them
  // through refs and keys itself on the resolved address instead. Depending on
  // the callbacks — and on `walletAddress`, which the effect assigns itself —
  // restarted the effect on almost every render, and each restart re-ran the
  // wallet signature it used to request up front. That is the repeated popup.
  const extractWalletInfoRef = useRef(extractWalletInfo);
  const signWalletProofRef = useRef(signWalletProof);
  const userRef = useRef(user);
  useEffect(() => {
    extractWalletInfoRef.current = extractWalletInfo;
    signWalletProofRef.current = signWalletProof;
    userRef.current = user;
  });

  const resolvedWallet = extractWalletInfo();
  const resolvedAddress = resolvedWallet?.address ?? null;
  const resolvedWalletKind = resolvedWallet?.kind ?? null;

  // At most one signature prompt per wallet per retry, shared by every effect
  // run. A rejected prompt stays rejected until the merchant taps Retry, which
  // bumps retryCount and so changes the key.
  const walletProofRef = useRef<{ key: string; promise: ReturnType<typeof signWalletProof> } | null>(null);

  useEffect(() => {
    if (!ready) return;

    if (!authenticated || !user) {
      setCredential(null);
      setFreshApiKey(null);
      setWalletAddress(null);
      setError(null);
      setIsLoading(false);
      clearStoredDashboardAuth(walletAddress);
      clearDashboardQueryCache();
      return;
    }

    if (isDashboardSessionExpired()) {
      window.dispatchEvent(new CustomEvent(DASHBOARD_SESSION_EXPIRED_EVENT, { detail: { message: "Dashboard session expired. Please sign in again." } }));
      return;
    }

    const walletInfo = extractWalletInfoRef.current();
    // Every path that returns without starting a run has to release the
    // spinner, or an aborted predecessor leaves isLoading stuck true forever.
    if (!walletInfo) { setIsLoading(false); return; }
    const addr = walletInfo.address;

    const storedWallet = localStorage.getItem(WALLET_KEY);
    if (storedWallet && storedWallet !== addr) {
      clearStoredDashboardAuth(storedWallet);
      clearDashboardQueryCache();
      setCredential(null);
      setFreshApiKey(null);
    }

    setWalletAddress(addr);

    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }

    // The session token is the dashboard credential. A pre-migration stored
    // API key still authenticates (hashed lookup) and is replaced on next login.
    const existingCredential = localStorage.getItem(SESSION_KEY) || localStorage.getItem(LEGACY_KEY);
    const existingKeyWallet = localStorage.getItem(WALLET_KEY);
    if (existingCredential && existingKeyWallet === addr) {
      setCredential(existingCredential);
      setIsLoading(false);
      return;
    }

    const legacyWalletKey = localStorage.getItem(`serapay_apikey_${addr}`);
    if (legacyWalletKey) {
      localStorage.removeItem(`serapay_apikey_${addr}`);
    }

    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsLoading(true);
    setError(null);

    (async () => {
      try {
        let authToken: string | null = null;
        authToken = await getAccessToken();
        if (!authToken) throw new Error("Privy access token is unavailable");

        const headers: Record<string, string> = { "Content-Type": "application/json" };
        headers["Authorization"] = `Bearer ${authToken}`;

        // Derive a display name from the Privy user object
        const privyUser = userRef.current as any;
        const derivedName: string =
          privyUser?.google?.name ||
          privyUser?.email?.address?.split("@")?.[0] ||
          "My Store";

        // Signing is a fallback, not a step. The server already proves this
        // wallet belongs to the Privy user from the access token alone
        // (assertPrivyWalletOwnership); a signature is only needed when that
        // lookup itself fails. Nothing is being paid at sign-in, so asking for
        // one up front bought no security and cost every merchant a popup.
        const requestWalletProof = () => {
          const key = `${addr}:${retryCount}`;
          if (walletProofRef.current?.key !== key) {
            walletProofRef.current = { key, promise: signWalletProofRef.current(addr, walletInfo.walletType) };
          }
          return walletProofRef.current.promise;
        };

        const registerMerchant = async (walletProof?: Awaited<ReturnType<typeof signWalletProof>>) => fetch("/api/merchant/register", {
          method: "POST",
          headers,
          body: JSON.stringify({ walletAddress: addr, name: derivedName, walletType: walletInfo.walletType, ...(walletProof ? { walletProof } : {}) }),
          signal: controller.signal,
        });

        let res = await registerMerchant();

        if (controller.signal.aborted) return;

        /*
          A Privy access token can be accepted by the SDK and still be rejected
          by the server moments later — it expires between being read and being
          verified, which is common right after a page load or a resumed
          session. 401 is not in the retryable-status list below, so this
          surfaced as "Invalid Privy access token" and stranded the merchant on
          the setup screen until they pressed Retry. Pressing Retry only worked
          because it fetched a fresh token, so do exactly that here, once,
          without making them click anything.
        */
        if (res.status === 401) {
          const body = await res.clone().json().catch(() => null);
          if (body?.code === "PRIVY_TOKEN_INVALID") {
            const refreshedToken = await getAccessToken().catch(() => null);
            if (controller.signal.aborted) return;
            if (refreshedToken) {
              headers["Authorization"] = `Bearer ${refreshedToken}`;
              res = await registerMerchant();
              if (controller.signal.aborted) return;
            }
          }
        }

        if (!res.ok) {
          let body = await res.json().catch(() => null);
          // PRIVY_WALLET_MISMATCH is deliberately absent. That code means Privy
          // answered and said this wallet is not linked to the account, which a
          // signature cannot overrule - retrying with one only popped a
          // surprise prompt after a MetaMask account switch and then registered
          // a second, empty merchant.
          if (["PRIVY_USER_LOOKUP_FAILED", "PRIVY_CONFIG_MISSING"].includes(body?.code)) {
            const walletProof = walletInfo.kind === "external"
              ? await requestWalletProof()
              : null;
            if (walletProof && !controller.signal.aborted) {
              res = await registerMerchant(walletProof);
              if (res.ok) {
                const data = await res.json();
                const token = data.sessionToken;
                localStorage.setItem(SESSION_KEY, token);
                localStorage.setItem(WALLET_KEY, addr);
                startDashboardSession();
                setCredential(token);
                setFreshApiKey(typeof data.apiKey === "string" ? data.apiKey : null);
                setError(null);
                setRetryCount(0);
                const p = window.location.pathname;
                const stayPut = p === "/" || p.startsWith("/wallet/") || p.startsWith("/pay");
                if (!stayPut) setLocation("/dashboard");
                return;
              }
              body = await res.json().catch(() => body);
            }
          }
          const setupError = new Error(body?.error || "Account setup failed") as Error & { status?: number; code?: string };
          setupError.status = res.status;
          setupError.code = body?.code;
          throw setupError;
        }
        const data = await res.json();
        const token = data.sessionToken as string;
        const freshKey = typeof data.apiKey === "string" ? data.apiKey : null;

        if (controller.signal.aborted) return;

        localStorage.setItem(SESSION_KEY, token);
        localStorage.setItem(WALLET_KEY, addr);
        startDashboardSession();
        setCredential(token);
        setFreshApiKey(freshKey);
        setError(null);
        setRetryCount(0);
        // Only redirect to /dashboard if the user is on a non-app page (e.g. /404).
        // Do NOT redirect from: / (QR generator), /pay/* or /wallet/pay/* (payment flow), /wallet/history/*
        const p = window.location.pathname;
        const stayPut = p === "/" || p.startsWith("/wallet/") || p.startsWith("/pay");
        if (!stayPut) {
          setLocation("/dashboard");
        }
      } catch (err: any) {
        // A superseded run finishing late must not clear the key, the storage or
        // the error state belonging to the run that replaced it.
        if (err?.name === "AbortError" || controller.signal.aborted) return;
        setCredential(null);
      setFreshApiKey(null);
        clearStoredDashboardAuth(addr);
        clearDashboardQueryCache();
        const rawMessage = err?.message || "";
        const status = Number(err?.status || 0);
        const retryableStatus = status === 0 || status === 408 || status === 425 || status === 500 || status === 502 || status === 503 || status === 504;
        const shouldRetrySetup = retryCount < 3 && retryableStatus && /privy|token|jwt|authorization|account setup|merchant|network|failed to fetch|lookup/i.test(rawMessage);
        if (shouldRetrySetup) {
          setError(null);
          const retryDelay = Math.min(4000 + retryCount * 6000, 20000);
          retryTimerRef.current = setTimeout(() => {
            retryTimerRef.current = null;
            setRetryCount((count) => count + 1);
          }, retryDelay);
        } else {
          setError(formatAccountSetupError(err));
        }
      } finally {
        if (!controller.signal.aborted) setIsLoading(false);
      }
    })();

    return () => {
      controller.abort();
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  // Primitives only. `user`, `wallets` and the callbacks derived from them
  // change identity constantly, and `walletAddress` is assigned by this very
  // effect — listing any of them re-entered account setup on every render.
  }, [authenticated, ready, resolvedAddress, resolvedWalletKind, retryCount, getAccessToken, setLocation, clearDashboardQueryCache]);

  const login = useCallback(async () => {
    setError(null);
    await privyLogin();
  }, [privyLogin]);

  const retry = useCallback(() => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    setError(null);
    setRetryCount((c) => c + 1);
  }, []);

  const logout = useCallback(() => {
    if (abortRef.current) abortRef.current.abort();
    // Both survive a logout otherwise, so a previously rejected signature would
    // be replayed on the next login and reported as cancelled without ever
    // showing the merchant a prompt.
    walletProofRef.current = null;
    setRetryCount(0);
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    clearStoredDashboardAuth(walletAddress);
    clearDashboardQueryCache();
    setCredential(null);
    setFreshApiKey(null);
    setWalletAddress(null);
    setError(null);
    if (authenticated) void privyLogout();
    setLocation("/");
  }, [authenticated, clearDashboardQueryCache, privyLogout, setLocation, walletAddress]);

  const isAuthenticated = authenticated;

  return (
    <AuthContext.Provider value={{ credential, freshApiKey, walletAddress, isAuthenticated, isLoading: isLoading || !ready, error, login, retry, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}
