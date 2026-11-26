import { Code, CodeToggle } from "../swap-guide/components/ui";
import type { Flow } from "./catalog";
import { WALLET_SIGNING, WALLET_BACKEND_SETUP, WALLET_CONTEXT, WALLET_SESSION, WALLET_BALANCES } from "./guides/shared";
import { flowAccess, keyConflictGuidance } from "./guides/access";

export function WalletSigningGuide({ flow }: { flow: Flow }) {
  const access = flowAccess[flow];
  return (
    <section id="api-key-signing" aria-labelledby="api-key-signing-title" className="si-panel si-guide-section">
      <h2 id="api-key-signing-title">When you need an API key</h2>
      <dl className="si-guide-access">
        <div><dt>Public</dt><dd>{access.public}</dd></div>
        <div><dt>Wallet action</dt><dd>{access.wallet}</dd></div>
        <div><dt>Wallet API key</dt><dd>{access.key}</dd></div>
      </dl>
      <h3>Enable wallet access</h3>
      <ol className="si-guide-rules" style={{ listStyle: "decimal" }}>
        <li><strong>Ask the wallet owner.</strong> Show their address and network. When they choose “Sign and continue”, fetch the signing domain from <code>/config</code> and the timestamp in seconds from <code>/system/time</code>. The wallet signs the gas-free EIP-712 message <code>ManageApiKey(owner, action="create", timestamp)</code>. A transfer or order asks for its own signature.</li>
        <li><strong>Create the key on your backend.</strong> Verify that the signed-in user owns the address. Send the signed fields to the same network’s <code>POST /api-keys</code> within five minutes of Sera’s timestamp. Seal the returned key and secret in an expiring HttpOnly cookie for that wallet and network. Return only the session status to the page.</li>
        <li><strong>Read the balance.</strong> The browser sends its session cookie to your backend. Your backend calls <code>GET /balances</code> with the lowercase owner address and <code>Authorization: Bearer api_key:api_secret</code>.</li>
      </ol>
      <p>“Keep browsing” or a declined signature leaves wallet access off. Sepolia and Live each keep a separate key for this wallet in the same browser. On a switch or reload, try the saved key for the selected network first. If the signature times out or the key expires or is revoked, fetch fresh Sera time and offer to sign again. Clear the wallet cookies on logout.</p>
      <details className="si-guide-notes">
        <summary>Key limit or a signature already used</summary>
        <p>{keyConflictGuidance}</p>
      </details>
      <p>Start on Sepolia. The example binds the signing domain, API host and cookie to the same network. Serve the public signing context through your own backend so the wallet can fetch it from your website’s origin. Your app also supplies two authenticated routes, <code>POST /wallet/:network/session</code> and <code>GET /wallet/:network/balances</code>. Use your existing login for either a social embedded wallet or a connected external wallet. If your server already has an encrypted HttpOnly session, you can keep the wallet credential there with the same owner, network and expiry checks.</p>
      <CodeToggle label="Show wallet signing example">
        <Code title="Browser · sign the message and open a session">{WALLET_SIGNING}</Code>
        <Code title="Backend · read public signing settings">{WALLET_CONTEXT}</Code>
        <Code title="Backend · configure the encrypted wallet cookie">{WALLET_BACKEND_SETUP}</Code>
        <Code title="Backend · exchange the signature">{WALLET_SESSION}</Code>
        <Code title="Backend · read a protected balance">{WALLET_BALANCES}</Code>
      </CodeToggle>
      <a className="si-guide-docs-link" href="https://docs.testnet.sera.cx/api-reference/authentication/#create-an-api-key">Sera API key reference</a>
    </section>
  );
}
