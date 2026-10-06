# Mobile wallet approval and QR resume

Expected flow: choose the receiving token and amount, press Generate QR, connect
an existing wallet, approve the sign-in message, then continue on the original
SeraPay browser page with the same request and a generated payment QR.

The pinned Privy React SDK (3.37.4) tries its mobile dApp-browser deep link before
WalletConnect for named EVM wallets such as OKX. That opens a separate browser
storage context, so neither the original draft nor its sign-in state follows.
The pnpm patch in `patches/@privy-io__react-auth@3.37.4.patch` changes only the
ordering of those two attempts in the ESM and CommonJS wallet-click handlers:
WalletConnect first, with the SDK's existing fallback for unavailable connectors.
Detected injected wallets retain priority. WalletConnect connection and sign-in
use the SDK's existing approval flow; QR creation sends no blockchain transaction.

On 2026-10-07, npm's stable `latest` release was 3.47.0. Inspection of that
release confirmed the same mobile EVM ordering; upgrading alone does not fix
this handoff. The app remains pinned to the tested 3.37.4 version with its patch.
The patch is required build input containing public SDK code, not application
credentials. Removing it restores the mobile dApp-browser behavior.
The public `pay.sera.cx` wallet bundle was also inspected on that date and still
served the original dApp-browser-first handler. The local fix requires deployment
before it changes the live mobile flow.

`Home.tsx` also protects a saved draft until currency restoration finishes,
records the resume intent at Generate QR, and waits for merchant registration
and the receiver profile before signing the payment link. Successful generation
clears the draft; closing the receiver modal withdraws the generation intent.

Regression checks:

```sh
pnpm test server/home-wallet-resume.test.ts server/mobile-wallet-handoff.test.ts
pnpm check
pnpm build
```

Before releasing an SDK upgrade, review the patch against that exact version and
rerun the tests. The handoff tests execute the installed SDK's actual callback.
They also execute its actual mobile WalletConnect URI handler for simulated iOS
and Android, confirming that OKX receives `/wc?uri=...` rather than a
`/wallet/dapp/url?dappUrl=...` request. These checks do not run the actual wallet
app or verify the operating system's return-to-browser behavior.

Device acceptance: on iPhone Chrome, enter 0.1 USDC (and repeat with USDT), press
Generate QR, select OKX, and approve sign-in. Return to the original Chrome tab
if the wallet does not bring it forward automatically. Confirm the QR carries
the selected token, 0.1 amount, live network, and configured receiving address.
Scan the QR using a second wallet to check the payment screen. Rejecting sign-in
or closing the receiver modal must leave the draft available without creating
a payment. No real transfer is needed to verify the connection fix.
