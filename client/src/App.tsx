import { Suspense, lazy } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Route, Switch, Redirect } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import { PrivyProvider } from "@privy-io/react-auth";
import { WagmiProvider, createConfig, http } from "wagmi";
import { mainnet, polygon, base, arbitrum, sepolia } from "wagmi/chains";
import { AuthProvider } from "./hooks/use-auth";
import { ToastProvider } from "./components/toast-system";
import { getPrivyConfigError, privyConfig } from "./lib/privy-config";

// ── Critical path: loaded eagerly (needed on first paint) ────────────────────
import Home from "./pages/Home";
import NotFound from "@/pages/NotFound";

// ── Lazy-loaded: split into separate chunks to reduce initial bundle ──────────
const PayPage          = lazy(() => import("./pages/PayPage"));
const ReceiptPage      = lazy(() => import("./pages/ReceiptPage"));
const DashboardPage    = lazy(() => import("./pages/DashboardPage").then(m => ({ default: m.Dashboard })));
const WalletsPage      = lazy(() => import("./pages/WalletsPage").then(m => ({ default: m.Wallets })));
const TransactionsPage = lazy(() => import("./pages/TransactionsPage").then(m => ({ default: m.Transactions })));
const SettingsPage     = lazy(() => import("./pages/SettingsPage").then(m => ({ default: m.Settings })));
const DeveloperPage    = lazy(() => import("./pages/DeveloperPage").then(m => ({ default: m.Developer })));
const MenuPOSPage      = lazy(() => import("./pages/MenuManagerPage").then(m => ({ default: m.MenuManager })));
const MenuPublicPage   = lazy(() => import("./pages/MenuPublicPage"));
const PayerHistoryPage = lazy(() => import("./pages/PayerHistoryPage"));
const MenuTemplatePicker = lazy(() => import("./pages/MenuTemplatePicker"));
const MenuCreatePage   = lazy(() => import("./pages/MenuCreatePage"));
// SEO pages — all lazy-loaded from a single chunk
const SeoPages = (name: string) => lazy(() => import("./pages/SeoPages").then(m => ({ default: (m as unknown as Record<string, React.ComponentType>)[name] })));
const StablecoinPaymentGatewayPage    = SeoPages("StablecoinPaymentGatewayPage");
const MultiCurrencyCryptoPaymentsPage = SeoPages("MultiCurrencyCryptoPaymentsPage");
const Web3PaymentGatewayPage          = SeoPages("Web3PaymentGatewayPage");
const NoIntegrationCryptoPaymentsPage = SeoPages("NoIntegrationCryptoPaymentsPage");
const CryptoQrPaymentPage             = SeoPages("CryptoQrPaymentPage");
const NonCustodialPaymentGatewayPage  = SeoPages("NonCustodialPaymentGatewayPage");
const AcceptUsdcPaymentsPage          = SeoPages("AcceptUsdcPaymentsPage");
const AcceptUsdtPaymentsPage          = SeoPages("AcceptUsdtPaymentsPage");
const AcceptXsgdPaymentsPage          = SeoPages("AcceptXsgdPaymentsPage");
const AcceptEurcPaymentsPage          = SeoPages("AcceptEurcPaymentsPage");
const AcceptMultipleStablecoinsPage   = SeoPages("AcceptMultipleStablecoinsPage");
const CryptoPaymentsForFreelancersPage = SeoPages("CryptoPaymentsForFreelancersPage");
const CryptoPaymentsForRestaurantsPage = SeoPages("CryptoPaymentsForRestaurantsPage");
const CryptoPaymentsForEcommercePage  = SeoPages("CryptoPaymentsForEcommercePage");
const CryptoPaymentsForNgosPage       = SeoPages("CryptoPaymentsForNgosPage");
const CryptoPaymentsForEventsPage     = SeoPages("CryptoPaymentsForEventsPage");
const CryptoInvoicePaymentsPage       = SeoPages("CryptoInvoicePaymentsPage");
const CryptoPaymentsSingaporePage     = SeoPages("CryptoPaymentsSingaporePage");
const CryptoPaymentsMalaysiaPage      = SeoPages("CryptoPaymentsMalaysiaPage");
const CryptoPaymentsPhilippinesPage   = SeoPages("CryptoPaymentsPhilippinesPage");
const CryptoPaymentsIndonesiaPage     = SeoPages("CryptoPaymentsIndonesiaPage");
const CryptoPaymentsThailandPage      = SeoPages("CryptoPaymentsThailandPage");
const InstantCryptoSettlementPage     = SeoPages("InstantCryptoSettlementPage");
const NoKycCryptoPaymentsPage         = SeoPages("NoKycCryptoPaymentsPage");
const CryptoPaymentLinkPage           = SeoPages("CryptoPaymentLinkPage");
const StablecoinQrCodeGeneratorPage   = SeoPages("StablecoinQrCodeGeneratorPage");
const SeraPayVsStripePage             = SeoPages("SeraPayVsStripePage");
const SeraPayVsCoinbaseCommercePage   = SeoPages("SeraPayVsCoinbaseCommercePage");
const SeraPayVsBitPayPage             = SeoPages("SeraPayVsBitPayPage");
const SeraPayVsNowPaymentsPage        = SeoPages("SeraPayVsNowPaymentsPage");

const wagmiConfig = createConfig({
  chains: [mainnet, polygon, base, arbitrum, sepolia],
  transports: {
    [mainnet.id]:   http(import.meta.env.VITE_MAINNET_RPC_URL || "https://ethereum-rpc.publicnode.com"),
    [polygon.id]:   http(import.meta.env.VITE_POLYGON_RPC_URL || "https://polygon-bor-rpc.publicnode.com"),
    [base.id]:      http(import.meta.env.VITE_BASE_RPC_URL || "https://base-rpc.publicnode.com"),
    [arbitrum.id]:  http(import.meta.env.VITE_ARBITRUM_RPC_URL || "https://arbitrum-one-rpc.publicnode.com"),
    [sepolia.id]:   http(import.meta.env.VITE_SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com"),
  },
});

function PrivyConfigMissing() {
  return (
    <div className="min-h-screen bg-[#F2FAF6] flex items-center justify-center px-4">
      <div className="w-full max-w-md rounded-lg border border-emerald-100 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold text-[#0A1F1A]">Privy configuration required</h1>
        <p className="mt-2 text-sm text-[#4A6B5E]">{getPrivyConfigError()}</p>
        <p className="mt-4 text-xs text-[#4A6B5E]">
          Add the final Privy app credentials to the environment and restart the dev server.
        </p>
      </div>
    </div>
  );
}

function Router() {
  return (
    <Suspense fallback={null}>
      <Switch>
        <Route path="/" component={Home} />
        <Route path="/pay/:encoded" component={PayPage} />
        <Route path="/wallet/pay/:encoded" component={PayPage} />
        <Route path="/wallet/receipt/:txId" component={ReceiptPage} />
        <Route path="/dashboard" component={DashboardPage} />
        <Route path="/wallets" component={WalletsPage} />
        <Route path="/sub-wallets" component={WalletsPage} />
        <Route path="/payments"><Redirect to="/" /></Route>
        <Route path="/transactions" component={TransactionsPage} />
        <Route path="/settings" component={SettingsPage} />
        <Route path="/developer" component={DeveloperPage} />
        <Route path="/menu-manager"><Redirect to="/menu-manager/pos" /></Route>
        <Route path="/menu-manager/new" component={MenuTemplatePicker} />
        <Route path="/menu-manager/pos" component={MenuPOSPage} />
        <Route path="/menu-manager/create" component={MenuCreatePage} />
        <Route path="/menu/:slug" component={MenuPublicPage} />
        <Route path="/wallet/history/:address" component={PayerHistoryPage} />
        {/* SEO landing pages */}
        <Route path="/stablecoin-payment-gateway" component={StablecoinPaymentGatewayPage} />
        <Route path="/multi-currency-crypto-payments" component={MultiCurrencyCryptoPaymentsPage} />
        <Route path="/web3-payment-gateway" component={Web3PaymentGatewayPage} />
        <Route path="/no-integration-crypto-payments" component={NoIntegrationCryptoPaymentsPage} />
        <Route path="/crypto-qr-payment" component={CryptoQrPaymentPage} />
        <Route path="/non-custodial-payment-gateway" component={NonCustodialPaymentGatewayPage} />
        <Route path="/accept-usdc-payments" component={AcceptUsdcPaymentsPage} />
        <Route path="/accept-usdt-payments" component={AcceptUsdtPaymentsPage} />
        <Route path="/accept-xsgd-payments" component={AcceptXsgdPaymentsPage} />
        <Route path="/accept-eurc-payments" component={AcceptEurcPaymentsPage} />
        <Route path="/accept-multiple-stablecoins" component={AcceptMultipleStablecoinsPage} />
        <Route path="/crypto-payments-for-freelancers" component={CryptoPaymentsForFreelancersPage} />
        <Route path="/crypto-payments-for-restaurants" component={CryptoPaymentsForRestaurantsPage} />
        <Route path="/crypto-payments-for-ecommerce" component={CryptoPaymentsForEcommercePage} />
        <Route path="/crypto-payments-for-ngos" component={CryptoPaymentsForNgosPage} />
        <Route path="/crypto-payments-for-events" component={CryptoPaymentsForEventsPage} />
        <Route path="/crypto-invoice-payments" component={CryptoInvoicePaymentsPage} />
        <Route path="/crypto-payments-singapore" component={CryptoPaymentsSingaporePage} />
        <Route path="/crypto-payments-malaysia" component={CryptoPaymentsMalaysiaPage} />
        <Route path="/crypto-payments-philippines" component={CryptoPaymentsPhilippinesPage} />
        <Route path="/crypto-payments-indonesia" component={CryptoPaymentsIndonesiaPage} />
        <Route path="/crypto-payments-thailand" component={CryptoPaymentsThailandPage} />
        <Route path="/instant-crypto-settlement" component={InstantCryptoSettlementPage} />
        <Route path="/no-kyc-crypto-payments" component={NoKycCryptoPaymentsPage} />
        <Route path="/crypto-payment-link" component={CryptoPaymentLinkPage} />
        <Route path="/stablecoin-qr-code-generator" component={StablecoinQrCodeGeneratorPage} />
        <Route path="/serapay-vs-stripe-crypto" component={SeraPayVsStripePage} />
        <Route path="/serapay-vs-coinbase-commerce" component={SeraPayVsCoinbaseCommercePage} />
        <Route path="/serapay-vs-bitpay" component={SeraPayVsBitPayPage} />
        <Route path="/serapay-vs-nowpayments" component={SeraPayVsNowPaymentsPage} />
        <Route path="/404" component={NotFound} />
        <Route component={NotFound} />
      </Switch>
    </Suspense>
  );
}

function App() {
  if (!privyConfig.appId) {
    return <PrivyConfigMissing />;
  }

  return (
    <ErrorBoundary>
      <PrivyProvider
        appId={privyConfig.appId}
        clientId={privyConfig.clientId || undefined}
        config={{
          loginMethods: ["wallet", "email", "google", "twitter", "telegram"],
          appearance: {
            theme: "light",
            accentColor: "#00C853",
            logo: "/icon-512.png",
            landingHeader: "Log in to SeraPay",
            loginMessage: "Accept stablecoins from anywhere in the world.",
            showWalletLoginFirst: false,
            walletChainType: "ethereum-only",
          },
          embeddedWallets: {
            ethereum: { createOnLogin: "all-users" },
          },
          legal: {
            termsAndConditionsUrl: "https://sera.cx/terms",
            privacyPolicyUrl: "https://sera.cx/privacy",
          },
        }}
      >
        <WagmiProvider config={wagmiConfig}>
          <ThemeProvider defaultTheme="light">
            <TooltipProvider>
              <AuthProvider>
                <ToastProvider>
                  <Toaster />
                  <Router />
                </ToastProvider>
              </AuthProvider>
            </TooltipProvider>
          </ThemeProvider>
        </WagmiProvider>
      </PrivyProvider>
    </ErrorBoundary>
  );
}

export default App;
