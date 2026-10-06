import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  privy: { authenticated: false, ready: true, user: null as any, login: vi.fn() },
  auth: { apiKey: null as string | null, walletAddress: null as string | null, isLoading: false, error: null, logout: vi.fn(), retry: vi.fn() },
  profile: { data: undefined as any, isLoading: false },
  loadCurrencies: vi.fn(),
  signCheckout: vi.fn(),
  navigate: vi.fn(),
  queryClient: { invalidateQueries: vi.fn() },
}));

vi.mock("@privy-io/react-auth", () => ({ usePrivy: () => state.privy }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => state.auth }));
vi.mock("@/hooks/use-merchant", () => ({ useMerchantProfile: () => state.profile }));
vi.mock("@/hooks/use-gateway", () => ({ useSeraApiConfig: () => ({ data: { mode: "live" } }) }));
vi.mock("wagmi", () => ({ useChainId: () => 1 }));
vi.mock("wouter", () => ({ useLocation: () => ["/", state.navigate] }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => state.queryClient }));
vi.mock("@/lib/currencyCalculator", async (importOriginal) => ({
  ...await importOriginal<any>(),
  loadSeraCurrencies: state.loadCurrencies,
}));
vi.mock("@/lib/payment", async (importOriginal) => ({
  ...await importOriginal<any>(),
  requestSignedPaymentUrl: state.signCheckout,
}));
vi.mock("@/components/QRStyled", () => ({
  QRStyled: (props: any) => React.createElement("div", { "data-qr-value": props.value }),
  QR_STYLES: [{ id: "rounded", label: "Rounded" }],
}));
vi.mock("@/components/SeraPayHeader", () => ({ SeraPayHeader: () => null, SeraLogo: () => null }));
vi.mock("@/components/NetworkSwitcher", () => ({ NetworkModeButton: () => null, NetworkSwitcherModal: () => null }));
vi.mock("@/pages/SeoPages", () => ({ SeoFooter: () => null }));

import Home from "../client/src/pages/Home";

const walletAddress = "0x1234567890abcdef1234567890abcdef12345678";
const settlementAddress = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const currencies = [
  { symbol: "USDC", name: "USD Coin", decimals: 6, address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", chainId: 1 },
  { symbol: "USDT", name: "Tether", decimals: 6, address: "0xdac17f958d2ee523a2206206994597c13d831ec7", chainId: 1 },
];
const pendingKey = "serapay_pending_request";
let renderer: ReactTestRenderer | undefined;
let storage: Map<string, string>;

function savedRequest(extra: Record<string, unknown> = {}) {
  return { receiveCoin: "USDC", amount: "0.1", wantQr: true, savedAt: Date.now(), ...extra };
}

async function mount() {
  await act(async () => { renderer = create(React.createElement(Home)); });
}

async function rerender() {
  await act(async () => { renderer!.update(React.createElement(Home)); });
}

function textOf(node: any): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  return (node.children || []).map(textOf).join("");
}

async function clickButton(label: string) {
  const button = renderer!.root.findAllByType("button").find((node) => textOf(node) === label);
  expect(button, `Button ${label}`).toBeDefined();
  await act(async () => { button!.props.onClick(); });
}

beforeEach(() => {
  vi.clearAllMocks();
  storage = new Map();
  Object.assign(state.privy, { authenticated: false, ready: true, user: null });
  Object.assign(state.auth, { apiKey: null, walletAddress: null, isLoading: false });
  Object.assign(state.profile, { data: undefined, isLoading: false });
  state.loadCurrencies.mockResolvedValue(currencies);
  state.signCheckout.mockResolvedValue("https://pay.sera.cx/pay/signed-request");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("React", React);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  vi.stubGlobal("window", {
    location: { pathname: "/", href: "https://pay.sera.cx/", origin: "https://pay.sera.cx" },
    innerWidth: 390, setInterval, clearInterval, setTimeout, clearTimeout,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  });
  vi.stubGlobal("document", { hidden: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ pairs: {}, events: [], transactions: [] }), {
    headers: { "Content-Type": "application/json" },
  })));
});

afterEach(async () => {
  if (renderer) await act(async () => { renderer!.unmount(); });
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("Home wallet approval resumes the merchant's QR request", () => {
  it("keeps the saved request while the initial currency registry is loading", async () => {
    const pending = savedRequest();
    storage.set(pendingKey, JSON.stringify(pending));
    let resolveRegistry!: (value: typeof currencies) => void;
    state.loadCurrencies.mockImplementation(() => new Promise((resolve) => { resolveRegistry = resolve; }));
    await mount();
    expect(JSON.parse(storage.get(pendingKey)!)).toEqual(pending);
    expect(state.signCheckout).not.toHaveBeenCalled();

    await act(async () => { resolveRegistry(currencies); });
    expect(JSON.parse(storage.get(pendingKey)!).amount).toBe("0.1");
    expect(JSON.parse(storage.get(pendingKey)!).receiveCoin).toBe("USDC");
  });

  it.each(["USDC", "USDT"])("resumes exactly 0.1 %s after approval and reload", async (receiveCoin) => {
    storage.set(pendingKey, JSON.stringify(savedRequest({ receiveCoin })));
    state.privy.authenticated = true;
    state.privy.user = { wallet: { address: walletAddress } };
    Object.assign(state.auth, { walletAddress, isLoading: true });
    await mount();
    expect(state.signCheckout).not.toHaveBeenCalled();
    expect(JSON.parse(storage.get(pendingKey)!).amount).toBe("0.1");

    // Registration can finish before the merchant's configured receiver loads.
    Object.assign(state.auth, { apiKey: "merchant-key", isLoading: false });
    state.profile.isLoading = true;
    await rerender();
    expect(state.signCheckout).not.toHaveBeenCalled();

    Object.assign(state.profile, { isLoading: false, data: { name: "Test Store", storeAddress: settlementAddress } });
    await rerender();
    expect(state.signCheckout).toHaveBeenCalledTimes(1);
    expect(state.signCheckout).toHaveBeenCalledWith(expect.objectContaining({
      receiverAddress: settlementAddress, receiveCoin, amount: "0.1", chainId: 1,
      payCoin: undefined, payAmount: undefined,
    }));
    expect(storage.has(pendingKey)).toBe(false);
    expect(renderer!.root.findAll((node) => node.props["data-qr-value"] === "https://pay.sera.cx/pay/signed-request")).toHaveLength(1);
    expect(state.navigate).not.toHaveBeenCalled();
  });

  it("resumes a newly submitted request in the same browser without a reload", async () => {
    // Restoring an ordinary draft must not consume a later Generate QR intent.
    storage.set(pendingKey, JSON.stringify(savedRequest({ wantQr: false })));
    await mount();
    await clickButton("Generate QR");
    const modal = renderer!.root.find((node) => typeof node.type === "function" && node.type.name === "GuestReceiverModal");
    await act(async () => { modal.props.onConnect(["wallet"]); });
    expect(state.privy.login).toHaveBeenCalledWith({ loginMethods: ["wallet"] });

    state.privy.authenticated = true;
    state.privy.user = { wallet: { address: walletAddress } };
    Object.assign(state.auth, { walletAddress, apiKey: "merchant-key" });
    await rerender();
    expect(state.signCheckout).toHaveBeenCalledTimes(1);
    expect(state.signCheckout).toHaveBeenCalledWith(expect.objectContaining({ receiveCoin: "USDC", amount: "0.1" }));
    expect(state.navigate).not.toHaveBeenCalled();
  });

  it("persists and resumes a fresh request with no previous saved draft", async () => {
    await mount();
    await clickButton("Select coin");
    const picker = renderer!.root.find((node) => typeof node.type === "function" && node.type.name === "CoinSheet");
    await act(async () => { picker.props.onSelect(currencies[0]); });
    await act(async () => { renderer!.root.findAllByType("input")[0].props.onChange({ target: { value: "0.1" } }); });
    expect(JSON.parse(storage.get(pendingKey)!)).toMatchObject({ receiveCoin: "USDC", amount: "0.1" });
    await clickButton("Generate QR");
    state.privy.authenticated = true;
    Object.assign(state.auth, { walletAddress, apiKey: "merchant-key" });
    await rerender();
    expect(state.signCheckout).toHaveBeenCalledTimes(1);
    expect(state.signCheckout).toHaveBeenCalledWith(expect.objectContaining({ receiveCoin: "USDC", amount: "0.1" }));
  });

  it("keeps the draft but withdraws auto-generation when the receiver modal is cancelled", async () => {
    storage.set(pendingKey, JSON.stringify(savedRequest({ wantQr: false })));
    await mount();
    await clickButton("Generate QR");
    const modal = renderer!.root.find((node) => typeof node.type === "function" && node.type.name === "GuestReceiverModal");
    await act(async () => { modal.props.onClose(); });
    expect(JSON.parse(storage.get(pendingKey)!)).toMatchObject({ receiveCoin: "USDC", amount: "0.1", wantQr: false });
    state.privy.authenticated = true;
    Object.assign(state.auth, { walletAddress, apiKey: "merchant-key" });
    await rerender();
    expect(state.signCheckout).not.toHaveBeenCalled();
  });
});
