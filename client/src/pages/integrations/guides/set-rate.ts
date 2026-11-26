import { ChartNoAxesColumnIncreasing, PenLine, SlidersHorizontal, Vault } from "lucide-react";
import { CHECK_WALLET, SIGN_RAW_CALL, VERIFY_RAW_CALL } from "./shared";
import type { GuideContent } from "./types";

const verifyDeposit = `const data = encodeFunctionData({
  abi: parseAbi(["function depositFund(address token,address owner,uint256 amount)"]),
  functionName: "depositFund", args: [spendingToken.address, owner, depositAmountRaw],
});
if (getAddress(tx.to) !== getAddress(config.sera_address) || tx.data.toLowerCase() !== data.toLowerCase() ||
    BigInt(tx.chainId) !== BigInt(config.chain_id) || BigInt(tx.type) !== 2n || BigInt(tx.value) !== 0n ||
    tx.accessList?.length || tx.authorizationList != null || BigInt(tx.gas) <= 0n ||
    BigInt(tx.maxPriorityFeePerGas) > BigInt(tx.maxFeePerGas)) throw new Error("Deposit changed");`;

const orderFields = `const orderFields = [
  { name: "user", type: "address" }, { name: "expiration", type: "uint48" },
  { name: "feeBps", type: "uint48" }, { name: "recipient", type: "address" },
  { name: "fromToken", type: "address" }, { name: "toToken", type: "address" },
  { name: "fromAmount", type: "uint256" }, { name: "toAmount", type: "uint256" },
  { name: "initialDepositAmount", type: "uint256" }, { name: "uuid", type: "uint256" },
];`;

const verifyOrder = `${orderFields}
function reviewedOrder(draft, preview, now) {
  const signedOrder = preview.eip712_order;
  const [spendToken, receiveToken] = draft.side === "ask"
    ? [draft.from_address, draft.to_address] : [draft.to_address, draft.from_address];
  const fields = preview.eip712_types?.Order;
  if (!Number.isSafeInteger(now) || !signedOrder || Object.keys(signedOrder).length !== orderFields.length ||
      !Array.isArray(fields) || fields.length !== orderFields.length ||
      fields.some((field, i) => field.name !== orderFields[i].name || field.type !== orderFields[i].type) ||
      !preview.ok || draft.owner_address.toLowerCase() !== owner.toLowerCase() ||
      !["ask", "bid"].includes(draft.side) ||
      getAddress(preview.from_token) !== getAddress(spendToken) ||
      getAddress(preview.to_token) !== getAddress(receiveToken) ||
      signedOrder.user.toLowerCase() !== owner.toLowerCase() ||
      preview.side !== draft.side || BigInt(signedOrder.uuid) !== BigInt(draft.uuid_int) ||
      BigInt(signedOrder.expiration) !== BigInt(draft.expiration) || draft.expiration <= now ||
      getAddress(signedOrder.fromToken) !== getAddress(spendToken) ||
      getAddress(signedOrder.toToken) !== getAddress(receiveToken) ||
      BigInt(signedOrder.fromAmount) !== BigInt(preview.from_amount) ||
      BigInt(signedOrder.toAmount) !== BigInt(preview.to_amount) ||
      BigInt(signedOrder.fromAmount) <= 0n || BigInt(signedOrder.toAmount) <= 0n ||
      getAddress(signedOrder.recipient) !== zeroAddress ||
      BigInt(signedOrder.feeBps) !== 0n || BigInt(signedOrder.initialDepositAmount) !== 0n) {
    throw new Error("Order preview no longer matches");
  }
  return signedOrder;
}`;

const mainnetOrderReview = `${orderFields}
// Read config and tokens for the active network before calling.
function mainnetPreview(draft, market, config, tokens, health) {
  const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
  const contract = "0xb5c50c5d5f038404f85970b7f5b7259c4ac0e198";
  const vault = "0xc7d4fd2638e6630c8c61329878676b88a8a24d43";
  const d = config.eip712_domain;
  if (config.chain_id !== 1 || d?.chainId !== 1 || d.name !== "Sera" || d.version !== "1" ||
      !same(config.sera_address, contract) || !same(d.verifyingContract, contract) || !same(config.vault_address, vault) ||
      health.status !== "healthy" || health.signature_ready !== true || health.executor_id !== health.relayer_executor_id) {
    throw new Error("Mainnet order configuration unavailable");
  }
  const base = tokens.find(t => same(t.address, draft.from_address));
  const quote = tokens.find(t => same(t.address, draft.to_address));
  if (!base || !quote || base.decimals !== market.base_decimals || quote.decimals !== market.quote_decimals ||
      ![base.decimals, quote.decimals].every(n => Number.isInteger(n) && n >= 0 && n <= 36)) throw new Error("Token registry changed");
  function decimal(value) {
    if (typeof value !== "string" || value.length > 50 || !/^\\d+(?:\\.\\d+)?$/.test(value)) throw new Error("Invalid decimal");
    const [whole, fraction = ""] = value.split(".");
    const units = BigInt(whole + fraction);
    if (!units) throw new Error("Expected a positive amount");
    return [units, 10n ** BigInt(fraction.length)];
  }
  function checkGrid(n, scale, step, precision) {
    if (!step && !(Number.isInteger(precision) && precision >= 0 && precision <= 36)) throw new Error("Missing market precision");
    const [u, s] = step ? decimal(step) : [1n, 10n ** BigInt(precision)];
    if (n * s % (scale * u)) throw new Error("Choose an exact market increment");
  }
  function raw(n, denominator, places) {
    const scaled = n * 10n ** BigInt(places);
    if (scaled % denominator) throw new Error("This amount is below token precision");
    const result = scaled / denominator;
    if (!result || result.toString().length > 50) throw new Error("Order amount out of range");
    return result;
  }
  const [a, as] = decimal(draft.amount), [p, ps] = decimal(draft.price);
  checkGrid(a, as, market.amount_step, market.quantity_precision);
  checkGrid(p, ps, market.price_step, market.tick_precision);
  const baseRaw = raw(a, as, base.decimals), quoteRaw = raw(a*p, as*ps, quote.decimals);
  const bid = draft.side === "bid";
  const from = bid ? quote : base, to = bid ? base : quote;
  const fromRaw = bid ? quoteRaw : baseRaw, toRaw = bid ? baseRaw : quoteRaw;
  if (fromRaw < BigInt(bid ? market.min_bid_quote_amount_raw : market.min_ask_amount_raw)) throw new Error("Below market minimum");
  return {
    ok: true, side: draft.side, normalized_amount: draft.amount, normalized_price: draft.price,
    from_token: from.address, to_token: to.address, from_amount: String(fromRaw), to_amount: String(toRaw),
    eip712_types: { Order: orderFields }, eip712_order: {
      user: draft.owner_address, expiration: draft.expiration, feeBps: "0", recipient: "0x" + "0".repeat(40),
      fromToken: from.address, toToken: to.address, fromAmount: String(fromRaw), toAmount: String(toRaw),
      initialDepositAmount: "0", uuid: draft.uuid_int,
    },
  };
}`;

export const setRate: GuideContent = {
  setup: [
    "Load /markets for the canonical base and quote order, market steps, and side-specific minimums. Load /health for executor_id and /config for the signing domain.",
    "Show users what they send and receive. Derive the side from the canonical market with an ask when they send base, and a bid when they send quote.",
    "Use fixed-point decimal strings. Amount is in base tokens, price in quote tokens per base token. An ask sells base; a bid buys base using quote.",
    "A funded owner can sign and place an order without an API key. Offer a private balance check when the user wants to see their available Vault funds or make a deposit.",
  ],
  steps: [
    {
      id: "preview",
      icon: SlidersHorizontal,
      title: "Preview the price and amount",
      summary:
        "Review the market, spending token and receive amount. Sepolia returns the preview. Mainnet supports building the same Order locally when its preview endpoint returns 405.",
      rules: [
        "Set expiration from Sera time. Generate a UUID v4 per order. Pack executor, UUID, group and leg as a decimal uint256.",
        "Use amount_step and price_step when present. Older registries publish quantity_precision and tick_precision as decimal places. Use the Mainnet construction below only for HTTP 405 on chain 1. Verify the deployed contract, executor, both token decimals and exact market increments. Show both amounts before signing. Stop on other errors.",
        "If the preview changes the amount or rate, show the new values and get fresh confirmation. It does not test balances or guarantee placement.",
        "A bid still sends base in from_address and quote in to_address. Use the returned from_token and to_token for actual spending direction.",
      ],
      sample: {
        title: "Preview one standalone order",
        code: `const [health, { timestamp }] = await Promise.all([
  sera("/health"), sera("/system/time"),
]);
const { executor_id } = health;
if (!Number.isInteger(executor_id) || executor_id < 0 || executor_id > 15) {
  throw new Error("Executor unavailable");
}
const order_id = crypto.randomUUID();
const orderBits = BigInt("0x" + order_id.replaceAll("-", ""));
const uuid_int = ((BigInt(executor_id) << 252n) |
  (orderBits << 124n) | ((orderBits >> 16n) << 12n)).toString();
// spendToken is the user's selected asset. baseAmount and quotePerBase are
// positive decimal strings in the canonical market's units.
const spend = spendToken.address.toLowerCase();
const side = spend === market.base_address.toLowerCase() ? "ask" :
  spend === market.quote_address.toLowerCase() ? "bid" : null;
if (!side) throw new Error("The selected token is outside this market");
const positiveDecimal = value => typeof value === "string" &&
  /^[0-9]+(?:\\.[0-9]+)?$/.test(value) && /[1-9]/.test(value);
if (!positiveDecimal(baseAmount) || !positiveDecimal(quotePerBase)) throw new Error("Invalid price or amount");
const draft = {
  owner_address: owner.toLowerCase(), side, order_type: "limit",
  from_address: market.base_address, to_address: market.quote_address,
  amount: baseAmount, price: quotePerBase, order_id, uuid_int,
  expiration: timestamp + 3600,
};
let preview;
try {
  preview = await sera("/orders/preview", { body: draft });
} catch (err) {
  if (err.status !== 405 || config.chain_id !== 1) throw err;
  // Use the Mainnet helper below with a fresh registry.
  const { tokens } = await sera("/tokens");
  preview = mainnetPreview(draft, market, config, tokens, health);
}`,
      },
      extraSamples: [{ title: "Mainnet · build an exact standalone Order", code: mainnetOrderReview }],
    },
    {
      id: "fund",
      icon: Vault,
      title: "Fund the Vault if needed",
      summary:
        "If the Vault already has enough of the spending token, skip to signing. To add funds, check the available balance and deposit only the shortfall.",
      rules: [
        "Check /balances and the vault_available field for the order’s spending token. Funds frozen for another order or withdrawal are unavailable.",
        "Use /permit/metadata where applicable. For a supported permit, verify the token, Vault spender, amount and deadline and sign the permit. Otherwise build an exact /approve, sign the reviewed transaction and submit it through /tx/send before building /deposit.",
        "Require a signer that returns raw bytes and use /tx/send for the reviewed deposit. A returned hash acknowledges submission. Reload /balances with the owner credential and wait for sufficient vault_available before signing the order.",
      ],
      sample: {
        title: "Deposit with an existing allowance",
        code: `// Backend: build the requested deposit with the authenticated owner’s bearer.
// viem: encodeFunctionData, getAddress, parseAbi
if (depositAmountRaw <= 0n) throw new Error("No deposit is needed");
const { tx } = await sera("/deposit", {
  bearer,
  body: { token: spendingToken.address, amount: depositAmountRaw.toString(), owner: owner.toLowerCase() },
});
${verifyDeposit}
// Save the reviewed transaction. Return tx and the attemptId to the wallet.`,
      },
      extraSamples: [
        {
          title: "Browser · sign the reviewed deposit",
          code: `// Check against the token, owner and amount the wallet user reviewed.
${verifyDeposit}
${SIGN_RAW_CALL}
// Send raw_tx and the original attemptId to your backend.`,
        },
        {
          title: "Backend · verify and broadcast the deposit",
          code: `${VERIFY_RAW_CALL}
if (!(await claimPendingHash({ owner, chainId: config.chain_id, attemptId, expectedHash })))
  throw new Error("Deposit already awaiting acknowledgment");
const { tx_hash } = await sera("/tx/send", { bearer, body: { raw_tx } });
if (tx_hash?.toLowerCase() !== expectedHash) throw new Error("Reconcile the original deposit");
// Reload /balances and require enough vault_available before placing the order.`,
        },
        {
          title: "Build a separate Vault approval",
          code: `const { tx: approveTx } = await sera("/approve", {
  bearer,
  body: { token: spendingToken.address, owner: owner.toLowerCase(),
    spender: config.vault_address, amount: depositAmountRaw.toString() },
});
// Decode approveTx: check token, network, zero native value, Vault spender
// and exact amount. For a partial allowance, try the exact replacement first.
// If the token requires a reset and Sera cannot build it, ask the owner
// to clear that allowance in their wallet. Recheck it before continuing.
// Sign the reviewed approval, broadcast via /tx/send, then request the deposit build.`,
        },
        {
          title: "Build a deposit with a signed permit",
          code: `// Sign the token's verified permit for this Vault using its current nonce.
// signedPermit.deadline is the signed Unix timestamp in seconds.
const { tx: depositTx } = await sera("/deposit", {
  bearer,
  body: { token: spendingToken.address, owner: owner.toLowerCase(),
    amount: depositAmountRaw.toString(), permit_signature: signedPermit.signature,
    permit_deadline: signedPermit.deadline, permit_amount: depositAmountRaw.toString() },
});
// Sign the reviewed transaction, send via /tx/send, then recheck /balances.`,
        },
      ],
    },
    {
      id: "publish",
      icon: PenLine,
      title: "Sign and publish the rate",
      summary:
        "Sign the preview’s exact EIP-712 Order and send the same normalized amount, price, IDs and expiry.",
      rules: [
        "Recheck chain, owner, spending token, receive token and raw amounts immediately before signing. Reject stale or changed drafts.",
        "Keep both IDs before submitting. After an ambiguous failure, look up the original order before retrying. A fresh UUID could place a second order.",
        "Show pending when the API accepts the order. The rate can remain open without a match. A match still needs to settle.",
      ],
      sample: {
        title: "Sign and place the reviewed order",
        code: `// viem: getAddress, zeroAddress
${verifyOrder}
if (!(await confirmOrderPreview(preview))) throw new Error("Order was not approved");
const { timestamp: now } = await sera("/system/time");
${CHECK_WALLET}
await checkWallet(wallet, owner, config.chain_id);
const signedOrder = reviewedOrder(draft, preview, now);
const signature = await wallet.signTypedData({
  account: owner,
  domain: config.eip712_domain,
  types: { Order: orderFields },
  primaryType: "Order",
  message: signedOrder,
});
await checkWallet(wallet, owner, config.chain_id);
if ((await sera("/system/time")).timestamp >= draft.expiration) throw new Error("Order expired while signing");
await savePendingOrder(draft.order_id, draft.uuid_int);
const placed = await sera("/orders", {
  body: { ...draft, amount: preview.normalized_amount, price: preview.normalized_price, signature },
});`,
      },
    },
    {
      id: "manage",
      icon: ChartNoAxesColumnIncreasing,
      title: "Track fills and cancel the remainder",
      summary:
        "Read /orders/{order_id} and /fills/{order_id} with the owner’s credential. Show the amount filled, amount remaining and settlement by fill.",
      rules: [
        "pending can include partial fills. matched means settlement is still in progress. Read every fill page, match the order perspective, and count only settled fills using balance_debits and balance_credits.",
        "filled_base_amount and remaining_amount are decimal strings in base-token units. Format them exactly for display. For example, 0E-18 means zero filled.",
        "For cancellation, sign CancelOrder using the original composite UUID. Respect 429 and the cooldown. A cancelled order can still have earlier fills settling.",
        "For a multi-rate position, use /orders/vl/batch and /orders/vl/cancel. Read the leg limits from /config. Use distinct markets, one owner and one spending token. Give each leg its own UUID and use a shared group from the first UUID. Review and sign each leg, then reconcile any amendments, cancellations and fills.",
      ],
      sample: {
        title: "Track and cancel a standalone order",
        code: `${CHECK_WALLET}
await checkWallet(wallet, owner, config.chain_id);
const order = await sera("/orders/" + order_id, { bearer });
if (order.trade_id !== order_id || order.order_type !== "limit" ||
    order.owner_address.toLowerCase() !== owner.toLowerCase() ||
    order.uuid_int !== savedUuidInt) throw new Error("Order or network changed");
const fills = [];
for (let offset = 0;; offset += 100) {
  const { items } = await sera("/fills/" + order_id + "?limit=100&offset=" + offset, { bearer });
  if (!Array.isArray(items) || items.some(fill =>
    ![fill.maker_order_id, fill.taker_order_id].includes(order_id) ||
    fill.settlement_economics?.perspective_order_id !== order_id)) throw new Error("Invalid order fills");
  fills.push(...items);
  if (items.length < 100) break;
}
const settledFills = fills.filter(fill => fill.settlement_status === "settled");
// Display settledFills separately from pending, confirming, failed or reverted rows.
// savedUuidInt is the composite UUID stored when this order was signed.
// The following cancellation runs only after the owner chooses to cancel.
await checkWallet(wallet, owner, config.chain_id);
const signature = await wallet.signTypedData({
  account: owner, domain: config.eip712_domain, primaryType: "CancelOrder",
  types: { CancelOrder: [
    { name: "owner", type: "address" },
    { name: "orderId", type: "uint256" },
  ] },
  message: { owner, orderId: BigInt(order.uuid_int) },
});
await checkWallet(wallet, owner, config.chain_id);
await sera("/orders/cancel", { body: {
  owner_address: owner.toLowerCase(), order_id, uuid_int: order.uuid_int, signature,
} });
// Continue reading earlier fills until each reaches a terminal state.`,
      },
      extraSamples: [
        {
          title: "Publish multiple rates against one spending token",
          code: `// standaloneDrafts: separately previewed, distinct markets for the same owner.
// Each draft has its own UUID and canonical amount, price and expiration.
// viem: getAddress, zeroAddress
${verifyOrder}
${CHECK_WALLET}
const { min, max } = config.limits.vl_batch;
const pairs = new Set(standaloneDrafts.map(({ draft }) =>
  [draft.from_address, draft.to_address].map(address => address.toLowerCase()).sort().join(":")
));
const spenders = new Set(standaloneDrafts.map(({ preview }) => preview.from_token.toLowerCase()));
const ids = new Set(standaloneDrafts.map(({ draft }) => draft.order_id));
if (standaloneDrafts.length < min || standaloneDrafts.length > max ||
    pairs.size !== standaloneDrafts.length || ids.size !== standaloneDrafts.length || spenders.size !== 1 ||
    standaloneDrafts.some(({ draft, preview }) => !preview.ok ||
      draft.owner_address.toLowerCase() !== owner.toLowerCase())) {
  throw new Error("Invalid multi-rate position");
}
if (!(await confirmBatchPreview(standaloneDrafts)) ||
    (await wallet.getChainId()) !== config.chain_id) throw new Error("Batch was not approved");
const pack = (bits, group, leg) => ((BigInt(executor_id) << 252n) |
  (bits << 124n) | (group << 12n) | BigInt(leg)).toString();
const uuidBits = id => BigInt("0x" + id.replaceAll("-", ""));
const group = uuidBits(standaloneDrafts[0].draft.order_id) >> 16n;
const orders = [];
for (const [index, { draft, preview }] of standaloneDrafts.entries()) {
  const { timestamp } = await sera("/system/time");
  await checkWallet(wallet, owner, config.chain_id);
  const reviewed = reviewedOrder(draft, preview, timestamp);
  const uuid_int = pack(uuidBits(draft.order_id), group, index);
  const signature = await wallet.signTypedData({
    account: owner, domain: config.eip712_domain,
    primaryType: "Order", types: { Order: orderFields },
    message: { ...reviewed, uuid: uuid_int },
  });
  await checkWallet(wallet, owner, config.chain_id);
  orders.push({ ...draft, uuid_int, signature,
    amount: preview.normalized_amount, price: preview.normalized_price });
}
const { timestamp: submitTime } = await sera("/system/time");
if (orders.some(order => order.expiration <= submitTime)) throw new Error("Order expired while signing");
await savePendingBatch(orders.map(order => order.order_id));
const batch = await sera("/orders/vl/batch", { body: { orders } });`,
        },
        {
          title: "Cancel a multi-rate position",
          code: `${CHECK_WALLET}
await checkWallet(wallet, owner, config.chain_id);
const signature = await wallet.signTypedData({
  account: owner, domain: config.eip712_domain, primaryType: "CancelVLBatch",
  types: { CancelVLBatch: [
    { name: "owner", type: "address" }, { name: "vlBatchId", type: "string" },
  ] },
  message: { owner, vlBatchId: vl_batch_id },
});
await checkWallet(wallet, owner, config.chain_id);
await sera("/orders/vl/cancel", {
  body: { owner_address: owner.toLowerCase(), vl_batch_id, signature },
});`,
        },
      ],
    },
  ],
  edgeCases: [
    [
      "Price tick or amount step rejected",
      "Explain the allowed step. Preview a corrected value and ask the user to approve any change.",
    ],
    [
      "Wrong side or pair",
      "Use the market’s canonical base and quote. Preview the actual spending and receiving tokens on both sides.",
    ],
    [
      "Insufficient Vault funds or gas",
      "Offer the correct funding action. Recheck vault_available on /balances before proceeding.",
    ],
    [
      "Partial fill or in-flight match",
      "Record fills individually. A reverted leg, cancellation or expiry must leave prior settled fills visible.",
    ],
    [
      "Cooldown, screen or self-match rejection",
      "Show the documented error, keep the original order if it still exists, and never silently change the rate or side.",
    ],
    [
      "Timeout or duplicate submission",
      "Reconcile the same saved order or batch IDs and keep the user informed while the result is unknown.",
    ],
  ],
  checklist: [
    {
      group: "Preview and fund on Sepolia",
      items: [
        {
          q: "Preview an ask and a bid on the same market.",
          expect: "Base and quote stay fixed while the spending token changes.",
        },
        {
          q: "Try a price outside the tick and an amount below the side minimum.",
          expect: "The request does not reach signing until corrected.",
        },
        {
          q: "Fund a Vault with permit and approval paths that your wallet supports.",
          expect:
            "The order waits until /balances shows enough vault_available.",
        },
      ],
    },
    {
      group: "Place, track and cancel",
      items: [
        {
          q: "Place an order, then simulate a partial fill, settlement delay and a reverted fill.",
          expect: "The history shows each outcome independently.",
        },
        {
          q: "Cancel during cooldown, then cancel after it ends.",
          expect:
            "Only unfilled liquidity is removed. Earlier fills remain visible.",
        },
        {
          q: "Retry an ambiguous submission and test multiple rate legs if offered.",
          expect:
            "No duplicate order is created and each batch leg is tracked.",
        },
      ],
    },
  ],
  promptRules: [
    "Use GET /markets for base_address, quote_address, steps and side minimums, and GET /health for executor_id. Show “You send” and “You receive”. Spend base for an ask or quote for a bid. In both cases send from_address=market.base_address, to_address=market.quote_address, amount in human base units and price in quote units per base.",
    'Generate and keep one UUIDv4 order_id. For a standalone order let bits be its 128-bit value as a BigInt. Set uuid_int = ((BigInt(executor_id) << 252n) | (bits << 124n) | ((bits >> 16n) << 12n)).toString(). POST /orders/preview with owner_address, side, order_type="limit", amount, price, from_address, to_address, order_id, uuid_int and expiration in Unix seconds from Sera time. Show the normalized price, amount and actual spending/receiving tokens for approval.',
    "Where explicit market steps are absent, derive the amount increment from quantity_precision and the price increment from tick_precision. Use POST /orders/preview first. For HTTP 405 only on Ethereum mainnet, use the documented Market Maker Guide to construct the standalone Order locally: verify the mainnet domain, Vault, healthy executor, pair and both decimals, use BigInt for base units and amount times price, enforce exact grid and token-unit representation, and show the exact amounts before signing. Stop on other failures.",
    "Keep signing available to a funded owner without an API key. If the user chooses to check or fund the Vault, use their credential to read the spending token’s vault_available in GET /balances?owner_address=…. Fund only the shortfall. Verify GET /permit/metadata and sign a supported permit for the correct token, amount and config.vault_address, or verify and sign the approval built by POST /approve. Build POST /deposit, verify its chain, target, call and amount, then sign. Require a raw signer and broadcast approval/deposit bytes via POST /tx/send. After depositing, recheck vault_available on GET /balances before signing the order. A broadcast hash alone establishes submission.",
    "Validate preview.ok and match side, owner, chain, token direction, raw amounts, uuid_int and expiry to the approved draft. For the standalone Vault order, check feeBps and initialDepositAmount are zero and recipient is the zero address. Check the returned eip712_types against Sera’s canonical Order field names, order and types. Sign the verified eip712_order with the canonical schema, primary type Order and config.eip712_domain. POST /orders with the original identifiers, normalized_amount as amount, normalized_price as price and signature.",
    "Parse filled_base_amount and remaining_amount as exact, nonnegative decimal strings, including scientific notation such as 0E-18. Display them in base-token units and use fill records to track settlement.",
    "Persist identifiers before submission. After reload or timeout reconcile GET /orders/{order_id} and GET /fills/{order_id} with the owner’s bearer before retrying. Show resting, partial, matched and settled states separately. Read every fill page and bind its maker_order_id or taker_order_id and settlement_economics.perspective_order_id to the order. Show only settled fills as completed and use their net debits and credits. Keep the authenticated CLOB order/fills history separate by owner and network. To cancel, sign CancelOrder(owner, orderId=BigInt(uuid_int)) and POST /orders/cancel with owner_address, order_id, uuid_int and signature. Respect cooldown/429 and keep tracking prior fills.",
    "If the product supports virtual liquidity, validate the batch against config.limits.vl_batch: distinct markets, one owner/spending token, one UUID per leg and one shared group. Preview and sign each leg, persist all IDs, submit POST /orders/vl/batch and cancel with the separately signed CancelVLBatch via POST /orders/vl/cancel.",
  ],
  production:
    "Refresh mainnet markets, executor and signing domain, provision the mainnet owner credential, then place and cancel or settle one small funded order.",
};
