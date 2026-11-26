import { ListChecks, QrCode, Wallet } from "lucide-react";
import { READ_SWAP_SETTLEMENT } from "./shared";
import paymentQrComponent from "../PaymentQrCode.tsx?raw";
import type { GuideContent } from "./types";

export const accept: GuideContent = {
  setup: [
    "Start on Sepolia with separate merchant and payer wallets. The merchant signs in before creating a link. Use their authenticated wallet as the receiver.",
    "Your app signs the link and saves each issued QR request. A reusable link can have many payments. A single-use link also needs an atomic reservation shared across payers and devices.",
    "Load tokens and quotes from the public Sera CLOB. At hosted checkout, ask the payer to enable wallet access before sending a direct transfer or submitting a conversion whose settlement you need to verify. Each quote and swap intent has its own deadline.",
  ],
  steps: [
    {
      id: "invoice",
      icon: QrCode,
      title: "Create and share the payment link",
      summary:
        "Choose the token you receive. Enter an amount for a fixed price, or leave it blank so the customer enters an amount at checkout. You can share either link as a QR code.",
      rules: [
        "Derive the receiver from the authenticated merchant wallet. Look up the receiving token and optional payer preset in that chain’s registry. Sign their contract addresses and decimals with the amount, receiver, chain, reference and link settings. Use a fresh request ID for each new QR and reuse it when retrying the same creation.",
        "The merchant can save a store name, profile image and QR design in your app. Scope edits to their authenticated wallet. Render the signed checkout URL as a QR code in the merchant’s browser. Use that same URL for the copy and open actions. Scanning it opens checkout so the customer can review the request before paying.",
        "Link expiry defaults to No expiry. The timed choices are 15 minutes, 1 hour, 24 hours and 7 days. Compute the deadline once at issuance. Verify the link on your server before showing its terms. Check its deadline when starting a payment and continue tracking any previously submitted attempt after expiry.",
        "Leave both amounts empty for an open link. For example, receive USDC and suggest USDT. Save both token contracts and their decimals. The customer enters the USDT amount at checkout and reviews the minimum USDC you’ll receive. With “Any coins”, the customer also chooses the payment token.",
        "Single-use defaults to off. Turn it on to close the link after the first verified payment, even when the payer chooses the amount.",
      ],
      sample: {
        title: "Sign the link on your server",
        code: `// These are helpers in your app. authenticateMerchant verifies the session
// and wallet ownership. signLink signs your app’s checkout terms on the server.
const merchant = await authenticateMerchant(request);
const duration = { none: 0, "15m": 15 * 60, "1h": 3600, "24h": 86400, "7d": 604800 };
if (!Object.hasOwn(duration, expiryChoice) || typeof singleUse !== "boolean") {
  throw new Error("Invalid link settings");
}
// receiveToken and payerPreset come from the selected network's registry.
// receiveAmount is the merchant's “I receive” entry. Reject excess precision
// before parseUnits so a payment link cannot silently round an invoice.
function positiveUnits(value, decimals) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255 ||
      typeof value !== "string" || value.length > 79 + decimals ||
      !/^[0-9]+(?:\\.[0-9]+)?$/.test(value) || (value.split(".")[1]?.length ?? 0) > decimals)
    throw new Error("Invalid token amount");
  const raw = parseUnits(value, decimals);
  if (raw <= 0n || raw >= 2n ** 256n) throw new Error("Invalid token amount");
  return raw;
}
const openAmount = receiveAmount === "" || receiveAmount === undefined;
const amountRaw = openAmount ? undefined : positiveUnits(receiveAmount, receiveToken.decimals);
if (openAmount && payerPreset?.amount !== undefined && payerPreset.amount !== "") {
  throw new Error("Leave both amounts empty for an open invoice");
}
if (!openAmount && payerPreset) {
  const payRaw = positiveUnits(payerPreset.amount, payerPreset.decimals);
  if (payerPreset.address.toLowerCase() === receiveToken.address.toLowerCase() && payRaw !== amountRaw)
    throw new Error("Same-token amounts must match");
}
const note = reference ?? "";
if (typeof note !== "string" || note.trim().length > 64 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
  throw new Error("Invalid reference or creation request");
}
// For a fixed invoice with a preset, resolve its payment amount before issuing.
// An open invoice carries just the suggested registry token and its decimals.
// Keep the same requestId and authenticated merchant when retrying.
const invoice = {
  id: requestId,
  receiver: merchant.walletAddress,
  chainId: config.chain_id,
  token: receiveToken.address,
  tokenDecimals: receiveToken.decimals,
  ...(amountRaw !== undefined && { amountRaw: amountRaw.toString() }),
  ...(note.trim() && { reference: note.trim() }),
  ...(payerPreset && { payCoin: payerPreset.symbol, ...(!openAmount && { payAmount: payerPreset.amount }),
    payToken: { address: payerPreset.address, decimals: payerPreset.decimals } }),
  singleUse,
  ...(duration[expiryChoice] && { expiresAt: Date.now() + duration[expiryChoice] * 1000 }),
};
// issueOnce is your database operation. Uniquely key by merchant and request ID.
// Insert the original signed URL, terms and creation time before returning it.
// On retry return the stored URL. Reject changes to the original request.
const paymentUrl = await links.issueOnce(merchant.id, invoice, expiryChoice, async terms => {
  const signed = await signLink(terms);
  return new URL("/checkout/" + signed, appOrigin).href;
});`,
      },
      extraSamples: [{
        title: "Sign and verify the checkout terms",
        code: `// Server only. jose: SignJWT, jwtVerify. Load a random 32-byte signingKey
// from your application's secret manager; use a dedicated payment-link key.
// appOrigin comes from trusted server configuration. Link contents are public.
async function signLink(terms) {
  const token = new SignJWT({ invoice: terms })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(appOrigin).setAudience("merchant-checkout").setIssuedAt();
  if (terms.expiresAt != null) token.setExpirationTime(Math.floor(terms.expiresAt / 1000));
  return token.sign(signingKey);
}
async function verifyLink(token, chainId) {
  const { payload } = await jwtVerify(token, signingKey, {
    algorithms: ["HS256"], issuer: appOrigin, audience: "merchant-checkout",
  });
  const invoice = payload.invoice;
  if (!invoice || invoice.chainId !== chainId ||
      (invoice.expiresAt != null && payload.exp !== Math.floor(invoice.expiresAt / 1000))) {
    throw new Error("Invalid payment link");
  }
  return invoice; // Look up and reserve single-use status before a new payment.
}`,
      }, {
        title: "Display the payment QR code in React",
        code: `// Install qrcode.react. Use the signed checkout URL returned by your server.
// <PaymentQrCode value={paymentUrl} />
// To add a centered logo, pass logoSrc="/logo.png" using an image hosted by your app.
${paymentQrComponent}`,
      }],
    },
    {
      id: "checkout",
      icon: Wallet,
      title: "Let the customer review and pay",
      summary:
        "Start with the suggested token when available. For an open link, the customer enters a positive amount in the token they choose. For a fixed link, show the merchant’s price in the receiving token. Show the customer the final payment terms before they sign.",
      rules: [
        "Anyone can view the link and enter an amount. Authenticate the paying wallet before creating an open-amount payment attempt. Before reserving a link or requesting a signature, match the receiving contract and decimals to the current registry. If the customer uses the preset token, check its contract and decimals too. If they select another token, resolve that selection on the invoice network.",
        "Check the paying token’s precision and your checkout minimum. This demo accepts open amounts from 0.01 in the customer’s selected token. For a direct payment, transfer that amount. For an open conversion, request one receive_less quote for the exact amount the payer enters. Show that spend and the minimum the merchant receives. Save those reviewed terms on the individual attempt.",
        "For the same token, a direct transfer can only show Submitted. Follow the Transfer guide for manual submissions. If the checkout needs automatic fulfillment or a single-use reservation, offer a different payment token for a CLOB-tracked conversion.",
        "For different currencies, estimate with /fx/rate using the receive currency as base and payment currency as quote. For distinct tokens with the same currency, or when FX is unavailable, estimate from token-specific /swap/quote results. Show unavailable if Sera cannot quote the pair. For a fixed receiving amount, use pay_more with recipient set to the saved invoice receiver. Pick an initial input estimate from the market. If the signed minimum is below the invoice, adjust the input and quote once more. Stop if the second quote still falls short, and show the final required spend before signing.",
        "For a conversion, give each swap a fresh deadline in Unix seconds and respect the returned quote expiry. Bind the quote to the invoice, attempt, payer, token pair and network. Verify its taker, token addresses, recipient, maximum input, minimum output, freshness and permission before asking for signatures. If it expires or terms change, get a new review.",
      ],
      sample: {
        title: "Request a conversion quote bound to the invoice",
        code: `// maxPayerInputRaw is the payer’s budget, in raw paying-token units.
// For an open link it is the exact amount entered. A fixed invoice also needs estimatedInputRaw.
// assertSwapQuote comes from the Swap guide.
if (invoice.chainId !== config.chain_id ||
    payToken.address.toLowerCase() === invoice.token.toLowerCase()) {
  throw new Error("Select the invoice network and a different payment token");
}
const required = invoice.amountRaw === undefined ? undefined : BigInt(invoice.amountRaw);
const inputRaw = required === undefined ? maxPayerInputRaw : estimatedInputRaw;
if (inputRaw <= 0n || inputRaw > maxPayerInputRaw) {
  throw new Error("Estimated input is outside the allowed range");
}
const draft = {
  from_token: payToken.address,
  to_token: invoice.token,
  from_amount: inputRaw.toString(),
  owner_address: payer.toLowerCase(),
  recipient: invoice.receiver,
  gas_mode: required === undefined ? "receive_less" : "pay_more",
};
let quote;
for (let attempt = 0; attempt < 2; attempt++) {
  const { timestamp } = await sera("/system/time");
  // App links use milliseconds. The CLOB expects Unix seconds.
  const linkDeadline = invoice.expiresAt === undefined ? Infinity : Math.floor(invoice.expiresAt / 1000);
  if (timestamp >= linkDeadline) throw new Error("Invoice expired");
  const request = { ...draft, expiration: Math.min(timestamp + 300, linkDeadline) };
  quote = await sera("/swap/quote", { body: request });
  const { timestamp: checkedAt } = await sera("/system/time");
  if (checkedAt >= linkDeadline) throw new Error("Invoice expired");
  const route = assertSwapQuote(quote, request, checkedAt, timestamp);
  if (BigInt(route.maxInputAmount) > maxPayerInputRaw) {
    throw new Error("Quote exceeds the maximum payer input");
  }
  const output = BigInt(route.minOutputAmount);
  if (output <= 0n) throw new Error("No executable quote");
  if (required === undefined || output >= required) break;
  if (attempt === 1) throw new Error("Quote does not cover the invoice");
  const input = BigInt(draft.from_amount);
  const adjusted = (input * required * 1001n + output * 1000n - 1n) /
    (output * 1000n);
  if (adjusted > maxPayerInputRaw) throw new Error("Quote exceeds the maximum payer input");
  draft.from_amount = adjusted.toString();
}
// Bind this quote to the saved attempt. Show maximum spend and follow the Swap guide.`,
      },
    },
    {
      id: "reconcile",
      icon: ListChecks,
      title: "Verify a conversion payment",
      summary:
        "Sera reports settlement for conversions through orders and fills. A direct-transfer hash only establishes submission.",
      rules: [
        "When checkout creates a payment attempt, verify the signed link and bind its saved QR request ID to that attempt. Check the merchant, receiver and network before writing. Save the reviewed intent, payer, network, invoice, quote UUID and returned trade ID together on your server. Only this signed intent binds Sera’s settlement to the merchant receiver.",
        "Before asking the payer to sign again, check the saved attempt and signed invoice on your backend. Offer a fresh quote only after you confirm the attempt was canceled before Sera accepted the swap and the invoice is still open. If Sera accepted the swap or its status is uncertain, keep tracking the original attempt.",
        "Read /orders/{trade_id} and every page of /fills/{trade_id} with the payer’s credential. Check order identity, fill status and the net amounts against the signed bounds and invoice. If the payer session expires, resume the same pending order when the payer reconnects. Missing, partial or inconsistent evidence keeps the payment unresolved.",
        "Commit settlement, fulfillment and any single-use reservation together. Deduplicate by chain and trade ID. A batch can share a transaction hash across multiple trades. Same-token submissions and QR sends have no public CLOB confirmation endpoint.",
      ],
      sample: {
        title: "Reconcile the saved intent using Sera",
        code: `// attempt comes from your server's saved invoice + signed intent + trade ID.
if (attempt.kind !== "swap") return;
const route = attempt.signedRoute;
if (attempt.linkId !== invoice.id || attempt.chainId !== invoice.chainId ||
    attempt.chainId !== config.chain_id ||
    route.recipient.toLowerCase() !== invoice.receiver.toLowerCase() ||
    route.outputToken.toLowerCase() !== invoice.token.toLowerCase() ||
    BigInt(route.minOutputAmount) <= 0n ||
    (invoice.amountRaw !== undefined && BigInt(route.minOutputAmount) < BigInt(invoice.amountRaw))) {
  return payments.flagForReview(invoice.id, attempt.id);
}
${READ_SWAP_SETTLEMENT}
const settled = await readSwapSettlement(attempt.tradeId, route);
if (!settled) return;
await payments.recordSettlementOnce({
  linkId: invoice.id, attemptId: attempt.id, chainId: attempt.chainId,
  tradeId: settled.tradeId, receivedRaw: settled.received.toString(), singleUse: invoice.singleUse,
});`,
      },
    },
  ],
  edgeCases: [
    [
      "Expired or edited link",
      "Stop new payment attempts. Keep watching any valid attempt already submitted before expiry and review late payments.",
    ],
    [
      "Wrong network or unavailable quote",
      "Switch to the intended chain or let the customer pick another supported token. Show the new amounts before signing.",
    ],
    [
      "Underpayment, wrong token or wrong address",
      "Do not fulfill. Keep the signed terms and record the mismatch for review.",
    ],
    [
      "Repeated click or simultaneous payers",
      "On a single-use link, only one attempt can hold the reservation. On a reusable link, independent payments can proceed. Match each settled trade ID to one payment.",
    ],
    [
      "Timeout, revert or delayed notification",
      "Continue checking the original reference while unknown. A terminal failed attempt can be replaced while the invoice is still valid.",
    ],
    [
      "Stale or tampered notification",
      "Treat the notification as a refresh signal. Read the original order and fills from Sera and check the stored signed intent before updating merchant state.",
    ],
  ],
  checklist: [
    {
      group: "Create and pay on Sepolia",
      items: [
        {
          q: "Create and open a link using a test merchant and a different payer.",
          expect:
            "The receiver matches the signed-in merchant wallet. The reference, token and amount match the signed terms.",
        },
        {
          q: "Select USDC to receive and USDT for the customer. Leave both amounts blank, open the QR and enter a USDT amount. Repeat with a fixed USDC price.",
          expect: "The open link suggests USDT and lets the customer enter a positive spend or change tokens. The fixed link keeps its USDC price. Each conversion shows maximum spend and minimum received before signing.",
        },
        {
          q: "Try the receive token and a different supported token.",
          expect:
            "A same-token submission stays unconfirmed. A conversion covers the invoice and shows the maximum spend.",
        },
        {
          q: "Try No expiry, each timed expiry, a wrong chain and a declined signature.",
          expect:
            "A timed link rejects new attempts after its deadline. A link without expiry still requires a fresh swap quote when converting.",
        },
      ],
    },
    {
      group: "Verify and reconcile",
      items: [
        {
          q: "Simulate an underpayment, wrong recipient, late payment and a revert.",
          expect:
            "The invoice stays unpaid or in review with no automatic fulfillment.",
        },
        {
          q: "Pay from two tabs with Single-use on, then repeat with Single-use off.",
          expect:
            "One successful payment consumes a single-use link. Two settled trades on a reusable link create two payment records with the same QR request ID. A separate QR with identical terms retains its own history. Rechecking either trade creates no extra record.",
        },
        {
          q: "Lose the submit response and reload checkout.",
          expect:
            "The original attempt is recovered, and the payer is not prompted to pay twice.",
        },
      ],
    },
  ],
  promptRules: [
    "Support fixed and open amounts. When both merchant amount fields are empty, issue an open link. Omit amount, payAmount and raw amount pins. Allow any listed payment token as an optional suggestion, including USDT when the merchant receives USDC. Pin both selected token contracts and decimals on the invoice network. Skip creation-time pricing for open links. Reject explicitly entered zero, malformed amounts and excess precision. At checkout let the customer choose a supported token and enter a positive amount at the token’s precision (the demo minimum is 0.01). Authenticate the payer before creating an attempt. For an open conversion, request receive_less with their exact input, check maxInputAmount equals that input and show the positive minOutputAmount in the receiving token before signing. Persist those terms per attempt and enforce expiry and single-use reservation.",
    "Implement link creation on the app’s backend. Authenticate merchant wallet ownership and derive the read-only receiving address from that session. Allow browsing before login. Sign the link identifier, chain, token, expiry and use policy. Include the receiving amount, reference and payer preset when specified. Preserve the “I receive” and “Customer pays” rows. “Any coins” leaves payCoin/payAmount unset. Populate choices from Sera’s token registry for the signed invoice network. A preset suggests the initial selection and the customer can change it. For a fixed amount with a suggested token, same-token amounts match. For a fixed conversion between different currencies, estimate with GET /fx/rate using the receiving currency as base and paying currency as quote. For two tokens with the same peg, or when FX is down, obtain token-specific CLOB quotes and report unavailable if neither direction can be priced. Before issuing a fixed conversion preset, check executable liquidity for the requested amounts with a disposable pay_more quote. Obtain a fresh quote for the actual payer at checkout.",
    "Default to No expiry and reusable. Offer 15 minutes, 1 hour, 24 hours or 7 days and an independent Single-use switch. Compute the absolute link cutoff once and verify its signature and deadline on the server for each new payment. Persist one immutable QR request for every issued link, including reusable links. Store the original signed URL and terms before reporting success. Keep guest previews and drafts out of the merchant list. For single use, persist an intent scoped to merchant and creation request ID. Atomically reserve it across competing payers, consume it on confirmed payment, and recover retries without a second charge. Track each reusable-link payment independently.",
    "Store optional merchant branding in your app’s database under the authenticated merchant. Expose only the public store details needed at checkout. After issuance, generate the QR locally from the exact signed checkout URL used for Copy and Open. Give it a white border of four QR modules. Guests may preview sample amounts before login. Only an authenticated merchant can issue a payable QR.",
    'At checkout, bind a payment attempt to the signed terms and the payer. For the receiving token, build an exact ERC-20 transfer via POST /transfer with the payer credential. Decode and verify the unsigned transfer before signing. Require a raw signer and submit once via POST /transfer/send. Mark a matching hash submitted only. For automated confirmation offer a different token and a conversion instead. For conversion, POST /swap/quote with from_token, to_token, from_amount, owner_address set to the payer, recipient set to the signed receiver, and expiration. Use pay_more for a fixed receiving amount and receive_less for an open payment with exact payer input. Set a fresh deadline from Sera time in seconds and cap it at the link cutoff (milliseconds divided by 1000) when present.',
    "Verify the quote’s expires_at and route_params against the reviewed payer, recipient, token pair, allowed maxInputAmount and required minOutputAmount. For a fixed receiving amount, if the quoted output falls short, adjust within the reviewed payer budget and quote once more. Stop if coverage is still insufficient. Re-review changed terms. For a wallet-funded swap, verify the returned permit’s owner, token, spender=config.sor_address, value, nonce, deadline and EIP-712 data before signing. Where the token needs approval, check permit.current_allowance_raw on the quote, build the exact /approve if short, sign and submit via /tx/send, then request a fresh quote and recheck permission. Equity-only swaps with zero initialDepositAmount can omit the permit. Sign the reviewed route_params as Intent under config.eip712_domain. POST /swap with the quote uuid, signature and any required permit_signature and permit_deadline.",
    "Reconcile the payer’s saved attempt and authenticated invoice state on the integrating app’s backend before requesting new signatures. Start a fresh review only when the invoice is open and cancellation occurred before Sera accepted the swap. Continue tracking the original attempt if Sera accepted it or its outcome is unknown.",
    "Persist the signed route, payer, chain, invoice, quote UUID and returned trade_id. Require the saved signed route UUID to match order.uuid_int. Fetch GET /orders/{trade_id} and all pages of GET /fills/{trade_id} with the payer’s credential. Require the correct owner, trade, tokens, signed recipient and order perspective, settled order and fills, matching fill counts and net balance debits/credits within the signed spending and invoice bounds. Deduplicate atomically by network and trade ID. Keep incomplete or failed reads unresolved, including after link expiry. Direct submissions and manual QR transfers have no CLOB confirmation or history lookup. Never fulfill from their hashes or from a wallet callback.",
  ],
  production:
    "Use fresh mainnet config and credentials, create a new invoice for a small amount, and verify the customer status and merchant ledger against the CLOB order and fills before enabling real links.",
};
