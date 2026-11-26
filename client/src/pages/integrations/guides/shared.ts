import { typedDataSigningGuidance } from "./access";

export const CHECK_WALLET = `async function checkWallet(wallet, owner, chainId) {
  const [chain, addresses] = await Promise.all([wallet.getChainId(), wallet.getAddresses()]);
  if (chain !== chainId || addresses[0]?.toLowerCase() !== owner.toLowerCase())
    throw new Error("Select the signed-in wallet on the configured network");
}`;

// Only the backend receives the CLOB bearer.
export const SIGN_RAW_CALL = `${CHECK_WALLET}
await checkWallet(wallet, owner, config.chain_id);
const requestTx = { from: owner, to: tx.to, data: tx.data };
for (const key of ["type", "chainId", "value", "nonce", "gas", "maxFeePerGas", "maxPriorityFeePerGas"])
  requestTx[key] = "0x" + BigInt(tx[key]).toString(16);
const result = await wallet.request({ method: "eth_signTransaction", params: [requestTx] });
await checkWallet(wallet, owner, config.chain_id);
const raw_tx = typeof result === "string" ? result : result?.raw;
if (typeof raw_tx !== "string" || !/^0x02(?:[0-9a-f]{2}){1,2047}$/i.test(raw_tx))
  throw new Error("Wallet did not return a signed EIP-1559 transaction");`;

export const VERIFY_RAW_CALL = `// viem: getAddress, keccak256, parseTransaction, recoverTransactionAddress
// tx is the original transaction saved by your server for this owner and attempt.
const signed = parseTransaction(raw_tx);
const signer = await recoverTransactionAddress({ serializedTransaction: raw_tx });
if (signed.type !== "eip1559" || signed.accessList?.length ||
    getAddress(signer) !== getAddress(owner) || BigInt(signed.chainId) !== BigInt(config.chain_id) ||
    getAddress(signed.to) !== getAddress(tx.to) || (signed.value ?? 0n) !== 0n ||
    signed.data?.toLowerCase() !== tx.data.toLowerCase() || BigInt(signed.nonce) !== BigInt(tx.nonce) ||
    signed.gas !== BigInt(tx.gas) || signed.maxFeePerGas !== BigInt(tx.maxFeePerGas) ||
    signed.maxPriorityFeePerGas !== BigInt(tx.maxPriorityFeePerGas))
  throw new Error("Signed transaction does not match the reviewed request");
const expectedHash = keccak256(raw_tx);`;

const DEPLOYMENT = `function deployment(network) {
  if (network === "sepolia") return { chainId: 11155111, base: "https://api.testnet.sera.cx/api/v1" };
  if (network === "live") return { chainId: 1, base: "https://api.sera.cx/api/v1" };
  throw new Error("Choose Sepolia or Live");
}`;

const CHECK_DEPLOYMENT = `const domain = config.eip712_domain;
const contracts = [config.sera_address, config.vault_address, config.sor_address];
if (config.chain_id !== expectedChainId || domain?.chainId !== config.chain_id ||
    domain.name !== "Sera" || domain.version !== "1" ||
    contracts.some(a => typeof a !== "string" || !/^0x[0-9a-f]{40}$/i.test(a) || /^0x0{40}$/i.test(a)) ||
    new Set(contracts.map(a => a.toLowerCase())).size !== 3 ||
    domain.verifyingContract?.toLowerCase() !== config.sera_address.toLowerCase()) {
  throw new Error("Unexpected Sera signing deployment");
}`;

export const API_SETUP = `// server/sera.js (Node.js)
${DEPLOYMENT}
export function seraFor(network) {
  const { base } = deployment(network);
  return (path, options) => requestSera(base, path, options);
}
async function requestSera(base, path, { body, bearer } = {}) {
  const headers = new Headers({ Accept: "application/json" });
  if (body !== undefined) headers.set("Content-Type", "application/json");
  if (bearer) headers.set("Authorization", "Bearer " + bearer);
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    redirect: "error",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    let code = payload?.detail?.error_code ?? payload?.detail?.code ?? payload?.error_code;
    if (path === "/api-keys" && response.status === 409) {
      const detail = payload?.detail;
      if (typeof detail === "string" && /^Maximum 10 API keys per wallet[.]/i.test(detail)) code = "key_limit";
      else if (detail === "Signature already used") code = "signature_used";
    }
    throw Object.assign(new Error("Sera request failed"), {
      status: response.status, code,
      retryAfter: response.headers.get("Retry-After"),
    });
  }
  if (!payload) throw new Error("Invalid response from Sera");
  return payload;
}

export async function loadSeraNetwork(network) {
  const { chainId: expectedChainId } = deployment(network);
  const sera = seraFor(network);
  const [config, { tokens }, { timestamp: seraNow }] = await Promise.all([
    sera("/config"), sera("/tokens"), sera("/system/time"),
  ]);
  ${CHECK_DEPLOYMENT}
  if (!Array.isArray(tokens) || tokens.length === 0 || !Number.isSafeInteger(seraNow) || seraNow <= 0) {
    throw new Error("Unexpected Sera signing deployment");
  }
  return { sera, config, tokens, seraNow };
}
// In your app: const { sera, config, tokens, seraNow } = await loadSeraNetwork("sepolia");`;

export const WALLET_SIGNING = `// ${typedDataSigningGuidance}
// Call this from your sign button. owner and getAccessToken come from your app's login.
// /wallet/* routes below belong to your app and use its own origin.
// selectedNetwork comes from your network switcher. Default to "sepolia".
const network = selectedNetwork;
if (network !== "sepolia" && network !== "live") throw new Error("Choose Sepolia or Live");
const expectedChainId = network === "sepolia" ? 11155111 : 1;
const walletPath = "/wallet/" + network;
const token = await getAccessToken();
if (!token) throw new Error("Sign in first");
const auth = { Authorization: "Bearer " + token };
const read = () => fetch(walletPath + "/balances?owner_address=" + owner.toLowerCase(), {
  credentials: "same-origin", headers: auth, cache: "no-store",
});

async function enableIfNeeded() {
  const current = await read();
  if (current.ok) return current.json();
  const problem = await current.json().catch(() => null);
  if (current.status !== 409 || problem?.code !== "CLOB_CREDENTIAL_REQUIRED")
    throw new Error("Check your login and try the balance request again");

  const settings = await fetch(walletPath + "/signing-context", {
    credentials: "omit", cache: "no-store", redirect: "error",
  });
  if (!settings.ok) throw new Error("Sera signing settings unavailable");
  const { config, timestamp } = await settings.json();
  ${CHECK_DEPLOYMENT}
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new Error("Invalid Sera time");
  ${CHECK_WALLET}
  if (await wallet.getChainId() !== expectedChainId) await wallet.switchChain({ id: expectedChainId });
  await checkWallet(wallet, owner, config.chain_id);
  const action = "create";
  const signature = await wallet.signTypedData({
    account: owner, domain, primaryType: "ManageApiKey",
    types: { ManageApiKey: [
      { name: "owner", type: "address" }, { name: "action", type: "string" },
      { name: "timestamp", type: "uint256" },
    ] },
    message: { owner, action, timestamp: BigInt(timestamp) },
  });
  await checkWallet(wallet, owner, config.chain_id);
  const opened = await fetch(walletPath + "/session", {
    method: "POST", credentials: "same-origin",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ owner, action, timestamp, signature }),
  });
  if (!opened.ok) {
    const problem = await opened.json().catch(() => null);
    if (problem?.code === "key_limit")
      throw new Error("Use a browser already enabled for this wallet and network, or review your active Sera keys.");
    if (problem?.code === "signature_used")
      throw new Error("This signature was already used. Choose Enable again to sign a fresh message.");
    throw new Error("Wallet access was not enabled");
  }
  const balances = await read();
  if (!balances.ok) throw new Error("Unable to read this wallet's balances");
  return balances.json();
}
const snapshot = await enableIfNeeded();`;

export const WALLET_CONTEXT = `// Your public GET /wallet/:network/signing-context handler. Import seraFor from your Sera setup.
const sera = seraFor(request.params.network);
const [config, { timestamp }] = await Promise.all([sera("/config"), sera("/system/time")]);
response.set("Cache-Control", "no-store").json({ config, timestamp });`;

export const WALLET_BACKEND_SETUP = `// Shared setup for the two Express handlers below (npm install jose cookie).
import { EncryptJWT, jwtDecrypt } from "jose";
import { parse as parseCookies } from "cookie";

// Provision a random 32-byte key in your server's secret manager, base64 encoded.
// This is your app's cookie-encryption key. Each wallet obtains its own CLOB key.
const cookieKey = Buffer.from(process.env.COOKIE_ENCRYPTION_KEY ?? "", "base64");
if (cookieKey.length !== 32) throw new Error("Configure a 32-byte cookie encryption key");
const cookieName = (network, owner) => "sera_wallet_" + network + "_" + owner;
const audience = network => "sera-clob:" + network;
const cookieOptions = { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/" };

// Populate request.auth.walletAddresses using your verified login middleware.
// Include only addresses proven to belong to this session (embedded or external).
function authenticatedOwner(request, requested) {
  const owner = typeof requested === "string" ? requested.toLowerCase() : "";
  if (!/^0x[0-9a-f]{40}$/.test(owner) ||
      !request.auth?.walletAddresses?.some(a => a.toLowerCase() === owner)) {
    throw Object.assign(new Error("Sign in with this wallet"), { status: 403 });
  }
  return owner;
}

async function walletBearer(request, network, owner) {
  const sealed = parseCookies(request.headers.cookie ?? "")[cookieName(network, owner)];
  if (!sealed) return null;
  try {
    const { payload } = await jwtDecrypt(sealed, cookieKey, {
      audience: audience(network), subject: owner, requiredClaims: ["exp"], keyManagementAlgorithms: ["dir"],
      contentEncryptionAlgorithms: ["A256GCM"],
    });
    return typeof payload.bearer === "string" ? payload.bearer : null;
  } catch { return null; }
}
// On logout, clear each matching sera_wallet_<network>_<owner> cookie with cookieOptions.`;

export const WALLET_SESSION = `// Your POST /wallet/:network/session handler. Import seraFor from your Sera setup.
const network = request.params.network;
const sera = seraFor(network);
const { owner, action, timestamp, signature } = request.body;
const sessionOwner = authenticatedOwner(request, owner);
if (action !== "create" || !Number.isSafeInteger(timestamp) || timestamp <= 0 ||
    typeof signature !== "string" || !/^0x(?:[0-9a-f]{2})+$/i.test(signature)) {
  throw new Error("Invalid key request");
}
let issued;
try {
  issued = await sera("/api-keys", {
    body: { owner_address: sessionOwner, action, timestamp, signature,
      duration_seconds: 86400, label: "Wallet session" },
  });
} catch (error) {
  if (error.status !== 409) throw error;
  const code = ["key_limit", "signature_used"].includes(error.code) ? error.code : "key_unavailable";
  return response.set("Cache-Control", "private, no-store").status(409).json({ code });
}
if (!issued.api_key || !issued.api_secret) throw new Error("Sera did not return credentials");
const now = Math.floor(Date.now() / 1000);
const expiry = issued.expires_at;
const expirySeconds = expiry == null ? Infinity :
  Number.isFinite(Number(expiry)) ? (Number(expiry) > 1e10 ? Number(expiry) / 1000 : Number(expiry)) :
  Date.parse(expiry) / 1000;
const exp = Math.floor(Math.min(now + 86400, now + Number(issued.duration_seconds ?? 86400), expirySeconds));
if (!Number.isSafeInteger(exp) || exp <= now) throw new Error("Invalid credential expiry");
const sealed = await new EncryptJWT({ bearer: issued.api_key + ":" + issued.api_secret })
  .setProtectedHeader({ alg: "dir", enc: "A256GCM" }).setAudience(audience(network))
  .setSubject(sessionOwner).setExpirationTime(exp).encrypt(cookieKey);
response.cookie(cookieName(network, sessionOwner), sealed, { ...cookieOptions, maxAge: (exp - now) * 1000 });
response.set("Cache-Control", "private, no-store").status(201).json({ walletAccess: true });`;

export const WALLET_BALANCES = `// Your GET /wallet/:network/balances handler. Import seraFor from your Sera setup.
const network = request.params.network;
const sera = seraFor(network);
const owner = authenticatedOwner(request, request.query.owner_address);
const bearer = await walletBearer(request, network, owner);
response.set("Cache-Control", "private, no-store");
if (!bearer) {
  response.status(409).json({ code: "CLOB_CREDENTIAL_REQUIRED" });
} else {
  try {
    const snapshot = await sera("/balances?owner_address=" + owner + "&include_zero=true", { bearer });
    if (snapshot.owner_address?.toLowerCase() !== owner) throw new Error("Balance owner changed");
    response.json(snapshot);
  } catch (error) {
    if (error.status !== 401 && error.status !== 403) throw error;
    // A temporary failure reading balances can leave the key valid.
    const [api_key, api_secret] = bearer.split(":");
    const check = await sera("/api-keys/verify", { body: { api_key, api_secret } })
      .catch(e => e.status === 401 ? { valid: false } : null);
    const otherOwner = check?.valid === true && /^0x[0-9a-f]{40}$/i.test(check.owner_address)
      && check.owner_address.toLowerCase() !== owner;
    if (check?.valid === false || otherOwner) {
      response.status(409).json({ code: "CLOB_CREDENTIAL_REQUIRED" });
    } else {
      response.status(503).json({ code: "BALANCES_UNAVAILABLE" });
    }
  }
}`;

// Shared by the copyable Swap and Accept examples. Terms come from the signed
// intent saved with the trade ID, never from client-provided settlement data.
export const READ_SWAP_SETTLEMENT = `async function readSwapSettlement(tradeId, route) {
  const id = encodeURIComponent(tradeId);
  const order = await sera("/orders/" + id, { bearer });
  const same = (a, b) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
  if (order.trade_id !== tradeId || order.order_type !== "swap" ||
      (typeof order.uuid_int !== "string" || order.uuid_int !== String(route.uuid)) ||
      !same(order.owner_address, route.taker) || !same(order.from_token, route.inputToken) ||
      !same(order.to_token, route.outputToken)) throw new Error("Order does not match signed intent");
  const summary = order.settlement_summary;
  if (order.status !== "settled" || summary?.status !== "settled") return null;
  const count = summary.total_fill_count;
  if (!Number.isSafeInteger(count) || count < 1 || count !== summary.settled_fill_count || summary.pending_fill_count !== 0) return null;

  const hash = summary.latest_tx_hash;
  const validHash = value => /^0x[0-9a-f]{64}$/i.test(value) && !/^0x0{64}$/i.test(value);
  if (!validHash(hash)) return null;
  let includesLatest = false;
  const valueFor = (rows, token, allowOtherCredits = false) => {
    if (!Array.isArray(rows) || !rows.length) throw new Error("Missing settlement amounts");
    const totals = new Map();
    for (const row of rows) {
      if (!/^0x[0-9a-f]{40}$/i.test(row.token_address) ||
          (!allowOtherCredits && !same(row.token_address, token)) ||
          typeof row.amount_raw !== "string" || !/^[0-9]{1,78}$/.test(row.amount_raw))
        throw new Error("Unexpected settlement amounts");
      const address = row.token_address.toLowerCase();
      const amount = BigInt(row.amount_raw);
      const total = (totals.get(address) ?? 0n) + amount;
      if (amount === 0n || total >= 2n ** 256n) throw new Error("Invalid settlement amount");
      totals.set(address, total);
    }
    const value = totals.get(token.toLowerCase());
    if (!value) throw new Error("Expected settlement asset is missing");
    return value;
  };
  let paid = 0n, received = 0n;
  for (let offset = 0; offset < count;) {
    const limit = Math.min(100, count - offset);
    const { items } = await sera("/fills/" + id + "?limit=" + limit + "&offset=" + offset, { bearer });
    if (!Array.isArray(items) || items.length !== limit) return null;
    for (const fill of items) {
      const e = fill.settlement_economics;
      if (![fill.maker_order_id, fill.taker_order_id].includes(tradeId) ||
          e?.perspective_order_id !== tradeId || fill.settlement_status !== "settled" ||
          !validHash(fill.tx_hash)) return null;
      includesLatest ||= same(fill.tx_hash, hash);
      paid += valueFor(e.balance_debits, route.inputToken);
      received += valueFor(e.balance_credits, route.outputToken, true);
    }
    offset += items.length;
  }
  const total = order.settlement_economics;
  if (!includesLatest || total?.perspective_order_id !== tradeId ||
      valueFor(total.balance_debits, route.inputToken) !== paid ||
      valueFor(total.balance_credits, route.outputToken, true) !== received ||
      paid <= 0n || paid > BigInt(route.maxInputAmount) ||
      received <= 0n || received < BigInt(route.minOutputAmount)) return null;
  return { tradeId, paid, received, hash };
}`;
