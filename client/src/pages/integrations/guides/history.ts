import type { WidgetFlow } from "@shared/integration-widget";

function orderPage(type: "limit" | "swap") {
  const amounts = type === "limit"
    ? "side: t.side, rate: t.price, filledBase: t.filled_base_amount, remainingBase: t.remaining_amount"
    : "inputToken: t.from_token, outputToken: t.to_token, requestedInputRaw: t.from_amount";
  return `// Server only. Use the verified wallet and its bearer for this network.
const readSera = seraFor(network);
const ownerAddress = owner.toLowerCase();
async function readPage(offset = 0, before = new Date().toISOString()) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid offset");
  const query = new URLSearchParams({
    owner_address: ownerAddress, type: "${type}", limit: "20",
    offset: String(offset), created_before: before, sort_by: "created_at", order: "desc",
  });
  const { trades, total } = await readSera("/orders?" + query, { bearer });
  if (!Array.isArray(trades) || !Number.isSafeInteger(total) || total < 0 ||
      (!trades.length && offset < total) ||
      trades.some(t => !t.trade_id || t.owner_address?.toLowerCase() !== ownerAddress ||
        t.order_type !== "${type}")) throw new Error("Order history unavailable");
  const next = offset + trades.length;
  const rows = trades.map(t => ({
    id: t.trade_id, time: t.created_at, pair: t.symbol, orderStatus: t.status,
    ${amounts},
  }));
  return { rows, nextOffset: next < total ? next : null, before };
}
const page = await readPage();
// On “Load more”, call readPage(page.nextOffset, page.before) when nextOffset is non-null.
// Use trade_id as the row key. Refresh starts at the first page.`;
}

const browserTransfers = `// npm install idb-keyval. This browser stores display records only.
import { get, update } from "idb-keyval";
// Bind these functions to the current wallet and chain. Rebind them on a switch.
const historyKey = "transfers:" + chainId + ":" + owner.toLowerCase();
async function saveTransfer(review, expectedHash, acknowledgment) {
  const hash = expectedHash.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new Error("Invalid signed hash");
  const submitted = acknowledgment?.tx_hash?.toLowerCase() === hash;
  await update(historyKey, (records = []) => {
    const old = records.find(r => r.hash === hash);
    const row = old ?? {
      hash, time: Date.now(), recipient: review.recipient,
      token: review.token, decimals: review.decimals, amountRaw: String(review.amountRaw),
    };
    const status = old?.status === "Submitted" || submitted ? "Submitted" : "Unconfirmed";
    return [{ ...row, status }, ...records.filter(r => r.hash !== hash)]
      .sort((a, b) => b.time - a.time).slice(0, 100);
  });
}
async function readTransfers() { return (await get(historyKey)) ?? []; }
// After signing, saveTransfer(review, signedHash, null) records uncertainty.
// After the server broadcasts once, saveTransfer(review, signedHash, acknowledgment)
// updates the same row. Opening or refreshing the table only calls readTransfers().`;

const savedTransfers = `// Your PostgreSQL table of signed attempts. The send step writes once per
// (chain_id, owner_address, tx_hash), then records the broadcast acknowledgment.
// This read uses the current session’s verified owner and selected chain.
if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid offset");
const { rows } = await db.query(
  \`SELECT submitted_at, recipient, token_address, token_decimals, amount_raw, status, tx_hash
   FROM transfer_submissions WHERE chain_id = $1 AND owner_address = $2
   ORDER BY submitted_at DESC, tx_hash DESC LIMIT 20 OFFSET $3\`,
  [chainId, owner.toLowerCase(), offset]);
// Format amount_raw with token_decimals. Keep raw signed bytes out of this table.`;

const paymentRows = `// Map these columns to your app’s checkout store. Save one stable payment_id
// per attempt. Set qr_request_id from the verified checkout on your server.
// Only your server’s settlement check can write actual amounts or mark it verified.
const merchant = await authenticateMerchant(request);
if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid offset");
const { rows } = await db.query(
  \`SELECT payment_id, qr_request_id, created_at, reference, status, verified,
          requested_amount_raw, receive_token, paid_amount_raw, pay_token,
          received_amount_raw, tx_hash
   FROM payment_attempts WHERE merchant_id = $1 AND receiver = $2 AND chain_id = $3
   ORDER BY created_at DESC, payment_id DESC LIMIT 20 OFFSET $4\`,
  [merchant.id, merchant.walletAddress.toLowerCase(), chainId, offset]);
const positiveRaw = value => typeof value === "string" && /^[0-9]+$/.test(value) && BigInt(value) > 0n;
const table = rows.map(row => {
  const paid = row.verified === true && row.status === "confirmed";
  return {
    id: row.payment_id, qrRequestId: row.qr_request_id ?? null, time: row.created_at, reference: row.reference,
    status: row.status === "confirmed" && !paid ? "confirming" : row.status,
    requested: row.requested_amount_raw, receiveToken: row.receive_token,
    paidAmount: paid ? row.paid_amount_raw : null, payToken: row.pay_token,
    receivedAmount: paid ? row.received_amount_raw : null,
    canShowReceipt: paid && row.created_at != null && Number.isFinite(new Date(row.created_at).getTime()) &&
      Boolean(row.receive_token) && positiveRaw(row.received_amount_raw) &&
      (positiveRaw(row.paid_amount_raw) ||
        (row.paid_amount_raw == null && (!row.pay_token || row.pay_token === row.receive_token))),
  };
});
// Recheck verified settlement on the receipt endpoint too.`;

interface HistoryGuide {
  summary: string;
  display: string;
  check: string;
  example: string;
  sampleTitle: string;
  otherExample?: { title: string; code: string };
  reference: string;
}

const orderReference = "https://docs.sera.cx/api-reference/endpoints/orders/#list-orders";
const transferReference = "https://docs.sera.cx/api-reference/endpoints/account/#erc-20-transfer";

export const historyGuides: Record<WidgetFlow, HistoryGuide> = {
  swap: {
    summary: "List this wallet’s swaps with GET /orders filtered by type=swap. Use the owner’s API key for the selected network.",
    display: "Show time, token pair and order status. A matched swap is waiting for settlement. Open the order and all its fills to check net amounts before showing what was spent and received. A quote, estimated output or transaction hash alone cannot establish payment.",
    check: "Recover a timed-out submission using the saved owner, network and signed route UUID. A missing trade ID or order leaves the submission unconfirmed. Keep the original attempt available and link to its status. Never send another swap from the history table.",
    sampleTitle: "Read one page of swaps",
    example: orderPage("swap"),
    reference: orderReference,
  },
  "set-rate": {
    summary: "List this wallet’s limit orders with GET /orders filtered by type=limit. Use the owner’s API key for the selected network.",
    display: "Show time, pair, side, rate, amount filled, amount remaining and order status. filled_base_amount and remaining_amount are decimal strings in base-token units. Matched orders can still be settling, and canceled orders can have earlier fills.",
    check: "Open GET /orders/{order_id} and every page of GET /fills/{order_id}. Check settlement_status and perspective_order_id before displaying each settled debit or credit. A partial fill, failed fill or cancellation must preserve the other fills.",
    sampleTitle: "Read one page of limit orders",
    example: orderPage("limit"),
    reference: orderReference,
  },
  transfer: {
    summary: "Sera returns a broadcast hash but offers no direct-transfer history or confirmation lookup. Show the submissions recorded by your app for this sender and network.",
    display: "Show time, recipient, token, amount, signed hash and status. Save the reviewed amount, contract and decimals once per chain, sender and signed hash before sending. Mark it Submitted only when /transfer/send returns that hash. A lost or mismatched acknowledgment stays Unconfirmed.",
    check: "Label browser-only history “This browser” and keep the latest 100 submissions. For cross-device history, read your authenticated server records. Ignore drafts and declined signatures. Reloading the table must never broadcast, and a submitted row cannot authorize fulfillment.",
    sampleTitle: "Save and read submissions in this browser",
    example: browserTransfers,
    otherExample: { title: "Read a cross-device transfer history", code: savedTransfers },
    reference: transferReference,
  },
  accept: {
    summary: "Use your own records to list payments attempted on this merchant’s checkout links. Authenticate the merchant and filter by their receiving wallet and network. Reading these records requires no merchant Sera API key. The payer’s order history belongs to the payer.",
    display: "List generated QR requests as soon as they are issued, even with zero payments. Link each payment row to its source request. Its private detail page shows the original terms, checkout link and all attempts made through it. Show time, payment reference, amount requested and status. Show the actual amount the customer paid and the merchant received only after verified settlement. Creating or scanning a link does not create a payment.",
    check: "Use one row per payment ID, even when several people use the same link. Keep an unconfirmed submission available by that ID. Leave the source empty for an unrelated wallet transfer. A scan and a copied link carry the same request ID. Verify converted payments with the payer’s order and all fills. A matching direct-transfer hash means Submitted, and QR scanning cannot discover a transfer through Sera. Fulfill after verifying settlement. Offer a receipt only when the recorded settlement includes the exact amounts and tokens. If an older record lacks those amounts, keep its verified status and withhold the receipt.",
    sampleTitle: "Read the merchant’s payment records",
    example: paymentRows,
    otherExample: {
      title: "Read one QR request and its payments",
      code: `// Use the authenticated merchant and selected network for both reads.
const merchant = await authenticateMerchant(request);
const scope = [merchant.id, chainId, requestId];
const { rows: [qr] } = await db.query(
  "SELECT id, created_at, terms, checkout_url FROM qr_requests WHERE merchant_id=$1 AND chain_id=$2 AND id=$3",
  scope);
if (!qr) throw new Error("QR request not found");
if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid offset");
const { rows: payments } = await db.query(
  "SELECT payment_id, created_at, status, verified FROM payment_attempts " +
  "WHERE merchant_id=$1 AND chain_id=$2 AND qr_request_id=$3 ORDER BY created_at DESC, payment_id DESC LIMIT 20 OFFSET $4",
  [...scope, offset]);
return { qr, payments }; // payments can be empty.`,
    },
    reference: "https://docs.sera.cx/api-reference/endpoints/orders/#get-fills-for-one-order",
  },
};

export function historyPrompt(flow: WidgetFlow) {
  const guide = historyGuides[flow];
  const listing = flow === "swap" || flow === "set-rate"
    ? "Page through trades and total with limit and offset, newest first. Pin created_before for Load more and deduplicate by trade_id. Use token addresses and the selected registry decimals for raw amounts."
    : "Page the authenticated app records newest first using a stable secondary key. Browser history must identify its scope. Store only display fields in history; exclude credentials, signed bytes and signatures.";
  return [
    "Transaction history",
    guide.summary, guide.display, guide.check, listing,
    "Show addresses and amounts as text. Format raw amounts using their token contract and decimals on the selected chain. Keep the table visible to guests with a sign-in action. Clear private rows on logout, wallet or network change. Show loading, empty and unavailable/retry separately. Retry reads only. Test paging, duplicate rows, an interrupted read and switching accounts or networks while a request is in flight.",
  ].join("\n");
}
