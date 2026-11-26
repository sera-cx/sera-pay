import { CHECK_WALLET, READ_SWAP_SETTLEMENT } from "../../integrations/guides/shared";

export { API_SETUP as SETUP } from "../../integrations/guides/shared";

export const QUOTE_REQUEST = `// viem: getAddress, parseUnits, zeroAddress
// fromToken and toToken are the selected entries from GET /tokens.
const from_token = getAddress(fromToken.address).toLowerCase();
const to_token = getAddress(toToken.address).toLowerCase();
const owner_address = getAddress(owner).toLowerCase();
const recipient = getAddress(reviewedRecipient ?? owner).toLowerCase();
if (from_token === to_token || recipient === zeroAddress) {
  throw new Error("Choose distinct tokens and a valid recipient");
}
if (!/^\\d+(\\.\\d+)?$/.test(amount) ||
    (amount.split(".")[1]?.length ?? 0) > fromToken.decimals) {
  throw new Error("Invalid input amount");
}
const raw = parseUnits(amount, fromToken.decimals);
const minimum = BigInt(fromToken.min_trade_amount_raw);
if (raw <= 0n || raw < minimum || raw >= 2n ** 256n) {
  throw new Error("Amount outside the supported range");
}
const { timestamp } = await sera("/system/time");
const request = {
  from_token, to_token, owner_address, recipient,
  from_amount: raw.toString(), expiration: timestamp + 300, gas_mode: gasMode,
};
const quote = await sera("/swap/quote", { body: request });
const { timestamp: quotedAt } = await sera("/system/time");
`;

export const VERIFY_QUOTE = `// Use the original request that produced this quote.
function assertSwapQuote(quote, request, now, quotedAt) {
  const route = quote?.route_params;
  if (!quote?.uuid || !route ||
      !Number.isSafeInteger(quote.expires_at) ||
      !Number.isSafeInteger(quotedAt) ||
      !Number.isSafeInteger(now) ||
      now >= quotedAt + 25 || quote.expires_at <= now + 5) {
    throw new Error("Refresh the quote");
  }

  const addresses = [
    [route.taker, request.owner_address],
    [route.recipient, request.recipient],
    [route.inputToken, request.from_token],
    [route.outputToken, request.to_token],
  ];
  if (addresses.some(([actual, expected]) => getAddress(actual) !== getAddress(expected))) {
    throw new Error("Quote does not match the reviewed swap");
  }

  const uint = (value, bits = 256) => {
    if ((typeof value !== "string" && !Number.isSafeInteger(value)) ||
        !/^\\d+$/.test(String(value))) throw new Error("Invalid quote amount");
    const result = BigInt(value);
    if (result >= 2n ** BigInt(bits)) throw new Error("Invalid quote amount");
    return result;
  };
  const input = uint(route.maxInputAmount);
  const requested = uint(request.from_amount);
  const deadline = uint(route.deadline, 48);
  if (input === 0n || uint(route.minOutputAmount) === 0n ||
      uint(route.uuid) === 0n || uint(route.initialDepositAmount) > input ||
      deadline <= BigInt(now + 5) || deadline > BigInt(request.expiration) ||
      (request.gas_mode === "receive_less" ? input !== requested : input < requested)) {
    throw new Error("Quote cannot be signed as shown");
  }
  return route;
}`;

export const QUOTE_RESPONSE = `{
  "uuid": "6d0ad60d-...",                  // quote id, send back in POST /swap
  "route_params": { ...Intent fields... }, // sign EXACTLY these, do not change
  "fee_breakdown": { "gas_cost_usd": "0.12", "gas_cost_from_token": "0.120000" },
  "expires_at": 1713250830,                // ~30 s after issue
  "permit": { ... } | null                 // see step 2
}`;

export const PERMIT_DECISION_TREE = `initialDepositAmount == 0  AND  permit == null
  └─> SKIP. Vault equity covers this swap.

initialDepositAmount > 0  AND  permit == null
  └─> STOP. Refresh the incomplete wallet-deposit quote.

permit.permit_required == true
  ├─ permit_supported == true  AND  permit.eip712 is complete
  │     (domain.name, domain.verifyingContract, spender, value_raw, nonce, deadline)
  │     └─> PERMIT_SIGN. wallet.signTypedData(permit.eip712.{domain,types,message})
  │         Gasless. No on-chain tx. Keep the signature AND the signed deadline.
  │
  ├─ permit_supported == true  BUT  metadata incomplete
  │     └─> ABORT: "Swap quote is missing permit data. Refresh the quote and try again."
  │
  └─ permit_supported == false   (use the quote flag for this token and chain)
        ├─ permit.spender missing  -> ABORT
        ├─ permit.current_allowance_raw >= permit.value_raw  -> SKIP
        └─ else -> build /approve, sign the reviewed bytes, send via /tx/send.
                   This is the ONE case where the user needs ETH for gas.`;

const CHECK_PERMISSION = `function needsPermit(quote, route, config) {
  const permit = quote.permit;
  const deposit = BigInt(route.initialDepositAmount);
  if (!permit && deposit === 0n) return false;
  const raw = value => typeof value === "string" && /^[0-9]{1,78}$/.test(value) && BigInt(value) < 2n ** 256n;
  if (!permit || typeof permit.permit_supported !== "boolean" || typeof permit.permit_required !== "boolean" ||
      getAddress(permit.token) !== getAddress(route.inputToken) ||
      getAddress(permit.spender) !== getAddress(config.sor_address) ||
      ((permit.permit_supported || permit.owner != null) && getAddress(permit.owner) !== getAddress(route.taker)) ||
      !raw(permit.value_raw) || !raw(permit.current_allowance_raw)) throw new Error("Refresh the permission");
  if (permit.permit_required && permit.permit_supported) {
    if (deposit <= 0n || BigInt(permit.value_raw) !== deposit) throw new Error("Refresh the permission");
    return true;
  }
  if (BigInt(permit.current_allowance_raw) < deposit)
    throw new Error("A sufficient token allowance and a fresh quote are required");
  return false;
}`;

export const SIGN_PERMIT = `// Run after the payer reviews the quote. This branch is gasless.
const permit = quote.permit;
const { timestamp: now } = await sera("/system/time");
const route = assertSwapQuote(quote, request, now, quotedAt);
let signedPermit;
${CHECK_PERMISSION}
if (needsPermit(quote, route, config)) {
  const typed = permit.eip712;
  const message = typed?.message;
  const domain = typed?.domain;
  if (!message || !domain?.name || typed.primaryType !== "Permit" ||
      (await walletClient.getChainId()) !== config.chain_id ||
      Number(domain.chainId) !== config.chain_id ||
      getAddress(domain.verifyingContract) !== getAddress(route.inputToken) ||
      getAddress(message.owner) !== getAddress(owner) ||
      getAddress(message.spender) !== getAddress(config.sor_address) ||
      BigInt(message.value) !== BigInt(permit.value_raw) ||
      BigInt(message.value) !== BigInt(route.initialDepositAmount) ||
      !Number.isSafeInteger(Number(message.deadline)) ||
      Number(message.deadline) <= now + 5 ||
      Number(message.deadline) > Number(route.deadline) ||
      BigInt(message.nonce) < 0n ||
      (permit.nonce != null && BigInt(message.nonce) !== BigInt(permit.nonce)) ||
      (permit.suggested_deadline != null &&
       Number(message.deadline) !== Number(permit.suggested_deadline))) {
    throw new Error("Refresh the permission");
  }
  ${CHECK_WALLET}
  await checkWallet(walletClient, owner, config.chain_id);
  const permitSignature = await walletClient.signTypedData({
    account: owner, domain, primaryType: "Permit",
    types: { Permit: [
      { name: "owner", type: "address" }, { name: "spender", type: "address" },
      { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ] },
    message: { ...message, value: BigInt(message.value),
      nonce: BigInt(message.nonce), deadline: BigInt(message.deadline) },
  });
  await checkWallet(walletClient, owner, config.chain_id);
  signedPermit = { quoteId: quote.uuid, signature: permitSignature, deadline: Number(message.deadline) };
}
// For a required non-permit approval, compare quote.permit.current_allowance_raw
// to the required amount. If short, build /approve for config.sor_address, sign,
// send via /tx/send and request a fresh quote to recheck allowance before signing.`;

export const SIGN_INTENT = `// walletClient: your viem WalletClient for the connected wallet
const INTENT_TYPES = {
  Intent: [
    { name: "taker",                type: "address" },
    { name: "inputToken",           type: "address" },
    { name: "outputToken",          type: "address" },
    { name: "maxInputAmount",       type: "uint256" },
    { name: "minOutputAmount",      type: "uint256" },
    { name: "recipient",            type: "address" },
    { name: "initialDepositAmount", type: "uint256" },
    { name: "uuid",                 type: "uint256" },
    { name: "deadline",             type: "uint48"  },
  ],
};

${CHECK_WALLET}
await checkWallet(walletClient, owner, config.chain_id);
const { timestamp: signTime } = await sera("/system/time");
const rp = assertSwapQuote(quote, request, signTime, quotedAt);
${CHECK_PERMISSION}
if (needsPermit(quote, rp, config) && signedPermit?.quoteId !== quote.uuid)
  throw new Error("Sign the permit for this quote first");
// Confirm this exact quote with the payer before opening the wallet.
const signature = await walletClient.signTypedData({
  account: owner,
  domain: config.eip712_domain,
  types: INTENT_TYPES,
  primaryType: "Intent",
  message: {
    taker:                rp.taker,
    inputToken:           rp.inputToken,
    outputToken:          rp.outputToken,
    maxInputAmount:       BigInt(rp.maxInputAmount),
    minOutputAmount:      BigInt(rp.minOutputAmount),
    recipient:            rp.recipient,
    initialDepositAmount: BigInt(rp.initialDepositAmount),
    uuid:                 BigInt(rp.uuid),
    deadline:             Number(rp.deadline),
  },
});
await checkWallet(walletClient, owner, config.chain_id);
// ethers v6: signer.signTypedData(domain, INTENT_TYPES, message)`;

export const SUBMIT = `// Save enough detail to recover this attempt before sending.
const { timestamp: submitTime } = await sera("/system/time");
const route = assertSwapQuote(quote, request, submitTime, quotedAt);
${CHECK_PERMISSION}
if (needsPermit(quote, route, config) && !signedPermit) {
  throw new Error("This quote requires a signed permit");
}
if (signedPermit && (signedPermit.quoteId !== quote.uuid ||
    !signedPermit.signature || !Number.isSafeInteger(signedPermit.deadline) ||
    signedPermit.deadline <= submitTime)) {
  throw new Error("Sign the permit for this quote");
}
const body = { uuid: quote.uuid, signature };
if (signedPermit) {
  body.permit_signature = signedPermit.signature;
  body.permit_deadline = signedPermit.deadline;
}
// Claim the reviewed quote once on the server, keyed by owner, chain and UUID.
if (!(await claimPendingSwap(quote.uuid, { chainId: config.chain_id, request, signedRoute: quote.route_params })))
  throw new Error("Swap already awaiting acknowledgment");
const result = await sera("/swap", { body });
if (!result.success || !result.trade_id) {
  throw new Error("Reconcile this attempt before retrying");
}
await saveTradeId(quote.uuid, result.trade_id);
// If the response is lost, look up the original attempt before retrying.`;

export const TRACK = `// Use the owner's server-side bearer and the route saved with this trade ID.
${READ_SWAP_SETTLEMENT}
const settlement = await readSwapSettlement(tradeId, route);
const settled = settlement !== null;
// Render the CLOB status while pending. On settlement show paid and received
// in their respective token units. The signed route binds the recipient.`;

export const SWITCH_TO_PRODUCTION = `const networks = {
  sepolia: { chainId: 11155111, api: "https://api.testnet.sera.cx/api/v1" },
  live: { chainId: 1, api: "https://api.sera.cx/api/v1" },
};
const { chainId, api } = networks[selectedNetwork];
const response = await fetch(api + "/config", { redirect: "error" });
if (!response.ok) throw new Error("Network configuration unavailable");
const config = await response.json();
if (config.chain_id !== chainId || config.eip712_domain?.chainId !== chainId)
  throw new Error("Unexpected Sera network");
// Scope cookie names, cookie audiences, pending attempts and caches by chain.
// Load that network’s token registry, verify the wallet chain and enable a
// separate wallet credential before making an authenticated request.`;
