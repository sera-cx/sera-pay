import { describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { EncryptJWT, jwtDecrypt, SignJWT, jwtVerify } from "jose";
import { parse as parseCookies } from "cookie";
import {
  createWalletClient,
  custom,
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  keccak256,
  parseAbi,
  parseTransaction,
  parseUnits,
  recoverTransactionAddress,
  verifyTypedData,
  zeroAddress,
  type Address,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { integrationPath } from "../client/src/pages/integrations/catalog";
import { historyGuides } from "../client/src/pages/integrations/guides/history";
import { guides } from "../client/src/pages/integrations/guides";
import {
  API_SETUP,
  WALLET_SIGNING,
  WALLET_CONTEXT,
  WALLET_BACKEND_SETUP,
  WALLET_SESSION,
  WALLET_BALANCES,
} from "../client/src/pages/integrations/guides/shared";
import * as swap from "../client/src/pages/swap-guide/content/code-samples";
import { TESTNET_CHECKS } from "../client/src/pages/swap-guide/content/checklists";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// Execute trusted repository examples verbatim so documentation and tests cannot drift independently.
const run = (code: string, context: Record<string, unknown>, result = "") =>
  new AsyncFunction(...Object.keys(context), code + "\n" + result)(
    ...Object.values(context),
  );

const account = privateKeyToAccount(generatePrivateKey());
const address = (byte: string) => ("0x" + byte.repeat(20)) as Address;
const owner = account.address;
const recipient = address("22");
const from = address("33");
const to = address("44");
const vault = address("55");
const router = address("66");
const now = 1_800_000_000;
const config = {
  chain_id: 11155111,
  eip712_domain: {
    name: "Sera",
    version: "1",
    chainId: 11155111,
    verifyingContract: address("77"),
  },
  sera_address: address("77"),
  vault_address: vault,
  sor_address: router,
  limits: { vl_batch: { min: 2, max: 50 } },
};
const cash = { address: from, decimals: 6, min_trade_amount_raw: "1000000" };
const clock = { timestamp: now };
const bearer = "synthetic-key:synthetic-secret";
const external = "https://api.testnet.sera.cx/api/v1";
const sample = (flow: keyof typeof guides, id: string) =>
  guides[flow].steps.find((step) => step.id === id)!;
const wallet = () => ({
  getChainId: vi.fn(async () => config.chain_id),
  getAddresses: vi.fn(async () => [owner]),
  signTypedData: vi.fn(async (data) => account.signTypedData(data)),
});
const request = {
  owner_address: owner,
  from_token: from,
  to_token: to,
  recipient,
  from_amount: "25000000",
  expiration: now + 300,
  gas_mode: "receive_less",
};
const route = {
  taker: owner,
  inputToken: from,
  outputToken: to,
  recipient,
  maxInputAmount: "25000000",
  minOutputAmount: "23000000",
  initialDepositAmount: "25000000",
  uuid: "1",
  deadline: now + 300,
};
const allowance = {
  permit_supported: false, permit_required: false, token: from, spender: router,
  value_raw: route.initialDepositAmount, current_allowance_raw: route.initialDepositAmount,
};
const quote = { uuid: "quote-1", expires_at: now + 30, route_params: route, permit: allowance };
const makeQuoteGuard = () =>
  run(swap.VERIFY_QUOTE, { getAddress }, "return assertSwapQuote;");

function settledTrade(tradeId = "trade", amount = "25000000") {
  const hash = keccak256("0x1234");
  const economics = {
    perspective_order_id: tradeId,
    balance_debits: [{ token_address: from, amount_raw: "25000000" }],
    balance_credits: [{ token_address: to, amount_raw: amount }],
  };
  return {
    order: {
      trade_id: tradeId,
      uuid_int: route.uuid,
      owner_address: owner,
      order_type: "swap",
      from_token: from,
      to_token: to,
      status: "settled",
      settlement_summary: {
        status: "settled",
        total_fill_count: 1,
        settled_fill_count: 1,
        pending_fill_count: 0,
        latest_tx_hash: hash,
      },
      settlement_economics: economics,
    },
    fills: [
      {
        taker_order_id: tradeId,
        settlement_status: "settled",
        tx_hash: hash,
        settlement_economics: economics,
      },
    ],
  };
}

function settlementApi(
  snapshot: ReturnType<typeof settledTrade>,
  tradeId = "trade",
) {
  return vi.fn(async (path: string, options: { bearer: string }) => {
    expect(options).toEqual({ bearer });
    if (path === "/orders/" + tradeId) return snapshot.order;
    const url = new URL(path, external);
    if (url.pathname === "/fills/" + tradeId) {
      const limit = Number(url.searchParams.get("limit"));
      const offset = Number(url.searchParams.get("offset"));
      expect(limit).toBeGreaterThan(0);
      expect(limit).toBeLessThanOrEqual(100);
      return { items: snapshot.fills.slice(offset, offset + limit) };
    }
    throw new Error("Unexpected API call: " + path);
  });
}

async function checkOrderListExample(flow: "swap" | "set-rate") {
  const type = flow === "swap" ? "swap" : "limit";
  const first = { trade_id: "a", owner_address: owner, order_type: type, created_at: "2026-01-02",
    status: "matched", symbol: "USDT/USDC", from_amount: "2001802", filled_base_amount: "0E-18" };
  const data = Array.from({ length: 21 }, (_, index) => ({ ...first, trade_id: String(index) }));
  const api = vi.fn(async (path: string, options) => {
    const url = new URL(path, external);
    expect(url.pathname).toBe("/orders");
    expect(url.searchParams.get("owner_address")).toBe(owner.toLowerCase());
    expect(url.searchParams.get("type")).toBe(type);
    expect(url.searchParams.get("order")).toBe("desc");
    expect(options).toEqual({ bearer });
    const offset = Number(url.searchParams.get("offset"));
    const limit = Number(url.searchParams.get("limit"));
    return { trades: data.slice(offset, offset + limit), total: data.length };
  });
  const { page, readPage } = await run(historyGuides[flow].example,
    { owner, bearer, network: "sepolia", seraFor: (network: string) => { expect(network).toBe("sepolia"); return api; } },
    "return { page, readPage };");
  expect(page.rows).toHaveLength(20);
  expect(page.rows[0]).toMatchObject({ orderStatus: "matched", ...(type === "swap"
    ? { requestedInputRaw: "2001802" } : { filledBase: "0E-18" }) });
  expect(page.nextOffset).toBe(20);
  const last = await readPage(page.nextOffset, page.before);
  expect(last.rows).toHaveLength(1);
  expect(last.nextOffset).toBeNull();
  expect(last.before).toBe(page.before);
  api.mockResolvedValueOnce({ trades: [{ ...first, owner_address: recipient }], total: 1 });
  await expect(readPage()).rejects.toThrow("Order history unavailable");
  api.mockResolvedValueOnce({ trades: [], total: 1 });
  await expect(readPage()).rejects.toThrow("Order history unavailable");
  api.mockResolvedValueOnce({ trades: [], total: 0 });
  expect((await readPage()).rows).toEqual([]);
}

describe("Swap guide audit", () => {
  it("11 lists only the owner’s paginated swaps with authentic status", () => checkOrderListExample("swap"));
  it("01 bootstraps Sepolia using one public API and rejects mixed domains", async () => {
    const setup = API_SETUP.replace(/^export /gm, "");
    const bootstrap = (domain = config.eip712_domain) =>
      run(
        setup,
        {
          fetch: async (url: string, init: RequestInit) => {
            expect(init.redirect).toBe("error");
            expect(url.startsWith(external)).toBe(true);
            const payload = url.endsWith("/config")
              ? { ...config, eip712_domain: domain }
              : url.endsWith("/tokens")
                ? { tokens: [cash] }
                : clock;
            return Response.json(payload);
          },
        },
        'const { config, tokens, seraNow } = await loadSeraNetwork("sepolia"); return [config.chain_id, tokens.length, seraNow];',
      );
    await expect(bootstrap()).resolves.toEqual([11155111, 1, now]);
    await expect(
      bootstrap({ ...config.eip712_domain, chainId: 1 }),
    ).rejects.toThrow("Unexpected Sera signing deployment");
  });

  it("02 creates an exact-unit quote with explicit recipient and Sera time", async () => {
    const sera = vi.fn(async (path) =>
      path === "/system/time" ? clock : quote,
    );
    const result = await run(
      swap.QUOTE_REQUEST,
      {
        sera,
        getAddress,
        parseUnits,
        zeroAddress,
        owner,
        fromToken: cash,
        toToken: { address: to },
        reviewedRecipient: recipient,
        amount: "25",
        gasMode: "receive_less",
      },
      "return { request, quotedAt };",
    );
    expect(result.request).toEqual({
      ...request,
      owner_address: owner.toLowerCase(),
    });
    expect(result.quotedAt).toBe(now);
    expect(sera).toHaveBeenNthCalledWith(2, "/swap/quote", {
      body: result.request,
    });
  });

  it("03 stops zero, over-precision, below-minimum and same-token inputs before requests", async () => {
    const sera = vi.fn();
    const input = {
      sera,
      getAddress,
      parseUnits,
      zeroAddress,
      owner,
      fromToken: cash,
      toToken: { address: to },
      reviewedRecipient: recipient,
      amount: "25",
      gasMode: "receive_less",
    };
    for (const change of [
      { amount: "0" },
      { amount: "0.01" },
      { amount: "2.0000001" },
      { toToken: cash },
      { reviewedRecipient: zeroAddress },
    ]) {
      await expect(
        run(swap.QUOTE_REQUEST, { ...input, ...change }),
      ).rejects.toThrow();
    }
    expect(sera).not.toHaveBeenCalled();
  });

  it("04 binds the returned quote to the reviewed payer, receiver and pair", async () => {
    const guard = await makeQuoteGuard();
    expect(guard(quote, request, now, now)).toEqual(route);
    for (const changed of [
      { taker: recipient },
      { recipient: owner },
      { inputToken: to },
      { outputToken: from },
    ]) {
      expect(() =>
        guard(
          { ...quote, route_params: { ...route, ...changed } },
          request,
          now,
          now,
        ),
      ).toThrow("reviewed swap");
    }
  });

  it("05 rejects stale quotes, invalid bounds and a changed gas-mode amount", async () => {
    const guard = await makeQuoteGuard();
    expect(() => guard(quote, request, now + 25, now)).toThrow("Refresh");
    expect(() =>
      guard({ ...quote, expires_at: now + 5 }, request, now, now),
    ).toThrow("Refresh");
    for (const changed of [
      { minOutputAmount: "0" },
      { initialDepositAmount: "50000000" },
      { maxInputAmount: "25000001" },
      { deadline: now + 301 },
      { uuid: "-1" },
    ]) {
      expect(() =>
        guard(
          { ...quote, route_params: { ...route, ...changed } },
          request,
          now,
          now,
        ),
      ).toThrow();
    }
  });

  it("06 signs the documented Intent and blocks the wrong wallet network", async () => {
    const walletClient = wallet();
    const context = {
      getAddress,
      walletClient,
      config,
      request,
      quote,
      owner,
      sera: async () => clock,
      quotedAt: now,
      assertSwapQuote: await makeQuoteGuard(),
    };
    const signature = await run(swap.SIGN_INTENT, context, "return signature;");
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/i);
    expect(
      walletClient.signTypedData.mock.calls[0][0].types.Intent.at(-1),
    ).toEqual({ name: "deadline", type: "uint48" });
    const externalWallet = createWalletClient({ transport: custom({
      async request({ method, params }) {
        if (method === "eth_chainId") return "0xaa36a7";
        if (method === "eth_accounts") return [owner];
        expect(method).toBe("eth_signTypedData_v4");
        const [signer, serialized] = params as [string, string];
        expect(signer.toLowerCase()).toBe(owner.toLowerCase());
        const payload = JSON.parse(serialized);
        expect(payload.types.EIP712Domain).toEqual([
          { name: "name", type: "string" }, { name: "version", type: "string" },
          { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
        ]);
        expect(await verifyTypedData({ ...payload, address: owner, signature })).toBe(true);
        return signature;
      },
    }) });
    await expect(run(swap.SIGN_INTENT, { ...context, walletClient: externalWallet }, "return signature;"))
      .resolves.toBe(signature);
    walletClient.getChainId.mockResolvedValueOnce(1);
    await expect(run(swap.SIGN_INTENT, context)).rejects.toThrow(
      "configured network",
    );
    walletClient.getAddresses.mockResolvedValueOnce([owner]).mockResolvedValueOnce([recipient]);
    await expect(run(swap.SIGN_INTENT, context)).rejects.toThrow("signed-in wallet");
    expect(walletClient.signTypedData).toHaveBeenCalledTimes(2);
  });

  it("07 signs a bound permit and rejects an unexpected spender without signing", async () => {
    const walletClient = wallet();
    const permit = {
      ...allowance, owner,
      permit_required: true,
      permit_supported: true,
      value_raw: route.initialDepositAmount,
      eip712: {
        primaryType: "Permit",
        domain: { ...config.eip712_domain, verifyingContract: from },
        message: {
          owner,
          spender: router,
          value: route.initialDepositAmount,
          nonce: "0",
          deadline: now + 30,
        },
      },
    };
    const context = {
      walletClient,
      config,
      getAddress,
      owner,
      request,
      quotedAt: now,
      sera: async () => clock,
      assertSwapQuote: await makeQuoteGuard(),
    };
    for (const insufficient of [null, { ...allowance, current_allowance_raw: "0" }]) {
      await expect(run(swap.SIGN_PERMIT, { ...context, quote: { ...quote, permit: insufficient } })).rejects.toThrow();
      await expect(run(swap.SIGN_INTENT, { ...context, signedPermit: undefined, quote: { ...quote, permit: insufficient } })).rejects.toThrow();
    }
    expect(walletClient.signTypedData).not.toHaveBeenCalled();
    const signed = await run(
      swap.SIGN_PERMIT,
      { ...context, quote: { ...quote, permit } },
      "return signedPermit;",
    );
    expect(signed).toMatchObject({ quoteId: quote.uuid, deadline: now + 30 });
    const bad = {
      ...permit,
      eip712: {
        ...permit.eip712,
        message: { ...permit.eip712.message, spender: vault },
      },
    };
    await expect(
      run(swap.SIGN_PERMIT, { ...context, quote: { ...quote, permit: bad } }),
    ).rejects.toThrow("Refresh the permission");
    expect(walletClient.signTypedData).toHaveBeenCalledTimes(1);
  });

  it("08 stores the attempt before submit, rejects mismatched permits and leaves timeouts unresolved", async () => {
    const claimPendingSwap = vi.fn();
    const saveTradeId = vi.fn();
    const calls: string[] = [];
    const sera = vi.fn(async (path) => {
      if (path === "/system/time") return clock;
      calls.push(path);
      throw new Error("lost response");
    });
    claimPendingSwap.mockImplementation(() => { calls.push("persisted"); return true; });
    const context = {
      sera,
      getAddress,
      claimPendingSwap,
      saveTradeId,
      config,
      quote,
      request,
      quotedAt: now,
      signature: "test",
      assertSwapQuote: await makeQuoteGuard(),
    };
    await expect(
      run(swap.SUBMIT, { ...context, signedPermit: { quoteId: "wrong" } }),
    ).rejects.toThrow("permit");
    await expect(
      run(swap.SUBMIT, { ...context, signedPermit: undefined }),
    ).rejects.toThrow("lost response");
    expect(calls).toEqual(["persisted", "/swap"]);
    expect(claimPendingSwap).toHaveBeenCalledWith(quote.uuid, { request, chainId: config.chain_id, signedRoute: quote.route_params });
    claimPendingSwap.mockReturnValueOnce(false);
    await expect(run(swap.SUBMIT, { ...context, signedPermit: undefined })).rejects.toThrow("already awaiting");
    expect(calls).toEqual(["persisted", "/swap"]);
    expect(saveTradeId).not.toHaveBeenCalled();
  });

  it("09 requires matching settled order and fills under the payer credential", async () => {
    const get = (snapshot: ReturnType<typeof settledTrade>) =>
      run(
        swap.TRACK,
        { route, tradeId: "trade", bearer, sera: settlementApi(snapshot) },
        "return settled;",
      );
    const pending = settledTrade();
    pending.order.status = "matched";
    await expect(get(pending)).resolves.toBe(false);
    for (const state of ["pending", "confirming", "failed", "reverted"]) {
      const conflict = settledTrade();
      conflict.fills[0].settlement_status = state;
      await expect(get(conflict)).resolves.toBe(false);
    }
    const foreign = settledTrade();
    foreign.order.owner_address = recipient;
    await expect(get(foreign)).rejects.toThrow("does not match");
    const changedRoute = settledTrade();
    changedRoute.order.uuid_int = "2";
    await expect(get(changedRoute)).rejects.toThrow("does not match");
    const missingUuid = settledTrade();
    Reflect.deleteProperty(missingUuid.order, "uuid_int");
    await expect(get(missingUuid)).rejects.toThrow("does not match");
    const contradictory = settledTrade();
    contradictory.order.settlement_summary.pending_fill_count = 1;
    await expect(get(contradictory)).resolves.toBe(false);
    await expect(get(settledTrade())).resolves.toBe(true);
    const multiple = settledTrade();
    multiple.order.settlement_summary.total_fill_count = 101;
    multiple.order.settlement_summary.settled_fill_count = 101;
    multiple.fills = Array.from({ length: 101 }, (_, index) => {
      const units = index < 100 ? "200000" : "5000000";
      return {
        ...multiple.fills[0],
        settlement_economics: {
          perspective_order_id: "trade",
          balance_debits: [{ token_address: from, amount_raw: units }],
          balance_credits: [{ token_address: to, amount_raw: units }],
        },
      };
    });
    await expect(get(multiple)).resolves.toBe(true);
    multiple.fills.pop();
    await expect(get(multiple)).resolves.toBe(false);
  });

  it("10 restores each wallet’s Sepolia and Live credentials across visits", async () => {
    type Network = "sepolia" | "live";
    const mainnet = "https://api.sera.cx/api/v1";
    const ownerAddress = owner.toLowerCase();
    let activeChain = config.chain_id;
    const signer = {
      ...wallet(),
      getChainId: vi.fn(async () => activeChain),
      switchChain: vi.fn(async ({ id }: { id: number }) => { activeChain = id; }),
    };
    const cookies = new Map<string, string>();
    const sealedCookies = () => Array.from(cookies, ([name, value]) => name + "=" + value).join("; ");
    const setup = await run(
      WALLET_BACKEND_SETUP.replace(/^import .*;$/gm, ""),
      { EncryptJWT, jwtDecrypt, parseCookies, process: { env: {
        NODE_ENV: "production", COOKIE_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      } } },
      "return { authenticatedOwner, walletBearer, cookieKey, audience, cookieName, cookieOptions };",
    );

    let createConflict: string | null = null;
    let failure: "revoked" | "temporarily unavailable" | null = null;
    const upstream = async (url: string, options: RequestInit) => {
      const network: Network = url.startsWith(external + "/") ? "sepolia" : "live";
      const base = network === "sepolia" ? external : mainnet;
      const chainId = network === "sepolia" ? 11155111 : 1;
      expect(url.startsWith(base + "/")).toBe(true);
      const path = url.slice(base.length);
      const domain = { ...config.eip712_domain, chainId };
      const authorization = new Headers(options.headers).get("Authorization");
      const issued = { api_key: network + "-key", api_secret: network + "-secret" };
      if (path === "/config" || path === "/system/time") {
        expect(options.credentials).toBeUndefined();
        expect(authorization).toBeNull();
        return Response.json(path === "/config" ? { ...config, chain_id: chainId, eip712_domain: domain } : clock);
      }
      if (path === "/api-keys") {
        expect(authorization).toBeNull();
        const body = JSON.parse(String(options.body));
        expect(body).toMatchObject({ owner_address: ownerAddress, action: "create", timestamp: now });
        expect(await verifyTypedData({
          address: owner, domain, primaryType: "ManageApiKey",
          types: { ManageApiKey: [
            { name: "owner", type: "address" }, { name: "action", type: "string" },
            { name: "timestamp", type: "uint256" },
          ] }, message: { owner, action: "create", timestamp: BigInt(now) }, signature: body.signature,
        })).toBe(true);
        return createConflict ? Response.json({ detail: createConflict }, { status: 409 }) : Response.json(issued);
      }
      if (path === "/api-keys/verify") {
        expect(network).toBe("sepolia");
        expect(authorization).toBeNull();
        expect(JSON.parse(String(options.body))).toEqual(issued);
        return Response.json({ valid: failure !== "revoked", owner_address: ownerAddress });
      }
      expect(path).toBe("/balances?owner_address=" + ownerAddress + "&include_zero=true");
      expect(authorization).toBe("Bearer " + issued.api_key + ":" + issued.api_secret);
      if (failure && network === "sepolia") return Response.json({}, { status: 403 });
      return Response.json({ owner_address: ownerAddress, balances: [{ wallet_balance: network === "sepolia" ? "11" : "77" }] });
    };
    const seraFor = await run(API_SETUP.replace(/^export /gm, ""),
      { fetch: upstream }, "return seraFor;");
    expect(() => seraFor("unsupported")).toThrow("Choose Sepolia or Live");
    let issuedCookies = 0;
    async function localFetch(path: string, options: RequestInit) {
      expect(path.startsWith("/wallet/")).toBe(true);
      const url = new URL(path, "https://app.test");
      const match = /^\/wallet\/(sepolia|live)\/(session|balances|signing-context)$/.exec(url.pathname);
      if (!match) throw new Error("Unexpected wallet route");
      const [, network, route] = match;
      const exchange = route === "session";
      expect(exchange).toBe(options.method === "POST");
      const publicSettings = route === "signing-context";
      expect(options.credentials).toBe(publicSettings ? "omit" : "same-origin");
      expect(new Headers(options.headers).get("Authorization")).toBe(publicSettings ? null : "Bearer app-login");
      let status = 200;
      let payload: unknown;
      const response = {
        set: vi.fn().mockReturnThis(),
        cookie(name: string, sealed: string, options: object) {
          expect(options).toMatchObject({ secure: true, httpOnly: true, sameSite: "lax" });
          expect(name).toBe(setup.cookieName(network, ownerAddress));
          expect(sealed).not.toContain(network + "-secret");
          cookies.set(name, sealed);
          issuedCookies++;
        },
        status(code: number) { status = code; return this; },
        json(data: unknown) { payload = data; },
      };
      const request = {
        headers: { cookie: sealedCookies() }, auth: { walletAddresses: [owner] }, params: { network },
        body: exchange ? JSON.parse(String(options.body)) : {},
        query: { owner_address: url.searchParams.get("owner_address") },
      };
      const handler = publicSettings ? WALLET_CONTEXT : exchange ? WALLET_SESSION : WALLET_BALANCES;
      await run(handler, { request, response, seraFor, ...setup, EncryptJWT });
      expect(response.set).toHaveBeenCalledWith("Cache-Control", publicSettings ? "no-store" : "private, no-store");
      if (exchange && status === 201) expect(payload).toEqual({ walletAccess: true });
      return Response.json(payload, { status });
    }
    // Each visit starts without JS state. Only the browser's cookies survive.
    const visit = (selectedNetwork: Network) => run(WALLET_SIGNING, {
      selectedNetwork, owner, wallet: signer, getAccessToken: async () => "app-login", fetch: localFetch,
    }, "return snapshot.balances[0].wallet_balance;");
    expect(await visit("sepolia")).toBe("11");
    expect(await visit("live")).toBe("77");
    expect(await visit("sepolia")).toBe("11");
    expect(await visit("live")).toBe("77");
    expect(signer.signTypedData).toHaveBeenCalledTimes(2);
    expect(cookies.size).toBe(2);
    const isolated = (network: Network, target: string, value?: string) =>
      setup.walletBearer({ headers: { cookie: setup.cookieName(network, target) + "=" + value } }, network, target);
    const sepoliaSealed = cookies.get(setup.cookieName("sepolia", ownerAddress));
    expect(await isolated("live", ownerAddress, sepoliaSealed)).toBeNull();
    expect(await isolated("sepolia", recipient, sepoliaSealed)).toBeNull();
    expect(await isolated("sepolia", ownerAddress, "tampered")).toBeNull();
    expect(() => setup.authenticatedOwner({ auth: { walletAddresses: [owner] } }, recipient)).toThrow("Sign in with this wallet");

    failure = "temporarily unavailable";
    await expect(visit("sepolia")).rejects.toThrow("try the balance request again");
    expect(signer.signTypedData).toHaveBeenCalledTimes(2);
    expect(await visit("live")).toBe("77");
    failure = null;
    expect(await visit("sepolia")).toBe("11");
    failure = "revoked";
    const stale = await localFetch("/wallet/sepolia/balances?owner_address=" + ownerAddress, {
      credentials: "same-origin", headers: { Authorization: "Bearer app-login" },
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ code: "CLOB_CREDENTIAL_REQUIRED" });
    expect(await visit("live")).toBe("77");
    signer.switchChain.mockRejectedValueOnce(new Error("Switch declined"));
    await expect(visit("sepolia")).rejects.toThrow("Switch declined");
    signer.signTypedData.mockRejectedValueOnce(new Error("User declined"));
    await expect(visit("sepolia")).rejects.toThrow("User declined");
    signer.getAddresses.mockResolvedValueOnce([owner]).mockResolvedValueOnce([recipient]);
    await expect(visit("sepolia")).rejects.toThrow("Select the signed-in wallet on the configured network");
    failure = null;
    cookies.delete(setup.cookieName("sepolia", ownerAddress));
    for (const [detail, feedback] of [
      ["Maximum 10 API keys per wallet. Revoke an existing key before creating a new one.", "already enabled"],
      ["Signature already used", "sign a fresh message"],
      ["Unknown conflict", "Wallet access was not enabled"],
    ]) {
      const before = signer.signTypedData.mock.calls.length;
      createConflict = detail;
      await expect(visit("sepolia")).rejects.toThrow(feedback);
      expect(signer.signTypedData.mock.calls.length).toBe(before + 1);
      expect(await visit("live")).toBe("77");
    }
    expect(issuedCookies).toBe(2);
    expect(
      TESTNET_CHECKS.flatMap((group) => group.items).some((item) =>
        item.q.includes("no permit support"),
      ),
    ).toBe(true);
    expect(integrationPath("/swap/guide")).toEqual({
      flow: "swap",
      guide: true,
    });
  });
});

const sendAmount = 25_000_000n;
const transferData = encodeFunctionData({
  abi: erc20Abi,
  functionName: "transfer",
  args: [recipient, sendAmount],
});
const tx = {
  type: "0x2",
  to: from,
  data: transferData,
  value: "0x0",
  chainId: "0xaa36a7",
  nonce: "0x1",
  gas: "0xea60",
  maxFeePerGas: "0x3b9aca00",
  maxPriorityFeePerGas: "0x1",
};
const transferBuild = sample("transfer", "validate").sample!.code;
const transferSign = sample("transfer", "sign");
const transferSend = transferSign.sample!.code + "\n" + transferSign.extraSamples![0].code;
const transferVerify = sample("transfer", "verify").sample!.code;
const typedTx = {
  to: from,
  data: transferData,
  value: 0n,
  chainId: config.chain_id,
  nonce: 1,
  gas: 60_000n,
  maxFeePerGas: 1_000_000_000n,
  maxPriorityFeePerGas: 1n,
  type: "eip1559" as const,
};
const makeTransfer = () => ({
  encodeFunctionData, decodeFunctionData,
  erc20Abi,
  getAddress,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  verifyTypedData,
  tx,
  config,
  token: cash,
  reviewedRecipient: recipient,
  rawAmount: sendAmount,
  owner,
  bearer,
  wallet: { ...wallet(), request: vi.fn(async () => account.signTransaction(typedTx)) },
  attemptId: "reviewed-transfer",
  claimPendingHash: vi.fn(async () => true),
  sera: vi.fn(async (_path, { body }) => ({ tx_hash: keccak256(body.raw_tx) })),
});
const expectedHash = keccak256("0x1234");
const runBroadcast = (acknowledgment: unknown, recordSubmittedOnce = vi.fn()) =>
  run(transferVerify, {
    expectedHash,
    acknowledgment,
    config,
    recordSubmittedOnce,
  });

describe("Transfer guide audit", () => {
  it("11 restores the scoped signed submission and upgrades only its matching acknowledgment", async () => {
    const store = new Map();
    const get = vi.fn(async (key) => store.get(key));
    const update = vi.fn(async (key, fn) => { store.set(key, fn(store.get(key))); });
    const open = (wallet: string, chainId: number) => run(
      historyGuides.transfer.example.replace(/^import .*;$/gm, ""), { owner: wallet, chainId, get, update },
      "return { readTransfers, saveTransfer };");
    const a = await open(owner, config.chain_id);
    const review = { recipient, token: from, decimals: 6, amountRaw: 5n };
    const hash = keccak256("0x11");
    await a.saveTransfer(review, hash, null);
    await a.saveTransfer(review, hash, { tx_hash: keccak256("0x22") });
    expect(await a.readTransfers()).toMatchObject([{ hash, status: "Unconfirmed", amountRaw: "5" }]);
    await a.saveTransfer(review, hash, { tx_hash: hash });
    await a.saveTransfer({ ...review, amountRaw: 99n }, hash, null);
    expect(await (await open(owner, config.chain_id)).readTransfers()).toMatchObject([{ hash, status: "Submitted", amountRaw: "5" }]);
    expect(await (await open(owner, 1)).readTransfers()).toEqual([]);
    expect(await (await open(recipient, config.chain_id)).readTransfers()).toEqual([]);
    expect(update).toHaveBeenCalledTimes(4);
  });
  it("01 documents Sepolia, wallet-owned credentials and the public route", () => {
    expect(guides.transfer.setup.join(" ")).toContain(
      "credential owner must match",
    );
    expect(integrationPath("/transfer/guide/")).toEqual({
      flow: "transfer",
      guide: true,
    });
  });
  it("02 builds raw ERC-20 units and uses the reviewed recipient", async () => {
    const sera = vi.fn(async () => ({ tx }));
    await run(transferBuild, {
      getAddress,
      parseUnits,
      zeroAddress,
      owner,
      reviewedRecipient: recipient,
      amount: "25",
      token: cash,
      bearer,
      sera,
    });
    expect(sera).toHaveBeenCalledWith("/transfer", {
      bearer,
      body: {
        token: from,
        to: recipient,
        from_address: owner.toLowerCase(),
        amount: "25000000",
      },
    });
  });
  it("03 prevents malformed address, zero address and precision mistakes without requesting a build", async () => {
    const sera = vi.fn();
    const common = {
      getAddress,
      parseUnits,
      zeroAddress,
      owner,
      reviewedRecipient: recipient,
      amount: "25",
      token: cash,
      bearer,
      sera,
    };
    for (const invalid of [
      { reviewedRecipient: "0x1" },
      { reviewedRecipient: zeroAddress },
      { amount: "0" },
      { amount: "0.0000001" },
      { amount: (2n ** 256n).toString() },
    ]) {
      await expect(
        run(transferBuild, { ...common, ...invalid }),
      ).rejects.toThrow();
    }
    expect(sera).not.toHaveBeenCalled();
  });
  it("04 decodes the built transaction and checks chain, contract, native value and transfer arguments", async () => {
    const input = makeTransfer();
    for (const changed of [
      { chainId: "0x1" },
      { value: "0x1" },
      { type: "0x4" },
      { accessList: [{ address: recipient, storageKeys: [] }] },
      { to },
      {
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "transfer",
          args: [owner, sendAmount],
        }),
      },
    ]) {
      await expect(
        run(transferSend, { ...input, tx: { ...tx, ...changed } }),
      ).rejects.toThrow("Transfer changed");
    }
    expect(input.wallet.request).not.toHaveBeenCalled();
  });
  it("05 recomputes the signer and catches changes made after review", async () => {
    const input = makeTransfer();
    const wrongSigner = privateKeyToAccount(generatePrivateKey());
    for (const sign of [
      () => wrongSigner.signTransaction(typedTx),
      () => account.signTransaction({ ...typedTx, nonce: 2 }),
      () => account.signTransaction({ ...typedTx, accessList: [{ address: recipient, storageKeys: [] }] }),
      () =>
        account.signTransaction({ ...typedTx, maxFeePerGas: 2_000_000_000n }),
    ]) {
      await expect(
        run(transferSend, { ...input, wallet: { ...input.wallet, request: sign } }),
      ).rejects.toThrow("Signed transaction");
    }
    expect(input.sera).not.toHaveBeenCalled();
  });
  it("06 saves the signed hash before the one broadcast and checks the returned hash", async () => {
    const input = makeTransfer();
    await run(transferSend, input);
    input.claimPendingHash.mockResolvedValueOnce(false);
    await expect(run(transferSend, input)).rejects.toThrow("already awaiting");
    input.wallet.getAddresses.mockResolvedValueOnce([owner]).mockResolvedValueOnce([recipient]);
    await expect(run(transferSend, input)).rejects.toThrow("signed-in wallet");
    expect(input.sera).toHaveBeenCalledTimes(1);
    expect(input.sera.mock.calls[0][0]).toBe("/transfer/send");
    expect(input.claimPendingHash.mock.invocationCallOrder[0]).toBeLessThan(
      input.sera.mock.invocationCallOrder[0],
    );
    await expect(
      run(transferSend, {
        ...input,
        sera: async () => ({ tx_hash: expectedHash }),
      }),
    ).rejects.toThrow("Unexpected");
  });
  it("07 keeps a declined signature from sending a transfer", async () => {
    const input = makeTransfer();
    await expect(
      run(transferSend, {
        ...input,
        wallet: { ...input.wallet, request: async () => { throw new Error("declined"); } },
      }),
    ).rejects.toThrow("declined");
    expect(input.sera).not.toHaveBeenCalled();
  });
  it("08 keeps missing, malformed or mismatched acknowledgments unresolved", async () => {
    const record = vi.fn();
    for (const response of [
      null,
      {},
      { tx_hash: "invalid" },
      { tx_hash: keccak256("0xff") },
    ]) {
      await runBroadcast(response, record);
    }
    expect(record).not.toHaveBeenCalled();
  });
  it("09 records only submitted status under the original chain and hash on redelivery", async () => {
    const keys = new Set<string>();
    const record = vi.fn(({ chainId, txHash, status }) => {
      expect(status).toBe("submitted");
      keys.add([chainId, txHash].join(":"));
    });
    await runBroadcast({ tx_hash: expectedHash }, record);
    await runBroadcast({ tx_hash: expectedHash }, record);
    expect([...keys]).toEqual([config.chain_id + ":" + expectedHash]);
  });
  it("10 requires a matching Sera acknowledgment and separate credentials for cutover", () => {
    expect(
      guides.transfer.checklist.flatMap((group) => group.items),
    ).toHaveLength(6);
    expect(guides.transfer.production).toMatch(
      /separate wallet credential.+Submitted/,
    );
    expect(sample("transfer", "verify").rules.join(" ")).toMatch(
      /cannot confirm delivery/,
    );
  });
});

const market = { base_address: from, quote_address: to };
const orderId = "3e10b034-b626-4589-b05f-6a536bb10e51";
const secondId = "4e10b034-b626-4589-b05f-6a536bb10e52";
const orderBits = (id: string) => BigInt("0x" + id.replaceAll("-", ""));
const uuid = (
  (orderBits(orderId) << 124n) |
  ((orderBits(orderId) >> 16n) << 12n)
).toString();
const draft = {
  owner_address: owner.toLowerCase(),
  side: "ask",
  from_address: from,
  to_address: to,
  amount: "100.00",
  price: "1.0900",
  order_id: orderId,
  uuid_int: uuid,
  expiration: now + 3600,
  order_type: "limit",
};
const preview = {
  ok: true,
  side: "ask",
  from_token: from,
  to_token: to,
  from_amount: "100000000",
  to_amount: "109000000",
  normalized_amount: "100",
  normalized_price: "1.09",
  eip712_types: { Order: [
    { name: "user", type: "address" }, { name: "expiration", type: "uint48" },
  { name: "feeBps", type: "uint48" }, { name: "recipient", type: "address" },
  { name: "fromToken", type: "address" }, { name: "toToken", type: "address" },
  { name: "fromAmount", type: "uint256" }, { name: "toAmount", type: "uint256" },
  { name: "initialDepositAmount", type: "uint256" }, { name: "uuid", type: "uint256" },
  ] },
  eip712_order: {
    user: owner,
    uuid,
    expiration: draft.expiration,
    fromToken: from,
    toToken: to,
    fromAmount: "100000000",
    toAmount: "109000000",
    recipient: zeroAddress,
    feeBps: "0",
    initialDepositAmount: "0",
  },
};
const rate = (id: string) => sample("set-rate", id);
const publish = () => ({
  owner,
  config,
  getAddress,
  zeroAddress,
  draft,
  preview,
  wallet: {
    getChainId: vi.fn(async () => config.chain_id),
    getAddresses: vi.fn(async () => [owner]),
    signTypedData: vi.fn(async () => "signature"),
  },
  confirmOrderPreview: vi.fn(async () => true),
  savePendingOrder: vi.fn(),
  sera: vi.fn(async (path) =>
    path === "/system/time" ? clock : { order_id: orderId },
  ),
});
const manage = () => ({
  savedUuidInt: uuid,
  owner,
  config,
  bearer,
  order_id: orderId,
  wallet: wallet(),
  sera: vi.fn(async (path) =>
    path === "/orders/" + orderId
      ? {
          trade_id: orderId,
          order_type: "limit",
          owner_address: owner,
          uuid_int: uuid,
        }
      : path.startsWith("/fills")
        ? { items: [] }
        : { status: "ok" },
  ),
});
const batch = () => ({
  owner, getAddress, zeroAddress,
  config,
  executor_id: 0,
  confirmBatchPreview: vi.fn(async () => true),
  wallet: {
    getChainId: vi.fn(async () => config.chain_id),
    getAddresses: vi.fn(async () => [owner]),
    signTypedData: vi.fn(async () => "signature"),
  },
  savePendingBatch: vi.fn(),
  sera: vi.fn(async path => path === "/system/time" ? clock : ({ order_ids: [orderId, secondId] })),
  standaloneDrafts: [
    { draft, preview },
    {
      draft: { ...draft, order_id: secondId, to_address: recipient },
      preview: { ...preview, to_token: recipient, eip712_order: { ...preview.eip712_order, toToken: recipient } },
    },
  ],
});

describe("Set Rate guide audit", () => {
  it("12 lists only the owner’s limit orders and retains base-unit precision", () => checkOrderListExample("set-rate"));
  it("01 uses server time, the canonical market and the correct standalone UUID layout", async () => {
    const sera = vi.fn(async (path) =>
      path === "/health"
        ? { executor_id: 3 }
        : path === "/system/time"
          ? clock
          : preview,
    );
    const result = await run(
      rate("preview").sample!.code,
      { owner, market, spendToken: cash, baseAmount: "100", quotePerBase: "1.09", sera, crypto: { randomUUID: () => orderId } },
      "return draft;",
    );
    expect(result).toMatchObject({
      side: "ask",
      from_address: from,
      to_address: to,
      expiration: now + 3600,
    });
    const asBid = await run(rate("preview").sample!.code, { owner, market, spendToken: { address: to },
      baseAmount: "12.5", quotePerBase: "1.11", sera, crypto: { randomUUID: () => secondId } }, "return draft;");
    expect(asBid).toMatchObject({ side: "bid", amount: "12.5", price: "1.11",
      from_address: market.base_address, to_address: market.quote_address });
    expect(BigInt(result.uuid_int) >> 252n).toBe(3n);
    expect((BigInt(result.uuid_int) >> 124n) & ((1n << 128n) - 1n)).toBe(
      orderBits(orderId),
    );
    expect((BigInt(result.uuid_int) >> 12n) & ((1n << 112n) - 1n)).toBe(
      orderBits(orderId) >> 16n,
    );
  });
  it("constructs the documented Mainnet order for a missing method and rejects fractional raw units", async () => {
    const contract = "0xb5c50c5d5f038404f85970b7f5b7259c4ac0e198";
    const mainnet = { chain_id: 1, sera_address: contract, vault_address: "0xc7d4fd2638e6630c8c61329878676b88a8a24d43",
      eip712_domain: { chainId: 1, verifyingContract: contract, name: "Sera", version: "1" } };
    const tokens = [{ address: from, decimals: 6 }, { address: to, decimals: 6 }];
    const grid = { ...market, base_decimals: 6, quote_decimals: 6, quantity_precision: 6, tick_precision: 6,
      min_ask_amount_raw: "1", min_bid_quote_amount_raw: "1" };
    const health = { executor_id: 0, relayer_executor_id: 0, status: "healthy", signature_ready: true };
    let status = 405;
    const sera = vi.fn(async (path: string) => {
      if (path === "/health") return health;
      if (path === "/tokens") return { tokens };
      if (path === "/system/time") return clock;
      throw Object.assign(new Error("Failed preview"), { status });
    });
    const source = rate("preview").extraSamples![0].code + "\n" + rate("preview").sample!.code;
    const args = { owner, market: grid, spendToken: tokens[1], baseAmount: "5", quotePerBase: "1.2", config: mainnet, sera,
      crypto: { randomUUID: () => orderId } };
    const result = await run(source, args, "return preview;");
    expect(result).toMatchObject({ side: "bid", from_amount: "6000000", to_amount: "5000000",
      eip712_order: { user: owner.toLowerCase(), fromToken: to, toToken: from, initialDepositAmount: "0" } });
    await expect(run(source, { ...args, baseAmount: "0.000001", quotePerBase: "0.1" })).rejects.toThrow();
    status = 503;
    await expect(run(source, args)).rejects.toThrow("Failed preview");
    expect(sera.mock.calls.filter(([path]) => path === "/tokens")).toHaveLength(2);
  });
  it("02 treats public preview failure as a stop before signing", async () => {
    const execution = vi.fn(async (path) =>
      path === "/health" ? { executor_id: 16 } : clock,
    );
    await expect(
      run(rate("preview").sample!.code, { owner, market, sera: execution }),
    ).rejects.toThrow("Executor unavailable");
    expect(execution.mock.calls.map(([path]) => path)).not.toContain(
      "/orders/preview",
    );
  });
  it("03 builds both funding permission payloads for the correct token and Vault", async () => {
    const sera = vi.fn(async () => ({ tx }));
    const context = {
      sera,
      bearer,
      config,
      owner,
      spendingToken: cash,
      depositAmountRaw: sendAmount,
      signedPermit: { signature: "permit", deadline: now + 20 },
    };
    for (const example of rate("fund").extraSamples!.slice(2))
      await run(example.code, context);
    expect(sera).toHaveBeenNthCalledWith(1, "/approve", {
      bearer,
      body: {
        token: from,
        owner: owner.toLowerCase(),
        spender: vault,
        amount: "25000000",
      },
    });
    expect(sera).toHaveBeenNthCalledWith(2, "/deposit", {
      bearer,
      body: {
        token: from,
        owner: owner.toLowerCase(),
        amount: "25000000",
        permit_signature: "permit",
        permit_deadline: now + 20,
        permit_amount: "25000000",
      },
    });
  });
  it("04 builds and sends a deposit with the wallet-owner API key", async () => {
    const data = encodeFunctionData({
      abi: parseAbi(["function depositFund(address token,address owner,uint256 amount)"]),
      functionName: "depositFund", args: [from, owner, sendAmount],
    });
    const depositTx = { ...tx, to: config.sera_address, data };
    const raw = await account.signTransaction({ ...typedTx, to: depositTx.to, data });
    const sera = vi.fn(async (path) => path === "/deposit" ? { tx: depositTx } : { tx_hash: keccak256(raw) });
    const { tx: _transfer, ...dependencies } = makeTransfer();
    const context = { ...dependencies, parseAbi, spendingToken: cash, depositAmountRaw: sendAmount, sera };
    context.wallet.request.mockResolvedValue(raw);
    const [sign, broadcast] = rate("fund").extraSamples!;
    const build = rate("fund").sample!.code;
    const built = await run(build, context, "return tx;");
    const signed = await run(sign.code, { ...context, tx: built }, "return raw_tx;");
    await run(broadcast.code, { ...context, tx: built, raw_tx: signed });
    expect(sera).toHaveBeenNthCalledWith(1, "/deposit", {
      bearer, body: { token: from, amount: sendAmount.toString(), owner: owner.toLowerCase() },
    });
    expect(sera).toHaveBeenNthCalledWith(2, "/tx/send", { bearer, body: { raw_tx: raw } });
    await expect(run(build, { ...context, depositAmountRaw: 0n })).rejects.toThrow("No deposit");
    await expect(run(build, { ...context, sera: async () => ({ tx }) })).rejects.toThrow("Deposit changed");
    await expect(run(broadcast.code, { ...context, tx: built, raw_tx: await account.signTransaction(typedTx) }))
      .rejects.toThrow("Signed transaction");
    expect(context.wallet.request).toHaveBeenCalledTimes(1);
  });
  it("05 stops when the user declines, changes chain, or receives different order fields", async () => {
    const context = publish();
    const code = rate("publish").sample!.code;
    await expect(
      run(code, { ...context, confirmOrderPreview: async () => false }),
    ).rejects.toThrow("not approved");
    context.wallet.getChainId.mockResolvedValueOnce(1);
    await expect(run(code, context)).rejects.toThrow("configured network");
    for (const changed of [
      { uuid: "1" },
      { user: recipient },
      { fromAmount: "99" },
      { toToken: recipient },
      { expiration: now - 1 },
      { initialDepositAmount: "1" },
    ]) {
      await expect(
        run(code, {
          ...context,
          preview: {
            ...preview,
            eip712_order: { ...preview.eip712_order, ...changed },
          },
        }),
      ).rejects.toThrow("no longer matches");
    }
    await expect(run(code, { ...context, preview: { ...preview, eip712_types: { Order: [] } } }))
      .rejects.toThrow("no longer matches");
    expect(context.wallet.signTypedData).not.toHaveBeenCalled();
    context.wallet.getAddresses.mockResolvedValueOnce([owner]).mockResolvedValueOnce([recipient]);
    await expect(run(code, context)).rejects.toThrow("signed-in wallet");
    expect(context.savePendingOrder).not.toHaveBeenCalled();
    expect(context.sera.mock.calls.some(([path]) => path === "/orders")).toBe(false);
  });
  it("06 signs exact preview values and persists the stable identity before submitting", async () => {
    const context = publish();
    await run(rate("publish").sample!.code, context);
    expect(context.wallet.signTypedData).toHaveBeenCalledWith(
      expect.objectContaining({ message: preview.eip712_order }),
    );
    expect(context.savePendingOrder).toHaveBeenCalledWith(orderId, uuid);
    expect(context.sera).toHaveBeenLastCalledWith("/orders", {
      body: {
        ...draft,
        amount: "100",
        price: "1.09",
        signature: "signature",
      },
    });
    expect(context.savePendingOrder.mock.invocationCallOrder[0]).toBeLessThan(
      context.sera.mock.invocationCallOrder[2],
    );
  });
  it("07 reads the owner’s fills and signs cancellation with the composite UUID", async () => {
    const mismatched = manage();
    await expect(run(rate("manage").sample!.code, { ...mismatched, savedUuidInt: "1234" }))
      .rejects.toThrow("Order or network changed");
    expect(mismatched.wallet.signTypedData).not.toHaveBeenCalled();
    const context = manage();
    await run(rate("manage").sample!.code, context);
    expect(context.sera).toHaveBeenNthCalledWith(
      2,
      "/fills/" + orderId + "?limit=100&offset=0",
      {
        bearer,
      },
    );
    expect(context.wallet.signTypedData).toHaveBeenCalledWith(
      expect.objectContaining({
        primaryType: "CancelOrder",
        message: { owner, orderId: BigInt(uuid) },
      }),
    );
    expect(context.sera).toHaveBeenLastCalledWith("/orders/cancel", {
      body: expect.objectContaining({ order_id: orderId, uuid_int: uuid }),
    });
  });
  it("08 refuses a mixed-spend, repeated-market, oversized or unapproved batch", async () => {
    const context = batch();
    const [one, two] = context.standaloneDrafts;
    const code = rate("manage").extraSamples![0].code;
    for (const legs of [
      [one],
      [one, { ...two, preview: { ...two.preview, from_token: to } }],
      [
        one,
        { ...two, draft: { ...two.draft, from_address: to, to_address: from } },
      ],
      Array(51).fill(one),
    ]) {
      await expect(
        run(code, { ...context, standaloneDrafts: legs }),
      ).rejects.toThrow("Invalid multi-rate");
    }
    await expect(
      run(code, { ...context, confirmBatchPreview: async () => false }),
    ).rejects.toThrow("not approved");
    expect(context.wallet.signTypedData).not.toHaveBeenCalled();
  });
  it("09 signs separate legs with a common group and retains both pending IDs", async () => {
    const context = batch();
    await run(rate("manage").extraSamples![0].code, context);
    expect(context.savePendingBatch).toHaveBeenCalledWith([orderId, secondId]);
    const [first, second] = context.wallet.signTypedData.mock.calls.map(
      ([data]) => BigInt(data.message.uuid),
    );
    expect(first & 4095n).toBe(0n);
    expect(second & 4095n).toBe(1n);
    expect((first >> 12n) & ((1n << 112n) - 1n)).toBe(
      (second >> 12n) & ((1n << 112n) - 1n),
    );
    expect(context.sera.mock.calls.map(([path]) => path)).toEqual(["/system/time", "/system/time", "/system/time", "/orders/vl/batch"]);
  });
  it("10 uses the batch cancellation type and retains pending and reverted fills after cancel", async () => {
    const context = manage();
    await run(rate("manage").extraSamples![1].code, {
      ...context,
      vl_batch_id: orderId,
    });
    expect(context.wallet.signTypedData).toHaveBeenCalledWith(
      expect.objectContaining({
        primaryType: "CancelVLBatch",
        message: { owner, vlBatchId: orderId },
      }),
    );
    expect(context.sera).toHaveBeenCalledWith("/orders/vl/cancel", {
      body: expect.objectContaining({ vl_batch_id: orderId }),
    });
    expect(rate("manage").rules.join(" ")).toMatch(
      /cancelled order can still have earlier fills settling/i,
    );
  });
});

const invoice = {
  id: 9,
  chainId: config.chain_id,
  receiver: recipient,
  token: to,
  amountRaw: sendAmount.toString(),
  expiresAt: (now + 3600) * 1000,
  singleUse: true,
};
const payment = (id: string) => sample("accept", id);
const checkout = async (outputs: string[]) => ({
  config,
  invoice,
  payToken: cash,
  payer: owner,
  assertSwapQuote: await makeQuoteGuard(),
  estimatedInputRaw: 20_000_000n,
  maxPayerInputRaw: 40_000_000n,
  sera: vi.fn(async (path, options) =>
    path === "/system/time"
      ? clock
      : {
          uuid: "invoice-quote",
          expires_at: now + 30,
          route_params: {
            ...route,
            maxInputAmount: options.body.from_amount,
            initialDepositAmount: options.body.from_amount,
            minOutputAmount: outputs.shift(),
            deadline: options.body.expiration,
          },
        },
  ),
});
const invoiceAttempt = {
  id: 12,
  kind: "swap",
  linkId: invoice.id,
  chainId: config.chain_id,
  tradeId: "trade",
  signedRoute: { ...route, minOutputAmount: invoice.amountRaw },
};
const ledger = () => ({
  flagForReview: vi.fn(),
  recordSettlementOnce: vi.fn(),
});
const paymentStatus = (
  snapshot: ReturnType<typeof settledTrade>,
  payments: ReturnType<typeof ledger>,
  attempt = invoiceAttempt,
) =>
  run(payment("reconcile").sample!.code, {
    invoice,
    attempt,
    config,
    bearer,
    sera: settlementApi(snapshot, attempt.tradeId),
    payments,
  });

describe("Accept guide audit", () => {
  it("11 scopes the merchant table and withholds actual amounts and receipts until verified", async () => {
    const values = [
      { payment_id: "direct", status: "submitted", verified: false },
      { payment_id: "incomplete", status: "confirmed", verified: false },
      { payment_id: "paid", qr_request_id: orderId, status: "confirmed", verified: true },
      { payment_id: "legacy", status: "confirmed", verified: true },
    ].map(row => ({ ...row, created_at: "2026-01-03T12:00:00Z", requested_amount_raw: "1000000",
      pay_token: from, receive_token: to, paid_amount_raw: "2001802", received_amount_raw: row.payment_id === "legacy" ? null : "1001001" }));
    const db = { query: vi.fn(async (sql, params) => {
      expect(sql).toMatch(/WHERE merchant_id = \$1 AND receiver = \$2 AND chain_id = \$3/);
      expect(params).toEqual(["merchant", owner.toLowerCase(), config.chain_id, 20]);
      return { rows: values };
    }) };
    const table = await run(historyGuides.accept.example, { db, offset: 20, chainId: config.chain_id,
      authenticateMerchant: async () => ({ id: "merchant", walletAddress: owner }), request: {} }, "return table;");
    expect(table).toMatchObject([
      { id: "direct", canShowReceipt: false, paidAmount: null, receivedAmount: null },
      { id: "incomplete", canShowReceipt: false, status: "confirming", receivedAmount: null },
      { id: "paid", qrRequestId: orderId, canShowReceipt: true, paidAmount: "2001802", receivedAmount: "1001001" },
      { id: "legacy", canShowReceipt: false, status: "confirmed", receivedAmount: null },
    ]);
  });
  const issue = async (settings: Record<string, unknown>) => {
    const signLink = vi.fn(async (_terms: Record<string, unknown>) => "signed-terms");
    const issueOnce = vi.fn(async (_merchantId, terms, _expiry, createUrl) => createUrl(terms));
    const paymentUrl = await run(
      payment("invoice").sample!.code,
      {
        request: {},
        authenticateMerchant: async () => ({ id: 8, walletAddress: recipient }),
        config,
        payerPreset: null,
        reference: " INV-1042 ",
        singleUse: false,
        expiryChoice: "none",
        receiveToken: { address: to, decimals: 6 },
        receiveAmount: "25.00",
        parseUnits,
        Date: { now: () => now * 1000 },
        requestId: orderId,
        appOrigin: "https://shop.example",
        links: { issueOnce },
        signLink,
        ...settings,
      },
      "return paymentUrl;",
    );
    return { paymentUrl, signLink, issueOnce };
  };

  it("01 signs the authenticated receiver, exact amount, reference and both link settings", async () => {
    const result = await issue({ request: { receiver: owner } });
    expect(result.paymentUrl).toBe(
      "https://shop.example/checkout/signed-terms",
    );
    expect(result.signLink).toHaveBeenCalledWith({
      id: orderId,
      receiver: recipient,
      chainId: config.chain_id,
      token: to,
      tokenDecimals: 6,
      amountRaw: "25000000",
      reference: "INV-1042",
      singleUse: false,
    });
    expect(result.issueOnce).toHaveBeenCalledWith(8, expect.objectContaining({ singleUse: false }), "none", expect.any(Function));
    const helpers = await run(payment("invoice").extraSamples![0].code, { SignJWT, jwtVerify,
      appOrigin: "https://shop.example", signingKey: randomBytes(32) }, "return { signLink, verifyLink };");
    const invoice = result.signLink.mock.calls[0][0];
    const signed = await helpers.signLink(invoice);
    await expect(helpers.verifyLink(signed, config.chain_id)).resolves.toEqual(invoice);
    await expect(helpers.verifyLink(signed, 1)).rejects.toThrow("Invalid payment link");
    const [header, body, sig] = signed.split(".");
    const altered = header + "." + body + "." + (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    await expect(helpers.verifyLink(altered, config.chain_id)).rejects.toThrow();
    const expired = await helpers.signLink({ ...invoice, expiresAt: Date.now() - 1000 });
    await expect(helpers.verifyLink(expired, config.chain_id)).rejects.toThrow();
    await expect(issue({ requestId: "invalid" })).rejects.toThrow("Invalid reference or creation request");

    for (const receiveAmount of ["0", "-1", "2e3", "1.0000001", "1".repeat(79)]) {
      await expect(issue({ receiveAmount })).rejects.toThrow("Invalid token amount");
    }
    const noReference = await issue({ reference: undefined });
    expect(noReference.signLink.mock.calls[0][0]).not.toHaveProperty("reference");
    for (const amount of ["0", "1.0000001", undefined]) {
      await expect(issue({ payerPreset: { symbol: "USDT", address: from, decimals: 6, amount } }))
        .rejects.toThrow("Invalid token amount");
    }
    await expect(issue({ payerPreset: { symbol: "USDC", address: to, decimals: 6, amount: "24.99" } }))
      .rejects.toThrow("Same-token amounts must match");
    const precise = await issue({ receiveAmount: "13.234501" });
    expect(precise.signLink).toHaveBeenCalledWith(expect.objectContaining({ amountRaw: "13234501" }));
    await expect(issue({ receiveAmount: "1.001", receiveToken: { address: to, decimals: 2 } }))
      .rejects.toThrow("Invalid token amount");

    const preciseToken = await issue({ receiveAmount: "1.000000000000000001", receiveToken: { address: to, decimals: 18 } });
    expect(preciseToken.signLink).toHaveBeenCalledWith(expect.objectContaining({ amountRaw: "1000000000000000001" }));
    const stored = await issue({
      singleUse: true,
      expiryChoice: "1h",
      payerPreset: { symbol: "USDC", amount: "20.10", address: from, decimals: 6 },
    });
    const terms = expect.objectContaining({
      singleUse: true,
      expiresAt: (now + 3600) * 1000,
      payCoin: "USDC",
      payAmount: "20.10",
      payToken: { address: from, decimals: 6 },
    });
    expect(stored.issueOnce).toHaveBeenCalledWith(8, terms, "1h", expect.any(Function));
    expect(stored.signLink).toHaveBeenCalledWith(terms);
    for (const [expiryChoice, seconds] of [
      ["15m", 900],
      ["24h", 86400],
      ["7d", 604800],
    ] as const) {
      const expiring = await issue({ expiryChoice });
      expect(expiring.signLink).toHaveBeenCalledWith(
        expect.objectContaining({ expiresAt: (now + seconds) * 1000 }),
      );
      expect(expiring.issueOnce).toHaveBeenCalledWith(8, expect.objectContaining({ singleUse: false }), expiryChoice, expect.any(Function));
    }
    await expect(issue({ expiryChoice: "tomorrow" })).rejects.toThrow(
      "Invalid link settings",
    );
    await expect(
      issue({
        authenticateMerchant: async () => {
          throw new Error("Login required");
        },
      }),
    ).rejects.toThrow("Login required");
  });
  it("omits untargeted amounts from the signed link and quotes the payer’s exact input once", async () => {
    const { signLink, issueOnce } = await issue({
      receiveAmount: "", singleUse: true,
      payerPreset: { symbol: "USDC", address: to, decimals: 6 },
    });
    const terms = signLink.mock.calls[0][0];
    expect(terms).toMatchObject({ receiver: recipient, token: to, singleUse: true, payCoin: "USDC" });
    expect(terms).not.toHaveProperty("amountRaw");
    expect(terms).not.toHaveProperty("payAmount");
    expect(issueOnce).toHaveBeenCalledWith(8, terms, "none", expect.any(Function));
    const preset = { symbol: "USDT", address: from, decimals: 6 };
    const openPair = await issue({ receiveAmount: "", payerPreset: preset });
    const openPairTerms = openPair.signLink.mock.calls[0][0];
    expect(openPairTerms).toMatchObject({ token: to, payCoin: "USDT", payToken: { address: from, decimals: 6 } });
    expect(openPairTerms).not.toHaveProperty("amountRaw");
    expect(openPairTerms).not.toHaveProperty("payAmount");
    await expect(issue({ receiveAmount: "", payerPreset: { ...preset, amount: "0" } }))
      .rejects.toThrow("Leave both amounts empty");
    const context = await checkout(["14000000"]);
    await run(payment("checkout").sample!.code, {
      ...context, invoice: { ...invoice, amountRaw: undefined }, maxPayerInputRaw: 15_000_000n,
    });
    const quotes = context.sera.mock.calls.filter(([path]) => path === "/swap/quote");
    expect(quotes).toHaveLength(1);
    expect(quotes[0][1].body).toMatchObject({ gas_mode: "receive_less", from_amount: "15000000", recipient });
  });
  it("02 binds the public pay_more quote to payer, invoice receiver, token and deadline", async () => {
    const context = await checkout(["25000000"]);
    await run(payment("checkout").sample!.code, context);
    expect(context.sera).toHaveBeenCalledWith("/swap/quote", {
      body: {
        owner_address: owner.toLowerCase(),
        recipient,
        from_token: from,
        to_token: to,
        from_amount: "20000000",
        gas_mode: "pay_more",
        expiration: now + 300,
      },
    });
  });
  it("03 rejects the wrong network, same-token conversion and expired or near-expiry link", async () => {
    const context = await checkout(["25000000"]);
    const code = payment("checkout").sample!.code;
    await expect(
      run(code, { ...context, invoice: { ...invoice, chainId: 1 } }),
    ).rejects.toThrow("invoice network");
    await expect(
      run(code, { ...context, payToken: { address: to } }),
    ).rejects.toThrow("different payment token");
    await expect(
      run(code, { ...context, invoice: { ...invoice, expiresAt: now * 1000 } }),
    ).rejects.toThrow("Invoice expired");
    const unlimited = await checkout(["25000000"]);
    await run(code, {
      ...unlimited,
      invoice: { ...invoice, expiresAt: undefined },
    });
    expect(unlimited.sera).toHaveBeenCalledWith("/swap/quote", {
      body: expect.objectContaining({ expiration: now + 300 }),
    });
    const nearExpiry = await checkout(["25000000"]);
    await run(code, {
      ...nearExpiry,
      invoice: { ...invoice, expiresAt: (now + 60) * 1000 },
    });
    expect(nearExpiry.sera).toHaveBeenCalledWith("/swap/quote", {
      body: expect.objectContaining({ expiration: now + 60 }),
    });
  });
  it("04 requotes only once using deterministic raw integer arithmetic", async () => {
    const context = await checkout(["23000000", "25001000"]);
    await run(payment("checkout").sample!.code, context);
    const quotes = context.sera.mock.calls.filter(
      ([path]) => path === "/swap/quote",
    );
    expect(quotes).toHaveLength(2);
    expect(quotes[1][1].body.from_amount).toBe("21760870");
  });
  it("05 stops when output is insufficient or the adjusted input exceeds its cap", async () => {
    const code = payment("checkout").sample!.code;
    await expect(
      run(code, await checkout(["23000000", "24999999"])),
    ).rejects.toThrow("does not cover");
    await expect(
      run(code, {
        ...(await checkout(["23000000"])),
        maxPayerInputRaw: 21_000_000n,
      }),
    ).rejects.toThrow("maximum payer input");
    await expect(run(code, await checkout(["0"]))).rejects.toThrow();
  });
  it("06 rejects a quote for a different recipient or token", async () => {
    const context = await checkout(["25000000"]);
    await expect(
      run(payment("checkout").sample!.code, {
        ...context,
        sera: async (path) =>
          path === "/system/time"
            ? clock
            : { ...quote, route_params: { ...route, recipient: owner } },
      }),
    ).rejects.toThrow("reviewed swap");
  });
  it("07 never fulfills a direct payment or an unsettled CLOB order", async () => {
    const payments = ledger();
    await paymentStatus(settledTrade(), payments, {
      ...invoiceAttempt,
      kind: "direct",
    });
    for (const status of ["pending", "matched", "failed", "cancelled"]) {
      const data = settledTrade();
      data.order.status = status;
      await paymentStatus(data, payments);
    }
    expect(payments.recordSettlementOnce).not.toHaveBeenCalled();
  });
  it("08 binds the invoice, signed recipient, token, chain and amount to the original attempt", async () => {
    const payments = ledger();
    for (const changed of [
      { linkId: 99 },
      { chainId: 1 },
      { signedRoute: { ...route, recipient: owner } },
      { signedRoute: { ...route, outputToken: from } },
      { signedRoute: { ...route, minOutputAmount: "1" } },
    ])
      await paymentStatus(settledTrade(), payments, {
        ...invoiceAttempt,
        ...changed,
      });
    expect(payments.flagForReview).toHaveBeenCalledTimes(5);
    expect(payments.recordSettlementOnce).not.toHaveBeenCalled();
  });
  it("09 rejects underpayment, unlinked fills and conflicting order and fill totals", async () => {
    const payments = ledger();
    await paymentStatus(settledTrade("trade", "24999999"), payments);
    const foreign = settledTrade();
    foreign.fills[0].taker_order_id = "different";
    await paymentStatus(foreign, payments);
    const inconsistent = settledTrade();
    inconsistent.fills[0].settlement_economics = {
      ...inconsistent.order.settlement_economics,
      balance_credits: [{ token_address: to, amount_raw: "25000001" }],
    };
    await paymentStatus(inconsistent, payments);
    const partial = settledTrade();
    partial.order.settlement_summary.total_fill_count = 2;
    partial.order.settlement_summary.settled_fill_count = 2;
    partial.fills.push({
      ...partial.fills[0],
      settlement_economics: {
        ...partial.order.settlement_economics,
        balance_credits: [{ token_address: recipient, amount_raw: "1" }],
      },
    });
    await expect(paymentStatus(partial, payments)).rejects.toThrow("Expected settlement asset");
    expect(payments.recordSettlementOnce).not.toHaveBeenCalled();
  });
  it("10 deduplicates by chain and trade even when several payments share a transaction hash", async () => {
    const payments = ledger();
    const keys = new Set<string>();
    payments.recordSettlementOnce.mockImplementation(({ chainId, tradeId }) =>
      keys.add(chainId + ":" + tradeId),
    );
    for (const id of ["trade", "trade", "other"]) {
      await paymentStatus(settledTrade(id), payments, {
        ...invoiceAttempt,
        tradeId: id,
      });
    }
    expect([...keys]).toEqual([
      config.chain_id + ":trade",
      config.chain_id + ":other",
    ]);
    expect(guides.accept.checklist.flatMap((group) => group.items)).toEqual(
      expect.arrayContaining([expect.objectContaining({
        q: expect.stringContaining("Leave both amounts blank"),
        expect: expect.stringContaining("enter a positive spend or change tokens"),
      })]),
    );
    expect(guides.accept.production).toMatch(
      /fresh mainnet config and credentials/,
    );
  });
});
