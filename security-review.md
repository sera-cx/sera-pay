# SeraPay — Security Review

Adversarial review of `main` after the community security PRs (#5, #6) were merged.
Conducted from the attacker's side: every finding below was tested by actually
sending the attack at a running server, not inferred from reading code.

**Date:** 2026-09-03
**Baseline:** commit `a51ff58` (PR #5 + PR #6 merged)
**Verification:** `tsc` clean · 78/79 tests (1 pre-existing skip) · build exit 0

---

## Summary

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | SSRF → internal network read via webhook endpoints | **Critical** | **Fixed** |
| 2 | Checkout link expiry not enforced server-side | Medium | **Fixed** |
| 3 | `singleUse` links not enforced anywhere | Low–Medium | Documented — needs a store |
| 4 | Vulnerable pre-merge duplicate files staged | Housekeeping | Flagged |
| 5 | Any merchant could claim any receiving address | **High** | **Fixed** (round 2) |

Things tested and found **sound** — no change needed — are listed at the end.
This matters as much as the findings: the payment core held up under attack.

---

## 1. SSRF → internal network read — CRITICAL (fixed)

### What it was

Two endpoints let an authenticated merchant name a URL the server then fetches:

- `POST /api/merchant/webhook/test` — returns the response body **in the HTTP
  response**, immediately.
- `POST /api/merchant/webhook` → `sendWebhook()` — fetches on every payment and
  **stores the response body**, which `GET /api/merchant/webhook/logs` returns.

Both had an SSRF blocklist, but both were regexes over the **hostname string**
and both **missed the Tailscale CGNAT range `100.64.0.0/10`** — which is where
this deployment's own database lives (`100.126.11.86:5434`), along with every
Tailnet peer.

### Proven, at the socket level

I replicated both blocklists exactly and ran attacker inputs through them:

```
TARGET                                 delivery  webhook/test
Tailscale DB (100.126.11.86)           PASS**    PASS**
Tailscale peer (100.75.242.39)         PASS**    PASS**
Tailscale MagicDNS (100.100.100.100)   PASS**    PASS**
AWS metadata (169.254.169.254)         PASS**    BLOCK
octal-encoded 127 (0177.0.0.1)         PASS**    PASS**
decimal localhost (2130706433)         PASS**    PASS**
IPv6-mapped (::ffff:10.0.0.1)          PASS**    PASS**
                                       (PASS** = reaches fetch = SSRF)
```

Then, against a **running server with a real merchant API key**, before the fix:
`webhook/test` pointed at `https://100.126.11.86:5434/` reached the database and
returned its response. After the fix (below), the same request returns
`{"error":"Private/local URLs are not allowed"}`.

### Why it is critical

An authenticated merchant — a low bar, anyone can register — could:

- **Port-scan and read the internal Tailnet**, including the Postgres host, via
  the response body handed back by `webhook/test`.
- **Reach cloud metadata** (`169.254.169.254`) on the *delivery* path, which is
  how short-lived cloud credentials get stolen.
- **Defeat the hostname check with DNS rebinding**: the blocklist checked the
  hostname, but `fetch()` re-resolves the name independently, so a domain that
  answered "public" on the check and "private" on the fetch walked straight past.

### The fix

New shared module **`server/url-guard.ts`** — `assertPublicHttpUrl(url)`:

- **Resolves the host** (`dns.lookup`, all records) and requires **every**
  resolved address to be public. Checking resolved IPs, not the hostname string,
  is what closes DNS rebinding.
- Blocks by **numeric range**, not string patterns:
  `0.0.0.0/8`, `10/8`, **`100.64/10` (CGNAT/Tailscale)**, `127/8`,
  `169.254/16`, `172.16/12`, `192.0.0/24`, `192.168/16`, `198.18/15`, multicast,
  reserved — plus IPv6 loopback/ULA/link-local and IPv4-mapped IPv6.
- Rejects non-HTTPS, `localhost`, `*.local`, `*.internal`.

All three webhook sites (save, test, delivery) now call it. Unit-tested — 75 cases in
`server/url-guard.test.ts`, DNS mocked — and confirmed live against
the real database address.

```
PASS block https://100.126.11.86:5434/     PASS block https://[::ffff:10.0.0.1]/
PASS block https://100.100.100.100/         PASS block https://169.254.169.254/
PASS block https://127.0.0.1/               PASS ALLOW https://8.8.8.8/
...                                         result all pass
```

Legitimate public webhooks still deliver — verified live.

---

## 2. Checkout link expiry not enforced server-side — MEDIUM (fixed)

`expiresAt` is signed into the checkout payload and a merchant can set it in the
QR builder. The checkout page refused an expired link
([PayPage.tsx:734](client/src/pages/PayPage.tsx#L734)) — but that is a
client-side courtesy. A request sent straight to `POST /api/payment/create` or
`/api/payment/swap/quote` **never checked it**, so an expired link stayed fully
payable to anyone who kept the URL.

Note this is *only* the signed-payload path. PR #5 already enforces expiry for
DB-backed payment intents ([payment-binding.ts:68](server/payment-binding.ts#L68)) —
the gap was the plain signed-amount link.

**Fix:** `bindCheckoutRequest` now rejects an expired payload with **410 Gone**
before any payment is created. Both routes bind through it, so both are covered.
The value is signed, so a payer cannot extend it.

Verified live: a freshly signed but back-dated link returns
`"This checkout link has expired. Ask the merchant for a fresh link."`

---

## 3. `singleUse` links not enforced — LOW–MEDIUM (documented)

The QR builder offers a **single-use** toggle
([AppLayout.tsx:456](client/src/components/AppLayout.tsx#L456)). The flag is
signed into the payload — and then **checked nowhere**, client or server. A link
marked single-use can be paid any number of times.

> **Scope correction (2026-09-04):** this applies only to the plain signed link
> minted from the QR builder toggle. Gateway payment intents (`POST /api/payments`)
> also sign `singleUse: true`, but they *are* effectively single-use already:
> `PAYABLE_INTENT_STATUSES` in [payment-binding.ts](server/payment-binding.ts)
> excludes `paid`, so a second payment against a paid intent is refused with 409.
> The gap is narrower than the heading suggests.

**Not fixed, deliberately.** A correct implementation needs per-link identity:
the server must record that *this specific* link was consumed, so that two
*different* single-use links for the same amount to the same address don't block
each other. The `transactions` table stores no link identity (no payload hash,
no nonce), so a naive "already a payment for this receiver+coin+amount" check
would wrongly reject legitimate repeat payments.

The right fix is small but is a schema change: store the signed payload's nonce
(`_n`, already minted per link) on the transaction, and refuse a second
non-failed payment carrying the same nonce. Shipping a half-correct dedup that
blocks real payments would be worse than the current gap.

**Severity is low:** paying twice hurts the payer, not the merchant, and cannot
redirect funds — the signature still pins receiver and amount. The exposure is a
merchant who *relies* on the toggle to cap redemptions and silently doesn't get
it. Recommend the schema addition as a fast follow.

---

## 4. Vulnerable duplicate files staged — HOUSEKEEPING

`server/payment-routes copy.ts` and `client/src/pages/Home copy.tsx` are staged.
The payment-routes copy is the **pre-merge version — it has neither security
fix** (no `checkout-payload`, no `payment-binding`). Nothing imports either, so
they are dead, but committing a known-vulnerable duplicate of the payment core
is worth avoiding. Delete both — the live files are strictly newer and were
confirmed to contain every flow feature the backups had.

---

## Tested and sound — no change needed

The payment core was the focus, and it held. Each of these was attacked, not
just read:

- **Forged / tampered checkout payloads** — HMAC-SHA256 with timing-safe
  compare. Unsigned, fake-signature, and tampered-amount payloads were all
  **rejected** at `/payment/create` and `/payment/swap/quote`; a validly signed
  one was accepted. This is PR #6 working as intended.
- **`/payment/notify` forgery** — an attacker cannot mark a payment paid. Notify
  only moves a row to `confirming`; `confirmed` requires on-chain verification of
  token + recipient + amount. Duplicate `txHash` is rejected (409).
- **SQL injection** — identifiers quoted via `q()` (double-quote escaping),
  every value parameterised (`$1`…). No string interpolation of user input into
  SQL.
- **Mass assignment** — no route spreads `req.body` into a DB update; every
  update passes an explicit field allowlist.
- **API-key theft in transit / at rest** — keys are `sk_` + 32 random bytes,
  never logged, never placed in a URL, never shipped in the client bundle
  (scanned all 272 built assets against the real secret values — zero hits).
- **CORS** — exact-match allowlist with credentials; no wildcard or
  origin-reflection bypass. An un-approved origin is refused.
- **Merchant registration** — Privy account linkage is checked **first**;
  signature proof is only a fallback for when Privy lookup is unavailable, so a
  wallet that can merely sign cannot claim a merchant under someone else.
- **Secrets in responses / errors** — API key returned only by authenticated
  register/regenerate flows; every 500 is a generic string; the Sera audit log
  redacts `/api-keys`, `/swap`, `/orders`, `/fills`, `/balances`, `/permit`,
  `/transfer`, `/withdraw`, and anything containing `signature`.
- **Rate limiting & headers** — `express-rate-limit` (20/min on payment create),
  `helmet` + CSP, body-size caps (2 MB, 10 MB for logo routes).
- **Signed-payload field clamping** — `sanitizeCheckoutRequest` clamps every
  field (addresses regex-checked, amounts normalised, strings length-capped,
  order items bounded) before signing; testnet chains are only signable when
  `SERA_ENABLE_TESTNET` is set.

---

## Files changed by this review

| File | Change |
|---|---|
| `server/url-guard.ts` | **New.** `assertPublicHttpUrl` — DNS-resolving SSRF guard. |
| `server/payment-routes.ts` | Both webhook sites call the guard; `bindCheckoutRequest` enforces `expiresAt`. |

No UI, copy, or payment flow was altered. The changes are server-side guards
only.

---

## Recommended fast-follows

1. **`singleUse` enforcement** (finding 3) — store the payload nonce on the
   transaction and refuse a repeat. Small schema change.
2. **Consider a webhook allowlist** — the guard blocks internal targets, but a
   merchant can still aim webhooks at arbitrary *public* hosts (ordinary for
   webhooks, but a mild abuse vector for using your server as a request
   reflector). Low priority.
3. **DNS-resolution caching / re-check on delivery** — the guard resolves at
   request time; a very determined rebinding attacker with sub-second TTLs is
   still theoretically possible on the delivery path. Pinning the resolved IP
   into the fetch would fully close it. Low priority.

---

# Round 2 — receiving addresses (2026-11-08)

A second pass asked for specifically: can anyone alter where a payment goes?
Address handling only — the recipient fields, the routes that write them, and
the reads that turn an address back into a merchant.

**Baseline:** `7497eab` on `fix/menu-orders-migration`
**Verification:** `tsc` clean · 586/587 tests (1 pre-existing skip) · every
conflict below reproduced against a local PostgreSQL database, before the fix
and again after it. No live endpoint testing this round: the route reasoning is
from code, the storage behaviour is from the database.

---

## 5. Any merchant could claim any receiving address — HIGH (fixed)

### What it was

Three fields decide who is paid and who a payment is credited to:
`merchants.walletAddress`, `merchants.storeAddress` and `sub_wallets.address`.
Only the first was ever proven — registration checks Privy wallet linkage, with
an EIP-712 signature as the fallback. The other two were merely asserted:

- `POST /sub-wallets` (`server/gateway-routes.ts`) took any well-formed address,
  screened it for compliance and marked it `active`.
- `PUT /merchant/settings` and `PUT /merchant/profile`
  (`server/payment-routes.ts`) did the same for the settlement override.

None of the three checked whether another merchant already held the address,
and there was no unique constraint behind them — `sub_wallets.address` had only
a plain `idx_sub_wallets_address`, and `merchants.storeAddress` had no index at
all. The zod schema (`shared/gateway.ts`) validated the hex format and nothing
more.

Receiving addresses are not secret. They are printed in every QR code and every
checkout link, so staking a claim on someone else's took nothing but a merchant
API key.

### Proven, at the database level

Against a local database at the pre-fix schema, every conflicting write was
accepted:

```
active sub_wallets on victim address     |     1   <- another merchant's registered wallet
active sub_wallets on shared sub address |     2   <- two merchants, one address
merchants with shared storeAddress       |     2   <- two merchants, one override
```

The reads that consume these resolve an address to exactly one merchant:
`getSubWalletByAddress()` and `getMerchantByStoreAddress()` were both `LIMIT 1`
with no `ORDER BY`, so among duplicates the answer was whatever the index scan
reached first — in practice the earlier row, stable only because an in-place
update does not move it.

### What it did, and what it did not

It did not move money. The stored recipient is re-derived server-side from the
resolved merchant in every path (`resolvePaymentMerchant`), so `toAddress`
stayed the address the payer was shown. What a claim took over was the
bookkeeping:

- **Cross-tenant disclosure.** Transfers to the victim's address were credited
  to the claimer, whose dashboard then showed the payer address, amount and
  time of payments they had nothing to do with.
- **Checkout denial of service.** The victim could no longer be paid through
  their own links: `assertPaymentIntentBindable` rejects an intent whose
  receiver resolves to a different merchant, so their payers got a 403.
- **Claim-jumping ahead of registration.** A claim staked on an address before
  its owner signed up kept resolving their payments afterwards, because
  registration never looked.

Authenticated but unprivileged: it needs a merchant API key, and registration
needs a Privy identity. A low bar, not an open one.

### The fix

Rule: a receiving address belongs to one merchant, and proof beats claim.

| File | Change |
|---|---|
| `server/address-claims.ts` | **New.** The claim rule as pure functions — foreign-claim detection, what each purpose may claim, and the unique-violation mapping. Carries the reasoning. |
| `drizzle/schema.ts` | `uq_sub_wallets_active_address` (unique on `address` where `status = 'active'`) and `uq_merchants_store_address` (unique on `storeAddress` where not null). |
| `drizzle/0010_unique_receiving_address_claims.sql` | The indexes, plus the one-time repair they cannot be created without. |
| `server/db.ts` | `listAddressClaims()` reads all three fields at once, since no index spans two tables; `releaseForeignAddressClaims()`; `getSubWalletByAddress()` now orders explicitly; the same indexes and repair added to `ensurePostgresSchema()`. |
| `server/gateway-routes.ts` | `POST /sub-wallets` rejects a claimed address with 409; a lost index race returns the same 409 rather than a 500. |
| `server/payment-routes.ts` | Both `storeAddress` writers check before screening; registration releases claims on the address it just proved; `resolveMerchantForReceiver` now resolves proven ownership before claimed. |
| `server/address-claims.test.ts` | **New.** 14 cases over the claim rule, including that the 409 never names the merchant holding the address. |

Resolution rules, where a conflict is already stored:

- **Proof beats claim.** A sub-wallet or override colliding with a
  `walletAddress` someone proved at registration is released, not the other way
  round. This is also the repair for any claim-jumping that already happened.
- **Equal standing, earlier wins.** Two claims of the same kind: keep the
  earlier, release the later. That is the row the `LIMIT 1` reads already
  resolved to, so attribution does not move.
- **A released override falls back** to the merchant's own `walletAddress`, so
  no payment is left without a recipient.
- **Archived rows do not block.** Deleting a sub-wallet and re-adding it still
  works, and so does another merchant claiming an address that was released.

The repair is in both the migration and `ensurePostgresSchema()`, because the
bootstrap — not the migration — is what every database is guaranteed to have
run. It precedes the index creation in both: a stored conflict would otherwise
fail `CREATE UNIQUE INDEX` and, in the bootstrap, take startup with it. Both
were tested by dropping the indexes, seeding conflicts (including a mixed-case
duplicate) and running each path over them.

### Deliberately not done

**Proof of control for sub-wallets.** A signature from the sub-wallet address
would make the claim as strong as registration's, and `/merchant/register`
already demands exactly that proof. It is not required here because the main
use of a sub-wallet is a destination the merchant cannot sign with from the
dashboard — a cold wallet or an exchange deposit address. Requiring a signature
closes a gap the uniqueness rule already closes, at the cost of the feature's
primary case. A product decision, not a bug fix.

---

## Tested and sound — round 2

Attacked and held, on the address paths:

- **The recipient is never taken from the request.** `/payment/create` uses the
  payload address only to look up the merchant; the stored `toAddress` comes
  from `resolvePaymentMerchant`.
- **Signed links are ownership-checked at mint.** `/payment/checkout/sign`
  refuses a receiver that is not the merchant's wallet, store address, or an
  *active* sub-wallet.
- **Order and intent references cannot be smuggled in unsigned.**
  `/payment/create` refuses `orderId` / `paymentIntentId` without a signed
  payload — which is what makes `assertMenuOrderBindable`'s missing receiver
  check unreachable rather than exploitable.
- **Menu-order links are signed server-side** from the stored order, receiver
  derived from the merchant record.
- **Intents cannot carry an arbitrary receiver** — derived from an
  ownership-checked `subWalletId`, else the merchant's own addresses.
- **Revocation holds.** `getSubWalletByAddress` filters `status = 'active'` on
  all three code paths, and deleting a sub-wallet also clears `storeAddress` if
  it pointed there.
- **No case-sensitivity bypass.** Every address comparison lowercases both
  sides, and registration normalises before insert, so the `walletAddress`
  unique constraint cannot be split with mixed case.

Minor, left alone: `/payment/direct/scan` is unauthenticated and will scan the
chain for transfers to any address named. It is public chain data and crediting
still requires merchant ownership, so the only leak is whether an address
belongs to a SeraPay merchant. Worth a rate limit.

Not covered this round: EIP-712 / Privy signature verification internals, swap
quote economics (slippage, gas caps), and webhook signing.
`server/sera-settlement.ts` states in its own header that it does not verify
the merchant recipient and relies on the caller's on-chain check — that
boundary deserves its own pass.
