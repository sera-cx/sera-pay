import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const sdkRoot = path.resolve(path.dirname(require.resolve("@privy-io/react-auth")), "../..");

// Execute the installed SDK's actual wallet-click callback with test connectors.
// This exercises the patched branch instead of merely checking patch text.
function sdkWalletClick(modulePath: string, context: Record<string, unknown>) {
  const source = readFileSync(path.join(sdkRoot, modulePath), "utf8");
  const ast = ts.createSourceFile(modulePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let callback: ts.ArrowFunction | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isArrowFunction(node) && node.parameters.length === 1 && ts.isBlock(node.body) &&
      node.body.getText(ast).includes('"Attempting injected EVM connection"') &&
      node.body.getText(ast).includes('"No available connection method for wallet"')) callback = node;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (!callback) throw new Error("The pinned Privy wallet-click callback changed; review the mobile patch.");
  return runInNewContext(`(${callback.getText(ast)})`, context) as (wallet: unknown) => Promise<void>;
}

describe.each([
  { format: "ESM", modulePath: "dist/esm/ConnectWalletView-5wi1B6wp.mjs" },
  { format: "CommonJS", modulePath: "dist/cjs/ConnectWalletView-CK8ub1wO.js" },
])("mobile EVM wallet handoff ($format)", ({ format, modulePath }) => {
  it.each([
    { mobile: false, injected: false },
    { mobile: true, injected: false },
    { mobile: true, injected: true },
  ])("keeps the original page and prefers detected wallets (mobile=$mobile, injected=$injected)", async ({ mobile, injected }) => {
    const getMobileRedirect = vi.fn(() => "okx://wallet/dapp/url?dappUrl=blank-page");
    const connect = vi.fn();
    const connector = { connectorType: "wallet_connect_v2", setWalletEntry: vi.fn(), resetConnection: vi.fn() };
    const injectedConnector = { connectorType: "injected", walletClientType: "okx", chainType: "ethereum" };
    const detected = injected ? [injectedConnector] : [];
    const registryWallet = { id: "okx", label: "OKX Wallet", chains: ["eip155:1"], listing: { slug: "okx-wallet", mobile: {} } };
    const config = { okx_wallet: { getMobileRedirect } };
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const common = { D: { normalize: (id: string) => id }, Q: {}, A: logger, R: (value: unknown) => !value };
    const context = format === "ESM" ? {
      ...common, oe: "ethereum-only", T: config, ae: detected, z: class {}, k: class {},
      d: mobile, x: () => false, be: connect, ze: connector, pe: vi.fn(), ke: undefined, C: false,
    } : {
      D: "ethereum-only", p: { mobileWalletsConfig: config, EthereumNullConnector: class {}, SolanaNullConnector: class {}, shouldUseInstallLinkFlow: () => false },
      P: detected, b: { normalize: (id: string) => id }, i: { isMobile: mobile }, m: { connectorLogger: logger },
      te: connect, de: connector, J: vi.fn(), ue: undefined, C: {}, N: false, _: (value: unknown) => !value,
    };
    await sdkWalletClick(modulePath, context)(registryWallet);
    expect(getMobileRedirect).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith(injected ? injectedConnector : connector, expect.objectContaining({ id: "okx", name: "OKX Wallet" }));
    if (injected) expect(connector.resetConnection).not.toHaveBeenCalled();
    else expect(connector.resetConnection).toHaveBeenCalledWith("okx");
  });
});

describe("same-phone OKX WalletConnect handoff", () => {
  it.each([false, true])("opens the approval URI without loading SeraPay in the wallet browser (Android=%s)", (android) => {
    const parseModule = (modulePath: string) => {
      const source = readFileSync(path.join(sdkRoot, modulePath), "utf8");
      return ts.createSourceFile(modulePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    };
    // Use the SDK's actual native/universal link formatters for both platforms.
    const linksAst = parseModule("dist/esm/pkce-CBNjl5V5.mjs");
    const linkFunctions = linksAst.statements.filter((node) => ts.isFunctionDeclaration(node) &&
      ["a", "c", "u", "d", "p", "h"].includes(node.name?.text || ""));
    expect(linkFunctions).toHaveLength(6);
    const links = runInNewContext(`(() => { ${linkFunctions.map((node) => node.getText(linksAst)).join("\n")}; return { native: c, universal: u }; })()`, {
      e: true, n: android, t: Error,
    });
    const providerAst = parseModule("dist/esm/toViemAccount-eEYORH6K.mjs");
    let displayUri: ts.ArrowFunction | undefined;
    const visit = (node: ts.Node) => {
      if (ts.isArrowFunction(node) && node.parameters.length === 1 && ts.isBlock(node.body) &&
        node.body.getText(providerAst).includes('"WalletConnect URI generated"') &&
        node.body.getText(providerAst).includes('"Displaying WalletConnect QR code"')) displayUri = node;
      ts.forEachChild(node, visit);
    };
    visit(providerAst);
    if (!displayUri) throw new Error("Review the pinned SDK's WalletConnect mobile handler.");
    const openWallet = vi.fn();
    const showModal = vi.fn();
    const provider = { signer: { abortPairingAttempt: vi.fn() } };
    const handler = runInNewContext(`(function(e) ${displayUri.body.getText(providerAst)})`, {
      m: { debug: vi.fn() }, n: provider, V: vi.fn(), b: Error, R: true,
      H: links.native, J: links.universal, Q: openWallet, G: vi.fn(),
    });
    const connector = {
      walletClientType: "okx-wallet", showPrivyQrModal: showModal,
      walletEntry: { name: "OKX Wallet", mobile: { native: "okex://main", universal: "okex://main" } },
      redirectUri: undefined,
    };
    const pairingUri = "wc:example-topic@2?relay-protocol=irn&symKey=test-session-key";
    handler.call(connector, pairingUri);
    expect(openWallet).toHaveBeenCalledTimes(1);
    const [target, windowTarget] = openWallet.mock.calls[0];
    const walletUrl = new URL(target);
    expect(walletUrl.protocol).toBe("okex:");
    expect(walletUrl.pathname).toBe("/wc");
    expect(walletUrl.searchParams.get("uri")).toBe(pairingUri);
    expect(walletUrl.searchParams.has("dappUrl")).toBe(false);
    expect(windowTarget).toBe("_self");
    expect(showModal).toHaveBeenCalledWith({ native: target, universal: target });
    expect(connector.redirectUri).toBe(target);
  });
});
