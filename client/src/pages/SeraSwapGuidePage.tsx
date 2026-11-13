/**
 * Sera swap integration guide — a customer-facing, step-by-step walkthrough of
 * quoting, signing and settling a stablecoin swap through Sera's own router
 * (SeraSOR). External route providers are deliberately out of scope.
 *
 * Every rule here is taken from docs.sera.cx and from the behaviour of the
 * Sera web app (app.sera.cx → Swap). Where the two differ, the web app wins.
 */

import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { SeraPayHeader } from "@/components/SeraPayHeader";
import { SeoFooter } from "@/pages/SeoPages";

// ── Design tokens (match SeoPages) ───────────────────────────────────────────
const font = "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
const mono = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const green = "#00C853";
const darkText = "#0A1F1A";
const mutedText = "#3D5A4F";
const bg = "#F2FAF6";
const borderColor = "rgba(78,206,154,0.18)";

const SECTIONS = [
  { id: "before", n: 0, label: "Before you start" },
  { id: "bootstrap", n: 1, label: "Bootstrap" },
  { id: "validate", n: 2, label: "Validate input" },
  { id: "quote", n: 3, label: "Request a quote" },
  { id: "allowance", n: 4, label: "Permit or approve" },
  { id: "sign", n: 5, label: "Sign the Intent" },
  { id: "submit", n: 6, label: "Submit the swap" },
  { id: "track", n: 7, label: "Track settlement" },
  { id: "sequence", n: 8, label: "Full sequence" },
  { id: "checklist", n: 9, label: "Edge-case checklist" },
  { id: "ai", n: 10, label: "Hand this to an AI" },
  { id: "appendix", n: 11, label: "Appendix" },
];

const GUIDE_URL = "https://pay.sera.cx/swap/guide";

// ── Primitives ───────────────────────────────────────────────────────────────
function H1({ children }: { children: React.ReactNode }) {
  return <h1 style={{ fontSize: 34, fontWeight: 900, color: darkText, margin: "0 0 14px", letterSpacing: "-0.8px", lineHeight: 1.2 }}>{children}</h1>;
}
function Lead({ children }: { children: React.ReactNode }) {
  return <p style={{ fontSize: 15, color: mutedText, lineHeight: 1.75, margin: "0 0 14px" }}>{children}</p>;
}
function P({ children }: { children: React.ReactNode }) {
  return <p style={{ fontSize: 14, color: mutedText, lineHeight: 1.75, margin: "0 0 14px" }}>{children}</p>;
}
function B({ children }: { children: React.ReactNode }) {
  return <strong style={{ color: darkText, fontWeight: 700 }}>{children}</strong>;
}
function C({ children }: { children: React.ReactNode }) {
  return <code style={{ fontFamily: mono, fontSize: "0.92em", background: "#EAF7F0", color: darkText, padding: "1px 5px", borderRadius: 4 }}>{children}</code>;
}
function H3({ children }: { children: React.ReactNode }) {
  return <h3 style={{ fontSize: 15, fontWeight: 800, color: darkText, margin: "26px 0 8px" }}>{children}</h3>;
}
function Ul({ items }: { items: React.ReactNode[] }) {
  return (
    <ul style={{ margin: "0 0 14px", paddingLeft: 20, color: mutedText, fontSize: 14, lineHeight: 1.7 }}>
      {items.map((it, i) => <li key={i} style={{ marginBottom: 6 }}>{it}</li>)}
    </ul>
  );
}

function Section({ id, n, title, children }: { id: string; n: number; title: string; children: React.ReactNode }) {
  return (
    <section id={id} style={{ scrollMarginTop: 80, marginTop: 48 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
        <span style={{ width: 30, height: 30, borderRadius: 999, background: green, color: "#fff", fontWeight: 800, fontSize: 13, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{n}</span>
        <h2 style={{ fontSize: 22, fontWeight: 800, color: darkText, margin: 0, letterSpacing: "-0.4px" }}>{title}</h2>
      </div>
      {children}
    </section>
  );
}

function Table({ head, rows, firstColMono = false }: { head: string[]; rows: React.ReactNode[][]; firstColMono?: boolean }) {
  return (
    <div style={{ overflowX: "auto", margin: "12px 0 20px", border: `1px solid ${borderColor}`, borderRadius: 12, background: "#fff" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ background: "#EAF7F0" }}>
            {head.map((h) => (
              <th key={h} style={{ padding: "10px 14px", textAlign: "left", fontWeight: 700, color: darkText, borderBottom: `1px solid ${borderColor}`, whiteSpace: "nowrap" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ borderBottom: i === rows.length - 1 ? "none" : `1px solid ${borderColor}` }}>
              {r.map((cell, j) => (
                <td key={j} style={{ padding: "10px 14px", color: j === 0 ? darkText : mutedText, fontWeight: j === 0 ? 600 : 400, lineHeight: 1.6, verticalAlign: "top", fontFamily: j === 0 && firstColMono ? mono : undefined, fontSize: j === 0 && firstColMono ? 12 : 13 }}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Code({ title, children }: { title?: string; children: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(children).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  return (
    <div style={{ position: "relative", margin: "12px 0 20px", borderRadius: 12, overflow: "hidden", border: "1px solid rgba(10,31,26,0.08)" }}>
      {title && (
        <div style={{ background: "#161b22", color: "#8b949e", fontFamily: mono, fontSize: 11, padding: "6px 12px", borderBottom: "1px solid #30363d" }}>{title}</div>
      )}
      <pre style={{ margin: 0, background: "#0d1117", color: "#e6edf3", padding: "14px 14px", fontSize: 12, lineHeight: 1.6, overflowX: "auto", fontFamily: mono }}>{children}</pre>
      <button
        onClick={copy}
        style={{ position: "absolute", top: title ? 32 : 8, right: 8, background: "#21262d", color: "#e6edf3", border: "1px solid #30363d", borderRadius: 6, padding: "3px 8px", fontSize: 11, cursor: "pointer", fontFamily: font }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function Callout({ kind = "info", title, children }: { kind?: "info" | "warn" | "danger"; title?: string; children: React.ReactNode }) {
  const palette = {
    info: { bg: "#EAF7F0", border: green, text: darkText },
    warn: { bg: "#FFF8E6", border: "#F5A623", text: "#5A3E00" },
    danger: { bg: "#FDECEC", border: "#E53935", text: "#6B1A17" },
  }[kind];
  return (
    <div style={{ background: palette.bg, borderLeft: `4px solid ${palette.border}`, borderRadius: 10, padding: "12px 16px", margin: "12px 0 18px", fontSize: 14, color: palette.text, lineHeight: 1.65 }}>
      {title && <p style={{ margin: "0 0 4px", fontWeight: 800 }}>{title}</p>}
      <div>{children}</div>
    </div>
  );
}

function Quote({ children }: { children: React.ReactNode }) {
  return (
    <blockquote style={{ margin: "10px 0 16px", padding: "10px 16px", background: "#fff", border: `1px solid ${borderColor}`, borderRadius: 10, fontSize: 14, color: darkText, lineHeight: 1.6, fontStyle: "italic" }}>{children}</blockquote>
  );
}

function Checklist({ title, items }: { title: string; items: { q: string; expect: string }[] }) {
  return (
    <div style={{ background: "#fff", border: `1px solid ${borderColor}`, borderRadius: 14, padding: "16px 18px", marginBottom: 14 }}>
      <p style={{ fontSize: 13, fontWeight: 800, color: darkText, margin: "0 0 12px", textTransform: "uppercase", letterSpacing: "0.4px" }}>{title}</p>
      {items.map((it) => (
        <label key={it.q} style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 12, cursor: "pointer" }}>
          <input type="checkbox" style={{ marginTop: 4, accentColor: green, flexShrink: 0 }} />
          <span style={{ lineHeight: 1.6 }}>
            <span style={{ display: "block", fontSize: 14, color: darkText, fontWeight: 600 }}>{it.q}</span>
            <span style={{ display: "block", fontSize: 13, color: mutedText }}><span style={{ color: green, fontWeight: 700 }}>Should happen:</span> {it.expect}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

// ── Flow diagram (pure HTML, no library) ─────────────────────────────────────
function FlowStep({ n, who, text, branch }: { n: number; who: string; text: string; branch?: string[] }) {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: "10px 0", borderBottom: `1px dashed ${borderColor}` }}>
      <span style={{ width: 24, height: 24, borderRadius: 999, background: "#EAF7F0", color: green, fontWeight: 800, fontSize: 11, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 1 }}>{n}</span>
      <div style={{ flex: 1 }}>
        <span style={{ fontFamily: mono, fontSize: 11, color: green, fontWeight: 700, marginRight: 8 }}>{who}</span>
        <span style={{ fontSize: 13, color: darkText }}>{text}</span>
        {branch && (
          <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 12.5, color: mutedText, lineHeight: 1.6 }}>
            {branch.map((b) => <li key={b}>{b}</li>)}
          </ul>
        )}
      </div>
    </div>
  );
}

// ── Code samples ─────────────────────────────────────────────────────────────
const CODE_BOOTSTRAP = `const API = "https://api.sera.cx/api/v1";

const config = await (await fetch(API + "/config")).json();
// config.chain_id, config.sera_address, config.vault_address, config.sor_address,
// config.eip712_domain -> { name: "Sera", version: "1", chainId: 1, verifyingContract }

const { timestamp: seraNow } = await (await fetch(API + "/system/time")).json();
// Unix seconds. Use THIS clock, not the device clock, for every deadline.

const { tokens } = await (await fetch(API + "/tokens")).json();
// [{ currency: "USD", symbol: "USDC", address, decimals,
//    min_trade_amount_raw, min_trade_amount }, ...]`;

const CODE_QUOTE_REQ = `POST /swap/quote
{
  "from_token":    "<ERC-20 address, lowercase>",
  "to_token":      "<ERC-20 address, lowercase>",
  "from_amount":   "<raw uint256 string>",
  "owner_address": "<user wallet, lowercase>",
  "recipient":     "<where output goes; defaults to owner>",
  "expiration":    seraNow + 300,
  "gas_mode":      "receive_less"
}`;

const CODE_QUOTE_RES = `{
  "uuid": "6d0ad60d-...",                  // quote record id, send back in POST /swap
  "route_params": { ...Intent fields... }, // sign EXACTLY these, do not normalise
  "fee_breakdown": { "gas_cost_usd": "0.12", "gas_cost_from_token": "0.120000" },
  "expires_at": 1713250830,                // ~30 s after issue
  "permit": { ... } | null                 // see step 4
}`;

const CODE_PERMIT_TREE = `permit == null  OR  permit.permit_required == false
  └─> SKIP. Nothing to sign for allowance.

permit.permit_required == true
  ├─ permit_supported == true  AND  permit.eip712 is complete
  │     (domain.name, domain.verifyingContract, spender, value_raw, nonce, deadline)
  │     └─> PERMIT_SIGN. wallet.signTypedData(permit.eip712.{domain,types,message})
  │         Gasless. No on-chain tx. Keep the signature AND the signed deadline.
  │
  ├─ permit_supported == true  BUT  metadata incomplete
  │     └─> ABORT: "Swap quote is missing permit data. Refresh the quote and try again."
  │
  └─ permit_supported == false   (token is not EIP-2612, e.g. USDT)
        ├─ permit.spender missing  -> ABORT: "Swap quote is missing the spender field
        │                                     needed for the approve fallback."
        ├─ allowance(owner, spender) >= permit.value_raw  -> SKIP
        └─ else -> APPROVE_TX: ERC-20 approve(spender, amount) from the wallet.
                   This is the ONE case where the user needs ETH for gas.`;

const CODE_SIGN = `import { createWalletClient, custom } from "viem";

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
} as const;

const rp = quote.route_params;
const signature = await walletClient.signTypedData({
  account: owner,
  domain: config.eip712_domain,   // { name: "Sera", version: "1", chainId: 1, verifyingContract }
  types: INTENT_TYPES,
  primaryType: "Intent",
  message: {
    taker:                rp.taker,
    inputToken:           rp.inputToken,
    outputToken:          rp.outputToken,
    maxInputAmount:       BigInt(rp.maxInputAmount),
    minOutputAmount:      BigInt(rp.minOutputAmount),
    recipient:            rp.recipient,
    initialDepositAmount: BigInt(rp.initialDepositAmount ?? "0"),
    uuid:                 BigInt(rp.uuid),
    deadline:             Number(rp.deadline),
  },
});
// ethers v6: signer.signTypedData(domain, INTENT_TYPES, message)`;

const CODE_SUBMIT = `POST /swap
{
  "uuid":             quote.uuid,
  "signature":        signature,
  "permit_signature": permitSignature,                 // only when permit != null
  "permit_deadline":  permit.eip712.message.deadline   // same condition
}

// 200
{ "success": true, "trade_id": "85c92fcb-...", "status": "pending",
  "fee_breakdown": { "gas_cost_usd": "0.12", "gas_cost_from_token": "0.120000" } }

// any 4xx
{ "detail": { "detail": "<human text>", "error_code": "<CODE>" } }`;

const CODE_TRACK = `GET /orders/{trade_id}
Authorization: Bearer {api_key}:{api_secret}

// status: pending -> matched -> settled | failed | cancelled
// settlement_summary.latest_tx_hash   -> on-chain settlement tx
// settlement_economics.balance_debits / balance_credits -> what moved in the wallet
// settlement_economics.fees_paid      -> gas line item`;

const CODE_APIKEY = `const MANAGE_API_KEY_TYPES = {
  ManageApiKey: [
    { name: "owner",     type: "address" },
    { name: "action",    type: "string"  },
    { name: "timestamp", type: "uint256" },
  ],
} as const;

const timestamp = seraNow;                       // within 5 min of Sera's clock
const sig = await walletClient.signTypedData({
  account: owner, domain: config.eip712_domain, types: MANAGE_API_KEY_TYPES,
  primaryType: "ManageApiKey",
  message: { owner, action: "create", timestamp: BigInt(timestamp) },
});

const r = await fetch(API + "/api-keys", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ owner_address: owner, action: "create", timestamp,
                         signature: sig, label: "my app" }),
});
const { api_key, api_secret } = await r.json();   // api_secret is shown ONCE`;

const PROMPT_BUILD = `Add Sera stablecoin swaps to my project. Follow the guide at ${GUIDE_URL} exactly (text pasted below if you can't open links). Sera's own router only; no other route providers.

Work in this order, pause after each step so I can review:
1. Learn: read the guide, summarise the flow in 10 lines.
2. Inspect: tell me where the code will go and what you'll reuse. No new dependencies without asking.
3. Build sections 1-7. Keep every number in the guide (300 s expiry, 25 s / 5 s staleness, 0.01 % tolerance, max 2 retries, 5-min lock, 5-min polling). Use the user-facing messages the guide quotes.
4. Test the logic with mocks (no live API).
5. Validate: go through the guide's checklist and show me PASS/FAIL for each item with the file that proves it. Fix every FAIL. Then give me steps to try one real swap on Sepolia.

Never hardcode addresses. Never retry a submit after a network error.

--- GUIDE ---
`;

const PROMPT_AUDIT = `Check my Sera swap code against the guide at ${GUIDE_URL} (text pasted below if you can't open links).

1. Find the swap code (search: swap/quote, route_params, signTypedData, permit, trade_id).
2. For each rule in the guide and each checklist item, say PASS / FAIL / N/A with the file that proves it.
3. For each FAIL, give the smallest fix as a diff. No unrelated refactors.
4. Tell me which fixes need a real Sepolia swap to confirm.

Most severe first. Anything that could submit a swap twice, or sign an old or zero-output quote, is critical.

--- GUIDE ---
`;

/**
 * Token-lean version of the guide for pasting under an AI prompt. Same rules
 * as the page, no prose, no tables, no UI copy except where the AI must reuse it.
 */
const COMPACT_GUIDE = `SERA SWAP INTEGRATION SPEC (compact). Source: ${GUIDE_URL}
Scope: Ethereum mainnet via Sera's router only (SeraSOR). No external route providers.
API: https://api.sera.cx/api/v1 (testnet: https://api.testnet.sera.cx/api/v1, Sepolia).
Auth: /config /system/time /tokens /markets /health /swap/quote = none. POST /swap = EIP-712 Intent signature in body. GET /orders/{id} = "Authorization: Bearer {api_key}:{api_secret}" (owner_address lowercase).
Facts: swaps are fill-or-kill; a quote is single-use and consumed on the first valid POST /swap.

1 BOOTSTRAP (on start, refresh every few min)
- GET /config -> chain_id, sera_address, vault_address, sor_address, eip712_domain. Never hardcode addresses. Null fields during startup = retry.
- GET /system/time -> seraNow (unix s). Use for every deadline, not device clock. Valid: now < expiration <= now+365d-300s.
- GET /tokens -> address, decimals, min_trade_amount(_raw). Only source for addresses/decimals. If unavailable: block swap, show "Token list unavailable. Please try again."

2 VALIDATE before quoting
- no/zero amount -> button "Enter an amount", no request.
- from_token == to_token -> disallow (flip direction).
- amount < min_trade_amount(from) -> "Minimum amount is {amount} {token}".
- balanceOf(wallet) < amount -> "Insufficient balance"; if funds are in Sera Vault: tell user to withdraw to wallet first.
- custom recipient must match /^0x[0-9a-fA-F]{40}$/ else "Enter a valid ETH wallet address."
- from_amount = parseUnits(input, decimals) as uint256 string.

3 QUOTE: POST /swap/quote {from_token, to_token, from_amount, owner_address, recipient (default owner), expiration: seraNow+300, gas_mode}
- gas_mode: receive_less (default; spend exact, receive less) | pay_more (receive exact, spend more). User never needs ETH.
- Keep: uuid, route_params, fee_breakdown{gas_cost_usd,gas_cost_from_token}, expires_at (~30 s), permit|null.
- Errors: 400 detail.code AMOUNT_BELOW_MIN (+detail.min_from_amount; only if attempted_from_amount_raw < min_from_amount_raw) -> show minimum. NO_LIQUIDITY (error_code or /no[_\\s-]?liquidity/i) -> "This amount isn't available right now. Lower amount may work." 429 -> back off (global, 20 s). 503/network -> "Network busy. Nothing was sent."
- Never sign if route_params.minOutputAmount == "0" or uuid == "0" -> "Amount is not enough to cover network cost, please raise your amount."
- Validate every route_params field present and BigInt-parseable; else discard and re-quote.
- STALE if fetched >= 25 s ago OR expires_at - now <= 5 s. Auto-refresh display at min(fetched+25s, expires_at-5s). Re-check immediately before every wallet prompt; if stale, re-quote first.
- TOLERANCE (default 1 bps = 0.01 %, presets 1/2/10/20 bps, user range 0-500 bps): when a re-quote replaces a stale quote, if maxInputAmount rose or minOutputAmount fell by more than tolerance -> STOP, show "Rate changed... You now get {amount} {symbol}" with explicit "Swap at new rate" button. Never auto-sign a worse quote.
- Public quote API has no slippage param; on-chain protection is the signed minOutputAmount.

4 ALLOWANCE (permit non-null whenever route_params.initialDepositAmount > 0)
- permit null OR permit_required false -> skip.
- permit_supported true AND eip712 complete (domain.name, domain.verifyingContract, spender, value_raw, nonce, deadline) -> signTypedData(permit.eip712.{domain,types,message}); gasless; keep signature + deadline.
- permit_supported true BUT incomplete -> abort "Swap quote is missing permit data. Refresh the quote and try again."
- permit_supported false: no spender -> abort; allowance(owner,spender) >= value_raw -> skip; else ERC-20 approve(spender, amount) tx (only case needing ETH; if no ETH: "Almost there - your wallet just needs a little ETH for network fees.").
- spender must equal /config.sor_address else abort "Approval contract mismatch. Refresh the quote and try again."
- One permit per quote. Reuse a signed permit across a re-quote ONLY if spender, verifyingContract, value, nonce, deadline are identical; else sign again.
- current_allowance_raw is informational; does not remove the permit requirement.
- After approve confirms, re-read allowance; if still short: "The wallet approval completed, but the spending cap is still below this swap amount."

5 SIGN INTENT (re-check staleness first; on re-quote rerun step 4 on the new permit)
- domain = /config.eip712_domain ({name:"Sera",version:"1",chainId:1,verifyingContract}). primaryType "Intent".
- types Intent: taker address, inputToken address, outputToken address, maxInputAmount uint256, minOutputAmount uint256, recipient address, initialDepositAmount uint256, uuid uint256, deadline uint48.
- message = route_params exactly (BigInt for uint256, Number for deadline). No rounding, reordering or checksum changes. Mismatch = 400, quote not consumed.
- Wallet reject -> "Swap cancelled. Nothing was submitted." Wallet timeout -> "Your wallet did not respond in time. If you already confirmed in your wallet, the swap still goes through and appears in your history within a few minutes. Otherwise press Swap again."

6 SUBMIT: POST /swap {uuid, signature, permit_signature?, permit_deadline?} (permit fields both or neither)
- 200 {success, trade_id, status:"pending"} -> persist trade_id BEFORE any UI update.
- 4xx body {detail:{detail, error_code}}; branch on error_code only.
- 400 (sig mismatch / missing permit / minOutput 0): not consumed; fix inputs.
- 409 QUOTE_STALE or INTENT_DEADLINE_EXPIRED: not consumed -> silently re-quote, run tolerance gate, re-sign, resubmit; max 2 retries.
- 410 expired/not found/consumed -> fresh quote; if you may have already submitted, look up the order instead.
- ALLOWANCE_INSUFFICIENT -> redo step 4, fresh quote. SLIPPAGE_EXCEEDED -> re-quote. NO_LIQUIDITY -> different pair/size. AMOUNT_BELOW_MIN -> increase. STP_BLOCKED -> user has a resting opposite order. TRANSIENT_SETTLEMENT_FAILURE -> retry once then "Swap failed. Please try again." 429/503 -> respect Retry-After.
- NETWORK FAILURE / TIMEOUT with no response: execution unknown. NEVER resubmit. Show "Execution status is unknown. This swap is pending reconciliation. Do not submit it again; check Activity for updates or contact support." Lock the same (owner, recipient, from, to, amount, gas_mode) for 5 min. Resolve via GET /orders?owner_address=..&type=swap&created_after=.. .
- Backend: 25 s timeout on POST /swap; record pre-submit finalized block as a recovery anchor.

7 TRACK: GET /orders/{trade_id} with API key, every few seconds, STOP after 5 min.
- status pending (Submitted) -> matched (Matched; settlement in flight, never back to pending) -> settled | failed | cancelled. settlement_summary.latest_tx_hash = tx to link (Confirming).
- After 5 min still pending: "Swap is taking longer than expected. We've stopped checking after 5 minutes..." with Refresh; NOT a failure.
- Display amounts from settlement_economics.balance_debits/balance_credits; fees from fees_paid; gross_* only for execution reporting.
- failed/cancelled: say funds and approvals are unchanged.
- Order has no recipient field: if output must reach a specific address, verify the ERC-20 Transfer from Vault to recipient in the settlement tx on-chain.
- No webhooks exist; polling only.

8 API KEY (once, for polling): EIP-712 ManageApiKey {owner address, action string "create", timestamp uint256 (within 5 min of seraNow)} signed against eip712_domain; POST /api-keys {owner_address, action, timestamp, signature, label} -> api_key, api_secret (shown once). Verify with POST /api-keys/verify. Max 10 keys/wallet.

9 VALIDATION CHECKLIST = every bullet above marked "never", "always", "only", "stop", "lock", "before", or a number (25 s, 5 s, 300 s, 1 bps, 500 bps, 2 retries, 5 min). Report PASS/FAIL per bullet with file evidence.`;

function PromptCard({ title, desc, text }: { title: string; desc: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(text).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  return (
    <div style={{ background: "#fff", border: `1px solid ${borderColor}`, borderRadius: 14, padding: "16px 18px", marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 8 }}>
        <div>
          <p style={{ fontSize: 14, fontWeight: 800, color: darkText, margin: "0 0 4px" }}>{title}</p>
          <p style={{ fontSize: 13, color: mutedText, margin: 0, lineHeight: 1.6 }}>{desc}</p>
        </div>
        <button onClick={copy} style={{ flexShrink: 0, background: green, color: "#fff", border: "none", borderRadius: 20, padding: "8px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: font }}>
          {copied ? "Copied" : "Copy prompt"}
        </button>
      </div>
      <details>
        <summary style={{ fontSize: 12, color: green, fontWeight: 600, cursor: "pointer" }}>Show prompt</summary>
        <pre style={{ margin: "10px 0 0", whiteSpace: "pre-wrap", fontFamily: mono, fontSize: 12, lineHeight: 1.6, color: darkText, background: "#F7FBF9", border: `1px solid ${borderColor}`, borderRadius: 10, padding: 12 }}>{text}</pre>
      </details>
    </div>
  );
}

function CopyGuideButton({ variant }: { variant: "compact" | "full" }) {
  const [state, setState] = useState<"idle" | "done" | "fail">("idle");
  const copy = () => {
    let text = COMPACT_GUIDE;
    if (variant === "full") {
      const main = document.querySelector("main");
      text = main ? `${GUIDE_URL}\n\n${main.innerText}` : GUIDE_URL;
    }
    navigator.clipboard?.writeText(text).then(() => setState("done")).catch(() => setState("fail"));
    setTimeout(() => setState("idle"), 1600);
  };
  const primary = variant === "compact";
  const label = primary ? "Copy compact guide for AI" : "Copy full page";
  return (
    <button
      onClick={copy}
      title={primary ? "About 2,000 tokens. Same rules, no prose." : "About 7,000 tokens. Everything on this page."}
      style={{
        background: primary ? green : "#fff", color: primary ? "#fff" : green, border: `2px solid ${green}`,
        borderRadius: 20, padding: "8px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: font,
      }}
    >
      {state === "done" ? "Copied" : state === "fail" ? "Copy failed" : label}
    </button>
  );
}

/**
 * Which section the reader is currently in. A section is "active" when its
 * heading is the last one to have crossed a line a little below the sticky
 * header, so the highlight moves exactly when the reader scrolls past it.
 */
function useActiveSection(ids: string[]): string {
  const [active, setActive] = useState(ids[0] ?? "");
  useEffect(() => {
    const update = () => {
      const line = 120; // px from the top of the viewport
      let current = ids[0] ?? "";
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= line) current = id;
      }
      // At the very bottom the last section may never reach the line; pick it anyway.
      if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 2) current = ids[ids.length - 1] ?? current;
      setActive(current);
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [ids]);
  return active;
}

const SECTION_IDS = SECTIONS.map((s) => s.id);

/** Scroll to a section smoothly and keep the URL hash in sync for sharing. */
function scrollToSection(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  const top = el.getBoundingClientRect().top + window.scrollY - 80; // clear the sticky header
  window.scrollTo({ top, behavior: "smooth" });
  window.history.replaceState(null, "", `#${id}`);
}

// ── Page ─────────────────────────────────────────────────────────────────────
export default function SeraSwapGuidePage() {
  const [, setLocation] = useLocation();
  const activeId = useActiveSection(SECTION_IDS);

  return (
    <div style={{ minHeight: "100dvh", background: bg, fontFamily: font, color: darkText }}>
      <SeraPayHeader
        maxWidth={1120}
        primaryAction={{ label: "Get Started", onClick: () => setLocation("/") }}
      />

      <div style={{ maxWidth: 1120, margin: "0 auto", padding: "44px 24px 80px", display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 40 }} className="guide-grid">
        <style>{`
          @media (min-width: 1024px) {
            .guide-grid { grid-template-columns: 220px minmax(0, 1fr) !important; }
            .guide-toc { display: block !important; }
          }
        `}</style>

        {/* Sticky table of contents (desktop) */}
        <nav className="guide-toc" style={{ display: "none", position: "sticky", top: 84, alignSelf: "start" }}>
          <p style={{ fontSize: 11, fontWeight: 800, color: mutedText, letterSpacing: "0.6px", textTransform: "uppercase", margin: "0 0 10px" }}>On this page</p>
          {SECTIONS.map((s) => {
            const isActive = s.id === activeId;
            return (
              <a
                key={s.id}
                href={`#${s.id}`}
                onClick={(e) => { e.preventDefault(); scrollToSection(s.id); }}
                aria-current={isActive ? "location" : undefined}
                style={{
                  display: "flex", gap: 8, alignItems: "baseline", fontSize: 13, textDecoration: "none",
                  padding: "5px 10px", marginLeft: -10, borderRadius: 8,
                  color: isActive ? darkText : mutedText,
                  fontWeight: isActive ? 700 : 400,
                  background: isActive ? "#EAF7F0" : "transparent",
                  boxShadow: isActive ? `inset 3px 0 0 ${green}` : "none",
                  transition: "background 120ms ease, color 120ms ease",
                }}
              >
                <span style={{ fontFamily: mono, fontSize: 11, color: green, width: 18, flexShrink: 0 }}>{s.n}</span>
                <span>{s.label}</span>
              </a>
            );
          })}
          <div style={{ marginTop: 18, paddingTop: 14, borderTop: `1px solid ${borderColor}` }}>
            <a href="https://docs.sera.cx" target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: green, fontWeight: 600, textDecoration: "none" }}>docs.sera.cx ↗</a>
          </div>
        </nav>

        <main style={{ minWidth: 0, maxWidth: 820 }}>
          <p style={{ fontSize: 12, fontWeight: 700, color: green, letterSpacing: "0.6px", textTransform: "uppercase", margin: "0 0 10px" }}>Developer guide</p>
          <H1>Integrate Sera swaps, step by step</H1>
          <Lead>
            From zero to a working stablecoin swap through Sera's orderbook, using <B>only Sera's own router (SeraSOR)</B>. External route providers are out of scope.
          </Lead>
          <Lead>
            <B>Who this is for.</B> A developer adding "convert currency A to currency B" to their own app, wallet or checkout. You need a wallet that can sign EIP-712 typed data (MetaMask, Rabby, Coinbase Wallet, Privy embedded wallets, Safe) and an HTTPS client. <B>No ETH for gas is required by the end user.</B>
          </Lead>
          <Lead>
            <B>What you get at the end.</B> A quote the user signs, a swap Sera settles on Ethereum, and a trade you can track to <C>settled</C>.
          </Lead>

          {/* 0 */}
          <Section id="before" n={0} title="Before you start">
            <Table
              head={["Resource", "Value"]}
              rows={[
                ["API base URL", <C>https://api.sera.cx/api/v1</C>],
                ["Chain", <>Ethereum mainnet, <C>chainId 1</C></>],
                ["Testnet", <><C>https://api.testnet.sera.cx/api/v1</C>, Sepolia, docs at docs.testnet.sera.cx</>],
                ["Sera contract (EIP-712 verifying contract)", <C>0xB5C50C5D5f038404F85970b7f5B7259C4AC0E198</C>],
                ["Vault contract", <C>0xC7d4Fd2638e6630C8C61329878676b88A8A24D43</C>],
                ["SOR contract (permit / approve spender)", <C>0xa7A0cf7cd6f043fCA23f29d8ae5aae6b46e11c18</C>],
              ]}
            />
            <Callout kind="warn" title="Do not hardcode those addresses">
              Read them at runtime from <C>GET /config</C> (step 1). Sera states that contract addresses can change without notice.
            </Callout>
            <H3>Authentication you need</H3>
            <Table
              head={["Call", "Auth"]}
              rows={[
                [<><C>GET /config</C>, <C>/system/time</C>, <C>/tokens</C>, <C>/markets</C>, <C>/health</C></>, "none"],
                [<C>POST /swap/quote</C>, "none"],
                [<C>POST /swap</C>, "the user's EIP-712 Intent signature in the body"],
                [<><C>GET /orders/{"{trade_id}"}</C> (track settlement)</>, <>API key: <C>Authorization: Bearer {"{api_key}:{api_secret}"}</C></>],
              ]}
            />
            <P>
              A user can quote and swap with nothing but their wallet. <B>You</B> need one API key, created once by the wallet that will own it, to poll order status server-side. See <a href="#appendix" onClick={(e) => { e.preventDefault(); scrollToSection("appendix"); }} style={{ color: green, fontWeight: 600 }}>Appendix A</a>.
            </P>
            <Callout kind="info" title="Two facts everything else follows from">
              <B>Swaps are Fill-or-Kill</B>: a quote either executes in full or is rejected. <B>Quotes are single-use</B>: <C>POST /swap</C> consumes the quote on the first valid submission.
            </Callout>
          </Section>

          {/* 1 */}
          <Section id="bootstrap" n={1} title="Bootstrap: config, clock, token list">
            <P>Do this once at app start and refresh it every few minutes.</P>
            <Code title="bootstrap.ts">{CODE_BOOTSTRAP}</Code>
            <H3>Edge cases the web app handles here</H3>
            <Ul items={[
              <><C>/config</C> can return <C>null</C> fields during a partial startup. Retry; do not treat a null as "not supported".</>,
              <><B>Token list unavailable</B> → show "Token list unavailable. Please try again." and block the swap button. Never fall back to a bundled list for anything that touches money. Decimals on mainnet are not all 6 (several stablecoins are 18, some are 2); the registry is the only truth.</>,
              <><B>Clock skew.</B> Sera rejects any expiration outside <C>now &lt; expiration &lt;= now + 365d − 300s</C> by <em>its</em> clock. Compute from <C>/system/time</C> and leave a buffer.</>,
            ]} />
          </Section>

          {/* 2 */}
          <Section id="validate" n={2} title="Validate the user's input before asking for a quote">
            <P>The web app blocks the Swap button, with a specific message, before it ever calls Sera. Replicate these checks in this order:</P>
            <Table
              head={["Check", "Web app behaviour"]}
              rows={[
                ["No amount, or amount ≤ 0", 'Button reads "Enter an amount"; no request.'],
                [<><C>from_token === to_token</C></>, "Not allowed; the pair selector swaps direction instead."],
                [<>Amount below <C>min_trade_amount</C> for the <B>from</B> token</>, '"Below minimum" / "Minimum amount is {amount} {token}".'],
                ["Wallet balance < amount", '"Insufficient balance". Balance is read on-chain with balanceOf.'],
                ["Funds are in the Sera Vault (exchange balance), not the wallet", '"You have {amount} {symbol} in your Exchange Balance. Withdraw it to your wallet before swapping." Swaps spend from the wallet; the Vault is for limit orders.'],
                ["No wallet connected", '"Connect wallet".'],
              ]}
            />
            <P>Amounts are converted to raw units with the token's <C>decimals</C> from the registry: <C>from_amount = parseUnits(input, decimals).toString()</C>.</P>
          </Section>

          {/* 3 */}
          <Section id="quote" n={3} title="Request a quote">
            <Code title="POST /swap/quote">{CODE_QUOTE_REQ}</Code>
            <H3>Field rules</H3>
            <Ul items={[
              <><C>recipient</C> may be any address. The signed Intent locks it and the contract pays exactly that address. The web app offers "Receive wallet" in Advanced settings and validates it as a 40-hex ETH address ("Enter a valid ETH wallet address.").</>,
              <><C>expiration</C> becomes the Intent <C>deadline</C>. The web app signs with <B>now + 300 s</B> for an executable quote. It uses now + 3600 only for the passive rate display, which is never signed.</>,
              <><C>gas_mode</C>: <C>receive_less</C> (web app default) means the user spends exactly <C>from_amount</C> and receives slightly less. <C>pay_more</C> means the user receives the full quoted output and spends slightly more; use it when the recipient must get an exact amount (this is what SeraPay uses for merchant payments).</>,
              <>Gas is already inside the quote. <B>The user never needs ETH for a swap.</B> Show <C>fee_breakdown.gas_cost_usd</C> as "Network cost". Web app tooltip: "This is a blockchain network fee paid to validators. It is not charged by Sera."</>,
            ]} />
            <H3>Response you must keep</H3>
            <Code title="200 OK">{CODE_QUOTE_RES}</Code>

            <H3>Quote-time edge cases (web app logic)</H3>
            <Table
              head={["Situation", "How to detect", "What the web app does"]}
              rows={[
                ["Amount below pair minimum", <>HTTP 400, <C>detail.code == "AMOUNT_BELOW_MIN"</C>, <C>detail.min_from_amount</C></>, '"Minimum amount is {min} {token}." Only when attempted_from_amount_raw < min_from_amount_raw; otherwise treat as a generic failure.'],
                ["No liquidity", <><C>error_code == "NO_LIQUIDITY"</C> or <C>detail</C> text matches <C>/no[_\\s-]?liquidity/i</C></>, '"This amount isn\'t available right now. Lower amount may work." plus a "Try lower amount" action.'],
                [<>Quote has <C>route_params.minOutputAmount == "0"</C> or <C>uuid == "0"</C></>, "inspect response", <>Informational only; <B>POST /swap will reject it.</B> Web app: "Amount is not enough to cover network cost, please raise your amount." Never let the user sign it.</>],
                ["Malformed quote", <>a <C>route_params</C> field is missing or not <C>BigInt</C>-parseable</>, '"Swap quote response is missing required field …". Discard and re-quote.'],
                ["Gas breakdown inconsistent with amounts", <>cross-check <C>fee_breakdown</C> against <C>route_params</C></>, '"Quote response has inconsistent gas breakdown. Refresh the rate and try again."'],
                ["429", "status", "Back off; do not hammer. SeraPay backs off globally for 20 s on any 429."],
                ["503 / network error", "status / thrown", '"Network busy. Nothing was sent."'],
              ]}
            />

            <H3>Quote freshness</H3>
            <Callout kind="danger" title="This is the part most integrations get wrong">
              A quote is <B>stale</B> when either it was fetched <B>≥ 25 s</B> ago (client clock, from the response), or <C>expires_at − now &lt;= 5 s</C> (Sera clock).
            </Callout>
            <P>
              The web app auto-refreshes the displayed quote at <C>min(fetched + 25 s, expires_at − 5 s)</C> while the user is looking at it, and <B>always re-checks staleness immediately before the wallet prompt</B> (step 5). If the quote is stale at that moment it silently re-quotes first. Never open a wallet prompt on a quote older than 25 s.
            </P>

            <H3>Price tolerance ("Minimum receive")</H3>
            <P>
              The web app keeps a user-settable tolerance in Advanced settings: default <B>0.01 %</B> (1 bps), presets 0.01 / 0.02 / 0.1 / 0.2 %, input range 0–5 % ("Enter a percentage from 0% to 5%."). It is used for one thing: when a fresh quote replaces a stale one right before signing, the new <C>route_params</C> are compared with the old. If <C>maxInputAmount</C> rose, or <C>minOutputAmount</C> fell, by more than the tolerance, the flow <B>stops</B> and shows:
            </P>
            <Quote>
              <B>Rate changed.</B> Quote moved while confirming. Refresh and review the new rate before signing the swap. You now get {"{amount} {symbol}"}. <span style={{ color: green, fontStyle: "normal", fontWeight: 700 }}>[Swap at new rate]</span>
            </Quote>
            <P>The user must click "Swap at new rate" to continue. Do not auto-sign a worse quote.</P>
            <Callout kind="info">
              The public <C>POST /swap/quote</C> has no slippage parameter. Your protection <em>on-chain</em> is the signed <C>minOutputAmount</C>; the tolerance above is a UX guard between two quotes.
            </Callout>
          </Section>

          {/* 4 */}
          <Section id="allowance" n={4} title="Decide: permit, approve, or nothing">
            <P>Every wallet-funded quote (<C>route_params.initialDepositAmount &gt; 0</C>) comes with a non-null <C>permit</C> object. Walk this decision tree exactly; it mirrors the web app:</P>
            <Code title="decision tree">{CODE_PERMIT_TREE}</Code>
            <H3>Rules that matter</H3>
            <Ul items={[
              <>The <C>spender</C> is the live <C>sor_address</C> from <C>/config</C>. If the quote's <C>permit.spender</C> disagrees with it, abort ("Approval contract mismatch. Refresh the quote and try again.").</>,
              <><B>One permit per quote.</B> <C>permit.nonce</C> is the wallet's <em>next</em> EIP-2612 nonce after Sera's own pending swaps from that wallet. If you re-quote and the new permit has the <B>same</B> spender, verifyingContract, value, nonce and deadline, reuse the signature you already have. If anything differs, sign the new one.</>,
              <><C>current_allowance_raw</C> is <B>informational only</B>. A standing allowance does not remove the permit requirement when <C>permit_supported</C> is true.</>,
              <>After an approve tx confirms, re-read the allowance. If it is still below the required amount (user edited the cap in the wallet): "The wallet approval completed, but the spending cap is still below this swap amount."</>,
              <>Approve-flow copy: "Approve {"{token}"} then swap" on the button, "Approving…", "Confirming approval…", and for an approve that cannot start: "Token approval could not start. Review your wallet or Safe transaction settings and try again."</>,
              <>The approve path needs native ETH. If the wallet has none: "Almost there — your wallet just needs a little ETH for network fees." with a "Top up wallet" action.</>,
            ]} />
          </Section>

          {/* 5 */}
          <Section id="sign" n={5} title="Sign the Intent">
            <Callout kind="warn" title="Immediately before this step">
              Re-check quote freshness (step 3). If stale: re-quote, run the tolerance comparison, and re-run step 4 on the <em>new</em> quote's permit.
            </Callout>
            <P>Then sign <B>exactly</B> <C>route_params</C> against the domain from <C>/config</C>:</P>
            <Code title="sign-intent.ts (viem)">{CODE_SIGN}</Code>
            <P>
              <B>Do not</B> regenerate, round, checksum-normalise, or reorder any field. Sera re-hashes <C>route_params</C> server-side and a mismatch is a 400 that does not consume the quote. Safe multisigs work through EIP-1271; Sera verifies on-chain.
            </P>
            <H3>Wallet edge cases</H3>
            <Table
              head={["Case", "Web app copy"]}
              rows={[
                ["User rejects in the wallet", '"Swap cancelled. Nothing was submitted."'],
                ["Wallet does not answer (timeout)", '"Your wallet did not respond in time. If you already confirmed in your wallet, the swap still goes through and appears in your history within a few minutes. Otherwise press Swap again."'],
                ["Mobile: wallet opens in another app", 'Keep the page open; "If your wallet opens separately, approve the prompt there and return here."'],
              ]}
            />
          </Section>

          {/* 6 */}
          <Section id="submit" n={6} title="Submit the swap">
            <Code title="POST /swap">{CODE_SUBMIT}</Code>
            <P>Store <C>trade_id</C> <B>before</B> you do anything else with the UI. It is the only handle you have on the order from here on.</P>
            <H3>Error handling</H3>
            <P>Branch on <C>error_code</C>, never on the human text.</P>
            <Table
              firstColMono
              head={["HTTP / error_code", "Quote consumed?", "What to do (web app behaviour)"]}
              rows={[
                ["400 signature mismatch, missing permit fields, minOutputAmount == 0", "No", "Bug in your flow. Fix inputs; the same quote can be resent."],
                ["409 QUOTE_STALE", "No", <><B>Silently re-quote and re-submit</B>, up to 2 retries. Run the tolerance check on the new quote; if it moved beyond tolerance, stop and show "Rate changed".</>],
                ["INTENT_DEADLINE_EXPIRED", "n/a", "Same as QUOTE_STALE: re-quote, re-sign, re-submit."],
                ["410 expired / not found / already consumed", "Yes", "Request a fresh quote. If you think you already submitted it, go to step 7 and look for the order instead of resubmitting."],
                ["ALLOWANCE_INSUFFICIENT", "", "Re-run step 4 (permit or approve) and resubmit with a fresh quote."],
                ["SLIPPAGE_EXCEEDED", "", 'No crossing liquidity at the signed price. Re-quote. Web app: "This swap needs a higher slippage tolerance…"'],
                ["NO_LIQUIDITY", "", 'Widening will not help. "This pair has no liquidity right now. Try a different pair."'],
                ["AMOUNT_BELOW_MIN", "", "Increase the amount."],
                ["STP_BLOCKED", "", "The user has a resting limit order on the other side. Cancel it or change side."],
                ["TRANSIENT_SETTLEMENT_FAILURE", "", 'Retry once; if it persists, surface "Swap failed. Please try again." and log it.'],
                ["429", "No", "Respect Retry-After."],
                ["503", "No", "Retry after Retry-After."],
                ["Network error / timeout awaiting the response", <B>Unknown</B>, "See below. This is the dangerous case."],
              ]}
            />
            <H3>The "execution unknown" case</H3>
            <P>If the request leaves your process and no response arrives (timeout, connection reset, tab closed), the order may well be settling. The web app:</P>
            <Ul items={[
              <>Treats the attempt as <C>execution_status: "pending_reconciliation"</C>.</>,
              <>Shows: "Execution status is unknown. This swap is pending reconciliation. <B>Do not submit it again</B>; check Activity for updates or contact support."</>,
              <><B>Locks the same (owner, recipient, from, to, amount, gas_mode) request for 5 minutes</B> so a retry click cannot mint and submit a second quote.</>,
              <>Points the user at Activity (the order list). For an API integration, resolve it yourself with <C>GET /orders?owner_address=…&amp;type=swap&amp;created_after=…</C> and match the quote's amounts.</>,
            ]} />
            <Callout kind="danger" title="Never auto-retry POST /swap after a network-level failure">
              Only a typed <C>QUOTE_STALE</C> / <C>INTENT_DEADLINE_EXPIRED</C> response is safe to retry, because those are the two codes Sera guarantees did not consume the quote.
            </Callout>
            <P>SeraPay's server applies a 25 s timeout to <C>POST /swap</C> and records the pre-submit finalized block number as a recovery anchor before sending. If you run a backend, do the same.</P>
          </Section>

          {/* 7 */}
          <Section id="track" n={7} title="Track settlement">
            <Code title="poll">{CODE_TRACK}</Code>
            <Table
              firstColMono
              head={["status", "Meaning", "Web app step label"]}
              rows={[
                ["pending", "Accepted, matching", "Submitted"],
                ["matched", "Every leg crossed; on-chain settlement in flight. Will not go back to pending.", "Matched"],
                ["(any) + settlement_summary.latest_tx_hash", "Tx broadcast, awaiting confirmations", "Confirming (tx hash is safe to link to Etherscan)"],
                ["settled", "Chain-confirmed success", "Settled / Swap Successful"],
                ["failed", <>Reverted or rejected; read <C>error_code</C></>, '"This swap failed to settle. Your funds and any approvals are unchanged."'],
                ["cancelled", "Cancelled before settling", '"This swap was cancelled before settling. Your funds and approvals are unchanged."'],
              ]}
            />
            <Callout kind="info" title="Polling policy (web app)">
              Poll every few seconds, <B>stop after 5 minutes</B>, and show "Swap is taking longer than expected. We've stopped checking after 5 minutes. The order may still settle on-chain — refresh in a moment, or check the Activity list." A <C>pending</C> order after 5 minutes is <B>not</B> a failure.
            </Callout>
            <H3>Amounts to display</H3>
            <Ul items={[
              <><C>balance_debits</C> / <C>balance_credits</C>: what actually left and entered the wallet after the gas-mode adjustment. Show these as "You swapped / You received".</>,
              <><C>gross_debits</C> / <C>gross_credits</C>: execution totals before gas. Use for average-price reporting only.</>,
              <><C>fees_paid</C>: the gas line item, with token attribution.</>,
            ]} />
            <P>
              The order record <B>does not contain the recipient</B>. If you need to prove the output reached a specific address (for example a merchant payout), verify the ERC-20 <C>Transfer</C> from the Vault to the recipient in the settlement transaction yourself. SeraPay does this before marking a payment paid.
            </P>
            <P><B>Statuses never fire webhooks.</B> Sera publishes no webhooks; polling is the only documented path.</P>
          </Section>

          {/* 8 */}
          <Section id="sequence" n={8} title="Full sequence">
            <div style={{ background: "#fff", border: `1px solid ${borderColor}`, borderRadius: 14, padding: "6px 18px 10px", marginBottom: 14 }}>
              <FlowStep n={1} who="app → sera" text="GET /config, /system/time, /tokens" />
              <FlowStep n={2} who="app" text="Validate amount (minimum, balance, from ≠ to)" />
              <FlowStep n={3} who="app → sera" text="POST /swap/quote (expiration = seraNow + 300, gas_mode)" />
              <FlowStep n={4} who="app" text={'Reject if minOutputAmount == 0 or uuid == "0". Before any wallet prompt: re-quote if ≥ 25 s old or expiring in ≤ 5 s; stop with "Rate changed" if it moved beyond tolerance.'} />
              <FlowStep n={5} who="app → wallet" text="Allowance:" branch={[
                "permit_supported → signTypedData(permit.eip712), gasless",
                "no EIP-2612 → approve(sor_address, amount) tx, needs ETH",
              ]} />
              <FlowStep n={6} who="app → wallet" text="signTypedData(Intent = route_params)" />
              <FlowStep n={7} who="app → sera" text="POST /swap { uuid, signature, permit_signature?, permit_deadline? }" branch={[
                "409 QUOTE_STALE / INTENT_DEADLINE_EXPIRED → not consumed → re-quote, re-sign, resubmit (max 2)",
                "network failure → pending reconciliation, lock 5 min, DO NOT resubmit",
                "200 → trade_id",
              ]} />
              <FlowStep n={8} who="app → sera" text="GET /orders/{trade_id} every few seconds, max 5 min" />
              <FlowStep n={9} who="sera → ethereum" text="Batch settlement tx; status becomes settled with settlement_economics" />
            </div>
          </Section>

          {/* 9 */}
          <Section id="checklist" n={9} title="Edge-case checklist">
            <P>
              You do not need to read code to use this list. Each line is a situation a real customer will run into. Try it in your app, or ask your developer or AI to show you, and tick it when the app does what the Sera web app does. Sections 1 to 7 above hold the technical detail behind each line.
            </P>
            <Checklist title="Before the swap starts" items={[
              { q: "The customer presses Swap with no amount typed in.", expect: "Nothing is sent. The button simply says \"Enter an amount\"." },
              { q: "The customer picks the same currency on both sides.", expect: "The app will not let them. Choosing the same coin flips the direction instead." },
              { q: "The customer types an amount smaller than Sera's minimum for that coin.", expect: "The app says \"Minimum amount is X\" before asking Sera, and still handles it gracefully if Sera says the same." },
              { q: "The customer does not have enough of the coin in their wallet.", expect: "The app says \"Insufficient balance\". If the money is sitting in their Sera exchange balance instead, it tells them to withdraw it to the wallet first." },
              { q: "The customer types a receiving address that is not a valid wallet address.", expect: "The app refuses it with \"Enter a valid ETH wallet address\"." },
            ]} />
            <Checklist title="Getting the price" items={[
              { q: "Where do the coin names, addresses and decimal places come from?", expect: "Always from Sera's live list, fetched when the app opens. Never from a list typed into the app by hand." },
              { q: "The customer looks at a price for a while before pressing Swap.", expect: "The price refreshes itself roughly every 25 seconds. A price older than 25 seconds, or about to expire, is never sent to the wallet for signing." },
              { q: "Sera returns a price where the customer would receive zero.", expect: "The app does not let them continue. It says the amount is too small to cover the network cost and asks them to raise it." },
              { q: "The price moves between the customer seeing it and pressing Swap.", expect: "If it moved by more than the tolerance (0.01 % by default), the app stops and shows \"Rate changed\" with the new amount. The customer has to press \"Swap at new rate\" themselves. It never signs a worse price silently." },
              { q: "There is no liquidity for this pair right now.", expect: "The app says \"This amount isn't available right now. Lower amount may work.\" and offers to try a lower amount." },
              { q: "Sera is busy or down.", expect: "The app says \"Network busy. Nothing was sent.\" and waits before trying again, rather than hammering Sera." },
            ]} />
            <Checklist title="Wallet permission" items={[
              { q: "The customer swaps a coin like USDC that supports gasless permission.", expect: "They sign one message in their wallet. No transaction, no ETH needed." },
              { q: "The customer swaps a coin like USDT that does not support gasless permission.", expect: "The app asks for an on-chain approval first (\"Approve USDT then swap\"). This is the only case where they need a little ETH, and the app tells them so if they have none." },
              { q: "The customer already approved this coin earlier.", expect: "The app checks and skips the approval step instead of asking again." },
              { q: "The customer approved a smaller amount than the swap needs.", expect: "The app notices and says the spending cap is still too low, rather than failing later." },
              { q: "The price refreshed after the customer signed the permission.", expect: "If the permission is identical, it is reused. If anything changed, the customer is asked to sign again. Never one permission used with a different quote." },
            ]} />
            <Checklist title="Confirming the swap" items={[
              { q: "The customer presses Reject in their wallet.", expect: "The app says \"Swap cancelled. Nothing was submitted.\" Nothing moved." },
              { q: "The wallet never responds (phone locked, popup closed).", expect: "The app says the wallet did not respond and tells them that if they did confirm, the swap still goes through, otherwise press Swap again." },
              { q: "Sera says the quote is stale at the moment of submitting.", expect: "The app quietly fetches a fresh price and tries again, at most twice. If the price moved too much, it shows \"Rate changed\" instead." },
              { q: "The internet drops while the swap is being sent, so the app never hears back from Sera.", expect: "This is the dangerous one. The app must NOT send it again. It shows \"Execution status is unknown… do not submit it again\", blocks the same swap for 5 minutes, and checks the order list to find out what happened." },
              { q: "Sera accepts the swap.", expect: "The app saves the trade ID straight away, before showing anything else, so the swap can always be found again." },
            ]} />
            <Checklist title="After the swap" items={[
              { q: "The customer is waiting for the swap to finish.", expect: "The app shows progress: Submitted → Matched → Confirming → Settled. \"Matched\" is progress, not success." },
              { q: "Five minutes pass and it is still not settled.", expect: "The app stops checking and says the swap is taking longer than expected and may still settle, with a Refresh button. It does not call it a failure." },
              { q: "The swap settles.", expect: "The amounts shown are what actually left and arrived in the wallet, after the network cost, and there is a link to the transaction on Etherscan." },
              { q: "The swap fails or is cancelled.", expect: "The app clearly says the customer's funds and approvals are unchanged, so they know nothing was lost." },
              { q: "The money had to reach a specific address (for example a merchant).", expect: "The app checks on-chain that the coins actually arrived at that address before calling the payment complete. Sera's order status alone does not prove this." },
            ]} />
          </Section>

          {/* 10 */}
          <Section id="ai" n={10} title="Hand this to an AI">
            <P>
              Using Claude Code, Cursor, Copilot or another coding agent? Give it one of these prompts and the full text of this page. The prompts make it <B>learn</B> the guide first, <B>integrate</B> step by step, <B>test</B> the pure logic, and <B>validate</B> every item in the checklist with file-and-line evidence before it tells you it is done.
            </P>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", margin: "0 0 6px" }}>
              <CopyGuideButton variant="compact" />
              <CopyGuideButton variant="full" />
            </div>
            <P>
              Paste the copied text under the prompt if your AI cannot open links. <B>Compact</B> is the same rules with no prose, about 2,000 tokens, and is all an AI needs. <B>Full page</B> is about 7,000 tokens and only worth it if you also want the human explanations and the checklist wording.
            </P>
            <PromptCard
              title="Build it from scratch"
              desc="For a codebase with no Sera integration yet. The AI reads, inspects your project, implements sections 1 to 7, writes tests, then validates against the checklist."
              text={PROMPT_BUILD}
            />
            <PromptCard
              title="Audit an existing integration"
              desc="For code that already calls Sera. The AI grades every rule PASS or FAIL with evidence and proposes minimal diffs, most severe first."
              text={PROMPT_AUDIT}
            />
            <Callout kind="warn" title="Still verify on Sepolia yourself">
              An AI can prove the logic with mocks. Only a real swap on <C>api.testnet.sera.cx</C> proves the wallet prompts, permit flow and settlement polling against the live service.
            </Callout>
          </Section>

          {/* 11 */}
          <Section id="appendix" n={11} title="Appendix">
            <H3>A. Mint an API key (one time, for status polling)</H3>
            <P>Sign an EIP-712 <C>ManageApiKey</C> message with the wallet that owns the key.</P>
            <Code title="create-api-key.ts">{CODE_APIKEY}</Code>
            <P>
              Use it as <C>Authorization: Bearer {"{api_key}:{api_secret}"}</C>. Read endpoints treat <C>owner_address</C> as case-sensitive: pass it <B>lowercase</B>. Verify a stored pair with <C>POST /api-keys/verify</C> (no rate-limit cost). Max 10 active keys per wallet.
            </P>

            <H3>B. Web app copy reference</H3>
            <P>Exact strings from app.sera.cx (English), for teams that want to match tone.</P>
            <Table
              head={["Moment", "Text"]}
              rows={[
                ["Button, idle", "Swap"],
                ["Button, approve needed", "Approve {token} then swap"],
                ["Progress", "Fetching quote… / Checking allowance… / Approving… / Confirming approval… / Sign on wallet / Swapping…"],
                ["Flow steps", "Confirm quote → Connect exchange session → Check token approval → Confirm swap → Submit swap"],
                ["Rate moved", "Rate changed. Quote moved while confirming. Refresh and review the new rate before signing the swap."],
                ["No liquidity", "This amount isn't available right now. Lower amount may work."],
                ["Output too small", "Amount is not enough to cover network cost, please raise your amount."],
                ["Stale on submit", "This quote is no longer valid. Refresh the rate and try again."],
                ["Unknown execution", "Execution status is unknown. This swap is pending reconciliation. Do not submit it again; check Activity for updates or contact support."],
                ["Settling", "Settling your swap… The orderbook has matched your intent and is broadcasting it on-chain."],
                ["Timeout", "Swap is taking longer than expected. We've stopped checking after 5 minutes."],
                ["Success", "Swap submitted / Swap Successful / {amount} {symbol} is now in your balance"],
                ["Failed", "This swap failed to settle. Your funds and any approvals are unchanged."],
                ["Cancelled", "This swap was cancelled before settling. Your funds and approvals are unchanged."],
              ]}
            />

            <H3>C. See it running</H3>
            <P>
              SeraPay's own checkout uses this exact flow to let a customer pay a merchant in a different stablecoin. Generate a payment link on the <Link href="/" style={{ color: green, fontWeight: 600 }}>home page</Link>, open it, and pick a "Customer pays" currency that differs from the merchant's receive currency. SeraPay quotes with <C>gas_mode: "pay_more"</C> because a merchant must receive a fixed amount.
            </P>
          </Section>

          <div style={{ background: green, borderRadius: 16, padding: "26px 24px", textAlign: "center", marginTop: 52 }}>
            <h2 style={{ fontSize: 20, fontWeight: 800, color: "#fff", margin: "0 0 8px" }}>Need the full API reference?</h2>
            <p style={{ fontSize: 14, color: "rgba(255,255,255,0.85)", margin: "0 0 18px" }}>Endpoint schemas, limit orders, Vault deposits and withdrawals live on docs.sera.cx.</p>
            <a href="https://docs.sera.cx" target="_blank" rel="noopener noreferrer" style={{ background: "#fff", color: green, borderRadius: 24, padding: "12px 28px", fontSize: 14, fontWeight: 700, textDecoration: "none", display: "inline-block" }}>Open docs.sera.cx</a>
          </div>
        </main>
      </div>

      <SeoFooter />
    </div>
  );
}
